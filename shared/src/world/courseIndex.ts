/**
 * The street centrelines, indexed for asking "where is the middle of this
 * road, and which way does it run" (WORLDGEN.md §41).
 *
 * §16 kept the courses so the renderer could stroke a curved road as one
 * line, and §40 built a graph whose topology is complete but whose geometry is
 * still chains of tile centres. This is the missing half: the courses made
 * queryable at a point, so anything that needs the road's true line — a
 * driver keeping to it, a route drawn along it — can have it instead of
 * feeling for the edges of the tarmac.
 *
 * **Why a query and not a per-tile plane.** The obvious shape is one more
 * array over the 589,824 tiles, and it is the wrong one twice over: it is
 * megabytes to store a thing that is only interesting within a few tiles of a
 * centreline, and it quantises the answer back to the grid the courses exist
 * to escape. Bucketed segments answer exactly, at any point, for the cost of
 * testing the handful of segments in the neighbouring cells.
 *
 * The bucketing is `courseJunctions`' (geometry.ts) — 8-tile cells, segments
 * added along their length so a long one lands in every cell it crosses.
 *
 * Deterministic: the query visits cells in a fixed order and breaks distance
 * ties on the lower segment index, so two hosts asking the same question of
 * the same courses get the same answer. Every operation is one IEEE-754 pins
 * exactly — multiply, add, compare, divide, `sqrt` — and deliberately not
 * `hypot`, which the standard leaves approximated. Coordinates are TILE units throughout,
 * matching `StreetCourse`.
 */

/** Cell size in tiles. The same 8 `courseJunctions` buckets by. */
const CELL = 8;

export interface CourseIndex {
  /** Segment endpoints, tile units. */
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  /** The carriageway width the segment's course carries. */
  width: Float64Array;
  /** Segments in a cell: `items[off[cellSlot] .. off[cellSlot + 1])`. */
  cellOf: Map<number, number>;
  off: Int32Array;
  items: Int32Array;
}

function cellKey(x: number, y: number): number {
  return (Math.floor(y / CELL) << 12) | (Math.floor(x / CELL) & 0xfff);
}

/** Bucket every course segment by the cells it crosses. */
export function buildCourseIndex(
  courses: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]>; width: number }>,
): CourseIndex {
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  const width: number[] = [];
  const keysOf: number[][] = [];
  for (const c of courses) {
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [x0, y0] = c.points[k] as readonly [number, number];
      const [x1, y1] = c.points[k + 1] as readonly [number, number];
      if (x0 === x1 && y0 === y1) continue;
      const seen = new Set<number>();
      // `Math.sqrt`, not `Math.hypot`: ECMA-262 pins sqrt to the exactly
      // rounded IEEE result and leaves hypot implementation-approximated, and
      // this number decides which cells a segment is filed under. A last-ulp
      // difference between two engines would file it differently and answer
      // a query differently, which is a desync waiting for the right map.
      const dx = x1 - x0;
      const dy = y1 - y0;
      const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / CELL) * 2);
      for (let s = 0; s <= steps; s++) {
        seen.add(cellKey(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps));
      }
      ax.push(x0);
      ay.push(y0);
      bx.push(x1);
      by.push(y1);
      width.push(c.width);
      keysOf.push([...seen]);
    }
  }

  // Flatten to CSR. A `Map` from key to slot keeps the lookup one hash, and
  // the segment lists contiguous.
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
  const at = new Int32Array(counts.length);
  for (let seg = 0; seg < keysOf.length; seg++) {
    for (const key of keysOf[seg] as number[]) {
      const slot = cellOf.get(key) as number;
      items[(off[slot] as number) + (at[slot] as number)] = seg;
      at[slot] = (at[slot] as number) + 1;
    }
  }

  return {
    ax: Float64Array.from(ax),
    ay: Float64Array.from(ay),
    bx: Float64Array.from(bx),
    by: Float64Array.from(by),
    width: Float64Array.from(width),
    cellOf,
    off,
    items,
  };
}

export interface CoursePoint {
  /** The closest point ON the centreline, tile units. */
  x: number;
  y: number;
  /** The segment's direction there, as a unit vector. */
  dx: number;
  dy: number;
  /** Distance from the query point, in tiles. */
  dist: number;
  /** The carriageway width the course carries. */
  width: number;
}

/**
 * The nearest point on any centreline to `(x, y)`, or null beyond `maxDist`.
 *
 * `maxDist` may not exceed the cell size: the search visits the query point's
 * cell and its eight neighbours, which is exactly the region within one cell
 * of the point.
 */
export function nearestCourse(
  idx: CourseIndex,
  x: number,
  y: number,
  maxDist: number,
): CoursePoint | null {
  const reach = maxDist > CELL ? CELL : maxDist;
  let bestD2 = reach * reach;
  let best = -1;
  let bestT = 0;
  for (let cy = -1; cy <= 1; cy++) {
    for (let cx = -1; cx <= 1; cx++) {
      const slot = idx.cellOf.get(cellKey(x + cx * CELL, y + cy * CELL));
      if (slot === undefined) continue;
      for (let k = idx.off[slot] as number; k < (idx.off[slot + 1] as number); k++) {
        const s = idx.items[k] as number;
        const sax = idx.ax[s] as number;
        const say = idx.ay[s] as number;
        const vx = (idx.bx[s] as number) - sax;
        const vy = (idx.by[s] as number) - say;
        const len2 = vx * vx + vy * vy;
        let t = len2 === 0 ? 0 : ((x - sax) * vx + (y - say) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = sax + vx * t - x;
        const py = say + vy * t - y;
        const d2 = px * px + py * py;
        // Ties to the lower segment: two hosts must pick the same one.
        if (d2 < bestD2 || (d2 === bestD2 && best >= 0 && s < best)) {
          bestD2 = d2;
          best = s;
          bestT = t;
        }
      }
    }
  }
  if (best < 0) return null;
  const sax = idx.ax[best] as number;
  const say = idx.ay[best] as number;
  const vx = (idx.bx[best] as number) - sax;
  const vy = (idx.by[best] as number) - say;
  const len = Math.sqrt(vx * vx + vy * vy) || 1;
  return {
    x: sax + vx * bestT,
    y: say + vy * bestT,
    dx: vx / len,
    dy: vy / len,
    dist: Math.sqrt(bestD2),
    width: idx.width[best] as number,
  };
}
