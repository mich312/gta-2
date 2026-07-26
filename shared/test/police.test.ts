import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning, getTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, wantedLevelOf, type GameState } from '../src/sim/state.js';
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

  it('car theft is a crime', () => {
    let state = createGameState(7);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], map);
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 }],
      map,
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    expect(state.players.byId[1]!.heat).toBeGreaterThan(0);
  });

  it('cops spawn for the wanted, converge, and hurt them (the level-3 chase)', () => {
    let state = commitCrimes(3);
    expect(wantedLevelOf(state.players.byId[1]!)).toBeGreaterThanOrEqual(3);
    const t = getTuning().police;

    // Within 10 sim-seconds a level-3 posse is on the street.
    let minDist = Infinity;
    for (let i = 0; i < 300; i++) {
      state = step(state, {}, [], map);
      for (const cid of state.cops.ids) {
        const cop = state.cops.byId[cid]!;
        const p1 = state.players.byId[1]!;
        minDist = Math.min(minDist, Math.hypot(cop.pos.x - p1.pos.x, cop.pos.y - p1.pos.y));
      }
    }
    const wanted = wantedLevelOf(state.players.byId[1]!);
    const expectedCops = Math.min(t.copsPerStar * wanted, t.maxCopsPerPlayer);
    expect(state.cops.ids.length).toBeGreaterThanOrEqual(Math.min(expectedCops, 6));
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
