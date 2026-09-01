import { deriveSeed, seedRng } from '../rng/prng.js';
import { findDoorway, placeShopsFixed } from './amenities.js';
import {
  fillBlock,
  fillRegion,
  hedgerowAt,
  orchardRowAt,
  takePathCourses,
  takePondBankRings,
  takePondRings,
} from './buildings.js';
import { latticeHash } from './fields.js';
// The woodland predicate, imported rather than spelled out here — §46. It
// used to live in this file as `fbm(WILD_SEED, tx / 22, ty / 22) >= 0.52`,
// with the seed, the wavelength and the level as local constants no painter
// could reach. A wood's DRAWN outline is the level set of exactly this field
// (`woodCut.ts`), so two copies of it would be two answers to one question.
import { wildAt } from './woodCut.js';
import { MIN_FACING_FIT, facingAngle, massFit } from './heights.js';
import { buildLayout, type StreetCourse } from './layout.js';
import type { CityPlan, PlanLandmark } from './plan.js';
import {
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_RUNWAY,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  DISTRICT_TYPES,
  type BlockRect,
  type Building,
  type DistrictType,
  type Landmark,
  type LandmarkKind,
  type Shop,
} from './types.js';

/**
 * The bake: the authored plan turned into the finished ground of the one city
 * — tiles, blocks, buildings, landmarks and shopfronts.
 *
 * This runs OFFLINE, once, from `pnpm citybake`, and its output is committed
 * as `city.data.ts` beside this file. The game never runs it. That is the
 * point of the whole change: what ships is a map somebody looked at and
 * accepted, not a program that will produce a different map tomorrow.
 */

/**
 * The one seed the bake draws on, for the things below the level anybody
 * would draw by hand: which of a block's building plots is a courtyard, where
 * the woodland thins. A constant, not a parameter — the city has no seed.
 */
const BAKE_SEED = 0x0a11ce;

export interface BakedCity {
  name: string;
  widthTiles: number;
  heightTiles: number;
  tiles: Uint8Array;
  district: Uint8Array;
  /** Street-grid bearing per tile, degrees 0..179; 0 on the screen axes. */
  bearing: Uint8Array;
  blocks: BlockRect[];
  buildings: Building[];
  landmarks: Landmark[];
  shops: Shop[];
  /**
   * The authored roads' centrelines as carved (tile units), trimmed to the
   * finished carriageway — what the renderer strokes to draw a curved road
   * as one line instead of a staircase of tiles. See WORLDGEN.md §16.
   */
  courses: StreetCourse[];
  /**
   * The waterline as closed rings, straight from the layout (VECTOR.md).
   *
   * Shipped rather than recovered at load: the coast is a boundary, so its
   * definition is the curve and the water tiles are its rasterisation. The
   * old arrangement ran the other way — tiles first, curve traced back out —
   * and no amount of smoothing could beat the staircase it started from.
   */
  shores: Array<{ points: Array<readonly [number, number]>; land: boolean; area: number }>;
  /**
   * The shore band's inner edge as closed rings (§39): where the quay, the
   * beach and the cliff foot give way to the ground behind them.
   *
   * The sibling of `shores`, shipped for the same reason. The sand and bank
   * tiles are its rasterisation, and the painters cut a tile against it the
   * same way they cut one against the waterline — so the line between sand
   * and grass runs at the angle the shore does, not at one of the five
   * angles a tile grid can say.
   */
  banks: Array<{ points: Array<readonly [number, number]>; land: boolean; area: number }>;
}

/**
 * How each kind of landmark is built: the ground it stands on, and the solid
 * footprints stamped on top, as fractions or offsets of its authored rect.
 *
 * `apron` is what the rest of the landmark's city block becomes — a stadium
 * gets grass around it, a power station gets yard, a tower gets a plaza. It
 * is what stops a hand-placed landmark leaving a hole in the street wall.
 */
interface Recipe {
  ground: number;
  apron: number;
  /**
   * Columns at the WEST end of the rect that get `apron` rather than
   * `ground` — the hut bay (R1-A08).
   *
   * Wave 2.3 promised the huts would come off the slabs and never moved
   * them: a 3x3 hangar stamped at the rect's corner notched nine tiles out
   * of the runway, and `runwayCentreRow` — which walks each column to the
   * strip's own edges — put those columns' centreline a row lower than the
   * rest, so the marked line jogged at x=507 and x=79. A landmark's ground
   * is what it is FOR; the shed beside it stands on hardstanding.
   */
  bay?: number;
  /** Solid footprints as [dx, dy, w, h, storeys?] — storeys authored where a
   * hash cannot know a chimney from a hall (wave 3.1). */
  parts: (w: number, h: number) => Array<[number, number, number, number, number?]>;
}

const RECIPES: Record<LandmarkKind, Recipe> = {
  // A stadium is a RING: stands on all four sides, an infield of grass, and
  // gates at the corners where the stands do not meet. One solid rect here
  // was the flyover's biggest disappointment — the city's two largest named
  // buildings read as warehouses with roof furniture
  // (REVIEW-WORLDGEN.md §2.4, `evidence/topdown-stadium-slab.png`). The
  // long stands rise over the end stands, so the mass tiers.
  stadium: {
    ground: T_PARK,
    apron: T_PARK,
    parts: (w, h) => [
      [1, 0, w - 2, 3, 4],
      [1, h - 3, w - 2, 3, 4],
      [0, 4, 3, h - 8, 2],
      [w - 3, 4, 3, h - 8, 2],
    ],
  },
  // Two turbine halls with the switchyard between them, and a pair of
  // stacks standing over everything — the silhouette a power station is
  // navigated by, which one slab plus a shed could not give it.
  power: {
    ground: T_LOT,
    apron: T_LOT,
    parts: (w, h) => [
      [0, 0, w - 5, 4, 3],
      [0, h - 4, w - 5, 4, 3],
      [w - 4, 1, 2, 2, 8],
      [w - 4, h - 3, 2, 2, 8],
    ],
  },
  tower: { ground: T_SIDEWALK, apron: T_SIDEWALK, parts: (w, h) => [[1, 1, w - 2, h - 2]] },
  hospital: { ground: T_LOT, apron: T_LOT, parts: (w, h) => [[0, 0, w, h]] },
  police: { ground: T_LOT, apron: T_LOT, parts: (w, h) => [[0, 0, w, h]] },
  // The country kinds: stamped on open ground, no block and no apron.
  farm: {
    ground: T_LOT,
    apron: T_LOT,
    parts: (w, h) => [
      [0, 0, 3, 3],
      [w - 4, h - 3, 4, 3],
    ],
  },
  campground: { ground: T_PARK, apron: T_PARK, parts: () => [[1, 1, 2, 2]] },
  lighthouse: { ground: T_FIELD, apron: T_FIELD, parts: (w, h) => [[0, 0, w, h]] },
  // The pit hut and the crusher: low masses on the worked floor, so the
  // quarry reads as a works rather than a shed on a car park.
  quarry: {
    ground: T_LOT,
    apron: T_LOT,
    parts: (w, h) => [
      [0, 0, 3, 3, 1],
      [w - 5, h - 4, 4, 3, 2],
    ],
  },
  // A long clear run and a hangar at one end: nothing else goes on it. The
  // apron is hardstanding, NOT more runway: with `apron: T_RUNWAY` the strip
  // ground spread four tiles past the drawn rect in every direction, under
  // and around the borough's streets — from the air, roads appeared to cross
  // the runway and the "runway" was three times the slab anybody drew
  // (REVIEW-WORLDGEN.md §2.1). A lot apron reads as what it is, and the
  // centreline rule now spans only the true strip.
  // ...and the hangar stands on a bay of that hardstanding at the west end,
  // not on the strip: the three columns it occupies are apron, so the runway
  // itself is an unbroken rectangle and its centreline runs true (R1-A08).
  // The drawn rects grew by those three columns when the bay was cut, so no
  // strip lost any of the run it was drawn with.
  airstrip: { ground: T_RUNWAY, apron: T_LOT, bay: 3, parts: () => [[0, 0, 3, 3]] },
  // The deliberate plazas (§13.6 step 7): open ground with streets flowing
  // through it. No parts — the space IS the landmark — except the circus,
  // whose monument stands in the ring's median for traffic to swing round.
  square: { ground: T_SIDEWALK, apron: T_SIDEWALK, parts: () => [] },
  green: { ground: T_PARK, apron: T_PARK, parts: () => [] },
  // Green, not paved: tarmac beside tarmac is invisible from the air, and
  // a circus is above all a thing you navigate by. Grass around the
  // carriageways with a monument in the median is the classic.
  circus: {
    ground: T_PARK,
    apron: T_SIDEWALK,
    parts: (w, h) => [[Math.floor(w / 2) - 1, Math.floor(h / 2) - 1, 3, 3]],
  },
};

