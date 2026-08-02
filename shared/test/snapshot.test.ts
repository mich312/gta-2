import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { takeSnapshot, diffSnapshots, applyDelta } from '../src/net/snapshot.js';
import { hashSnapshot } from '../src/net/hash.js';

const map = generateCity(910, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

describe('snapshot delta', () => {
  it('applyDelta(diff(a,b), a) reproduces b exactly (moves + add + remove)', () => {
    let state = createGameState(42);
    state = step(state, {}, [
      { type: 'spawnPlayer', playerId: 1, name: 'a' },
      { type: 'spawnPlayer', playerId: 2, name: 'b' },
    ], map);
    for (let i = 0; i < 25; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick, down: true } }, [], map);
    }
    const snapA = takeSnapshot(state);

    // move, remove player 2, add player 3
    for (let i = 0; i < 10; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: 100 + i, tick: state.tick, left: true } }, [], map);
    }
    state = step(state, {}, [
      { type: 'despawnPlayer', playerId: 2 },
      { type: 'spawnPlayer', playerId: 3, name: 'c' },
    ], map);
    const snapB = takeSnapshot(state);

    const delta = diffSnapshots(snapA, snapB);
    expect(delta.players.removed).toContain(2);
    expect(delta.players.added.map((p) => p.id)).toContain(3);

    const rebuilt = applyDelta(snapA, delta, snapB.tick);
    // lastInputSeq is deliberately excluded from diffing (bandwidth): patch
    // it over ON COPIES before comparing — snapshots are structurally shared
    // now, so writing on a rebuilt entity could write on the base's — and
    // everything else must reproduce exactly.
    const patched = {
      ...rebuilt,
      players: rebuilt.players.map((p) => ({
        ...p,
        lastInputSeq: snapB.players.find((sp) => sp.id === p.id)!.lastInputSeq,
      })),
    };
    expect(patched).toEqual(snapB);
    expect(hashSnapshot(patched)).toBe(hashSnapshot(snapB));
  });

  it('a motionless player produces no player-table delta', () => {
    let state = createGameState(7);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    for (let i = 0; i < 90; i++) state = step(state, {}, [], map); // settles to rest
    const a = takeSnapshot(state);
    state = step(state, {}, [], map);
    const b = takeSnapshot(state);
    const delta = diffSnapshots(a, b);
    expect(delta.players.added).toEqual([]);
    expect(delta.players.removed).toEqual([]);
    expect(delta.players.updated).toEqual([]);
  });

  it('an empty world produces a wholly empty delta', () => {
    // Vehicles are deliberately NOT asserted quiet in the test above any
    // more: ambient traffic is maintained around players, so a world with a
    // player in it never fully settles. With nobody to drive near, it does.
    let state = createGameState(7);
    for (let i = 0; i < 60; i++) state = step(state, {}, [], map);
    const a = takeSnapshot(state);
    state = step(state, {}, [], map);
    const delta = diffSnapshots(a, takeSnapshot(state));
    for (const table of [delta.players, delta.vehicles, delta.cops, delta.peds, delta.props]) {
      expect(table.added).toEqual([]);
      expect(table.updated).toEqual([]);
      expect(table.removed).toEqual([]);
    }
  });

  it('clones an entity the delta names (mutating a changed entity leaves base intact)', () => {
    let state = createGameState(3);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const a = takeSnapshot(state);
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: state.tick, up: true } }, [], map);
    const b = takeSnapshot(state);
    const rebuilt = applyDelta(a, diffSnapshots(a, b), b.tick);
    rebuilt.players[0]!.pos.x = -9999;
    expect(a.players[0]!.pos.x).not.toBe(-9999);
    expect(b.players[0]!.pos.x).not.toBe(-9999);
  });

  /**
   * The other half of the copy-on-write contract: an entity the delta does
   * NOT name rides into the new snapshot by reference.
   *
   * This is what took `applyDelta` off the allocation profile — the old
   * version cloned all seven tables entity-by-entity, thirty times a second,
   * on the render thread, and the history buffers kept the copies alive long
   * enough to be promoted and collected as major pauses. The price is that
   * snapshots are read-only: anything that wants to write on an entity out of
   * one clones it first.
   */
  it('shares an entity the delta does not name, and the untouched table whole', () => {
    let state = createGameState(3);
    state = step(state, {}, [
      { type: 'spawnPlayer', playerId: 1, name: 'a' },
      { type: 'spawnPlayer', playerId: 2, name: 'b' },
    ], map);
    for (let i = 0; i < 90; i++) state = step(state, {}, [], map); // both settle to rest
    const a = takeSnapshot(state);
    // Only player 1 moves; player 2 stays put.
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: state.tick, up: true } }, [], map);
    const b = takeSnapshot(state);
    const delta = diffSnapshots(a, b);
    expect(delta.players.updated.map((p) => p.id)).toEqual([1]);

    const rebuilt = applyDelta(a, delta, b.tick);
    const still = (snap: typeof a) => snap.players.find((p) => p.id === 2);
    expect(still(rebuilt)).toBe(still(a));
    expect(rebuilt.players.find((p) => p.id === 1)).not.toBe(a.players.find((p) => p.id === 1));
    // A table with no delta at all is the same ARRAY, not merely the same
    // entities — props never moved, so the props table is carried whole.
    expect(delta.props.updated).toEqual([]);
    expect(rebuilt.props).toBe(a.props);
  });

  it('keeps every table id-sorted through interleaved adds and removes', () => {
    // The old implementation re-sorted the whole table on every application;
    // the merge now relies on `added` being id-sorted, so an add that lands
    // BETWEEN surviving ids has to come out in order.
    let state = createGameState(3);
    state = step(state, {}, [
      { type: 'spawnPlayer', playerId: 2, name: 'b' },
      { type: 'spawnPlayer', playerId: 9, name: 'i' },
    ], map);
    const a = takeSnapshot(state);
    state = step(state, {}, [
      { type: 'despawnPlayer', playerId: 9 },
      { type: 'spawnPlayer', playerId: 1, name: 'a' },
      { type: 'spawnPlayer', playerId: 5, name: 'e' },
      { type: 'spawnPlayer', playerId: 11, name: 'k' },
    ], map);
    const b = takeSnapshot(state);
    const rebuilt = applyDelta(a, diffSnapshots(a, b), b.tick);
    expect(rebuilt.players.map((p) => p.id)).toEqual([1, 2, 5, 11]);
  });

  /**
   * Every field of every entity has to be DIFFED, not merely encoded.
   *
   * A field left out of `VEHICLE_FIELDS` is a spectacularly quiet bug: it
   * still ships in a full snapshot, so it looks perfect on the frame a player
   * joins, and it is then frozen at that value for the rest of the session.
   * The take-off latch shipped like that for exactly one afternoon — a
   * helicopter climbed to cruise height with `climb` stuck at false, so the
   * altitude on the wire said "flying" and the flight control said "landing"
   * all the way up. Enumerating the state rather than the list is the only
   * version of this test that catches the next one.
   */
  it('diffs every field on a vehicle, not merely the ones somebody remembered', () => {
    let state = createGameState(51);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const lane = map.vehicleSpawns[0]!;
    state = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 9001,
          kind: 'chopper',
          x: lane.x,
          y: lane.y,
          heading: 0,
          paint: 4,
        },
      ],
      map,
    );
    const before = takeSnapshot(state);

    // Move every field a vehicle has, by hand: this is about the transport,
    // not about which of them the sim happens to change together.
    const v = state.vehicles.byId[9001]!;
    v.pos = { x: v.pos.x + 8, y: v.pos.y + 8 };
    v.heading = 1;
    v.speed = 40;
    v.driverId = 1;
    v.health = 111;
    v.condition = 'burning';
    v.fuseAtTick = 500;
    v.igniterId = 1;
    v.spreadUsed = 1;
    v.gangId = 2;
    v.zones = [1, 2, 3, 4];
    v.broken = 5;
    v.z = 33;
    v.climb = true;
    v.liftHeld = true;
    v.paint = 7;
    v.fitting = 'mine';
    v.fittingAmmo = 3;
    const after = takeSnapshot(state);

    const rebuilt = applyDelta(before, diffSnapshots(before, after), after.tick);
    const got = rebuilt.vehicles.find((x) => x.id === 9001)!;
    const want = after.vehicles.find((x) => x.id === 9001)!;
    for (const key of Object.keys(want) as Array<keyof typeof want>) {
      expect(`${String(key)}: ${JSON.stringify(got[key])}`).toBe(
        `${String(key)}: ${JSON.stringify(want[key])}`,
      );
    }
  });

  it('a vehicle painted at spawn arrives painted, through a delta', () => {
    // The paint never changes after birth, so it only ever travels on the
    // delta that ADDS the vehicle — which is the path a session takes for
    // every parked car it reseeds after the window moves.
    let state = createGameState(52);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const before = takeSnapshot(state);
    const lane = map.vehicleSpawns[1]!;
    state = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 9002,
          kind: 'car',
          x: lane.x,
          y: lane.y,
          heading: 0,
          paint: 6,
        },
      ],
      map,
    );
    const rebuilt = applyDelta(before, diffSnapshots(before, takeSnapshot(state)), state.tick);
    expect(rebuilt.vehicles.find((x) => x.id === 9002)?.paint).toBe(6);
  });
});
