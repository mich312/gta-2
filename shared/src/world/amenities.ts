import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { HALF_PI, PI } from '../math/trig.js';
import type { Vec2 } from '../math/vec.js';
import type { WorldgenParams } from './params.js';
import {
  T_ROAD,
  T_SIDEWALK,
  TILE_SIZE,
  type Building,
  type CityMap,
  type DistrictType,
  type Shop,
  type ShopKind,
  type VehicleSpawn,
} from './types.js';

const SHOP_DISTRICTS: Record<ShopKind, DistrictType[]> = {
  gun: ['industrial', 'commercial', 'downtown'],
  clothing: ['commercial', 'downtown', 'residential'],
};

function t(map: CityMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return -1;
  return map.tiles[ty * map.widthTiles + tx] as number;
}

/** A doorway tile: the sidewalk tile directly outside a building's edge. */
function findDoorway(map: CityMap, b: Building): { x: number; y: number } | null {
  const sides: Array<[number, number, number, number, number, number]> = [
    // [start x, start y, dx along, dy along, offx outside, offy outside]
    [b.x, b.y - 1, 1, 0, 0, 0], // top
    [b.x, b.y + b.h, 1, 0, 0, 0], // bottom
    [b.x - 1, b.y, 0, 1, 0, 0], // left
    [b.x + b.w, b.y, 0, 1, 0, 0], // right
  ];
  for (const [sx, sy, dx, dy] of sides) {
    const len = dx !== 0 ? b.w : b.h;
    // Prefer the middle of a side.
    const order: number[] = [];
    const mid = Math.floor(len / 2);
    for (let o = 0; o < len; o++) {
      order.push(mid + (o % 2 === 0 ? 1 : -1) * Math.ceil(o / 2));
    }
    for (const o of order) {
      if (o < 0 || o >= len) continue;
      const x = sx + dx * o;
      const y = sy + dy * o;
      if (t(map, x, y) === T_SIDEWALK) return { x, y };
    }
  }
  return null;
}

export function placeShops(map: CityMap, params: WorldgenParams, rng: number): number {
  for (const kind of ['gun', 'clothing'] as const) {
    const quota = params.shopQuota[kind];
    const preferred = SHOP_DISTRICTS[kind];
    // Candidates in preference order, then by index (deterministic).
    const candidates: number[] = [];
    for (const d of preferred) {
      for (let i = 0; i < map.buildings.length; i++) {
        const b = map.buildings[i] as Building;
        if (b.district === d && b.w >= 3 && b.h >= 3) candidates.push(i);
      }
    }
    let placed = 0;
    const used = new Set(map.shops.map((s) => s.buildingIndex));
    while (placed < quota && candidates.length > 0) {
      let pick: number;
      [pick, rng] = nextIntRange(rng, 0, candidates.length);
      const bi = candidates.splice(pick, 1)[0] as number;
      if (used.has(bi)) continue;
      const door = findDoorway(map, map.buildings[bi] as Building);
      if (!door) continue;
      // Keep shops apart so districts share the wealth.
      const tooClose = map.shops.some(
        (s) => Math.abs(s.doorX - door.x) + Math.abs(s.doorY - door.y) < 20,
      );
      if (tooClose) continue;
      map.shops.push({ kind, doorX: door.x, doorY: door.y, buildingIndex: bi });
      used.add(bi);
      placed++;
    }
  }
  return rng;
}

/** Parked-car spawn points along road edges (consumed by phase 3). */
export function placeVehicleSpawns(map: CityMap, params: WorldgenParams, rng: number): number {
  const spawns: VehicleSpawn[] = [];
  let countdown = params.parkedCarSpacing;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_ROAD) continue;
      const sidewalkLeft = t(map, tx - 1, ty) === T_SIDEWALK;
      const sidewalkUp = t(map, tx, ty - 1) === T_SIDEWALK;
      if (!sidewalkLeft && !sidewalkUp) continue;
      countdown--;
      if (countdown > 0) continue;
      let jitter: number;
      [jitter, rng] = nextIntRange(rng, 0, 5);
      countdown = params.parkedCarSpacing + jitter;
      // Heading follows the road direction implied by which side has kerb.
      let flip: number;
      [flip, rng] = nextFloat01(rng);
      const heading = sidewalkLeft
        ? flip < 0.5
          ? HALF_PI
          : -HALF_PI
        : flip < 0.5
          ? 0
          : PI;
      spawns.push({
        x: (tx + 0.5) * TILE_SIZE,
        y: (ty + 0.5) * TILE_SIZE,
        heading,
        kind: 'car',
      });
    }
  }
  map.vehicleSpawns = spawns;
  return rng;
}

/** Every 5th sidewalk tile, row-major: plenty of deterministic ped spots. */
export function placePedSpawns(map: CityMap): void {
  const spawns: Vec2[] = [];
  let n = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_SIDEWALK) continue;
      n++;
      if (n % 5 === 0) spawns.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE });
    }
  }
  map.pedSpawns = spawns;
}

export function placePlayerSpawns(map: CityMap, params: WorldgenParams, rng: number): number {
  // Deterministic candidate list: every 3rd sidewalk tile, row-major.
  const candidates: Vec2[] = [];
  let n = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_SIDEWALK) continue;
      n++;
      if (n % 3 === 0) candidates.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE });
    }
  }
  const spawns: Vec2[] = [];
  let minDist = params.playerSpawnMinDist * TILE_SIZE;
  let attempts = 0;
  while (spawns.length < params.playerSpawnCount && candidates.length > 0) {
    let pick: number;
    [pick, rng] = nextIntRange(rng, 0, candidates.length);
    const c = candidates.splice(pick, 1)[0] as Vec2;
    const ok = spawns.every((s) => {
      const dx = s.x - c.x;
      const dy = s.y - c.y;
      return dx * dx + dy * dy >= minDist * minDist;
    });
    if (ok) spawns.push(c);
    attempts++;
    if (attempts > 500 && spawns.length < params.playerSpawnCount) {
      minDist /= 2; // relax rather than loop forever on tiny maps
      attempts = 0;
    }
  }
  map.playerSpawns = spawns;
  return rng;
}