/**
 * The solid footprints a landmark of this kind and size stamps, as
 * `[dx, dy, w, h]` offsets inside its rect.
 *
 * Exported for `checkCity`, which asks the one question the bake never asked
 * itself: is a landmark's stamped mass still standing when the bake ends?
 * Everything downstream reads the tile plane, so a wall quietly repainted by
 * a later pass leaves a `Building` record claiming ground that is now park
 * and nothing anywhere complains (R5-A04).
 */
export function landmarkParts(
  kind: LandmarkKind,
  w: number,
  h: number,
): Array<[number, number, number, number]> {
  return RECIPES[kind]
    .parts(w, h)
    .filter(([, , pw, ph]) => pw >= 1 && ph >= 1)
    .map(([dx, dy, pw, ph]) => [dx, dy, pw, ph] as [number, number, number, number]);
}

/**
 * Kinds whose footprint welcomes carriageway: a plaza with no streets
 * flowing through it is a courtyard. Their GROUND never overwrites road (the
 * `paintable` guard), and their solid parts are validated individually
 * instead of the whole rect — a circus monument that landed on a carriageway
 * would sever the ring, so it has to sit in the median, and the bake checks
 * that it does.
 */
const OPEN_TO_ROAD = new Set<LandmarkKind>(['square', 'green', 'circus']);

function paintable(t: number): boolean {
  return t !== T_WATER && t !== T_BANK && t !== T_SAND && t !== T_ROAD && t !== T_BRIDGE;
}

/**
 * The street network proper.
 *
 * Deliberately NOT "ground a car can stand on": a farmyard and a runway are
 * both drivable, and counting them would have the bake decide the farm was
 * already connected because the farm exists. What a driveway looks for is a
 * road.
 */
function onNetwork(t: number): boolean {
  return t === T_ROAD || t === T_BRIDGE;
}

/** Ground a track can be cut through: not a wall, not the sea. */
function cuttable(t: number): boolean {
  return (
    t === T_FIELD ||
    t === T_TREES ||
    t === T_PARK ||
    t === T_SIDEWALK ||
    t === T_SAND ||
    t === T_LOT ||
    t === T_RUNWAY
  );
}

/**
 * Cut a two-tile track from a door to the nearest road, if there is not one
 * within a couple of tiles already. Breadth-first over cuttable ground, so
 * the track is the shortest one that exists rather than a guess at a
 * direction.
 */
/**
 * Breadth-first scratch for `driveway`, allocated once for the whole bake
 * rather than per landmark — two and a half megabytes a time, two dozen
 * times, plus a full fill each. `era` is what makes reuse safe without
 * clearing: a cell belongs to this call only if its era matches.
 */
let drivewayFrom: Int32Array | null = null;
let drivewayEra: Int32Array | null = null;
let drivewayCall = 0;

function driveway(tiles: Uint8Array, W: number, H: number, dx: number, dy: number): void {
  // Twice, and the first attempt is the one that usually answers.
  //
  // The track is the shortest route from the door to the network, and the
  // shortest route out of a landmark's door runs along the landmark's own
  // flank — which lays carriageway flush against the wall with no kerb
  // between them, where every other road-to-wall contact in the drawn city
  // goes via pavement. Vantage Tower's drive is eight tiles of exactly that,
  // and it is invisible to the landmark's own kerb ring, which is drawn
  // before this pass exists. So: cut it once holding a tile off every wall,
  // and only if no such route exists at all fall back to the one that hugs
  // one — a landmark with no drive is a worse answer than a landmark with a
  // drive against its wall.
  if (cutTrack(tiles, W, H, dx, dy, true)) return;
  cutTrack(tiles, W, H, dx, dy, false);
}

function cutTrack(
  tiles: Uint8Array,
  W: number,
  H: number,
  dx: number,
  dy: number,
  keepOffWalls: boolean,
): boolean {
  const near = (x: number, y: number): boolean => {
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (onNetwork(tiles[ny * W + nx] as number)) return true;
      }
    }
    return false;
  };
  if (dx < 0 || dy < 0 || dx >= W || dy >= H || near(dx, dy)) return true;
  const besideWall = (x: number, y: number): boolean =>
    (x > 0 && tiles[y * W + x - 1] === T_BUILDING) ||
    (x + 1 < W && tiles[y * W + x + 1] === T_BUILDING) ||
    (y > 0 && tiles[(y - 1) * W + x] === T_BUILDING) ||
    (y + 1 < H && tiles[(y + 1) * W + x] === T_BUILDING);

  if (drivewayFrom === null || drivewayFrom.length < W * H) {
    drivewayFrom = new Int32Array(W * H);
    drivewayEra = new Int32Array(W * H);
  }
  const from = drivewayFrom;
  const era = drivewayEra as Int32Array;
  const call = ++drivewayCall;
  const start = dy * W + dx;
  from[start] = start;
  era[start] = call;
  const queue = [start];
  let head = 0;
  let hit = -1;
  while (head < queue.length && hit < 0) {
    const i = queue[head++] as number;
    const x = i % W;
    const y = (i - x) / W;
    for (const [ox, oy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      const j = ny * W + nx;
      if (era[j] === call) continue;
      const t = tiles[j] as number;
      if (onNetwork(t)) {
        from[j] = i;
        era[j] = call;
        hit = j;
        break;
      }
      if (!cuttable(t)) continue;
      // The second tile of the track is the one to the east, so a route that
      // keeps off walls has to keep its neighbour off them too.
      if (keepOffWalls && (besideWall(nx, ny) || besideWall(nx + 1, ny))) continue;
      from[j] = i;
      era[j] = call;
      queue.push(j);
    }
  }
  if (hit < 0) return false;
  for (let i = hit; i !== start; i = from[i] as number) {
    if (!onNetwork(tiles[i] as number)) tiles[i] = T_ROAD;
    // Two tiles wide, so it is a track and not a footpath.
    if (cuttable(tiles[i + 1] as number)) tiles[i + 1] = T_ROAD;
  }
  return true;
}

