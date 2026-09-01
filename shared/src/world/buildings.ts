import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { latticeHash, valueNoise } from './fields.js';
import { facingAngle } from './heights.js';
import {
  coastRings,
  levelRings,
  rasteriseRings,
  sampleField,
  type CoastRing,
} from './geometry.js';
import { meanderPolyline, type PlanPoint } from './plan.js';
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
  type BlockRect,
  type Building,
} from './types.js';

/**
 * Rings cut by this pass that are WATER — park ponds (WORLDGEN.md §29).
 *
 * A pond is a boundary: you see it, and once there is swimming you enter it.
 * By VECTOR.md's rule that makes it a curve, and the wet tiles under it its
 * rasterisation — exactly like the coast. It could not be built with the
 * coast because a pond belongs to the park that contains it, and parks are
 * placed thousands of lines later; so it is collected here and drained into
 * `layout.shores` by the caller, where it joins the coastline as one more
 * ring the water tiles are a rasterisation OF.
 *
 * A module-level sink rather than a threaded return value because `fillBlock`
 * is called from two places through three layers of optional arguments, and
 * one more of those would be worse than this.
 */
const pondRings: CoastRing[] = [];

/**
 * And the outer edge of each pond's beach (§39): the same curve treatment for
 * the same reason, one level further out.
 *
 * A pond's sand used to be a four-neighbour ring round the wet tiles, which
 * is the exact defect §38 removed from the coast — a lattice band drawn
 * against a curved waterline. The shape was a continuous field all along, so
 * the beach is a second contour of it rather than a scan of its rasterisation.
 */
const pondBankRings: CoastRing[] = [];

/**
 * How far a park pond's beach runs back from its waterline, in tiles.
 *
 * A shade under the coast's `QUAY_REACH`, because a pond is a tenth of the
 * size of a bay and a beach in proportion to the sea would swallow it.
 */
const POND_BEACH = 1.4;

/**
 * The park walks carved since the last call, as the polylines they were
 * carved FROM (3.2): the tiles are the staircase, these are the curves, and
 * the bake ships them as `kind: 'path'` courses — §16's mechanism, second
 * consumer. Same sink pattern as the ponds above, for the same reason.
 */
const pathPolylines: Array<{ points: PlanPoint[]; width: number }> = [];

/** Take the walks carved since the last call. The bake drains this once. */
export function takePathCourses(): Array<{ points: PlanPoint[]; width: number }> {
  return pathPolylines.splice(0, pathPolylines.length);
}

/** Take the ponds cut since the last call. The bake drains this once. */
export function takePondRings(): CoastRing[] {
  return pondRings.splice(0, pondRings.length);
}

/** Take the pond beaches cut since the last call, for `banks`. */
export function takePondBankRings(): CoastRing[] {
  return pondBankRings.splice(0, pondBankRings.length);
}

export interface Ctx {
  tiles: Uint8Array;
  W: number;
  H: number;
  buildings: Building[];
  /**
   * Which tiles the current block may touch, if it is not its whole rect.
   *
   * A block's record is its bounding box, but a block an avenue cut in two —
   * or any block a future street fabric leaves non-rectangular (WORLDGEN.md
   * §13) — is only SOME of that box, and its neighbour across the road owns
   * the rest. Absent means the whole box, which is what every block was
   * before the avenues crossed them.
   */
  within?: (tx: number, ty: number) => boolean;
}

/**
 * Ground no block interior may be laid over: the waterfront, and the roads.
 *
 * The waterfront guard is the old one — offices out of the bay and off the
 * shore. Roads joined it when blocks stopped being the output of a recursive
 * carve and became the rectangles BETWEEN authored streets: an avenue drawn
 * straight through a borough now crosses block rectangles rather than
 * defining their edges, and without this a warehouse would be built over
 * four lanes of Vasco Avenue.
 */
function blocked(ctx: Ctx, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= ctx.W || ty >= ctx.H) return false;
  // Ground beyond the block's own mask is another block's ground, however it
  // sits inside this one's bounding box: not paintable, and (through
  // rectHasWater) not buildable-over either.
  if (ctx.within !== undefined && !ctx.within(tx, ty)) return true;
  const t = ctx.tiles[ty * ctx.W + tx];
  return (
    t === T_WATER ||
    t === T_BANK ||
    t === T_SAND ||
    t === T_ROAD ||
    t === T_BRIDGE ||
    t === T_RUNWAY ||
    // Anything already built. Boroughs are polygons that abut, so their
    // lattices produce blocks that overlap along the seam; without this, one
    // block's park pond gets carved through the terrace the block next door
    // has already put up, and the Building record then claims tiles that are
    // open water. Overlapping footprints are simply not placed.
    t === T_BUILDING
  );
}

function fill(ctx: Ctx, x: number, y: number, w: number, h: number, t: number): void {
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) {
      if (tx < 0 || ty < 0 || tx >= ctx.W || ty >= ctx.H) continue;
      if (blocked(ctx, tx, ty)) continue;
      ctx.tiles[ty * ctx.W + tx] = t;
    }
  }
}

/**
 * True if any tile of this footprint is ground a building may not stand on.
 *
 * `fill` already refuses to paint over it, but the Building RECORD is what
 * shop doorways and collision are derived from — so a footprint straddling
 * the waterfront would paint correctly and still put a gun shop door in the
 * water. Footprints that touch it are not placed at all.
 */
function rectHasWater(ctx: Ctx, x: number, y: number, w: number, h: number): boolean {
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) {
      if (blocked(ctx, tx, ty)) return true;
    }
  }
  return false;
}

function isWater(ctx: Ctx, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= ctx.W || ty >= ctx.H) return false;
  return ctx.tiles[ty * ctx.W + tx] === T_WATER;
}

function isRoad(ctx: Ctx, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= ctx.W || ty >= ctx.H) return false;
  return ctx.tiles[ty * ctx.W + tx] === T_ROAD;
}

