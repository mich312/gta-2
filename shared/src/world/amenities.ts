import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { HALF_PI, PI } from '../math/trig.js';
import type { Vec2 } from '../math/vec.js';
import type { WorldgenParams } from './params.js';
import {
  DISTRICT_TYPES,
  T_BUILDING,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_WATER,
  T_SIDEWALK,
  TILE_SIZE,
  type BlockRect,
  type Building,
  type CityMap,
  type DistrictType,
  type Landmark,
  type LandmarkKind,
  type Shop,
  type ShopKind,
  type VehicleSpawn,
} from './types.js';

const SHOP_DISTRICTS: Record<ShopKind, DistrictType[]> = {
  gun: ['industrial', 'commercial', 'downtown'],
  clothing: ['commercial', 'downtown', 'residential'],
  // A respray garage belongs where the workshops are, and you have to be
  // able to reach it in a car — so industrial and commercial first.
  spray: ['industrial', 'commercial', 'residential'],
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
  for (const kind of ['gun', 'clothing', 'spray'] as const) {
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
      // Lamp spacing varies by district: downtown is brightly lit, industrial
      // sparsely. Districts differed only by building colour before this.
      const district = DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number];
      const lampEvery =
        district === 'downtown' ? 6 : district === 'commercial' ? 8 : district === 'industrial' ? 14 : 10;
      if (roadRight || roadDown) {
        lampN++;
        if (lampN % lampEvery === 0) {
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

const PICKUP_CYCLE = ['health', 'armour', 'ammo', 'health', 'ammo'] as const;

/**
 * Health/armour/ammo crates. Placed on open ground away from the road —
 * parks and industrial lots — so collecting one is a small detour rather
 * than something you drive over by accident. Deterministic row-major
 * sampling with a fixed kind cycle, exactly like the prop pass.
 */
export function placePickups(map: CityMap): void {
  const spawns: CityMap['pickupSpawns'] = [];
  const spacing = 34;
  let n = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      const tile = t(map, tx, ty);
      if (tile !== T_PARK && tile !== T_LOT) continue;
      // Interior tiles only: a crate flush against a wall is a pain to reach.
      if (t(map, tx - 1, ty) === T_BUILDING || t(map, tx + 1, ty) === T_BUILDING) continue;
      if (t(map, tx, ty - 1) === T_BUILDING || t(map, tx, ty + 1) === T_BUILDING) continue;
      n++;
      if (n % spacing !== 0) continue;
      spawns.push({
        kind: PICKUP_CYCLE[spawns.length % PICKUP_CYCLE.length] as 'health' | 'armour' | 'ammo',
        x: (tx + 0.5) * TILE_SIZE,
        y: (ty + 0.5) * TILE_SIZE,
      });
    }
  }
  map.pickupSpawns = spawns;
}


/**
 * Moorings: water tiles with a bank close by, so a boat is reachable on
 * foot rather than stranded mid-river. Deterministic row-major sampling.
 */
export function placeBoatSpawns(map: CityMap): void {
  const spawns: VehicleSpawn[] = [];
  let n = 0;
  for (let ty = 1; ty < map.heightTiles - 1; ty++) {
    for (let tx = 1; tx < map.widthTiles - 1; tx++) {
      if (t(map, tx, ty) !== T_WATER) continue;
      // The whole 3x3 must be open water: a boat is 22 px across, so a
      // mooring pressed against the bank leaves the hull overlapping land
      // and the boat cannot move at all.
      let roomy = true;
      for (let dy = -1; dy <= 1 && roomy; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (t(map, tx + dx, ty + dy) !== T_WATER) {
            roomy = false;
            break;
          }
        }
      }
      if (!roomy) continue;
      // ...and dry land within reach, or nobody can get aboard.
      let bank = false;
      for (let dy = -3; dy <= 3 && !bank; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const near = t(map, tx + dx, ty + dy);
          if (near === T_SIDEWALK || near === T_ROAD || near === T_PARK || near === T_LOT) {
            bank = true;
            break;
          }
        }
      }
      if (!bank) continue;
      n++;
      if (n % 24 !== 0) continue;
      // Point along the river: whichever axis has more open water.
      const alongX = t(map, tx - 1, ty) === T_WATER && t(map, tx + 1, ty) === T_WATER;
      spawns.push({
        x: (tx + 0.5) * TILE_SIZE,
        y: (ty + 0.5) * TILE_SIZE,
        heading: alongX ? 0 : HALF_PI,
        kind: 'boat',
      });
    }
  }
  map.boatSpawns = spawns;
}