export function bakeCity(plan: CityPlan): BakedCity {
  const layout = buildLayout(plan);
  const W = layout.widthTiles;
  const H = layout.heightTiles;

  // A landmark that overlaps the sea or a street is an authoring slip that
  // would otherwise bake silently: the stamp overwrites whatever is there, so
  // a hospital drawn two tiles too wide swallows the road beside it and
  // strands every street beyond. The plan has to be right; say which line is
  // wrong, and where.
  for (const l of plan.landmarks) {
    const [lx, ly, lw, lh] = l.rect;
    const openToRoad = OPEN_TO_ROAD.has(l.kind);
    for (let ty = ly; ty < ly + lh; ty++) {
      for (let tx = lx; tx < lx + lw; tx++) {
        const t = layout.tiles[ty * W + tx] as number;
        if (layout.water[ty * W + tx] === 1) {
          throw new Error(`city plan: landmark ${l.name} at ${lx},${ly} stands in the water`);
        }
        if (!openToRoad && (t === T_ROAD || t === T_BRIDGE)) {
          throw new Error(
            `city plan: landmark ${l.name} at ${lx},${ly} (${lw}x${lh}) is built over the road at ${tx},${ty}`,
          );
        }
      }
    }
    // A plaza's SOLID parts still may not stand on carriageway: the circus
    // monument belongs in the median, and one tile over severs the ring.
    if (openToRoad) {
      for (const [dx, dy, pw, ph] of RECIPES[l.kind].parts(lw, lh)) {
        for (let ty = ly + dy; ty < ly + dy + ph; ty++) {
          for (let tx = lx + dx; tx < lx + dx + pw; tx++) {
            const t = layout.tiles[ty * W + tx] as number;
            if (t === T_ROAD || t === T_BRIDGE) {
              throw new Error(
                `city plan: ${l.name}'s monument stands on the carriageway at ${tx},${ty} — centre it on the median`,
              );
            }
          }
        }
      }
    }
  }
  const tiles = layout.tiles;
  const buildings: Building[] = [];
  const landmarks: Landmark[] = [];

  /**
   * Tiles a landmark's own stamp has already made solid.
   *
   * `paintable()` explicitly allows `T_BUILDING`, which is right for the
   * apron inside a landmark's own block — the clear pass has just demolished
   * everything there — and wrong for a NEIGHBOUR's landmark mass, which the
   * same pass deliberately refuses to demolish (`landmarkBuilt`). Without
   * this mask the two halves disagreed: the building record survived and its
   * walls did not. Chapel Green's four-tile reclaim apron reached three
   * columns into Marsh Post and painted six rows of the police station to
   * park, leaving a 7x7 record over a 4x7 building (R5-A04).
   *
   * A mask rather than a re-stamp after the ground passes: the stamp also
   * pushes the `Building` and `Landmark` records and finds the doorway, so
   * re-running it would duplicate records or need to be split in two, and a
   * mass re-laid at the end would go down over the kerb ring, the driveways
   * and the tree clearing that were all drawn around where it used to be.
   * Refusing the paint keeps every pass's output exactly where it was, and
   * it sits one line from the `landmarkBuilt` guard that makes the same
   * promise about the records.
   */
  const landmarkMass = new Uint8Array(W * H);

  const ground = (x: number, y: number, w: number, h: number, tile: number): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) {
        const i = ty * W + tx;
        if (landmarkMass[i] === 1) continue;
        if (paintable(tiles[i] as number)) tiles[i] = tile;
      }
    }
  };
  /**
   * The buildings a LANDMARK stamped, by identity (§36).
   *
   * §30 stopped the block-clearing pass deleting these, but identified them by
   * "overlaps some landmark's rect", which also protects an ordinary house
   * that happens to stand in one — and the apron then paints `T_LOT` over
   * tiles whose building record survived. Identity says exactly what was
   * meant: this building IS a landmark's own stamp.
   *
   * Read twice: by the block-clearing pass below, and by `placeShopsFixed`
   * at the end of the bake, which is handed this set for the same reason —
   * it too walks `city.buildings` and would otherwise carve a respray garage
   * out of a hospital ward or a police station (§36.1).
   */
  const landmarkBuilt = new WeakSet<Building>();
  const solid = (
    x: number,
    y: number,
    w: number,
    h: number,
    district: DistrictType,
    storeys?: number,
  ): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) {
        tiles[ty * W + tx] = T_BUILDING;
        landmarkMass[ty * W + tx] = 1;
      }
    }
    const rec: Building = { x, y, w, h, district, ...(storeys !== undefined ? { storeys } : {}) };
    landmarkBuilt.add(rec);
    buildings.push(rec);
  };

  /**
   * A landmark's plot, held off the carriageway.
   *
   * Every block in the city holds its buildings one tile inside its own edge,
   * so the kerb belt gets laid between the wall and the road. A landmark does
   * not go through that: its plot is drawn by hand, the recipe stamps its
   * masses at the rect, and the kerb ring drawn round it afterwards can only
   * paint GROUND — a ring tile that is already carriageway stays carriageway,
   * because paving a road is not a kerb. So wherever the author's rect
   * happens to touch tarmac the mass ends up flush against it: Sunridge
   * Station and Seaview Infirmary are the two places in the drawn city where
   * that happens, each with pavement on its block's other three sides, while
   * every other road-to-wall contact in the city goes via pavement.
   *
   * The PLOT gives up the row, not the mass: the rect shrinks by one tile on
   * the face that meets the road, the recipe lays the landmark out in what is
   * left, and the freed row is paved. Shaving the stamped mass instead would
   * leave the recipe and the tiles disagreeing about what a hospital is —
   * which is the property `city.test.ts` pins as "the mass it stamped is
   * still there".
   */
  const holdOffRoad = (
    rect: readonly [number, number, number, number],
  ): [number, number, number, number] => {
    let [x, y, w, h] = rect;
    const roadAt = (tx: number, ty: number): boolean => {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
      const t = tiles[ty * W + tx] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    const kerb: number[] = [];
    // One face at a time, and never past a plot four tiles across: a landmark
    // that gives up its last row is not a landmark any more, and a plot boxed
    // in by carriageway on all four sides is the drawing's statement to make,
    // not the bake's to answer by demolition.
    for (const side of ['w', 'e', 'n', 's'] as const) {
      if (w < 5 || h < 5) break;
      const vertical = side === 'w' || side === 'e';
      const n = vertical ? h : w;
      const fx = side === 'e' ? x + w : side === 'w' ? x - 1 : x;
      const fy = side === 's' ? y + h : side === 'n' ? y - 1 : y;
      let faces = false;
      for (let k = 0; k < n && !faces; k++) {
        faces = roadAt(fx + (vertical ? 0 : k), fy + (vertical ? k : 0));
      }
      if (!faces) continue;
      const kx = side === 'e' ? x + w - 1 : x;
      const ky = side === 's' ? y + h - 1 : y;
      for (let k = 0; k < n; k++) {
        const tx = vertical ? kx : kx + k;
        const ty = vertical ? ky + k : ky;
        if (tx >= 0 && ty >= 0 && tx < W && ty < H) kerb.push(ty * W + tx);
      }
      if (vertical) {
        w--;
        if (side === 'w') x++;
      } else {
        h--;
        if (side === 'n') y++;
      }
    }
    for (const i of kerb) {
      const t = tiles[i] as number;
      if (t === T_ROAD || t === T_BRIDGE || t === T_WATER) continue;
      tiles[i] = T_SIDEWALK;
      landmarkMass[i] = 1;
    }
    return [x, y, w, h];
  };

  const stamp = (l: PlanLandmark): void => {
    const recipe = RECIPES[l.kind];
    // A plaza WANTS road through it, so it keeps the rect it was drawn with;
    // everything else is held a tile off the carriageway.
    const [x, y, w, h] = OPEN_TO_ROAD.has(l.kind) ? l.rect : holdOffRoad(l.rect);
    // DISTRICT_TYPES by index, not a positional copy of it: two hardcoded
    // lists here survived every review until wave 4.1, and a reorder of the
    // source of truth would have silently relabelled every stamped building
    // with no type error and no red test.
    const district = DISTRICT_TYPES[layout.district[y * W + x] as number] as DistrictType;
    const bay = recipe.bay ?? 0;
    if (bay > 0) ground(x, y, bay, h, recipe.apron);
    ground(x + bay, y, w - bay, h, recipe.ground);
    for (const [dx, dy, pw, ph, storeys] of recipe.parts(w, h)) {
      if (pw < 1 || ph < 1) continue;
      solid(x + dx, y + dy, pw, ph, district, storeys);
    }
    const door = findDoorway(
      { widthTiles: W, heightTiles: H, tiles } as never,
      { x, y, w, h, district },
    );
    landmarks.push({
      kind: l.kind,
      name: l.name,
      x,
      y,
      w,
      h,
      doorX: door ? (door.x + 0.5) * TILE_SIZE : (x + w / 2) * TILE_SIZE,
      doorY: door ? (door.y + 0.5) * TILE_SIZE : (y + h + 0.5) * TILE_SIZE,
    });
  };

  // Country landmarks go down BEFORE anything is built, because the meadow
  // fill only ever rewrites bare ground: stamped first, the farmyard and the
  // runway are simply not bare ground when the woodland arrives.
  const claimed = new Set(layout.blocks.filter((b) => b.landmark >= 0).map((b) => b.landmark));
  for (const [li, l] of plan.landmarks.entries()) if (!claimed.has(li)) stamp(l);

  // Every block is built, including the ones a landmark stands in.
  //
  // Claimed blocks used to be kerbed, surfaced and then left alone, which is
  // fine for a police station in a twelve-tile block and ruinous for a tower
  // standing in a hundred-tile park: the first drawn island came out with
  // eight thousand tiles of bare ground where its biggest park should have
  // been, because one landmark had claimed the block. The block is filled
  // like any other, and the landmark is cleared out of it afterwards.
  // The rural fringe (§14.3 D5): how far every tile of country stands from
  // town, walked over dry land from all urban-owned ground. The band within
  // one rural pitch of the seam is the ecotone — smallholdings and orchard
  // rows instead of bare meadow — and the depth is the rural district's own
  // pitch, so a tight shore parish frays over a shorter reach than the
  // open marsh.
  const townDist = new Int32Array(W * H).fill(-1);
  {
    const bag: number[] = [];
    for (let i = 0; i < townDist.length; i++) {
      const own = layout.owner[i] as number;
      if (own >= 0 && !(plan.districts[own] as { rural?: boolean }).rural && layout.water[i] !== 1) {
        townDist[i] = 0;
        bag.push(i);
      }
    }
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q] as number;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if ((townDist[j] as number) >= 0 || layout.water[j] === 1) continue;
        townDist[j] = (townDist[i] as number) + 1;
        bag.push(j);
      }
    }
  }
  const fringeAt = (tx: number, ty: number): boolean => {
    // Bounds first. A block's bounding box can reach the map edge — the
    // drawn city never puts one there, a generated one does — and a tile
    // index off the end of the plane reads as `undefined`, which is not
    // less than zero, and the district lookup below then explodes on a
    // borough that does not exist.
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const i = ty * W + tx;
    const own = layout.owner[i] as number;
    if (own < 0) return false;
    const d = plan.districts[own] as { rural?: boolean; street: { pitchX: number; pitchY: number } };
    if (!d.rural) return false;
    const td = townDist[i] as number;
    return td >= 0 && td <= Math.min(d.street.pitchX, d.street.pitchY);
  };
  for (const b of layout.blocks) {
    const rng = seedRng(deriveSeed(BAKE_SEED, `block.${b.x}.${b.y}`));
    const within = (tx: number, ty: number): boolean =>
      tx >= b.x && ty >= b.y && tx < b.x + b.w && ty < b.y + b.h &&
      b.mask[(ty - b.y) * b.w + (tx - b.x)] === 1;
    // A rotated borough's blocks are parallelograms and a contour borough's
    // are crescents between shore bands: their fill follows the street
    // frontage the mask knows about, not the box the ring fill walks (see
    // fillRegion). Rural ground has no frontage either way.
    if ((b.angle !== 0 || b.shaped) && !b.rural) fillRegion(tiles, W, H, buildings, b, rng, within);
    else fillBlock(tiles, W, H, buildings, b, rng, wildAt, within, fringeAt);
  }

  // Country outside a block is still country.
  //
  // The fill above visits blocks and nothing else, and the blocks are cut
  // round the lattice — so every tile of country no block covers keeps the
  // bare meadow the ground pass wrote, whatever put it outside a block. Two
  // things do, and until this round only one of them was answered:
  //
  //  - A REMOVAL. Three passes in the layout delete road AFTER the blocks are
  //    cut (the ring shave, the bridge trim, the orphan prune, all marked in
  //    `layout.cleared`) and every one of them writes bare ground: the
  //    removal puts the GROUND back and not the country the carve cleared to
  //    make room. On Gannet Rock — an island WORLDGEN.md §12.9 calls wild and
  //    §14.6 calls deliberately trackless, whose entire lattice the orphan
  //    prune takes out for having no link to the mainland — that shipped a
  //    wood with a road-shaped hole in it.
  //  - A COASTLINE THE DISTRICT POLYGON DOES NOT REACH. Gannet Rock's polygon
  //    begins at y=598 and the island runs up to y=566, so the northern third
  //    of it carries no block at all. That shipped as three thousand tiles of
  //    unbroken meadow with the canopy starting on a dead straight line at
  //    y=600, which is where the block grid begins and nothing a player can
  //    see.
  //
  // They are the same defect and they take the same answer: the rural fill's
  // own rule, asked again over the ground it never visited. The wildness
  // field decides wood or meadow, woodland stays a tile off any surviving
  // lane so every lane is drivable at full width, and it never touches the
  // waterline, where trees are the cliff the shore pass put there and
  // clearing or planting one would move a landing.
  //
  // ASKING THE FIELD, rather than growing out from the removal, is what makes
  // the two answers one answer — and it is also what makes this safe. The
  // first version of this pass seeded on `cleared` and spread four tiles into
  // the verge, which closes a corridor but plants a nine-tile band of
  // whatever the field says over open grassland: dead-straight woods striped
  // across Gannet's north, this defect wearing the other hat, and it needed a
  // both-flanks gate to hold it back. Over ALL the ground no block covers
  // there is nothing to hold back, because the canopy edge is the field's own
  // contour — the same contour the blocks either side of a scar were filled
  // from. A corridor closes because its two flanks agree about it; open
  // country stays open because the field says meadow there; and the seam at
  // y=600 stops being a seam because the same question was asked on both
  // sides of it.
  {
    const covered = new Uint8Array(W * H);
    for (const b of layout.blocks) {
      for (let ty = Math.max(0, b.y); ty < Math.min(H, b.y + b.h); ty++) {
        for (let tx = Math.max(0, b.x); tx < Math.min(W, b.x + b.w); tx++) {
          if (b.mask[(ty - b.y) * b.w + (tx - b.x)] === 1) covered[ty * W + tx] = 1;
        }
      }
    }
    const rural = (i: number): boolean => {
      const own = layout.owner[i] as number;
      return own >= 0 && (plan.districts[own] as { rural?: boolean }).rural === true;
    };
    /** Bare ground in no block, in country: the ground the fill never saw. */
    const orphan = (i: number): boolean =>
      covered[i] === 0 && tiles[i] === T_FIELD && layout.water[i] !== 1 && rural(i);
    const solidAt = (tx: number, ty: number, t: number): boolean =>
      tx >= 0 && ty >= 0 && tx < W && ty < H && tiles[ty * W + tx] === t;
    const near = (tx: number, ty: number, t: number, r: number): boolean => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) if (solidAt(tx + dx, ty + dy, t)) return true;
      }
      return false;
    };
    // NEVER A WOOD ACROSS A MOUTH.
    //
    // One tile of verge is enough to keep a lane drivable at its full width,
    // which is the rule the rural fill states — but it is a rule about the
    // SIDE of a lane, and it has nothing to say about the gap between the end
    // of one carriageway and the start of the next. The ring's held-short
    // mouths (§14.3 D6) are three and four tiles deep, so the tile in the
    // middle of one stands clear of both and would otherwise be planted. A
    // tree there is not a hole in a canopy closing over, it is a street
    // walled up: `mapaudit` reads a wood across a mouth as `high`, "a street
    // that cannot be driven at all", and it is right to.
    const roadWithin = (x: number, y: number, dx: number, dy: number): boolean => {
      for (let k = 1; k <= 3; k++) {
        if (solidAt(x + dx * k, y + dy * k, T_ROAD)) return true;
        if (solidAt(x + dx * k, y + dy * k, T_BRIDGE)) return true;
      }
      return false;
    };
    const acrossAMouth = (x: number, y: number): boolean =>
      (roadWithin(x, y, 1, 0) && roadWithin(x, y, -1, 0)) ||
      (roadWithin(x, y, 0, 1) && roadWithin(x, y, 0, -1));
    // Decided against the picture as the blocks left it, so the answer does
    // not depend on the order the plane is walked in.
    const plant: number[] = [];
    const chosen = new Uint8Array(W * H);
    const take = (i: number): void => {
      if (chosen[i] === 1) return;
      chosen[i] = 1;
      plant.push(i);
    };
    for (let i = 0; i < W * H; i++) {
      if (!orphan(i)) continue;
      const x = i % W;
      const y = (i - x) / W;
      if (!wildAt(x, y)) continue;
      // One tile of verge keeps every surviving lane drivable at full width —
      // the rule fillBlock states for the woodland it plants itself.
      if (near(x, y, T_ROAD, 1) || near(x, y, T_BRIDGE, 1)) continue;
      if (near(x, y, T_WATER, 1)) continue;
      if (acrossAMouth(x, y)) continue;
      take(i);
    }

    // THE REST OF THE RULE, not just the wildness field.
    //
    // `fillBlock`'s rural branch plants three things, and until now this pass
    // asked about one. The wildness field decides WOODLAND, and it is the
    // only one of the three that has anything to say about open country in
    // the middle of a parish — which is why asking it alone closed the seam
    // at Gannet Rock's y=600 and left nothing visible outstanding there.
    //
    // The other two are patterns keyed to something the ground already has,
    // and they are the ones a block boundary cuts in half:
    //
    //  - HEDGEROWS, one verge back from every lane. Their hash is keyed on
    //    the world grid precisely "so a run crosses block corners unbroken" —
    //    and then a run reaching the edge of the last block stopped dead on a
    //    line nothing draws, because the ground beyond it was in no block. On
    //    the shipped plan 19 of the 46 severed runs touch a hedge that IS
    //    planted, which is the seam in its visible form.
    //  - ORCHARD ROWS, in the fringe band within one rural pitch of town
    //    (§14.3 D5). Blockless country inside that band — 1,076 tiles of it —
    //    got plain meadow where the block beside it frays into rows.
    //
    // The predicates are `buildings.ts`'s own, called rather than copied, so
    // the two sides of a block edge cannot answer differently. What this pass
    // keeps from itself are its own two refusals, which are stricter than the
    // block's and stay that way: nothing within one tile of the waterline,
    // where a tree is the cliff the shore pass put there; and nothing across
    // a held-short mouth, where a tree is not a hedge but a street walled up.
    for (let i = 0; i < W * H; i++) {
      if (!orphan(i)) continue;
      const x = i % W;
      const y = (i - x) / W;
      if (!hedgerowAt(tiles, W, H, x, y) && !(fringeAt(x, y) && orchardRowAt(tiles, W, H, x, y))) continue;
      if (near(x, y, T_WATER, 1)) continue;
      if (acrossAMouth(x, y)) continue;
      take(i);
    }
    for (const i of plant) tiles[i] = T_TREES;

    // ...and a ride left through it wherever the clearing was the only way.
    //
    // The corridor is a scar, but on Gannet Rock it was also the island's one
    // internal route: the wood is a wall to a car and to a pedestrian alike,
    // the cliff coast is sealed, and the meadow north of the airstrip reached
    // the strip through the very clearing this pass has just closed. Planting
    // it shut walled four thousand tiles off from everything and turned six
    // `citybake --check` warnings into seven. Closing a hole in a canopy is
    // worth doing; closing a way through is not, and the difference is
    // measurable rather than a matter of taste — so it is measured. Ground
    // that could be walked to before this pass can still be walked to after
    // it: where the new canopy severed two pieces that used to be one, a
    // single tile of the wood is taken back out, which is a ride through a
    // wood and not a road anybody removed. One tile wide, so no corridor.
    const open = (i: number, plantedIsOpen: boolean): boolean => {
      if (plantedIsOpen && planted[i] === 1) return true;
      const t = tiles[i] as number;
      return t !== T_BUILDING && t !== T_WATER && t !== T_TREES;
    };
    const planted = new Uint8Array(W * H);
    for (const i of plant) planted[i] = 1;
    /** Four-connected pieces of open ground — the rule `cityCheck` walks. */
    const label = (plantedIsOpen: boolean): Int32Array => {
      const lab = new Int32Array(W * H).fill(-1);
      let id = 0;
      for (let s0 = 0; s0 < W * H; s0++) {
        if ((lab[s0] as number) >= 0 || !open(s0, plantedIsOpen)) continue;
        const stack = [s0];
        lab[s0] = id;
        while (stack.length > 0) {
          const i = stack.pop() as number;
          const x = i % W;
          const y = (i - x) / W;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if ((lab[j] as number) >= 0 || !open(j, plantedIsOpen)) continue;
            lab[j] = id;
            stack.push(j);
          }
        }
        id++;
      }
      return lab;
    };
    // The picture as the fill left it: the planted tiles read as the open
    // ground they were a moment ago.
    const before = label(true);
    /**
     * Pieces the canopy closed over that are not worth a ride: see the price
     * test at the end of the round. Marked so the next round looks past them
     * instead of costing them out again.
     */
    const glade = new Uint8Array(W * H);
    // One severed piece rejoined per round, then look again: taking a ride
    // out changes the map the next round is measured on. The cap is a
    // backstop, not a budget — the drawn city uses five, one of them a refusal.
    for (let round = 0; round < 24; round++) {
      const after = label(false);
      const size = new Map<number, number>();
      const groups = new Map<number, Map<number, number>>();
      for (let i = 0; i < W * H; i++) {
        const a = after[i] as number;
        if (a < 0) continue;
        size.set(a, (size.get(a) ?? 0) + 1);
        const b = before[i] as number;
        let g = groups.get(b);
        if (g === undefined) {
          g = new Map();
          groups.set(b, g);
        }
        if (!g.has(a)) g.set(a, i);
      }
      const sizeOf = (id: number): number => size.get(id) ?? 0;
      // The biggest piece of a group keeps what the group was; the rest lost
      // it. Taking them biggest-first means a ride is always measured against
      // the smaller side, which is the side that lost something.
      let keepAt = -1;
      let lostId = -1;
      let lostSize = 0;
      for (const [, g] of groups) {
        if (g.size < 2) continue;
        const seats = [...g.entries()].sort((u, v) => sizeOf(v[0]) - sizeOf(u[0]));
        const home = seats[0] as [number, number];
        for (let s = 1; s < seats.length; s++) {
          const [id, seat] = seats[s] as [number, number];
          if (glade[seat] === 1) continue;
          keepAt = home[1];
          lostId = id;
          lostSize = sizeOf(id);
          break;
        }
        if (keepAt >= 0) break;
      }
      if (keepAt < 0) break;
      // The ride back out, and WHAT IT IS ALLOWED TO CROSS.
      //
      // The first version could only take back tiles it had just planted, and
      // what it had just planted over a corridor is a corridor: a two-tile
      // strip with a block wall of trees down each side, so the only route it
      // could ever find was the removed street's own clearing, end to end.
      // That is why Gannet Rock shipped with a dead straight forty-eight-tile
      // slot through its wood — the corridor this pass exists to close,
      // redrawn one tile narrower and by our own hand.
      //
      // But the wood either side is a wood, not a wall. A ride crosses
      // whoever's trees it likes, and woodland the fill planted inside a
      // rural block is no more sacred than woodland this pass planted outside
      // one — so the search may cross either, and the crossing it finds is
      // the narrowest neck between the two pieces instead of the length of a
      // vanished street. The waterline is the one exception and stays one:
      // trees on the shore are the cliff the shore pass put there, and a ride
      // through one is a landing on a coast the plan says has none.
      //
      // What does not change: open ground costs nothing to cross, so a ride
      // is only ever paid for in canopy; it is one tile wide, so it is a ride
      // and not a road; and the search is the same 0-1 breadth-first with one
      // deque and no heap.
      const keepId = after[keepAt] as number;
      /**
       * Canopy a ride may cross: anything this pass planted, and any woodland
       * standing in open country — but never a tree at the waterline.
       */
      const rideable = (j: number): boolean => {
        if ((tiles[j] as number) !== T_TREES) return false;
        if (planted[j] === 1) return true;
        if (!rural(j)) return false;
        const x = j % W;
        const y = (j - x) / W;
        return !near(x, y, T_WATER, 1);
      };
      const from = new Int32Array(W * H).fill(-1);
      const buckets: number[][] = [[]];
      for (let i = 0; i < W * H; i++) {
        if ((after[i] as number) !== keepId) continue;
        from[i] = i;
        (buckets[0] as number[]).push(i);
      }
      let hit = -1;
      for (let d = 0; d < buckets.length && hit < 0; d++) {
        const bucket = buckets[d] as number[];
        for (let q = 0; q < bucket.length && hit < 0; q++) {
          const i = bucket[q] as number;
          if ((after[i] as number) === lostId) {
            hit = i;
            break;
          }
          const x = i % W;
          const y = (i - x) / W;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if ((from[j] as number) >= 0) continue;
            const free = (after[j] as number) >= 0;
            if (!free && !rideable(j)) continue;
            from[j] = i;
            const nd = free ? d : d + 1;
            while (buckets.length <= nd) buckets.push([]);
            (buckets[nd] as number[]).push(j);
          }
        }
      }
      if (hit < 0) break;
      const ride: number[] = [];
      for (let i = hit; (from[i] as number) !== i; i = from[i] as number) {
        if ((tiles[i] as number) === T_TREES) ride.push(i);
      }
      // A GLADE IS NOT A SEVERED PLACE.
      //
      // The rule this pass keeps is that ground you could walk to before it
      // ran you can still walk to after — but a canopy closing over a single
      // tile of meadow has not taken a place away from anybody, it has made a
      // clearing, and a wood full of clearings is a wood. Left unsaid, that
      // costs exactly what it sounds like: the first thing this guard did on
      // Gannet Rock was cut ten tiles of straight ride through the trees to
      // reach ONE tile of grass.
      //
      // So the ride is priced against what it reaches: never spend more wood
      // on a ride than there is ground at the end of it. No threshold to
      // choose and nothing to tune — the measure is the map's own. The four
      // pieces the drawn city severs read 1, 424, 1207 and 52 tiles against
      // rides of 10, 5, 5 and 6, so the one-tile glade is left as a glade and
      // the three real ones are joined.
      if (ride.length > lostSize) {
        for (let i = 0; i < W * H; i++) if ((after[i] as number) === lostId) glade[i] = 1;
        continue;
      }
      // Every tree on the way back comes out; the open ground it crossed on
      // the way was never wood and is left alone.
      for (const i of ride) {
        tiles[i] = T_FIELD;
        planted[i] = 0;
      }
    }
  }


  // Then the landmark takes its plot back: anything built inside its footprint
  // or its apron is demolished, the ground surfaced, and a kerb laid round it
  // so the doorway pass has a pavement to find.
  const APRON = 4;
  for (const [li, l] of plan.landmarks.entries()) {
    if (!claimed.has(li)) continue;
    const [lx, ly, lw, lh] = l.rect;
    const x0 = lx - APRON;
    const y0 = ly - APRON;
    const x1 = lx + lw + APRON;
    const y1 = ly + lh + APRON;
    for (let bi = buildings.length - 1; bi >= 0; bi--) {
      const bd = buildings[bi] as Building;
      if (bd.x >= x1 || bd.x + bd.w <= x0 || bd.y >= y1 || bd.y + bd.h <= y0) continue;
      // ...but never another LANDMARK's. Country landmarks are stamped first,
      // before anything is built, and a landmark that later claims a block
      // overlapping one was clearing it away — building and all — leaving the
      // sidewalk ring it had already drawn round an empty field. That is why
      // Marsh Post stood on grass with no building in it and no entry in
      // `buildings` (WORLDGEN.md §30).
      if (landmarkBuilt.has(bd)) continue;
      for (let ty = bd.y; ty < bd.y + bd.h; ty++) {
        for (let tx = bd.x; tx < bd.x + bd.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          if (tiles[ty * W + tx] === T_BUILDING) tiles[ty * W + tx] = T_FIELD;
        }
      }
      buildings.splice(bi, 1);
    }
    ground(x0, y0, x1 - x0, y1 - y0, RECIPES[l.kind].apron);
    for (let ty = ly - 1; ty <= ly + lh; ty++) {
      for (let tx = lx - 1; tx <= lx + lw; tx++) {
        const onRing = tx === lx - 1 || ty === ly - 1 || tx === lx + lw || ty === ly + lh;
        if (!onRing || tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        // Not over a wall. `paintable` allows `T_BUILDING`, which is right
        // for the apron inside the block (the clear pass has already taken
        // those buildings) and wrong for a ring that reaches one tile PAST
        // the landmark, where a neighbouring block's building may stand —
        // pavement drawn across it left sidewalk inside a solid mass (§36).
        const here = tiles[ty * W + tx] as number;
        if (here !== T_BUILDING && paintable(here)) tiles[ty * W + tx] = T_SIDEWALK;
      }
    }
    stamp(l);
  }

  // Every landmark has a way in.
  //
  // A hand-placed farm two fields from the nearest lane is the one authoring
  // mistake that is easy to make and impossible to see on the picture, so the
  // bake fixes it rather than reporting it: shortest path from the door to
  // the road network over ground a track could be cut through, laid two tiles
  // wide. Nothing is cut through a building or across water, so a landmark
  // walled in by both simply keeps no drive and the checker says so.
  for (const [li, l] of landmarks.entries()) {
    // ...except the ones you fly to. Cutting a track to an island reachable
    // only from the air would be the bake quietly undoing the plan.
    if ((plan.landmarks[li] as PlanLandmark).byAir) continue;
    driveway(tiles, W, H, Math.floor(l.doorX / TILE_SIZE), Math.floor(l.doorY / TILE_SIZE));
  }

  // Woodland keeps its distance from the places you are meant to drive to —
  // except at the waterline, where it is not woodland but the cliff the shore
  // pass put there, and clearing it would open a landing.
  const atWater = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < W && ty < H && tiles[ty * W + tx] === T_WATER;
  for (const l of plan.landmarks) {
    const [x, y, w, h] = l.rect;
    for (let ty = Math.max(0, y - 3); ty < Math.min(H, y + h + 3); ty++) {
      for (let tx = Math.max(0, x - 3); tx < Math.min(W, x + w + 3); tx++) {
        if (tiles[ty * W + tx] !== T_TREES) continue;
        if (atWater(tx - 1, ty) || atWater(tx + 1, ty) || atWater(tx, ty - 1) || atWater(tx, ty + 1)) {
          continue;
        }
        tiles[ty * W + tx] = T_FIELD;
      }
    }
  }

  // A pocket of meadow the trees have sealed is absorbed into the wood.
  // The hedgerow and orchard passes (§14.3 D5) plant tree-lines through
  // country the wildness field has already made patchy, and where the two
  // conspire they pen in a few tiles of grass with no way to walk in —
  // ground the connectivity checker rightly calls orphaned. A clearing
  // nobody can reach is not a clearing; it is wood with a hole in the
  // canopy, so paint it as the wood it is.
  {
    const open = (t: number): boolean => t !== T_BUILDING && t !== T_WATER && t !== T_TREES;
    const seen = new Uint8Array(W * H);
    for (let s0 = 0; s0 < tiles.length; s0++) {
      if (seen[s0] === 1 || !open(tiles[s0] as number)) continue;
      const pocket: number[] = [s0];
      seen[s0] = 1;
      let plain = true; // nothing but field and park grass
      let landlocked = true; // no shore to moor at
      for (let q = 0; q < pocket.length; q++) {
        const i = pocket[q] as number;
        const t = tiles[i] as number;
        if (t !== T_FIELD && t !== T_PARK) plain = false;
        const x = i % W;
        const y = (i - x) / W;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (tiles[j] === T_WATER) landlocked = false;
          if (seen[j] === 1 || !open(tiles[j] as number)) continue;
          seen[j] = 1;
          pocket.push(j);
        }
      }
      if (pocket.length <= 20 && plain && landlocked) {
        for (const i of pocket) tiles[i] = T_TREES;
      }
    }
  }

  // The cliff, sealed last.
  //
  // Every pass between the shore and here can open one by accident — a
  // runway apron painted a tile too far, a lane cleared through the scrub, a
  // landmark's ground overwriting the rock it stands on — and a single
  // walkable tile at the waterline is the difference between an island you
  // fly to and an island you moor at. Stated once, at the end, as the
  // invariant it is.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (layout.sheer[i] !== 1) continue;
      const t = tiles[i] as number;
      if (t === T_BUILDING || t === T_TREES || t === T_WATER) continue;
      const wet =
        (tx + 1 < W && tiles[i + 1] === T_WATER) ||
        (tx > 0 && tiles[i - 1] === T_WATER) ||
        (ty + 1 < H && tiles[i + W] === T_WATER) ||
        (ty > 0 && tiles[i - W] === T_WATER);
      if (wet) tiles[i] = T_TREES;
    }
  }

  // The blend band (§14.3 D4). Every district channel — palette, stock,
  // props, peds — flips on the painted line, because everything reads the
  // district plane and the plane flips on one tile. Identity is allowed to
  // (the fabric seam is §13's product); intensity is not, so within a few
  // tiles of a one-rank neighbour, about a third of the buildings adopt
  // the district across the line — a commercial parade bleeding into
  // residential streets — and the plane is repainted under their
  // footprints, which hands the prop and ped passes the same dither for
  // free. The bearing plane is deliberately untouched: fabric stays sharp.
  {
    const DISTRICTS = DISTRICT_TYPES;
    const IDX: Record<string, number> = Object.fromEntries(DISTRICT_TYPES.map((d, i) => [d, i]));
    // One rung of §9.4's ladder: the pairs that shade into each other in a
    // real city. Parks and the countryside are two ranks from everything —
    // their seams get fronts and fringes (D5, D6), not dither.
    const LADDER: ReadonlyArray<readonly [string, string]> = [
      ['downtown', 'commercial'],
      ['commercial', 'residential'],
      ['industrial', 'residential'],
      ['industrial', 'commercial'],
    ];
    const rung = new Set(LADDER.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const BLEND_SEED = 0xb1e4d;
    const BAND = 5;
    for (const bld of buildings) {
      if (!(bld.district in IDX) || bld.district === 'park') continue;
      if (latticeHash(BLEND_SEED, bld.x, bld.y) >= 0.35) continue;
      const cx = Math.min(W - 1, Math.max(0, Math.floor(bld.x + bld.w / 2)));
      const cy = Math.min(H - 1, Math.max(0, Math.floor(bld.y + bld.h / 2)));
      // Nearest one-rank neighbour within the band, nearest ring first, so
      // a corner where three districts meet blends toward the closest.
      let adopt: string | null = null;
      for (let r = 1; r <= BAND && adopt === null; r++) {
        for (let dy = -r; dy <= r && adopt === null; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const other = DISTRICTS[layout.district[ny * W + nx] as number] as string;
            if (other !== bld.district && rung.has(`${bld.district}|${other}`)) {
              adopt = other;
              break;
            }
          }
        }
      }
      if (adopt === null) continue;
      bld.district = adopt as DistrictType;
      for (let ty = Math.max(0, bld.y); ty < Math.min(H, bld.y + bld.h); ty++) {
        for (let tx = Math.max(0, bld.x); tx < Math.min(W, bld.x + bld.w); tx++) {
          layout.district[ty * W + tx] = IDX[adopt] as number;
        }
      }
    }
  }

  // Quay the wet road edges (PLAN-WORLDGEN.md wave 2.4). §23.1 took road
  // running straight into water from 15 tiles to 9 by drowning whole decks;
  // what was left is corner slivers at bridge mouths and angled shores — a
  // road tile whose neighbour is open sea with no bank between. Each becomes
  // quay, which is what a carriageway meeting water IS, unless removing it
  // would sever the street network (checked by flood, not assumed) — a tile
  // that fails that check stays road and stays a checker finding. Before
  // `trimCourses`, so a course over a converted tile is trimmed with it.
  {
    const wet: number[] = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (tiles[y * W + x] !== T_ROAD) continue;
        const sea =
          tiles[y * W + x + 1] === T_WATER ||
          tiles[y * W + x - 1] === T_WATER ||
          tiles[(y + 1) * W + x] === T_WATER ||
          tiles[(y - 1) * W + x] === T_WATER;
        if (sea) wet.push(y * W + x);
      }
    }
    const network = (): number => {
      const seen = new Uint8Array(W * H);
      let components = 0;
      for (let start = 0; start < tiles.length; start++) {
        if (seen[start] === 1) continue;
        const t = tiles[start] as number;
        if (t !== T_ROAD && t !== T_BRIDGE) continue;
        components++;
        const stack = [start];
        seen[start] = 1;
        while (stack.length > 0) {
          const i = stack.pop() as number;
          const x = i % W;
          const y = (i - x) / W;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (seen[j] === 1) continue;
            const nt = tiles[j] as number;
            if (nt !== T_ROAD && nt !== T_BRIDGE) continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      return components;
    };
    const before = network();
    for (const i of wet) {
      tiles[i] = T_BANK;
      if (network() > before) tiles[i] = T_ROAD;
    }
  }

  const blocks: BlockRect[] = layout.blocks.map((b) => ({
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    district: b.district,
    density: b.density,
    ...(b.rural ? { rural: true } : {}),
  }));

  // Which way each building FACES (§20). Derived here, once, from the bearing
  // plane rather than at the eight places a building is created: the bearing
  // is exactly what a borough's fabric already recorded per tile, so every
  // filler that ever adds a building gets the answer for free.
  //
  // Read at the footprint's centre, and taken only where the whole footprint
  // agrees — a building straddling a seam between two boroughs at different
  // angles has no one street to face, and squaring it to the world is the
  // honest answer there.
  //
  // The bearing is FOLDED into (-45,45] before it is recorded: a rectangle
  // turned to face a street can front it with either of its own axes, and
  // taking the bearing raw turns elongated buildings across themselves for no
  // gain (§22.4). Then, and only then, the turn has to be affordable — the
  // mass keeps its aspect ratio and has to fit back inside its plot, and
  // `MIN_FACING_FIT` is where a shrinking mass stops being a facing and
  // starts being an invisible wall.
  for (const b of buildings) {
    const cx = Math.min(W - 1, Math.max(0, Math.floor(b.x + b.w / 2)));
    const cy = Math.min(H - 1, Math.max(0, Math.floor(b.y + b.h / 2)));
    const deg = layout.bearing[cy * W + cx] as number;
    if (deg === 0) continue;
    const face = facingAngle(deg);
    if (face === 0) continue;
    if (massFit(b.w, b.h, face) < MIN_FACING_FIT) continue;
    let agrees = true;
    for (let ty = b.y; ty < b.y + b.h && agrees; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if ((layout.bearing[ty * W + tx] as number) !== deg) {
          agrees = false;
          break;
        }
      }
    }
    if (agrees) b.angle = face;
  }

  const baked: BakedCity = {
    name: plan.name,
    widthTiles: W,
    heightTiles: H,
    tiles,
    district: layout.district,
    bearing: layout.bearing,
    // The coastline, plus every park pond cut since (§29). A pond belongs to
    // the park that contains it, so it cannot be cut with the coast — but it
    // is the same kind of thing, and joining the two here is what keeps ONE
    // answer to "where is the water" instead of two.
    shores: [...layout.shores, ...takePondRings()],
    // The coast band, plus every park pond's beach (§39). Same joining as
    // `shores` above, and for the same reason: one answer to where the shore
    // band ends, not two.
    banks: [...layout.banks, ...takePondBankRings()],
    blocks,
    buildings,
    landmarks,
    shops: [],
    // The roads, plus every park walk carved since (3.2). Joined here for
    // the same reason the ponds join the shores above: one answer to "what
    // curves does the ground carry", trimmed by one pass against the same
    // finished tiles — each kind against its own ground.
    courses: trimCourses(
      [
        ...layout.courses,
        ...takePathCourses().map((p): StreetCourse => ({ points: p.points, width: p.width, kind: 'path' })),
      ],
      tiles,
      W,
      H,
    ),
  };
  baked.shops = placeShopsFixed(baked, plan.shopQuota, plan.shopSpacingTiles, landmarkBuilt);
  return baked;
}