/**
 * Sidewalk: every tile of the block that touches a road.
 *
 * It used to be the block's PERIMETER tiles that touch a road, which was the
 * same set back when a block was, by construction, a rectangle with roads on
 * all four sides and none through it. Authored avenues cross blocks, so the
 * kerb has to follow the road wherever it runs — otherwise the pavement stops
 * dead where an avenue enters a block, and with it the crowd, the props, the
 * payphones and the kerbside parking, all of which filter on sidewalk.
 */
export function laySidewalk(ctx: Ctx, b: BlockRect): void {
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      if (tx < 0 || ty < 0 || tx >= ctx.W || ty >= ctx.H) continue;
      if (ctx.within !== undefined && !ctx.within(tx, ty)) continue;
      const here = ctx.tiles[ty * ctx.W + tx];
      // Only bare ground becomes kerb: no pavement over a river, a quay, a
      // beach, or the carriageway itself.
      if (here !== T_FIELD) continue;
      if (
        isRoad(ctx, tx - 1, ty) ||
        isRoad(ctx, tx + 1, ty) ||
        isRoad(ctx, tx, ty - 1) ||
        isRoad(ctx, tx, ty + 1)
      ) {
        ctx.tiles[ty * ctx.W + tx] = T_SIDEWALK;
      }
    }
  }
}

/** The context `laySidewalk` and `fillBlock` share; exported for the baker. */
export function blockCtx(
  tiles: Uint8Array,
  W: number,
  H: number,
  buildings: Building[],
): Ctx {
  return { tiles, W, H, buildings };
}

/** Recursively split a rect into building-sized chunks (downtown/commercial). */
function packRect(
  ctx: Ctx,
  b: BlockRect,
  x: number,
  y: number,
  w: number,
  h: number,
  maxSize: number,
  plazaChance: number,
  rng: number,
): number {
  if (w < 3 || h < 3) return rng;
  if (w <= maxSize && h <= maxSize) {
    let roll: number;
    [roll, rng] = nextFloat01(rng);
    if (roll >= plazaChance && !rectHasWater(ctx, x, y, w, h)) {
      fill(ctx, x, y, w, h, T_BUILDING);
      ctx.buildings.push({ x, y, w, h, district: b.district });
    }
    return rng;
  }
  if (w >= h) {
    let cut: number;
    [cut, rng] = nextIntRange(rng, 3, Math.max(4, w - 2));
    rng = packRect(ctx, b, x, y, cut, h, maxSize, plazaChance, rng);
    rng = packRect(ctx, b, x + cut + 1, y, w - cut - 1, h, maxSize, plazaChance, rng);
  } else {
    let cut: number;
    [cut, rng] = nextIntRange(rng, 3, Math.max(4, h - 2));
    rng = packRect(ctx, b, x, y, w, cut, maxSize, plazaChance, rng);
    rng = packRect(ctx, b, x, y + cut + 1, w, h - cut - 1, maxSize, plazaChance, rng);
  }
  return rng;
}

/**
 * The countryside's two PLANTED patterns, as predicates on the ground alone.
 *
 * Both used to live inside `fillBlock`'s rural branch, which walks blocks —
 * so rural country that no block covers never got either of them, and a hedge
 * run reaching the edge of a block stopped dead on a line nothing draws. The
 * bake's blockless-country pass asks them again out there (`bake.ts`), and
 * they are predicates here rather than two copies of a rule so that the two
 * callers cannot drift apart: a hedge planted by one and not the other is the
 * seam this exists to remove.
 *
 * Neither reads the block, so neither needs one. Both read the ground as it
 * stands, so the caller decides when to ask.
 */
const HEDGE_SEED = 0x5eed9e;
const ORCHARD_SEED = 0x0bc4a2d;

/**
 * Hedgerows (§14.3 D5). The countryside's cheap trick with outsized reach:
 * every lane carries an intermittent tree-line one verge back from its edge,
 * so country reads as a FIELD with a boundary instead of open felt. One tile
 * of verge keeps every lane drivable at full width (the same rule the
 * woodland clearing enforces), and the hash gaps are gates in the chokepoint
 * sense — a hedge you must find the gap in is countryside gameplay. The hash
 * is keyed on the world grid, not the block, so a run crosses block corners
 * unbroken. A hedge never stands against a building (that is a smallholding's
 * yard) and never beside another hedge's corner — two runs meeting at a bend
 * would seal the verge pocket between themselves and the lane.
 */
export function hedgerowAt(tiles: Uint8Array, W: number, H: number, tx: number, ty: number): boolean {
  if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
  if (tiles[ty * W + tx] !== T_FIELD) return false;
  const ctx: Ctx = { tiles, W, H, buildings: [] };
  const nearRoad4 = (x: number, y: number): boolean =>
    isRoad(ctx, x - 1, y) || isRoad(ctx, x + 1, y) || isRoad(ctx, x, y - 1) || isRoad(ctx, x, y + 1);
  const onShore4 = (x: number, y: number): boolean =>
    isWater(ctx, x - 1, y) || isWater(ctx, x + 1, y) || isWater(ctx, x, y - 1) || isWater(ctx, x, y + 1);
  if (nearRoad4(tx, ty) || onShore4(tx, ty)) return false;
  // One verge off the lane: a neighbour touches the road, this tile does not.
  const secondRow =
    nearRoad4(tx - 1, ty) || nearRoad4(tx + 1, ty) || nearRoad4(tx, ty - 1) || nearRoad4(tx, ty + 1);
  if (!secondRow) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (tiles[(ty + dy) * W + tx + dx] === T_BUILDING) return false;
    }
  }
  // Roads on two perpendicular sides mean a junction corner: a hedge bending
  // round it would pen the corner verge in with the lane.
  const roadNS =
    isRoad(ctx, tx, ty - 1) || isRoad(ctx, tx, ty - 2) || isRoad(ctx, tx, ty + 1) || isRoad(ctx, tx, ty + 2);
  const roadEW =
    isRoad(ctx, tx - 1, ty) || isRoad(ctx, tx - 2, ty) || isRoad(ctx, tx + 1, ty) || isRoad(ctx, tx + 2, ty);
  if (roadNS && roadEW) return false;
  return latticeHash(HEDGE_SEED, tx >> 2, ty >> 2) < 0.68;
}

