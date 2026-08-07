import {
  T_BRIDGE,
  T_BUILDING,
  T_RAMP,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  type Building,
  type CityMap,
} from './types.js';
import { buildingStoreys } from './heights.js';

/**
 * The world as solid volumes rather than solid squares.
 *
 * The 2D collision this replaces asks one question per tile — "is it solid?" —
 * which cannot express the thing a 3D city is made of: a road you drive over
 * and a river you sail under, occupying the same square of ground. Today
 * `T_BRIDGE` fakes it by meaning "solid to boats, open to cars", which works
 * for exactly one case and collapses the moment anything else needs two
 * levels.
 *
 * Instead every tile carries a short stack of **spans**: half-open intervals
 * `[bottom, top)` of solid matter, sorted by bottom. You stand on a span's
 * top; you are blocked if your own vertical extent overlaps one. A bridge is
 * a column with earth far below, water surface, and a deck span at road
 * height with nothing but air between them — which is what lets a boat pass
 * under a car.
 *
 * Everything here is a pure function of the map, and the map is a pure
 * function of (seed, params), so the grid never goes on the wire and both
 * hosts build the identical thing. Exact ops only: this runs inside client
 * prediction, and `step()` has to stay bit-identical on any host
 * (ROADMAP.md §0, invariant 1).
 *
 * NOTE ON PHYSICS ENGINES. Rapier, Jolt and Ammo are all out, and not for
 * taste: none of them guarantees bit-identical results across platforms, and
 * this repo's replays, bot harness, host-parity gate and rewind/replay
 * reconciliation all depend on that. Deterministic 3D collision has to be
 * written, the way the 2D collision was written. That is what this is.
 */

/** Depth of the solid earth below any standing surface. Not a real bottom. */
export const EARTH = -4096;
/** World px per storey, for turning building heights into volumes. */
export const Z_PER_STOREY = 24;
/** Height of the bridge deck above the water surface. */
export const BRIDGE_DECK_Z = 40;
/** Thickness of a bridge deck: what a boat's mast would hit. */
export const BRIDGE_DECK_THICKNESS = 6;
/** How high a ramp tile lifts its surface. Stepped, not sloped — see below. */
export const RAMP_Z = 12;
/** Trees are solid to a mover but not to a helicopter passing overhead. */
export const TREE_Z = 36;
/**
 * Kerb height: how far the pavement stands above the carriageway.
 *
 * Real, not decorative. It is inside every mover's step-up allowance so
 * nobody is stopped by it, but it is what makes a street read as a street
 * rather than as a coloured stripe, and it is the surface a car mounting the
 * pavement actually climbs.
 */
export const KERB_Z = 3;

export interface Span {
  bottom: number;
  top: number;
}

/**
 * Flat-encoded span columns.
 *
 * One allocation per array rather than an array of arrays: 57,600 tiles at
 * 240×240, almost all of which have one or two spans. The offset/count pair
 * indexes into the shared bottoms/tops.
 */
export interface VolumeGrid {
  widthTiles: number;
  heightTiles: number;
  /** Index into bottoms/tops of this tile's first span. */
  offset: Int32Array;
  /** How many spans this tile has. */
  count: Uint8Array;
  bottoms: Float64Array;
  tops: Float64Array;
  /**
   * Surface height of the walkable ground per tile, for spawning and for
   * anything that wants "where is the street here" without a query.
   */
  ground: Float64Array;
  /**
   * The oriented walls of buildings CUT at an angle (VECTOR phase 4, §37).
   *
   * The tile columns above are the rasterisation of these rectangles, so they
   * already agree to within half a tile — which is exactly the error you feel
   * driving along a 22° wall: the tiles step, so the car catches on the
   * corners of its own building. These are the rectangle itself, tested after
   * the columns and never instead of them, so a wall is at worst what the
   * tiles said and at best the line the renderer draws.
   *
   * Flat numbers rather than objects, in one array, because this is read
   * inside `step()` and has to stay bit-identical on any host.
   */
  obb: ObbIndex;
}

/**
 * Oriented rectangles, bucketed by a coarse grid so a query touches a handful
 * rather than two thousand.
 */
