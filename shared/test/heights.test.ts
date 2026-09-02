import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { hashState } from '../src/net/hash.js';
import { PART_FULL, isSolidTile, solidPartAt } from '../src/world/collide.js';
import { BEV_NONE, bevelOther } from '../src/world/bevel.js';
import { buildingStoreys } from '../src/world/heights.js';
import { BRIDGE_DECK_Z, KERB_Z, TREE_Z, Z_PER_STOREY, groundUnder } from '../src/world/volume.js';
import type { SimEvent } from '../src/sim/events.js';
import { PLAYER_RADIUS } from '../src/constants.js';
import {
  T_BRIDGE,
  T_BUILDING,
  T_ROAD,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  type CityMap,
} from '../src/world/types.js';

/**
 * The ground has height (3D.md X2).
 *
 * The flat simulation asked one question of a tile — solid or not — and
 * rested everything on a plane at zero. With `heights` on, the same solver
 * asks it at the mover's own height, and the stunt integrator lands on the
 * ground under the mover rather than on zero. Kerbs are three px up, a roof
 * is a surface, a fall ends on whatever is below. With it off, nothing here
 * changes — that case is the whole rest of the suite.
 */

const params = parseWorldgenParams(worldgenJson);
let flat: CityMap;
let tall: CityMap;

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson, weapons: weaponsJson });
  flat = generateCity(1, params);
  tall = generateCity(1, { ...params, heights: true });
});

const px = (t: number): number => (t + 0.5) * TILE_SIZE;
const tileAt = (m: CityMap, x: number, y: number): number => m.tiles[y * m.widthTiles + x] as number;

function spawnOnFoot(map: CityMap, seed: number, x: number, y: number, z = 0): GameState {
  let s = createGameState(seed);
  s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'p' }], map);
  const p = s.players.byId[1]!;
  p.pos = { x, y };
  p.vel = { x: 0, y: 0 };
  p.z = z;
  p.vz = 0;
  return s;
}

/**
 * A low building (one or two storeys) with four tiles of walkable ground —
 * pavement or carriageway — east of it on every row it spans and the rows
 * either side. Returns its rect and the height of its roof.
 */
