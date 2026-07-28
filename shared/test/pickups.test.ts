import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import worldgenJson from '../data/worldgen.json';
import { getTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createPed, createPickup, createGameState, type GameState } from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { damagePed } from '../src/sim/peds.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { clearSpot, roadLane } from './helpers.js';

const map = generateCity(5150, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    pickups: pickupsJson,
  });
});

const FISTS = { weaponId: 'fists', ammo: 0 };

/** One player, one pickup of `kind` placed right on top of them. */
function withPickup(kind: 'health' | 'armour' | 'ammo', seed = 1): GameState {
  let state = createGameState(seed);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'p', loadout: [FISTS] }], map);
  const p = state.players.byId[1]!;
  return step(
    state,
    {},
    [{ type: 'spawnPickup', pickupId: 9, kind, x: p.pos.x, y: p.pos.y }],
    map,
  );
}

describe('the world places pickups', () => {
  it('worldgen puts crates of every kind on open ground', () => {
    expect(map.pickupSpawns.length).toBeGreaterThan(5);
    const kinds = new Set(map.pickupSpawns.map((p) => p.kind));
    expect(kinds.has('health')).toBe(true);
    expect(kinds.has('armour')).toBe(true);
    expect(kinds.has('ammo')).toBe(true);
  });

  it('is a pure function of the seed', () => {
    const again = generateCity(5150, parseWorldgenParams(worldgenJson));
    expect(again.pickupSpawns).toEqual(map.pickupSpawns);
  });
});

describe('health and armour', () => {
  it('a hurt player heals from a health crate, and it goes on cooldown', () => {
    let state = withPickup('health');
    state.players.byId[1]!.health = 20;
    const events: SimEvent[] = [];
    state = step(state, {}, [], map, events);
    expect(state.players.byId[1]!.health).toBeGreaterThan(20);
    expect(state.pickups.byId[9]!.active).toBe(false);
    expect(state.pickups.byId[9]!.respawnAtTick).toBeGreaterThan(state.tick);
    expect(events.some((e) => e.type === 'pickupTaken')).toBe(true);
  });

  it('a healthy player leaves the crate alone', () => {
    let state = withPickup('health');
    state = step(state, {}, [], map);
    expect(state.players.byId[1]!.health).toBe(100);
    expect(state.pickups.byId[9]!.active).toBe(true);
  });

  it('healing never exceeds the cap', () => {
    let state = withPickup('health');
    state.players.byId[1]!.health = 99;
    state = step(state, {}, [], map);
    expect(state.players.byId[1]!.health).toBe(getTuning().pickups.maxHealth);
  });

  it('the crate comes back after its cooldown', () => {
    let state = withPickup('health');
    state.players.byId[1]!.health = 10;
    state = step(state, {}, [], map);
    const due = state.pickups.byId[9]!.respawnAtTick!;
    // Step away, or the still-wounded player simply takes it again the tick
    // after it returns — which is correct, but not what this test measures.
    state.players.byId[1]!.pos = { x: map.widthPx - 40, y: map.heightPx - 40 };
    const events: SimEvent[] = [];
    while (state.tick <= due) state = step(state, {}, [], map, events);
    expect(state.pickups.byId[9]!.active).toBe(true);
    expect(state.pickups.byId[9]!.respawnAtTick).toBeNull();
    expect(events.some((e) => e.type === 'pickupUp')).toBe(true);
  });

  it('armour soaks damage before health does, and is spent doing it', () => {
    let state = withPickup('armour');
    state = step(state, {}, [], map);
    const armour = state.players.byId[1]!.armour;
    expect(armour).toBeGreaterThan(0);

    state = step(
      state,
      {},
      [
        {
          type: 'spawnPlayer',
          playerId: 2,
          name: 'shooter',
          loadout: [{ weaponId: 'pistol', ammo: 99 }],
        },
      ],
      map,
    );
    const victim = state.players.byId[1]!;
    state.players.byId[2]!.pos = { x: victim.pos.x - 40, y: victim.pos.y };
    state = step(state, { 2: { ...NULL_INPUT, seq: 1, tick: 1, fire: true, aimAngle: 0 } }, [], map);

    const after = state.players.byId[1]!;
    expect(after.armour).toBeLessThan(armour);
    expect(after.health).toBe(100); // armour took all of it
  });

  it('ammo crates top up guns but are ignored by the bare-knuckled', () => {
    let state = withPickup('ammo');
    state = step(state, {}, [], map);
    expect(state.pickups.byId[9]!.active).toBe(true);

    state.players.byId[1]!.weapons.push({ weaponId: 'pistol', ammo: 3 });
    state = step(state, {}, [], map);
    expect(state.pickups.byId[9]!.active).toBe(false);
    const pistol = state.players.byId[1]!.weapons.find((w) => w.weaponId === 'pistol')!;
    expect(pistol.ammo).toBeGreaterThan(3);
  });

  it('pickup collection is deterministic', () => {
    const run = (): number => {
      let state = withPickup('health', 77);
      state.players.byId[1]!.health = 15;
      for (let i = 0; i < 60 * 40; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});

describe('fists', () => {
  it('never run out of ammo', () => {
    let state = createGameState(3);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a', loadout: [FISTS] }], map);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'b', loadout: [FISTS] }], map);

    let seq = 1;
    for (let i = 0; i < 300; i++) {
      const b = state.players.byId[2]!;
      if (b.mode === 'dead') break;
      // Stay in reach; fists have a very short range by design.
      b.pos = { x: state.players.byId[1]!.pos.x + 14, y: state.players.byId[1]!.pos.y };
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: 0 } },
        [],
        map,
      );
    }
    expect(state.players.byId[2]!.mode).toBe('dead');
    const fists = state.players.byId[1]!.weapons.find((w) => w.weaponId === 'fists')!;
    expect(fists).toBeDefined();
    expect(fists.ammo).toBe(0);
  });

  it('survive death even though guns do not', () => {
    let state = createGameState(4);
    state = step(
      state,
      {},
      [
        {
          type: 'spawnPlayer',
          playerId: 1,
          name: 'a',
          loadout: [FISTS, { weaponId: 'pistol', ammo: 50 }],
        },
      ],
      map,
    );
    expect(state.players.byId[1]!.weapons.length).toBe(2);

    // Put the victim on an actual road lane: a car driven into a building
    // now takes collision damage and can burn out before it kills anybody.
    const lane = roadLane(map);
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y };
    state = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 20,
          kind: 'car',
          x: lane.x,
          y: lane.y,
          heading: lane.heading,
        },
      ],
      map,
    );
    for (let i = 0; i < 60 && state.players.byId[1]!.mode !== 'dead'; i++) {
      const car = state.vehicles.byId[20]!;
      // Hold the car intact and on top of them: this test is about what the
      // corpse keeps, not about vehicle durability.
      car.health = 100;
      car.condition = 'ok';
      car.fuseAtTick = null;
      car.speed = 300;
      car.pos = { x: state.players.byId[1]!.pos.x, y: state.players.byId[1]!.pos.y };
      state = step(state, {}, [], map);
    }
    expect(state.players.byId[1]!.mode).toBe('dead');
    expect(state.players.byId[1]!.weapons.map((w) => w.weaponId)).toEqual(['fists']);
    expect(state.players.byId[1]!.activeWeapon).toBe(0);
  });
});

