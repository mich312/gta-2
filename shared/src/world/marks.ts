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

/**
 * Junction furniture: the paint a crossroads wears, decided once.
 *
 * §49 measured what this city's junctions actually had on the ground: 779 of
 * them, 21 zebra tiles in the whole city, and every kerb corner square. The
 * cause was not that nobody had written a crossing painter — the per-tile
 * painter has drawn stop lines and zebras since §35 — but WHERE it could
 * draw. A tile under a course ribbon takes its marks from the ribbon and the
 * ribbon knew only how to draw a centre dash, so on the 77% of carriageway
 * the ribbons cover, no crossing could exist at all. What was left had to get
 * through a width gate that only a four-tile arterial passes, and through a
 * cardinal run test that no curved arterial passes.
 *
 * So the furniture comes off the CURVES, like the junctions themselves: a
 * crossing knows its centre, its radius and — since `courseCrossings` — its
 * arms, and everything below is those three facts turned into quads a painter
 * fills. Tile units throughout, because that is what both painters scale
 * from, and pure, because that is what makes it testable without a canvas.
 */

/** A convex quad in tile units: four corners, wound consistently. */
export type MarkQuad = readonly [number, number, number, number, number, number, number, number];

/** A turn arrow on one approach lane, in tile units. */
export interface MarkArrow {
  /** The arrow's tail, on the lane's centreline. */
  x: number;
  y: number;
  /** Unit vector along the direction of travel — towards the junction. */
  dx: number;
  dy: number;
  /** Whether this lane's arrow carries a hook to the left / to the right. */
  left: boolean;
  right: boolean;
}

export interface JunctionPaint {
  /** Zebra stripes, several per arm. */
  zebras: MarkQuad[];
  /** Stop lines: one per arm, across the approaching half only. */
  stops: MarkQuad[];
  /** Turn arrows: one per approach lane per arm. */
  arrows: MarkArrow[];
}

/**
 * The narrowest carriageway that brings a junction its lights and its paint,
 * in tiles — `MAX_CARRIAGEWAY`, which is what this city calls an arterial.
 *
 * One constant for both, because a stop line at an unsignalised junction is a
 * line nobody is holding and a signal over an unmarked mouth is a light with
 * nothing to stop at. sim/signals.ts imports it rather than keeping its own.
 */
export const SIGNAL_MIN_WIDTH = 4;

/** Gap between the junction box and the near edge of the zebra, in tiles. */
const ZEBRA_SETBACK = 0.2;
/** How deep the crossing is, in tiles — the width a walker gets. */
const ZEBRA_DEPTH = 1;
/** Gap between the zebra and the stop line, and the line's own thickness. */
const STOP_GAP = 0.2;
const STOP_THICK = 0.25;
/** How far back from the stop line the turn arrow's tail sits, in tiles. */
const ARROW_SETBACK = 0.35;
/** Arrow shaft length and head half-width, in tiles. */
const ARROW_LEN = 1.3;
const ARROW_HEAD = 0.36;
/** Stripes across one crossing, and how much of the pitch each one fills. */
const ZEBRA_STRIPES = 4;
const ZEBRA_DUTY = 0.55;

/** Is this crossing one the city governs — and therefore paints? */
export function isSignalCrossing(cross: { arms: ReadonlyArray<{ width: number }> }): boolean {
  return cross.arms.some((a) => a.width >= SIGNAL_MIN_WIDTH);
}

/** A quad from a centre point, an along vector and a cross vector. */
function quad(
  cx: number,
  cy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): MarkQuad {
  return [
    cx - ax - bx,
    cy - ay - by,
    cx + ax - bx,
    cy + ay - by,
    cx + ax + bx,
    cy + ay + by,
    cx - ax + bx,
    cy - ay + by,
  ] as const;
}

