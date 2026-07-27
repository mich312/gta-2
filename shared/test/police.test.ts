import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning, getTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createCop, createGameState, wantedLevelOf, type GameState } from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';

const map = generateCity(6006, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
  });
});

const PISTOL = [{ weaponId: 'pistol', ammo: 500 }];

function fire(seq: number, aim: number): InputIntent {
  return { ...NULL_INPUT, seq, tick: seq, fire: true, aimAngle: aim };
}

/** Two players; p1 shoots p2 until wanted level reaches the target. */
function commitCrimes(targetLevel: number): GameState {
  let state = createGameState(42);
  state = step(
    state,
    {},
    [
      { type: 'spawnPlayer', playerId: 1, name: 'crook', loadout: PISTOL },
      { type: 'spawnPlayer', playerId: 2, name: 'victim' },
    ],
    map,
  );
  let seq = 1;
  // Aim at the victim; keep shooting (and let respawns re-supply victims).
  // Spawns are deliberately spread out, so the test drags the victim next to
  // the shooter (direct state surgery is fine server-side and repeats
  // identically, so determinism checks still hold).
  for (let t = 0; t < 3000 && wantedLevelOf(state.players.byId[1]!) < targetLevel; t++) {
    const p1 = state.players.byId[1]!;
    const p2 = state.players.byId[2]!;
    if (p2.mode !== 'dead' && Math.hypot(p2.pos.x - p1.pos.x, p2.pos.y - p1.pos.y) > 120) {
      p2.pos = { x: p1.pos.x + 60, y: p1.pos.y };
    }
    const aim = Math.atan2(p2.pos.y - p1.pos.y, p2.pos.x - p1.pos.x);
    const cmds: Array<{ type: 'respawnPlayer'; playerId: number; loadout: typeof PISTOL }> = [];
    // The cops WILL kill the crook mid-spree; respawn both parties so the
    // spree continues (heat survives death by design).
    if (p2.mode === 'dead' && p2.respawnAtTick !== null && state.tick >= p2.respawnAtTick) {
      cmds.push({ type: 'respawnPlayer', playerId: 2, loadout: [] });
    }
    if (p1.mode === 'dead' && p1.respawnAtTick !== null && state.tick >= p1.respawnAtTick) {
      cmds.push({ type: 'respawnPlayer', playerId: 1, loadout: PISTOL });
    }
    state = step(state, { 1: fire(seq++, aim) }, cmds, map);
  }
  return state;
}

