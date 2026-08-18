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
import {
  POWER_DOUBLE_DAMAGE,
  POWER_FAST_RELOAD,
  POWER_INVISIBLE,
  POWER_JAIL_CARD,
  POWER_TIMED,
  createCop,
  createGameState,
  type GameState,
  type PickupKind,
} from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { clearSpot } from './helpers.js';

const map = generateCity(6006, parseWorldgenParams(worldgenJson));

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

/** A player standing on a crate of `kind`, one step from taking it. */
function onCrate(kind: PickupKind, seed = 808): GameState {
  let state = createGameState(seed);
  state = step(
    state,
    {},
    [
      {
        type: 'spawnPlayer',
        playerId: 1,
        name: 'collector',
        loadout: [{ weaponId: 'pistol', ammo: 50 }],
      },
    ],
    map,
  );
  const p = state.players.byId[1]!;
  state = step(
    state,
    {},
    [{ type: 'spawnPickup', pickupId: 50, kind, x: p.pos.x, y: p.pos.y }],
    map,
  );
  return state;
}

function take(state: GameState, events: SimEvent[] = []): GameState {
  return step(state, { 1: { ...NULL_INPUT, seq: 1, tick: state.tick } }, [], map, events);
}

describe('power-ups (F3b)', () => {
  it('all five are collectable and land in one bitfield', () => {
    const cases: Array<[PickupKind, number]> = [
      ['damage', POWER_DOUBLE_DAMAGE],
      ['invis', POWER_INVISIBLE],
      ['reload', POWER_FAST_RELOAD],
      ['jailcard', POWER_JAIL_CARD],
    ];
    for (const [kind, bit] of cases) {
      const after = take(onCrate(kind));
      expect(after.players.byId[1]!.powerFlags & bit, kind).toBe(bit);
    }
  });

  it('a bribe clears heat outright, and is refused when you are clean', () => {
    let s = onCrate('bribe');
    s.players.byId[1]!.heat = 320;
    s = take(s);
    expect(s.players.byId[1]!.heat).toBe(0);
    expect(s.players.byId[1]!.wantedLevel).toBe(0);

    // No heat, no sale: the crate is still there for when you need it.
    let clean = onCrate('bribe');
    clean = take(clean);
    expect(clean.pickups.byId[50]!.active).toBe(true);
  });

  it('timed powers are exclusive, which is what makes one clock correct', () => {
    let s = onCrate('damage');
    s = take(s);
    const p1 = s.players.byId[1]!;
    expect(p1.powerFlags & POWER_DOUBLE_DAMAGE).toBe(POWER_DOUBLE_DAMAGE);

    // Drop a second, different timed crate on top of them.
    s = step(
      s,
      {},
      [{ type: 'spawnPickup', pickupId: 51, kind: 'reload', x: p1.pos.x, y: p1.pos.y }],
      map,
    );
    s = take(s);
    const p2 = s.players.byId[1]!;
    expect(p2.powerFlags & POWER_FAST_RELOAD).toBe(POWER_FAST_RELOAD);
    expect(p2.powerFlags & POWER_DOUBLE_DAMAGE).toBe(0);
  });

  it('the jail card is untimed and survives a timed power lapsing', () => {
    let s = onCrate('jailcard');
    s = take(s);
    const p = s.players.byId[1]!;
    expect(p.powerFlags & POWER_JAIL_CARD).toBe(POWER_JAIL_CARD);
    p.powerFlags |= POWER_DOUBLE_DAMAGE;
    p.powerUntilTick = s.tick + 1;
    for (let i = 0; i < 5; i++) s = take(s);
    const after = s.players.byId[1]!;
    expect(after.powerFlags & POWER_TIMED).toBe(0);
    expect(after.powerFlags & POWER_JAIL_CARD).toBe(POWER_JAIL_CARD);
  });

  it('timed powers lapse on their own', () => {
    // The crate is collected on the tick it spawns under the player, so the
    // clock is already running when onCrate returns.
    let s = onCrate('invis');
    const secs = getTuning().pickups.kinds['invis']!.value;
    expect(s.players.byId[1]!.powerUntilTick - s.tick).toBe(Math.round(secs * 30));
    for (let i = 0; i < Math.round(secs * 30) + 2; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map);
    }
    expect(s.players.byId[1]!.powerFlags & POWER_INVISIBLE).toBe(0);
  });

  it('double damage doubles what a shot takes off', () => {
    const shoot = (withPower: boolean): number => {
      let s = createGameState(77);
      s = step(
        s,
        {},
        [
          {
            type: 'spawnPlayer',
            playerId: 1,
            name: 'a',
            loadout: [{ weaponId: 'pistol', ammo: 50 }],
          },
          { type: 'spawnPlayer', playerId: 2, name: 'b' },
        ],
        map,
      );
      const shooter = s.players.byId[1]!;
      const spot = clearSpot(map, shooter.pos, 40);
      s.players.byId[2]!.pos = { x: spot.x, y: spot.y };
      if (withPower) {
        shooter.powerFlags = POWER_DOUBLE_DAMAGE;
        shooter.powerUntilTick = s.tick + 300;
      }
      const aim = Math.atan2(spot.y - shooter.pos.y, spot.x - shooter.pos.x);
      s = step(s, { 1: { ...NULL_INPUT, seq: 1, tick: s.tick, fire: true, aimAngle: aim } }, [], map);
      return 100 - s.players.byId[2]!.health;
    };
    const plain = shoot(false);
    expect(plain).toBeGreaterThan(0);
    expect(shoot(true)).toBe(plain * 2);
  });

  it('fast reload halves the gap between shots', () => {
    let s = onCrate('reload');
    const p = s.players.byId[1]!;
    p.powerFlags = POWER_FAST_RELOAD;
    p.powerUntilTick = s.tick + 900;
    const aim = clearSpot(map, p.pos, 40).angle;
    s = step(s, { 1: { ...NULL_INPUT, seq: 1, tick: s.tick, fire: true, aimAngle: aim } }, [], map);
    const boosted = s.players.byId[1]!.fireCooldown;
    let plainState = onCrate('health'); // a control with no power lit
    plainState = step(
      plainState,
      { 1: { ...NULL_INPUT, seq: 1, tick: plainState.tick, fire: true, aimAngle: aim } },
      [],
      map,
    );
    const plain = plainState.players.byId[1]!.fireCooldown;
    expect(boosted).toBe(Math.max(1, Math.round(plain / 2)));
  });

  it('invisibility drops you off the police radar', () => {
    let s = createGameState(909);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'ghost' }], map);
    const p = s.players.byId[1]!;
    p.heat = 250;
    const spot = clearSpot(map, p.pos, 60);
    insertEntity(s.cops, createCop(500, { x: spot.x, y: spot.y }, 50));
    // Seen first...
    s = step(s, { 1: NULL_INPUT }, [], map);
    expect(s.cops.byId[500]!.targetId).toBe(1);
    // ...then not.
    const me = s.players.byId[1]!;
    me.powerFlags = POWER_INVISIBLE;
    me.powerUntilTick = s.tick + 300;
    me.heat = 250;
    s = step(s, { 1: NULL_INPUT }, [], map);
    expect(s.cops.byId[500]!.targetId).toBeNull();
  });

  it('the jail card is spent instead of the arrest, once', () => {
    let s = createGameState(910);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'lucky' }], map);
    const p = s.players.byId[1]!;
    p.heat = 250;
    p.powerFlags = POWER_JAIL_CARD;
    // On ground the map has, for the reason `police.test.ts` spells out: eight
    // pixels east of spawn zero is whatever the bake put there, and an arrest
    // that never happens makes this look like a jail-card bug.
    const beat = clearSpot(map, p.pos, 8);
    insertEntity(s.cops, createCop(500, { x: beat.x, y: beat.y }, 50));
    const events: SimEvent[] = [];
    s = step(s, { 1: NULL_INPUT }, [], map, events);
    expect(events.some((e) => e.type === 'jailCardUsed')).toBe(true);
    expect(events.some((e) => e.type === 'busted')).toBe(false);
    const after = s.players.byId[1]!;
    expect(after.mode).toBe('foot'); // walked away
    expect(after.powerFlags & POWER_JAIL_CARD).toBe(0); // and it is gone
    expect(after.heat).toBe(0);

    // Second time, with no card left, they are nicked — once the officer is
    // off the cadence the first attempt put them on.
    const events2: SimEvent[] = [];
    for (let i = 0; i < 20 && !events2.some((e) => e.type === 'busted'); i++) {
      const me = s.players.byId[1]!;
      me.heat = 250;
      s = step(s, { 1: NULL_INPUT }, [], map, events2);
    }
    expect(events2.some((e) => e.type === 'busted')).toBe(true);
  });

  it('worldgen scatters power-up crates, and staples still dominate', () => {
    const kinds = map.pickupSpawns.map((s) => s.kind);
    const staples = kinds.filter((k) => k === 'health' || k === 'ammo' || k === 'armour').length;
    for (const k of ['bribe', 'jailcard', 'damage', 'invis', 'reload']) {
      expect(kinds, k).toContain(k);
    }
    expect(staples / kinds.length).toBeGreaterThan(0.6);
  });

  it('collecting a power-up is deterministic', () => {
    const run = (): number => hashState(take(onCrate('damage')));
    expect(run()).toBe(run());
  });
});

