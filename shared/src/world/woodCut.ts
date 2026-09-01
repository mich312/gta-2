import { fbm } from './fields.js';
import { T_FIELD, T_PARK, T_SAND, T_TREES } from './types.js';

/**
 * The woodland edge, as a line through each tile it crosses (WORLDGEN.md §46).
 *
 * §25 made the coast a curve and the water tiles its rasterisation, and all
 * three painters took the curve; §39 did the same for the shore band's inner
 * edge and §45 for the bridge deck. The LAND-USE boundary never got any of
 * them, and `bevel.ts` refused it by name — *"woodland edges inland are left
 * square too, for now"*. What that left is the largest drawn defect on the
 * map: `evidence/final-review/islet-zoom.png` at 20 px/tile is a smoothly
 * curved coastline with a perfect tile staircase of woodland inside it, and
 * `causeway-end.png` is the same thing as green rectangles on a spit. It is
 * the commissioner's own complaint — "squares from the pixel based map" — in
 * the one boundary nothing repaints.
 *
 * **Where the curve comes from, and why it is not an approximation of one.**
 * `bake.ts` plants open-country woodland from a field and nothing else:
 * `wildAt(tx, ty)` is `fbm(WILD_SEED, tx / 22, ty / 22) >= 0.52`, sampled once
 * per tile. So the wood's true outline is the LEVEL SET of that field, and the
 * tile mask is that curve point-sampled at tile centres — the identical
 * relationship `buildDeckCut` exploits between a deck and the swept disc
 * `carveCourse` cut it from, and that `shoreChains` exploits between the water
 * tiles and the shore rings. This does not INVENT a smooth edge for the wood
 * and it does not smooth the mask: it reads back the contour the mask is a
 * sample of. `wildAt` itself lives here now and `bake.ts` imports it, so the
 * planting rule and the contour cannot drift apart.
 *
 * **And where the field is NOT the outline, which is a third of it.** The
 * field decides woodland; later passes then edit the result — a lane's
 * one-tile verge is cleared, hedgerows and orchard rows plant `T_TREES` where
 * the field says meadow, the shore pass stands a sheer `T_TREES` cliff at the
 * waterline, a park fills to its block edge. Measured on the shipped bake,
 * only 69.8% of woodland boundary tiles agree with the field (a wrong seed
 * scores 49.6%, a wrong scale 50.5% — the field is unmistakably the right one,
 * and it is unmistakably not the whole story). So a tile is cut only where the
 * field EXPLAINS BOTH SQUARES of the face: the wooded side samples positive
 * and the open side samples negative. Where a later pass moved the boundary,
 * the boundary is that pass's and is left exactly as it lies. A curve that
 * cannot honestly claim a face does not draw it.
 *
 * **Output shape is `shoreChains`'s**, deliberately, and for the reason §45
 * gives: `Map<tile, Float32Array>` of tile-local points with the OPEN GROUND
 * ON THE RIGHT of travel, which is the one convention `shoreHalf` and
 * `chainSide` are written against. The 2D painter cuts a wood tile with the
 * two functions it already cuts a band tile with, and the 3D city lays the
 * canopy over the half `shoreHalf` hands back. No second polygon-splitting
 * path exists to disagree with the first.
 *
 * **One line per tile, and when it declines.** A tile whose four corners do
 * not all agree about which side of the contour they are on is cut on the
 * chord between its two border crossings. Where the contour enters and leaves
 * the same square twice — four crossings, a saddle — this returns nothing and
 * the tile stays square, exactly as `buildDeckCut` and `buildShoreCut` decline
 * a chain one line cannot describe.
 *
 * Deterministic: `fbm` is integer-hash value noise with polynomial smoothing
 * (no transcendentals, no tables), plus multiply, add, compare and a fixed
 * bisection count — so both hosts derive the identical curve from the
 * identical tile bytes and it never goes on the wire.
 */

/**
 * The woodland field's seed. `bake.ts` owned this and the contour had no way
 * to read it; it is here so the planting rule and the outline are one thing.
 */
export const WILD_SEED = 0x7009d5;
/** Wavelength of the woodland field, in tiles. */
export const WILD_SCALE = 22;
/** The level set that is the edge of a wood. */
export const WILD_LEVEL = 0.52;

/**
 * How far inside the wood a point is, in field units: positive is wooded,
 * zero is the edge, negative is open country.
 *
 * Offset by half a tile because `wildAt` samples the field at the tile's
 * INTEGER coordinate, so that integer point is the tile's CENTRE as far as
 * this contour is concerned — the same frame `deckDepth` works in, where a
 * tile is deck when its centre is inside the disc. `x - 0.5` is exact for
 * the half-integers this is asked at, so `wildDepth(tx + 0.5, ty + 0.5)` and
 * `wildAt(tx, ty)` are the same bits, not merely the same value.
 */
export function wildDepth(x: number, y: number): number {
  return fbm(WILD_SEED, (x - 0.5) / WILD_SCALE, (y - 0.5) / WILD_SCALE) - WILD_LEVEL;
}

/**
 * The bake's woodland predicate (`bake.ts` used to spell this inline).
 *
 * Kept as a function of the tile coordinate, byte-identical to what it
 * replaced, so no ground moves: `fbm(WILD_SEED, tx / 22, ty / 22) >= 0.52`.
 */
