import { deriveSeed, nextFloat01, nextIntRange, seedRng } from '../rng/prng.js';
import { HALF_PI, PI, dCos, dSin } from '../math/trig.js';
import type { Vec2 } from '../math/vec.js';
import { latticeHash } from './fields.js';
import type { WorldgenParams } from './params.js';
import {
  districtAt,
  DISTRICT_TYPES,
  T_BANK,
  T_SAND,
  T_BUILDING,
  T_FIELD,
  T_FLOOR,
  T_LOT,
  T_PARK,
  T_RAMP,
  T_ROAD,
  T_BRIDGE,
  T_RUNWAY,
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

/**
 * Body colours per painted vehicle kind. Mirrors the `body` variant axis in
 * shared/data/sprites.json, which worldgen cannot read for the same reason it
 * cannot read the tuning: it is a pure function of (seed, params) and runs
 * before either file is loaded. The client's `CAR_VARIANTS` is the other end
 * of this number, and the sprite test is what keeps the two honest.
 */
export const PAINT_VARIANTS = 10;

/**
 * A stable 32-bit draw for one place, off an already-derived stream seed.
 *
 * The point of it is what it does NOT depend on: the window. Callers pass
 * GLOBAL tile coordinates, so the answer is a property of a place in the
 * unbounded world — which is exactly the guarantee every other pure worldgen
 * pass already gives (see generate.ts). Separate streams are what keep the
 * questions asked of one kerb uncorrelated: if the model and the colour came
 * off the same draw, every red car in the city would be a taxi.
 */
function placeHash(streamSeed: number, a: number, b: number): number {
  return Math.floor(latticeHash(streamSeed, a, b) * 0x1000000);
}

/**
 * The nominal city these budgets were tuned against, in tiles. Everything
 * below scales with the map's area against it.
 *
 * Written as a rate rather than a count because the map grew four-fold and
 * every one of these was a constant: the same two hundred pedestrians, the
 * same four hundred props and the same forty-eight parked cars spread over
 * four times the ground is not a bigger city, it is an emptier one.
 */
const NOMINAL_TILES = 384 * 384;

/** Scale a budget tuned for the nominal city to this map's area. */
export function areaScale(map: { widthTiles: number; heightTiles: number }): number {
  return (map.widthTiles * map.heightTiles) / NOMINAL_TILES;
}

/** Street furniture the wire can afford, per nominal city. */
const PROPS_PER_CITY = 400;
/** Moorings and crates: both are spawned in full, so both are capped. */
const BOATS_PER_CITY = 230;
const PICKUPS_PER_CITY = 305;

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
  // Neither of these picks its building from a district preference: a
  // clinic reuses a hospital door, and the proving ground takes whatever is
  // nearest to where players appear.
  depot: [],
};

/**
 * The least a pass needs to read the ground: the finished map satisfies it,
 * and so does the half-built city the baker is still assembling.
 */
export interface TileGrid {
  widthTiles: number;
  heightTiles: number;
  tiles: Uint8Array;
}

function t(map: TileGrid, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return -1;
  return map.tiles[ty * map.widthTiles + tx] as number;
}

/** A doorway tile: the sidewalk tile directly outside a building's edge. */
export function findDoorway(map: TileGrid, b: Building): { x: number; y: number } | null {
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
  map: TileGrid,
  b: Building,
  door: { x: number; y: number },
  wide: boolean,
): {
  interior: { x: number; y: number; w: number; h: number };
  entryX: number;
  entryY: number;
  /** True when a requested two-tile garage door actually opened. */
  gotWide: boolean;
} | null {
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
  let gotWide = false;
  if (wide) {
    const nx = alongX ? entryX + 1 : entryX;
    const ny = alongX ? entryY : entryY + 1;
    const inRoom = alongX ? nx < interior.x + interior.w : ny < interior.y + interior.h;
    // ...and only where the approach to that half is open ground rather than
    // the next building along.
    const outside = t(map, nx + outX, ny + outY);
    if (inRoom && outside !== T_BUILDING && outside !== T_WATER && outside !== -1) {
      set(nx, ny);
      gotWide = true;
    }
  }
  return { interior, entryX, entryY, gotWide };
}

/** Undo carveInterior: the whole footprint goes back to being solid wall. */
function fillSolid(map: TileGrid, b: Building): void {
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      map.tiles[ty * map.widthTiles + tx] = T_BUILDING;
    }
  }
}

/**
 * Shopfronts, chosen from the baked city's own building list.
 *
 * The old pass hung shops off the arterial lattice — every Mth cell got a gun
 * shop — because in an unbounded world "how many are there" is a question
 * about density rather than about count. The city has edges now, so it is a
 * count again: a fixed quota per kind, spread across the map by refusing to
 * put two within `spacing` tiles of each other, and no random draw anywhere
 * in it. The same buildings become shops every time because they are the same
 * buildings.
 *
 * `landmarkBuilt` is the bake's own WeakSet of the masses a LANDMARK stamped
 * (`bake.ts`, "The buildings a LANDMARK stamped, by identity"), and it is a
 * required argument rather than an optional one so that no future caller can
 * forget to answer the question. Those records live in the same
 * `city.buildings` array as the houses and carry an inherited district, so
 * without it this pass could not tell a terrace from a hospital: it picked
 * eight of them and `carveInterior` hollowed each one out into a wall ring, a
 * `T_FLOOR` room and a two-tile garage door. That put a respray inside The
 * Spire and the Halloran Building, a respray inside three infirmaries whose
 * ward the clinic code states is solid, and a respray inside Kelvin Road
 * Station, Sunridge Station and Marsh Post — where the drive-through buy
 * clears the player's wanted level from the road tile outside the police
 * station's own front door. Skipping them costs nothing: the quota fills
 * identically from ordinary houses (66 shops, gun 20 / clothing 20 /
 * spray 26, before and after).
 */