/**
 * Orchard rows: hash-chosen 16-tile cells carry trees on a planted grid —
 * every third column, every other row — which is what makes them read as rows
 * rather than woodland. The caller supplies the fringe test (§14.3 D5): this
 * pattern belongs to the band within one rural pitch of town, not to the open
 * country behind it.
 */
export function orchardRowAt(tiles: Uint8Array, W: number, H: number, tx: number, ty: number): boolean {
  if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
  if (tiles[ty * W + tx] !== T_FIELD) return false;
  const ctx: Ctx = { tiles, W, H, buildings: [] };
  const nearRoad4 =
    isRoad(ctx, tx - 1, ty) || isRoad(ctx, tx + 1, ty) || isRoad(ctx, tx, ty - 1) || isRoad(ctx, tx, ty + 1);
  const onShore4 =
    isWater(ctx, tx - 1, ty) || isWater(ctx, tx + 1, ty) || isWater(ctx, tx, ty - 1) || isWater(ctx, tx, ty + 1);
  if (nearRoad4 || onShore4) return false;
  return latticeHash(ORCHARD_SEED, tx >> 4, ty >> 4) < 0.35 && tx % 3 === 0 && ty % 2 === 0;
}

/**
 * Fill one block: sidewalk ring, then district-specific building layout.
 * The visual identity of each district lives here — downtown packs solid,
 * residential rows leave yards, industrial is big slabs on open lots,
 * parks stay green — and the countryside is meadow with forest where the
 * wildness field says so.
 */