/**
 * A run has to be this many times its own carriageway width to be kept.
 *
 * The trim's original floor was a flat three tiles, from the wave where the
 * only courses were the ring and the long avenues — nothing short survived
 * anyway, so the number was never tested. The second wave brought 409
 * courses from every street family, and short survivors became common: 65 of
 * them under four tiles.
 *
 * A four-tile survivor is not a road. What it is, every time, is the piece of
 * some carved-away line that happened to cross a JUNCTION — and a junction is
 * road in all directions by construction, so every centreline sample lands on
 * carriageway and the run passes the trim. Painted, it is an isolated ribbon
 * lying across a square crossroads at whatever angle its parent line ran:
 * kerb casing, edge lines and centre dash included. `evidence/` has one at
 * tile (530, 206), 20° across a plain four-way.
 *
 * No local geometry tells that stub from a road. Perpendicular to it the road
 * runs three tiles either way, its ends carry on into more road, and its band
 * is fully covered — because it is inside a crossroads, where all of that is
 * true of any direction you pick. The one thing that distinguishes it is its
 * LENGTH: it is short enough to hide inside the junction it crosses. So the
 * floor is stated against the thing it has to outgrow. The widest crossing in
 * the city is two arterials (`ARTERIAL_WIDTH`, four tiles) meeting, about six
 * tiles across the kerbs and eight corner to corner; three times a course's
 * own width — nine tiles for a street, twelve for an avenue or the ring —
 * clears that with room, and is the same statement in the ribbon's own terms:
 * a stroke shorter than a few times its width reads as a blob, not a line.
 *
 * Dropping a run costs nothing but the smooth kerb on a stretch too short to
 * see it on. The tiles are untouched, so the road is still there and still
 * drivable, and `courseCover` lifts with the course it belonged to — the
 * per-tile lane markings come straight back underneath.
 */