function lowBuildingWithRoadEast(m: CityMap): { x: number; y: number; w: number; h: number; top: number } {
  const walkable = (t: number): boolean => t === T_ROAD || t === T_SIDEWALK;
  for (const b of m.buildings) {
    const storeys = buildingStoreys(b);
    if (storeys > 2 || b.w < 2 || b.h < 2) continue;
    if ((b.angle ?? 0) !== 0) continue;
    let clear = true;
    for (let ty = b.y - 1; ty <= b.y + b.h && clear; ty++) {
      for (let tx = b.x + b.w; tx < b.x + b.w + 4; tx++) {
        if (tx >= m.widthTiles || ty < 0 || ty >= m.heightTiles || !walkable(tileAt(m, tx, ty))) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;
    let solid = true;
    for (let ty = b.y; ty < b.y + b.h && solid; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) if (tileAt(m, tx, ty) !== T_BUILDING) solid = false;
    }
    if (solid) return { x: b.x, y: b.y, w: b.w, h: b.h, top: storeys * Z_PER_STOREY };
  }
  throw new Error('no low building with open ground east of it');
}

/** Road, then pavement, then a wall, in one row going east. */
function kerbThenWall(m: CityMap): { x: number; y: number } {
  for (let ty = 2; ty < m.heightTiles - 2; ty++) {
    for (let tx = 2; tx < m.widthTiles - 4; tx++) {
      if (tileAt(m, tx - 1, ty) !== T_ROAD || tileAt(m, tx, ty) !== T_ROAD) continue;
      if (tileAt(m, tx + 1, ty) !== T_SIDEWALK || tileAt(m, tx + 2, ty) !== T_BUILDING) continue;
      // Room beside the row too, so a car's footprint is not clipped by
      // something in the next row over.
      if (tileAt(m, tx, ty - 1) !== T_ROAD || tileAt(m, tx, ty + 1) !== T_ROAD) continue;
      if (tileAt(m, tx + 1, ty - 1) !== T_SIDEWALK || tileAt(m, tx + 1, ty + 1) !== T_SIDEWALK) continue;
      return { x: tx, y: ty };
    }
  }
  throw new Error('no road/kerb/wall row');
}

describe('the ground field', () => {
  it('exists only when the session asks for heights', () => {
    expect(flat.ground).toBeUndefined();
    expect(tall.ground).toBeDefined();
  });

  it('puts the carriageway at zero, the kerb up, water down and a roof at its storeys', () => {
    const g = tall.ground!;
    const W = tall.widthTiles;
    let road = 0;
    let kerb = 0;
    let water = 0;
    for (let i = 0; i < g.length; i++) {
      const t = tall.tiles[i] as number;
      if (t === T_ROAD && g[i] === 0) road++;
      if (t === T_SIDEWALK && g[i] === KERB_Z) kerb++;
      if (t === T_WATER && g[i] === -8) water++;
    }
    expect(road).toBeGreaterThan(50_000);
    expect(kerb).toBeGreaterThan(20_000);
    expect(water).toBeGreaterThan(200_000);
    const b = lowBuildingWithRoadEast(tall);
    expect(g[b.y * W + b.x]).toBe(b.top);
    // Every building tile has a top, whether or not a record covers it.
    for (let i = 0; i < g.length; i++) {
      if ((tall.tiles[i] as number) === T_BUILDING) expect(g[i]).toBeGreaterThanOrEqual(Z_PER_STOREY);
    }
  });
});

describe("walls at the mover's own height", () => {
  it('a wall reaches every mover on a flat map', () => {
    const b = lowBuildingWithRoadEast(flat);
    expect(isSolidTile(flat, b.x, b.y, 'land', 0)).toBe(true);
    expect(isSolidTile(flat, b.x, b.y, 'land', 1000)).toBe(true);
  });

  it('a roof below your feet is not in your way', () => {
    const b = lowBuildingWithRoadEast(tall);
    expect(isSolidTile(tall, b.x, b.y, 'land', 0)).toBe(true);
    expect(isSolidTile(tall, b.x, b.y, 'land', b.top - 1)).toBe(true);
    expect(isSolidTile(tall, b.x, b.y, 'land', b.top)).toBe(false);
  });

  it('the tree wedge of a wooded shore stands at its own height, not the water’s', () => {
    // A water tile bevelled against trees: the field records the WATER's
    // height, eight px down, and the wood in the other half must not be
    // measured against that. To a walker at ground level the tile is a
    // wall in every part, exactly as on the flat map.
    let found = 0;
    for (let ty = 0; ty < tall.heightTiles; ty++) {
      for (let tx = 0; tx < tall.widthTiles; tx++) {
        const i = ty * tall.widthTiles + tx;
        if ((tall.tiles[i] as number) !== T_WATER || (tall.bevel![i] as number) === BEV_NONE) continue;
        if (bevelOther(tall.tiles, tall.bevel!, tall.widthTiles, tx, ty) !== T_TREES) continue;
        found++;
        expect(solidPartAt(tall, tx, ty, 'land', 0)).toBe(PART_FULL);
        expect(solidPartAt(tall, tx, ty, 'land', 0)).toBe(solidPartAt(flat, tx, ty, 'land', 0));
        expect(isSolidTile(tall, tx, ty, 'land', 0)).toBe(true);
        // A helicopter's worth of height clears the canopy but never the sea.
        expect(solidPartAt(tall, tx, ty, 'land', TREE_Z)).not.toBe(PART_FULL);
        expect(isSolidTile(tall, tx, ty, 'land', TREE_Z)).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('resting on the ground under you', () => {
  it('stepping onto the pavement lifts you a kerb, stepping off drops you back', () => {
    const row = kerbThenWall(tall);
    let s = spawnOnFoot(tall, 7, px(row.x), px(row.y));
    s = step(s, {}, [], tall);
    expect(s.players.byId[1]!.z).toBe(0);
    // Walk east until the footprint is on the kerb.
    for (let i = 0; i < 40; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, right: true } }, [], tall);
    }
    const p = s.players.byId[1]!;
    expect(p.z).toBe(KERB_Z);
    // The wall beyond the kerb still stops them, kerb or no kerb.
    expect(p.pos.x).toBeLessThan((row.x + 2) * TILE_SIZE);
    // And back down.
    for (let i = 40; i < 80; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, left: true } }, [], tall);
    }
    expect(s.players.byId[1]!.z).toBe(0);
  });

  it('is exactly the flat game on a flat map: the pavement is at zero', () => {
    const row = kerbThenWall(flat);
    let s = spawnOnFoot(flat, 7, px(row.x), px(row.y));
    for (let i = 0; i < 40; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, right: true } }, [], flat);
    }
    expect(s.players.byId[1]!.z).toBe(0);
  });

  it('a car mounting the kerb sits a kerb up and still stops at the wall', () => {
    const row = kerbThenWall(tall);
    let s = createGameState(9);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'd' }], tall);
    s = step(
      s,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: px(row.x - 1), y: px(row.y), heading: 0 }],
      tall,
    );
    const p = s.players.byId[1]!;
    p.pos = { x: px(row.x - 1), y: px(row.y) };
    p.mode = 'driving';
    p.vehicleId = 2;
    s.vehicles.byId[2]!.driverId = 1;
    let lifted = false;
    for (let i = 0; i < 90; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, up: true } }, [], tall);
      if (s.players.byId[1]!.z === KERB_Z) lifted = true;
    }
    expect(lifted).toBe(true);
    const v = s.vehicles.byId[2]!;
    expect(v.pos.x + getVehicleTuning('car').halfExtent).toBeLessThanOrEqual((row.x + 2) * TILE_SIZE + 0.01);
  });
});

