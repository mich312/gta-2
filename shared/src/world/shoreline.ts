import { T_BRIDGE, T_WATER } from './types.js';

/**
 * The coast, drawn in one line (WORLDGEN.md §18).
 *
 * §16 did this for roads and named the reason: the curve EXISTS, and the bake
 * threw it away, shipping only its rasterisation — so the renderer spent its
 * time reconstructing curves from their own wreckage. The shore is the same
 * complaint with the opposite cause. There is no authored curve to keep,
 * because nobody drew the coastline: it fell out of a warped distance field
 * (§12.7) sampled at tile centres. The line is real, it is smooth, and the
 * only record of it anywhere is a staircase of 16 px right angles.
 *
 * §15's bevels bought back the biggest half-tile of that staircase and could
 * never buy back more, because a bevel is a single 45° cut and a coast turns
 * through every other angle too. What follows recovers the whole line:
 *
 *   1. **Trace.** Every edge between a wet cell and a dry one, directed so
 *      the water is on the right, chained end-to-end into closed loops. One
 *      loop per island, per lake, per rock. This is exact — it is the tile
 *      plane's own boundary, no approximation yet.
 *   2. **Round.** Chaikin corner-cutting twice. A rasterised line's corners
 *      are all the same size, so cutting them all is exactly right: what
 *      comes out follows the tiles at their own scale and stops being made
 *      of right angles at any smaller one.
 *   3. **Thin.** Douglas–Peucker at a third of a tile — under the eye's
 *      reach at any zoom the game uses, and it takes a coast of six thousand
 *      corners down to something a renderer can stroke per frame.
 *
 * Derived, not baked, and the choice matters. §16's courses HAD to be baked
 * because the carve's polyline was the only copy; a shore has no source but
 * the tiles, so recovering it costs no wire bytes, changes no bake, and — the
 * part that pays — works identically for a city nobody drew. Like the bevel
 * plane it is a pure function of the finished tile plane, so both hosts
 * compute the same coast from the same bytes without sending any of it.
 *
 * And like the courses, it is COSMETIC. The tiles remain the truth: collision
 * asks `isSolidTile` and the bevel plane, traffic drives its lanes, boats
 * moor against `T_BANK`. What the loops change is what the coast LOOKS like,
 * which is what was wrong with it.
 */

/**
 * One closed run of coastline, in tile units.
 *
 * The points are a ring: the last joins the first, and the first is not
 * repeated. Directed with WATER ON THE RIGHT of travel — so the outward
 * normal into the sea at a point is the direction rotated a quarter turn
 * clockwise on screen, and the land normal a quarter turn the other way.
 * Consumers that shade one side of the line need that and nothing else.
 */
export interface ShoreLoop {
  points: Array<readonly [number, number]>;
  /** Tiles enclosed by the ring: a lake is small, a mainland is not. */
  area: number;
  /**
   * True when the ring encloses LAND (an island, a headland), false when it
   * encloses water (a lake, a lagoon, the bay inside a spit). A painter that
   * fills one side wants to know which side it has.
   */
  land: boolean;
}

/** Water, for the purpose of drawing a coast. */
function wet(t: number): boolean {
  // A bridge deck is a road over the sea, and the sea goes under it: counting
  // the deck as land would run the coastline round three sides of every
  // crossing and leave a tide mark across the carriageway.
  return t === T_WATER || t === T_BRIDGE;
}

/**
 * Chaikin corner-cutting, on a closed ring.
 *
 * Each round replaces every corner with the two points a quarter and three
 * quarters along its arms, which is the standard construction and converges
 * on a quadratic B-spline. Two rounds is what §12.7's `smoothPolyline` uses
 * on a road and is right here for the same reason: enough to stop reading as
 * steps, not so much that a headland melts.
 */
