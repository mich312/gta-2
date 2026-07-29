import {
  T_BRIDGE,
  T_BUILDING,
  T_RAMP,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  TILE_SIZE,
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

  return { widthTiles: W, heightTiles: H, offset, count, bottoms, tops, ground };
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
