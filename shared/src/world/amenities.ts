import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { HALF_PI, PI } from '../math/trig.js';
import type { Vec2 } from '../math/vec.js';
import { isIntersectionTile, roadSpanAt } from './roads.js';
import type { WorldgenParams } from './params.js';
import {
  T_BUILDING,
  T_PARK,
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
      // No kerb parking on arterials — those lanes belong to ambient traffic.
      // (Checked after the rng draws so the worldgen stream is unchanged.)
      if (roadSpanAt(map, tx, ty, sidewalkLeft).width >= 3) continue;
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

/** Tiles between traffic spawn points along an arterial corridor. */
const TRAFFIC_SPAWN_SPACING = 11;

/**
 * Ambient-traffic spawn points: lane-centred positions on arterial roads
 * (crossing width ≥ 3 tiles), right-hand lanes at 1/3 and 2/3 of the road
 * width, alternating direction so both lanes get used. Deterministic scan,
 * no rng — the list must be identical on every host.
 */
export function placeTrafficSpawns(map: CityMap): void {
  const spawns: VehicleSpawn[] = [];
  let alongH = 0;
  let alongV = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_ROAD) continue;
      if (isIntersectionTile(map, tx, ty)) continue;
      const h = roadSpanAt(map, tx, ty, true);
      const v = roadSpanAt(map, tx, ty, false);
      // Horizontal arterial corridor: long along x, true width 3..6 across y.
      if (h.width > 6 && v.width >= 3 && v.width <= 6 && v.before === 0) {
        alongH++;
        if (alongH % TRAFFIC_SPAWN_SPACING !== 0) continue;
        const y0 = (ty - v.before) * TILE_SIZE;
        const w = v.width * TILE_SIZE;
        const east = (alongH / TRAFFIC_SPAWN_SPACING) % 2 === 0;
        // Right-hand traffic: eastbound rides the south lane.
        spawns.push({
          x: (tx + 0.5) * TILE_SIZE,
          y: y0 + (east ? (w * 2) / 3 : w / 3),
          heading: east ? 0 : PI,
          kind: 'car',
        });
      } else if (v.width > 6 && h.width >= 3 && h.width <= 6 && h.before === 0) {
        alongV++;
        if (alongV % TRAFFIC_SPAWN_SPACING !== 0) continue;
        const x0 = (tx - h.before) * TILE_SIZE;
        const w = h.width * TILE_SIZE;
        const south = (alongV / TRAFFIC_SPAWN_SPACING) % 2 === 0;
        // Southbound rides the west lane.
        spawns.push({
          x: x0 + (south ? w / 3 : (w * 2) / 3),
          y: (ty + 0.5) * TILE_SIZE,
          heading: south ? HALF_PI : -HALF_PI,
          kind: 'car',
        });
      }
    }
  }
  map.trafficSpawns = spawns;
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

/**
 * Street furniture (phase 8): lamps on kerbside sidewalk tiles, bins against
 * building walls, fences along park edges. Deterministic row-major sampling.
 */
export function placeProps(map: CityMap): void {
  const props: CityMap['propSpawns'] = [];
  let lampN = 0;
  let binN = 0;
  let fenceN = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_SIDEWALK) continue;
      const roadRight = t(map, tx + 1, ty) === T_ROAD;
      const roadDown = t(map, tx, ty + 1) === T_ROAD;
      const bldLeft = t(map, tx - 1, ty) === T_BUILDING;
      const bldUp = t(map, tx, ty - 1) === T_BUILDING;
      const parkLeft = t(map, tx - 1, ty) === T_PARK;
      const parkUp = t(map, tx, ty - 1) === T_PARK;
      if (roadRight || roadDown) {
        lampN++;
        if (lampN % 9 === 0) {
          props.push({ kind: 'lamp', x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE, orient: 0 });
          continue;
        }
      }
      if (bldLeft || bldUp) {
        binN++;
        if (binN % 13 === 0) {
          props.push({ kind: 'bin', x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE, orient: 0 });
          continue;
        }
      }
      if (parkLeft || parkUp) {
        fenceN++;
        if (fenceN % 2 === 0) {
          props.push({
            kind: 'fence',
            x: (tx + 0.5) * TILE_SIZE,
            y: (ty + 0.5) * TILE_SIZE,
            orient: parkLeft ? 1 : 0,
          });
        }
      }
    }
  }
  map.propSpawns = props.slice(0, 400);
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