function chaikinRing(ring: Array<readonly [number, number]>, rounds: number): Array<readonly [number, number]> {
  let cur = ring;
  for (let r = 0; r < rounds; r++) {
    const next: Array<readonly [number, number]> = [];
    for (let i = 0; i < cur.length; i++) {
      const [ax, ay] = cur[i] as readonly [number, number];
      const [bx, by] = cur[(i + 1) % cur.length] as readonly [number, number];
      next.push([ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25]);
      next.push([ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75]);
    }
    cur = next;
  }
  return cur;
}

/**
 * Douglas–Peucker on a ring, iteratively.
 *
 * Iteratively and not recursively on purpose: a mainland coast arrives here
 * with tens of thousands of points after two Chaikin rounds, and the textbook
 * recursion is one stack frame per split. The explicit stack costs three
 * lines and cannot blow up on a big island.
 */
function simplifyRing(
  ring: Array<readonly [number, number]>,
  eps: number,
): Array<readonly [number, number]> {
  const n = ring.length;
  if (n < 8) return ring;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  // A ring has no ends to anchor to, so it is cut at its two most distant
  // points and simplified as two open chains — the usual dodge, and the only
  // one that cannot shave a whole lobe off a smooth loop.
  let far = 1;
  {
    const [ax, ay] = ring[0] as readonly [number, number];
    let bd = -1;
    for (let i = 1; i < n; i++) {
      const [px, py] = ring[i] as readonly [number, number];
      const d = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      if (d > bd) {
        bd = d;
        far = i;
      }
    }
  }
  keep[far] = 1;
  const stack: Array<[number, number]> = [
    [0, far],
    [far, n],
  ];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi - lo < 2) continue;
    const [ax, ay] = ring[lo % n] as readonly [number, number];
    const [bx, by] = ring[hi % n] as readonly [number, number];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let worst = eps * eps;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = ring[i % n] as readonly [number, number];
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
      const dx = px - (ax + vx * t);
      const dy = py - (ay + vy * t);
      // Squared, and the threshold squared with it. `Math.hypot` is correct
      // about overflow and slow about everything, and this is the inner loop
      // of a pass over every corner of every coast — §15.4's lesson again.
      const d = dx * dx + dy * dy;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at < 0) continue;
    keep[at % n] = 1;
    stack.push([lo, at], [at, hi]);
  }
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(ring[i] as readonly [number, number]);
  return out.length >= 4 ? out : ring;
}

/** Twice the signed area of a ring. Positive is clockwise with y down. */
function signedArea2(ring: Array<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i] as readonly [number, number];
    const [x1, y1] = ring[(i + 1) % ring.length] as readonly [number, number];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}

/**
 * The coastline of a finished tile plane, as closed polylines.
 *
 * `smooth` and `eps` exist for the tests and for a caller that wants the raw
 * staircase (both zero) to compare against. Nothing in the game passes them.
 */