export function placeShopsFixed(
  city: { widthTiles: number; heightTiles: number; tiles: Uint8Array; buildings: Building[]; shops: Shop[] },
  quota: { gun: number; clothing: number; spray: number },
  spacing: number,
  landmarkBuilt: WeakSet<Building>,
): Shop[] {
  const shops: Shop[] = [];
  const used = new Set<number>();

  const far = (b: Building, minDist: number): boolean =>
    shops.every((s) => Math.abs(s.doorX - b.x) + Math.abs(s.doorY - b.y) >= minDist);

  for (const kind of ['gun', 'clothing', 'spray'] as const) {
    let placed = 0;
    // Roomy candidates first: a 3x3 footprint leaves a single tile of floor
    // behind the counter, so the small ones are the fallback, not the norm.
    // Then the spacing is relaxed rather than the quota missed.
    for (const minDist of [spacing, Math.floor(spacing / 2), 0]) {
      for (const minSize of [5, 3]) {
        for (const district of SHOP_DISTRICTS[kind]) {
          for (const [bi, b] of city.buildings.entries()) {
            if (placed >= quota[kind]) break;
            if (used.has(bi) || b.district !== district) continue;
            // A landmark's own mass is not a shopfront. It is the one thing
            // in this array the plan asked to stay solid.
            if (landmarkBuilt.has(b)) continue;
            if (Math.min(b.w, b.h) < minSize) continue;
            if (!far(b, minDist)) continue;
            const door = findDoorway(city, b);
            if (!door) continue;
            const room = carveInterior(city, b, door, kind === 'spray');
            if (!room) continue;
            // A respray you cannot drive into is not a respray: if the wide
            // door failed to open on this building, wall it back up and try
            // the next candidate rather than shipping a garage for pedestrians.
            if (kind === 'spray' && !room.gotWide) {
              fillSolid(city, b);
              continue;
            }
            shops.push({
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
      }
      if (placed >= quota[kind]) break;
    }
  }
  return shops;
}

/**
 * Is this road tile part of a straight carriageway running along `alongY`?
 *
 * Kerbside parking assumes the kerb says which way the street runs: sidewalk
 * to the west means a north-south street, sidewalk to the north an east-west
 * one. On the grid that inference is sound. On the city's curved arterials it
 * is not: a diagonal band rasterises to stair steps, every step has kerb on
 * its west AND its north, and a car parked by either guess sits at right
 * angles to the traffic in the middle of the carriageway. So the inference is
 * checked rather than trusted — the street must actually run a few tiles in
 * the claimed direction and stay narrow across it, which every straight
 * street passes and every stair step fails.
 */
function axisCarriageway(map: CityMap, tx: number, ty: number, alongY: boolean): boolean {
  const road = (x: number, y: number): boolean => {
    const tile = t(map, x, y);
    return tile === T_ROAD || tile === T_BRIDGE;
  };
  const along = (i: number): boolean => (alongY ? road(tx, ty + i) : road(tx + i, ty));
  const across = (i: number): boolean => (alongY ? road(tx + i, ty) : road(tx, ty + i));
  // Runs at least 3 tiles each way along the street...
  for (let i = 1; i <= 3; i++) if (!along(i) || !along(-i)) return false;
  // ...and is no wider across it than a carriageway. Wider means a plaza or
  // the middle of a diagonal band, and a parked car there is in the road.
  let width = 1;
  for (let i = 1; i <= 5 && across(i); i++) width++;
  for (let i = 1; i <= 5 && across(-i); i++) width++;
  return width <= 4;
}

/**
 * The street grid's bearing at this tile, in radians, or 0 on the axes.
 *
 * Read from the baked bearing plane (`CityMap.bearing`): the exact angle the
 * borough's lattice was carved with (§13.4 `grid` fabric), not an estimate
 * from tarmac. The kerb inference above knows two directions, and a rotated
 * borough's streets run at neither — every kerb in the Old Quarter says
 * "north-south street" about tarmac running twenty degrees off it.
 */
function bearingAt(map: CityMap, tx: number, ty: number): number {
  const deg = map.bearing?.[ty * map.widthTiles + tx] ?? 0;
  return (deg * PI) / 180;
}

/**
 * Does the street really run along `angle` here, and is it street-narrow?
 *
 * The rotated-street version of `axisCarriageway`: walk the true line three
 * tiles each way, then measure across it. The width bound is 3 rather than
 * 4 — every rotated lattice street is 3 wide, and the 4s are the authored
 * avenues and the ring's stair-steps, where a parked car is in the traffic.
 */
function bearingCarriageway(map: CityMap, tx: number, ty: number, angle: number): boolean {
  const road = (x: number, y: number): boolean => {
    const tile = t(map, Math.round(x), Math.round(y));
    return tile === T_ROAD || tile === T_BRIDGE;
  };
  const dx = dCos(angle);
  const dy = dSin(angle);
  // One tile of sideways tolerance on the walk: a rotated band's edge lane
  // rasterises with a half-tile wobble, and a spot ON the wobble is still on
  // a street that genuinely continues. What the car needs is the street,
  // not the raster.
  const on = (x: number, y: number): boolean =>
    road(x, y) || road(x - dy, y + dx) || road(x + dy, y - dx);
  for (let i = 1; i <= 3; i++) {
    if (!on(tx + dx * i, ty + dy * i) || !on(tx - dx * i, ty - dy * i)) return false;
  }
  let width = 1;
  for (let i = 1; i <= 6 && road(tx - dy * i, ty + dx * i); i++) width++;
  for (let i = 1; i <= 6 && road(tx + dy * i, ty - dx * i); i++) width++;
  // Six across, not three: the walk above has already proved the street runs
  // linearly here with the car's own heading, and the spot is kerb-adjacent
  // by construction — the disease this test exists for was cars standing at
  // WRONG headings mid-carriageway, not cars hugging the edge of a wide one.
  // Contour fabrics make wide-but-linear tarmac routine (two shore bands
  // meeting along an inland ridge read as one six-wide boulevard); past six
  // it is a plaza, and a parked car in a plaza is in everyone's way.
  return width <= 6;
}

/** Parked-car spawn points along road edges (consumed by phase 3). */
export function placeVehicleSpawns(map: CityMap, params: WorldgenParams): void {
  const spawns: VehicleSpawn[] = [];
  // Segments of this many tiles, one car in each. The old rule was a running
  // countdown of `parkedCarSpacing` plus a 0-4 jitter, so this is the same
  // average density expressed without any running state.
  const span = Math.max(2, Math.round(params.parkedCarSpacing) + 2);
  // Hashed once, not once per tile: the label walk is not free at city scale.
  const where = deriveSeed(map.seed, 'parking.where');
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_ROAD) continue;
      const sidewalkLeft = t(map, tx - 1, ty) === T_SIDEWALK;
      const sidewalkUp = t(map, tx, ty - 1) === T_SIDEWALK;
      if (!sidewalkLeft && !sidewalkUp) continue;
      const gx = tx;
      const gy = ty;
      // Where the kerb is says which way the road runs, and the car is placed
      // by dividing THAT axis into fixed segments and hashing one offset
      // inside each. Fixed segments keep the minimum separation the countdown
      // used to give — two parked cars in adjacent tiles would interpenetrate
      // — and hashing the offset keeps the row from looking ruled.
      const alongY = sidewalkLeft;
      const seg = Math.floor((alongY ? gy : gx) / span);
      const key = alongY ? placeHash(where, gx, seg) : placeHash(where, seg, gy);
      // Floor-mod: the world runs into negative coordinates, and `%` there
      // returns a negative offset that no tile can equal.
      const along = alongY ? gy : gx;
      if (along - seg * span !== key % span) continue;
      // Heading follows the road direction implied by which side has kerb,
      // and which way along it is a second draw from the same place. On a
      // rotated street (§13.4) the kerb's guess is wrong by the borough's
      // whole angle — a car spawned by it noses into the frontage and wedges
      // there, which for a police cruiser is a unit lost before the chase
      // starts — so the tarmac's own bearing wins whenever it is confident
      // and off-axis. On the axis grids the probe measures the axis to the
      // bit and this stays exactly the heading it always was.
      const flip = placeHash(where, gx * 2 + 1, gy * 2 + 1) % 2 === 0;
      const grid = bearingAt(map, gx, gy);
      // A rotated lattice runs two ways — the bearing and the bearing plus
      // ninety — and the tarmac says which family this kerb sits on.
      let heading = alongY ? (flip ? HALF_PI : -HALF_PI) : flip ? 0 : PI;
      if (grid !== 0) {
        const a = bearingCarriageway(map, gx, gy, grid)
          ? grid
          : bearingCarriageway(map, gx, gy, grid + HALF_PI)
            ? grid + HALF_PI
            : grid;
        heading = flip ? a : a + PI;
      }
      spawns.push({
        x: (tx + 0.5) * TILE_SIZE,
        y: (ty + 0.5) * TILE_SIZE,
        heading,
        kind: 'car',
      });
    }
  }
  map.vehicleSpawns = spawns;
  // No rng in the signature any more (wave 4.3). This pass used to draw from
  // a stream twice per car, then stopped — drawing from a WINDOW-ordered walk
  // was precisely what made parked cars a property of the viewport — and for
  // a long time it still TOOK a stream and handed it back untouched, which
  // advertised consumption that never happened. Streams are derived per pass
  // name, so dropping the argument shifts nobody.
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
export function placeParking(map: CityMap, params: WorldgenParams): void {
  const spots: VehicleSpawn[] = [];
  const half = PARKED_HALF_EXTENT;
  // One stream per question, derived once rather than per kerb.
  const whatSeed = deriveSeed(map.seed, 'parking.kind');
  const paintSeed = deriveSeed(map.seed, 'parking.paint');
  for (const s of map.vehicleSpawns) {
    const tx = Math.floor(s.x / TILE_SIZE);
    const ty = Math.floor(s.y / TILE_SIZE);
    const kerbWest = t(map, tx - 1, ty) === T_SIDEWALK;
    const kerbNorth = t(map, tx, ty - 1) === T_SIDEWALK;
    if (!kerbWest && !kerbNorth) continue;
    // Marked, not removed, where the kerb's guess about the street direction
    // cannot be trusted — the stair steps of the ring road and other curved
    // arterials, where a car parked by that guess sat crosswise in the
    // middle of the carriageway. Removing the spot instead moved every OTHER
    // parked car in the city (the fleet is the N best-ranked spots, so the
    // pool shrinking promotes new ones everywhere) and thinned the police
    // waves, which stage from the same kerbs. The mark keeps the lists and
    // their order intact; the session just never stands a car on it.
    // A rotated street (§13.4) has a bearing the kerb cannot name. Where the
    // baked bearing plane states one, the car parks along it — oriented so
    // the kerb is on its right, which is the same right-hand-traffic rule
    // the axis arms below apply — and the spot stays at the lane tile's
    // centre, because "push against the kerb edge" is axis arithmetic.
    // Everything on the axis grids takes the branch it always took, to the
    // pixel.
    const grid = bearingAt(map, tx, ty);
    if (grid !== 0) {
      // The plane stores ONE angle and the lattice runs two ways: its
      // streets lie along the bearing and along the bearing plus ninety.
      // The tarmac says which family this kerb belongs to.
      const along = bearingCarriageway(map, tx, ty, grid)
        ? grid
        : bearingCarriageway(map, tx, ty, grid + HALF_PI)
          ? grid + HALF_PI
          : null;
      const a = along ?? grid;
      // Kerb on the right of travel: for a west kerb that means heading
      // south; here it means whichever of the two ways along the bearing
      // puts the kerb tile on the right-hand side.
      //
      // `dSin`, not `Math.sin`, and this is the site that made the rule worth
      // extending here: on an east-west street `a` is exactly PI, and
      // `Math.sin(PI)` is 1.2246e-16 — the residue of PI's own float
      // representation, not a number the language pins the SIGN of. The test
      // below is `> 0`, so an engine returning zero or a hair negative parks
      // that car facing the other way down the street, and `heading` is a
      // snapshot field (`snapshot.ts`) that `hashState` hashes. `dSin(PI)` is
      // exactly 0 on every host, so the branch is the same everywhere.
      const rightDot = kerbWest ? dSin(a) : -dCos(a);
      const heading = rightDot > 0 ? a : a + PI;
      const trusted = along !== null;
      spots.push({
        x: s.x,
        y: s.y,
        heading,
        kind: PARKED_CYCLE[placeHash(whatSeed, tx, ty) % PARKED_CYCLE.length] as string,
        paint: placeHash(paintSeed, tx, ty) % PAINT_VARIANTS,
        ...(trusted ? {} : { crosswise: true }),
        gangId: 0,
      });
      continue;
    }
    const crosswise = !axisCarriageway(map, tx, ty, kerbWest);

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
      // What is parked here, and what colour it is, are facts about the KERB.
      //
      // Both used to be facts about this loop: `PARKED_CYCLE[spots.length % n]`
      // for the model, and the entity id — handed out in spawn order by the
      // session — for the paint. Neither survives the window moving. A session
      // that walks into the next region regenerates the map at a new origin,
      // and the scan order changes, so the same physical kerb comes back with
      // a different car on it in a different colour; every parked car in sight
      // changed model and paint at once, in front of the player, for no reason
      // visible in the world. It read as the terrain repainting the traffic.
      //
      // Hashed off the GLOBAL tile instead — the same coordinate system every
      // other pure worldgen pass uses — so the street outside your window is
      // the same street from whichever window it is generated. Still no rng
      // consumed: adding this shifts nobody else's draws.
      kind: PARKED_CYCLE[
        placeHash(whatSeed, tx, ty) % PARKED_CYCLE.length
      ] as string,
      paint: placeHash(paintSeed, tx, ty) % PAINT_VARIANTS,
      ...(crosswise ? { crosswise: true } : {}),
      // Filled in by assignTurf, which runs later: turf does not exist yet
      // at this point in generation, and reading it here would mark every
      // car as nobody's.
      gangId: 0,
    });
  }
  map.parkingSpots = spots;
}