export interface ObbIndex {
  /** Per rectangle: cx, cy, halfW, halfH, cos, sin, top — seven floats. */
  data: Float64Array;
  /** Bucket size in world px. */
  cell: number;
  cols: number;
  rows: number;
  /** Rectangle indices per bucket, flattened. */
  items: Int32Array;
  /** Where each bucket's run starts in `items`; `starts[n]` is the end. */
  starts: Int32Array;
}

/** Build the oriented-wall index from the buildings that were cut at an angle. */
export function buildObbIndex(map: CityMap, cell = TILE_SIZE * 4): ObbIndex {
  const cols = Math.ceil((map.widthTiles * TILE_SIZE) / cell);
  const rows = Math.ceil((map.heightTiles * TILE_SIZE) / cell);
  const cut: Building[] = [];
  for (const b of map.buildings) {
    if (b.mw === undefined || b.mh === undefined || (b.angle ?? 0) === 0) continue;
    cut.push(b);
  }
  const data = new Float64Array(cut.length * 7);
  const counts = new Int32Array(cols * rows + 1);
  const boxes: number[][] = [];
  for (let i = 0; i < cut.length; i++) {
    const b = cut[i] as Building;
    const rad = ((b.angle as number) * Math.PI) / 180;
    const cx = (b.x + b.w / 2) * TILE_SIZE;
    const cy = (b.y + b.h / 2) * TILE_SIZE;
    const hw = ((b.mw as number) / 2) * TILE_SIZE;
    const hh = ((b.mh as number) / 2) * TILE_SIZE;
    data[i * 7] = cx;
    data[i * 7 + 1] = cy;
    data[i * 7 + 2] = hw;
    data[i * 7 + 3] = hh;
    data[i * 7 + 4] = Math.cos(rad);
    data[i * 7 + 5] = Math.sin(rad);
    data[i * 7 + 6] = buildingStoreys(b) * Z_PER_STOREY;
    // Buckets the rectangle's bounding circle touches — cheap and exact
    // enough, since a miss only costs one SAT test.
    const r = Math.sqrt(hw * hw + hh * hh);
    const c0 = Math.max(0, Math.floor((cx - r) / cell));
    const c1 = Math.min(cols - 1, Math.floor((cx + r) / cell));
    const r0 = Math.max(0, Math.floor((cy - r) / cell));
    const r1 = Math.min(rows - 1, Math.floor((cy + r) / cell));
    const cells: number[] = [];
    for (let ry = r0; ry <= r1; ry++) {
      for (let rx = c0; rx <= c1; rx++) {
        const k = ry * cols + rx;
        cells.push(k);
        counts[k + 1] = (counts[k + 1] as number) + 1;
      }
    }
    boxes.push(cells);
  }
  const starts = new Int32Array(cols * rows + 1);
  for (let k = 0; k < cols * rows; k++) starts[k + 1] = (starts[k] as number) + (counts[k + 1] as number);
  const items = new Int32Array(starts[cols * rows] as number);
  const fill = new Int32Array(cols * rows);
  for (let i = 0; i < boxes.length; i++) {
    for (const k of boxes[i] as number[]) {
      items[(starts[k] as number) + (fill[k] as number)] = i;
      fill[k] = (fill[k] as number) + 1;
    }
  }
  return { data, cell, cols, rows, items, starts };
}

/**
 * Does an axis-aligned box overlap any oriented wall whose height covers it?
 *
 * Separating axes: the box's two and the rectangle's two. Plain arithmetic
 * throughout — no `hypot`, no trig at query time — because this runs inside
 * `step()` and has to be bit-identical on every host.
 */
