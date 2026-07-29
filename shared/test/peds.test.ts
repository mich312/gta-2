import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import worldgenJson from '../data/worldgen.json';
import { getTuning, initTuning } from '../src/tuning.js';
import { TICK_RATE } from '../src/constants.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { damagePed } from '../src/sim/peds.js';
import { step } from '../src/sim/step.js';
import { clearSpot } from './helpers.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimCommand } from '../src/sim/commands.js';
import { hashState } from '../src/net/hash.js';
import { boxInSolid } from '../src/world/collide.js';

const map = generateCity(8080, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
  });
});

function spawnPeds(state: GameState, count: number): GameState {
  const cmds: SimCommand[] = [];
  for (let i = 0; i < count; i++) {
    const spot = map.pedSpawns[i * 3]!;
    cmds.push({ type: 'spawnPed', pedId: 1000 + i, x: spot.x, y: spot.y });
  }
  return step(state, {}, cmds, map);
}

describe('pedestrians', () => {
  it('the map generates plenty of ped spawn points', () => {
    expect(map.pedSpawns.length).toBeGreaterThan(400);
  });

  it('200 peds wander without ever clipping into buildings, deterministically', () => {
    const run = (): { state: GameState; hash: number } => {
      let state = createGameState(1);
      state = spawnPeds(state, 200);
      for (let t = 0; t < 300; t++) {
        state = step(state, {}, [], map);
      }
      return { state, hash: hashState(state) };
    };
    const a = run();
    expect(a.state.peds.ids.length).toBe(200);
    for (const id of a.state.peds.ids) {
      expect(boxInSolid(map, a.state.peds.byId[id]!.pos, 5)).toBe(false);
    }
    // Someone actually moved.
    const first = a.state.peds.byId[a.state.peds.ids[0]!]!;
    const spawn = map.pedSpawns[0]!;
    expect(Math.hypot(first.pos.x - spawn.x, first.pos.y - spawn.y)).toBeGreaterThan(0);
    expect(run().hash).toBe(a.hash);
  });

  it('gunfire scatters the crowd', () => {
    let state = createGameState(2);
    state = step(
      state,
      {},
      [{ type: 'spawnPlayer', playerId: 1, name: 'shooter', loadout: [{ weaponId: 'pistol', ammo: 90 }] }],
      map,
    );
    const p1 = state.players.byId[1]!;
    // Put a handful of peds right around the shooter.
    const cmds: SimCommand[] = [];
    for (let i = 0; i < 5; i++) {
      cmds.push({ type: 'spawnPed', pedId: 500 + i, x: p1.pos.x + 40 + i * 15, y: p1.pos.y + 30 });
    }
    state = step(state, {}, cmds, map);
    const fire: InputIntent = { ...NULL_INPUT, seq: 1, tick: 1, fire: true, aimAngle: -1.2 };
    state = step(state, { 1: fire }, [], map);
    const fleeing = state.peds.ids.filter((id) => state.peds.byId[id]!.mode === 'flee');
    expect(fleeing.length).toBeGreaterThan(0);
  });

  it('killing a pedestrian is a crime', () => {
    let state = createGameState(3);
    state = step(
      state,
      {},
      [{ type: 'spawnPlayer', playerId: 1, name: 'monster', loadout: [{ weaponId: 'shotgun', ammo: 40 }] }],
      map,
    );
    const p1 = state.players.byId[1]!;
    // Along a clear line, not a fixed +x offset — see test/helpers.ts.
    const spot = clearSpot(map, p1.pos, 30);
    state = step(state, {}, [{ type: 'spawnPed', pedId: 900, x: spot.x, y: spot.y }], map);
    let seq = 1;
    for (let i = 0; i < 120 && state.peds.byId[900]?.mode !== 'dead'; i++) {
      const ped = state.peds.byId[900] ?? null;
      const aim = ped ? Math.atan2(ped.pos.y - p1.pos.y, ped.pos.x - p1.pos.x) : 0;
      state = step(state, { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: aim } }, [], map);
    }
    // A body, not a vanishing act: they lie there for the corpse span and are
    // then cleared away.
    expect(state.peds.byId[900]!.mode).toBe('dead');
    // Off the tunable rather than a literal: the number moved with P2's
    // difficulty pass and a hard-coded 75 pinned the old one for no reason.
    // The kill charge lands in full — `addHeat` restarts the cool-down clock,
    // so nothing decays in the same breath.
    expect(state.players.byId[1]!.heat).toBeGreaterThanOrEqual(getTuning().peds.heatPerPedKill);
    for (let i = 0; i < getTuning().peds.corpseSec * TICK_RATE + 2; i++) {
      state = step(state, {}, [], map);
    }
    expect(state.peds.byId[900]).toBeUndefined();
  });
});

/**
 * Ids chosen, not arbitrary. Being armed is `id % armedOneIn === 0` and going
 * down alive rather than dying is `id % downOneIn === 0`, both pure functions
 * of the id — so ARMED is a multiple of 7 that is not a multiple of 3, and
 * UNARMED is neither.
 */
const ARMED_PED = 7;
const UNARMED_PED = 8;

/** A player with a gun, and a ped `dist` px away along a clear line. */
function shooterAndPed(seed: number, pedId: number, dist: number): GameState {
  let state = createGameState(seed);
  state = step(
    state,
    {},
    [
      {
        type: 'spawnPlayer',
        playerId: 1,
        name: 'shooter',
        loadout: [{ weaponId: 'pistol', ammo: 200 }],
      },
    ],
    map,
  );
  const spot = clearSpot(map, state.players.byId[1]!.pos, dist);
  return step(state, {}, [{ type: 'spawnPed', pedId, x: spot.x, y: spot.y }], map);
}

