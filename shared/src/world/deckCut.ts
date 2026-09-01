import { T_BRIDGE, T_WATER } from './types.js';

/**
 * A bridge deck's own outer edge, as a line through each tile it crosses
 * (WORLDGEN.md §45).
 *
 * §25 made the coast a curve and the water tiles its rasterisation, and all
 * three painters took the curve. The deck never got the same treatment, and
 * was refused by name in each of them — "the coast runs UNDER it" in the 2D
 * painter, no `T_BRIDGE` in the 3D `GROUND_AT_SEA`, `null` ground in
 * `mapRender`. That refusal is correct about the COAST: a river's waterline
 * really does pass beneath a span and says nothing about where the deck ends.
 * What it left behind is a built edge over open water with no curve of any
 * kind over it, so the deck was drawn exactly as it lies — one square tile at
 * a time — while the shoreline twenty tiles behind it was drawn smooth.
 *
 * **Where the curve comes from, and why it is not an approximation of one.**
 * `carveCourse` (layout.ts) lays a carriageway as a SWEPT DISC: a tile
 * becomes road or deck when `segmentDistance(tx + 0.5, ty + 0.5, seg)` is at
 * most `width / 2`. The same polyline and the same width are then recorded in
 * the bake as a `StreetCourse` (layout.ts, `courses.push`). So the deck's true
 * outline is the level set `distance == width / 2` of its own course, and the
 * tile mask is that curve point-sampled at tile centres. Measured on the
 * shipped city: all 1,564 deck tiles fall inside the disc and 869 of the 872
 * tiles across a deck/water face fall outside it. This does not INVENT an
 * edge for the deck — it reads back the one the deck was cut from, exactly as
 * `shoreChains` reads back the one the water was cut from.
 *
 * The three exceptions are water tiles the disc covers where `bridgeable`
 * declined to lay a deck at all — a span too long for the plan's
 * `maxBridgeSpan`. The curve runs through them and the painters will show a
 * sliver of deck there, which is what the plan says is there.
 *
 * **Output shape is `shoreChains`'s**, deliberately: `Map<tile, Float32Array>`
 * of tile-local points with the WATER ON THE RIGHT of travel. That is the one
 * convention `shoreHalf` and `chainSide` are written against, so the two
 * renderers cut a deck tile with the same two functions they already cut a
 * shore tile with, and no second polygon-splitting path exists to disagree
 * with the first.
 *
 * **One line per tile, and when it declines.** A tile whose four corners do
 * not all agree about which side of the curve they are on is cut on the chord
 * between its two border crossings. Where the curve enters and leaves the same
 * square twice — four crossings, a saddle — this returns nothing for that tile
 * and it stays square, exactly as `buildShoreCut` returns nothing for a chain
 * that bows too far from its own chord. A cut that one line cannot describe is
 * not described by one line.
 *
 * Deterministic: exact ops only (multiply, add, compare, divide, `sqrt` — and
 * deliberately not `hypot`, which the standard leaves approximated), a fixed
 * bisection count, and built from the baked courses, so both hosts derive the
 * identical curve and it never goes on the wire.
 */

/** Bucket size in tiles for the segment index. The 8 `courseIndex` uses. */
const CELL = 8;

/**
 * Bisection steps used to place a border crossing. 2^-22 of a tile is far
 * below a pixel at any zoom the game draws, and a fixed count is what makes
 * two hosts place the crossing on the same float.
 */
const BISECT = 22;

/**
 * A chord shorter than this is a nick, not a crossing: the curve clips one
 * corner and the square is already within a fiftieth of a tile of right.
 * Cutting on it would only feed `shoreHalf` a degenerate polygon.
 */
const MIN_CHORD = 0.02;

/** What a course looks like to this module. `StreetCourse`, loosely typed. */
export interface CourseLike {
  points: ReadonlyArray<readonly [number, number]>;
  width: number;
}

/**
 * Course segments bucketed by the cells their swept disc can reach.
 *
 * Filed by the segment's BOUNDING BOX GROWN BY ITS OWN HALF-WIDTH, not by
 * sampling along it. `courseIndex` samples, which is fine for "which
 * centreline is nearest" and is not fine here: a segment missed by the
 * sampler would flip the SIGN of the field at a point, and the sign is what
 * decides whether a pixel is deck or river. The grown box is conservative by
 * construction — every point the disc covers is inside it — so a cell lookup
 * can never miss a segment that would have come out positive.
 */
