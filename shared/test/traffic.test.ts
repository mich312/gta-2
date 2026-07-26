import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import { hashState } from '../src/net/hash.js';
import { boxInSolid } from '../src/world/collide.js';
import type { SimCommand } from '../src/sim/commands.js';
import {
  T_FIELD,
  T_ROAD,
  TILE_SIZE,
  tileAt,
  type CityMap,
} from '../src/world/types.js';

const map = generateCity(2026, parseWorldgenParams(worldgenJson));

/**
 * Synthetic arena: open field with one horizontal 4-tile arterial corridor
 * (rows 18–21) across the full width. Lane centres: eastbound ≈ y 330.67,
 * westbound ≈ y 309.33.
 */
function corridorMap(): CityMap {
  const W = 80;
  const H = 40;
  const tiles = new Uint8Array(W * H).fill(T_FIELD);
  for (let ty = 18; ty <= 21; ty++) {
    for (let tx = 0; tx < W; tx++) tiles[ty * W + tx] = T_ROAD;
  }
  return {
    seed: 0,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles,
    district: new Uint8Array(W * H),
    blocks: [],
    buildings: [],
    shops: [],
    vehicleSpawns: [],
    trafficSpawns: [],
    boatSpawns: [],
    playerSpawns: [{ x: 500, y: 330 }],
    pedSpawns: [],
    propSpawns: [],
  };
}

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson, traffic: trafficJson });
});

function key(seq: number, keys: Partial<InputIntent>): InputIntent {
  return { ...NULL_INPUT, seq, tick: seq, ...keys };
}

function spawnTraffic(state: GameState, spots: Array<{ x: number; y: number; heading: number }>, m: CityMap): GameState {
  const cmds: SimCommand[] = spots.map((s, i) => ({
    type: 'spawnVehicle',
    vehicleId: 100 + i,
    kind: 'car',
    x: s.x,
    y: s.y,
    heading: s.heading,
    ai: true,
  }));
  return step(state, {}, cmds, m);
}