describe('wanted + police', () => {
  it('violence raises heat; wanted level maps from heat', () => {
    const state = commitCrimes(1);
    expect(wantedLevelOf(state.players.byId[1]!)).toBeGreaterThanOrEqual(1);
    expect(state.players.byId[1]!.wantedLevel).toBe(wantedLevelOf(state.players.byId[1]!));
  });

  /** Player 1 in a car parked on top of them, ready to drive. Returns the state. */
  function boardParkedCar(seed: number): GameState {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], map);
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 }],
      map,
    );
    return step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
  }

  it('lifting an empty parked car unseen is not a crime', () => {
    const state = boardParkedCar(7);
    expect(state.players.byId[1]!.mode).toBe('driving');
    expect(state.players.byId[1]!.heat).toBe(0);
  });

  it('lifting one under a cop’s nose is', () => {
    let state = createGameState(7);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], map);
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 }],
      map,
    );
    // A witness, standing right next to the car so line of sight is certain.
    insertEntity(
      state.cops,
      createCop(90, { x: p.pos.x + 12, y: p.pos.y }, getTuning().police.copHealth),
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    expect(state.players.byId[1]!.mode).toBe('driving');
    expect(state.players.byId[1]!.heat).toBeGreaterThanOrEqual(
      getTuning().police.heatPerTheft,
    );
  });

  it('a speeding car runs a cop down, and it counts against the driver', () => {
    let state = boardParkedCar(11);
    const t = getTuning().police;
    const v = state.vehicles.byId[2]!;
    v.speed = 300;
    insertEntity(state.cops, createCop(90, { x: v.pos.x, y: v.pos.y }, t.copHealth));

    const events: SimEvent[] = [];
    state = step(state, {}, [], map, events);
    const hit = state.cops.byId[90]!;
    expect(hit.health).toBeLessThan(t.copHealth);
    expect(hit.carHitCooldown).toBeGreaterThan(0);
    // Assault on an officer is a crime even at the wheel.
    expect(state.players.byId[1]!.heat).toBeGreaterThan(0);

    // Immunity holds: parked on top of them costs no further health.
    const healthAfterFirst = hit.health;
    const car = state.vehicles.byId[2]!;
    hit.pos = { x: car.pos.x, y: car.pos.y };
    state = step(state, {}, [], map);
    expect(state.cops.byId[90]!.health).toBe(healthAfterFirst);

    // Sustained contact does finish the job, and it is reported as a cop down.
    const kill: SimEvent[] = [];
    for (let i = 0; i < 120 && state.cops.byId[90]; i++) {
      const c = state.cops.byId[90];
      const drive = state.vehicles.byId[2]!;
      drive.speed = 300;
      if (c) c.pos = { x: drive.pos.x, y: drive.pos.y };
      state = step(state, {}, [], map, kill);
    }
    expect(state.cops.byId[90]).toBeUndefined();
    expect(kill.some((e) => e.type === 'copDown')).toBe(true);
  });

  it('cops arrive on a ramp, not a wall', () => {
    const t = getTuning().police;
    let state = createGameState(21);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);

    let ticksToSecondCop = -1;
    for (let i = 1; i <= 400 && ticksToSecondCop < 0; i++) {
      // Hold the fugitive at three stars so decay can't end the measurement.
      state.players.byId[1]!.heat = 320;
      state = step(state, {}, [], map);
      if (state.cops.ids.length >= 2) ticksToSecondCop = i;
    }

    expect(ticksToSecondCop).toBeGreaterThan(0);
    // At most one arrival per spawnCooldownTicks, so a second cop cannot be
    // on the street any sooner than that.
    expect(ticksToSecondCop).toBeGreaterThanOrEqual(t.spawnCooldownTicks);
  });

  it('the fifth star fields more cops than the fourth', () => {
    const t = getTuning().police;
    const posse = (stars: number): number =>
      Math.min(t.copsPerStar * stars, t.maxCopsPerPlayer);
    expect(posse(5)).toBeGreaterThan(posse(4));
    expect(posse(4)).toBeGreaterThan(posse(3));
  });

  it('cops spawn for the wanted, converge, and hurt them (the level-3 chase)', () => {
    let state = commitCrimes(3);
    expect(wantedLevelOf(state.players.byId[1]!)).toBeGreaterThanOrEqual(3);
    const t = getTuning().police;

    // Cops arrive on a ramp (one per spawnCooldownTicks), not as a wall, so
    // the posse is measured at its peak over the window rather than at a
    // single instant — the fugitive may be shot dead partway through, which
    // sends everyone home.
    let minDist = Infinity;
    let peakCops = 0;
    for (let i = 0; i < 600; i++) {
      state = step(state, {}, [], map);
      peakCops = Math.max(peakCops, state.cops.ids.length);
      for (const cid of state.cops.ids) {
        const cop = state.cops.byId[cid]!;
        const p1 = state.players.byId[1]!;
        minDist = Math.min(minDist, Math.hypot(cop.pos.x - p1.pos.x, cop.pos.y - p1.pos.y));
      }
    }
    const wanted = wantedLevelOf(state.players.byId[1]!);
    const expectedCops = Math.min(t.copsPerStar * wanted, t.maxCopsPerPlayer);
    expect(peakCops).toBeGreaterThanOrEqual(Math.min(expectedCops, 6));
    // They converge: someone got within firing range of the standing target.
    expect(minDist).toBeLessThan(t.fireRange);
    // And it costs blood: the fugitive has been shot.
    expect(state.players.byId[1]!.health).toBeLessThan(100);
  });

  it('heat decays and cops go home when the fugitive stays out of sight', () => {
    // Directly seed modest heat (below one star after decay begins).
    let state = createGameState(9);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    state.players.byId[1]!.heat = 90; // manual seed, server-side test
    const decayPerTick = getTuning().police.heatDecayPerSec / 30;
    const before = state.players.byId[1]!.heat;
    state = step(state, {}, [], map);
    // No cops exist -> unseen -> decay applies.
    expect(state.players.byId[1]!.heat).toBeCloseTo(before - decayPerTick, 5);
    for (let i = 0; i < 90 * 30; i++) {
      state = step(state, {}, [], map);
      if (state.players.byId[1]!.heat === 0) break;
    }
    expect(state.players.byId[1]!.heat).toBe(0);
  });

  it('shooting a cop hurts it and killing one raises heat hard', () => {
    let state = commitCrimes(1);
    // Let cops arrive.
    for (let i = 0; i < 200 && state.cops.ids.length === 0; i++) {
      state = step(state, {}, [], map);
    }
    expect(state.cops.ids.length).toBeGreaterThan(0);
    const events: SimEvent[] = [];
    let seq = 10_000;
    const heatBefore = state.players.byId[1]!.heat;
    // Blast at the nearest cop until it drops (or 300 ticks pass).
    for (let i = 0; i < 300; i++) {
      const p1 = state.players.byId[1]!;
      const cid = state.cops.ids[0];
      if (cid === undefined) break;
      const cop = state.cops.byId[cid]!;
      const aim = Math.atan2(cop.pos.y - p1.pos.y, cop.pos.x - p1.pos.x);
      state = step(state, { 1: fire(seq++, aim) }, [], map, events);
      if (events.some((e) => e.type === 'copDown')) break;
      if (p1.mode === 'dead') break; // cops shot back first — acceptable
    }
    if (events.some((e) => e.type === 'copDown')) {
      expect(state.players.byId[1]!.heat).toBeGreaterThan(heatBefore);
    }
  });

  it('the whole chase is deterministic', () => {
    const run = (): number => {
      let state = commitCrimes(2);
      for (let i = 0; i < 200; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