/**
 * Hidden packages: a hundred of them, in places you would not walk past.
 *
 * "Hard to reach" is done by preferring tiles with the FEWEST open
 * neighbours — alley dead-ends, the far side of a fence, the gap behind a
 * building. A package on an open pavement is not hidden, it is litter.
 *
 * Every one is on ground a person can stand on, because a package you cannot
 * reach is worse than no package at all — there is a test.
 */
export function placePackages(map: CityMap, params: WorldgenParams): void {
  const want = Math.round(params.packageCount * areaScale(map));
  if (want <= 0) return;
  const open = (tx: number, ty: number): boolean => {
    const tile = t(map, tx, ty);
    return tile === T_SIDEWALK || tile === T_PARK || tile === T_LOT;
  };
  // Score every candidate by how enclosed it is, then take the most enclosed
  // — deterministically, and spread by a stride so they are not all in one
  // alley.
  const scored: Array<{ x: number; y: number; enclosure: number }> = [];
  for (let ty = 1; ty < map.heightTiles - 1; ty++) {
    for (let tx = 1; tx < map.widthTiles - 1; tx++) {
      if (!open(tx, ty)) continue;
      let walls = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          if (i === 0 && j === 0) continue;
          if (!open(tx + i, ty + j)) walls++;
        }
      }
      if (walls < 5) continue; // an open pavement is not a hiding place
      scored.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE, enclosure: walls });
    }
  }
  scored.sort((a, b) => b.enclosure - a.enclosure || a.y - b.y || a.x - b.x);
  map.packages = spread(scored, want);
}

