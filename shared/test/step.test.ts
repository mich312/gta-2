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
import { HALF_PI, PI, wrapAngle } from '../src/math/trig.js';

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

  it('runs towards the mouse: movement is relative to the aim, not the screen', () => {
    // Pick an open spot so nothing is clipping a wall, and drive each of the
    // four keys at four different aim angles. `up` must always go where the
    // player is pointing; `right` must always be a quarter turn clockwise of
    // it on a y-down screen, and so on round.
    const spot = { x: map.playerSpawns[0]!.x, y: map.playerSpawns[0]!.y };
    const keys = [
      { name: 'up', input: { up: true }, offset: 0 },
      { name: 'right', input: { right: true }, offset: HALF_PI },
      { name: 'down', input: { down: true }, offset: PI },
      { name: 'left', input: { left: true }, offset: -HALF_PI },
    ];

    for (const aimAngle of [0, HALF_PI, PI, -HALF_PI * 0.5]) {
      for (const key of keys) {
        let state = createGameState(12);
        state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
        state.players.byId[1]!.pos = { ...spot };
        // Two ticks is enough to have velocity without having travelled far
        // enough to reach anything solid, whatever the map looks like here.
        for (let i = 0; i < 2; i++) {
          state = step(
            state,
            { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick, aimAngle, ...key.input } },
            [],
            map,
          );
        }
        const vel = state.players.byId[1]!.vel;
        expect(Math.hypot(vel.x, vel.y)).toBeGreaterThan(0);
        const heading = Math.atan2(vel.y, vel.x);
        const want = wrapAngle(aimAngle + key.offset);
        expect(Math.abs(wrapAngle(heading - want))).toBeLessThan(0.02);
      }
    }
  });

  it('two keys at once are no faster than one', () => {
    // The diagonal correction has to survive the rotation into aim space, or
    // running forwards-and-right is 41% quicker than running forwards.
    const speeds = [{ up: true }, { up: true, right: true }].map((keys) => {
      let state = createGameState(13);
      state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
      state.players.byId[1]!.pos = { ...map.playerSpawns[0]! };
      for (let i = 0; i < 20; i++) {
        state = step(
          state,
          { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick, aimAngle: 0.7, ...keys } },
          [],
          map,
        );
      }
      const v = state.players.byId[1]!.vel;
      return Math.hypot(v.x, v.y);
    });
    expect(speeds[0]!).toBeGreaterThan(0);
    expect(Math.abs(speeds[1]! - speeds[0]!)).toBeLessThan(0.5);
  });
});