export interface DeckField {
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  /** Half the carriageway width the segment carries, in tiles. */
  half: Float64Array;
  cellOf: Map<number, number>;
  off: Int32Array;
  items: Int32Array;
}

function cellKey(cx: number, cy: number): number {
  return (cy << 12) | (cx & 0xfff);
}

/** Bucket every course segment by the cells its swept disc can reach. */
export function buildDeckField(courses: ReadonlyArray<CourseLike> | undefined): DeckField {
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  const half: number[] = [];
  const keysOf: number[][] = [];
  for (const c of courses ?? []) {
    const h = c.width / 2;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [x0, y0] = c.points[k] as readonly [number, number];
      const [x1, y1] = c.points[k + 1] as readonly [number, number];
      if (x0 === x1 && y0 === y1) continue;
      const cx0 = Math.floor((Math.min(x0, x1) - h) / CELL);
      const cx1 = Math.floor((Math.max(x0, x1) + h) / CELL);
      const cy0 = Math.floor((Math.min(y0, y1) - h) / CELL);
      const cy1 = Math.floor((Math.max(y0, y1) + h) / CELL);
      const keys: number[] = [];
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) keys.push(cellKey(cx, cy));
      }
      ax.push(x0);
      ay.push(y0);
      bx.push(x1);
      by.push(y1);
      half.push(h);
      keysOf.push(keys);
    }
  }

  // Flatten to CSR, the same shape `courseIndex` uses.
  const cellOf = new Map<number, number>();
  const counts: number[] = [];
  for (const keys of keysOf) {
    for (const key of keys) {
      let slot = cellOf.get(key);
      if (slot === undefined) {
        slot = counts.length;
        cellOf.set(key, slot);
        counts.push(0);
      }
      counts[slot] = (counts[slot] as number) + 1;
    }
  }
  const off = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) off[i + 1] = (off[i] as number) + (counts[i] as number);
  const items = new Int32Array(off[counts.length] as number);
  const fill = new Int32Array(counts.length);
  for (let s = 0; s < keysOf.length; s++) {
    for (const key of keysOf[s] as number[]) {
      const slot = cellOf.get(key) as number;
      items[(off[slot] as number) + (fill[slot] as number)] = s;
      fill[slot] = (fill[slot] as number) + 1;
    }
  }

  return {
    ax: Float64Array.from(ax),
    ay: Float64Array.from(ay),
    bx: Float64Array.from(bx),
    by: Float64Array.from(by),
    half: Float64Array.from(half),
    cellOf,
    off,
    items,
  };
}

/**
 * How far inside the carriageway a point is, in tiles: `half - distance` to
 * the nearest course, maximised over every course that reaches this cell.
 *
 * Positive is on the road (and, over water, on the deck); zero is the edge
 * `carveCourse` rasterises with `<=`; negative is off it. Only the SIGN is
 * guaranteed exact — a point far outside every disc reports whatever the
 * segments filed in its own cell say, which is negative but not necessarily
 * the true distance. That is all any caller here asks of it, and it is what
 * makes a single-cell lookup enough.
 */