describe('falling onto what is below', () => {
  it('lands on a roof from above it, and it costs something', () => {
    const b = lowBuildingWithRoadEast(tall);
    const cx = (b.x + b.w / 2) * TILE_SIZE;
    const cy = (b.y + b.h / 2) * TILE_SIZE;
    let s = spawnOnFoot(tall, 11, cx, cy, b.top + 24);
    s.players.byId[1]!.health = 100;
    for (let i = 0; i < 60; i++) s = step(s, {}, [], tall);
    const p = s.players.byId[1]!;
    expect(p.z).toBe(b.top);
    expect(groundUnder(tall, p.pos.x, p.pos.y, PLAYER_RADIUS)).toBe(b.top);
    expect(p.health).toBeLessThan(100);
    expect(p.health).toBeGreaterThan(0);
  });

  it('walking off the roof edge is a fall to the street', () => {
    const b = lowBuildingWithRoadEast(tall);
    const cx = (b.x + b.w - 0.5) * TILE_SIZE;
    const cy = (b.y + b.h / 2) * TILE_SIZE;
    let s = spawnOnFoot(tall, 12, cx, cy, b.top);
    s.players.byId[1]!.health = 100;
    let highest = 0;
    for (let i = 0; i < 90; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, right: true } }, [], tall);
      highest = Math.max(highest, s.players.byId[1]!.z);
    }
    const p = s.players.byId[1]!;
    expect(highest).toBe(b.top);
    // Down on whatever is beside the building — the pavement, a kerb up, or
    // the carriageway — and never still on the roof.
    expect(p.z).toBe(groundUnder(tall, p.pos.x, p.pos.y, PLAYER_RADIUS));
    expect(p.z).toBeLessThanOrEqual(KERB_Z);
    expect(p.pos.x).toBeGreaterThan((b.x + b.w) * TILE_SIZE);
    expect(p.health).toBeLessThan(100);
  });

  it('on a flat map the same drop is a fall to zero, as it always was', () => {
    const b = lowBuildingWithRoadEast(flat);
    // Beside the building, not over it: on a flat map a wall reaches any
    // height, so a body at 48 over a roof is a body inside a wall.
    let s = spawnOnFoot(flat, 11, (b.x + b.w + 1.5) * TILE_SIZE, (b.y + b.h / 2) * TILE_SIZE, 48);
    for (let i = 0; i < 60; i++) s = step(s, {}, [], flat);
    expect(s.players.byId[1]!.z).toBe(0);
  });
});

describe('determinism', () => {
  it('two runs of the same fall agree to the hash', () => {
    const run = (): number => {
      const b = lowBuildingWithRoadEast(tall);
      let s = spawnOnFoot(tall, 13, (b.x + b.w - 0.5) * TILE_SIZE, (b.y + b.h / 2) * TILE_SIZE, b.top);
      for (let i = 0; i < 90; i++) {
        s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, right: true } }, [], tall);
      }
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});

/**
 * A bridge to drive over: a road tile, then at least `len` deck tiles, then
 * road again, along one axis, with the lines either side deck or road for
 * the whole run so a car fits. `dx, dy` is the direction of travel.
 */