/**
 * Take `count` items spread evenly across a list, rather than the first
 * `count` of it.
 *
 * The idiom this replaces was `list.filter((_, i) => i % stride === 0)
 * .slice(0, count)` with `stride = floor(list.length / count)`. That is a
 * no-op whenever the list is shorter than twice the cap, because the stride
 * comes out as 1 and the filter keeps everything — so the slice quietly takes
 * the FIRST `count` entries of a row-major sweep, which is exactly the
 * clustering the stride was added to prevent.
 *
 * It was not a small effect. On seed 7 it put 358 of 381 street props in the
 * northern half of the city and 23 in the southern; seed 11 skewed the other
 * way; seed 42 had nothing at all below y = 2632 of 3840. A whole half of
 * every generated city had no lamp posts, no bins and no street lighting.
 *
 * Indexing by `floor(i * length / count)` cannot degenerate: it always walks
 * the full list, never repeats an index, and is a pure function of the two
 * lengths, so every host still generates the same city.
 */
function spread<T>(list: readonly T[], count: number): T[] {
  const n = Math.min(count, list.length);
  if (n <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)] as T);
  return out;
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
/** How many explosive barrels a city gets, per nominal city. */
const BARRELS_PER_CITY = 60;

export function placeProps(map: CityMap): void {
  const props: CityMap['propSpawns'] = [];
  const barrels: CityMap['propSpawns'] = [];
  let lampN = 0;
  let binN = 0;
  let fenceN = 0;
  let barrelN = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      const tile = t(map, tx, ty);
      // Barrels stand on the yard as well as the pavement: an industrial
      // slab in this world mostly fronts onto its LOT, and a barrel rule
      // that only knew sidewalks put zero barrels in a city whose industry
      // had no kerbs.
      if (tile !== T_SIDEWALK && tile !== T_LOT) continue;
      const bldLeft = t(map, tx - 1, ty) === T_BUILDING;
      const bldUp = t(map, tx, ty - 1) === T_BUILDING;
      if (tile === T_LOT) {
        const district = DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number];
        if ((bldLeft || bldUp) && district === 'industrial' && ++barrelN % 3 === 0) {
          barrels.push({
            kind: 'barrel',
            x: (tx + 0.5) * TILE_SIZE,
            y: (ty + 0.5) * TILE_SIZE,
            orient: 0,
          });
        }
        continue;
      }
      const roadRight = t(map, tx + 1, ty) === T_ROAD;
      const roadDown = t(map, tx, ty + 1) === T_ROAD;
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
  const scale = areaScale(map);
  const barrels_ = Math.round(BARRELS_PER_CITY * scale);
  const furnitureCap = Math.round(PROPS_PER_CITY * scale) - barrels_;
  // Barrels get their own reserved slice, spread the same way so they are
  // across the industrial districts rather than piled in the first.
  map.propSpawns = spread(props, furnitureCap).concat(spread(barrels, barrels_));
}

