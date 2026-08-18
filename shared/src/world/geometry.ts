/**
 * Geometry: the boundaries of this city, as curves (VECTOR.md).
 *
 * The rule the plan turns on is that **vertices own boundaries and grids own
 * fields**. A boundary is where something ends — you can see it and you can
 * hit it, and a grid can only ever say where it is to within half a cell. A
 * field is what is true at a point — you ask it constantly and never collide
 * with it, and a grid answers that in one indexed read.
 *
 * This module owns the first half. It turns a continuous scalar field into
 * the closed rings of its zero contour, and turns those rings back into a
 * mask. The important direction is the SECOND one: the mask is a pure
 * function of the rings, so it cannot hold an opinion of its own.
 *
 * What this replaces is a round trip. The coast used to be rasterised from a
 * field, then traced back out of the raster and smoothed — and no smoother
 * can recover a curve that was destroyed before it ran, which is why 55% of
 * the drawn waterline sat within 7.5° of an axis however hard `deriveShores`
 * worked. Here the contour is extracted from the field itself, by
 * interpolation, so it was never quantised in the first place.
 */

import { simplifyPolyline } from './plan.js';

/** A closed ring of points, in tile units. Never repeats its first point. */
export type Ring = Array<readonly [number, number]>;

/** A closed boundary between land and water. */
export interface CoastRing {
  points: Ring;
  /** True if this ring encloses LAND; false if it encloses water (a lake). */
  land: boolean;
  /** Enclosed area in square tiles, always positive. */
  area: number;
}

/** A scalar field sampled on a regular grid, positive inside. */
export interface Field {
  v: Float32Array;
  /** Samples across and down, so `v[j * nx + i]` is at `(i * step, j * step)`. */
  nx: number;
  ny: number;
  step: number;
}

/**
 * Sample a continuous field on a grid fine enough to contour.
 *
 * `step` is in tiles and should divide the map. Half a tile is plenty: the
 * contour's position is INTERPOLATED between samples, so its accuracy goes as
 * the square of the spacing rather than linearly, and the error at half a
 * tile is far under the quarter-pixel the vertices are shipped at.
 */
export function sampleField(
  at: (x: number, y: number) => number,
  W: number,
  H: number,
  step: number,
): Field {
  const nx = Math.round(W / step) + 1;
  const ny = Math.round(H / step) + 1;
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) v[j * nx + i] = at(i * step, j * step);
  }
  return { v, nx, ny, step };
}

/** Where the zero crossing falls between two samples, as a fraction. */
function cross(a: number, b: number): number {
  const d = a - b;
  return d === 0 ? 0.5 : a / d;
}

/**
 * The zero contour of a field, as closed rings wound with LAND ON THE LEFT.
 *
 * Marching squares, with the crossing point on each cell edge placed by
 * linear interpolation rather than at the edge's midpoint — that single
 * detail is the difference between a curve and a staircase, and it is why
 * this can be sampled coarsely and still come out smooth.
 *
 * Saddle cells (two diagonal corners inside, two out) are resolved by the
 * average of the four corners, which is the standard disambiguation and keeps
 * the rings from crossing themselves at a pinch point.
 *
 * The winding convention matches what the painters have always assumed: water
 * is on the RIGHT of travel, so a quarter turn clockwise on screen from the
 * direction of travel lands you in the sea.
 */