const MIN_RUN_WIDTHS = 3;

/**
 * Keep only the stretches of each course that still run over its ground —
 * carriageway for a road, pavement for a park walk (3.2).
 *
 * The courses were recorded while carving, but a dozen passes have run
 * since — an unbridgeable strait left the road un-laid, a landmark took a
 * plot back — and a painted ribbon over ground that is not road any more
 * would be the renderer contradicting the map. Long segments are split to
 * trimming granularity first, every half tile of each is sampled against
 * the FINISHED tiles, and only unbroken runs survive; stubs too short to be
 * anything but a streak across a junction are dropped — see
 * `MIN_RUN_WIDTHS`.
 */
function trimCourses(
  courses: StreetCourse[],
  tiles: Uint8Array,
  W: number,
  H: number,
): StreetCourse[] {
  // Each kind against its own ground (3.2): a road course runs over
  // carriageway and its decks, a path course over the pavement the park
  // walk carved — a footpath sample on tarmac is as much of a lie as a
  // centre dash on grass.
  const onGround = (kind: StreetCourse['kind'], x: number, y: number): boolean => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const t = tiles[ty * W + tx] as number;
    if (kind === 'path') return t === T_SIDEWALK;
    return t === T_ROAD || t === T_BRIDGE;
  };
  const out: StreetCourse[] = [];
  // Quantised BEFORE sampling, to the same hundredth of a tile the encoder
  // ships: trimming the true line and shipping a rounded one let a point
  // within 0.005 of a tile boundary round across it, and the invariant
  // "every centreline sample is on carriageway" held for a polyline nobody
  // was ever given.
  const q = (v: number): number => Math.round(v * 100) / 100;
  for (const course of courses) {
    // Split to at most 4-tile segments so a break only costs its own piece.
    const pts: Array<readonly [number, number]> = [];
    for (let k = 0; k + 1 < course.points.length; k++) {
      const [ax, ay] = course.points[k] as readonly [number, number];
      const [bx, by] = course.points[k + 1] as readonly [number, number];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len / 4));
      for (let s = 0; s < n; s++) {
        pts.push([q(ax + ((bx - ax) * s) / n), q(ay + ((by - ay) * s) / n)]);
      }
    }
    if (course.points.length > 0) {
      const [lx, ly] = course.points[course.points.length - 1] as readonly [number, number];
      pts.push([q(lx), q(ly)]);
    }

    const minRun = Math.max(3, course.width * MIN_RUN_WIDTHS);
    let run: Array<readonly [number, number]> = [];
    let runLen = 0;
    const flush = (): void => {
      if (run.length >= 2 && runLen >= minRun) {
        out.push({ points: run, width: course.width, kind: course.kind });
      }
      run = [];
      runLen = 0;
    };
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k] as readonly [number, number];
      const [bx, by] = pts[k + 1] as readonly [number, number];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len * 2));
      let clear = true;
      for (let s = 0; s <= steps; s++) {
        if (!onGround(course.kind, ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps)) {
          clear = false;
          break;
        }
      }
      if (clear) {
        if (run.length === 0) run.push(pts[k] as never);
        run.push(pts[k + 1] as never);
        runLen += len;
      } else {
        flush();
      }
    }
    flush();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The wire form of the finished city.                                 */
