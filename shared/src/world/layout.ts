import { latticeHash, valueNoise } from './fields.js';
import {
  meanderPolyline,
  pointInPoly,
  polyBounds,
  segmentDistance,
  smoothPolyline,
  type CityPlan,
  type PlanPoint,
  type PlanRoad,
  type PlanStroke,
} from './plan.js';
import {
  DISTRICT_TYPES,
  T_BANK,
  T_BRIDGE,
  T_FIELD,
  T_ROAD,
  T_SAND,
  T_TREES,
  T_WATER,
  type BlockRect,
  type DistrictType,
} from './types.js';

/**
 * The authored plan expanded into ground: land, water, districts, streets,
 * bridges, shores and the block rectangles the fill passes build in.
 *
 * Everything here is a pure function of the plan. The noise it uses is not
 * deciding *where* anything goes — the outlines do that — it is adding the
 * detail below the scale anybody would draw by hand, which is the difference
 * between a coastline and a polygon.
 */

/** A block, plus which authored landmark (if any) has claimed it. */
export interface LayoutBlock extends BlockRect {
  /** Index into `plan.landmarks`, or -1. A claimed block is not built on. */
  landmark: number;
  /** How solidly this block's borough is built up, 0..1. */
  density: number;
  /**
   * Which tiles of the rect the block actually is, row-major over w×h.
   *
   * A block stopped being a rectangle when the avenues did (WORLDGEN.md §13):
   * ground between streets is whatever shape the streets leave, so the rect
   * is only the bounding box and this says which of its tiles belong. The
   * fill passes consult it through `Ctx.within`; the bake drops it — the
   * wire format still carries plain rects, because nothing at runtime asks.
   */
  mask: Uint8Array;
  /**
   * The borough lattice's rotation in degrees, 0 for the screen axes. Tells
   * the bake which filler this block wants: an unrotated block keeps the
   * frontage-ring fill it always had; a rotated one is a parallelogram in
   * an axis-aligned box, and a ring around that box would build into the
   * street, so its fill follows the mask's own street frontage instead.
   */
  angle: number;
}

export interface CityLayout {
  widthTiles: number;
  heightTiles: number;
  tiles: Uint8Array;
  district: Uint8Array;
  blocks: LayoutBlock[];
  /** 1 where the geography says water, before roads bridged any of it. */
  water: Uint8Array;
  /** Which district entry owns each tile; -1 outside every borough. */
  owner: Int16Array;
  /** 1 on landmasses the plan says are cliff-bound. See PlanGeography. */
  sheer: Uint8Array;
  /** Street-grid bearing per tile, degrees 0..179; 0 on the screen axes. */
  bearing: Uint8Array;
}

const DISTRICT_IDX: Record<DistrictType, number> = Object.fromEntries(
  DISTRICT_TYPES.map((d, i) => [d, i]),
) as Record<DistrictType, number>;

const COAST_SEED = 0x1c0a57;
const MEANDER_SEED = 0x8172a;

/* ------------------------------------------------------------------ */
/* Land and water                                                      */
/* ------------------------------------------------------------------ */

/** Distance from every cell to the nearest cell of `want`, chamfer 3x3. */
function distanceField(mask: Uint8Array, want: number, W: number, H: number): Float32Array {
  const D = new Float32Array(W * H).fill(1e9);
  for (let i = 0; i < D.length; i++) if (mask[i] === want) D[i] = 0;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? 1e9 : (D[y * W + x] as number);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      D[y * W + x] = Math.min(
        D[y * W + x] as number,
        at(x - 1, y) + 1,
        at(x, y - 1) + 1,
        at(x - 1, y - 1) + 1.414,
        at(x + 1, y - 1) + 1.414,
      );
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      D[y * W + x] = Math.min(
        D[y * W + x] as number,
        at(x + 1, y) + 1,
        at(x, y + 1) + 1,
        at(x + 1, y + 1) + 1.414,
        at(x - 1, y + 1) + 1.414,
      );
    }
  }
  return D;
}

/** Separable box blur. Rounds the corners off an authored polygon. */
function blurField(field: Float32Array, r: number, W: number, H: number): Float32Array {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const cx = (v: number): number => (v < 0 ? 0 : v >= W ? W - 1 : v);
  const cy = (v: number): number => (v < 0 ? 0 : v >= H ? H - 1 : v);
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += field[y * W + cx(x)] as number;
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / (2 * r + 1);
      acc += (field[y * W + cx(x + r + 1)] as number) - (field[y * W + cx(x - r)] as number);
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[cy(y) * W + x] as number;
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / (2 * r + 1);
      acc += (tmp[cy(y + r + 1) * W + x] as number) - (tmp[cy(y - r) * W + x] as number);
    }
  }
  return out;
}

/** Widen a stroke from w0 to w1 along its length; is (x, y) inside it? */
function strokeHit(s: { points: PlanPoint[]; w0: number; w1: number }, x: number, y: number): boolean {
  for (let k = 0; k + 1 < s.points.length; k++) {
    const [ax, ay] = s.points[k] as PlanPoint;
    const [bx, by] = s.points[k + 1] as PlanPoint;
    const u = k / Math.max(1, s.points.length - 2);
    const w = s.w0 + (s.w1 - s.w0) * u;
    if (segmentDistance(x, y, ax, ay, bx, by) < w / 2) return true;
  }
  return false;
}