/**
 * All the paint for one junction.
 *
 * The layout, from the box outwards along an arm: junction, gap, zebra, gap,
 * stop line, and the arrows behind that. It is the order the ground has it in
 * for a reason a driver reads without thinking — you stop, then the crossing,
 * then the box — and getting it backwards puts the queue on the crossing.
 *
 * Which half of the arm is the approach comes from the same fact the lane
 * model steers by: traffic keeps right, so a driver heading INTO the junction
 * along `-arm` keeps to `(arm.dy, -arm.dx)`. The stop line covers that half
 * and stops at the centreline; painted across the full width — which is what
 * the per-tile painter used to do before §35 — it tells the traffic coming
 * out to stop at a junction it is leaving.
 */
export function junctionPaint(
  cross: {
    x: number;
    y: number;
    r: number;
    arms: ReadonlyArray<{ dx: number; dy: number; width: number }>;
  },
  /**
   * Every other crossing in the city, so an arm can be asked whether it has
   * ROOM. Optional, and an empty list means "assume it has" — which is what a
   * single junction in a fixture wants.
   */
  neighbours: ReadonlyArray<{ x: number; y: number; r: number }> = [],
): JunctionPaint {
  const out: JunctionPaint = { zebras: [], stops: [], arrows: [] };
  // More ways in than a crossroads has is not a junction, it is a place where
  // several roads spill into one apron. `sim/signals.ts` refuses to signalise
  // those for the same reason — no phase governs them — and paint that says
  // otherwise is paint nobody can obey.
  if (cross.arms.length > 4) return out;
  for (const arm of cross.arms) {
    const { dx, dy, width } = arm;
    // The right hand of a driver coming IN along this arm.
    const nx = dy;
    const ny = -dx;
    const half = width / 2;
    // How far the junction BOX reaches along this arm. The disc radius is the
    // right answer only where the roads meet square: two four-tile arterials
    // crossing at 45° make a box half again as long along each arm as it is
    // wide, and a crossing laid at the disc's radius sat inside the tarmac
    // with cars stopped on top of it. Each other arm's carriageway, projected
    // along this one, is `w / 2 / sin θ`; the mouth is the furthest of them.
    let mouth = cross.r;
    for (const o of cross.arms) {
      const sin = Math.abs(dx * o.dy - dy * o.dx);
      if (sin < 0.2) continue; // parallel enough to be this same road
      mouth = Math.max(mouth, Math.min(o.width / 2 / sin, cross.r * 2.2));
    }
    const z0 = mouth + ZEBRA_SETBACK;
    const z1 = z0 + ZEBRA_DEPTH;
    // And does the arm have room for it? Where two junctions are a few tiles
    // apart — the fan of arterials at the top of the old town, mostly — each
    // one laid its crossing into the other's mouth, and a dozen zebras came
    // out stacked across one sheet of tarmac. An arm that runs into the next
    // junction before the paint has finished is left bare, which is what a
    // city does with a block too short to cross in.
    const stopEnd = z1 + STOP_GAP + STOP_THICK;
    let room = Infinity;
    for (const o of neighbours) {
      const t = (o.x - cross.x) * dx + (o.y - cross.y) * dy;
      if (t <= 0.01) continue;
      const p = Math.abs((o.x - cross.x) * nx + (o.y - cross.y) * ny);
      if (p > Math.max(half, o.r) + 0.5) continue;
      room = Math.min(room, t - o.r);
    }
    if (room < stopEnd + 0.5) continue;
    // Zebra: stripes laid ALONG the direction of travel, spaced across the
    // carriageway — which is the way round a real one goes, and the way the
    // per-tile painter has always drawn it.
    const pitch = (width - 0.2) / ZEBRA_STRIPES;
    const bar = (pitch * ZEBRA_DUTY) / 2;
    for (let s = 0; s < ZEBRA_STRIPES; s++) {
      const off = -half + 0.1 + pitch * (s + 0.5);
      const cx = cross.x + dx * ((z0 + z1) / 2) + nx * off;
      const cy = cross.y + dy * ((z0 + z1) / 2) + ny * off;
      out.zebras.push(quad(cx, cy, (dx * ZEBRA_DEPTH) / 2, (dy * ZEBRA_DEPTH) / 2, nx * bar, ny * bar));
    }
    // Stop line: across the approaching half only.
    const sMid = z1 + STOP_GAP + STOP_THICK / 2;
    const sOff = half / 2;
    out.stops.push(
      quad(
        cross.x + dx * sMid + nx * sOff,
        cross.y + dy * sMid + ny * sOff,
        (dx * STOP_THICK) / 2,
        (dy * STOP_THICK) / 2,
        (nx * half) / 2,
        (ny * half) / 2,
      ),
    );
    // Turn arrows, one per approach lane — and only where there are lanes to
    // tell apart. A three-tile street has one lane each way, so its arrow
    // could only say "you may do anything", which is what an unmarked lane
    // already says; drawn anyway it put a symbol every few tiles down every
    // side street in the city.
    if (width >= SIGNAL_MIN_WIDTH) {
      // Which turns exist is a fact about the junction and not about the arm,
      // so it is read off the OTHER arms: a hook painted towards a wall is
      // worse than no hook at all.
      const leftArm = cross.arms.some((o) => o !== arm && o.dx * -nx + o.dy * -ny > 0.7);
      const rightArm = cross.arms.some((o) => o !== arm && o.dx * nx + o.dy * ny > 0.7);
      const lanes = Math.max(1, Math.floor(half));
      for (let l = 0; l < lanes; l++) {
        // `n` points at the driver's right, so lane 0 is the one against the
        // centre line and the last one is against the kerb.
        const off = (half * (l + 0.5)) / lanes;
        const at = sMid + STOP_THICK / 2 + ARROW_SETBACK;
        out.arrows.push({
          x: cross.x + dx * (at + ARROW_LEN) + nx * off,
          y: cross.y + dy * (at + ARROW_LEN) + ny * off,
          dx: -dx,
          dy: -dy,
          // The kerb lane turns right, the median lane turns left.
          left: leftArm && l === 0,
          right: rightArm && l === lanes - 1,
        });
      }
    }
  }
  return out;
}