export function fillBlock(
  tiles: Uint8Array,
  W: number,
  H: number,
  buildings: Building[],
  b: BlockRect,
  rng: number,
  /** Forest predicate (window-LOCAL tiles); only rural blocks consult it. */
  wildAt?: (tx: number, ty: number) => boolean,
  /** The block's mask, when it is not its whole rect. See `Ctx.within`. */
  within?: (tx: number, ty: number) => boolean,
  /** The rural fringe (§14.3 D5): country ground within a pitch of town. */
  fringeAt?: (tx: number, ty: number) => boolean,
): number {
  const ctx: Ctx = { tiles, W, H, buildings, within };

  if (b.rural) {
    // Open country: no kerbs (which is what silences the crowd, the
    // props, the payphones and the kerbside cars out here — they all
    // filter on sidewalk), meadow underfoot, forest where the wildness
    // field says forest — except within one tile of a carved lane, so
    // every lane stays drivable at full width.
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (within !== undefined && !within(tx, ty)) continue;
        const here = tiles[ty * W + tx];
        if (here !== T_FIELD) continue; // water, bank, sand, roads stay
        tiles[ty * W + tx] = wildAt?.(tx, ty) ? T_TREES : T_FIELD;
      }
    }
    for (let ty = Math.max(0, b.y); ty < Math.min(H, b.y + b.h); ty++) {
      for (let tx = Math.max(0, b.x); tx < Math.min(W, b.x + b.w); tx++) {
        if (tiles[ty * W + tx] !== T_TREES) continue;
        // Woodland at the waterline is not woodland, it is the cliff the
        // shore pass put there. Clearing it for a lane would open a landing
        // on a coast the plan says has none.
        const onShore =
          isWater(ctx, tx - 1, ty) ||
          isWater(ctx, tx + 1, ty) ||
          isWater(ctx, tx, ty - 1) ||
          isWater(ctx, tx, ty + 1);
        if (onShore) continue;
        const nearRoad =
          isRoad(ctx, tx - 1, ty) ||
          isRoad(ctx, tx + 1, ty) ||
          isRoad(ctx, tx, ty - 1) ||
          isRoad(ctx, tx, ty + 1);
        if (nearRoad) tiles[ty * W + tx] = T_FIELD;
      }
    }

    const onShore4 = (tx: number, ty: number): boolean =>
      isWater(ctx, tx - 1, ty) ||
      isWater(ctx, tx + 1, ty) ||
      isWater(ctx, tx, ty - 1) ||
      isWater(ctx, tx, ty + 1);

    // The rural fringe (§14.3 D5): the band of country within one pitch of
    // town is not empty meadow — it is where the suburb frays out into
    // smallholdings and orchard rows, the missing rung of §9.4's ladder
    // between "suburb" and "nothing". Holdings go down FIRST: the hedges
    // below line every lane, and a yard tested after them would always
    // find a tree where its gate should be.
    if (fringeAt !== undefined) {
      // Smallholdings: a house and its yard, stood by a lane, a few to the
      // whole fringe rather than a few to the block. The anchor grid is
      // world-keyed like the hedges so density does not depend on how the
      // block boundaries happened to fall.
      const HOLDING_SEED = 0x40151e5;
      const roadNear2 = (tx: number, ty: number): boolean => {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (isRoad(ctx, tx + dx, ty + dy)) return true;
          }
        }
        return false;
      };
      for (let cy = b.y >> 4; cy <= (b.y + b.h) >> 4; cy++) {
        for (let cx = b.x >> 4; cx <= (b.x + b.w) >> 4; cx++) {
          const roll = latticeHash(HOLDING_SEED, cx, cy);
          if (roll >= 0.5) continue;
          const hw = 4;
          const hh = 3;
          // A handful of jittered candidate anchors per accepted cell: the
          // rural blocks are lane-cut scraps of every shape, and one blind
          // dart per cell mostly misses them.
          for (let t = 0; t < 6; t++) {
            const ax = (cx << 4) + 1 + Math.floor(latticeHash(HOLDING_SEED + 1 + t, cx, cy) * 12);
            const ay = (cy << 4) + 1 + Math.floor(latticeHash(HOLDING_SEED + 7 + t, cx, cy) * 12);
            if (ax < b.x || ay < b.y || ax + hw > b.x + b.w || ay + hh > b.y + b.h) continue;
            if (!fringeAt(ax, ay) || !fringeAt(ax + hw - 1, ay + hh - 1)) continue;
            // The whole footprint plus a one-tile yard must be this
            // block's own ground — field or clearable woodland, never
            // water or somebody's road — and the yard must stand within
            // reach of a lane: a farmhouse nobody can drive to is bake
            // debt.
            let clear = true;
            let laneSide = false;
            for (let ty = ay - 1; ty <= ay + hh && clear; ty++) {
              for (let tx = ax - 1; tx <= ax + hw && clear; tx++) {
                if (tx < 0 || ty < 0 || tx >= W || ty >= H) {
                  clear = false;
                  break;
                }
                const t2 = tiles[ty * W + tx];
                if (within !== undefined && !within(tx, ty)) clear = false;
                else if (t2 !== T_FIELD && t2 !== T_TREES) clear = false;
                else if (onShore4(tx, ty)) clear = false;
                else if (roadNear2(tx, ty)) laneSide = true;
              }
            }
            if (!clear || !laneSide) continue;
            // The yard is cleared ground: a smallholding is a clearing
            // with a house in it, not a house in a wood.
            for (let ty = ay - 1; ty <= ay + hh; ty++) {
              for (let tx = ax - 1; tx <= ax + hw; tx++) {
                if (tiles[ty * W + tx] === T_TREES) tiles[ty * W + tx] = T_FIELD;
              }
            }
            fill(ctx, ax, ay, hw, hh, T_BUILDING);
            buildings.push({ x: ax, y: ay, w: hw, h: hh, district: 'residential' });
            break;
          }
        }
      }
      for (let ty = Math.max(1, b.y); ty < Math.min(H - 1, b.y + b.h); ty++) {
        for (let tx = Math.max(1, b.x); tx < Math.min(W - 1, b.x + b.w); tx++) {
          if (within !== undefined && !within(tx, ty)) continue;
          if (!fringeAt(tx, ty)) continue;
          if (orchardRowAt(tiles, W, H, tx, ty)) tiles[ty * W + tx] = T_TREES;
        }
      }
    }

    // Hedgerows (§14.3 D5), one verge back from every lane. The rule itself
    // is `hedgerowAt` above, so the bake's blockless-country pass plants the
    // same run on the other side of a block edge.
    for (let ty = Math.max(1, b.y); ty < Math.min(H - 1, b.y + b.h); ty++) {
      for (let tx = Math.max(1, b.x); tx < Math.min(W - 1, b.x + b.w); tx++) {
        if (within !== undefined && !within(tx, ty)) continue;
        if (hedgerowAt(tiles, W, H, tx, ty)) tiles[ty * W + tx] = T_TREES;
      }
    }
    return rng;
  }

  laySidewalk(ctx, b);
  let ix = b.x + 1;
  let iy = b.y + 1;
  let iw = b.w - 2;
  let ih = b.h - 2;
  // Trim carved bands off the interior's edges (wave 2.2). An authored
  // arterial crossing a block near its edge leaves interior rows of
  // carriageway plus the sidewalk belt it grew, and `frontage`'s solid
  // branch stamps units the full interior height — so every unit spanned
  // the band, every placement refused, and fifteen whole blocks of
  // Sunridge baked as bare field behind the ring road. An edge is trimmed
  // while a third or more of it is carriageway or pavement: a crossing
  // band trims away, a lone alley mouth or driveway does not.
  {
    const share = (x0: number, y0: number, w: number, h: number): number => {
      let n = 0;
      for (let ty = y0; ty < y0 + h; ty++) {
        for (let tx = x0; tx < x0 + w; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          const t = tiles[ty * W + tx];
          if (t === T_ROAD || t === T_BRIDGE || t === T_SIDEWALK) n++;
        }
      }
      return n / Math.max(1, w * h);
    };
    while (ih >= 3 && share(ix, iy, iw, 1) >= 0.3) {
      iy++;
      ih--;
    }
    while (ih >= 3 && share(ix, iy + ih - 1, iw, 1) >= 0.3) ih--;
    while (iw >= 3 && share(ix, iy, 1, ih) >= 0.3) {
      ix++;
      iw--;
    }
    while (iw >= 3 && share(ix + iw - 1, iy, 1, ih) >= 0.3) iw--;
  }
  if (iw < 2 || ih < 2) return rng;
  const density = b.density ?? 0.5;

  switch (b.district) {
    case 'downtown':
      rng = frontage(ctx, b, ix, iy, iw, ih, 6, 0.05 * (1 - density), T_LOT, rng);
      break;
    case 'commercial':
      rng = frontage(ctx, b, ix, iy, iw, ih, 5, 0.10 * (1 - density), T_LOT, rng);
      break;
    case 'residential':
      rng = frontage(ctx, b, ix, iy, iw, ih, 4, 0.22 * (1 - density), T_PARK, rng);
      break;
    case 'industrial': {
      fill(ctx, ix, iy, iw, ih, T_LOT);
      // Big sheds on an open yard: the shape of the district is the SPACE
      // between them, so they are few and large rather than many and small.
      let slabs: number;
      [slabs, rng] = nextIntRange(rng, 2, 4);
      for (let i = 0; i < slabs; i++) {
        const lane = Math.floor(iw / slabs);
        const maxW = Math.max(4, lane - 2);
        const maxH = Math.max(4, ih - 3);
        let w: number;
        let h: number;
        [w, rng] = nextIntRange(rng, Math.min(6, maxW), maxW + 1);
        [h, rng] = nextIntRange(rng, Math.min(6, maxH), maxH + 1);
        const x = ix + i * lane + 1;
        let yOff: number;
        [yOff, rng] = nextIntRange(rng, 0, Math.max(1, ih - h));
        const y = iy + yOff;
        const cw = Math.min(w, ix + iw - x);
        if (cw >= 4 && h >= 4 && !rectHasWater(ctx, x, y, cw, h)) {
          fill(ctx, x, y, cw, h, T_BUILDING);
          buildings.push({ x, y, w: cw, h, district: b.district });
        }
      }
      break;
    }
    case 'park': {
      fill(ctx, ix, iy, iw, ih, T_PARK);
      // A big park gets a real interior (§13.6 step 8): gates, a meandering
      // path network, a pond with a warped shore, woodland clumps, a
      // bandstand. Anything smaller keeps the modest cross-paths below.
      if (iw * ih >= 1200) {
        rng = fillPark(ctx, b, rng, wildAt);
        break;
      }
      // A park was an empty green rectangle. Paths across it, a pond in a
      // big one and a bandstand in the middle give it something to be, and
      // give the props pass edges to hang benches and fences off. A park in
      // a chase should be a shortcut with a cost, not a gap.
      if (iw >= 7 && ih >= 7) {
        const midY = iy + Math.floor(ih / 2);
        const midX = ix + Math.floor(iw / 2);
        let which: number;
        [which, rng] = nextIntRange(rng, 0, 3);
        if (which !== 1) fill(ctx, ix, midY, iw, 1, T_SIDEWALK);
        if (which !== 0) fill(ctx, midX, iy, 1, ih, T_SIDEWALK);
        // A diagonal desire line: the shortcut people actually walk.
        const steps = Math.min(iw, ih) - 2;
        for (let k = 0; k < steps; k++) {
          const px = ix + 1 + Math.floor((k * (iw - 2)) / Math.max(1, steps - 1));
          const py = iy + 1 + Math.floor((k * (ih - 2)) / Math.max(1, steps - 1));
          if (tiles[py * W + px] === T_PARK) tiles[py * W + px] = T_SIDEWALK;
        }
      }
      if (iw >= 14 && ih >= 14) {
        let pw: number;
        let ph: number;
        [pw, rng] = nextIntRange(rng, 4, Math.min(9, iw - 6));
        [ph, rng] = nextIntRange(rng, 4, Math.min(9, ih - 6));
        // The pond wants a margin of park all the way round, tested on the
        // ground rather than trusted to the box. A block used to BE its box,
        // so "two tiles in from the edge" was margin enough; a block that is
        // a curved sliver along a road (a motorway median through a park has
        // a park-sized box) would put open water at the kerb, and a street
        // may not end in the sea — least of all in the middle of a park.
        if (!rectHasWater(ctx, ix + 1, iy + 1, pw + 2, ph + 2)) {
          fill(ctx, ix + 2, iy + 2, pw, ph, T_WATER);
        }
        // A bandstand: something to navigate by inside the green. The same
        // margin test, for the same reason — not on a road shoulder.
        const bx = ix + iw - 5;
        const by = iy + ih - 5;
        if (!rectHasWater(ctx, bx - 1, by - 1, 5, 5)) {
          fill(ctx, bx, by, 3, 3, T_BUILDING);
          buildings.push({ x: bx, y: by, w: 3, h: 3, district: b.district });
        }
      }
      break;
    }
  }
  return rng;
}

