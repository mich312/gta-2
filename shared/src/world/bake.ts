import { deriveSeed, seedRng } from '../rng/prng.js';
import { findDoorway, placeShopsFixed } from './amenities.js';
import { fillBlock, fillRegion } from './buildings.js';
import { fbm, latticeHash } from './fields.js';
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
const WILD_SEED = 0x7009d5;

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
  parts: (w: number, h: number) => Array<[number, number, number, number]>;
}

const RECIPES: Record<LandmarkKind, Recipe> = {
  stadium: { ground: T_PARK, apron: T_PARK, parts: (w, h) => [[0, 0, w, h]] },
  power: {
    ground: T_LOT,
    apron: T_LOT,
    parts: (w, h) => [
      [0, 0, w, h - 3],
      [w - 4, h - 2, 3, 2],
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
  quarry: { ground: T_LOT, apron: T_LOT, parts: () => [[0, 0, 3, 3]] },
  // A long clear run and a hangar at one end: nothing else goes on it.
  airstrip: { ground: T_RUNWAY, apron: T_RUNWAY, parts: () => [[0, 0, 3, 3]] },
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
  if (dx < 0 || dy < 0 || dx >= W || dy >= H || near(dx, dy)) return;

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
      from[j] = i;
      era[j] = call;
      queue.push(j);
    }
  }
  if (hit < 0) return;
  for (let i = hit; i !== start; i = from[i] as number) {
    if (!onNetwork(tiles[i] as number)) tiles[i] = T_ROAD;
    // Two tiles wide, so it is a track and not a footpath.
    if (cuttable(tiles[i + 1] as number)) tiles[i + 1] = T_ROAD;
  }
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

  const ground = (x: number, y: number, w: number, h: number, tile: number): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) {
        const i = ty * W + tx;
        if (paintable(tiles[i] as number)) tiles[i] = tile;
      }
    }
  };
  const solid = (x: number, y: number, w: number, h: number, district: DistrictType): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) tiles[ty * W + tx] = T_BUILDING;
    }
    buildings.push({ x, y, w, h, district });
  };

  const stamp = (l: PlanLandmark): void => {
    const [x, y, w, h] = l.rect;
    const recipe = RECIPES[l.kind];
    const district = (['downtown', 'residential', 'industrial', 'commercial', 'park'] as const)[
      layout.district[y * W + x] as number
    ] as DistrictType;
    ground(x, y, w, h, recipe.ground);
    for (const [dx, dy, pw, ph] of recipe.parts(w, h)) {
      if (pw < 1 || ph < 1) continue;
      solid(x + dx, y + dy, pw, ph, district);
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
  const wildAt = (tx: number, ty: number): boolean => fbm(WILD_SEED, tx / 22, ty / 22) >= 0.52;
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
        if (paintable(tiles[ty * W + tx] as number)) tiles[ty * W + tx] = T_SIDEWALK;
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
    const DISTRICTS = ['downtown', 'residential', 'industrial', 'commercial', 'park'] as const;
    const IDX: Record<string, number> = { downtown: 0, residential: 1, industrial: 2, commercial: 3, park: 4 };
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

  const blocks: BlockRect[] = layout.blocks.map((b) => ({
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    district: b.district,
    density: b.density,
    ...(b.rural ? { rural: true } : {}),
  }));

  const baked: BakedCity = {
    name: plan.name,
    widthTiles: W,
    heightTiles: H,
    tiles,
    district: layout.district,
    bearing: layout.bearing,
    blocks,
    buildings,
    landmarks,
    shops: [],
    courses: trimCourses(layout.courses, tiles, W, H),
  };
  baked.shops = placeShopsFixed(baked, plan.shopQuota, plan.shopSpacingTiles);
  return baked;
}

/**
 * Keep only the stretches of each course that still run over carriageway.
 *
 * The courses were recorded while carving, but a dozen passes have run
 * since — an unbridgeable strait left the road un-laid, a landmark took a
 * plot back — and a painted ribbon over ground that is not road any more
 * would be the renderer contradicting the map. Long segments are split to
 * trimming granularity first, every half tile of each is sampled against
 * the FINISHED tiles, and only unbroken runs survive; stubs shorter than
 * three tiles are dropped rather than left as orphan streaks.
 */
function trimCourses(
  courses: StreetCourse[],
  tiles: Uint8Array,
  W: number,
  H: number,
): StreetCourse[] {
  const onCarriageway = (x: number, y: number): boolean => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const t = tiles[ty * W + tx] as number;
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

    let run: Array<readonly [number, number]> = [];
    let runLen = 0;
    const flush = (): void => {
      if (run.length >= 2 && runLen >= 3) {
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
        if (!onCarriageway(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps)) {
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
    },
    null,
    0,
  );
}

export function decodeBakedCity(raw: unknown): BakedCity {
  const r = raw as Record<string, unknown>;
  const widthTiles = r['widthTiles'] as number;
  const heightTiles = r['heightTiles'] as number;
  const n = widthTiles * heightTiles;
  return {
    name: r['name'] as string,
    widthTiles,
    heightTiles,
    tiles: decodePlane(r['tiles'] as string, n),
    district: decodePlane(r['district'] as string, n),
    // Absent in a pre-bearing bake: every street was on the screen axes.
    bearing: typeof r['bearing'] === 'string' ? decodePlane(r['bearing'] as string, n) : new Uint8Array(n),
    blocks: r['blocks'] as BlockRect[],
    buildings: r['buildings'] as Building[],
    landmarks: r['landmarks'] as Landmark[],
    shops: r['shops'] as Shop[],
    // Absent in a pre-course bake: every road was its tiles and nothing more.
    courses: (r['courses'] as StreetCourse[] | undefined) ?? [],
  };
}