/** Roughly how much street there is around a tile, in a seven-square box. */
function streetDensity(map: CityMap, tx: number, ty: number): number {
  let n = 0;
  for (let oy = -3; oy <= 3; oy++) {
    for (let ox = -3; ox <= 3; ox++) {
      const tile = t(map, tx + ox, ty + oy);
      if (tile === T_ROAD || tile === T_SIDEWALK) n++;
    }
  }
  return n;
}

/**
 * Where a player appears: on a pavement, in a built-up part of town.
 *
 * The district filter and the density test are both new, and both are here
 * because the city has a countryside and a working waterfront now. Any
 * pavement used to do, which on a map that is a third open country meant one
 * player in five started on a dock road with no traffic, no crowd, no shop
 * and nothing to steal — technically a spawn, and a bad first thirty seconds.
 */
export function placePlayerSpawns(map: CityMap, params: WorldgenParams, rng: number): number {
  // Deterministic candidate list: every 3rd sidewalk tile, row-major.
  const candidates: Vec2[] = [];
  let n = 0;
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (t(map, tx, ty) !== T_SIDEWALK) continue;
      const d = districtAt(map, tx, ty);
      if (d !== 'downtown' && d !== 'commercial' && d !== 'residential') continue;
      n++;
      if (n % 3 !== 0) continue;
      if (streetDensity(map, tx, ty) < 16) continue;
      candidates.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE });
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