describe('cash on the ground (O1)', () => {
  it('a body drops what it was carrying, and only for a killer who exists', () => {
    let s = createGameState(4242);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const spot = clearSpot(map, s.players.byId[1]!.pos, 40);
    insertEntity(s.peds, createPed(700, { x: spot.x, y: spot.y }, 30));
    // Counted by kind, not by total: somebody armed also drops their gun, and
    // that drop is about what they were carrying rather than about who is
    // owed for it.
    const cash = (): number =>
      s.pickups.ids.map((id) => s.pickups.byId[id]!).filter((pu) => pu.kind === 'cash').length;
    const before = cash();
    damagePed(s, s.peds.byId[700]!, 999, 1, []);
    expect(cash()).toBe(before + 1);

    // A gang-war casualty (attacker -1) leaves no cash: nobody earned it.
    insertEntity(s.peds, createPed(701, { x: spot.x, y: spot.y }, 30));
    const was = cash();
    damagePed(s, s.peds.byId[701]!, 999, -1, []);
    expect(cash()).toBe(was);
  });

  it('a wad nobody takes does not litter the city for ever', () => {
    let s = createGameState(4243);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    // Far from the player so it is not collected the moment it lands.
    const far = clearSpot(map, s.players.byId[1]!.pos, 600);
    insertEntity(s.pickups, createPickup(900, 'cash', { x: far.x, y: far.y }));
    let gone = false;
    for (let i = 0; i < 30 * 30 && !gone; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: s.tick } }, [], map);
      if (!s.pickups.byId[900]) gone = true;
    }
    expect(gone).toBe(true);
  });

  it('taking one always succeeds and changes nothing in the sim', () => {
    // Money is not sim state: the crate's whole effect is the event, priced
    // by the server through the same capped chokepoint as everything else.
    let s = createGameState(4244);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const p = s.players.byId[1]!;
    const events: SimEvent[] = [];
    s = step(
      s,
      {},
      [{ type: 'spawnPickup', pickupId: 901, kind: 'cash', x: p.pos.x, y: p.pos.y }],
      map,
      events,
    );
    const taken = events.find((e) => e.type === 'pickupTaken');
    expect(taken).toBeDefined();
    if (taken && taken.type === 'pickupTaken') expect(taken.kind).toBe('cash');
    const me = s.players.byId[1]!;
    expect(me.health).toBe(100);
    expect(me.powerFlags).toBe(0);
  });
});