export function contourRings(f: Field): Ring[] {
  const { v, nx, ny, step } = f;
  /** Directed segments, keyed by their start point, quantised to link up. */
  const key = (x: number, y: number): string =>
    `${Math.round(x / step * 4096)},${Math.round(y / step * 4096)}`;
  const from = new Map<string, Array<readonly [number, number]>>();
  const push = (a: readonly [number, number], b: readonly [number, number]): void => {
    const k = key(a[0], a[1]);
    const bag = from.get(k);
    if (bag === undefined) from.set(k, [a, b]);
    else bag.push(a, b);
  };

  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const v00 = v[j * nx + i] as number;
      const v10 = v[j * nx + i + 1] as number;
      const v11 = v[(j + 1) * nx + i + 1] as number;
      const v01 = v[(j + 1) * nx + i] as number;
      const c = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const x = i * step;
      const y = j * step;
      // The four possible crossings, on the cell's own edges.
      const eB = [x + cross(v00, v10) * step, y] as const; // top edge in screen terms
      const eR = [x + step, y + cross(v10, v11) * step] as const;
      const eT = [x + cross(v01, v11) * step, y + step] as const;
      const eL = [x, y + cross(v00, v01) * step] as const;
      // Segments directed so that positive (land) is on the LEFT, which in a
      // y-down plane puts the water on the right of travel.
      switch (c) {
        case 1: push(eL, eB); break;
        case 2: push(eB, eR); break;
        case 3: push(eL, eR); break;
        case 4: push(eR, eT); break;
        case 6: push(eB, eT); break;
        case 7: push(eL, eT); break;
        case 8: push(eT, eL); break;
        case 9: push(eT, eB); break;
        case 11: push(eT, eR); break;
        case 12: push(eR, eL); break;
        case 13: push(eR, eB); break;
        case 14: push(eB, eL); break;
        // Saddles: which pair joins depends on the middle, so ask it.
        case 5:
          if ((v00 + v10 + v11 + v01) / 4 > 0) {
            push(eL, eB);
            push(eR, eT);
          } else {
            push(eL, eT);
            push(eR, eB);
          }
          break;
        case 10:
          if ((v00 + v10 + v11 + v01) / 4 > 0) {
            push(eT, eL);
            push(eB, eR);
          } else {
            push(eB, eL);
            push(eT, eR);
          }
          break;
        default:
          break;
      }
    }
  }

  // Walk the segments into closed rings. Every crossing point has exactly one
  // segment leaving it and one arriving (saddles are why the map holds a list
  // rather than a single entry), so following `to` until we are back where we
  // started closes a ring and consumes it.
  const rings: Ring[] = [];
  for (const [k, bag] of from) {
    while (bag.length > 0) {
      const start = bag.shift() as readonly [number, number];
      let next = bag.shift() as readonly [number, number];
      if (bag.length === 0) from.delete(k);
      const ring: Ring = [start];
      for (let guard = 0; guard < 1e7; guard++) {
        ring.push(next);
        const nk = key(next[0], next[1]);
        const onward = from.get(nk);
        if (onward === undefined || onward.length === 0) break;
        onward.shift();
        next = onward.shift() as readonly [number, number];
        if (onward.length === 0) from.delete(nk);
        if (key(next[0], next[1]) === key(start[0], start[1])) {
          ring.push(next);
          break;
        }
      }
      // A contour of a field is closed or it is nothing. The walk normally
      // ends by arriving back at the start — either matching it explicitly or
      // running out of segments there, because the start's own bag emptied
      // when we took the first one. Anything else means the field disagreed
      // with itself between two cells, and shipping the fragment would put a
      // coastline with a hole in it into the bake without a word (§27.5).
      const last = ring[ring.length - 1] as readonly [number, number];
      if (key(last[0], last[1]) !== key(start[0], start[1])) {
        throw new Error(
          `contourRings: open contour, ${ring.length} points from ${start[0]},${start[1]}`,
        );
      }
      // Drop zero-length steps: a crossing that lands exactly on a cell
      // corner is emitted by both of the cells that share it, and a repeated
      // point has no direction, so anything asking which side of the ring it
      // is on gets no answer.
      const tidy: Ring = [];
      for (const p of ring) {
        const last = tidy[tidy.length - 1];
        if (last !== undefined && last[0] === p[0] && last[1] === p[1]) continue;
        tidy.push(p);
      }
      const head = tidy[0] as readonly [number, number];
      const tail = tidy[tidy.length - 1] as readonly [number, number];
      if (tidy.length > 1 && head[0] === tail[0] && head[1] === tail[1]) tidy.pop();
      if (tidy.length >= 4) rings.push(tidy);
    }
  }
  return rings;
}