const LANDMARK_NAMES: Record<LandmarkKind, string[]> = {
  stadium: ['Ironside Stadium', 'The Bowl', 'Harbour Park'],
  power: ['Kessler Power', 'Eastworks Plant', 'Grid Station'],
  tower: ['Vantage Tower', 'The Spire', 'Halloran Building'],
  hospital: ['Mercy General', 'St. Brannoch', 'Riverside Infirmary', 'Central Clinic'],
};

/** Minimum footprint that reads as "big" for each kind, in tiles. */
const LANDMARK_SIZE: Record<LandmarkKind, [number, number]> = {
  stadium: [11, 9],
  power: [9, 8],
  tower: [6, 6],
  hospital: [6, 5],
};

const LANDMARK_DISTRICTS: Record<LandmarkKind, DistrictType[]> = {
  stadium: ['park', 'residential', 'commercial'],
  power: ['industrial'],
  tower: ['downtown', 'commercial'],
  hospital: ['commercial', 'residential', 'downtown'],
};

/**
 * Landmarks: a handful of oversized, distinctly-shaped, NAMED structures.
 *
 * Every building on this map was an anonymous coloured rectangle, so there
 * was nothing to navigate by and nothing to arrange to meet at. Hospitals are
 * landmarks too, because respawning somewhere you can recognise is the
 * difference between a setback and a teleport.
 */
export function placeLandmarks(map: CityMap, rng: number): number {
  const wanted: Array<[LandmarkKind, number]> = [
    ['hospital', 4],
    ['tower', 2],
    ['stadium', 1],
    ['power', 1],
  ];
  const taken: Landmark[] = [];

  for (const [kind, count] of wanted) {
    const [minW, minH] = LANDMARK_SIZE[kind];
    // Candidate blocks: big enough, right district, far from the others.
    const candidates: number[] = [];
    for (const district of LANDMARK_DISTRICTS[kind]) {
      for (let i = 0; i < map.blocks.length; i++) {
        const b = map.blocks[i] as BlockRect;
        if (b.district !== district) continue;
        if (b.w < minW + 2 || b.h < minH + 2) continue;
        candidates.push(i);
      }
    }
    let placed = 0;
    let guard = candidates.length;
    while (placed < count && candidates.length > 0 && guard-- > 0) {
      let pick: number;
      [pick, rng] = nextIntRange(rng, 0, candidates.length);
      const b = map.blocks[candidates.splice(pick, 1)[0] as number] as BlockRect;

      const x = b.x + 1;
      const y = b.y + 1;
      const w = Math.min(minW, b.w - 2);
      const h = Math.min(minH, b.h - 2);
      if (w < 3 || h < 3) continue;
      // Never on the river, and never on top of another landmark.
      let clear = true;
      for (let ty = y; ty < y + h && clear; ty++) {
        for (let tx = x; tx < x + w; tx++) {
          if (t(map, tx, ty) === T_WATER) {
            clear = false;
            break;
          }
        }
      }
      if (!clear) continue;
      const tooClose = taken.some(
        (l) => Math.abs(l.x - x) + Math.abs(l.y - y) < 40,
      );
      if (tooClose) continue;

      // Stamp it as one solid structure and register it as a building so the
      // renderer and collision treat it like any other.
      for (let ty = y; ty < y + h; ty++) {
        for (let tx = x; tx < x + w; tx++) {
          map.tiles[ty * map.widthTiles + tx] = T_BUILDING;
        }
      }
      map.buildings.push({ x, y, w, h, district: b.district });

      const names = LANDMARK_NAMES[kind];
      const name = names[(placed + taken.length) % names.length] as string;
      const door = findDoorway(map, { x, y, w, h, district: b.district });
      const landmark: Landmark = {
        kind,
        name,
        x,
        y,
        w,
        h,
        doorX: door ? (door.x + 0.5) * TILE_SIZE : (x + w / 2) * TILE_SIZE,
        doorY: door ? (door.y + 0.5) * TILE_SIZE : (y + h + 1) * TILE_SIZE,
      };
      taken.push(landmark);
      map.landmarks.push(landmark);
      placed++;
    }
  }

  map.hospitals = map.landmarks
    .filter((l) => l.kind === 'hospital')
    .map((l) => ({ x: l.doorX, y: l.doorY }));
  return rng;
}