describe('people who shoot back', () => {
  it('somebody armed returns fire instead of running', () => {
    let state = shooterAndPed(31, ARMED_PED, 70);
    const aim = Math.atan2(
      state.peds.byId[ARMED_PED]!.pos.y - state.players.byId[1]!.pos.y,
      state.peds.byId[ARMED_PED]!.pos.x - state.players.byId[1]!.pos.x,
    );
    // One round: enough to provoke, nowhere near enough to kill.
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, fire: true, aimAngle: aim } }, [], map);
    const provoked = state.peds.byId[ARMED_PED]!;
    expect(provoked.mode).toBe('hostile');
    expect(provoked.targetId).toBe(1);

    // And it is not a bluff: stand there and you get shot.
    const startHealth = state.players.byId[1]!.health;
    for (let i = 0; i < 90; i++) state = step(state, {}, [], map);
    expect(state.players.byId[1]!.health).toBeLessThan(startHealth);
  });

  it('everybody else still runs', () => {
    let state = shooterAndPed(32, UNARMED_PED, 70);
    const aim = Math.atan2(
      state.peds.byId[UNARMED_PED]!.pos.y - state.players.byId[1]!.pos.y,
      state.peds.byId[UNARMED_PED]!.pos.x - state.players.byId[1]!.pos.x,
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, fire: true, aimAngle: aim } }, [], map);
    const scared = state.peds.byId[UNARMED_PED]!;
    expect(scared.mode).toBe('flee');
    expect(scared.targetId).toBeNull();
  });

  it('a grudge lapses; the crowd does not hold one for ever', () => {
    let state = shooterAndPed(33, ARMED_PED, 70);
    const ped = state.peds.byId[ARMED_PED]!;
    damagePed(state, ped, 4, 1, []);
    expect(state.peds.byId[ARMED_PED]!.targetId).toBe(1);
    // Out of sight, out of range: the clock is what ends it.
    state.players.byId[1]!.pos = { x: 4, y: 4 };
    for (let i = 0; i < getTuning().peds.grudgeTicks + 5; i++) state = step(state, {}, [], map);
    expect(state.peds.byId[ARMED_PED]!.targetId).toBeNull();
    expect(state.peds.byId[ARMED_PED]!.mode).not.toBe('hostile');
  });

  it('the body leaves the gun on the pavement, and it can be picked up', () => {
    let state = shooterAndPed(34, ARMED_PED, 40);
    const ped = state.peds.byId[ARMED_PED]!;
    const where = { x: ped.pos.x, y: ped.pos.y };
    damagePed(state, ped, 1000, 1, []);

    // A body, and a gun beside it.
    expect(state.peds.byId[ARMED_PED]!.mode).toBe('dead');
    const dropped = state.pickups.ids
      .map((id) => state.pickups.byId[id]!)
      .filter((pu) => pu.kind === 'weapon');
    expect(dropped.length).toBe(1);
    const gun = dropped[0]!;
    expect(gun.weaponId).toBe(getTuning().peds.weapon);
    expect(gun.ammo).toBeGreaterThan(0);
    expect(Math.hypot(gun.pos.x - where.x, gun.pos.y - where.y)).toBeLessThan(1);

    // Walk onto it and it is yours — once. It does not respawn.
    state.players.byId[1]!.pos = { x: gun.pos.x, y: gun.pos.y };
    state = step(state, {}, [], map);
    const me = state.players.byId[1]!;
    expect(me.weapons.some((w) => w.weaponId === getTuning().peds.weapon)).toBe(true);
    expect(state.pickups.byId[gun.id]).toBeUndefined();
  });

  it('a gun nobody picks up rots off the street', () => {
    let state = shooterAndPed(35, ARMED_PED, 40);
    damagePed(state, state.peds.byId[ARMED_PED]!, 1000, 1, []);
    const gunId = state.pickups.ids.find((id) => state.pickups.byId[id]!.kind === 'weapon')!;
    expect(gunId).toBeDefined();
    // Keep the player well clear so this is expiry, not collection.
    state.players.byId[1]!.pos = { x: 4, y: 4 };
    for (let i = 0; i < getTuning().peds.dropLifeSec * TICK_RATE + 2; i++) {
      state = step(state, {}, [], map);
    }
    expect(state.pickups.byId[gunId]).toBeUndefined();
  });

  it('a body is scenery: it stops no bullets and takes no more damage', () => {
    let state = shooterAndPed(36, ARMED_PED, 40);
    damagePed(state, state.peds.byId[ARMED_PED]!, 1000, 1, []);
    const body = state.peds.byId[ARMED_PED]!;
    const timerBefore = body.timer;
    damagePed(state, body, 1000, 1, []);
    expect(state.peds.byId[ARMED_PED]!.mode).toBe('dead');
    expect(state.peds.byId[ARMED_PED]!.timer).toBe(timerBefore);
    // Exactly one gun on the pavement, not one per bullet fired into it.
    expect(state.pickups.ids.filter((id) => state.pickups.byId[id]!.kind === 'weapon').length)
      .toBe(1);
  });

  it('the whole thing stays deterministic', () => {
    const run = (): number => {
      let state = shooterAndPed(37, ARMED_PED, 70);
      damagePed(state, state.peds.byId[ARMED_PED]!, 4, 1, []);
      for (let i = 0; i < 200; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
