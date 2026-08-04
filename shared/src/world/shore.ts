/**
 * The shore, as a curve.
 *
 * The first piece of the city to stop being squares (WORLDGEN.md §17).
 *
 * The coastline is not drawn as tiles and never was: `paintCoast`
 * (`layout.ts`) builds an implicit field — an authored outline, blurred into
 * a signed distance, then displaced by a vector domain warp — and asks it one
 * question per tile centre. What ships is the answers, and the question is
 * thrown away. So the sea arrives on screen as a staircase of 16 px right
 * angles, §15 spent a wave chamfering the worst corners of it back to 45°,
 * and everything downstream that wants to know which way the water runs
 * measures the staircase and guesses.
 *
 * This module keeps the curve instead. Marching squares over the tile-centre
 * lattice gives the contour's topology; each crossing is then placed along
 * its edge by bisecting the SAME field the mask was thresholded from, so the
 * line lands where the water actually is rather than halfway between two
 * cells. The result is a set of closed rings in tile units — the shoreline as
 * geometry, at whatever angle it happens to run.
 *
 * **The mask stays the master, for now.** Two rules keep this a pure
 * addition:
 *
 * 1. A crossing is clamped to the middle of its edge (never nearer than
 *    `EDGE_MARGIN` to either end), so the contour cannot pass through a tile
 *    centre.
 * 2. Simplification is verified, not trusted: the rings are rasterised back
 *    at every tile centre and must reproduce the mask exactly, and any ring
 *    that fails retries at half the tolerance until it passes.
 *
 * Together those make `traceShore` incapable of disagreeing with the tile
 * plane it was traced from — which is what lets it ship beside the tiles and
 * be adopted one consumer at a time, the way §16 shipped the street courses
 * before anything stroked them.
 *
 * Deterministic and float-free where it counts: the topology is decided by
 * integer mask comparisons, and the points are quantised to a sixteenth of a
 * tile (one world px) before anybody looks at them.
 */

import { T_BRIDGE, TILE_SIZE, type ShoreIndex } from './types.js';

/** A closed ring of shoreline, in tile units. The first point is not repeated. */
export interface ShoreRing {
  points: Array<readonly [number, number]>;
  /**
   * Signed area in square tiles: **positive for a land outline, negative for
   * a hole** in one — a lagoon, a park pond, the cut a bridge deck makes in
   * the sea. It follows from the segments being directed with the land on
   * their right (see `CASES`), and it is the answer to the question every
   * consumer asks second, after "where is the line".
   *
   * Nothing needs it to FILL the rings — `rasteriseRings` is even-odd and
   * does not care how anything is wound — which is what makes it a free
   * cross-check rather than load-bearing: sum the signed areas of the whole
   * set and you get the land area of the city, and `shore.test.ts` asserts
   * that against the tile count.
   */
  area: number;
}

/** Points are shipped and compared at a sixteenth of a tile: one world px. */
export const SHORE_QUANTUM = 1 / 16;

/**
 * How near a crossing may come to a tile centre, as a fraction of the gap.
 *
 * The one rule that makes the contour provably agree with the mask: a tile
 * centre is a corner of the marching lattice, and if no crossing ever reaches
 * a corner then no corner is ever ON the contour, so every tile centre is
 * strictly inside or strictly outside and the parity fill cannot disagree
 * with the byte it came from. 0.15 still lets the line travel 70% of the gap,
 * which is the whole of the staircase worth removing.
 */
const EDGE_MARGIN = 0.15;

/** Bisection steps per crossing. Five puts it inside 1/32 of a tile. */
const BISECT_STEPS = 5;

/**
 * Douglas–Peucker tolerances to try, in tiles, in order.
 *
 * A quarter of a tile is four world px — under a car's width, and where the
 * pass earns its keep, because a rasterised coast is mostly runs of near-
 * collinear steps and collapsing those is the whole reduction. The ladder
 * exists because simplification is VERIFIED rather than trusted (see
 * `buildShore`): if a tolerance moves the curve across a tile centre
 * anywhere, the next one down is tried, and 0 — the untouched contour —
 * cannot fail.
 */