describe('ambient traffic', () => {
  it('worldgen emits lane-centred arterial spawn points with cardinal headings', () => {
    expect(map.trafficSpawns.length).toBeGreaterThan(40);
    for (const s of map.trafficSpawns) {
      const tx = Math.floor(s.x / TILE_SIZE);
      const ty = Math.floor(s.y / TILE_SIZE);
      expect(tileAt(map, tx, ty)).toBe(T_ROAD);
      const quarter = s.heading / (Math.PI / 2);
      expect(Math.abs(quarter - Math.round(quarter))).toBeLessThan(1e-9);
    }
  });

  it('cruises its lane on a straight arterial and reaches cruise speed', () => {
    const m = corridorMap();
    let state = createGameState(7);
    state = spawnTraffic(state, [{ x: 200, y: 330, heading: 0 }], m);
    for (let i = 0; i < 200; i++) state = step(state, {}, [], m);
    const v = state.vehicles.byId[100]!;
    expect(v.speed).toBeGreaterThan(95); // at cruise
    expect(v.pos.x).toBeGreaterThan(700); // it really covered ground
    expect(Math.abs(v.pos.y - 330.67)).toBeLessThan(8); // holds the right lane
    expect(v.pos.y).toBeGreaterThan(18 * TILE_SIZE); // never left the road
    expect(v.pos.y).toBeLessThan(22 * TILE_SIZE);
  });

  it('brakes for a player on foot instead of running them over', () => {
    const m = corridorMap();
    let state = createGameState(9);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'jaywalker' }], m);
    expect(state.players.byId[1]!.pos).toEqual({ x: 500, y: 330 });
    state = spawnTraffic(state, [{ x: 320, y: 330, heading: 0 }], m);
    let minGap = Infinity;
    let minX = Infinity;
    for (let i = 0; i < 300; i++) {
      state = step(state, { 1: key(1 + i, {}) }, [], m);
      const v = state.vehicles.byId[100]!;
      const p = state.players.byId[1]!;
      // The car must never touch the player: no overlap, no damage.
      minGap = Math.min(minGap, Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y));
      expect(p.health).toBe(100);
      minX = Math.min(minX, v.pos.x);
    }
    expect(minGap).toBeGreaterThan(16);
    // After the blocked timeout the car gave up and drove away.
    expect(minX).toBeLessThan(420);
  });

  it('a stopped traffic car can be carjacked and stays a normal car', () => {
    const m = corridorMap();
    let state = createGameState(11);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], m);
    state = spawnTraffic(state, [{ x: 480, y: 330, heading: 0 }], m);
    expect(state.vehicles.byId[100]!.ai).toBe(1);
    state = step(state, { 1: key(1, { action: true }) }, [], m);
    const p = state.players.byId[1]!;
    expect(p.mode).toBe('driving');
    expect(p.vehicleId).toBe(100);
    expect(state.vehicles.byId[100]!.ai).toBe(0);
    // Drive it: player inputs steer it now, not the traffic brain.
    for (let i = 0; i < 60; i++) state = step(state, { 1: key(2 + i, { up: true }) }, [], m);
    expect(state.vehicles.byId[100]!.speed).toBeGreaterThan(150); // past traffic cruise
  });

  it('opposing cars sort into right-hand lanes and pass without touching', () => {
    const m = corridorMap();
    let state = createGameState(13);
    // Both spawned dead-centre in the SAME line — lane keeping must separate
    // them before they meet, and they must flow past each other, not gridlock.
    state = spawnTraffic(
      state,
      [
        { x: 400, y: 330, heading: 0 },
        { x: 700, y: 330, heading: Math.PI },
      ],
      m,
    );
    let minGap = Infinity;
    let passed = false;
    for (let i = 0; i < 240; i++) {
      state = step(state, {}, [], m);
      const a = state.vehicles.byId[100]!;
      const b = state.vehicles.byId[101]!;
      minGap = Math.min(minGap, Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y));
      if (a.pos.x > b.pos.x + 60) passed = true;
    }
    expect(minGap).toBeGreaterThan(17); // never collided
    expect(passed).toBe(true); // traffic flows in both directions
  });

  it('roams the real city staying on roads, and is bit-deterministic', () => {
    const spots = map.trafficSpawns.filter((_, i) => i % 7 === 0).slice(0, 12);
    expect(spots.length).toBe(12);

    const run = (ticks: number): { state: GameState; onRoad: number; samples: number; dist: number[] } => {
      let state = createGameState(2026);
      state = spawnTraffic(state, spots, map);
      const dist = spots.map(() => 0);
      const prev = spots.map((s) => ({ x: s.x, y: s.y }));
      let onRoad = 0;
      let samples = 0;
      for (let i = 0; i < ticks; i++) {
        state = step(state, {}, [], map);
        if (i % 10 !== 0) continue;
        for (let c = 0; c < spots.length; c++) {
          const v = state.vehicles.byId[100 + c]!;
          expect(boxInSolid(map, v.pos, 9)).toBe(false); // never inside a building
          samples++;
          const tx = Math.floor(v.pos.x / TILE_SIZE);
          const ty = Math.floor(v.pos.y / TILE_SIZE);
          if (tileAt(map, tx, ty) === T_ROAD) onRoad++;
          dist[c]! += Math.hypot(v.pos.x - prev[c]!.x, v.pos.y - prev[c]!.y);
          prev[c]!.x = v.pos.x;
          prev[c]!.y = v.pos.y;
        }
      }
      return { state, onRoad, samples, dist };
    };

    const a = run(900);
    expect(a.onRoad / a.samples).toBeGreaterThan(0.9); // traffic lives on the road
    for (const d of a.dist) expect(d).toBeGreaterThan(400); // every car actually drives

    const b = run(900);
    expect(hashState(b.state)).toBe(hashState(a.state)); // lockstep determinism
  });
});
