import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import { hashState } from '../src/net/hash.js';
import type { SimCommand } from '../src/sim/commands.js';

const map = generateCity(4242, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

function scriptedIntent(tick: number, playerId: number): InputIntent {
  const phase = Math.floor(tick / 20) + playerId;
  return {
    ...NULL_INPUT,
    seq: tick,
    tick,
    up: phase % 4 === 0,
    right: phase % 4 === 1,
    down: phase % 4 === 2,
    left: phase % 4 === 3,
    aimAngle: ((tick * 7 + playerId) % 100) / 50 - 1,
  };
}

function runSession(seed: number, ticks: number): GameState {
  let state = createGameState(seed);
  const spawn: SimCommand[] = [
    { type: 'spawnPlayer', playerId: 1, name: 'a' },
    { type: 'spawnPlayer', playerId: 2, name: 'b' },
  ];
  state = step(state, {}, spawn, map);
  for (let t = 0; t < ticks; t++) {
    state = step(
      state,
      { 1: scriptedIntent(state.tick, 1), 2: scriptedIntent(state.tick, 2) },
      [],
      map,
    );
  }
  return state;
}

describe('step', () => {
  it('same seed + same inputs => bit-identical state', () => {
    const a = runSession(777, 300);
    const b = runSession(777, 300);
    expect(hashState(a)).toBe(hashState(b));
    expect(a).toEqual(b);
  });

  it('different seeds diverge', () => {
    expect(hashState(runSession(1, 50))).not.toBe(hashState(runSession(2, 50)));
  });

  it('never mutates its input state', () => {
    let state = createGameState(5);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    const before = hashState(state);
    step(state, { 1: scriptedIntent(1, 1) }, [{ type: 'despawnPlayer', playerId: 1 }], map);
    expect(hashState(state)).toBe(before);
  });

  it('spawn is idempotent and despawn removes', () => {
    let state = createGameState(9);
    state = step(
      state,
      {},
      [
        { type: 'spawnPlayer', playerId: 1, name: 'x' },
        { type: 'spawnPlayer', playerId: 1, name: 'x' },
      ],
      map,
    );
    expect(state.players.ids).toEqual([1]);
    state = step(state, {}, [{ type: 'despawnPlayer', playerId: 1 }], map);
    expect(state.players.ids).toEqual([]);
  });

  it('players move when given input and stop without it', () => {
    let state = createGameState(11);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    const start = { ...state.players.byId[1]!.pos };
    for (let i = 0; i < 30; i++) {
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick, right: true } },
        [],
        map,
      );
    }
    const moved = state.players.byId[1]!.pos;
    expect(Math.abs(moved.x - start.x) + Math.abs(moved.y - start.y)).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) {
      state = step(state, {}, [], map);
    }
    expect(state.players.byId[1]!.vel.x).toBe(0);
    expect(state.players.byId[1]!.vel.y).toBe(0);
  });
});