/**
 * The interior of a big park (§13.6 step 8): gates where the streets touch
 * it, a network of meandering paths between them, a pond with a warped
 * shore, woodland clumps off the paths, and a bandstand to navigate by.
 *
 * Everything reuses machinery the geography already paid for — the paths
 * are `meanderPolyline` like the rivers, the pond's shore is value noise
 * like the coast's warp, the woodland is the same field the countryside
 * grows from. A park in a chase should be a shortcut with a cost: paths are
 * fast and watched, the woods are cover that slows a car to a crawl, and
 * the pond is the wall you forgot was there.
 */
function fillPark(
  ctx: Ctx,
  b: BlockRect,
  rng: number,
  wildAt?: (tx: number, ty: number) => boolean,
): number {
  const { W, H, tiles } = ctx;
  const inBlock = (tx: number, ty: number): boolean =>
    tx >= b.x &&
    ty >= b.y &&
    tx < b.x + b.w &&
    ty < b.y + b.h &&
    !(ctx.within !== undefined && !ctx.within(tx, ty));
  const parkAt = (tx: number, ty: number): boolean =>
    inBlock(tx, ty) && tiles[ty * W + tx] === T_PARK;

  // The gates: kerb tiles on the park's own edge, thinned so consecutive
  // gates are a walk apart, ordered by angle round the middle so the path
  // ring visits them the way a stroller would.
  const kerbs: Array<[number, number]> = [];
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      if (!inBlock(tx, ty)) continue;
      if (tiles[ty * W + tx] !== T_SIDEWALK) continue;
      kerbs.push([tx, ty]);
    }
  }
  if (kerbs.length === 0) return rng;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  kerbs.sort(
    (p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx),
  );
  const gates: Array<[number, number]> = [];
  for (const k of kerbs) {
    if (gates.every((g) => Math.hypot(g[0] - k[0], g[1] - k[1]) >= 22)) gates.push(k);
  }
  if (gates.length < 2) return rng;

  /** A 2-wide walk carved over park grass only: never through the trees the
   *  clump pass has not planted yet, never over water, never over a street. */
  const path = (from: [number, number], to: [number, number], salt: number): void => {
    const course = meanderPolyline(
      [from as PlanPoint, to as PlanPoint],
      deriveParkSeed(b, salt),
      Math.min(8, Math.hypot(to[0] - from[0], to[1] - from[1]) / 5),
      3,
      latticeHash,
    );
    // The curve, kept (3.2): the loop below rasterises it and used to throw
    // it away, leaving the renderer only the staircase. Two wide, like the
    // carve. `trimCourses` holds it to the pavement it actually took — the
    // stretches `parkAt` refused (a bulge past the park's edge, a clipped
    // corner) are trimmed against the finished tiles like any road's.
    pathPolylines.push({ points: course, width: 2 });
    for (let k = 0; k + 1 < course.length; k++) {
      const [ax, ay] = course[k] as PlanPoint;
      const [bx, by] = course[k + 1] as PlanPoint;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      for (let s = 0; s <= len; s += 0.6) {
        const px = ax + ((bx - ax) * s) / len;
        const py = ay + ((by - ay) * s) / len;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const tx = Math.round(px + ox * 0.5);
            const ty = Math.round(py + oy * 0.5);
            if (parkAt(tx, ty) && Math.hypot(tx + 0.5 - px, ty + 0.5 - py) < 1.1) {
              tiles[ty * W + tx] = T_SIDEWALK;
            }
          }
        }
      }
    }
  };
  // The ring of walks gate to gate, and one long diagonal — the desire line.
  for (let i = 0; i < gates.length; i++) {
    path(gates[i] as [number, number], gates[(i + 1) % gates.length] as [number, number], i);
  }
  if (gates.length >= 4) {
    path(gates[0] as [number, number], gates[Math.floor(gates.length / 2)] as [number, number], 99);
  }

  // The pond: a disc with a noise-warped shore, somewhere deep in the green
  // and clear of every path — open water may not touch a street, in a park
  // least of all.
  let ponds = 0;
  for (let attempt = 0; attempt < 24 && ponds < 2; attempt++) {
    let px: number;
    let py: number;
    let pr: number;
    [px, rng] = nextIntRange(rng, b.x + 8, b.x + b.w - 8);
    [py, rng] = nextIntRange(rng, b.y + 8, b.y + b.h - 8);
    [pr, rng] = nextIntRange(rng, 4, 8);
    let clear = true;
    for (let ty = py - pr - 2; ty <= py + pr + 2 && clear; ty++) {
      for (let tx = px - pr - 2; tx <= px + pr + 2 && clear; tx++) {
        if (Math.hypot(tx - px, ty - py) > pr + 2) continue;
        clear = parkAt(tx, ty);
      }
    }
    if (!clear) continue;
    // The pond's edge, as a curve (§29). The shape was always a continuous
    // field — a warped disc — and testing it per tile threw the curve away
    // exactly as the coast used to. Contour it instead, keep the ring, and
    // let the wet tiles be its rasterisation, so the painters shade a pond
    // against the same kind of line they shade the sea against.
    const pad = pr + 3;
    const ox = px - pad;
    const oy = py - pad;
    const span = pad * 2;
    const pondLand = (lx: number, ly: number): number => {
      const wx = ox + lx;
      const wy = oy + ly;
      const warp = (valueNoise(deriveParkSeed(b, 7), wx / 5, wy / 5) - 0.5) * 3;
      return Math.hypot(wx - px, wy - py) - (pr - 1 + warp);
    };
    const local = coastRings(sampleField(pondLand, span, span, 0.5), 4);
    const wet = local.filter((r) => !r.land);
    if (wet.length === 0) continue;
    for (const r of wet) {
      const world = r.points.map(([lx, ly]) => [lx + ox, ly + oy] as readonly [number, number]);
      pondRings.push({ points: world, land: false, area: r.area });
    }
    const pondMask = rasteriseRings(
      wet.map((r) => r.points),
      span,
      span,
    );
    for (let ly = 0; ly < span; ly++) {
      for (let lx = 0; lx < span; lx++) {
        // The ring encloses the pond, and `rasteriseRings` fills what a ring
        // encloses — so a set cell is water here, not land.
        if (pondMask[ly * span + lx] !== 1) continue;
        const tx = ox + lx;
        const ty = oy + ly;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        tiles[ty * W + tx] = T_WATER;
      }
    }
    // A pond has a shore: the grass never meets the water flush. Sand is
    // the city's standing rule for where land is allowed to touch water
    // (`water.test`'s quay invariant), and a small beach is also simply
    // what a park pond has.
    //
    // Its OUTER edge is a curve too (§39), and by the cheapest possible
    // route: the pond's shape is already a field, so the beach is the same
    // field contoured `POND_BEACH` further out. This used to be a
    // four-neighbour scan of the wet tiles — the same lattice band against a
    // curved waterline that §38 took off the coast, in miniature.
    const beach = levelRings(
      sampleField((lx, ly) => pondLand(lx, ly) - POND_BEACH, span, span, 0.5),
      4,
    ).filter((r) => !r.land);
    for (const r of beach) {
      pondBankRings.push({
        points: r.points.map(([lx, ly]) => [lx + ox, ly + oy] as readonly [number, number]),
        land: false,
        area: r.area,
      });
    }
    const beachMask = rasteriseRings(
      beach.map((r) => r.points),
      span,
      span,
    );
    for (let ly = 0; ly < span; ly++) {
      for (let lx = 0; lx < span; lx++) {
        // Enclosed by the beach ring and not the pond itself: the sand.
        if (beachMask[ly * span + lx] !== 1) continue;
        const tx = ox + lx;
        const ty = oy + ly;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (tiles[ty * W + tx] === T_WATER) continue;
        if (!parkAt(tx, ty)) continue;
        tiles[ty * W + tx] = T_SAND;
      }
    }
    ponds++;
  }

  // The bandstand: a small solid deep inside, clear of paths and water.
  for (let attempt = 0; attempt < 16; attempt++) {
    let bx: number;
    let by: number;
    [bx, rng] = nextIntRange(rng, b.x + 6, b.x + b.w - 9);
    [by, rng] = nextIntRange(rng, b.y + 6, b.y + b.h - 9);
    let clear = true;
    for (let ty = by - 1; ty <= by + 3 && clear; ty++) {
      for (let tx = bx - 1; tx <= bx + 3 && clear; tx++) clear = parkAt(tx, ty);
    }
    if (!clear) continue;
    fill(ctx, bx, by, 3, 3, T_BUILDING);
    ctx.buildings.push({ x: bx, y: by, w: 3, h: 3, district: b.district });
    break;
  }

  // Woodland clumps, off the paths and back from the water: cover with a
  // cost, not a fence. The same wildness field the countryside grows from,
  // thresholded a little looser because a park is planted, not wild.
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      if (!parkAt(tx, ty)) continue;
      if (!wildAt?.(tx, ty)) continue;
      let back = true;
      for (let oy = -2; oy <= 2 && back; oy++) {
        for (let ox = -2; ox <= 2 && back; ox++) {
          const t2 = tiles[(ty + oy) * W + (tx + ox)] as number;
          if (t2 === T_SIDEWALK || t2 === T_ROAD || t2 === T_WATER) back = false;
        }
      }
      if (back) tiles[ty * W + tx] = T_TREES;
    }
  }
  return rng;
}