const SIMPLIFY_LADDER: readonly number[] = [0.25, 0.12, 0.06, 0];

/**
 * The signed field the mask was thresholded from, sampled anywhere.
 *
 * Positive is land. It is allowed to disagree with the mask — the coast is
 * cleaned up morphologically after it is thresholded, and a despeckled
 * puddle is a place where the field still says water and the mask says land.
 * Where they disagree the crossing falls back to the middle of the edge,
 * which is exactly what a tile-resolution contour would have said anyway.
 */
export type ShoreField = (x: number, y: number) => number;

/* ------------------------------------------------------------------ */
/* Crossings                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where along the gap between two neighbouring tile centres the water line
 * falls, as a fraction from `a` to `b`.
 *
 * `a` is the land end and `b` the water end, per the MASK. If the field
 * agrees about both ends it is bisected for the true crossing; if it does not
 * — the mask having been cleaned up after thresholding — the answer is the
 * middle, and the contour is no worse there than the staircase it replaces.
 */
function crossing(field: ShoreField, ax: number, ay: number, bx: number, by: number): number {
  const fa = field(ax, ay);
  const fb = field(bx, by);
  if (!(fa > 0 && fb <= 0)) return 0.5;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const m = (lo + hi) / 2;
    if (field(ax + (bx - ax) * m, ay + (by - ay) * m) > 0) lo = m;
    else hi = m;
  }
  const t = (lo + hi) / 2;
  return t < EDGE_MARGIN ? EDGE_MARGIN : t > 1 - EDGE_MARGIN ? 1 - EDGE_MARGIN : t;
}

/* ------------------------------------------------------------------ */
/* Marching squares                                                    */
/* ------------------------------------------------------------------ */

/**
 * Which cell edges each of the sixteen corner patterns joins, and in which
 * direction.
 *
 * Edges are indexed 0 top, 1 right, 2 bottom, 3 left; the corner bits are
 * 1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left, set where the mask
 * says land. Each entry is a flat list of (from, to) pairs.
 *
 * **Directed, and the direction is load-bearing.** Every segment runs with
 * the LAND ON ITS RIGHT (screen axes, y downward). Two things fall out of
 * that and neither is available from an undirected table: every crossing has
 * exactly one segment leaving it, so chaining is a walk with nothing to
 * choose; and a ring's winding then says what it bounds, so an island and the
 * lagoon inside it come back with opposite signed areas instead of whichever
 * sign the scan order happened to produce.
 *
 * The two saddles (5 and 10) are resolved so that the WATER is connected
 * through the middle and the two land corners are cut off separately — which
 * matches how the tile plane behaves under a mover, since a diagonal pinch of
 * two water tiles is solid either way round.
 */
const CASES: ReadonlyArray<ReadonlyArray<number>> = [
  /*  0 */ [],
  /*  1 */ [0, 3],
  /*  2 */ [1, 0],
  /*  3 */ [1, 3],
  /*  4 */ [2, 1],
  /*  5 */ [0, 3, 2, 1],
  /*  6 */ [2, 0],
  /*  7 */ [2, 3],
  /*  8 */ [3, 2],
  /*  9 */ [0, 2],
  /* 10 */ [1, 0, 3, 2],
  /* 11 */ [1, 2],
  /* 12 */ [3, 1],
  /* 13 */ [0, 1],
  /* 14 */ [3, 0],
  /* 15 */ [],
];

/**
 * Trace the shoreline of a land mask as closed rings.
 *
 * `land` is one byte per tile, 1 for land, row-major, `W` by `H`. The rings
 * come back in tile-index space: integer (x, y) is the CENTRE of tile (x, y),
 * which is the lattice marching squares runs on and the space
 * `rasteriseRings` checks in.
 *
 * The map's margin is open water (`PlanGeography.margin`), so no ring ever
 * reaches the border and every crossing is interior. Rings are emitted in
 * scan order of the cell that started them, which makes the output a pure
 * function of the mask and the field.
 */