/**
 * Where each kind of vehicle lives.
 *
 * "Every type of vehicle can be found somewhere in the world" was nominally
 * already true and practically was not. Four kinds came off `PARKED_CYCLE`;
 * the rest were a weighted roll in ambient traffic, where a digger was one in
 * a hundred on a spawn that despawns at 1100 px — findable in the sense that
 * a lottery ticket is winnable. And the tank existed only because
 * `placeTank` was special-cased back into the session after the parking
 * stride dropped it.
 *
 * So: a home is a place you can drive to. Two sources, in order.
 *
 *  1. **Thematic**, off what the city already generates — the ambulance at a
 *     hospital, the limo outside a tower, the bus at the stadium, the digger
 *     at the quarry, the pickup at the farm. This is the half worth having:
 *     it makes the map legible, because knowing what a building is tells you
 *     what is parked outside it.
 *  2. **A backstop.** Anything on the roster that found no anchor in this
 *     window is put at a kerbside point chosen by hashing its name, so the
 *     completeness rule holds on every seed and every window rather than
 *     usually. A city with no tower is not a city with no limousine.
 *
 * Deterministic and rng-free, like `placeParking`: derived from tiles and
 * landmarks, so no seed's city changes shape because a home was added.
 */
const LANDMARK_VEHICLES: Partial<Record<LandmarkKind, string[]>> = {
  hospital: ['ambulance'],
  police: ['copcar'],
  tower: ['limo'],
  stadium: ['bus'],
  power: ['truck'],
  farm: ['pickup'],
  quarry: ['digger'],
  campground: ['icecream'],
  // The reward for finding the airfield. A plane needs a runway to leave
  // the ground, so unlike everything else on this list it CANNOT have a
  // kerbside backstop — a plane parked on a street is scenery.
  airstrip: ['plane', 'chopper'],
};

/**
 * Kinds that must exist somewhere in every window, in priority order.
 *
 * Not simply "every kind in vehicles.json": the ones already common in
 * traffic need no help, and a police cruiser or a gang car turns up because
 * of who is driving it rather than because of where it is parked.
 */
const HOME_ROSTER = [
  'ambulance',
  'firetruck',
  'bus',
  'garbage',
  'truck',
  'digger',
  'limo',
  'icecream',
  'pickup',
  'moto',
  'bicycle',
  'tank',
  // A helicopter lifts from wherever it is standing, so a backstop one is a
  // working helicopter rather than an ornament. The plane is deliberately
  // absent: see LANDMARK_VEHICLES.
  'chopper',
];

/**
 * A drivable tile near a point that nothing else has already claimed.
 *
 * `taken` is not optional politeness: the station yard is the home of both a
 * cruiser and the tank, and without it they were handed the same tile — two
 * vehicles on one spot interpenetrate and shuffle apart at walking pace,
 * which is the failure `motorise` already had to learn about. A test caught
 * it on the first run.
 */
function drivableNear(map: CityMap, at: Vec2, taken: Vec2[], clearPx: number, reach = 7): Vec2 | null {
  const tx = Math.floor(at.x / TILE_SIZE);
  const ty = Math.floor(at.y / TILE_SIZE);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tile = t(map, tx + dx, ty + dy);
      // Road, lot, pavement or runway: somewhere a vehicle can be left and
      // driven off. The runway matters — it is the only ground the aircraft
      // that live on it are allowed to stand.
      if (tile !== T_ROAD && tile !== T_LOT && tile !== T_SIDEWALK && tile !== T_RUNWAY) continue;
      const d = dx * dx + dy * dy;
      if (d >= bestD) continue;
      const x = (tx + dx + 0.5) * TILE_SIZE;
      const y = (ty + dy + 0.5) * TILE_SIZE;
      let clash = false;
      for (const o of taken) {
        // Squared, not `Math.hypot`: `*` and `+` are exactly rounded under
        // IEEE-754 and `hypot` is not, and this comparison decides where a
        // vehicle stands in a city both hosts generate for themselves.
        const ox = o.x - x;
        const oy = o.y - y;
        if (ox * ox + oy * oy < clearPx * clearPx) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      bestD = d;
      best = { x, y };
    }
  }
  return best;
}

/** Stable per-name offset into a list, so a backstop lands in one place. */
function nameOffset(name: string, len: number): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return len > 0 ? (h >>> 0) % len : 0;
}