export function obbBlocked(
  ix: ObbIndex,
  x: number,
  y: number,
  half: number,
  z0: number,
  z1: number,
): boolean {
  const { data, cell, cols, rows, items, starts } = ix;
  if (items.length === 0) return false;
  const c0 = Math.max(0, Math.floor((x - half) / cell));
  const c1 = Math.min(cols - 1, Math.floor((x + half) / cell));
  const r0 = Math.max(0, Math.floor((y - half) / cell));
  const r1 = Math.min(rows - 1, Math.floor((y + half) / cell));
  for (let ry = r0; ry <= r1; ry++) {
    for (let rx = c0; rx <= c1; rx++) {
      const k = ry * cols + rx;
      const from = starts[k] as number;
      const to = starts[k + 1] as number;
      for (let s = from; s < to; s++) {
        const i = (items[s] as number) * 7;
        const top = data[i + 6] as number;
        // A wall you are above, or entirely below, is not in the way.
        if (z0 >= top || z1 <= 0) continue;
        const dx = x - (data[i] as number);
        const dy = y - (data[i + 1] as number);
        const hw = data[i + 2] as number;
        const hh = data[i + 3] as number;
        const co = data[i + 4] as number;
        const si = data[i + 5] as number;
        // The box's extent projected onto the rectangle's axes, and the
        // rectangle's onto the world's. Overlap on all four means a hit.
        const ax = Math.abs(co) * half + Math.abs(si) * half;
        if (Math.abs(dx * co + dy * si) > hw + ax) continue;
        if (Math.abs(-dx * si + dy * co) > hh + ax) continue;
        const wx = hw * Math.abs(co) + hh * Math.abs(si);
        if (Math.abs(dx) > wx + half) continue;
        const wy = hw * Math.abs(si) + hh * Math.abs(co);
        if (Math.abs(dy) > wy + half) continue;
        return true;
      }
    }
  }
  return false;
}

/** The spans of one tile, in order. Outside the map: one infinite wall. */
export function spansAt(vg: VolumeGrid, tx: number, ty: number): Span[] {
  if (tx < 0 || ty < 0 || tx >= vg.widthTiles || ty >= vg.heightTiles) {
    return [{ bottom: EARTH, top: Infinity }];
  }
  const i = ty * vg.widthTiles + tx;
  const start = vg.offset[i] as number;
  const n = vg.count[i] as number;
  const out: Span[] = [];
  for (let s = 0; s < n; s++) {
    out.push({ bottom: vg.bottoms[start + s] as number, top: vg.tops[start + s] as number });
  }
  return out;
}

/**
 * Does a mover occupying `[z0, z1)` collide with this tile?
 *
 * Half-open on purpose: standing exactly on a surface (`z0 === span.top`) is
 * not a collision, or every mover would sink into the ground it is resting
 * on. The same convention makes a deck at 40 and a mover whose head reaches
 * exactly 40 pass cleanly underneath.
 */
export function blockedAt(
  vg: VolumeGrid,
  tx: number,
  ty: number,
  z0: number,
  z1: number,
): boolean {
  if (tx < 0 || ty < 0 || tx >= vg.widthTiles || ty >= vg.heightTiles) return true;
  const i = ty * vg.widthTiles + tx;
  const start = vg.offset[i] as number;
  const n = vg.count[i] as number;
  for (let s = 0; s < n; s++) {
    const bottom = vg.bottoms[start + s] as number;
    const top = vg.tops[start + s] as number;
    if (bottom < z1 && top > z0) return true;
  }
  return false;
}

/**
 * The highest solid surface at or below `z` — what a mover standing here
 * rests on. `-Infinity` when there is nothing under them at all (over water,
 * or off the edge of a bridge).
 */
export function supportUnder(vg: VolumeGrid, tx: number, ty: number, z: number): number {
  if (tx < 0 || ty < 0 || tx >= vg.widthTiles || ty >= vg.heightTiles) return Infinity;
  const i = ty * vg.widthTiles + tx;
  const start = vg.offset[i] as number;
  const n = vg.count[i] as number;
  let best = -Infinity;
  for (let s = 0; s < n; s++) {
    const top = vg.tops[start + s] as number;
    if (top <= z && top > best) best = top;
  }
  return best;
}

/**
 * The lowest solid ceiling strictly above `z`, or `Infinity` for open sky.
 * Used to check that a mover stepping up onto a surface has room to stand.
 */
