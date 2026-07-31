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
    return rng;
  }

  laySidewalk(ctx, b);
  const ix = b.x + 1;
  const iy = b.y + 1;
  const iw = b.w - 2;
  const ih = b.h - 2;
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
        fill(ctx, ix + 2, iy + 2, pw, ph, T_WATER);
        // A bandstand: something to navigate by inside the green.
        const bx = ix + iw - 5;
        const by = iy + ih - 5;
        if (!rectHasWater(ctx, bx, by, 3, 3)) {
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
      if (skip >= gapChance && !rectHasWater(ctx, ux, uy, uw, uh)) {
        fill(ctx, ux, uy, uw, uh, T_BUILDING);
        ctx.buildings.push({ x: ux, y: uy, w: uw, h: uh, district: b.district });
        at += unit;
      } else {
        // A gap in the frontage: an alley mouth or a yard entrance.
        let gap: number;
        [gap, rng] = nextIntRange(rng, 2, 4);
        at += unit + gap;
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