export function deckDepth(f: DeckField, x: number, y: number): number {
  const slot = f.cellOf.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (slot === undefined) return -Infinity;
  let best = -Infinity;
  for (let k = f.off[slot] as number; k < (f.off[slot + 1] as number); k++) {
    const s = f.items[k] as number;
    const sax = f.ax[s] as number;
    const say = f.ay[s] as number;
    const vx = (f.bx[s] as number) - sax;
    const vy = (f.by[s] as number) - say;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((x - sax) * vx + (y - say) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (sax + vx * t);
    const py = y - (say + vy * t);
    // `Math.sqrt`, not `Math.hypot`: ECMA-262 pins sqrt to the exactly
    // rounded IEEE result and leaves hypot implementation-approximated. This
    // number decides which side of the deck edge a pixel is on.
    const d = (f.half[s] as number) - Math.sqrt(px * px + py * py);
    if (d > best) best = d;
  }
  return best;
}

/**
 * Where along `a -> b` the field changes sign, as a parameter in [0, 1].
 *
 * Called only when the two ends disagree, so a bracket exists on the first
 * step and the fixed step count is a precision, not a termination condition.
 */
function crossAt(f: DeckField, x0: number, y0: number, x1: number, y1: number): number {
  let lo = 0;
  let hi = 1;
  const inLo = deckDepth(f, x0, y0) >= 0;
  for (let i = 0; i < BISECT; i++) {
    const m = (lo + hi) / 2;
    const inM = deckDepth(f, x0 + (x1 - x0) * m, y0 + (y1 - y0) * m) >= 0;
    if (inM === inLo) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** What this module reads a tile grid as. `TileGrid` is taken (amenities.ts). */
export type DeckTiles = Uint8Array | Uint16Array | Int32Array | ReadonlyArray<number>;

/**
 * The tiles the deck edge is allowed to redraw: both squares of every
 * deck/water face, and nothing else.
 *
 * ONE definition, exported, because three painters key off it and a fourth
 * (`mapAudit`) reports on it. The level set `deckDepth` reads runs round EVERY
 * carriageway in the city, and following it inland would redraw every kerb on
 * the map — a change orders of magnitude wider than the one anybody asked
 * for. Restricting it here rather than in each caller is what stops the three
 * painters from drifting apart about where the deck stops being special.
 *
 * A tile qualifies when it is deck with open water four-adjacent, or open
 * water with deck four-adjacent: exactly the two squares either side of a face
 * `buildBridgeRails` would stand a parapet on.
 */
export function deckEdgeTiles(tiles: DeckTiles, W: number, H: number): Set<number> {
  const cand = new Set<number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((tiles[y * W + x] as number) !== T_BRIDGE) continue;
      for (const [dx, dy] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if ((tiles[ny * W + nx] as number) !== T_WATER) continue;
        cand.add(y * W + x);
        cand.add(ny * W + nx);
      }
    }
  }
  return cand;
}

/** The deck's outer edge, per tile, in `shoreChains` form. */
export function buildDeckCut(
  tiles: DeckTiles,
  W: number,
  H: number,
  courses: ReadonlyArray<CourseLike> | undefined,
): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (!courses || courses.length === 0) return out;
  const f = buildDeckField(courses);
  if (f.ax.length === 0) return out;
  const cand = deckEdgeTiles(tiles, W, H);

  // Corners of the unit square, and the four border edges between them.
  const CX = [0, 1, 1, 0];
  const CY = [0, 0, 1, 1];
  for (const idx of cand) {
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const inside = [0, 1, 2, 3].map(
      (k) => deckDepth(f, tx + (CX[k] as number), ty + (CY[k] as number)) >= 0,
    );
    const hits: Array<[number, number]> = [];
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      if (inside[k] === inside[j]) continue;
      const x0 = tx + (CX[k] as number);
      const y0 = ty + (CY[k] as number);
      const x1 = tx + (CX[j] as number);
      const y1 = ty + (CY[j] as number);
      const t = crossAt(f, x0, y0, x1, y1);
      hits.push([
        (CX[k] as number) + ((CX[j] as number) - (CX[k] as number)) * t,
        (CY[k] as number) + ((CY[j] as number) - (CY[k] as number)) * t,
      ]);
    }
    // Not two crossings: the square is wholly one side (nothing to cut) or
    // the curve enters and leaves twice (nothing one line can say). Both keep
    // the tile square, which is what every painter does today.
    if (hits.length !== 2) continue;
    let [a, b] = hits as [[number, number], [number, number]];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    if (Math.sqrt(vx * vx + vy * vy) < MIN_CHORD) continue;

    // Water on the RIGHT of travel, which with y down is where the cross
    // product of the run with the offset comes out positive — the convention
    // `shoreHalf` and `chainSide` are written against, so a deck chain and a
    // coast chain mean the same thing by the same test.
    const wetCentre = deckDepth(f, tx + 0.5, ty + 0.5) < 0;
    const cross = vx * (0.5 - a[1]) - vy * (0.5 - a[0]);
    if (cross > 0 !== wetCentre) {
      const swap = a;
      a = b;
      b = swap;
    }
    out.set(idx, Float32Array.from([a[0], a[1], b[0], b[1]]));
  }
  return out;
}