/**
 * Twice the signed area of a ring.
 *
 * NEGATIVE for a ring enclosing land, positive for one enclosing water — a
 * consequence of the winding convention (water on the right) in a y-down
 * plane, and the reason `land` is not simply "positive area".
 */
export function ringArea2(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i] as readonly [number, number];
    const [x1, y1] = r[(i + 1) % r.length] as readonly [number, number];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}

/** A ring's perimeter, in tiles. */
export function ringPerimeter(r: Ring): number {
  let p = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i] as readonly [number, number];
    const [x1, y1] = r[(i + 1) % r.length] as readonly [number, number];
    p += Math.hypot(x1 - x0, y1 - y0);
  }
  return p;
}

/**
 * Is this ring an island, or a bar?
 *
 * Area alone cannot tell them apart — a sandbar four tiles wide and fifty
 * long has the area of a respectable islet while having no interior at all,
 * which is how two of them ended up floating in the middle of the sound. The
 * hydraulic radius (area ÷ perimeter) is the width the shape actually has:
 * for a long thin rectangle it tends to half the width, so the test below is
 * "at least four tiles across somewhere".
 */
export function ringHasInterior(r: Ring, minWidth = 4): boolean {
  const p = ringPerimeter(r);
  return p > 0 && Math.abs(ringArea2(r)) / 2 / p >= minWidth / 2;
}

/**
 * Fill closed rings into a tile mask: 1 where land, 0 where water.
 *
 * Scanline through tile CENTRES with the even-odd rule, which is what makes
 * the mask a pure function of the rings — the same question asked of the same
 * curve, once per tile, with no second opinion about where the edge is. This
 * is the only place the land plane is ever written.
 */
export function rasteriseRings(rings: readonly Ring[], W: number, H: number): Uint8Array {
  const mask = new Uint8Array(W * H);
  // Bucket edges by the tile rows they span, so each row only tests its own.
  const rows: Array<Array<readonly [number, number, number, number]>> = Array.from(
    { length: H },
    () => [],
  );
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i] as readonly [number, number];
      const [bx, by] = r[(i + 1) % r.length] as readonly [number, number];
      if (ay === by) continue;
      const lo = Math.max(0, Math.ceil(Math.min(ay, by) - 0.5));
      const hi = Math.min(H - 1, Math.floor(Math.max(ay, by) - 0.5));
      for (let ty = lo; ty <= hi; ty++) (rows[ty] as Array<readonly [number, number, number, number]>).push([ax, ay, bx, by]);
    }
  }
  const xs: number[] = [];
  for (let ty = 0; ty < H; ty++) {
    const y = ty + 0.5;
    xs.length = 0;
    for (const [ax, ay, bx, by] of rows[ty] as Array<readonly [number, number, number, number]>) {
      if (ay <= y === by <= y) continue;
      xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    if (xs.length === 0) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from2 = Math.max(0, Math.ceil((xs[k] as number) - 0.5));
      const to = Math.min(W - 1, Math.floor((xs[k + 1] as number) - 0.5));
      for (let tx = from2; tx <= to; tx++) mask[ty * W + tx] = 1;
    }
  }
  return mask;
}

/**
 * A field's zero contour, tidied: contour, simplify, measure, and say which
 * way each ring is wound. One call, so nobody assembles this sequence twice
 * and differently.
 *
 * `minArea` drops specks in square tiles. `eps` is the simplification
 * tolerance in tiles; a quarter of a world pixel is 1/64.
 *
 * `land` here means "wound the way a ring enclosing POSITIVE field is wound",
 * which for the coast field is land and for the shore band's field is the
 * grass behind it. The name is the coast's because the coast is what the
 * convention was fixed by; what it always means is the sign of the area.
 */
export function levelRings(f: Field, minArea = 0, eps = 1 / 64): CoastRing[] {
  const out: CoastRing[] = [];
  for (const raw of contourRings(f)) {
    const points = simplifyPolyline(raw.map(([x, y]) => [x, y]), eps) as Ring;
    if (points.length < 4) continue;
    const a2 = ringArea2(points);
    const area = Math.abs(a2) / 2;
    if (area < minArea) continue;
    // Water on the right in a y-down plane makes a land ring's signed area
    // negative; a lake, wound the other way round, comes out positive.
    out.push({ points, land: a2 < 0, area });
  }
  return out;
}