/** A stable seed for a park's furniture, derived from where the park is. */
function deriveParkSeed(b: BlockRect, salt: number): number {
  return (Math.imul(b.x, 2654435761) ^ Math.imul(b.y, 40503) ^ Math.imul(salt + 1, 7919)) >>> 0;
}

/**
 * Fill a block that is not a rectangle: frontage by DEPTH, not by ring.
 *
 * The ring fill below walks the bounding box's edges, which is right exactly
 * when the box edge is the street edge. A rotated borough's block is a
 * parallelogram in an axis-aligned box (WORLDGEN.md §13.4 `grid` fabric) —
 * its box edges cut through the middle of the carriageway, and a ring laid
 * along them builds into the street on two sides and faces bare yard on the
 * others. So this filler asks the ground instead: breadth-first from the
 * kerb, every member tile learns how deep it sits behind the street, and the
 * frontage is the band within the district's depth — whatever direction the
 * street happens to run. Units are small axis-aligned rects packed into the
 * band with hashed sizes and gap rolls, one tile of seam between them, which
 * is what an axis-aligned tile world can honestly make of a rotated street
 * wall: row-houses stepping along the frontage.
 */
export function fillRegion(
  tiles: Uint8Array,
  W: number,
  H: number,
  buildings: Building[],
  b: BlockRect,
  rng: number,
  within: (tx: number, ty: number) => boolean,
): number {
  const ctx: Ctx = { tiles, W, H, buildings, within };
  laySidewalk(ctx, b);
  if (b.district === 'park') {
    fill(ctx, b.x, b.y, b.w, b.h, T_PARK);
    return rng;
  }

  const density = b.density ?? 0.5;
  // Unit sizes run a tile smaller than the axis ring fill's (§13.6 step 9):
  // every block through here has a CURVED or angled frontage, and the finer
  // the unit, the finer the stairstep with which the row-houses follow it.
  const style: Record<string, { depth: number; gap: number; yard: number; lo: number; hi: number }> = {
    downtown: { depth: 6, gap: 0.05 * (1 - density), yard: T_LOT, lo: 3, hi: 6 },
    commercial: { depth: 5, gap: 0.1 * (1 - density), yard: T_LOT, lo: 3, hi: 6 },
    residential: { depth: 4, gap: 0.22 * (1 - density), yard: T_PARK, lo: 2, hi: 5 },
    // Industrial has no frontage band: big sheds stand anywhere on the open
    // yard, and the district's shape is the space between them.
    industrial: { depth: 999, gap: 0.55, yard: T_LOT, lo: 4, hi: 9 },
  };
  const s = style[b.district] ?? (style['commercial'] as { depth: number; gap: number; yard: number; lo: number; hi: number });

  // How deep each member tile sits behind the kerb.
  const depth = new Int16Array(b.w * b.h).fill(-1);
  const queue: number[] = [];
  const at = (tx: number, ty: number): number => (ty - b.y) * b.w + (tx - b.x);
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      if (!within(tx, ty)) continue;
      if (tiles[ty * W + tx] === T_SIDEWALK) {
        depth[at(tx, ty)] = 0;
        queue.push(at(tx, ty));
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    const lx = i % b.w;
    const ly = (i - lx) / b.w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const tx = b.x + lx + dx;
      const ty = b.y + ly + dy;
      if (tx < b.x || ty < b.y || tx >= b.x + b.w || ty >= b.y + b.h) continue;
      if (!within(tx, ty)) continue;
      if ((depth[at(tx, ty)] as number) >= 0) continue;
      depth[at(tx, ty)] = (depth[i] as number) + 1;
      queue.push(at(tx, ty));
    }
  }

  // The yard first, the buildings over it — same order as the ring fill.
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      if (!within(tx, ty)) continue;
      if ((depth[at(tx, ty)] as number) < 1) continue;
      if (tiles[ty * W + tx] === T_FIELD) tiles[ty * W + tx] = s.yard;
    }
  }

  const gone = new Uint8Array(b.w * b.h); // gap rolls consume ground for real
  const cand = (tx: number, ty: number): boolean => {
    if (tx < b.x || ty < b.y || tx >= b.x + b.w || ty >= b.y + b.h) return false;
    if (!within(tx, ty) || gone[at(tx, ty)] === 1) return false;
    const d = depth[at(tx, ty)] as number;
    if (d < 1 || d > s.depth) return false;
    return tiles[ty * W + tx] === s.yard;
  };
  const nearBuilt = (x0: number, y0: number, w: number, h: number): boolean => {
    for (let ty = y0 - 1; ty <= y0 + h; ty++) {
      for (let tx = x0 - 1; tx <= x0 + w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (tiles[ty * W + tx] === T_BUILDING) return true;
      }
    }
    return false;
  };

  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      if (!cand(tx, ty)) continue;
      let uw: number;
      let uh: number;
      let roll: number;
      [uw, rng] = nextIntRange(rng, s.lo, s.hi);
      [uh, rng] = nextIntRange(rng, s.lo, s.hi);
      [roll, rng] = nextFloat01(rng);
      if (roll < s.gap) {
        // A real gap: this stretch of frontage is a yard entrance, not a
        // unit that failed. Consumed, or the next anchor rebuilds it.
        for (let g = 0; g < uw && tx + g < b.x + b.w; g++) gone[at(tx + g, ty)] = 1;
        continue;
      }
      let w = 0;
      while (w < uw && cand(tx + w, ty)) w++;
      let h = 1;
      grow: while (h < uh) {
        for (let gx = 0; gx < w; gx++) if (!cand(tx + gx, ty + h)) break grow;
        h++;
      }
      if (w < 2 || h < 2) continue;
      if (nearBuilt(tx, ty, w, h)) continue;
      // Cut at the block's own angle where it has one (§36). The unit's SIZE
      // still comes from the axis-aligned growth above — the depth field runs
      // with the frontage, so the numbers are right — but it is stamped as an
      // oriented rectangle, and the tiles under it are that rectangle's
      // rasterisation. Which is the whole of VECTOR phase 3 for this filler:
      // a building cut at an angle never has to shrink to be drawn at one.
      if (!stampOriented(ctx, tx, ty, w, h, b, cand)) {
        fill(ctx, tx, ty, w, h, T_BUILDING);
        buildings.push({ x: tx, y: ty, w, h, district: b.district });
      }
    }
  }
  return rng;
}