/** Dilate (grow) or erode (shrink) a mask by a disc of radius r. */
function morph(
  mask: Uint8Array,
  r: number,
  grow: boolean,
  W: number,
  H: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let hit = grow ? 0 : 1;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
        let done = false;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx;
          const v = mask[ny * W + nx];
          if (grow && v === 1) {
            hit = 1;
            done = true;
            break;
          }
          if (!grow && v === 0) {
            hit = 0;
            done = true;
            break;
          }
        }
        if (done) break;
      }
      out[y * W + x] = hit;
    }
  }
  return out;
}

/** Flip runs of `want` smaller than `minTiles`. Kills specks and puddles. */
function despeckle(mask: Uint8Array, want: number, minTiles: number, W: number, H: number): void {
  const seen = new Uint8Array(W * H);
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] === 1 || mask[start] !== want) continue;
    const bag = [start];
    seen[start] = 1;
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
        if (seen[j] === 1 || mask[j] !== want) continue;
        seen[j] = 1;
        bag.push(j);
      }
    }
    if (bag.length < minTiles) for (const i of bag) mask[i] = want === 1 ? 0 : 1;
  }
}

interface Coast {
  water: Uint8Array;
  /** Shore normal dotted with the swell: +1 fully exposed, -1 sheltered. */
  exposure: Float32Array;
}

/**
 * The coastline: an authored outline, turned into a distance field, then
 * displaced by a vector domain warp.
 *
 * A raster of the outline alone has power at exactly one scale — the one the
 * outline was drawn at — and the eye reads that instantly as a drawing. A
 * real coast has structure at every scale, which is the whole content of the
 * "how long is a coastline" result. Warping the SAMPLE POINT rather than the
 * threshold is what keeps the authored silhouette recognisable while making
 * its edge sinuous all the way down: the island is still where somebody put
 * it, and its shore is no longer a polygon.
 *
 * The one asymmetry — damping the warp where the shore faces the swell — is
 * worth more than another octave. Waves plane a windward coast straight and
 * leave a sheltered one full of inlets, and a coast that is equally ragged
 * all the way round looks generated no matter how good the noise is.
 */
function paintCoast(plan: CityPlan): Coast {
  const W = plan.widthTiles;
  const H = plan.heightTiles;
  const g = plan.geography;

  const rivers: PlanStroke[] = g.rivers.map((r) => ({
    ...r,
    points: r.meander > 0 ? meanderPolyline(r.points, MEANDER_SEED, r.meander, 4, latticeHash) : r.points,
  }));
  const spits: PlanStroke[] = g.spits.map((s) => ({
    ...s,
    points: s.meander > 0 ? meanderPolyline(s.points, MEANDER_SEED ^ 0x99, s.meander, 3, latticeHash) : s.points,
  }));

  // The MAIN landmasses only. Islets and spits are added after the warp: a
  // twenty-tile rock cannot have forty-tile bays bitten out of it, and a warp
  // sized for a coastline simply washes one away.
  const base = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let land = false;
      for (const island of g.islands) if (pointInPoly(island, x, y)) { land = true; break; }
      if (land) for (const b of g.bays) if (pointInPoly(b, x, y)) { land = false; break; }
      if (land) for (const l of g.lagoons) if (pointInPoly(l, x, y)) { land = false; break; }
      if (land) for (const r of rivers) if (strokeHit(r, x, y)) { land = false; break; }
      base[y * W + x] = land ? 1 : 0;
    }
  }

  const inland = distanceField(base, 0, W, H);
  const offshore = distanceField(base, 1, W, H);
  const raw = new Float32Array(W * H);
  for (let i = 0; i < raw.length; i++) raw[i] = base[i] === 1 ? (inland[i] as number) : -(offshore[i] as number);
  const sdf = blurField(raw, 4, W, H);

  const sample = (f: Float32Array, x: number, y: number): number => {
    const sx = x < 0 ? 0 : x >= W ? W - 1 : Math.round(x);
    const sy = y < 0 ? 0 : y >= H ? H - 1 : Math.round(y);
    return f[sy * W + sx] as number;
  };
  const [sxw, syw] = g.swell;
  const swellLen = Math.hypot(sxw, syw) || 1;
  const exposureAt = (x: number, y: number): number => {
    const gx = sample(sdf, x + 3, y) - sample(sdf, x - 3, y);
    const gy = sample(sdf, x, y + 3) - sample(sdf, x, y - 3);
    const len = Math.hypot(gx, gy) || 1;
    return -((gx / len) * (sxw / swellLen) + (gy / len) * (syw / swellLen));
  };

  // Four octaves, halving wavelength and amplitude from the plan's numbers.
  const octaves: Array<[number, number]> = [];
  for (let o = 0; o < 4; o++) octaves.push([g.wave / 2 ** o, g.warp / 2 ** o]);

  let land: Uint8Array<ArrayBuffer> = new Uint8Array(W * H);
  const exposure = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let wx = 0;
      let wy = 0;
      for (const [lam, amp] of octaves) {
        wx += (valueNoise(COAST_SEED ^ Math.imul(lam | 0, 2654435761), x / lam, y / lam) - 0.5) * 2 * amp;
        wy += (valueNoise(COAST_SEED ^ Math.imul(lam | 0, 40503), x / lam + 11.7, y / lam - 4.3) - 0.5) * 2 * amp;
      }
      const e = exposureAt(x, y);
      exposure[y * W + x] = e;
      const damp = 1 - 0.55 * Math.max(0, e);
      land[y * W + x] = sample(sdf, x + wx * damp, y + wy * damp) > 0 ? 1 : 0;
    }
  }

  // A coast is allowed to be ragged. It is not allowed to be confetti.
  land = morph(morph(land, 2, true, W, H), 2, false, W, H);
  land = morph(morph(land, 2, false, W, H), 2, true, W, H);
  despeckle(land, 1, 120, W, H);
  despeckle(land, 0, 60, W, H);

  // Now the small stuff, with a warp its own size: five tiles at a wavelength
  // of twenty-four, so a rock has a ragged edge and is still a rock.
  const fine = (x: number, y: number, salt: number): number =>
    (valueNoise(COAST_SEED ^ salt, x / 24, y / 24) - 0.5) * 10;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (land[y * W + x] === 1) continue;
      let add = false;
      for (const islet of g.islets) {
        const d = Math.hypot(x - islet.at[0], y - islet.at[1]);
        if (d < islet.radius + fine(x, y, 0x5a17)) { add = true; break; }
      }
      if (!add) {
        for (const s of spits) {
          if (strokeHit({ ...s, w0: s.w0 + fine(x, y, 0x2b17), w1: s.w1 + fine(x, y, 0x2b17) }, x, y)) {
            add = true;
            break;
          }
        }
      }
      if (add) land[y * W + x] = 1;
    }
  }

  const margin = g.margin;
  const water = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const edge = x < margin || y < margin || x >= W - margin || y >= H - margin;
      water[y * W + x] = edge || land[y * W + x] !== 1 ? 1 : 0;
    }
  }
  return { water, exposure };
}

