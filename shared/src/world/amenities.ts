import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { HALF_PI, PI } from '../math/trig.js';
import type { Vec2 } from '../math/vec.js';
import type { WorldgenParams } from './params.js';
import {
  DISTRICT_TYPES,
  T_BUILDING,
  T_FLOOR,
  T_LOT,
  T_PARK,
  T_RAMP,
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
  type PickupSpawnKind,
} from './types.js';

/**
 * Half a car, in px (`vehicles.json: car.halfExtent`). Worldgen cannot read the
 * tuning file — it is a pure function of (seed, params) and runs before any of
 * it is loaded — so the one number it needs is stated here.
 */
const PARKED_HALF_EXTENT = 9;

/** Street furniture the wire can afford, across the whole city. */
const MAX_PROPS = 400;

const SHOP_DISTRICTS: Record<ShopKind, DistrictType[]> = {
  gun: ['industrial', 'commercial', 'downtown'],
  clothing: ['commercial', 'downtown', 'residential'],
  // A respray garage belongs where the workshops are, and you have to be
  // able to reach it in a car — so industrial and commercial first.
  spray: ['industrial', 'commercial', 'residential'],
  // Clinics are not placed by the shop pass at all — they are registered at
  // the hospital landmarks after those exist. Listed only to satisfy the
  // exhaustive record.
  clinic: [],
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

/**
 * Hollow out a shop: the building keeps a one-tile wall ring and everything
 * inside it becomes walkable floor, with a doorway punched through the wall
 * beside the door tile. Returns null when the geometry does not work — too
 * small to have an inside, or a doorway that would open into a corner rather
 * than into the room.
 *
 * The roof is simply absent over the floor tiles, so the room reads as a
 * cutaway from above: exactly how the genre has always shown an interior, and
 * it needs no second render pass or per-building height.
 */
function carveInterior(
  map: CityMap,
  b: Building,
  door: { x: number; y: number },
  wide: boolean,
): { interior: { x: number; y: number; w: number; h: number }; entryX: number; entryY: number } | null {
  const interior = { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 };
  if (interior.w < 1 || interior.h < 1) return null;

  // Which wall the doorway goes through follows from where the door tile sits,
  // as does which way is "outside" from it.
  let entryX: number;
  let entryY: number;
  let alongX: boolean;
  let outX = 0;
  let outY = 0;
  if (door.y === b.y - 1) {
    entryX = door.x;
    entryY = b.y;
    alongX = true;
    outY = -1;
  } else if (door.y === b.y + b.h) {
    entryX = door.x;
    entryY = b.y + b.h - 1;
    alongX = true;
    outY = 1;
  } else if (door.x === b.x - 1) {
    entryX = b.x;
    entryY = door.y;
    alongX = false;
    outX = -1;
  } else if (door.x === b.x + b.w) {
    entryX = b.x + b.w - 1;
    entryY = door.y;
    alongX = false;
    outX = 1;
  } else {
    return null;
  }
  // The doorway has to open onto the room, not into the corner of the ring.
  if (alongX && (entryX < interior.x || entryX >= interior.x + interior.w)) return null;
  if (!alongX && (entryY < interior.y || entryY >= interior.y + interior.h)) return null;

  const set = (tx: number, ty: number): void => {
    map.tiles[ty * map.widthTiles + tx] = T_FLOOR;
  };
  for (let ty = interior.y; ty < interior.y + interior.h; ty++) {
    for (let tx = interior.x; tx < interior.x + interior.w; tx++) set(tx, ty);
  }
  set(entryX, entryY);

  // A garage door is two tiles wide, because a car is wider than one tile and
  // a respray you cannot drive into is not a respray.
  if (wide) {
    const nx = alongX ? entryX + 1 : entryX;
    const ny = alongX ? entryY : entryY + 1;
    const inRoom = alongX ? nx < interior.x + interior.w : ny < interior.y + interior.h;
    // ...and only where the approach to that half is open ground rather than
    // the next building along.
    const outside = t(map, nx + outX, ny + outY);
    if (inRoom && outside !== T_BUILDING && outside !== T_WATER && outside !== -1) set(nx, ny);
  }
  return { interior, entryX, entryY };
}

export function placeShops(map: CityMap, params: WorldgenParams, rng: number): number {
  for (const kind of ['gun', 'clothing', 'spray'] as const) {
    const quota = params.shopQuota[kind];
    const preferred = SHOP_DISTRICTS[kind];
    // Candidates in preference order, then by index (deterministic). Roomy
    // buildings first — a shop is a place you walk into now, and a 3x3
    // footprint leaves a single tile of floor behind the counter. The small
    // ones stay eligible so the quota is still met on a cramped map.
    const candidates: number[] = [];
    for (const minSize of [5, 3]) {
      for (const d of preferred) {
        for (let i = 0; i < map.buildings.length; i++) {
          const b = map.buildings[i] as Building;
          const size = Math.min(b.w, b.h);
          if (b.district !== d || size < minSize) continue;
          if (minSize === 3 && size >= 5) continue; // already in the first pass
          candidates.push(i);
        }
      }
    }
    let placed = 0;
    const used = new Set(map.shops.map((s) => s.buildingIndex));
    // Pick from the roomy prefix while there is one, so the random draw cannot
    // reach past it into the cramped tail while good sites remain.
    let head = candidates.length;
    for (let i = 0; i < candidates.length; i++) {
      const b = map.buildings[candidates[i] as number] as Building;
      if (Math.min(b.w, b.h) < 5) {
        head = i;
        break;
      }
    }
    while (placed < quota && candidates.length > 0) {
      let pick: number;
      [pick, rng] = nextIntRange(rng, 0, head > 0 ? head : candidates.length);
      const bi = candidates.splice(pick, 1)[0] as number;
      if (head > 0) head--;
      if (used.has(bi)) continue;
      const building = map.buildings[bi] as Building;
      const door = findDoorway(map, building);
      if (!door) continue;
      // Keep shops apart so districts share the wealth.
      const tooClose = map.shops.some(
        (s) => Math.abs(s.doorX - door.x) + Math.abs(s.doorY - door.y) < 20,
      );
      if (tooClose) continue;
      const room = carveInterior(map, building, door, kind === 'spray');
      if (!room) continue;
      map.shops.push({
        kind,
        doorX: door.x,
        doorY: door.y,
        buildingIndex: bi,
        interior: room.interior,
        entryX: room.entryX,
        entryY: room.entryY,
      });
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

/**
 * Where cars are left parked, as opposed to where they are spawned from.
 *
 * These used to be the same list, and a parked car sat in the middle of the
 * carriageway. A car's collision box is 18 px and a tile is 16, so on a
 * two-tile street — every secondary road in the city — a parked car left 14 px
 * of gap and blocked the street outright: ambient traffic queued behind it
 * until its own stuck-recovery backed it out.
 *
 * So: park flush against the kerb where the road is wide enough to pass, and
 * half up on the pavement where it is not, which is what people do on a
 * narrow street anyway. Heading follows the traffic that side of the road
 * carries, so a parked car points the way its lane goes rather than at random.
 *
 * Derived from the tile grid with no rng of its own, deliberately: the spawn
 * list it filters is what cops, roadblocks and ambient traffic are drawn from,
 * and those must not move because parking changed.
 */
export function placeParking(map: CityMap): void {
  const spots: VehicleSpawn[] = [];
  const half = PARKED_HALF_EXTENT;
  for (const s of map.vehicleSpawns) {
    const tx = Math.floor(s.x / TILE_SIZE);
    const ty = Math.floor(s.y / TILE_SIZE);
    const kerbWest = t(map, tx - 1, ty) === T_SIDEWALK;
    const kerbNorth = t(map, tx, ty - 1) === T_SIDEWALK;
    if (!kerbWest && !kerbNorth) continue;

    // How much carriageway there is, counting away from the kerb.
    let width = 1;
    for (let i = 1; i <= 5; i++) {
      const tile = kerbWest ? t(map, tx + i, ty) : t(map, tx, ty + i);
      if (tile !== T_ROAD) break;
      width++;
    }
    const kerbEdge = (kerbWest ? tx : ty) * TILE_SIZE;
    // Wide enough to be passed: sit in the road with the wheels on the kerb.
    // Otherwise put half the car up on the pavement so the street stays open.
    // Wide enough to be passed: sit in the road with the wheels against the
    // kerb. Otherwise put the car half up on the pavement, which is what
    // people do on a street too narrow to do anything else — and leaves the
    // carriageway usable rather than plugged.
    const offset = width >= 3 ? half : 0;
    spots.push({
      x: kerbWest ? kerbEdge + offset : s.x,
      y: kerbWest ? s.y : kerbEdge + offset,
      // Right-hand traffic: the west half of a road carries southbound
      // traffic, the north half carries westbound.
      heading: kerbWest ? HALF_PI : PI,
      // Parked stock varies too, on a fixed cycle rather than an rng draw:
      // worldgen must not consume randomness it did not consume before, or
      // every seed's city changes shape.
      kind: PARKED_CYCLE[spots.length % PARKED_CYCLE.length] as string,
    });
  }
  map.parkingSpots = spots;
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
/** How many explosive barrels a city gets, whatever else it is full of. */
const BARREL_BUDGET = 60;

export function placeProps(map: CityMap): void {
  const props: CityMap['propSpawns'] = [];
  const barrels: CityMap['propSpawns'] = [];
  let lampN = 0;
  let binN = 0;
  let fenceN = 0;
  let barrelN = 0;
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
        // Barrels stand against industrial walls, and only there. Scattered
        // evenly across the city they are a random tax on driving; clustered
        // where the work is, they are a weapon you can plan around — which is
        // the difference between scenery that explodes and a hazard.
        //
        // Collected apart from the furniture because of what happens below:
        // the furniture list is decimated to a cap, and a decimation does not
        // care that one kind is gameplay and the rest is decoration. First
        // attempt put two barrels in the whole city on one seed and none at
        // all on another.
        if (district === 'industrial' && ++barrelN % 3 === 0) {
          barrels.push({
            kind: 'barrel',
            x: (tx + 0.5) * TILE_SIZE,
            y: (ty + 0.5) * TILE_SIZE,
            orient: 0,
          });
          continue;
        }
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
  // Sampled across the whole list, not the first 400 of a row-major sweep:
  // that put every lamp post, bin and fence in the city into its top few
  // blocks and left the other 80% of the map with no street furniture and no
  // street lighting at all.
  const furnitureCap = MAX_PROPS - BARREL_BUDGET;
  const stride = Math.max(1, Math.floor(props.length / furnitureCap));
  const kept = props.filter((_, i) => i % stride === 0).slice(0, furnitureCap);
  // Barrels get their own reserved slice, strided the same way so they are
  // spread across the industrial districts rather than piled in the first.
  const bStride = Math.max(1, Math.floor(barrels.length / BARREL_BUDGET));
  map.propSpawns = kept.concat(
    barrels.filter((_, i) => i % bStride === 0).slice(0, BARREL_BUDGET),
  );
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

/**
 * Staples common, powers rare. The cycle length is coprime-ish with nothing
 * in particular — it just has to be long enough that a power-up is a find
 * rather than street furniture. Two thirds of the map is still health, ammo
 * and armour.
 */
/**
 * Kerbside stock. Mostly cars, with the odd van or truck — a street of
 * identical hatchbacks is the tell that a city was generated.
 */
const PARKED_CYCLE = ['car', 'car', 'car', 'van', 'car', 'taxi', 'car', 'truck', 'car', 'car'] as const;

const PICKUP_CYCLE = [
  'health',
  'armour',
  'ammo',
  'health',
  'ammo',
  'bribe',
  'health',
  'damage',
  'ammo',
  'armour',
  'invis',
  'health',
  'ammo',
  'reload',
  'armour',
  'health',
  'jailcard',
  'ammo',
] as const;

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
        kind: PICKUP_CYCLE[spawns.length % PICKUP_CYCLE.length] as PickupSpawnKind,
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
  police: ['1st Precinct', 'Kelvin Road Station', 'Harbour Precinct', 'Central Station'],
};

/** Minimum footprint that reads as "big" for each kind, in tiles. */
const LANDMARK_SIZE: Record<LandmarkKind, [number, number]> = {
  stadium: [11, 9],
  power: [9, 8],
  tower: [6, 6],
  hospital: [6, 5],
  police: [5, 5],
};

const LANDMARK_DISTRICTS: Record<LandmarkKind, DistrictType[]> = {
  stadium: ['park', 'residential', 'commercial'],
  power: ['industrial'],
  tower: ['downtown', 'commercial'],
  hospital: ['commercial', 'residential', 'downtown'],
  police: ['downtown', 'commercial', 'residential'],
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
    ['police', 3],
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
  map.policeStations = map.landmarks
    .filter((l) => l.kind === 'police')
    .map((l) => ({ x: l.doorX, y: l.doorY }));

  return rng;
}


/**
 * Stunt ramps, dropped on industrial lots where there is room to build up
 * speed. Replaces the jump the genre never had with the thing it did have.
 */
/**
 * Car crushers: open-air crane sites on industrial lots, reachable by road.
 *
 * Deliberately NOT a carved building like the shops — you drive a car in and
 * leave on foot, so the site has to be somewhere a car can get to and stop.
 * Placed by a deterministic scan with no rng draw at all, so adding them
 * shifts nobody else's worldgen.
 */
/**
 * Register each hospital's door as a clinic counter.
 *
 * Runs AFTER placeShops, and that ordering is load-bearing: adding entries to
 * map.shops beforehand made them count towards the "keep shops apart" rule,
 * which moved which buildings became shops, which moved the carved interior
 * floor tiles, which moved player spawns. A test that punches somebody to
 * death stopped connecting. Worldgen passes must not quietly feed each other.
 */
export function registerClinics(map: CityMap): void {
  for (const l of map.landmarks) {
    if (l.kind !== 'hospital') continue;
    map.shops.push({
      kind: 'clinic',
      doorX: Math.floor(l.doorX / TILE_SIZE),
      doorY: Math.floor(l.doorY / TILE_SIZE),
      buildingIndex: -1,
      // A clinic has no room you can walk into: the ward is solid, and the
      // doorway IS the counter. An empty rect says exactly that, and keeps
      // the invariant that every shop interior is walkable floor true — a
      // hospital footprint here claimed solid tiles were floor.
      interior: { x: Math.floor(l.doorX / TILE_SIZE), y: Math.floor(l.doorY / TILE_SIZE), w: 0, h: 0 },
      entryX: Math.floor(l.doorX / TILE_SIZE),
      entryY: Math.floor(l.doorY / TILE_SIZE),
    });
  }
}

export function placeCranes(map: CityMap): void {
  const sites: Vec2[] = [];
  let n = 0;
  for (let ty = 2; ty < map.heightTiles - 2; ty++) {
    for (let tx = 2; tx < map.widthTiles - 2; tx++) {
      if (t(map, tx, ty) !== T_LOT) continue;
      // Room for the jaws, and a road within reach so it is drivable-to.
      let open = true;
      for (let oy = -1; oy <= 1 && open; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (t(map, tx + ox, ty + oy) !== T_LOT) {
            open = false;
            break;
          }
        }
      }
      if (!open) continue;
      let nearRoad = false;
      for (let d = 2; d <= 5 && !nearRoad; d++) {
        for (const [ox, oy] of [
          [d, 0],
          [-d, 0],
          [0, d],
          [0, -d],
        ] as const) {
          if (t(map, tx + ox, ty + oy) === T_ROAD) {
            nearRoad = true;
            break;
          }
        }
      }
      if (!nearRoad) continue;
      n++;
      // Sparse: a crusher on every lot would make theft trivially profitable.
      if (n % 40 !== 0) continue;
      const tooClose = sites.some(
        (c) => Math.abs(c.x - (tx + 0.5) * TILE_SIZE) + Math.abs(c.y - (ty + 0.5) * TILE_SIZE) < 600,
      );
      if (tooClose) continue;
      sites.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE });
    }
  }
  map.cranes = sites;
}

/**
 * Payphones: on the pavement, at junctions, spread across the city.
 *
 * The genre's mission-giver is a ringing phone rather than a marker you drive
 * into — the city calls you and you choose whether to pick up. Placed by a
 * deterministic scan with no rng draw, like the cranes.
 */
export function placePayphones(map: CityMap): void {
  const spots: Vec2[] = [];
  let n = 0;
  for (let ty = 2; ty < map.heightTiles - 2; ty++) {
    for (let tx = 2; tx < map.widthTiles - 2; tx++) {
      if (t(map, tx, ty) !== T_SIDEWALK) continue;
      // A corner: pavement with road on two adjacent sides. That is where a
      // phone box goes, and it is somewhere you can stop a car near.
      const roadE = t(map, tx + 1, ty) === T_ROAD;
      const roadW = t(map, tx - 1, ty) === T_ROAD;
      const roadS = t(map, tx, ty + 1) === T_ROAD;
      const roadN = t(map, tx, ty - 1) === T_ROAD;
      if (!((roadE || roadW) && (roadS || roadN))) continue;
      n++;
      if (n % 7 !== 0) continue;
      const x = (tx + 0.5) * TILE_SIZE;
      const y = (ty + 0.5) * TILE_SIZE;
      if (spots.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < 420)) continue;
      spots.push({ x, y });
    }
  }
  map.payphones = spots;
}

export function placeRamps(map: CityMap): void {
  let n = 0;
  for (let ty = 2; ty < map.heightTiles - 2; ty++) {
    for (let tx = 2; tx < map.widthTiles - 2; tx++) {
      if (t(map, tx, ty) !== T_LOT) continue;
      // Needs a clear run-up along one axis.
      const runX = t(map, tx - 2, ty) === T_LOT && t(map, tx - 1, ty) === T_LOT;
      const runY = t(map, tx, ty - 2) === T_LOT && t(map, tx, ty - 1) === T_LOT;
      if (!runX && !runY) continue;
      n++;
      if (n % 90 !== 0) continue;
      map.tiles[ty * map.widthTiles + tx] = T_RAMP;
    }
  }
}
