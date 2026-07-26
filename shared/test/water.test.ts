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
import { rayWallDistance } from '../src/sim/weapons.js';
import type { SimCommand } from '../src/sim/commands.js';
import {
  T_BUILDING,
  T_FIELD,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_WATER,
  TILE_SIZE,
  tileAt,
  type CityMap,
} from '../src/world/types.js';

const params = parseWorldgenParams(worldgenJson);
const map = generateCity(2026, params);

/** Synthetic bay: water columns 0–11, sand 12–13, open field beyond. */
function bayMap(): CityMap {
  const W = 60;
  const H = 40;
  const tiles = new Uint8Array(W * H).fill(T_FIELD);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < 12; tx++) tiles[ty * W + tx] = T_WATER;
    tiles[ty * W + 12] = T_SAND;
    tiles[ty * W + 13] = T_SAND;
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
    playerSpawns: [{ x: 12.5 * TILE_SIZE, y: 20 * TILE_SIZE }],
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

describe('waterfront worldgen', () => {
  it('carves water, beach, and promenade on exactly one edge', () => {
    const W = map.widthTiles;
    const H = map.heightTiles;
    let water = 0;
    let sand = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === T_WATER) water++;
      if (map.tiles[i] === T_SAND) sand++;
    }
    expect(water).toBeGreaterThan(W * 6); // a real waterfront, not a puddle
    expect(sand).toBeGreaterThan(W * 1.5);

    // Water hugs one edge: every water tile within waterWidth+2 of some edge.
    const margin = params.waterWidth + 2;
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        if (tileAt(map, tx, ty) !== T_WATER) continue;
        const nearEdge = tx < margin || ty < margin || tx >= W - margin || ty >= H - margin;
        expect(nearEdge).toBe(true);
      }
    }

    // Somewhere a promenade: sidewalk with sand right beside it.
    let promenade = 0;
    for (let ty = 1; ty < H - 1; ty++) {
      for (let tx = 1; tx < W - 1; tx++) {
        if (tileAt(map, tx, ty) !== T_SIDEWALK) continue;
        if (
          tileAt(map, tx - 1, ty) === T_SAND ||
          tileAt(map, tx + 1, ty) === T_SAND ||
          tileAt(map, tx, ty - 1) === T_SAND ||
          tileAt(map, tx, ty + 1) === T_SAND
        ) {
          promenade++;
        }
      }
    }
    expect(promenade).toBeGreaterThan(50);

    // Nothing is built in the sea and no road runs into it.
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const t = tileAt(map, tx, ty);
        if (t !== T_WATER) continue;
        expect(t).not.toBe(T_BUILDING);
        expect(t).not.toBe(T_ROAD);
      }
    }
    for (const b of map.buildings) {
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          expect(tileAt(map, tx, ty)).not.toBe(T_WATER);
        }
      }
    }
  });

  it('boat spawns sit on water; moored rows near the beach', () => {
    expect(map.boatSpawns.length).toBeGreaterThan(10);
    expect(map.boatSpawns.some((b) => b.moored)).toBe(true);
    expect(map.boatSpawns.some((b) => !b.moored)).toBe(true);
    for (const b of map.boatSpawns) {
      const tx = Math.floor(b.x / TILE_SIZE);
      const ty = Math.floor(b.y / TILE_SIZE);
      expect(tileAt(map, tx, ty)).toBe(T_WATER);
    }
  });

  it('waterWidth 0 regenerates the land-locked city (replay back-compat)', () => {
    const dry = generateCity(2026, { ...params, waterWidth: 0 });
    for (let i = 0; i < dry.tiles.length; i++) {
      expect(dry.tiles[i]).not.toBe(T_WATER);
      expect(dry.tiles[i]).not.toBe(T_SAND);
    }
    expect(dry.boatSpawns.length).toBe(0);
  });
});