export function traceShore(
  land: Uint8Array,
  W: number,
  H: number,
  field: ShoreField,
): ShoreRing[] {
  // Crossing parameter per lattice edge, or -1 for "no crossing here".
  // Edge id 2*i is the horizontal edge from tile i to its east neighbour,
  // 2*i+1 the vertical edge to its south neighbour.
  const at = new Float64Array(2 * W * H).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const here = land[i] as number;
      if (x + 1 < W && here !== (land[i + 1] as number)) {
        at[2 * i] = here === 1 ? crossing(field, x, y, x + 1, y) : 1 - crossing(field, x + 1, y, x, y);
      }
      if (y + 1 < H && here !== (land[i + W] as number)) {
        at[2 * i + 1] = here === 1 ? crossing(field, x, y, x, y + 1) : 1 - crossing(field, x, y + 1, x, y);
      }
    }
  }

  // Every crossing is left by exactly one segment and entered by exactly one,
  // so the whole boundary is a set of directed cycles and `leaves` is all the
  // chaining index anybody needs.
  const leaves = new Int32Array(2 * W * H).fill(-1);
  const arrives = new Int32Array(2 * W * H).fill(-1);
  for (let y = 0; y + 1 < H; y++) {
    for (let x = 0; x + 1 < W; x++) {
      const i = y * W + x;
      const code =
        (land[i] as number) |
        ((land[i + 1] as number) << 1) |
        ((land[i + W + 1] as number) << 2) |
        ((land[i + W] as number) << 3);
      const pairs = CASES[code] as ReadonlyArray<number>;
      if (pairs.length === 0) continue;
      // Cell edge index -> lattice edge id: top and bottom are the horizontal
      // edges of this row and the next, left and right the vertical edges of
      // this column and the next.
      const edgeOf = [2 * i, 2 * (i + 1) + 1, 2 * (i + W), 2 * i + 1];
      for (let k = 0; k + 1 < pairs.length; k += 2) {
        const from = edgeOf[pairs[k] as number] as number;
        const to = edgeOf[pairs[k + 1] as number] as number;
        leaves[from] = to;
        arrives[to] = from;
      }
    }
  }

  // Edge id -> the point it carries.
  const pointOf = (edge: number): readonly [number, number] => {
    const i = edge >> 1;
    const x = i % W;
    const y = (i - x) / W;
    const t = at[edge] as number;
    return (edge & 1) === 0 ? [x + t, y] : [x, y + t];
  };

  const seen = new Uint8Array(2 * W * H);
  const rings: ShoreRing[] = [];
  for (let start = 0; start < leaves.length; start++) {
    if (leaves[start] === -1 || seen[start] === 1) continue;
    // A crossing with no segment arriving at it would mean the boundary ran
    // off the map, which the sea margin forbids. Refusing to start a ring
    // there is what keeps a malformed mask from producing an open "ring".
    if (arrives[start] === -1) continue;
    const points: Array<readonly [number, number]> = [];
    let edge = start;
    do {
      seen[edge] = 1;
      points.push(pointOf(edge));
      edge = leaves[edge] as number;
    } while (edge !== start && edge !== -1 && seen[edge] === 0);
    if (points.length >= 3) rings.push({ points, area: signedArea(points) });
  }
  return rings;
}

/** Twice-the-signed-area over two: positive counter-clockwise with y down. */
export function signedArea(points: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as readonly [number, number];
    const [xj, yj] = points[j] as readonly [number, number];
    a += xj * yi - xi * yj;
  }
  return a / 2;
}

/* ------------------------------------------------------------------ */
/* Quantisation and simplification                                     */
/* ------------------------------------------------------------------ */

/** Snap to the shipped grid, and drop points the snap made duplicates. */
function quantise(points: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const [x, y] of points) {
    const qx = Math.round(x / SHORE_QUANTUM) * SHORE_QUANTUM;
    const qy = Math.round(y / SHORE_QUANTUM) * SHORE_QUANTUM;
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === qx && last[1] === qy) continue;
    out.push([qx, qy]);
  }
  while (out.length > 1) {
    const a = out[0] as readonly [number, number];
    const b = out[out.length - 1] as readonly [number, number];
    if (a[0] !== b[0] || a[1] !== b[1]) break;
    out.pop();
  }
  return out;
}

