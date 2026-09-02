import { shoreChains, type ShoreLike } from './geometry.js';
import { T_BRIDGE, T_WATER, TILE_SIZE } from './types.js';

/**
 * The coastline as a line through each tile it crosses, for collision
 * (WORLDGEN.md §43).
 *
 * §25 made the coast a curve and the water tiles its rasterisation, and both
 * renderers took the curve: the 2D painter cuts a tile with `shoreHalf`, the
 * 3D one punches its ground mask against the same chain. Collision did not,
 * so **the water you could see and the water you could drive into were
 * different shapes** — a car stopped a tile short of a waterline that had been
 * drawn diagonally across the square, or drove out onto sea the painter had
 * already coloured blue.
 *
 * **Why this is not the ported solver.** §41.4 tried moving one in from
 * elsewhere and withdrew it: that solver's rules were exact against rings
 * traced FROM a tile mask, and against contours of a FIELD they had to be
 * reconciled after the fact — which left 1.02% of movers resting inside
 * water where the tile solver leaves none. The lesson recorded there was that
 * the point test, the box test and the push have to be DERIVED TOGETHER from
 * one definition. So this supplies exactly one thing — the solid half-plane of
 * a tile — and `collide.ts` reads all three off it, the same way it already
 * reads all three off a bevel's 45° hypotenuse. A bevel is this with the
 * normal rounded to a diagonal; there is no second solver.
 *
 * **One line per tile, and when it declines.** `shoreChains` cuts the rings
 * into per-tile chains, and a chain can bend. Measured over the shipped city:
 * of 7,782 shore tiles, 5,833 have a single straight run, and the chord
 * through the chain's ends is within 0.1 tile of every interior point on
 * 99.8% of the rest. Where it is not — a chain that doubles back inside one
 * square, a cape thinner than a tile — this returns nothing for that tile and
 * the bevels handle it exactly as they do today. A cut that cannot be
 * described by one line is not described by one line.
 *
 * Deterministic: exact ops only (multiply, add, divide, `sqrt`), no rng, and
 * built from the baked rings, so both hosts derive the identical planes and it
 * never goes on the wire.
 */

/**
 * A chord shorter than this is not a crossing, it is a nick — the chain
 * enters and leaves through nearly the same point, and the line through its
 * ends says nothing about which side is which. Tile units.
 */
const MIN_CHORD = 0.25;
/**
 * How far a chain may stray from its own chord before one line stops
 * describing it. Tile units — a third of a tile, five world px.
 */
const MAX_BOW = 0.35;

export interface ShoreCut {
  /** Tile index to slot, for the tiles the coast crosses in one clean run. */
  slot: Map<number, number>;
  /**
   * The unit normal pointing INTO the water, and the offset it meets: a point
   * is WET where `nx * lx + ny * ly > c`, with `(lx, ly)` measured in px from
   * the tile's own top-left corner.
   *
   * px rather than tile units because that is what the movement solver works
   * in, and converting once here is one multiply that the hot path then never
   * does.
   */
  nx: Float64Array;
  ny: Float64Array;
  c: Float64Array;
}

/** Nothing to cut: a city with no coastline (a bare test fixture). */
const EMPTY: ShoreCut = {
  slot: new Map(),
  nx: new Float64Array(0),
  ny: new Float64Array(0),
  c: new Float64Array(0),
};

/**
 * The shore, per tile, as the half-plane that holds the water.
 *
 * Water is on the RIGHT of a ring's travel and the screen's y runs down, so
 * the wet side is where the cross product of the run with the offset comes out
 * positive — the same test the 3D ground mask applies texel by texel, so the
 * shape that stops a car is the shape that was punched out of the ground.
 */
export function buildShoreCut(
  shores: ReadonlyArray<ShoreLike> | undefined,
  W: number,
  H: number,
  /**
   * The tile grid, so the cut can decline at a bridge mouth. Optional only
   * so a bare fixture can omit it; the city always passes it.
   */
  tiles?: Uint8Array,
): ShoreCut {
  if (!shores || shores.length === 0) return EMPTY;
  const chains = shoreChains(shores, W, H);
  if (chains.size === 0) return EMPTY;

  const slot = new Map<number, number>();
  const nx: number[] = [];
  const ny: number[] = [];
  const c: number[] = [];
  for (const [tile, chain] of chains) {
    const n = chain.length / 2;
    if (n < 2) continue;
    if (tiles && bridgeMouth(tiles, W, H, tile)) continue;
    const ax = chain[0] as number;
    const ay = chain[1] as number;
    const bx = chain[2 * n - 2] as number;
    const by = chain[2 * n - 1] as number;
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len < MIN_CHORD) continue;
    // How far the chain bows away from its own chord. Distance to the LINE,
    // not the segment: the interior points lie between the ends by
    // construction, so the two agree, and the line form is three operations.
    let bow = 0;
    for (let k = 1; k < n - 1; k++) {
      const px = (chain[2 * k] as number) - ax;
      const py = (chain[2 * k + 1] as number) - ay;
      const d = Math.abs(px * vy - py * vx) / len;
      if (d > bow) bow = d;
    }
    if (bow > MAX_BOW) continue;

    // Wet where cross(v, p - a) > 0, i.e. vx*(py-ay) - vy*(px-ax) > 0, which
    // is `(-vy, vx) . p > (-vy, vx) . a`. Normalised so the normal is a unit
    // vector and `c` is a real distance, which is what lets the solver treat
    // the two components symmetrically.
    const ux = -vy / len;
    const uy = vx / len;
    slot.set(tile, nx.length);
    nx.push(ux);
    ny.push(uy);
    // In px from the tile corner: the chain is in tile units, so scaling the
    // offset by the tile size scales the whole equation with it.
    c.push((ux * ax + uy * ay) * TILE_SIZE);
  }

  return {
    slot,
    nx: Float64Array.from(nx),
    ny: Float64Array.from(ny),
    c: Float64Array.from(c),
  };
}

/**
 * A land tile a bridge deck touches: the road the deck continues, and the
 * pavement at the corner of the mouth.
 *
 * The coast curve is the smoothed outline of the water, and a deck is
 * carved over water, so the curve follows the bank to the deck's side, turns
 * along it — and, smoothed, rounds that corner straight across the mouth.
 * Measured on the shipped city: of 67 mouth columns a car could drive
 * straight at, 64 stopped dead, on a cut through the road tile before the
 * deck or, for the outer columns, through the pavement corner beside it that
 * a car's box overlaps by a pixel. The curve has no business at a mouth: a
 * land tile touching a deck is whole, and the bevels answer as they always
 * did. The water beside it keeps its own cut, so nothing opens onto the sea;
 * what is given up is a few px of drawn water at the corner of a quay that
 * a body can now stand on.
 */
function bridgeMouth(tiles: Uint8Array, W: number, H: number, i: number): boolean {
  if (tiles[i] === T_WATER || tiles[i] === T_BRIDGE) return false;
  const tx = i % W;
  const ty = (i - tx) / W;
  // All eight neighbours: the pavement corner that touches the deck only
  // diagonally is the one the outer column's box clips.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (tiles[ny * W + nx] === T_BRIDGE) return true;
    }
  }
  return false;
}
