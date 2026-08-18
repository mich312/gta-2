import { diagonalRoadDir } from './marks.js';
import { T_BRIDGE, T_FIELD, T_PARK, T_ROAD, T_SAND, T_SIDEWALK, T_TREES, T_WATER, TILE_SIZE } from './types.js';

/**
 * Half-tile bevels: the diagonal, finally in the ground itself.
 *
 * Everything in this city is orthogonal because the tile grid is, and the
 * places it hurts most are the places nature draws the line — a coast
 * rasterises to a staircase of 16 px right angles, and a beach that the
 * water field drew as a curve arrives on screen as Lego. The genre's own
 * answer is older than this project: GTA2's map format had diagonal block
 * types precisely so shores and corners could run at 45°. This module is
 * that block type, grown locally.
 *
 * A bevel is one byte per tile saying "one half of this tile, cut corner to
 * corner, belongs to the neighbouring material". The tile plane itself is
 * untouched — `tiles` still says T_WATER or T_SAND and every pass that reads
 * it keeps its answer — but the renderers paint the cut half as the
 * neighbour, and collision treats the diagonal as the wall. A stair-stepped
 * waterline becomes a true 45° line you can walk (or moor) along.
 *
 * Where it applies, and where it deliberately does not:
 *
 * - **Soft ground only.** Water against sand, meadow and park grass; the
 *   beach's own back line against the grass behind it. These are the edges
 *   nature drew, and nature does not do right angles at 16 px.
 * - **And one built edge: the kerb of a diagonal avenue.** The carved
 *   diagonal bands (the ring road, the curved arterials) stair-step, and
 *   their kerbs stair-step with them; the sidewalk yields its step corners
 *   to the carriageway wherever `diagonalRoadDir` says the road mass
 *   genuinely runs at 45° — and nowhere else, so every square junction
 *   corner in the city stays the square it was drawn as.
 * - **Built and sheer edges stay square.** A quay (`T_BANK`) is coursed
 *   masonry; a bridge is a deck; a cliff (the sheer-shore `T_TREES` wall) is
 *   rock; a building is a building. Squareness is what makes them read as
 *   *built*, so the pass never touches them. Woodland edges inland are left
 *   square too, for now — the 3D canopy is a box, and opening its corner to
 *   walkers would let them vanish under it (see WORLDGEN.md §15).
 *
 * The pass is a pure function of the finished tile plane: no rng, no
 * authored input, derived after the last pass that carves a tile. That is
 * the placement doctrine's favourite kind of change — it moves nobody's
 * city, and both hosts compute the identical plane from the identical bytes.
 */

/** No bevel: the tile is all one material. The overwhelming default. */
export const BEV_NONE = 0;
/** The NE half (above the NW–SE diagonal) belongs to the neighbour. */
export const BEV_NE = 1;
/** The SE half (below the NE–SW diagonal) belongs to the neighbour. */
export const BEV_SE = 2;
/** The SW half (below the NW–SE diagonal) belongs to the neighbour. */
export const BEV_SW = 3;
/** The NW half (above the NE–SW diagonal) belongs to the neighbour. */
export const BEV_NW = 4;

export type BevelCode = 0 | 1 | 2 | 3 | 4;

/**
 * Corner geometry, one row per code: the two orthogonal neighbours that meet
 * at the corner (whose shared material the cut half adopts), the diagonal
 * neighbour behind it, and the two opposite orthogonals used by the guard.
 * Order is [n1x, n1y, n2x, n2y, dx, dy, o1x, o1y, o2x, o2y].
 */
const CORNERS: ReadonlyArray<ReadonlyArray<number>> = [
  /* BEV_NE */ [0, -1, 1, 0, 1, -1, 0, 1, -1, 0],
  /* BEV_SE */ [0, 1, 1, 0, 1, 1, 0, -1, -1, 0],
  /* BEV_SW */ [0, 1, -1, 0, -1, 1, 0, -1, 1, 0],
  /* BEV_NW */ [0, -1, -1, 0, -1, -1, 0, 1, 1, 0],
];

/**
 * Who yields a corner to whom.
 *
 * Phase 1 — the water yields to the land it laps against, and the beach
 * yields to the grass behind it. On a rasterised 45° line the staircase's
 * inner corners all live on one side of the boundary, so cutting that side
 * alone turns the whole staircase into a clean diagonal.
 *
 * Phase 2 — the land yields to the water, which is what rounds a headland:
 * a convex 90° corner of ground with open water on both faces has no
 * water-side tile to cut, so the chamfer has to come off the land. Phase 2
 * is suppressed wherever phase 1 already smoothed the same corner, because
 * cutting both sides of one staircase step recedes the coast twice and
 * leaves a half-tile spit of land floating against the water cut (found by
 * the first test that drew a plain staircase).
 */