/**
 * Distance from p to the SEGMENT a–b — not to the infinite line through it,
 * which is the textbook Douglas–Peucker measure and is wrong here.
 *
 * A coastline at tile scale is full of hairpins: a one-tile spit, a channel
 * that doubles back. Across a hairpin the chord between the two retained ends
 * is short while the run between them is long, so a point far past the end of
 * the chord can sit close to the chord's LINE and be dropped — collapsing the
 * spit and taking the curve across a tile centre with it. Measuring to the
 * segment cannot make that mistake, costs one clamp, and is why the
 * rasterisation check passes at a useful tolerance instead of giving up and
 * shipping the raw contour.
 */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Douglas–Peucker over an open run, inclusive of both ends. */
function simplifyRun(
  points: ReadonlyArray<readonly [number, number]>,
  lo: number,
  hi: number,
  tolerance: number,
  keep: Uint8Array,
): void {
  if (hi <= lo + 1) return;
  const [ax, ay] = points[lo] as readonly [number, number];
  const [bx, by] = points[hi] as readonly [number, number];
  let worst = -1;
  let worstAt = -1;
  for (let i = lo + 1; i < hi; i++) {
    const [px, py] = points[i] as readonly [number, number];
    const d = segmentDistance(px, py, ax, ay, bx, by);
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
  if (worst <= tolerance) return;
  keep[worstAt] = 1;
  simplifyRun(points, lo, worstAt, tolerance, keep);
  simplifyRun(points, worstAt, hi, tolerance, keep);
}

/**
 * Douglas–Peucker over a CLOSED ring.
 *
 * Broken at two points rather than one — the first, and whichever is farthest
 * from it — because a ring split at a single vertex is an open run whose two
 * ends are the same point, and every interior vertex is then within
 * `tolerance` of a zero-length line.
 */
export function simplifyRing(
  points: ReadonlyArray<readonly [number, number]>,
  tolerance: number,
): Array<readonly [number, number]> {
  const n = points.length;
  if (n < 4 || tolerance <= 0) return points.slice();
  const [ax, ay] = points[0] as readonly [number, number];
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const [px, py] = points[i] as readonly [number, number];
    const d = (px - ax) * (px - ax) + (py - ay) * (py - ay);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  simplifyRun(points, 0, far, tolerance, keep);
  // The second run wraps, so it is walked over a rotated copy.
  const tail: Array<readonly [number, number]> = [];
  for (let i = far; i <= n; i++) tail.push(points[i % n] as readonly [number, number]);
  const tailKeep = new Uint8Array(tail.length);
  tailKeep[0] = 1;
  tailKeep[tail.length - 1] = 1;
  simplifyRun(tail, 0, tail.length - 1, tolerance, tailKeep);
  for (let i = 1; i + 1 < tail.length; i++) if (tailKeep[i] === 1) keep[(far + i) % n] = 1;
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(points[i] as readonly [number, number]);
  return out;
}

/* ------------------------------------------------------------------ */
/* The check that makes it safe                                        */
/* ------------------------------------------------------------------ */

/**
 * Fill the rings at every tile centre, even-odd, into a fresh mask.
 *
 * The rings live in tile-index space, so a tile centre is the integer lattice
 * point and the scanline for row `y` runs along an integer. Vertices DO land
 * on those scanlines — every crossing on a horizontal lattice edge has an
 * integer y — so the crossing test is half-open in y, which counts each such
 * vertex for exactly one of its two edges. No segment can be horizontal at an
 * integer y (within a cell, the only integer-y edges are its top and its
 * bottom, and no case joins them at the same height), so there is no
 * degenerate case left to handle.
 */
export function rasteriseRings(rings: ReadonlyArray<ShoreRing>, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const xs: number[] = [];
  for (let y = 0; y < H; y++) {
    xs.length = 0;
    for (const ring of rings) {
      const pts = ring.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i] as readonly [number, number];
        const [xj, yj] = pts[j] as readonly [number, number];
        if (yi <= y ? yj <= y : yj > y) continue;
        xs.push(xj + ((y - yj) / (yi - yj)) * (xi - xj));
      }
    }
    if (xs.length === 0) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.ceil(xs[k] as number);
      const to = Math.floor(xs[k + 1] as number);
      for (let x = from < 0 ? 0 : from; x <= to && x < W; x++) out[y * W + x] = 1;
    }
  }
  return out;
}

