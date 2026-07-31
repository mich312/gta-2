import { nextFloat01, nextIntRange } from '../rng/prng.js';
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

export interface Ctx {
  tiles: Uint8Array;
  W: number;
  H: number;
  buildings: Building[];
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
  const t = ctx.tiles[ty * ctx.W + tx];
  return (
    t === T_WATER || t === T_BANK || t === T_SAND || t === T_ROAD || t === T_BRIDGE || t === T_RUNWAY
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
): number {
  const ctx: Ctx = { tiles, W, H, buildings };

  if (b.rural) {
    // Open country: no kerbs (which is what silences the crowd, the
    // props, the payphones and the kerbside cars out here — they all
    // filter on sidewalk), meadow underfoot, forest where the wildness
    // field says forest — except within one tile of a carved lane, so
    // every lane stays drivable at full width.
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const here = tiles[ty * W + tx];
        if (here !== T_FIELD) continue; // water, bank, sand, roads stay
        tiles[ty * W + tx] = wildAt?.(tx, ty) ? T_TREES : T_FIELD;
      }
    }
    for (let ty = Math.max(0, b.y); ty < Math.min(H, b.y + b.h); ty++) {
      for (let tx = Math.max(0, b.x); tx < Math.min(W, b.x + b.w); tx++) {
        if (tiles[ty * W + tx] !== T_TREES) continue;
        const nearRoad =
          isRoad(ctx, tx - 1, ty) ||
          isRoad(ctx, tx + 1, ty) ||
          isRoad(ctx, tx, ty - 1) ||
          isRoad(ctx, tx, ty + 1);
        if (nearRoad) tiles[ty * W + tx] = T_FIELD;
      }
    }
    return rng;
  }

  laySidewalk(ctx, b);
  const ix = b.x + 1;
  const iy = b.y + 1;
  const iw = b.w - 2;
  const ih = b.h - 2;
  if (iw < 2 || ih < 2) return rng;

  switch (b.district) {
    case 'downtown':
      rng = packRect(ctx, b, ix, iy, iw, ih, 8, 0.06, rng);
      break;
    case 'commercial':
      rng = packRect(ctx, b, ix, iy, iw, ih, 6, 0.12, rng);
      break;
    case 'industrial': {
      fill(ctx, ix, iy, iw, ih, T_LOT);
      let slabs: number;
      [slabs, rng] = nextIntRange(rng, 1, 3);
      for (let i = 0; i < slabs; i++) {
        const maxW = Math.max(3, Math.floor(iw / slabs) - 1);
        const maxH = Math.max(3, ih - 2);
        let w: number;
        let h: number;
        [w, rng] = nextIntRange(rng, 3, maxW + 1);
        [h, rng] = nextIntRange(rng, 3, maxH + 1);
        const x = ix + i * Math.floor(iw / slabs) + 1;
        let yOff: number;
        [yOff, rng] = nextIntRange(rng, 0, Math.max(1, ih - h));
        const y = iy + yOff;
        const cw = Math.min(w, ix + iw - x);
        if (cw >= 3 && h >= 3 && !rectHasWater(ctx, x, y, cw, h)) {
          fill(ctx, x, y, cw, h, T_BUILDING);
          buildings.push({ x, y, w: cw, h, district: b.district });
        }
      }
      break;
    }
    case 'residential': {
      // Rows of small houses with yard gaps.
      for (let y = iy; y + 3 <= iy + ih; y += 5) {
        for (let x = ix; x + 3 <= ix + iw; ) {
          let size: number;
          [size, rng] = nextIntRange(rng, 2, 4);
          let skip: number;
          [skip, rng] = nextFloat01(rng);
          const w = Math.min(size, ix + iw - x);
          const h = Math.min(size, iy + ih - y);
          if (skip >= 0.2 && w >= 2 && h >= 2 && !rectHasWater(ctx, x, y, w, h)) {
            fill(ctx, x, y, w, h, T_BUILDING);
            buildings.push({ x, y, w, h, district: b.district });
          }
          let gap: number;
          [gap, rng] = nextIntRange(rng, 1, 3);
          x += size + gap;
        }
      }
      break;
    }
    case 'park': {
      fill(ctx, ix, iy, iw, ih, T_PARK);
      // A park was an empty green rectangle. A path across it and a pond in
      // a big one give it something to be, and give the props pass edges to
      // hang benches and fences off.
      if (iw >= 7 && ih >= 7) {
        const midY = iy + Math.floor(ih / 2);
        const midX = ix + Math.floor(iw / 2);
        let which: number;
        [which, rng] = nextIntRange(rng, 0, 3);
        if (which !== 1) fill(ctx, ix, midY, iw, 1, T_SIDEWALK);
        if (which !== 0) fill(ctx, midX, iy, 1, ih, T_SIDEWALK);
      }
      if (iw >= 12 && ih >= 12) {
        let pw: number;
        let ph: number;
        [pw, rng] = nextIntRange(rng, 3, Math.min(6, iw - 6));
        [ph, rng] = nextIntRange(rng, 3, Math.min(6, ih - 6));
        fill(ctx, ix + 2, iy + 2, pw, ph, T_WATER);
      }
      break;
    }
  }
  return rng;
}