export function ceilingAbove(vg: VolumeGrid, tx: number, ty: number, z: number): number {
  if (tx < 0 || ty < 0 || tx >= vg.widthTiles || ty >= vg.heightTiles) return z;
  const i = ty * vg.widthTiles + tx;
  const start = vg.offset[i] as number;
  const n = vg.count[i] as number;
  let best = Infinity;
  for (let s = 0; s < n; s++) {
    const bottom = vg.bottoms[start + s] as number;
    if (bottom >= z && bottom < best) best = bottom;
  }
  return best;
}

/** World-px convenience wrappers. */
export function supportUnderWorld(vg: VolumeGrid, x: number, y: number, z: number): number {
  return supportUnder(vg, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE), z);
}

/**
 * Build the volume grid for a map.
 *
 * Deterministic and total: every tile gets at least one span, so no query can
 * fall through a hole that only exists because a tile type was forgotten.
 */
export function buildVolumeGrid(map: CityMap): VolumeGrid {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const n = W * H;

  // Which building covers each tile, so a building's tiles share one height
  // rather than each rolling their own and producing a staircase.
  const heightOf = new Float64Array(n);
  for (const b of map.buildings) {
    const z = buildingStoreys(b) * Z_PER_STOREY;
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        heightOf[ty * W + tx] = z;
      }
    }
  }

  // Two passes: count spans to size the arrays, then fill. Avoids growing.
  const offset = new Int32Array(n);
  const count = new Uint8Array(n);
  const ground = new Float64Array(n);
  const columns: Span[][] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const col = columnFor(map, i, heightOf[i] as number);
    columns[i] = col.spans;
    ground[i] = col.ground;
    offset[i] = total;
    count[i] = col.spans.length;
    total += col.spans.length;
  }

  const bottoms = new Float64Array(total);
  const tops = new Float64Array(total);
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (const s of columns[i] as Span[]) {
      bottoms[k] = s.bottom;
      tops[k] = s.top;
      k++;
    }
  }

  return { widthTiles: W, heightTiles: H, offset, count, bottoms, tops, ground, obb: buildObbIndex(map) };
}

/**
 * One tile's column.
 *
 * Ramps are stepped rather than sloped. A sloped surface needs the collision
 * to interpolate within a tile, which is a different and larger change; a
 * step of 12 px is inside the step-up allowance, so a car drives up a ramp
 * smoothly enough to prove the model without it. Recorded here rather than
 * hidden: this is the first thing to revisit when ramps need to feel right.
 */
function columnFor(map: CityMap, i: number, buildingZ: number): { spans: Span[]; ground: number } {
  const tile = map.tiles[i];

  switch (tile) {
    case T_WATER:
      // Open water: earth far below, nothing to stand on at the surface. A
      // land mover walking in finds no support and starts to fall, which is
      // what "you cannot walk on water" means in a volume world.
      return { spans: [{ bottom: EARTH, top: -8 }], ground: -8 };

    case T_BRIDGE:
      // The case the flat grid could not express: water at the bottom, a deck
      // in the air, and clear space between them for a boat.
      return {
        spans: [
          { bottom: EARTH, top: -8 },
          { bottom: BRIDGE_DECK_Z, top: BRIDGE_DECK_Z + BRIDGE_DECK_THICKNESS },
        ],
        ground: BRIDGE_DECK_Z + BRIDGE_DECK_THICKNESS,
      };

    case T_BUILDING: {
      // Solid from the street to the roof. You are stopped by the wall at
      // ground level and can stand on the roof — which the 2D grid could not
      // represent at all, because "solid" had no top.
      const top = buildingZ > 0 ? buildingZ : Z_PER_STOREY;
      return { spans: [{ bottom: EARTH, top }], ground: top };
    }

    case T_TREES:
      // Solid to anything on the ground, open to anything above the canopy.
      return { spans: [{ bottom: EARTH, top: TREE_Z }], ground: TREE_Z };

    case T_RAMP:
      return { spans: [{ bottom: EARTH, top: RAMP_Z }], ground: RAMP_Z };

    case T_SIDEWALK:
      return { spans: [{ bottom: EARTH, top: KERB_Z }], ground: KERB_Z };

    default:
      // Road, park, lot, sand, runway, shop floor, field: street level,
      // walkable, open sky.
      return { spans: [{ bottom: EARTH, top: 0 }], ground: 0 };
  }
}