/** Where two masks differ. 0 is the only acceptable answer. */
export function maskDiff(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

/**
 * Trace, quantise and simplify the shoreline, and refuse to return anything
 * that does not rasterise back to the mask it came from.
 *
 * Simplification is applied per ring and verified for the whole set, because
 * that is the only honest granularity: rings nest, and a lagoon whose outline
 * moved changes the parity of the island around it. On a mismatch the
 * tolerance halves and the whole set is re-simplified, down to no
 * simplification at all — which is guaranteed to pass, because an unsimplified
 * quantised contour cannot cross a tile centre.
 */
export function buildShore(
  land: Uint8Array,
  W: number,
  H: number,
  field: ShoreField,
): ShoreRing[] {
  const traced = traceShore(land, W, H, field).map((r) => ({
    ...r,
    points: quantise(r.points),
  }));
  for (const tolerance of SIMPLIFY_LADDER) {
    const rings = traced
      .map((r) => {
        const points = tolerance === 0 ? r.points : simplifyRing(r.points, tolerance);
        return { points, area: signedArea(points) };
      })
      .filter((r) => r.points.length >= 3);
    if (maskDiff(rasteriseRings(rings, W, H), land) === 0) return rings;
  }
  throw new Error('shore: the unsimplified contour disagrees with its own mask');
}

/* ------------------------------------------------------------------ */
/* The index: rings as something the solver can ask                    */
/* ------------------------------------------------------------------ */

/**
 * Where a ring point sits in world px.
 *
 * Ring coordinates are in TILE-INDEX space, where the integer (x, y) is the
 * CENTRE of tile (x, y) — that is the lattice marching squares runs on. So
 * the conversion carries a half-tile, and because the points are multiples of
 * a sixteenth of a tile the result is always a whole number of pixels.
 */
function toPx(v: number): number {
  return (v + 0.5) * TILE_SIZE;
}

/** Does segment a–b touch the rect? Slab clipping, touching counts. */
function hitsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  let lo = 0;
  let hi = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > hi) return false;
      if (t > lo) lo = t;
    } else {
      if (t < lo) return false;
      if (t < hi) hi = t;
    }
    return true;
  };
  const dx = bx - ax;
  const dy = by - ay;
  if (!clip(-dx, ax - x0)) return false;
  if (!clip(dx, x1 - ax)) return false;
  if (!clip(-dy, ay - y0)) return false;
  if (!clip(dy, y1 - ay)) return false;
  return lo <= hi;
}

/**
 * Turn the shore rings into a per-tile edge index (`ShoreIndex`).
 *
 * Two things happen here that are not bookkeeping.
 *
 * **The half-plane.** Each segment becomes the half-plane the water occupies.
 * Segments run with the land on their right (`CASES`), so the water is on
 * their left, and the leftward normal of a direction `d` in screen axes
 * (y downward) is `(d.y, -d.x)`. That is the whole of the geometry: the
 * solver never looks at a segment again, only at `nx*x + ny*y >= c`.
 *
 * **Bridges are dropped.** The rings are traced from the tile plane, where a
 * deck is not water, so every bridge has a deck-shaped hole punched through
 * the sea around it (§17.11). Those edges are not shoreline and must not
 * collide: kept, they would put an invisible wall along the parapet for a car
 * and a second one across the arch for a boat. An edge with a bridge tile on
 * either side of it is therefore left out of the index entirely, which makes
 * the water surface continuous under every deck — the truth the tile plane
 * cannot hold, and the one place this pass gets to act as though the sectors
 * of §17.5 already existed.
 *
 * Pure function of (rings, tiles): both hosts build the identical index from
 * bytes they both have, so it never goes on the wire.
 */