/* ------------------------------------------------------------------ */

/**
 * Run-length encoding of a tile plane, base64'd.
 *
 * A city is a hundred and fifty thousand tiles and most of them are the same
 * as the one before — streets run, blocks are solid, the sea is the sea. Runs
 * take it to a few tens of kilobytes, which is small enough to sit in the
 * client bundle and be read by both hosts without a fetch.
 */
function encodePlane(plane: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < plane.length) {
    const v = plane[i] as number;
    let n = 1;
    while (i + n < plane.length && plane[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  return toBase64(out);
}

function decodePlane(text: string, length: number): Uint8Array {
  const bin = fromBase64(text);
  const plane = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const v = bin[i] as number;
    const n = bin[i + 1] as number;
    plane.fill(v, at, at + n);
    at += n;
  }
  if (at !== length) throw new Error(`city: encoded plane is ${at} tiles, expected ${length}`);
  return plane;
}

/**
 * Base64, written out rather than borrowed.
 *
 * `btoa`/`atob` are in both hosts and `Buffer` is in one of them, but shared/
 * is compiled with no DOM and no Node types on purpose — it is the package
 * both other packages import, and the day it depends on one host's globals is
 * the day the other one stops building. Sixteen lines is a cheaper price than
 * that.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >>> 18) & 63] as string;
    out += B64[(n >>> 12) & 63] as string;
    out += i + 1 < bytes.length ? (B64[(n >>> 6) & 63] as string) : '=';
    out += i + 2 < bytes.length ? (B64[n & 63] as string) : '=';
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('city: bad base64 in the baked map');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

export function encodeBakedCity(city: BakedCity): string {
  return JSON.stringify(
    {
      name: city.name,
      widthTiles: city.widthTiles,
      heightTiles: city.heightTiles,
      tiles: encodePlane(city.tiles),
      district: encodePlane(city.district),
      bearing: encodePlane(city.bearing),
      blocks: city.blocks,
      buildings: city.buildings,
      landmarks: city.landmarks,
      shops: city.shops,
      // Centrelines to the hundredth of a tile: a sixth of a world px,
      // invisible on screen and a third of the JSON of full doubles.
      courses: city.courses.map((c) => ({
        points: c.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
        width: c.width,
        kind: c.kind,
      })),
      // The waterline, to the same hundredth of a tile: a sixth of a world
      // pixel, well under the quarter-pixel the vertices are flattened at.
      shores: city.shores.map((r) => ({
        points: r.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
        land: r.land,
        area: Math.round(r.area),
      })),
      // And the band's inner edge, to the same hundredth of a tile.
      banks: city.banks.map((r) => ({
        points: r.points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
        land: r.land,
        area: Math.round(r.area),
      })),
    },
    null,
    0,
  );
}

/**
 * Refuse a malformed asset with the field named, instead of handing the sim
 * whatever a truncated or hand-mangled `city.data.ts` happens to decode to.
 *
 * The asymmetry this closes (wave 4.2): `plan.ts` validates the hand-edited
 * plan exhaustively, while the megabyte of GENERATED file that actually
 * becomes the game world was all blind casts — and the three "absent in a
 * pre-X bake" fallbacks it carried were dead, because there is one producer
 * and one committed consumer, both in this repository, both current. This
 * is a structural check, not a semantic one: shapes, lengths and ranges.
 * The semantic checks are `checkCity`'s job, and the shipped-city test runs
 * them over these same bytes.
 */
function must(cond: boolean, what: string): void {
  if (!cond) throw new Error(`city.data: ${what}`);
}

export function decodeBakedCity(raw: unknown): BakedCity {
  const r = raw as Record<string, unknown>;
  must(typeof r === 'object' && r !== null, 'not an object');
  const widthTiles = r['widthTiles'] as number;
  const heightTiles = r['heightTiles'] as number;
  must(Number.isInteger(widthTiles) && widthTiles > 0, 'widthTiles is not a positive integer');
  must(Number.isInteger(heightTiles) && heightTiles > 0, 'heightTiles is not a positive integer');
  must(typeof r['name'] === 'string', 'name is not a string');
  for (const plane of ['tiles', 'district', 'bearing'] as const) {
    must(typeof r[plane] === 'string', `${plane} plane is not an encoded string`);
  }
  for (const list of ['blocks', 'buildings', 'landmarks', 'shops', 'courses', 'shores', 'banks'] as const) {
    must(Array.isArray(r[list]), `${list} is not an array`);
  }
  const n = widthTiles * heightTiles;
  const tiles = decodePlane(r['tiles'] as string, n);
  const district = decodePlane(r['district'] as string, n);
  const bearing = decodePlane(r['bearing'] as string, n);
  for (const b of r['buildings'] as Building[]) {
    must(
      b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= widthTiles && b.y + b.h <= heightTiles,
      `building at ${b.x},${b.y} is outside the map`,
    );
  }
  for (const l of r['landmarks'] as Landmark[]) {
    must(
      l.x >= 0 && l.y >= 0 && l.x + l.w <= widthTiles && l.y + l.h <= heightTiles,
      `landmark ${l.name} is outside the map`,
    );
  }
  for (const c of r['courses'] as StreetCourse[]) {
    must(c.points.length >= 2 && c.width > 0, 'a course with no line or no width');
    must(
      c.kind === 'avenue' || c.kind === 'ring' || c.kind === 'street' || c.kind === 'path',
      'a course of unknown kind',
    );
  }
  return {
    name: r['name'] as string,
    widthTiles,
    heightTiles,
    tiles,
    district,
    bearing,
    blocks: r['blocks'] as BlockRect[],
    shores: r['shores'] as BakedCity['shores'],
    banks: r['banks'] as BakedCity['banks'],
    buildings: r['buildings'] as Building[],
    landmarks: r['landmarks'] as Landmark[],
    shops: r['shops'] as Shop[],
    courses: r['courses'] as StreetCourse[],
  };
}