const YIELDS_P1: ReadonlyArray<readonly [number, number]> = [
  [T_WATER, T_SAND],
  [T_WATER, T_FIELD],
  [T_WATER, T_PARK],
  // The wooded shore (§15.4 step 2). One-directional on purpose, and the
  // direction is the whole trick: the WATER yields, so the canopy simply
  // overhangs the cut — cutting the trees toward the water instead would
  // open a hole in the ground under a canopy box that draws square in 3D.
  // Land movers never notice (trees and water are both walls, so the bevel
  // collapses to FULL); this pair exists for the boats, which get a 45°
  // cliff face to slide along instead of a staircase to snag on. The
  // cliff's own convex headlands stay square — that would need the
  // trees-side cut this pair deliberately refuses.
  [T_WATER, T_TREES],
  // The bridge deck (§31). Same one-directional trick as the wooded shore:
  // the WATER yields, so the deck overhangs its own cut and a diagonal
  // crossing reads as a ramp rather than a flight of stairs. Cutting the deck
  // instead would open a hole in a carriageway. This is the one BUILT edge
  // the pass bevels besides a diagonal avenue's kerb, and for the same
  // reason — the thing is genuinely running at 45° and its rasterisation is
  // the only reason it steps.
  [T_WATER, T_BRIDGE],
  [T_SAND, T_FIELD],
  [T_SAND, T_PARK],
];
const YIELDS_P2: ReadonlyArray<readonly [number, number]> = [
  [T_SAND, T_WATER],
  [T_FIELD, T_WATER],
  [T_PARK, T_WATER],
  // The grass's own convex corners against the beach, same logic as the
  // headland: the backline's staircase is smoothed from the sand side, but a
  // square grass corner jutting into open sand has no sand-side stair to cut.
  [T_FIELD, T_SAND],
  [T_PARK, T_SAND],
];

/**
 * The pair tables as flat lookups, because this pass reads five neighbours
 * of half a million tiles and a Set hash per candidate made it a 110 ms
 * pass on the full city. Tile ids fit in four bits (`T_RUNWAY` is 13), so a
 * pair is one byte index and "does this material yield to anything at all"
 * is the one-read reject that skips the road, the blocks and the open sea.
 */
function pairTable(pairs: ReadonlyArray<readonly [number, number]>): [Uint8Array, Uint8Array] {
  const allow = new Uint8Array(256);
  const any = new Uint8Array(16);
  for (const [a, b] of pairs) {
    allow[(a << 4) | b] = 1;
    any[a] = 1;
  }
  return [allow, any];
}
const [P1, P1_ANY] = pairTable(YIELDS_P1);
const [P2, P2_ANY] = pairTable(YIELDS_P2);

/**
 * Derive the bevel plane from a finished tile plane.
 *
 * A tile is bevelled at a corner when the two orthogonal neighbours meeting
 * there AND the diagonal behind them are all one material the tile yields
 * to, and neither opposite orthogonal is that material (a tile with the
 * other material on three sides is a tip, and cutting a tip makes a point
 * where the map meant a finger). One bevel per tile, first qualifying
 * corner wins, in NE→SE→SW→NW order — a tile that could cut two opposite
 * corners is a one-tile diagonal strand, and keeping one square corner
 * keeps it visibly a strand.
 *
 * Two passes, both reading the ORIGINAL tiles, so the result is independent
 * of scan order; phase 2 additionally reads phase 1's output (never its
 * own) for the suppression rule above.
 */