export function buildShoreIndex(
  rings: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]> }>,
  tiles: Uint8Array,
  W: number,
  H: number,
): ShoreIndex {
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  const nx: number[] = [];
  const ny: number[] = [];
  const cs: number[] = [];

  const tileAtPx = (x: number, y: number): number => {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return -1;
    return tiles[ty * W + tx] as number;
  };

  for (const ring of rings) {
    const pts = ring.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const p0 = pts[j] as readonly [number, number];
      const p1 = pts[i] as readonly [number, number];
      const x0 = toPx(p0[0]);
      const y0 = toPx(p0[1]);
      const x1 = toPx(p1[0]);
      const y1 = toPx(p1[1]);
      const dx = x1 - x0;
      const dy = y1 - y0;
      if (dx === 0 && dy === 0) continue;
      // Water is to the left of travel; the offset that probes each side is
      // scaled by the larger component rather than the length, so there is no
      // square root anywhere in the build.
      const scale = 4 / Math.max(Math.abs(dx), Math.abs(dy));
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const wet = tileAtPx(mx + dy * scale, my - dx * scale);
      const dry = tileAtPx(mx - dy * scale, my + dx * scale);
      if (wet === T_BRIDGE || dry === T_BRIDGE) continue;
      ax.push(x0);
      ay.push(y0);
      bx.push(x1);
      by.push(y1);
      nx.push(dy);
      ny.push(-dx);
      cs.push(dy * x0 - dx * y0);
    }
  }

  const n = ax.length;
  const counts = new Int32Array(W * H);
  const visit = (k: number, fn: (tile: number) => void): void => {
    const lox = Math.max(0, Math.floor(Math.min(ax[k] as number, bx[k] as number) / TILE_SIZE));
    const hix = Math.min(W - 1, Math.floor(Math.max(ax[k] as number, bx[k] as number) / TILE_SIZE));
    const loy = Math.max(0, Math.floor(Math.min(ay[k] as number, by[k] as number) / TILE_SIZE));
    const hiy = Math.min(H - 1, Math.floor(Math.max(ay[k] as number, by[k] as number) / TILE_SIZE));
    for (let ty = loy; ty <= hiy; ty++) {
      for (let tx = lox; tx <= hix; tx++) {
        // Only the tiles the segment genuinely crosses. A half-plane is
        // infinite and the tile is the only thing clipping it, so listing an
        // edge under a tile it merely passes near would build a wall there.
        if (
          !hitsRect(
            ax[k] as number,
            ay[k] as number,
            bx[k] as number,
            by[k] as number,
            tx * TILE_SIZE,
            ty * TILE_SIZE,
            (tx + 1) * TILE_SIZE,
            (ty + 1) * TILE_SIZE,
          )
        ) {
          continue;
        }
        fn(ty * W + tx);
      }
    }
  };
  for (let k = 0; k < n; k++) visit(k, (t) => void ((counts[t] as number) += 1));

  const offset = new Int32Array(W * H + 1);
  for (let i = 0; i < W * H; i++) offset[i + 1] = (offset[i] as number) + (counts[i] as number);
  const items = new Int32Array(offset[W * H] as number);
  const at = new Int32Array(W * H);
  for (let k = 0; k < n; k++) {
    visit(k, (t) => {
      items[(offset[t] as number) + (at[t] as number)] = k;
      (at[t] as number) += 1;
    });
  }

  const inv = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    inv[k] = 1 / Math.sqrt((nx[k] as number) ** 2 + (ny[k] as number) ** 2);
  }
  return {
    widthTiles: W,
    heightTiles: H,
    offset,
    items,
    nx: Float64Array.from(nx),
    ny: Float64Array.from(ny),
    c: Float64Array.from(cs),
    inv,
  };
}