describe('water and boats in the sim', () => {
  it('players cannot walk into the sea; bullets fly over it', () => {
    const m = bayMap();
    let state = createGameState(5);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'swimmer' }], m);
    for (let i = 0; i < 200; i++) {
      state = step(state, { 1: key(1 + i, { left: true }) }, [], m);
      const p = state.players.byId[1]!;
      const tx = Math.floor(p.pos.x / TILE_SIZE);
      const ty = Math.floor(p.pos.y / TILE_SIZE);
      expect(tileAt(m, tx, ty)).not.toBe(T_WATER); // beached, never swimming
    }
    // Shots carry across the whole bay (water never blocks the ray).
    const d = rayWallDistance(m, 13.5 * TILE_SIZE, 20 * TILE_SIZE, -1, 0, 180);
    expect(d).toBe(180);
  });

  it('an ambient boat cruises the bay, stays on water, deterministically', () => {
    const run = (): { state: GameState; dist: number } => {
      const m = bayMap();
      let state = createGameState(7);
      const cmds: SimCommand[] = [
        {
          type: 'spawnVehicle',
          vehicleId: 50,
          kind: 'boat',
          x: 6 * TILE_SIZE,
          y: 8 * TILE_SIZE,
          heading: Math.PI / 2,
          ai: true,
        },
      ];
      state = step(state, {}, cmds, m);
      let dist = 0;
      let prev = { x: 6 * TILE_SIZE, y: 8 * TILE_SIZE };
      for (let i = 0; i < 600; i++) {
        state = step(state, {}, [], m);
        const v = state.vehicles.byId[50]!;
        const tx = Math.floor(v.pos.x / TILE_SIZE);
        const ty = Math.floor(v.pos.y / TILE_SIZE);
        expect(tileAt(m, tx, ty)).toBe(T_WATER); // never runs aground
        dist += Math.hypot(v.pos.x - prev.x, v.pos.y - prev.y);
        prev = { x: v.pos.x, y: v.pos.y };
      }
      return { state, dist };
    };
    const a = run();
    expect(a.dist).toBeGreaterThan(600); // it genuinely sails
    const b = run();
    expect(hashState(b.state)).toBe(hashState(a.state));
  });

  it('a moored boat can be boarded from the beach, driven, and only exited ashore', () => {
    const m = bayMap();
    let state = createGameState(9);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'sailor' }], m);
    // Moored just off the sand (player stands at x=200 on the beach).
    const cmds: SimCommand[] = [
      {
        type: 'spawnVehicle',
        vehicleId: 60,
        kind: 'boat',
        x: 11 * TILE_SIZE,
        y: 20 * TILE_SIZE,
        heading: Math.PI / 2, // bow along the shore
      },
    ];
    state = step(state, {}, cmds, m);
    state = step(state, { 1: key(1, { action: true }) }, [], m);
    expect(state.players.byId[1]!.mode).toBe('driving');
    expect(state.players.byId[1]!.vehicleId).toBe(60);

    // Sail out into open water.
    let seq = 2;
    state = step(state, { 1: key(seq++, {}) }, [], m);
    for (let i = 0; i < 55; i++) {
      state = step(state, { 1: key(seq++, { up: true, right: true }) }, [], m);
    }
    const atSea = state.vehicles.byId[60]!;
    expect(Math.floor(atSea.pos.x / TILE_SIZE)).toBeLessThan(10); // genuinely offshore
    // Wait for the boat to coast to a stop, far from land.
    for (let i = 0; i < 90; i++) state = step(state, { 1: key(seq++, {}) }, [], m);

    // Mid-water exit is refused — you stay at the helm.
    state = step(state, { 1: key(seq++, { action: true }) }, [], m);
    expect(state.players.byId[1]!.mode).toBe('driving');

    // Sail back until the hull noses the beach, then step ashore.
    state = step(state, { 1: key(seq++, {}) }, [], m);
    for (let i = 0; i < 240 && state.players.byId[1]!.mode === 'driving'; i++) {
      const v = state.vehicles.byId[60]!;
      const wantExit = v.pos.x > 10.6 * TILE_SIZE && Math.abs(v.speed) < 30;
      state = step(
        state,
        { 1: key(seq++, wantExit ? { action: true } : { up: v.pos.x < 10.6 * TILE_SIZE, left: v.heading > 0.1, right: v.heading < -0.1 }) },
        [],
        m,
      );
    }
    const p = state.players.byId[1]!;
    expect(p.mode).toBe('foot');
    const tx = Math.floor(p.pos.x / TILE_SIZE);
    const ty = Math.floor(p.pos.y / TILE_SIZE);
    expect(tileAt(m, tx, ty)).not.toBe(T_WATER); // stepped out onto land
  });
});
