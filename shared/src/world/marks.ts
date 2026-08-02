/**
 * Road paint, decided once for both renderers.
 *
 * The 2D painter (`client/src/render/tiles.ts`) and the 3D city builder
 * (`client/src/three/cityGeometry.ts`) each grew their own answer to "where
 * does the centre line go", and they disagreed: on every four-tile arterial
 * the 3D line sat half a lane from the 2D one, with a different dash cadence,
 * and you could watch the paint jump sideways as painted ground chunks
 * replaced the shader fallback after a spawn. Meanwhile the carved diagonal
 * bands — the ring road and every curved arterial — got no paint from either,
 * because both renderers only knew how to measure a carriageway along an
 * axis.
 *
 * This module is the one answer. It lives in `shared/` rather than in the
 * client because the direction field it computes is also what the traffic
 * lane model wants the day it stops being cardinal (BUGS.md §7.6) — the paint
 * and the driving must come from the same geometry or the cars ignore their
 * own lanes.
 *
 * Everything here is pure and takes an `isRoad` callback rather than a map,
 * so it can be tested without generating a city.
 */

export type IsRoad = (tx: number, ty: number) => boolean;

/**
 * Where the centre line falls inside one carriageway tile, as a fraction of
 * the tile from its low edge — or null when the centre is not in this tile.
 *
 * The old rule was "the far edge of tile `floor(width / 2) - 1`", which is the
 * middle only when the road is an even number of tiles across. Every secondary
 * road in this city is three tiles wide, so the line landed on the boundary
 * between the first tile and the second, and the street had a lane and a half
 * on one side of it and half a lane on the other.
 *
 * The sim never agreed: `laneOptions` has always put the two lanes at the true
 * centre of the drivable span, plus and minus a quarter of its width. This is
 * the paint catching up, and it is a pure function so the arithmetic can be
 * checked without a canvas.
 */
export function laneCentreInTile(width: number, index: number): number | null {
  if (width < 2) return null;
  const at = width / 2 - index;
  return at > 0 && at <= 1 ? at : null;
}

/**
 * A diagonal band's orientation: which way the paint runs.
 *
 * `'se'` runs along (+1, +1) in tile space — down-right, y growing south the
 * way the game means it. `'ne'` runs along (+1, -1), up-right.
 */
export type DiagonalDir = 'se' | 'ne';

/**
 * The principal direction of the road mass around a tile, or null where the
 * neighbourhood is axis-aligned (or too small to say).
 *
 * A carved arterial rasterises to a stair-stepped band, so no single tile can
 * know which way its road runs — every stair step is one or two tiles long on
 * either axis. The NEIGHBOURHOOD knows: gather the road tiles within `radius`
 * (Chebyshev) and take the principal axis of their scatter. The angle is
 * quantised to the nearest 45°, because the bands this city carves are smooth
 * curves and the paint only has to be less wrong than no paint at all —
 * a quantised line that holds still beats an exact one that wobbles per tile.
 */
export function diagonalRoadDir(
  isRoad: IsRoad,
  tx: number,
  ty: number,
  radius = 5,
): DiagonalDir | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!isRoad(tx + dx, ty + dy)) continue;
      n++;
      sx += dx;
      sy += dy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
  }
  if (n < 4) return null;
  // Central second moments: the covariance of the road mass around its own
  // mean, not around this tile — a tile near the band's edge would otherwise
  // read the offset as direction.
  const cxx = sxx - (sx * sx) / n;
  const cyy = syy - (sy * sy) / n;
  const cxy = sxy - (sx * sy) / n;
  // Principal axis of the scatter. `0.5 * atan2(2σxy, σxx − σyy)` is the
  // textbook orientation of the major axis; quantise it to 45° steps.
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const step = Math.round(theta / (Math.PI / 4));
  // Steps: 0 horizontal, ±2 vertical, 1 is (+1,+1), -1 is (+1,-1).
  if (step === 1) return 'se';
  if (step === -1) return 'ne';
  return null;
}

/**
 * Whether this diagonal-band tile carries the centre line — the diagonal
 * version of "the tile `laneCentreInTile` names".
 *
 * The cross-section is the HORIZONTAL run through the tile, not a walk along
 * the band's normal. A diagonal walk moves two lattice classes apart at every
 * step — from a tile with `x − y = 0` it only ever sees other even-`x − y`
 * tiles — so each parity class measured its own "width", each found its own
 * "centre", and the band grew two parallel centre lines half a diagonal
 * apart. A horizontal line crosses every tile of the band exactly once, its
 * run through a 45° band is the band's width times √2 (still under
 * `RUN_ROAD`, which is why the cardinal path passed these tiles over), and
 * `laneCentreInTile` on that run names one tile per row: a clean single
 * chain stepping along the band. The sub-tile offset is deliberately NOT
 * carried out of here — the band edges are stair-stepped anyway, and a line
 * through the middle of the named tile holds still, which is the property
 * that matters.
 */
export function diagonalCentreTile(isRoad: IsRoad, tx: number, ty: number): boolean {
  let left = 0;
  while (left < 8 && isRoad(tx - left - 1, ty)) left++;
  let right = 0;
  while (right < 8 && isRoad(tx + right + 1, ty)) right++;
  return laneCentreInTile(left + right + 1, left) !== null;
}

/**
 * The band's mark for one road tile, or null for bare asphalt: the shared
 * verdict both renderers paint from. Call it only for tiles whose axis runs
 * already failed the cardinal test — the cardinal path has its own richer
 * furniture (edge lines, stop lines, zebras) and stays as it is.
 */
export function diagonalMark(isRoad: IsRoad, tx: number, ty: number): DiagonalDir | null {
  if (!diagonalCentreTile(isRoad, tx, ty)) return null;
  return diagonalRoadDir(isRoad, tx, ty);
}