describe('multiplier crates (O2)', () => {
  it('worldgen scatters them, but rarely — staples still dominate', () => {
    const kinds = map.pickupSpawns.map((s) => s.kind);
    expect(kinds).toContain('multi');
    const multis = kinds.filter((k) => k === 'multi').length;
    // Rare on purpose: a multiplier you can find often makes frenzies and
    // missions — the two things the multiplier exists to reward — not worth
    // doing. Under one crate in twenty.
    expect(multis / kinds.length).toBeLessThan(0.05);
    const staples = kinds.filter((k) => k === 'health' || k === 'ammo' || k === 'armour').length;
    expect(staples / kinds.length).toBeGreaterThan(0.6);
  });

  it('taking one always succeeds, and changes nothing in the sim', () => {
    // The crate's whole effect is the event it emits: nothing in step() reads
    // a multiplier, so the sim side deliberately does nothing at all.
    //
    // Built by hand rather than through onCrate, because a crate spawned
    // under a player is consumed on that same tick and its event goes to the
    // step that spawned it — which onCrate discards.
    let state = createGameState(4242);
    state = step(
      state,
      {},
      [{ type: 'spawnPlayer', playerId: 1, name: 'collector' }],
      map,
    );
    const p0 = state.players.byId[1]!;
    const events: SimEvent[] = [];
    state = step(
      state,
      {},
      [{ type: 'spawnPickup', pickupId: 60, kind: 'multi', x: p0.pos.x, y: p0.pos.y }],
      map,
      events,
    );
    const taken = events.find((e) => e.type === 'pickupTaken');
    expect(taken).toBeDefined();
    if (taken && taken.type === 'pickupTaken') {
      expect(taken.kind).toBe('multi');
      expect(taken.playerId).toBe(1);
    }
    // The crate is spent...
    expect(state.pickups.byId[60]!.active).toBe(false);
    // ...and no player field moved because of it.
    const p = state.players.byId[1]!;
    expect(p.powerFlags).toBe(0);
    expect(p.health).toBe(100);
    expect(p.frenzyTarget).toBe(0);
  });

  it('collecting one is deterministic', () => {
    const run = (): number => hashState(take(onCrate('multi')));
    expect(run()).toBe(run());
  });
});