export function deriveBevels(tiles: Uint8Array, W: number, H: number): Uint8Array {
  const bevel = new Uint8Array(W * H);
  // Each corner's five neighbours as flat index offsets, once per call.
  const n1 = new Int32Array(4);
  const n2 = new Int32Array(4);
  const dg = new Int32Array(4);
  const o1 = new Int32Array(4);
  const o2 = new Int32Array(4);
  for (let c = 0; c < 4; c++) {
    const k = CORNERS[c] as ReadonlyArray<number>;
    n1[c] = (k[1] as number) * W + (k[0] as number);
    n2[c] = (k[3] as number) * W + (k[2] as number);
    dg[c] = (k[5] as number) * W + (k[4] as number);
    o1[c] = (k[7] as number) * W + (k[6] as number);
    o2[c] = (k[9] as number) * W + (k[8] as number);
  }

  const scan = (allow: Uint8Array, any: Uint8Array, suppress: Uint8Array | null): void => {
    for (let y = 1; y < H - 1; y++) {
      const rowEnd = y * W + W - 1;
      for (let i = y * W + 1; i < rowEnd; i++) {
        if (bevel[i] !== BEV_NONE) continue;
        const a = tiles[i] as number;
        if (any[a] === 0) continue;
        for (let c = 0; c < 4; c++) {
          const b = tiles[i + (n1[c] as number)] as number;
          if (b === a || allow[(a << 4) | b] === 0) continue;
          if (tiles[i + (n2[c] as number)] !== b) continue;
          if (tiles[i + (dg[c] as number)] !== b) continue;
          if (tiles[i + (o1[c] as number)] === b) continue;
          if (tiles[i + (o2[c] as number)] === b) continue;
          // Phase 2 cuts land toward water only where the water side did
          // not already smooth this corner: a corner neighbour carrying a
          // phase-1 bevel means this is a staircase step already handled,
          // not a headland.
          if (
            suppress &&
            (suppress[i + (n1[c] as number)] !== BEV_NONE ||
              suppress[i + (n2[c] as number)] !== BEV_NONE)
          ) {
            continue;
          }
          bevel[i] = c + 1;
          break;
        }
      }
    }
  };

  scan(P1, P1_ANY, null);
  scan(P2, P2_ANY, bevel.slice());

  // Phase 3 — the kerb along the diagonal avenues (§15.4 step 1). The
  // sidewalk yields its stair corners to the carriageway exactly as the
  // water yields to the land, but ONLY where the road mass around the
  // corner genuinely runs diagonal: ungated, the same corner test fires at
  // every square junction in the city — a block corner has road on two
  // orthogonal sides by construction — and chamfers the lot.
  //
  // `diagonalRoadDir` is the gate both renderers already trust for the
  // band's paint, and the cut's own diagonal must run WITH the band (an
  // 'se' band can only shed NE/SW halves): a corner whose hypotenuse would
  // cross the band is junction furniture, not a stair step.
  //
  // The gate computes through `atan2`, which the exact-op doctrine forbids
  // anywhere collision can read. It is admissible here and only here
  // because road and sidewalk are open in the same media — a kerb bevel can
  // never change a solidity answer, so a (theoretical) one-ulp host
  // disagreement could move a painted kerb pixel but never a body.
  //
  // Only the sidewalk side is cut, ever. Cutting the road's own convex
  // corners toward the pavement would paint kerbstones where the traffic
  // still drives its tile-grid lanes — cars clipping the footway is worse
  // than a square tooth of tarmac.
  const isRoad = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const t = tiles[y * W + x] as number;
    return t === T_ROAD || t === T_BRIDGE;
  };
  // The painter's cardinal test (RUN_ROAD in the 2D renderer, mirrored by
  // the 3D builder): a road run this long on either axis is a straight
  // street, whatever the covariance says. It has to be asked FIRST, because
  // the covariance gate alone lies at exactly the wrong place — the road
  // mass visible from a square crossroads corner is an L, and an L's
  // principal axis IS the diagonal.
  const CARDINAL_RUN = 8;
  const runShort = (x: number, y: number): boolean => {
    let h = 1;
    for (let s = 1; h < CARDINAL_RUN && isRoad(x - s, y); s++) h++;
    for (let s = 1; h < CARDINAL_RUN && isRoad(x + s, y); s++) h++;
    if (h >= CARDINAL_RUN) return false;
    let v = 1;
    for (let s = 1; v < CARDINAL_RUN && isRoad(x, y - s); s++) v++;
    for (let s = 1; v < CARDINAL_RUN && isRoad(x, y + s); s++) v++;
    return v < CARDINAL_RUN;
  };
  const dgx = new Int32Array(4);
  const dgy = new Int32Array(4);
  for (let c = 0; c < 4; c++) {
    const k = CORNERS[c] as ReadonlyArray<number>;
    dgx[c] = k[4] as number;
    dgy[c] = k[5] as number;
  }
  for (let y = 1; y < H - 1; y++) {
    const rowEnd = y * W + W - 1;
    for (let i = y * W + 1; i < rowEnd; i++) {
      if (bevel[i] !== BEV_NONE || tiles[i] !== T_SIDEWALK) continue;
      const x = i - y * W;
      for (let c = 0; c < 4; c++) {
        if (tiles[i + (n1[c] as number)] !== T_ROAD) continue;
        if (tiles[i + (n2[c] as number)] !== T_ROAD) continue;
        if (tiles[i + (dg[c] as number)] !== T_ROAD) continue;
        if (tiles[i + (o1[c] as number)] === T_ROAD) continue;
        if (tiles[i + (o2[c] as number)] === T_ROAD) continue;
        if (!runShort(x + (dgx[c] as number), y + (dgy[c] as number))) continue;
        const dir = diagonalRoadDir(isRoad, x, y);
        if (dir === null) continue;
        // c 0..3 is NE,SE,SW,NW; NE/SW hypotenuses run NW–SE, with an 'se'
        // band; SE/NW run NE–SW, with an 'ne' band.
        if (dir === 'se' ? c === 1 || c === 3 : c === 0 || c === 2) continue;
        bevel[i] = c + 1;
        break;
      }
    }
  }

  // Phase 4 — the kerb radius at a junction (§50).
  //
  // The doctrine above says built edges stay square and names the block
  // corner as the thing phase 3 must not touch. That was right about phase
  // 3, which was chasing a stair step and would have chamfered every corner
  // in the city as a side effect, and wrong about the corner itself: a kerb
  // at a crossroads is the one built edge that is NOT square anywhere,
  // because a vehicle turning into a side street sweeps a curve and the kerb
  // is cut back to let it. §49 measured the consequence — not one of this
  // city's 1,312 bevels lay against a road tile, so all 779 junctions had
  // four square notches — and a square notch is exactly what a junction
  // looks like when nobody has thought about the turn.
  //
  // The cut is the corner tile's own half, and it is the SIDEWALK that
  // yields, never the carriageway: opening the pavement to the tarmac widens
  // the mouth, which is what a radius does. The gate is what makes this
  // different from phase 3's ungated version — the diagonal neighbour must
  // be junction tarmac, road running the painter's `RUN_ROAD` in BOTH axes,
  // which is true at a crossroads and false at every driveway, layby and
  // stair step in the city.
  const junctionTile = (x: number, y: number): boolean => {
    if (!isRoad(x, y)) return false;
    let h = 1;
    for (let s = 1; h < CARDINAL_RUN && isRoad(x - s, y); s++) h++;
    for (let s = 1; h < CARDINAL_RUN && isRoad(x + s, y); s++) h++;
    if (h < CARDINAL_RUN) return false;
    let v = 1;
    for (let s = 1; v < CARDINAL_RUN && isRoad(x, y - s); s++) v++;
    for (let s = 1; v < CARDINAL_RUN && isRoad(x, y + s); s++) v++;
    return v >= CARDINAL_RUN;
  };
  for (let y = 1; y < H - 1; y++) {
    const rowEnd = y * W + W - 1;
    for (let i = y * W + 1; i < rowEnd; i++) {
      if (bevel[i] !== BEV_NONE || tiles[i] !== T_SIDEWALK) continue;
      const x = i - y * W;
      for (let c = 0; c < 4; c++) {
        if (tiles[i + (n1[c] as number)] !== T_ROAD) continue;
        if (tiles[i + (n2[c] as number)] !== T_ROAD) continue;
        if (tiles[i + (dg[c] as number)] !== T_ROAD) continue;
        if (tiles[i + (o1[c] as number)] === T_ROAD) continue;
        if (tiles[i + (o2[c] as number)] === T_ROAD) continue;
        if (!junctionTile(x + (dgx[c] as number), y + (dgy[c] as number))) continue;
        bevel[i] = c + 1;
        break;
      }
    }
  }

  return bevel;
}