/**
 * Stamp a unit as an oriented rectangle, if the block has an angle and the
 * turned footprint lands on ground the square one was allowed.
 *
 * Returns false when there is nothing to do (a square block) or when the turn
 * would put a corner somewhere the unit may not go — the caller then stamps
 * the square footprint, exactly as before. Refusing rather than shrinking is
 * the §22.4 lesson: a mass that fits by getting smaller is not a fit.
 */
function stampOriented(
  ctx: Ctx,
  tx: number,
  ty: number,
  w: number,
  h: number,
  b: BlockRect & { angle?: number },
  cand: (x: number, y: number) => boolean,
): boolean {
  const deg = facingAngle(b.angle ?? 0);
  if (deg === 0) return false;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = tx + w / 2;
  const cy = ty + h / 2;
  // The tiles the turned rect covers: centre-in-rect, the same rule
  // `rasteriseRings` uses, so a footprint and a coastline round in the same
  // direction.
  const reach = Math.ceil((w + h) / 2) + 1;
  const hit: number[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
    for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (Math.abs(u) > w / 2 || Math.abs(v) > h / 2) continue;
      // Every tile it lands on must be ground the square unit could have had
      // — AND ground a building may stand on at all. `fill` skips a blocked
      // tile and paints the rest; this cannot, because the tiles it writes
      // ARE the drawn rectangle, so a hole in them is a hole in the building.
      // It refuses the whole turn instead, and the caller stamps square.
      if (!cand(px, py) || blocked(ctx, px, py)) return false;
      // And the gap between buildings, checked against the TURNED footprint.
      // The caller's `nearBuilt` guards the axis-aligned rect this came from,
      // and a rotated rect reaches past it — so two units could end up
      // shoulder to shoulder, closing the alley between them. A ped walking
      // that alley then has nowhere to be, which is how the crowd ended up
      // inside a wall.
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = px + ox;
          const ny = py + oy;
          if (nx < 0 || ny < 0 || nx >= ctx.W || ny >= ctx.H) continue;
          if (ctx.tiles[ny * ctx.W + nx] === T_BUILDING) return false;
        }
      }
      hit.push(py * ctx.W + px);
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  if (hit.length < 4) return false;
  for (const i of hit) ctx.tiles[i] = T_BUILDING;
  ctx.buildings.push({
    // The integer bounding box: what collision, the volume grid and every
    // placement pass read, unchanged in meaning.
    x: x0,
    y: y0,
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    district: b.district,
    angle: deg,
    mw: w,
    mh: h,
  });
  return true;
}