/* ------------------------------------------------------------------ */
/* Roads                                                               */
/* ------------------------------------------------------------------ */

/** Whether a road may be carried across water here, along one axis. */
function bridgeable(
  water: Uint8Array,
  W: number,
  H: number,
  tx: number,
  ty: number,
  dx: number,
  dy: number,
  maxSpan: number,
): boolean {
  // Land within maxSpan in BOTH directions, or it is not a crossing: the open
  // sea has no far bank, so a road pointed at it simply stops.
  let ahead = false;
  let behind = false;
  for (let s = 1; s <= maxSpan; s++) {
    const x = Math.round(tx + dx * s);
    const y = Math.round(ty + dy * s);
    if (x < 0 || y < 0 || x >= W || y >= H) break;
    if (water[y * W + x] !== 1) {
      ahead = true;
      break;
    }
  }
  for (let s = 1; s <= maxSpan; s++) {
    const x = Math.round(tx - dx * s);
    const y = Math.round(ty - dy * s);
    if (x < 0 || y < 0 || x >= W || y >= H) break;
    if (water[y * W + x] !== 1) {
      behind = true;
      break;
    }
  }
  return ahead && behind;
}

export function buildLayout(plan: CityPlan): CityLayout {
  const W = plan.widthTiles;
  const H = plan.heightTiles;
  const { water, exposure } = paintCoast(plan);
  const tiles = new Uint8Array(W * H);
  const district = new Uint8Array(W * H).fill(DISTRICT_IDX.park);
  const owner = new Int16Array(W * H).fill(-1);
  for (let i = 0; i < tiles.length; i++) tiles[i] = water[i] === 1 ? T_WATER : T_FIELD;

  // Boroughs, in plan order: later polygons win, so an overlap is an edit
  // rather than an error. The bearing plane is written here too: every tile
  // a borough owns knows the angle its streets run at, so the passes that
  // stand cars at kerbs or walk "along the street" get the exact number the
  // lattice was carved with instead of estimating it from tarmac.
  const bearing = new Uint8Array(W * H);
  for (const [di, d] of plan.districts.entries()) {
    const idx = DISTRICT_IDX[d.district];
    const deg = ((Math.round(d.street.angle) % 180) + 180) % 180;
    const [bx0, by0, bx1, by1] = polyBounds(d.area);
    for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++) {
      for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++) {
        if (!pointInPoly(d.area, tx + 0.5, ty + 0.5)) continue;
        district[ty * W + tx] = idx;
        owner[ty * W + tx] = di;
        bearing[ty * W + tx] = deg;
      }
    }
  }

  /** Paint one tile of carriageway, bridging where a bridge is warranted. */
  const lay = (tx: number, ty: number, along: PlanPoint | null): void => {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;
    const i = ty * W + tx;
    if (water[i] !== 1) {
      tiles[i] = T_ROAD;
      return;
    }
    if (!along) return;
    if (bridgeable(water, W, H, tx, ty, along[0], along[1], plan.maxBridgeSpan)) tiles[i] = T_BRIDGE;
  };

  /**
   * Carve a road along a course, `width` tiles across, as a swept disc.
   *
   * A swept disc rather than a rasterised rectangle because these courses
   * turn: a road built out of axis-aligned rectangles has a notch at every
   * corner, and the whole reason the plan holds polylines is that its roads
   * are not axis-aligned.
   */
  const carveCourse = (points: PlanPoint[], width: number, bridges: boolean): void => {
    const half = width / 2;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k] as PlanPoint;
      const [bx, by] = points[k + 1] as PlanPoint;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      // The direction of travel, for the bridge span test: a road running
      // ALONG a river is a causeway, not a crossing.
      const dir: PlanPoint = [(bx - ax) / len, (by - ay) / len];
      const x0 = Math.floor(Math.min(ax, bx) - half - 1);
      const x1 = Math.ceil(Math.max(ax, bx) + half + 1);
      const y0 = Math.floor(Math.min(ay, by) - half - 1);
      const y1 = Math.ceil(Math.max(ay, by) + half + 1);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (segmentDistance(tx + 0.5, ty + 0.5, ax, ay, bx, by) > half) continue;
          lay(tx, ty, bridges ? dir : null);
        }
      }
    }
  };

  /** Offset a course sideways by `d` tiles, for a dual carriageway. */
  const offsetCourse = (points: PlanPoint[], d: number): PlanPoint[] =>
    points.map((p, i) => {
      const a = points[Math.max(0, i - 1)] as PlanPoint;
      const b = points[Math.min(points.length - 1, i + 1)] as PlanPoint;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [p[0] - ((b[1] - a[1]) / len) * d, p[1] + ((b[0] - a[0]) / len) * d] as PlanPoint;
    });

  for (const road of plan.roads) {
    const pts = road.curve ? smoothPolyline(road.points, 3) : road.points;
    if (road.median > 0) {
      const off = (road.median + road.width) / 2;
      carveCourse(offsetCourse(pts, off), road.width, road.bridges);
      carveCourse(offsetCourse(pts, -off), road.width, road.bridges);
    } else {
      carveCourse(pts, road.width, road.bridges);
    }
  }

  /* ---- street lattices, clipped to each borough's outline ---------- */

  const cuts = (start: number, extent: number, pitch: number, width: number): number[] => {
    const out = [start];
    if (pitch >= width + 3) {
      for (let p = start + pitch; p < start + extent - width; p += pitch) out.push(p);
    }
    return out;
  };

  /**
   * Is there already road under this proposed street, or right beside it?
   *
   * A lattice cut that lands a tile or two off an avenue does not read as two
   * streets: it reads as one very wide one, and the traffic model agrees —
   * `signals.isJunctionTile` calls tarmac that is over-wide across BOTH axes a
   * junction, so a five-tile band of road turns a whole avenue into one
   * enormous junction. A street CROSSING this one conflicts near the crossing
   * and nowhere else; one running ALONGSIDE conflicts the whole way down.
   */
  const doubledUp = (
    pos: number,
    from: number,
    to: number,
    width: number,
    vertical: boolean,
  ): boolean => {
    const CLEAR = 3;
    let conflicts = 0;
    let n = 0;
    for (let a = from; a < to; a += 3) {
      n++;
      for (let b = pos - CLEAR; b < pos + width + CLEAR; b++) {
        const tx = vertical ? b : a;
        const ty = vertical ? a : b;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = tiles[ty * W + tx] as number;
        if (t === T_ROAD || t === T_BRIDGE) {
          conflicts++;
          break;
        }
      }
    }
    return n > 0 && conflicts * 5 >= n * 2;
  };

  const blocks: LayoutBlock[] = [];
  const landmarkAt = (x: number, y: number, w: number, h: number): number => {
    for (const [li, l] of plan.landmarks.entries()) {
      const [lx, ly, lw, lh] = l.rect;
      if (lx < x + w && lx + lw > x && ly < y + h && ly + lh > y) return li;
    }
    return -1;
  };

  for (const [di, d] of plan.districts.entries()) {
    const [rx, ry, rx1, ry1] = polyBounds(d.area);
    const rw = rx1 - rx;
    const rh = ry1 - ry;
    const { pitchX, pitchY, width, alleyOver, angle } = d.street;
    const inThis = (tx: number, ty: number): boolean =>
      tx >= 0 && ty >= 0 && tx < W && ty < H && owner[ty * W + tx] === di;

    /** Carve a lattice line, but only over ground this borough owns. */
    const line = (x: number, y: number, w: number, h: number): void => {
      for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
        for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) {
          if (!inThis(tx, ty)) continue;
          lay(tx, ty, null);
        }
      }
    };
    /* ---- the lattice, on the borough's own axes (§13.4 `grid` fabric) --- */

    const th = (angle * Math.PI) / 180;
    const eux = Math.cos(th);
    const euy = Math.sin(th);
    // The rotated frame: u along the grid's east, v along its south.
    const cx = (rx + rx1) / 2;
    const cy = (ry + ry1) / 2;
    const toU = (x: number, y: number): number => (x - cx) * eux + (y - cy) * euy;
    const toV = (x: number, y: number): number => -(x - cx) * euy + (y - cy) * eux;

    /**
     * `doubledUp`, for a course that is not axis-aligned: sample along it,
     * probing only PERPENDICULAR to the line. Same conflict ratio and the
     * same reason as the axis test — a lattice line running alongside an
     * avenue reads as one very wide road. The probe must be a thin corridor,
     * not a box: a box counts every street this line merely CROSSES, and a
     * lattice whose two families cross each other every pitch then suppresses
     * one family entirely. A crossing conflicts near the crossing and
     * nowhere else; only a parallel road conflicts the whole way down.
     */
    /**
     * The roads that were already there when this borough's lattice began —
     * the avenues, the ring, a neighbour's streets across the seam. The
     * rotated lattice is suppressed against THESE and never against itself:
     * its own two families cross every pitch, and a crossing sampled at the
     * wrong phase reads as a conflict, which is how half of one family died
     * at random in the first bake. Two lines of the same lattice cannot run
     * alongside each other by construction — the pitch is wider than the
     * probe — so the only doubling a lattice line can commit is against a
     * road somebody else drew, and that is the snapshot's whole content.
     */
    const pre: Uint8Array | null = angle !== 0 ? tiles.slice() : null;
    const doubledUpCourse = (x1: number, y1: number, x2: number, y2: number): boolean => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const dx = (x2 - x1) / (len || 1);
      const dy = (y2 - y1) / (len || 1);
      const reach = width / 2 + 2;
      const was = pre as Uint8Array;
      let n = 0;
      let conflicts = 0;
      for (let s = 0; s <= len; s += 3) {
        const px = x1 + dx * s;
        const py = y1 + dy * s;
        if (!inThis(Math.round(px), Math.round(py))) continue;
        n++;
        let hit = false;
        for (let o = -reach; o <= reach && !hit; o += 1) {
          const tx = Math.round(px - dy * o);
          const ty = Math.round(py + dx * o);
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          const t = was[ty * W + tx] as number;
          if (t === T_ROAD || t === T_BRIDGE) hit = true;
        }
        if (hit) conflicts++;
      }
      // Suppressed only when it spends MOST of its run beside somebody
      // else's road. The axis test uses 40%, but an axis lattice line meets
      // an avenue at one angle for a short stretch; in a rotated borough the
      // avenues are the things that curve, and a lattice line can brush one
      // for a third of its length while being the only street the rest of
      // the borough has. Half is where "duplicate" stops being a judgement
      // call.
      return n > 0 && conflicts * 2 > n;
    };

    /** Carve one rotated lattice line: the band |coord - at| < width/2. */
    const carveLine = (at: number, alongU: boolean, lo: number, hi: number): void => {
      // Endpoints in map space, for the doubled-up sampling.
      const pt = (t: number): [number, number] =>
        alongU
          ? [cx + eux * t - euy * at, cy + euy * t + eux * at]
          : [cx + eux * at - euy * t, cy + euy * at + eux * t];
      const [x1, y1] = pt(lo);
      const [x2, y2] = pt(hi);
      if (doubledUpCourse(x1, y1, x2, y2)) return;
      const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - width));
      const xe = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + width));
      const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - width));
      const ye = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + width));
      for (let ty = y0; ty <= ye; ty++) {
        for (let tx = x0; tx <= xe; tx++) {
          if (!inThis(tx, ty)) continue;
          const c = alongU ? toV(tx + 0.5, ty + 0.5) : toU(tx + 0.5, ty + 0.5);
          if (Math.abs(c - at) < width / 2) lay(tx, ty, null);
        }
      }
    };

    const xs = angle === 0 ? cuts(rx, rw, pitchX, width) : [];
    const ys = angle === 0 ? cuts(ry, rh, pitchY, width) : [];
    if (angle === 0) {
      for (const x of xs) if (!doubledUp(x, ry, ry + rh, width, true)) line(x, ry, width, rh);
      for (const y of ys) if (!doubledUp(y, rx, rx + rw, width, false)) line(rx, y, rw, width);
    } else {
      // The borough bbox corners, projected into the rotated frame, bound
      // the lattice; every line is clipped to owned ground when it lands.
      let uMin = Infinity;
      let uMax = -Infinity;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (const [px, py] of [
        [rx, ry],
        [rx1, ry],
        [rx, ry1],
        [rx1, ry1],
      ] as const) {
        uMin = Math.min(uMin, toU(px, py));
        uMax = Math.max(uMax, toU(px, py));
        vMin = Math.min(vMin, toV(px, py));
        vMax = Math.max(vMax, toV(px, py));
      }
      if (pitchX >= width + 3) {
        for (let u = uMin + pitchX; u < uMax - width; u += pitchX) carveLine(u, false, vMin, vMax);
      }
      if (pitchY >= width + 3) {
        for (let v = vMin + pitchY; v < vMax - width; v += pitchY) carveLine(v, true, uMin, uMax);
      }
    }

    /**
     * Ground this block can be: the borough's own dry land, minus whatever
     * carriageway has already been carved through it — the lattice's, and
     * above all an authored avenue's.
     */
    const buildable = (tx: number, ty: number): boolean => {
      if (!inThis(tx, ty) || water[ty * W + tx] === 1) return false;
      const t = tiles[ty * W + tx] as number;
      return t !== T_ROAD && t !== T_BRIDGE;
    };

    /**
     * The connected pieces of an interstice's buildable ground.
     *
     * A block used to BE the lattice rect. But an avenue drawn through a
     * borough crosses the rects rather than bounding them, and a rect the
     * avenue cuts in two is two blocks: each side gets its own record, its
     * own bounding box, its own mask and its own fill, instead of one fill
     * straddling four lanes of road and scattering fragments on the far
     * side. Rects no road crosses come out exactly as before — one
     * component, the full rect, every tile of its ground a member — which
     * is what keeps this refactor invisible where the fabric is untouched
     * (WORLDGEN.md §13.6 step 2).
     */
    const componentsOf = (
      bx: number,
      by: number,
      bw: number,
      bh: number,
    ): Array<{ x: number; y: number; w: number; h: number; mask: Uint8Array }> => {
      const seen = new Uint8Array(bw * bh);
      const out: Array<{ x: number; y: number; w: number; h: number; mask: Uint8Array }> = [];
      for (let sy = by; sy < by + bh; sy++) {
        for (let sx = bx; sx < bx + bw; sx++) {
          const s = (sy - by) * bw + (sx - bx);
          if (seen[s] === 1 || !buildable(sx, sy)) continue;
          const bag = [s];
          seen[s] = 1;
          for (let q = 0; q < bag.length; q++) {
            const i = bag[q] as number;
            const lx = i % bw;
            const ly = (i - lx) / bw;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              const nx = lx + dx;
              const ny = ly + dy;
              if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
              const j = ny * bw + nx;
              if (seen[j] === 1 || !buildable(bx + nx, by + ny)) continue;
              seen[j] = 1;
              bag.push(j);
            }
          }
          if (bag.length < 4) continue; // dust, not a block
          let x0 = bw;
          let y0 = bh;
          let x1 = 0;
          let y1 = 0;
          for (const i of bag) {
            const lx = i % bw;
            const ly = (i - lx) / bw;
            x0 = Math.min(x0, lx);
            y0 = Math.min(y0, ly);
            x1 = Math.max(x1, lx);
            y1 = Math.max(y1, ly);
          }
          const w = x1 - x0 + 1;
          const h = y1 - y0 + 1;
          const mask = new Uint8Array(w * h);
          for (const i of bag) {
            const lx = i % bw;
            const ly = (i - lx) / bw;
            mask[(ly - y0) * w + (lx - x0)] = 1;
          }
          out.push({ x: bx + x0, y: by + y0, w, h, mask });
        }
      }
      // One piece means no road crossed the rect, and the block is the rect
      // it always was — full bounding box, so its fill seed and its frontage
      // geometry come out exactly as before this refactor, with the mask
      // only fencing off water and the neighbouring borough's ground. Tight
      // boxes are for the pieces an avenue actually made.
      if (out.length === 1) {
        const mask = new Uint8Array(bw * bh);
        for (let ly = 0; ly < bh; ly++) {
          for (let lx = 0; lx < bw; lx++) {
            if (seen[ly * bw + lx] === 1) mask[ly * bw + lx] = 1;
          }
        }
        return [{ x: bx, y: by, w: bw, h: bh, mask }];
      }
      return out;
    };

    if (angle !== 0) {
      // A rotated borough has no interstice arithmetic to lean on: its
      // blocks are simply the connected pieces of ground its lattice leaves,
      // over the whole borough at once. Step 2 made the fill mask-driven, so
      // the pieces being parallelograms costs nothing downstream.
      const comps = componentsOf(rx, ry, rw + 1, rh + 1);
      for (const c of comps) {
        // The alley, in the block's own frame: through the middle of the
        // piece, along whichever rotated axis the piece runs longest in —
        // the same rule the axis path applies, measured in u and v instead
        // of x and y. Carved after the piece is cut, so it stays a shortcut
        // through the block's yard rather than splitting it in two.
        if (alleyOver > 0) {
          let uLo = Infinity;
          let uHi = -Infinity;
          let vLo = Infinity;
          let vHi = -Infinity;
          let mx = 0;
          let my = 0;
          let n = 0;
          for (let ly = 0; ly < c.h; ly++) {
            for (let lx = 0; lx < c.w; lx++) {
              if (c.mask[ly * c.w + lx] !== 1) continue;
              const px = c.x + lx + 0.5;
              const py = c.y + ly + 0.5;
              uLo = Math.min(uLo, toU(px, py));
              uHi = Math.max(uHi, toU(px, py));
              vLo = Math.min(vLo, toV(px, py));
              vHi = Math.max(vHi, toV(px, py));
              mx += px;
              my += py;
              n++;
            }
          }
          // Both extents matter: a strip left where a lattice line was
          // suppressed is long enough for an alley and far too thin — an
          // alley through it leaves nothing but two rows of frontage, which
          // is corduroy, not a shortcut through a yard. Eight is frontage
          // both sides of the cut with a yard's worth left over.
          if (n > 0 && Math.max(uHi - uLo, vHi - vLo) >= alleyOver && Math.min(uHi - uLo, vHi - vLo) >= 8) {
            const alongU = uHi - uLo >= vHi - vLo;
            const gx = mx / n;
            const gy = my / n;
            const at = alongU ? toV(gx, gy) : toU(gx, gy);
            const lo = alongU ? uLo : vLo;
            const hi = alongU ? uHi : vHi;
            for (let ly = 0; ly < c.h; ly++) {
              for (let lx = 0; lx < c.w; lx++) {
                if (c.mask[ly * c.w + lx] !== 1) continue;
                const tx = c.x + lx;
                const ty = c.y + ly;
                const cu = alongU ? toU(tx + 0.5, ty + 0.5) : toV(tx + 0.5, ty + 0.5);
                const cv = alongU ? toV(tx + 0.5, ty + 0.5) : toU(tx + 0.5, ty + 0.5);
                if (cu >= lo && cu <= hi && Math.abs(cv - at) < 1) lay(tx, ty, null);
              }
            }
          }
        }
        blocks.push({
          x: c.x,
          y: c.y,
          w: c.w,
          h: c.h,
          district: d.district,
          rural: d.rural,
          landmark: d.rural ? -1 : landmarkAt(c.x, c.y, c.w, c.h),
          density: d.density,
          mask: c.mask,
          angle,
        });
      }
      continue;
    }

    for (let j = 0; j < ys.length; j++) {
      const by = (ys[j] as number) + width;
      const bh = (j + 1 < ys.length ? (ys[j + 1] as number) : ry + rh) - by;
      if (bh < 4) continue;
      for (let i = 0; i < xs.length; i++) {
        const bx = (xs[i] as number) + width;
        const bw = (i + 1 < xs.length ? (xs[i + 1] as number) : rx + rw) - bx;
        if (bw < 4) continue;
        // A block that is mostly bay, or mostly somebody else's borough, is
        // not a block.
        let mine = 0;
        for (let ty = by; ty < by + bh; ty++) {
          for (let tx = bx; tx < bx + bw; tx++) {
            if (inThis(tx, ty) && water[ty * W + tx] !== 1) mine++;
          }
        }
        if (mine * 5 < bw * bh * 2) continue;

        // The pieces are cut BEFORE the alley: an avenue makes two blocks of
        // a rect, an alley is a shortcut through the yard of one.
        const comps = componentsOf(bx, by, bw, bh);

        // A service alley through anything big enough to hide in. Blocks
        // without one are walls; blocks with one are a shortcut with a risk,
        // which is the whole of a foot chase.
        if (alleyOver > 0 && Math.max(bw, bh) >= alleyOver) {
          if (bw >= bh) line(bx + Math.floor(bw / 2) - 1, by, 2, bh);
          else line(bx, by + Math.floor(bh / 2) - 1, bw, 2);
        }

        // The landmark claim stays a decision about the WHOLE interstice:
        // a landmark standing across the avenue from a piece still needs
        // some block to carry the claim, or the bake stamps it before the
        // fill instead of after (see bakeCity on why urban landmarks must
        // come second). It goes to every piece whose box it overlaps, or to
        // the first piece if the avenue cut it away from all of them.
        const li = d.rural ? -1 : landmarkAt(bx, by, bw, bh);
        const lRect = li >= 0 ? (plan.landmarks[li] as { rect: [number, number, number, number] }).rect : null;
        let claimed = false;
        const pieces = comps.map((c) => {
          const overlaps =
            lRect !== null &&
            lRect[0] < c.x + c.w &&
            lRect[0] + lRect[2] > c.x &&
            lRect[1] < c.y + c.h &&
            lRect[1] + lRect[3] > c.y;
          if (overlaps) claimed = true;
          return { ...c, landmark: overlaps ? li : -1 };
        });
        if (li >= 0 && !claimed && pieces.length > 0) (pieces[0] as { landmark: number }).landmark = li;

        for (const p of pieces) {
          blocks.push({
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            district: d.district,
            rural: d.rural,
            landmark: p.landmark,
            density: d.density,
            mask: p.mask,
            angle: 0,
          });
        }
      }
    }
  }

  // No causeways. A bridge is a SHORT crossing, and "short" has to be
  // measured after the fact rather than trusted to the direction the road
  // happened to be pointing when it left the bank: a curved road crossing a
  // harbour has a segment somewhere that points along the water instead of
  // over it, finds land within the span on that heading, and lays a
  // hundred-tile causeway out to sea. Anything whose narrowest crossing is
  // wider than the plan allows goes back to being water, and the stub prune
  // below tidies up whatever road that stranded.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== T_BRIDGE) continue;
      const run = (dx: number, dy: number): number => {
        let n = 1;
        for (let s = 1; ; s++) {
          const x = tx + dx * s;
          const y = ty + dy * s;
          if (x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] !== 1) break;
          n++;
        }
        for (let s = 1; ; s++) {
          const x = tx - dx * s;
          const y = ty - dy * s;
          if (x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] !== 1) break;
          n++;
        }
        return n;
      };
      const shortest = Math.min(
        run(0, 1),
        run(1, 0),
        Math.round(run(1, 1) * 1.414),
        Math.round(run(1, -1) * 1.414),
      );
      if (shortest > plan.maxBridgeSpan) tiles[i] = T_WATER;
    }
  }

  // Which landmasses are cliff-bound. Flood-filled over the finished water
  // mask from the plan's seed points, so it is the island the author pointed
  // at however far the warp moved its shore.
  const sheerLand = new Uint8Array(W * H);
  if (plan.geography.cliffIslands.length > 0) {
    const seen = new Uint8Array(W * H);
    for (const [sx, sy] of plan.geography.cliffIslands) {
      const start = Math.round(sy) * W + Math.round(sx);
      if (water[start] === 1 || seen[start] === 1) continue;
      const bag = [start];
      seen[start] = 1;
      sheerLand[start] = 1;
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
          if (seen[j] === 1 || water[j] === 1) continue;
          seen[j] = 1;
          sheerLand[j] = 1;
          bag.push(j);
        }
      }
    }
  }
  const sheer = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < W && ty < H && sheerLand[ty * W + tx] === 1;

  /* ---- shores ------------------------------------------------------ */

  const wetAt = (tx: number, ty: number): boolean =>
    tx < 0 || ty < 0 || tx >= W || ty >= H ? false : water[ty * W + tx] === 1;
  const wetNear = (tx: number, ty: number, r: number): boolean => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if ((dx !== 0 || dy !== 0) && wetAt(tx + dx, ty + dy)) return true;
      }
    }
    return false;
  };
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== T_FIELD) continue;
      const d = DISTRICT_TYPES[district[i] as number] as DistrictType;
      // Sand is a low-energy deposit: it collects in the lee, and the town
      // walls its own waterfront whatever the weather. An exposed headland
      // gets rock, which here is the same quay tile — solid to hulls, open
      // to feet.
      const sandy = d === 'park' && (exposure[i] as number) < -0.15;
      const touching = wetAt(tx + 1, ty) || wetAt(tx - 1, ty) || wetAt(tx, ty + 1) || wetAt(tx, ty - 1);
      if (sheer(tx, ty)) {
        // Cliff: rock and scrub straight down to the water. Solid, so there
        // is no stepping ashore here from a boat.
        if (touching || wetNear(tx, ty, 2)) tiles[i] = T_TREES;
      } else if (touching) {
        tiles[i] = sandy ? T_SAND : T_BANK;
      } else if (sandy && wetNear(tx, ty, 2)) {
        tiles[i] = T_SAND;
      }
    }
  }

  // A street does not end in the sea. Carriageway that touches open water
  // becomes quay, unless it is the approach to a bridge.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== T_ROAD) continue;
      if (!(wetAt(tx + 1, ty) || wetAt(tx - 1, ty) || wetAt(tx, ty + 1) || wetAt(tx, ty - 1))) continue;
      const onBridge =
        tiles[i + 1] === T_BRIDGE ||
        tiles[i - 1] === T_BRIDGE ||
        (ty + 1 < H && tiles[i + W] === T_BRIDGE) ||
        (ty > 0 && tiles[i - W] === T_BRIDGE);
      // A quay is a place to step ashore. On a cliff coast there isn't one:
      // the lane stops at the rock.
      if (!onBridge) tiles[i] = sheer(tx, ty) ? T_TREES : T_BANK;
    }
  }

  // Orphan carriageway: scraps the quay pass leaves behind, and any length of
  // road stranded where the plan put no crossing. They are not streets —
  // nothing can drive off them — but they are road as far as the traffic model
  // is concerned, and an ambient car spawned on one can never get anywhere.
  const label = new Int32Array(W * H).fill(-1);
  const members: number[][] = [];
  const isRoad = (i: number): boolean => tiles[i] === T_ROAD || tiles[i] === T_BRIDGE;
  for (let start = 0; start < tiles.length; start++) {
    if (!isRoad(start) || (label[start] as number) >= 0) continue;
    const id = members.length;
    const bag = [start];
    label[start] = id;
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
        if ((label[j] as number) >= 0 || !isRoad(j)) continue;
        label[j] = id;
        bag.push(j);
      }
    }
    members.push(bag);
  }
  let biggest = 0;
  let roadTiles = 0;
  for (const [id, bag] of members.entries()) {
    roadTiles += bag.length;
    if (bag.length > (members[biggest] as number[]).length) biggest = id;
  }
  const kept = members.length > 0 ? (members[biggest] as number[]).length : 0;
  if (roadTiles > 0 && kept * 5 < roadTiles * 3) {
    throw new Error(
      `city plan: the road network is in pieces — the largest holds ${kept} of ${roadTiles} tiles`,
    );
  }
  for (const [id, bag] of members.entries()) {
    if (id === biggest) continue;
    for (const i of bag) tiles[i] = T_FIELD;
  }

  // ...and then the shore is finished again. Pruning a stranded street turns
  // it back into bare ground, and bare ground may not meet the sea: every
  // waterfront tile is quay or beach, which is what stops a block being built
  // flush against open water later on.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== T_FIELD) continue;
      if (!(wetAt(tx + 1, ty) || wetAt(tx - 1, ty) || wetAt(tx, ty + 1) || wetAt(tx, ty - 1))) continue;
      if (sheer(tx, ty)) {
        tiles[i] = T_TREES;
        continue;
      }
      const d = DISTRICT_TYPES[district[i] as number] as DistrictType;
      tiles[i] = d === 'park' && (exposure[i] as number) < -0.15 ? T_SAND : T_BANK;
    }
  }

  return { widthTiles: W, heightTiles: H, tiles, district, blocks, water, owner, sheer: sheerLand, bearing };
}
