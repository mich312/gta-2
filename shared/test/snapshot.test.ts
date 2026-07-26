import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import { initTuning } from '../src/tuning.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { takeSnapshot, diffSnapshots, applyDelta } from '../src/net/snapshot.js';
import { hashSnapshot } from '../src/net/hash.js';

beforeAll(() => {
  initTuning({ player: playerTuning });
});

describe('snapshot delta', () => {
  it('applyDelta(diff(a,b), a) reproduces b exactly (moves + add + remove)', () => {
    let state = createGameState(42);
    state = step(state, {}, [
      { type: 'spawnPlayer', playerId: 1, name: 'a' },
      { type: 'spawnPlayer', playerId: 2, name: 'b' },
    ]);
    for (let i = 0; i < 25; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick, down: true } }, []);
    }
    const snapA = takeSnapshot(state);

    // move, remove player 2, add player 3
    for (let i = 0; i < 10; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: 100 + i, tick: state.tick, left: true } }, []);
    }
    state = step(state, {}, [
      { type: 'despawnPlayer', playerId: 2 },
      { type: 'spawnPlayer', playerId: 3, name: 'c' },
    ]);
    const snapB = takeSnapshot(state);

    const delta = diffSnapshots(snapA, snapB);
    expect(delta.removed).toContain(2);
    expect(delta.added.map((p) => p.id)).toContain(3);

    const rebuilt = applyDelta(snapA, delta, snapB.tick);
    expect(rebuilt).toEqual(snapB);
    expect(hashSnapshot(rebuilt)).toBe(hashSnapshot(snapB));
  });

  it('no changes => empty delta', () => {
    let state = createGameState(7);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }]);
    for (let i = 0; i < 90; i++) state = step(state, {}, []); // settles to rest
    const a = takeSnapshot(state);
    state = step(state, {}, []);
    const b = takeSnapshot(state);
    const delta = diffSnapshots(a, b);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.updated).toEqual([]);
  });

  it('delta application is not a reference share (mutating rebuilt leaves base intact)', () => {
    let state = createGameState(3);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }]);
    const a = takeSnapshot(state);
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: state.tick, up: true } }, []);
    const b = takeSnapshot(state);
    const rebuilt = applyDelta(a, diffSnapshots(a, b), b.tick);
    rebuilt.players[0]!.pos.x = -9999;
    expect(a.players[0]!.pos.x).not.toBe(-9999);
    expect(b.players[0]!.pos.x).not.toBe(-9999);
  });
});