export function deriveShores(
  tiles: Uint8Array,
  W: number,
  H: number,
  smooth = 2,
  eps = 1 / 3,
): ShoreLoop[] {
  const at = (x: number, y: number): number =>
    // Outside the map is open sea. Note what this does NOT do: land running
    // off the edge of the map gets no coast along the border, because the
    // trace only walks out from wet cells and there are none out there. Every
    // plan keeps a margin of open water round the whole map (§12.4), so the
    // case cannot arise in a city — and a coastline drawn along the edge of
    // the world would be a worse answer than none.
    x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (tiles[y * W + x] as number);

  // Every boundary edge, keyed by its start corner. Corners are lattice
  // points, (W+1)×(H+1) of them, so one flat index each. Two edges can leave
  // one corner — that is a saddle, where two wet cells touch diagonally —
  // hence a second slot rather than a map of arrays.
  const CW = W + 1;
  const endA = new Int32Array((W + 1) * (H + 1)).fill(-1);
  const endB = new Int32Array((W + 1) * (H + 1)).fill(-1);
  const put = (sx: number, sy: number, ex: number, ey: number): void => {
    const s = sy * CW + sx;
    const e = ey * CW + ex;
    if (endA[s] === -1) endA[s] = e;
    else endB[s] = e;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!wet(at(x, y))) continue;
      // Water on the right of travel. With y down, "right" is the direction
      // turned a quarter turn clockwise, so a northern edge runs east, an
      // eastern edge runs south, and so on round.
      if (!wet(at(x, y - 1))) put(x, y, x + 1, y);
      if (!wet(at(x + 1, y))) put(x + 1, y, x + 1, y + 1);
      if (!wet(at(x, y + 1))) put(x + 1, y + 1, x, y + 1);
      if (!wet(at(x - 1, y))) put(x, y + 1, x, y);
    }
  }

  const usedA = new Uint8Array(endA.length);
  const usedB = new Uint8Array(endA.length);
  const loops: ShoreLoop[] = [];
  for (let s0 = 0; s0 < endA.length; s0++) {
    for (let slot = 0; slot < 2; slot++) {
      const first = slot === 0 ? endA[s0] : endB[s0];
      if (first === -1) continue;
      if ((slot === 0 ? usedA[s0] : usedB[s0]) === 1) continue;
      const ring: Array<readonly [number, number]> = [];
      let cur = s0;
      let use = slot;
      for (;;) {
        if (use === 0) usedA[cur] = 1;
        else usedB[cur] = 1;
        const cx = cur % CW;
        const cy = (cur - cx) / CW;
        ring.push([cx, cy]);
        const next = use === 0 ? (endA[cur] as number) : (endB[cur] as number);
        if (next === s0) break;
        // Which of the (at most two) edges leaving the next corner to take.
        // At a saddle both are legal and the choice decides whether two wet
        // cells touching corner to corner read as one region pinched to a
        // point or as two that meet there. Taking the SECOND slot when this
        // corner has already been left once keeps them apart, which is what
        // the eye sees and what the bevel pass (§15) also decided.
        if (endA[next] === -1) break;
        use = (usedA[next] === 1 && endB[next] !== -1) ? 1 : 0;
        if ((use === 0 ? usedA[next] : usedB[next]) === 1) break;
        cur = next;
      }
      // A single wet tile in a field is a puddle, not a coast, and four
      // corners of ring is not something to stroke.
      if (ring.length < 8) continue;
      const raw2 = signedArea2(ring);
      const rounded = smooth > 0 ? chaikinRing(ring, smooth) : ring;
      const thinned = eps > 0 ? simplifyRing(rounded, eps) : rounded;
      if (thinned.length < 4) continue;
      loops.push({
        points: thinned,
        area: Math.abs(raw2) / 2,
        // Water on the right of travel decides the winding, and the winding
        // decides what is enclosed. Round a lake the water is inside, so the
        // walk turns clockwise on screen and the doubled area comes out
        // positive; round an island the water is outside, the walk runs the
        // other way, and it comes out negative. Hence: negative encloses land.
        land: raw2 < 0,
      });
    }
  }
  loops.sort((a, b) => b.area - a.area);
  return loops;
}

/**
 * The coast, cut up into the piece that runs through each tile.
 *
 * Each entry is the polyline THROUGH that tile in tile-local coordinates —
 * `[x0, y0, x1, y1, …]` with every value in 0..1 — entering on one edge of
 * the square and leaving on another.
 *
 * A single nearest segment per tile is the obvious thing and it is wrong, by
 * a whole tile edge. Two neighbouring tiles pick two different segments,
 * clip themselves against two different lines, and the two lines cross their
 * shared edge at two different points: the coast comes out as a chain of
 * chords that do not meet, which is a staircase again with the steps at a
 * jauntier angle. Splitting the polyline at the tile boundaries makes the
 * entry and exit points SHARED, so what each tile draws joins what its
 * neighbour draws exactly, and the line is continuous the whole way round
 * the island.
 *
 * One chain per tile, the longest where a coast passes through twice — a
 * one-tile isthmus with sea on both sides gets the shore that matters and
 * loses the other, which is a better failure than intersecting the two and
 * cutting the isthmus in half.
 */