/**
 * The material of a bevelled tile's cut half: what the corner's orthogonal
 * neighbours are made of. By construction they agree, so reading one is
 * reading both. BEV_NONE (or out of range) answers the tile's own material,
 * so callers can use this unconditionally.
 */
export function bevelOther(
  tiles: Uint8Array,
  bevel: Uint8Array,
  W: number,
  tx: number,
  ty: number,
): number {
  const i = ty * W + tx;
  const code = bevel[i] as number;
  if (code === BEV_NONE) return tiles[i] as number;
  const [n1x, n1y] = CORNERS[code - 1] as ReadonlyArray<number>;
  return tiles[(ty + (n1y as number)) * W + (tx + (n1x as number))] as number;
}

/**
 * Is a point inside the CUT half of its tile? `lx`/`ly` are local px within
 * the tile, 0 (west/north edge) to TILE_SIZE. The diagonal itself belongs to
 * the base material — strict inequalities — so an unbevelled reading and a
 * bevelled one agree on the boundary.
 */
export function inCutHalf(code: number, lx: number, ly: number): boolean {
  switch (code) {
    case BEV_NE:
      return lx > ly;
    case BEV_SW:
      return lx < ly;
    case BEV_SE:
      return lx + ly > TILE_SIZE;
    case BEV_NW:
      return lx + ly < TILE_SIZE;
    default:
      return false;
  }
}

/**
 * The opposite half's code — which half the BASE material keeps. Handy for
 * collision, where "which half is solid" flips with which side of the pair
 * is the solid one.
 */
export function oppositeHalf(code: number): number {
  switch (code) {
    case BEV_NE:
      return BEV_SW;
    case BEV_SW:
      return BEV_NE;
    case BEV_SE:
      return BEV_NW;
    case BEV_NW:
      return BEV_SE;
    default:
      return BEV_NONE;
  }
}