export function placeVehicleHomes(map: CityMap): void {
  const homes: VehicleSpawn[] = [];
  const placed = new Set<string>();

  // Every home needs room for its own body plus the longest thing that might
  // be parked beside it. A flat clearance off the largest vehicle in the game
  // is simpler than a per-pair test and errs the safe way.
  const CLEARANCE = 3 * TILE_SIZE;
  const taken: Vec2[] = [];
  const add = (kind: string, at: Vec2, heading: number): void => {
    const spot = drivableNear(map, at, taken, CLEARANCE);
    if (!spot) return;
    taken.push(spot);
    homes.push({ x: spot.x, y: spot.y, heading, kind, gangId: 0 });
    placed.add(kind);
  };

  // 1. Thematic, off the landmarks the city already has.
  for (const l of map.landmarks) {
    for (const kind of LANDMARK_VEHICLES[l.kind] ?? []) {
      add(kind, { x: l.doorX, y: l.doorY }, HALF_PI);
    }
  }
  // The tank keeps its old home — behind the first station — and now rides
  // in the list that cannot be sampled away instead of being re-added by
  // hand in the session.
  const yard = map.policeStations[0];
  if (yard) add('tank', { x: yard.x, y: yard.y + TILE_SIZE * 2 }, 0);

  // 2. The backstop, so the rule holds on every window and not merely on the
  //    generous ones.
  const spawns = map.vehicleSpawns;
  if (spawns.length > 0) {
    for (const kind of HOME_ROSTER) {
      if (placed.has(kind)) continue;
      const from = nameOffset(kind, spawns.length);
      // Walk from the hashed offset to the first point that takes it: a
      // kerbside spawn is on a road by construction, so this rarely walks.
      for (let i = 0; i < spawns.length; i++) {
        const c = spawns[(from + i) % spawns.length];
        if (!c) continue;
        const before = homes.length;
        add(kind, { x: c.x, y: c.y }, c.heading);
        if (homes.length > before) break;
      }
    }
  }

  map.vehicleHomes = homes;
}

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
  'health',
  'armour',
  'ammo',
  // One in the whole cycle, and the cycle is long: a multiplier you can find
  // often would make frenzies and missions — the two things the multiplier
  // exists to reward — not worth doing.
  'multi',
  'health',
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
  // Capped for the same reason the moorings are: every crate is a live sim
  // entity from the first tick — and the kinds are dealt over the CAPPED
  // list, not the candidate list. Dealt before the cap, the cycle's fairness
  // belonged to a list nobody gets: `spread` samples every ~(L/n)th
  // candidate, and whenever that stride shared a factor with the 24-long
  // cycle, whole residue classes of it vanished — the 4.6 rebake moved the
  // candidate count and the city shipped 607 crates with no jail card in
  // any of them. The mix is a property of what ships.
  const capped = spread(spawns, Math.round(PICKUPS_PER_CITY * Math.sqrt(areaScale(map))));
  map.pickupSpawns = capped.map((s, i) => ({
    ...s,
    kind: PICKUP_CYCLE[i % PICKUP_CYCLE.length] as PickupSpawnKind,
  }));
}


/**
 * Water a boat could actually leave in: every tile of the water-or-bridge
 * medium that the open sea reaches.
 *
 * The medium is water OR bridge because that is exactly what a boat may
 * occupy (`collide.ts`, `plainSolid` in the 'water' medium) — a deck passes
 * overhead, and
 * BUGS.md §9.2's guarantee that no mooring is shut in by a bridge holds
 * because a bridge never divides a body of water here either.
 *
 * The sea is seeded from the map edge rather than found by size: the city is
 * an island and the ocean runs off all four sides, so "connected to the
 * border" is the same question as "can this boat get out to sea", asked
 * without labelling every puddle. One flood over the whole plane, once per
 * bake, and then a lookup per mooring candidate — a flood PER candidate is
 * thirteen thousand floods (R5-A03).
 */