function bridgeRun(m: CityMap, len: number): { x: number; y: number; dx: number; dy: number; len: number } {
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
  ] as const) {
    for (let ty = 1; ty < m.heightTiles - 1; ty++) {
      for (let tx = 1; tx < m.widthTiles - 1; tx++) {
        if (tileAt(m, tx - dx, ty - dy) !== T_ROAD || tileAt(m, tx, ty) !== T_BRIDGE) continue;
        let n = 0;
        while (
          tx + n * dx < m.widthTiles &&
          ty + n * dy < m.heightTiles &&
          tileAt(m, tx + n * dx, ty + n * dy) === T_BRIDGE
        ) {
          n++;
        }
        if (n < len || tx + n * dx >= m.widthTiles || ty + n * dy >= m.heightTiles) continue;
        if (tileAt(m, tx + n * dx, ty + n * dy) !== T_ROAD) continue;
        let wide = true;
        for (const side of [-1, 1]) {
          for (let k = -1; k <= n && wide; k++) {
            const t = tileAt(m, tx + k * dx + side * dy, ty + k * dy + side * dx);
            if (t !== T_BRIDGE && t !== T_ROAD) wide = false;
          }
        }
        if (wide) return { x: tx, y: ty, dx, dy, len: n };
      }
    }
  }
  throw new Error('no bridge run of that length');
}

describe('real bridges', () => {
  it('the shipped city has decks that climb from the shore to full height', () => {
    const g = tall.ground!;
    const W = tall.widthTiles;
    let low = 0;
    let high = 0;
    for (let i = 0; i < g.length; i++) {
      if ((tall.tiles[i] as number) !== T_BRIDGE) continue;
      if (g[i] === 10) low++;
      if ((g[i] as number) >= BRIDGE_DECK_Z) high++;
    }
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(0);
    // The road at a landfall is at street level: the deck steps up from it.
    const b = bridgeRun(tall, 8);
    expect(g[(b.y - b.dy) * W + b.x - b.dx]).toBe(0);
    expect(g[b.y * W + b.x]).toBe(10);
  });

  it('a car drives over a bridge: up one side, across, down the other, unharmed', () => {
    const b = bridgeRun(tall, 8);
    const start = { x: px(b.x - 2 * b.dx), y: px(b.y - 2 * b.dy) };
    const heading = Math.atan2(b.dy, b.dx);
    let s = createGameState(21);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'd' }], tall);
    s = step(
      s,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: start.x, y: start.y, heading }],
      tall,
    );
    const p = s.players.byId[1]!;
    p.pos = { ...start };
    p.mode = 'driving';
    p.vehicleId = 2;
    s.vehicles.byId[2]!.driverId = 1;
    const health = s.vehicles.byId[2]!.health;
    const events: SimEvent[] = [];
    let highest = 0;
    let crossed = false;
    for (let i = 0; i < 400 && !crossed; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, up: true } }, [], tall, events);
      const v = s.vehicles.byId[2]!;
      const z = s.players.byId[1]!.z;
      highest = Math.max(highest, z);
      // Always on the deck under it, never in the air above it or in the
      // water below it.
      expect(z).toBe(groundUnder(tall, v.pos.x, v.pos.y, getVehicleTuning('car').halfExtent));
      const along = b.dx ? v.pos.x : v.pos.y;
      const far = (b.dx ? b.x : b.y) + b.len + 1;
      if (along > far * TILE_SIZE) crossed = true;
    }
    expect(crossed).toBe(true);
    expect(highest).toBeGreaterThanOrEqual(BRIDGE_DECK_Z);
    // And on down the road beyond: back on the ground, whatever it is there.
    for (let i = 0; i < 40; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 500 + i, tick: 500 + i, up: true } }, [], tall, events);
    }
    const v = s.vehicles.byId[2]!;
    expect(s.players.byId[1]!.z).toBe(groundUnder(tall, v.pos.x, v.pos.y, getVehicleTuning('car').halfExtent));
    expect(s.players.byId[1]!.z).toBeLessThan(BRIDGE_DECK_Z);
    // Driving down a bridge is not a series of landings.
    expect(events.filter((e) => e.type === 'stuntLaunched' || e.type === 'stuntLanded')).toHaveLength(0);
    expect(s.vehicles.byId[2]!.health).toBe(health);
  });

  it('stepping off a kerb is a step, not a fall', () => {
    const row = kerbThenWall(tall);
    let s = spawnOnFoot(tall, 8, px(row.x + 1), px(row.y), KERB_Z);
    for (let i = 0; i < 40; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, left: true } }, [], tall);
      expect(s.players.byId[1]!.vz).toBe(0);
    }
    expect(s.players.byId[1]!.z).toBe(0);
  });
});