export function shoreChains(
  loops: ReadonlyArray<Pick<ShoreLoop, 'points'>>,
  W: number,
  H: number,
): Map<number, Float32Array> {
  const best = new Map<number, number[]>();
  const bestLen = new Map<number, number>();
  let curTile = -1;
  let cur: number[] = [];
  let curLen = 0;

  const flush = (): void => {
    if (curTile < 0 || cur.length < 4) return;
    if (curLen > (bestLen.get(curTile) ?? -1)) {
      bestLen.set(curTile, curLen);
      best.set(curTile, cur);
    }
    curTile = -1;
    cur = [];
    curLen = 0;
  };
  const piece = (tile: number, ax: number, ay: number, bx: number, by: number): void => {
    const tx = tile % W;
    const ty = (tile - tx) / W;
    if (tile !== curTile) {
      flush();
      curTile = tile;
      cur = [ax - tx, ay - ty];
      curLen = 0;
    }
    cur.push(bx - tx, by - ty);
    curLen += Math.hypot(bx - ax, by - ay);
  };

  const ts: number[] = [];
  for (const loop of loops) {
    const n = loop.points.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = loop.points[i] as readonly [number, number];
      const [bx, by] = loop.points[(i + 1) % n] as readonly [number, number];
      const dx = bx - ax;
      const dy = by - ay;
      // Where this segment crosses a tile boundary, as parameters along it.
      ts.length = 0;
      ts.push(0, 1);
      if (dx !== 0) {
        const lo = Math.ceil(Math.min(ax, bx));
        const hi = Math.floor(Math.max(ax, bx));
        for (let k = lo; k <= hi; k++) {
          const t = (k - ax) / dx;
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      if (dy !== 0) {
        const lo = Math.ceil(Math.min(ay, by));
        const hi = Math.floor(Math.max(ay, by));
        for (let k = lo; k <= hi; k++) {
          const t = (k - ay) / dy;
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      ts.sort((p, q) => p - q);
      for (let k = 0; k + 1 < ts.length; k++) {
        const t0 = ts[k] as number;
        const t1 = ts[k + 1] as number;
        if (t1 - t0 < 1e-9) continue;
        const mid = (t0 + t1) / 2;
        const tx = Math.floor(ax + dx * mid);
        const ty = Math.floor(ay + dy * mid);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        piece(ty * W + tx, ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1);
      }
    }
  }
  flush();

  const out = new Map<number, Float32Array>();
  for (const [tile, pts] of best) out.set(tile, Float32Array.from(pts));
  return out;
}

/** Where a point on the unit square's border sits along its perimeter, 0..4. */
function perimeter(x: number, y: number): number {
  if (y <= 1e-9) return x;
  if (x >= 1 - 1e-9) return 1 + y;
  if (y >= 1 - 1e-9) return 3 - x;
  return 4 - y;
}

/**
 * The part of a tile square on one side of the coast running through it, in
 * tile-local coordinates — or empty when the chain leaves nothing that side.
 *
 * Built by walking, not by clipping. The obvious construction is
 * Sutherland–Hodgman against each of the chain's runs in turn, and it is
 * wrong wherever the chain bends: intersecting half-planes shaves a sliver
 * off BOTH sides at every bend, so the two halves stop adding up to the
 * square and the missing slice shows as a notch in the coast. Instead the
 * boundary is traced — along the chain, then round the square's own border
 * from where the coast leaves back to where it entered — which partitions
 * the square exactly however the chain wanders.
 *
 * Water is on the RIGHT of travel (see `deriveShores`) and the screen's y
 * runs down, so the dry side is the left; `wantWet` picks which piece comes
 * back.
 */
export function shoreHalf(chain: Float32Array, wantWet: boolean): Array<[number, number]> {
  const n = chain.length / 2;
  if (n < 2) return [];
  const poly: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) poly.push([chain[k * 2] as number, chain[k * 2 + 1] as number]);

  // Round the border from the exit back to the entry, picking up the corners
  // on the way. Increasing perimeter parameter, which is clockwise on screen.
  const s0 = perimeter(poly[0]?.[0] as number, poly[0]?.[1] as number);
  const sk = perimeter(
    poly[n - 1]?.[0] as number,
    poly[n - 1]?.[1] as number,
  );
  const CORNERS: Array<[number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  // In the order the walk MEETS them, not in the order they are listed: a
  // coast leaving through the south edge picks up the south-west corner
  // before the north-west one, and a fixed order ties the polygon in a knot.
  const walk = (from: number, to: number): Array<[number, number]> => {
    const span = (to - from + 4) % 4;
    return CORNERS.map((c, i) => ({ c, at: (i + 1 - from + 4) % 4 }))
      .filter((e) => e.at < span)
      .sort((a, b) => a.at - b.at)
      .map((e) => e.c);
  };
  for (const c of walk(sk, s0)) poly.push(c);

  // Which half this is, decided at the square's CENTRE.
  //
  // The obvious probe — a step to the left of the coast, where dry ground
  // must be — fails on the commonest tile there is: one whose coast runs
  // along its own border, where the step lands outside the square entirely.
  // The centre is always inside exactly one of the two halves and always
  // has a side, so asking it both questions settles it in every case.
  const CX = 0.5;
  const CY = 0.5;
  let near = Infinity;
  let centreWet = false;
  for (let k = 0; k + 1 < n; k++) {
    const ax = chain[k * 2] as number;
    const ay = chain[k * 2 + 1] as number;
    const vx = (chain[k * 2 + 2] as number) - ax;
    const vy = (chain[k * 2 + 3] as number) - ay;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((CX - ax) * vx + (CY - ay) * vy) / len2));
    const qx = CX - (ax + vx * t);
    const qy = CY - (ay + vy * t);
    const d = qx * qx + qy * qy;
    if (d >= near) continue;
    near = d;
    centreWet = vx * (CY - ay) - vy * (CX - ax) > 0;
  }
  let hasCentre = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > CY !== yj > CY && CX < ((xj - xi) * (CY - yi)) / (yj - yi) + xi) hasCentre = !hasCentre;
  }
  const polyIsWet = hasCentre ? centreWet : !centreWet;
  if (polyIsWet === wantWet) return poly.length >= 3 ? poly : [];

  // The other half: the same chain walked backwards, and the rest of the
  // border. Built rather than subtracted, so both halves are honest polygons.
  const other: Array<[number, number]> = [];
  for (let k = n - 1; k >= 0; k--) other.push([chain[k * 2] as number, chain[k * 2 + 1] as number]);
  for (const c of walk(s0, sk)) other.push(c);
  return other.length >= 3 ? other : [];
}

/**
 * Which tiles a set of loops passes through, one byte per tile.
 *
 * The §16 pattern, for the same reason it was needed there: where the curve
 * is drawn, the per-tile painter has to stop drawing its own version of the
 * same line, or the shore is painted twice by two things that disagree about
 * where it is.
 */
export function shoreCover(loops: ShoreLoop[], W: number, H: number): Uint8Array {
  const cover = new Uint8Array(W * H);
  const mark = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) cover[y * W + x] = 1;
  };
  for (const loop of loops) {
    const n = loop.points.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = loop.points[i] as readonly [number, number];
      const [bx, by] = loop.points[(i + 1) % n] as readonly [number, number];
      // Half-tile steps along the segment, and the four tiles round each
      // sample: a line running down a tile boundary belongs to both sides.
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      for (let s = 0; s <= steps; s++) {
        const px = ax + ((bx - ax) * s) / steps;
        const py = ay + ((by - ay) * s) / steps;
        const tx = Math.floor(px);
        const ty = Math.floor(py);
        mark(tx, ty);
        mark(tx - 1, ty);
        mark(tx, ty - 1);
        mark(tx - 1, ty - 1);
      }
    }
  }
  return cover;
}