function seagoing(map: CityMap): Uint8Array {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const open = (i: number): boolean => map.tiles[i] === T_WATER || map.tiles[i] === T_BRIDGE;
  const reach = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (i: number): void => {
    if (reach[i] === 1 || !open(i)) return;
    reach[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  return reach;
}

/**
 * Moorings: water tiles with a bank close by, so a boat is reachable on
 * foot rather than stranded mid-river. Deterministic row-major sampling.
 */
export function placeBoatSpawns(map: CityMap): void {
  const spawns: VehicleSpawn[] = [];
  // ...and water that goes somewhere. The 3x3-of-open-water and bank-within-
  // three tests are both local, and an ornamental park pond satisfies both:
  // five of the shipped city's moorings were motorboats sitting in Ravenhill
  // Park's and Sunridge Park's ponds, ringed by sand and grass, boardable
  // from the path and unable to go anywhere at all (R5-A03). WORLDGEN.md §29
  // gave those ponds their beaches deliberately, so the pond is right and
  // the boat is wrong.
  const sea = seagoing(map);
  let n = 0;
  for (let ty = 1; ty < map.heightTiles - 1; ty++) {
    for (let tx = 1; tx < map.widthTiles - 1; tx++) {
      if (t(map, tx, ty) !== T_WATER) continue;
      // The whole 3x3 must be open water: a boat is 22 px across, so a
      // mooring pressed against the bank leaves the hull overlapping land
      // and the boat cannot move at all. This also keeps moorings clear of
      // the diagonal shoreline for free: a bevel needs two orthogonal land
      // neighbours, which only a CORNER of the 3x3 ring can have, and a
      // corner tile's land wedge starts a full tile diagonal (22.6 px) from
      // the mooring centre — beyond the hull's own 15.6 px corner reach.
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
      // ...and dry land within reach, or nobody can get aboard. The quay
      // is the natural mooring edge — that is what it is for.
      let bank = false;
      for (let dy = -3; dy <= 3 && !bank; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const near = t(map, tx + dx, ty + dy);
          if (
            near === T_BANK ||
            near === T_SAND ||
            near === T_SIDEWALK ||
            near === T_ROAD ||
            near === T_PARK ||
            near === T_LOT
          ) {
            bank = true;
            break;
          }
        }
      }
      if (!bank) continue;
      if (sea[ty * map.widthTiles + tx] !== 1) continue;
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
  // Bounded, unlike the point lists that only feed other passes: the session
  // spawns every one of these as a live entity, and the snapshot ring clones
  // every live entity thirty times a second. Density still rises with the
  // map — just not linearly, and never past what a tick can carry.
  map.boatSpawns = spread(spawns, Math.round(BOATS_PER_CITY * Math.sqrt(areaScale(map))));
}

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
  map.hospitals = map.landmarks
    .filter((l) => l.kind === 'hospital')
    .map((l) => ({ x: l.doorX, y: l.doorY }));
  map.policeStations = map.landmarks
    .filter((l) => l.kind === 'police')
    .map((l) => ({ x: l.doorX, y: l.doorY }));
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

/**
 * The proving ground: one room, as close to where players appear as a
 * carvable building gets.
 *
 * Runs DEAD LAST in generation — after every other pass, including the ones
 * that read the tile grid to place parking, props, pickups and spawns — and
 * draws no random number. Both of those are deliberate. Carving a room
 * changes tiles, and this file already has the scar tissue to prove that a
 * pass which quietly feeds a later one moves player spawns two districts
 * away (see `registerClinics`). Going last means turning the proving ground
 * on cannot move anything: the same seed gives the same city with it and
 * without it, so a bug you found with the room open is still there when you
 * close it.
 *
 * Nearest to `playerSpawns[0]` rather than anywhere clever, because the whole
 * point is that you can find it without being told where it is.
 */
export function placeProvingGround(map: CityMap): void {
  const home = map.playerSpawns[0];
  if (!home) return;
  const used = new Set(map.shops.map((s) => s.buildingIndex));

  // Every candidate, nearest first. A stable sort on a plain distance keeps
  // it deterministic without an rng draw; ties break on building index.
  const byDistance = map.buildings
    .map((b, bi) => {
      const cx = (b.x + b.w / 2) * TILE_SIZE;
      const cy = (b.y + b.h / 2) * TILE_SIZE;
      const dx = cx - home.x;
      const dy = cy - home.y;
      return { bi, d2: dx * dx + dy * dy };
    })
    .filter(({ bi }) => !used.has(bi))
    .sort((a, b) => a.d2 - b.d2 || a.bi - b.bi);

  for (const { bi } of byDistance) {
    const building = map.buildings[bi] as Building;
    if (Math.min(building.w, building.h) < 3) continue;
    const door = findDoorway(map, building);
    if (!door) continue;
    // A wide door, like a respray: you want to be able to drive a tank back
    // in as well as walk out.
    const room = carveInterior(map, building, door, true);
    if (!room) continue;
    map.shops.push({
      kind: 'depot',
      doorX: door.x,
      doorY: door.y,
      buildingIndex: bi,
      interior: room.interior,
      entryX: room.entryX,
      entryY: room.entryY,
    });
    // You start at the door. `pickSpawn` chooses uniformly from this list and
    // the ordinary list is spread across the whole city, so leaving it alone
    // meant landing near the room one time in however many spawns there are —
    // which is a treasure hunt, and the room exists to save time. This is the
    // ONLY thing the proving ground changes outside its own four walls, and
    // it changes nothing about the city itself: the tiles, the buildings, the
    // parked cars, the props and the pickups are all identical with it and
    // without it.
    map.playerSpawns = [{ x: (door.x + 0.5) * TILE_SIZE, y: (door.y + 0.5) * TILE_SIZE }];
    return;
  }
}

export function placeCranes(map: CityMap): void {
  // Every quarry works a crusher, wherever the plan put the quarry: the crane
  // economy reaches the countryside. Seeded into the list FIRST rather than
  // appended, so the spacing rule below counts them — a scanned site 500px
  // from the quarry pit is two crushers in the same place.
  const sites: Vec2[] = map.landmarks
    .filter((l) => l.kind === 'quarry')
    .map((l) => ({ x: (l.x + l.w - 2.5) * TILE_SIZE, y: (l.y + l.h - 2.5) * TILE_SIZE }));
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

export function placeRamps(map: CityMap, seed: number): void {
  // Hash-gated per GLOBAL position, not every-Nth-candidate: ramps mutate
  // tiles, and a counter would make the tile a function of the window
  // rather than of the world.
  const rampSeed = deriveSeed(seed, 'ramps');
  for (let ty = 2; ty < map.heightTiles - 2; ty++) {
    for (let tx = 2; tx < map.widthTiles - 2; tx++) {
      if (t(map, tx, ty) !== T_LOT) continue;
      // Needs a clear run-up along one axis.
      const runX = t(map, tx - 2, ty) === T_LOT && t(map, tx - 1, ty) === T_LOT;
      const runY = t(map, tx, ty - 2) === T_LOT && t(map, tx, ty - 1) === T_LOT;
      if (!runX && !runY) continue;
      if (latticeHash(rampSeed, tx, ty) >= 1 / 90) continue;
      map.tiles[ty * map.widthTiles + tx] = T_RAMP;
    }
  }
}