/**
 * Build the block's street frontage and leave its middle open.
 *
 * This replaced a recursive split that scattered detached three-tile sheds
 * across the whole interior. Measured on the first drawn city, downtown came
 * out 13% built and 28% bare dirt — more empty ground than building, inside
 * the densest district on the map — because a block packed by subdivision has
 * no street wall and no mass. A city block is a RING: shoulder-to-shoulder
 * frontage facing the street, deep enough to read as mass from a car, with a
 * yard behind it that you reach through a gap.
 *
 * `gapChance` is how often the ring is broken — a service entrance, a lot, a
 * corner nobody built on. Downtown barely breaks; a suburb breaks often, and
 * a broken ring is what makes one district feel loose and the other tight.
 */
function frontage(
  ctx: Ctx,
  b: BlockRect,
  ix: number,
  iy: number,
  iw: number,
  ih: number,
  maxDepth: number,
  gapChance: number,
  yard: number,
  rng: number,
): number {
  const depth = Math.max(2, Math.min(maxDepth, Math.floor(Math.min(iw, ih) / 2) - 1));
  // Too small to have an inside: build it solid, in units, and be done.
  const solid = iw < depth * 2 + 3 || ih < depth * 2 + 3;

  /** Lay a run of building units along one side of the ring. */
  const side = (x0: number, y0: number, w: number, h: number, alongX: boolean): void => {
    if (w < 2 || h < 2) return;
    const run = alongX ? w : h;
    let at = 0;
    while (at < run) {
      let unit: number;
      [unit, rng] = nextIntRange(rng, 3, 7);
      unit = Math.min(unit, run - at);
      if (unit < 2) break;
      let skip: number;
      [skip, rng] = nextFloat01(rng);
      const ux = alongX ? x0 + at : x0;
      const uy = alongX ? y0 : y0 + at;
      const uw = alongX ? unit : w;
      const uh = alongX ? h : unit;
      if (skip < gapChance) {
        // A gap in the frontage: an alley mouth or a yard entrance.
        let gap: number;
        [gap, rng] = nextIntRange(rng, 2, 4);
        at += unit + gap;
      } else if (rectHasWater(ctx, ux, uy, uw, uh)) {
        // Blocked ground — a carved avenue, the waterfront, another block's
        // building. Slide ONE tile and try again. This branch used to share
        // the rolled-gap's unit-plus-gap stride, so a block crossed by a
        // curved arterial wrote a whole unit of frontage off at every brush
        // with the band and came out with no buildings at all — 110 blocks
        // of it along the ring (BUGS.md §7.6, REVIEW-WORLDGEN.md §2.6).
        at += 1;
        continue;
      } else {
        fill(ctx, ux, uy, uw, uh, T_BUILDING);
        ctx.buildings.push({ x: ux, y: uy, w: uw, h: uh, district: b.district });
        at += unit;
      }
      // One tile of separation, so the wall reads as buildings and not as
      // one continuous slab.
      at += 1;
    }
  };

  if (solid) {
    side(ix, iy, iw, ih, iw >= ih);
    return rng;
  }
  fill(ctx, ix, iy, iw, ih, yard);
  side(ix, iy, iw, depth, true);
  side(ix, iy + ih - depth, iw, depth, true);
  side(ix, iy + depth + 1, depth, ih - depth * 2 - 2, false);
  side(ix + iw - depth, iy + depth + 1, depth, ih - depth * 2 - 2, false);
  return rng;
}