/**
 * The finished coast: `levelRings` plus the rule that an island has to have
 * an interior.
 *
 * `minArea` drops puddles and pebbles — the despeckle the mask pass used to
 * do, expressed on the shape rather than on its rasterisation. A ribbon four
 * tiles wide and fifty long has an island's AREA and no interior, so the
 * hydraulic-radius test drowns it; that rule is right for a coast and wrong
 * for anything else, which is why it lives here and not in `levelRings`. The
 * shore band IS a ribbon by construction.
 */
export function coastRings(f: Field, minArea = 120, eps = 1 / 64): CoastRing[] {
  return levelRings(f, minArea, eps).filter((r) => !r.land || ringHasInterior(r.points));
}

/* ------------------------------------------------------------------ */
/* Indexing a boundary: the coast, cut up per tile                     */
/* ------------------------------------------------------------------ */

/**
 * These two moved here from `shoreline.ts` when `deriveShores` was deleted
 * (VECTOR.md phase 1). They are not recovery — they never look at a tile to
 * decide where the coast is. They take the curve as given and index it, which
 * is what a painter needs to shade one tile at a time, and they are just as
 * useful now the curve arrives from the bake instead of from a trace.
 */

/** Minimum shape `shoreChains` needs of a loop. */
export interface ShoreLike {
  points: Array<readonly [number, number]>;
}

export function shoreChains(
  loops: ReadonlyArray<ShoreLike>,
  W: number,
  H: number,
): Map<number, Float32Array> {
  const best = new Map<number, number[]>();
  const bestLen = new Map<number, number>();
  let curTile = -1;
  let cur: number[] = [];
  let curLen = 0;
  // The first piece of the ring being walked, held back so the last piece can
  // be joined to it. See `closeRing`.
  let firstTile = -1;
  let firstPts: number[] = [];
  let firstLen = 0;

  const record = (tile: number, pts: number[], len: number): void => {
    if (tile < 0 || pts.length < 4) return;
    if (len > (bestLen.get(tile) ?? -1)) {
      bestLen.set(tile, len);
      best.set(tile, pts);
    }
  };
  const flush = (): void => {
    if (firstTile < 0 && curTile >= 0 && cur.length >= 4) {
      firstTile = curTile;
      firstPts = cur;
      firstLen = curLen;
    }
    record(curTile, cur, curLen);
    curTile = -1;
    cur = [];
    curLen = 0;
  };
  /**
   * Finish a ring, joining its last piece to its first.
   *
   * A ring is a cycle and its point list is not: wherever the list happens to
   * start, the curve through THAT tile arrives as the walk's last piece and
   * leaves as its first. Keeping the longer of the two — which is what the
   * per-tile rule below does — throws the other half away, and a chain that
   * starts inside the square instead of on its border makes `shoreHalf` walk
   * the wrong way round it: a thin spike of the wrong material, once per ring.
   *
   * Invisible on the coast, where a ring is two thousand points round an
   * island and the one bad tile is somewhere in open sand. Not invisible on a
   * park pond's beach, which is sixty-five points round a puddle.
   */
  const closeRing = (): void => {
    if (curTile >= 0 && curTile === firstTile && cur.length >= 4 && firstPts.length >= 4) {
      // The last piece ends where the first piece begins — the ring's own
      // first point — so drop the repeat when splicing them.
      record(curTile, cur.concat(firstPts.slice(2)), curLen + firstLen);
      curTile = -1;
      cur = [];
      curLen = 0;
    } else {
      flush();
    }
    firstTile = -1;
    firstPts = [];
    firstLen = 0;
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
    // `Math.sqrt`, not `Math.hypot`. This length decides which of two chains
    // through a tile is kept, and `shoreChains` now feeds the collision solver
    // as well as the painter (§43): ECMA-262 pins sqrt to the exactly rounded
    // IEEE result and leaves hypot approximated, so a last-ulp disagreement
    // between two engines could keep a different chain and stop a car in a
    // different place.
    curLen += Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
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
    closeRing();
  }

  const out = new Map<number, Float32Array>();
  for (const [tile, pts] of best) out.set(tile, Float32Array.from(pts));
  return out;
}