export function wildAt(tx: number, ty: number): boolean {
  return wildDepth(tx + 0.5, ty + 0.5) >= 0;
}

/** Open country a wood can have a drawn edge against. Not water, not built. */
function isOpen(t: number): boolean {
  return t === T_FIELD || t === T_PARK || t === T_SAND;
}

/** What this module reads a tile grid as. Matches `deckCut.ts`'s. */
export type WoodTiles = Uint8Array | Uint16Array | Int32Array | ReadonlyArray<number>;

/**
 * Bisection steps used to place a border crossing. `deckCut.ts`'s 22, for the
 * same reason: 2^-22 of a tile is far below a pixel at any zoom the game
 * draws, and a fixed count is what makes two hosts place it on the same float.
 */
const BISECT = 22;

/**
 * A chord shorter than this is a nick, not a crossing — the contour clips one
 * corner and the square is already within a fiftieth of a tile of right.
 * `deckCut.ts`'s number.
 */
const MIN_CHORD = 0.02;

/**
 * The tiles the woodland contour is allowed to redraw: both squares of every
 * wood/open-country face THE FIELD EXPLAINS, and nothing else.
 *
 * ONE definition, exported, because three painters key off it and a fourth
 * (`mapAudit`) reports on it — the rule §45 set for `deckEdgeTiles` and the
 * reason the three painters cannot drift about where a wood stops being
 * special. The contour runs across the whole map, and following it away from
 * a drawn boundary would repaint meadow that has no wood anywhere near it.
 *
 * A tile qualifies when it is `T_TREES` with open country four-adjacent, or
 * open country with `T_TREES` four-adjacent, AND the field agrees with BOTH:
 * `wildAt` true on the wooded square, false on the open one. That second half
 * is what keeps this off the boundaries a later pass drew rather than the
 * field — a cleared lane verge, a hedgerow, an orchard row, the sheer
 * `T_TREES` cliff at the waterline, a park's square block edge.
 */
export function woodEdgeTiles(tiles: WoodTiles, W: number, H: number): Set<number> {
  const cand = new Set<number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const own = tiles[y * W + x] as number;
      const ownWood = own === T_TREES;
      if (!ownWood && !isOpen(own)) continue;
      if (wildAt(x, y) !== ownWood) continue;
      for (const [dx, dy] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const other = tiles[ny * W + nx] as number;
        const otherWood = other === T_TREES;
        if (otherWood === ownWood) continue;
        if (!otherWood && !isOpen(other)) continue;
        if (wildAt(nx, ny) !== otherWood) continue;
        cand.add(y * W + x);
        cand.add(ny * W + nx);
      }
    }
  }
  return cand;
}

/** Where along `a -> b` the contour changes sign, as a parameter in [0, 1]. */
function crossAt(x0: number, y0: number, x1: number, y1: number): number {
  let lo = 0;
  let hi = 1;
  const inLo = wildDepth(x0, y0) >= 0;
  for (let i = 0; i < BISECT; i++) {
    const m = (lo + hi) / 2;
    const inM = wildDepth(x0 + (x1 - x0) * m, y0 + (y1 - y0) * m) >= 0;
    if (inM === inLo) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** The woodland edge, per tile, in `shoreChains` form. */
export function buildWoodCut(
  tiles: WoodTiles,
  W: number,
  H: number,
): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  const cand = woodEdgeTiles(tiles, W, H);
  if (cand.size === 0) return out;

  // Corners of the unit square, and the four border edges between them.
  const CX = [0, 1, 1, 0];
  const CY = [0, 0, 1, 1];
  for (const idx of cand) {
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const inside = [0, 1, 2, 3].map(
      (k) => wildDepth(tx + (CX[k] as number), ty + (CY[k] as number)) >= 0,
    );
    const hits: Array<[number, number]> = [];
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      if (inside[k] === inside[j]) continue;
      const x0 = tx + (CX[k] as number);
      const y0 = ty + (CY[k] as number);
      const x1 = tx + (CX[j] as number);
      const y1 = ty + (CY[j] as number);
      const t = crossAt(x0, y0, x1, y1);
      hits.push([
        (CX[k] as number) + ((CX[j] as number) - (CX[k] as number)) * t,
        (CY[k] as number) + ((CY[j] as number) - (CY[k] as number)) * t,
      ]);
    }
    // Not two crossings: the square is wholly one side (nothing to cut) or
    // the contour enters and leaves twice (nothing one line can say). Both
    // keep the tile square, which is what every painter does today.
    if (hits.length !== 2) continue;
    let [a, b] = hits as [[number, number], [number, number]];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    if (Math.sqrt(vx * vx + vy * vy) < MIN_CHORD) continue;

    // OPEN COUNTRY on the RIGHT of travel, which with y down is where the
    // cross product of the run with the offset comes out positive — the
    // convention `shoreHalf` and `chainSide` are written against, so a wood
    // chain, a band chain and a coast chain all mean the same thing by the
    // same test and `shoreHalf(seg, true)` is the open half everywhere.
    const openCentre = wildDepth(tx + 0.5, ty + 0.5) < 0;
    const cross = vx * (0.5 - a[1]) - vy * (0.5 - a[0]);
    if (cross > 0 !== openCentre) {
      const swap = a;
      a = b;
      b = swap;
    }
    out.set(idx, Float32Array.from([a[0], a[1], b[0], b[1]]));
  }
  return out;
}