/** The arrow as a filled outline: shaft, head, and whichever hooks it has. */
export function arrowOutline(a: MarkArrow): MarkQuad[] {
  const { dx, dy } = a;
  const nx = -dy;
  const ny = dx;
  const parts: MarkQuad[] = [];
  const shaft = 0.075;
  // Shaft, from the tail to just short of the head.
  const bodyLen = ARROW_LEN - ARROW_HEAD;
  parts.push(
    quad(
      a.x + dx * (bodyLen / 2),
      a.y + dy * (bodyLen / 2),
      (dx * bodyLen) / 2,
      (dy * bodyLen) / 2,
      nx * shaft,
      ny * shaft,
    ),
  );
  // Head: a triangle, given as a degenerate quad so one filler draws both.
  const tipX = a.x + dx * ARROW_LEN;
  const tipY = a.y + dy * ARROW_LEN;
  const baseX = a.x + dx * bodyLen;
  const baseY = a.y + dy * bodyLen;
  parts.push([
    tipX,
    tipY,
    baseX + nx * ARROW_HEAD,
    baseY + ny * ARROW_HEAD,
    baseX - nx * ARROW_HEAD,
    baseY - ny * ARROW_HEAD,
    tipX,
    tipY,
  ] as const);
  // Hooks: a stub off the shaft, half way up, with its own little head.
  for (const side of [a.left ? -1 : 0, a.right ? 1 : 0]) {
    if (side === 0) continue;
    const hx = nx * side;
    const hy = ny * side;
    const rootX = a.x + dx * (bodyLen * 0.55);
    const rootY = a.y + dy * (bodyLen * 0.55);
    const reach = 0.5;
    parts.push(
      quad(
        rootX + hx * (reach / 2),
        rootY + hy * (reach / 2),
        (hx * reach) / 2,
        (hy * reach) / 2,
        dx * shaft,
        dy * shaft,
      ),
    );
    const htX = rootX + hx * (reach + 0.22);
    const htY = rootY + hy * (reach + 0.22);
    parts.push([
      htX,
      htY,
      rootX + hx * reach + dx * 0.26,
      rootY + hy * reach + dy * 0.26,
      rootX + hx * reach - dx * 0.26,
      rootY + hy * reach - dy * 0.26,
      htX,
      htY,
    ] as const);
  }
  return parts;
}