/**
 * Which side of a tile's chain a point falls on: −1 to the right of travel,
 * +1 to the left, in the same tile-local coordinates the chain is in.
 *
 * The companion of `shoreHalf`, and it answers for points the chain does not
 * pass through. A painter cutting a tile in two needs to know what each half
 * is MADE of, and the honest answer is "whatever the nearest ground on that
 * side is made of" — which needs a side test for the neighbours, not just for
 * the tile being cut. Classifying materials instead (sand and bank are shore,
 * grass is not) gets the cliff wrong, because a wooded cliff foot and the
 * wood behind it are the same tile type on opposite sides of the line.
 *
 * Nearest-segment rather than winding, because a chain is a fragment: it has
 * ends, and the question is only ever asked within a tile or so of it, where
 * the two agree except inside the turn of a very sharp corner.
 */
export function chainSide(chain: Float32Array, x: number, y: number): number {
  const n = chain.length / 2;
  let best = Infinity;
  let side = 1;
  for (let k = 0; k + 1 < n; k++) {
    const ax = chain[k * 2] as number;
    const ay = chain[k * 2 + 1] as number;
    const vx = (chain[k * 2 + 2] as number) - ax;
    const vy = (chain[k * 2 + 3] as number) - ay;
    const l2 = vx * vx + vy * vy;
    if (l2 === 0) continue;
    const rx = x - ax;
    const ry = y - ay;
    const t = Math.max(0, Math.min(1, (rx * vx + ry * vy) / l2));
    const dx = rx - t * vx;
    const dy = ry - t * vy;
    const d = dx * dx + dy * dy;
    if (d >= best) continue;
    best = d;
    // With y down, the right of a direction is that direction turned a
    // quarter turn clockwise, where the cross product comes out positive.
    side = vx * ry - vy * rx > 0 ? -1 : 1;
  }
  return side;
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

/**
 * One place where the road courses meet: the crossing point, the disc a
 * painter punches out of a stroke, and — new in §50 — the ARMS.
 *
 * The disc alone was enough while the only question was "where does the
 * centre dash stop". Everything a junction is furnished WITH has to know
 * which way the roads leave it: a stop line lies across one arm, a zebra
 * across the same arm one step further out, an arrow points along it. The
 * tile plane cannot answer that — a merged sheet of tarmac has no direction
 * — so the arms come off the curves with the crossing.
 */
export interface CourseCrossing {
  x: number;
  y: number;
  /** Half the widest carriageway through here: the junction's own radius. */
  r: number;
  /**
   * The ways out, as unit vectors pointing AWAY from the crossing, each with
   * the carriageway width of the course it belongs to. Four at a crossroads,
   * three at a T, two where a course simply bends into another.
   */
  arms: Array<{ dx: number; dy: number; width: number }>;
}

/** Two arms are the same arm if they leave within this angle of each other. */
const ARM_MERGE_COS = Math.cos((25 * Math.PI) / 180);

/**
 * How far a course must carry on past the crossing for that side to count as
 * an arm, in tiles. A course that ENDS on another one makes a T, and a T with
 * a fourth arm painted on it puts a crossing across somebody's front garden.
 */
const ARM_MIN_RUN = 2;

/**
 * Where the road courses cross each other — junctions, computed from the
 * CURVES rather than guessed from the tiles.
 *
 * The two marking systems disagreed about this. The per-tile painter has
 * always left a junction bare (`if (horizontal && vertical) return`), while
 * the ribbon painter stroked its centre dash straight through: 5,780 of
 * 15,260 junction tiles carried a dash the game's own rule says they should
 * not (WORLDGEN.md §23.3). A junction is where two centrelines meet, which is
 * a fact about the lines, so ask the lines.
 *
 * Crossings found within a carriageway of each other are ONE junction. Three
 * courses meeting at a corner cross pairwise and answer three points a third
 * of a tile apart; furnished separately that is three sets of stop lines
 * stacked across one mouth, which is the same failure the per-tile painter
 * had for the same reason — asking a local question about a thing that is not
 * local.
 */
export function courseCrossings(
  courses: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]>; width: number }>,
): CourseCrossing[] {
  // Bucket every segment by the 8-tile cell it starts in, so a course is only
  // ever tested against its neighbours. Pairwise over ~7,700 segments would
  // be thirty million tests for a thing that has to run at load.
  const CELL = 8;
  const bucket = new Map<number, Array<{ i: number; k: number }>>();
  const add = (x: number, y: number, i: number, k: number): void => {
    const key = (Math.floor(y / CELL) << 12) | Math.floor(x / CELL);
    const bag = bucket.get(key);
    if (bag === undefined) bucket.set(key, [{ i, k }]);
    else bag.push({ i, k });
  };
  courses.forEach((c, i) => {
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k] as readonly [number, number];
      const [bx, by] = c.points[k + 1] as readonly [number, number];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / CELL));
      for (let s = 0; s <= steps; s++) {
        add(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, i, k);
      }
    }
  });

  /** Length of course `i` from vertex `k` plus `t` of segment k, each way. */
  const runFrom = (i: number, k: number, t: number): [number, number] => {
    const pts = (courses[i] as { points: ReadonlyArray<readonly [number, number]> }).points;
    const seg = (j: number): number => {
      const [ax, ay] = pts[j] as readonly [number, number];
      const [bx, by] = pts[j + 1] as readonly [number, number];
      return Math.hypot(bx - ax, by - ay);
    };
    const here = seg(k);
    let back = here * t;
    for (let j = k - 1; j >= 0 && back < ARM_MIN_RUN; j--) back += seg(j);
    let fwd = here * (1 - t);
    for (let j = k + 1; j + 1 < pts.length && fwd < ARM_MIN_RUN; j++) fwd += seg(j);
    return [back, fwd];
  };

  const raw: Array<CourseCrossing> = [];
  const seen = new Set<string>();
  for (const bag of bucket.values()) {
    for (let p = 0; p < bag.length; p++) {
      for (let q = p + 1; q < bag.length; q++) {
        const A = bag[p] as { i: number; k: number };
        const B = bag[q] as { i: number; k: number };
        // A course crossing ITSELF at the next segment along is a bend, not a
        // junction. Different courses, or the same one doubling back.
        if (A.i === B.i && Math.abs(A.k - B.k) <= 1) continue;
        const ca = courses[A.i] as {
          points: ReadonlyArray<readonly [number, number]>;
          width: number;
        };
        const cb = courses[B.i] as {
          points: ReadonlyArray<readonly [number, number]>;
          width: number;
        };
        const [ax, ay] = ca.points[A.k] as readonly [number, number];
        const [bx, by] = ca.points[A.k + 1] as readonly [number, number];
        const [cx, cy] = cb.points[B.k] as readonly [number, number];
        const [dx, dy] = cb.points[B.k + 1] as readonly [number, number];
        const r1x = bx - ax;
        const r1y = by - ay;
        const r2x = dx - cx;
        const r2y = dy - cy;
        const den = r1x * r2y - r1y * r2x;
        if (den === 0) continue; // parallel: a doubled-up line, not a crossing
        const t = ((cx - ax) * r2y - (cy - ay) * r2x) / den;
        const u = ((cx - ax) * r1y - (cy - ay) * r1x) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const x = ax + r1x * t;
        const y = ay + r1y * t;
        // One crossing per meeting, not one per segment pair that finds it.
        const key = `${Math.round(x * 2)},${Math.round(y * 2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const arms: CourseCrossing['arms'] = [];
        for (const [c, k, tt, vx, vy] of [
          [ca, A.k, t, r1x, r1y],
          [cb, B.k, u, r2x, r2y],
        ] as const) {
          const len = Math.hypot(vx, vy) || 1;
          const [back, fwd] = runFrom(c === ca ? A.i : B.i, k, tt);
          if (fwd >= ARM_MIN_RUN) arms.push({ dx: vx / len, dy: vy / len, width: c.width });
          if (back >= ARM_MIN_RUN) arms.push({ dx: -vx / len, dy: -vy / len, width: c.width });
        }
        raw.push({ x, y, r: Math.max(ca.width, cb.width) / 2, arms });
      }
    }
  }

  // Merge the pairwise answers into junctions. Union-find over a coarse grid,
  // so a corner where three courses meet is one place with three arms rather
  // than three places with two.
  const parent = raw.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    for (let j = i; (parent[j] as number) !== r; ) {
      const next = parent[j] as number;
      parent[j] = r;
      j = next;
    }
    return r;
  };
  const grid = new Map<number, number[]>();
  raw.forEach((c, i) => {
    const key = (Math.floor(c.y / CELL) << 12) | Math.floor(c.x / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nk = key + (dy << 12) + dx;
        for (const j of grid.get(nk) ?? []) {
          const o = raw[j] as CourseCrossing;
          const reach = Math.max(c.r, o.r);
          if (Math.hypot(c.x - o.x, c.y - o.y) > reach) continue;
          const a = find(i);
          const b = find(j);
          if (a !== b) parent[a] = b;
        }
      }
    }
    const bag = grid.get(key);
    if (bag === undefined) grid.set(key, [i]);
    else bag.push(i);
  });

  const groups = new Map<number, number[]>();
  raw.forEach((_, i) => {
    const k = find(i);
    const bag = groups.get(k);
    if (bag === undefined) groups.set(k, [i]);
    else bag.push(i);
  });

  const out: CourseCrossing[] = [];
  for (const bag of groups.values()) {
    let sx = 0;
    let sy = 0;
    let r = 0;
    const arms: CourseCrossing['arms'] = [];
    for (const i of bag) {
      const c = raw[i] as CourseCrossing;
      sx += c.x;
      sy += c.y;
      r = Math.max(r, c.r);
      for (const arm of c.arms) {
        // The same way out, found twice by two pairs of segments, is one arm
        // — and it is the WIDER course that decides how much of the mouth
        // gets furniture.
        const same = arms.find((o) => o.dx * arm.dx + o.dy * arm.dy >= ARM_MERGE_COS);
        if (same) same.width = Math.max(same.width, arm.width);
        else arms.push({ ...arm });
      }
    }
    out.push({ x: sx / bag.length, y: sy / bag.length, r, arms });
  }
  // Row-major, so every host walks them in the same order.
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

/**
 * The junction discs alone: what a painter punches out of a stroke.
 *
 * Kept as its own name because that is all most callers want, and because a
 * disc is the whole answer to "is this tile inside a junction".
 */
export function courseJunctions(
  courses: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]>; width: number }>,
): Array<{ x: number; y: number; r: number }> {
  return courseCrossings(courses).map((c) => ({ x: c.x, y: c.y, r: c.r }));
}

/**
 * Distance to the nearest point on a set of rings, as a function — exact out
 * to `limit`, and reported as `limit` beyond it.
 *
 * The shore band — quay and beach — was decided by neighbour tests on the
 * tile plane, so its inner edge was 100% axis-aligned while the waterline in
 * front of it was 19.7% (§38). This is the field that fixes it: distance to
 * the coast is smooth everywhere and exact, so its contours are curves for the
 * same reason the coast's own contour is one.
 *
 * Segments are bucketed by a coarse grid and searched outward ring by ring of
 * cells, stopping once the best distance found cannot be beaten by a further
 * ring — so a query costs a handful of segment tests rather than three
 * thousand.
 *
 * `limit` is what makes that bound hold everywhere rather than only near the
 * coast. In the middle of a landmass there is no segment to find, so the ring
 * search expands until it meets one, and at half-tile sampling that is 2.4
 * million searches across the whole map. Every caller is asking about a band a
 * few tiles wide, so past `limit` the exact number is not information anybody
 * uses — only its sign, which "at least this far" gives.
 */
export function ringDistance(
  rings: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]> }>,
  W: number,
  H: number,
  cell = 8,
  limit = 8,
): (x: number, y: number) => number {
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const bucket: number[][] = Array.from({ length: cols * rows }, () => []);
  const seg: number[] = [];
  for (const r of rings) {
    const p = r.points;
    for (let k = 0; k < p.length; k++) {
      const [ax, ay] = p[k] as readonly [number, number];
      const [bx, by] = p[(k + 1) % p.length] as readonly [number, number];
      const s = seg.length;
      seg.push(ax, ay, bx, by);
      const c0 = Math.max(0, Math.floor(Math.min(ax, bx) / cell));
      const c1 = Math.min(cols - 1, Math.floor(Math.max(ax, bx) / cell));
      const r0 = Math.max(0, Math.floor(Math.min(ay, by) / cell));
      const r1 = Math.min(rows - 1, Math.floor(Math.max(ay, by) / cell));
      for (let ry = r0; ry <= r1; ry++) {
        for (let rx = c0; rx <= c1; rx++) (bucket[ry * cols + rx] as number[]).push(s);
      }
    }
  }
  const d2ToSeg = (x: number, y: number, s: number): number => {
    const ax = seg[s] as number;
    const ay = seg[s + 1] as number;
    const vx = (seg[s + 2] as number) - ax;
    const vy = (seg[s + 3] as number) - ay;
    const l2 = vx * vx + vy * vy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
    const dx = x - ax - t * vx;
    const dy = y - ay - t * vy;
    return dx * dx + dy * dy;
  };
  // Beyond this the answer is reported as `limit` rather than searched for.
  // Without it a point in the middle of a landmass expands the ring search
  // over the whole map before it finds a coast — which is fine once per tile
  // and ruinous at half-tile sampling, where it turned one layout into a
  // minute and a half. Every caller only cares about the first few tiles.
  const stopAt = Math.ceil(limit / cell) + 1;
  // Cells with a segment in them or beside them. A point whose own cell and
  // all eight neighbours are empty is at least one WHOLE cell from anything —
  // the point is inside the middle cell, so the block reaches a full cell past
  // it in every direction — which is the far case answered in one array read
  // instead of twenty-five bucket lookups. It needs `limit <= cell` to be
  // sound, so the limit is clamped to that.
  const reach = Math.min(limit, cell);
  const near = new Uint8Array(cols * rows);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      if ((bucket[ry * cols + rx] as number[]).length === 0) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = ry + dy;
          const nx = rx + dx;
          if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
          near[ny * cols + nx] = 1;
        }
      }
    }
  }
  return (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(cols - 1, Math.floor(x / cell)));
    const cy = Math.max(0, Math.min(rows - 1, Math.floor(y / cell)));
    if (near[cy * cols + cx] === 0) return reach;
    let best = Infinity;
    for (let ring = 0; ring <= stopAt && ring < Math.max(cols, rows); ring++) {
      // Once the nearest possible point in the next ring of cells is further
      // than what we have, we are done.
      if (best < Infinity && (ring - 1) * cell * ((ring - 1) * cell) > best) break;
      let any = false;
      for (let ry = cy - ring; ry <= cy + ring; ry++) {
        if (ry < 0 || ry >= rows) continue;
        for (let rx = cx - ring; rx <= cx + ring; rx++) {
          if (rx < 0 || rx >= cols) continue;
          // Only the shell of the square, not its interior — the interior was
          // covered by the previous ring.
          if (ring > 0 && rx !== cx - ring && rx !== cx + ring && ry !== cy - ring && ry !== cy + ring) {
            continue;
          }
          any = true;
          for (const s of bucket[ry * cols + rx] as number[]) {
            const d = d2ToSeg(x, y, s);
            if (d < best) best = d;
          }
        }
      }
      if (!any && best < Infinity) break;
    }
    if (best === Infinity) return reach;
    const d = Math.sqrt(best);
    return d > reach ? reach : d;
  };
}
