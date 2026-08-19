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
  /**
   * How far the hook reaches off the shaft, in tiles — clamped so the tip
   * stays on the carriageway rather than over the kerb.
   */
  hook: number;
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
/**
 * How much carriageway an arm must still have beyond the paint before it is
 * worth painting, in tiles. A cul-de-sac's turning head and a three-tile stub
 * both pass every test that looks only at the junction. Short, because the
 * arm is a straight ray and the road it stands for is often a curve.
 */
const ARM_RUN = 2;
/** Where the give-way line sits past the mouth, its pitch and thickness. */
const GIVE_WAY_SETBACK = 0.35;
const GIVE_WAY_PITCH = 0.55;
const GIVE_WAY_THICK = 0.2;
/**
 * How much wider than its own road the tarmac at a crossing may be, in tiles.
 *
 * One tile of slack is the kerb band and the bevels; the histogram of the
 * shipped city is 249 arms at +1 and a long tail out to +8, and the tail is
 * where the aprons are. Three keeps every ordinary mouth, including the ones
 * a turning lane widens, and refuses the sheets.
 */
const MOUTH_SLACK = 3;
/** How far a turn arrow's hook reaches off the shaft, in tiles. */
const HOOK_REACH = 0.5;
/** Stripes across one crossing, and how much of the pitch each one fills. */
const ZEBRA_STRIPES = 4;
const ZEBRA_DUTY = 0.55;

/**
 * How far past the junction's mouth the paint reaches, in tiles: the far edge
 * of the stop line.
 *
 * Exported because the SIM has to know it. `stopLineGap` used to halt a car
 * 6px short of the first junction-labelled tile, which is the mouth — and the
 * stop line is painted a tile and a half further out than that, so every AI
 * driver in the city came to rest past its own stop line and, two times in
 * five, on the crossing itself. A stop line the traffic ignores is worse than
 * no stop line: it says the paint is scenery. One number, read by the painter
 * that draws the line and by the model that stops at it.
 */
export const STOP_LINE_REACH = ZEBRA_SETBACK + ZEBRA_DEPTH + STOP_GAP + STOP_THICK;

/**
 * How far the junction BOX reaches along one arm, in tiles.
 *
 * The disc radius is the right answer only where the roads meet square: two
 * four-tile arterials crossing at 45° make a box half again as long along
 * each arm as it is wide, and anything laid at the disc's radius sits inside
 * the tarmac. Each other arm's carriageway, projected along this one, is
 * `w / 2 / sin θ`; the mouth is the furthest of them.
 *
 * This is THE definition of how big a junction is, and everything that needs
 * to know now asks it: the paint, the labelling merge in `sim/signals.ts`,
 * and the policy that decides which junctions get lights. Three different
 * answers to this question — a disc of `r + 0.5`, a square of `ceil(r) + 1`,
 * and this — is what left 17 crossroads showing green to both axes at once,
 * because the merge's disc was too small to reach the fragments the flood
 * fill had left lying around the box.
 */
export function armMouth(
  cross: { r: number; arms: ReadonlyArray<{ dx: number; dy: number; width: number }> },
  arm: { dx: number; dy: number },
): number {
  let mouth = cross.r;
  for (const o of cross.arms) {
    const sin = Math.abs(arm.dx * o.dy - arm.dy * o.dx);
    if (sin < 0.2) continue; // parallel enough to be this same road
    mouth = Math.max(mouth, Math.min(o.width / 2 / sin, cross.r * 2.2));
  }
  return mouth;
}

/**
 * How far out along an arm the crossing's own tarmac reaches.
 *
 * Two answers, and the honest one is the further out. `armMouth` is geometry:
 * where the arm's own half-width clears the crossing point. `ground.mouth`
 * reads the labelling: where the tiles stop belonging to this junction. The
 * labelled answer is the better one where a junction was found in the tiles,
 * because its point is the centroid of a patch that may run three tiles along
 * the arm and the geometric mouth lands short of the patch's edge. But most
 * crossings the curves describe carry no label at all, and there the labelled
 * walk gives up on its first quarter-tile step and answers 0.25 — a stop line
 * in the middle of the box, and a width measured ACROSS the cross street,
 * which then reads as twenty-four tiles of open apron and throws the arm away.
 * Take the max and neither failure can happen.
 */
export function armReach(
  cross: {
    x: number;
    y: number;
    r: number;
    arms: ReadonlyArray<{ dx: number; dy: number; width: number }>;
  },
  arm: { dx: number; dy: number; width: number },
  ground?: JunctionGround,
): number {
  const geometric = armMouth(cross, arm);
  const labelled = ground?.mouth?.(cross.x, cross.y, arm.dx, arm.dy);
  return labelled === undefined ? geometric : Math.max(geometric, labelled);
}

/** The furthest any arm's mouth reaches: the radius of the whole junction. */
export function junctionReach(cross: {
  r: number;
  arms: ReadonlyArray<{ dx: number; dy: number; width: number }>;
}): number {
  let reach = cross.r;
  for (const arm of cross.arms) reach = Math.max(reach, armMouth(cross, arm));
  return reach;
}

/**
 * What the ground will take, so a crossing is never painted where a driver
 * cannot be.
 *
 * The furniture comes off the curves, and a curve knows nothing about what
 * was built under it. Left ungated it put zebra stripes in the creek at
 * (383,472), a stop line through a building at (171,237), and a full
 * signalised kit inside the turning head of a cul-de-sac at (144,467).
 * Supplied by the caller because only the caller has a map.
 */
export interface JunctionGround {
  /** May a crossing be painted on this tile? Carriageway, and not a deck. */
  paintable(tx: number, ty: number): boolean;
  /**
   * How far the junction BOX actually reaches along this arm, in tiles —
   * measured on the labelling rather than worked out from the angles.
   *
   * `armMouth` below is the geometric answer and it is the one to use when
   * there is no map to ask. On a skew crossing it is up to 2.2 times the
   * radius while the labelled box stops near the radius, and that gap is a
   * gap between the PAINT and the SIM: the driver model measures from the
   * first labelled tile, so paint drawn from the geometry sat as much as
   * 1.9 tiles beyond where the car stops. Same box, one measurement.
   */
  mouth?(x: number, y: number, dx: number, dy: number): number;
  /**
   * How wide the carriageway is ACROSS the arm at a point, in tiles.
   *
   * A crossing belongs at a mouth, and a mouth is where the tarmac is about
   * as wide as the road that made it. Without this test the paint went down
   * wherever the ground was road and the room was clear, which in the merged
   * aprons where several arterials converge meant two crossings at 45° to
   * each other in the middle of an open sheet with no kerb near either — the
   * exact debris §35 was written against, arrived at from the other side.
   * 117 of 435 painted arms were on tarmac more than three tiles wider than
   * their own road, and 63 of those on tarmac wider by eight.
   */
  spread?(x: number, y: number, nx: number, ny: number): number;
}

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
  /** What the ground will take. Absent means "anything", for a fixture. */
  ground?: JunctionGround,
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
    const z0 = armReach(cross, arm, ground) + ZEBRA_SETBACK;
    const z1 = z0 + ZEBRA_DEPTH;
    const sMid = z1 + STOP_GAP + STOP_THICK / 2;
    // How far out the paint reaches, arrows included. The room test used to
    // stop at the stop line and let the arrows run on another 1.65 tiles,
    // which filled the four-tile link between two close junctions end to end.
    const reach = sMid + STOP_THICK / 2 + ARROW_SETBACK + ARROW_LEN;
    // Does the arm have room for it? Where two junctions are a few tiles
    // apart — the fan of arterials at the top of the old town, mostly — each
    // one laid its crossing into the other's mouth, and a dozen zebras came
    // out stacked across one sheet of tarmac. An arm that runs into the next
    // junction before the paint has finished is left bare, which is what a
    // city does with a block too short to cross in.
    let room = Infinity;
    for (const o of neighbours) {
      const t = (o.x - cross.x) * dx + (o.y - cross.y) * dy;
      if (t <= 0.01) continue;
      const p = Math.abs((o.x - cross.x) * nx + (o.y - cross.y) * ny);
      if (p > Math.max(half, o.r) + 0.5) continue;
      room = Math.min(room, t - o.r);
    }
    if (room < reach + 0.5) continue;
    // And will the ground take it?
    //
    // Two questions, and they are not the same one. First: is the ground the
    // paint actually covers carriageway — sampled across the width of the
    // crossing and along its depth, which is what stops a zebra landing in
    // the creek or a stop line running through a building. Second: does the
    // arm GO anywhere — sampled down the centreline only, and only a couple
    // of tiles further, because an arm is a straight ray and the road it
    // stands for may be a curve. That is what refuses a cul-de-sac's turning
    // head, which passes every test that looks only at the junction.
    if (ground) {
      let ok = true;
      // Sampled at the middle of each half of the carriageway, not at its
      // outer edge: a rasterised road is not exactly `width` tiles across
      // everywhere, so the outermost zebra stripe legitimately grazes the
      // kerb band on a curve. Refusing the arm for that threw away 136 of
      // the city's 530 arterial arms for touching a pavement the painters
      // clip against anyway. What this is looking for is a crossing laid
      // somewhere it has no business being at all.
      const edge = half / 2;
      for (const along of [z0, (z0 + z1) / 2, z1, sMid]) {
        for (const off of [-edge, 0, edge]) {
          const px = cross.x + dx * along + nx * off;
          const py = cross.y + dy * along + ny * off;
          if (!ground.paintable(Math.floor(px), Math.floor(py))) ok = false;
        }
      }
      for (const along of [reach + 0.5, reach + ARM_RUN]) {
        const px = cross.x + dx * along;
        const py = cross.y + dy * along;
        if (!ground.paintable(Math.floor(px), Math.floor(py))) ok = false;
      }
      // And is this a MOUTH? Tarmac much wider than the road it belongs to is
      // an apron, and a zebra laid across an apron is a zebra in open ground.
      if (ok && ground.spread) {
        const mid = (z0 + z1) / 2;
        const wide = ground.spread(cross.x + dx * mid, cross.y + dy * mid, nx, ny);
        if (wide > width + MOUTH_SLACK) ok = false;
      }
      if (!ok) continue;
    }
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
          // The kerb lane turns right, the median lane turns left. The hook
          // is held inside the carriageway: at 0.72 tiles off a lane centre
          // 1.5 tiles from the middle of a four-tile road, two thirds of them
          // used to reach over the kerb.
          left: leftArm && l === 0,
          right: rightArm && l === lanes - 1,
          hook: Math.min(HOOK_REACH, half - off - 0.15),
        });
      }
    }
  }
  return out;
}

/**
 * Give way: the mark an UNSIGNALISED crossing wears.
 *
 * §49 found the city had exactly two vocabulary words — the full arterial kit,
 * or nothing — and 581 of its junctions had the second. Worse than unmarked:
 * the centre dash is punched out of every crossing disc, so at a residential
 * crossroads both lines simply stop and nothing replaces them. Nothing on the
 * ground says two streets meet, or which of them is the through road.
 *
 * This is the third word, and it is cheap: a broken line across the minor
 * arms, at the mouth. Which arms are minor is the seniority the ribbon
 * painter already ranks by (§16) — width first, then how long the road runs —
 * so the marks agree with the centre line that carries on through. Where both
 * roads rank the same the junction stays bare, because "give way to nobody in
 * particular" is not a thing paint can say.
 */
export function junctionGiveWay(
  cross: {
    x: number;
    y: number;
    r: number;
    arms: ReadonlyArray<{ dx: number; dy: number; width: number; len: number }>;
  },
  neighbours: ReadonlyArray<{ x: number; y: number; r: number }> = [],
  ground?: JunctionGround,
): MarkQuad[] {
  const out: MarkQuad[] = [];
  if (cross.arms.length < 3 || cross.arms.length > 4) return out;
  // Seniority: the widest road, and among equals the longest one.
  let best = cross.arms[0] as { width: number; len: number };
  for (const a of cross.arms) {
    if (a.width > best.width || (a.width === best.width && a.len > best.len)) best = a;
  }
  const minor = (a: { width: number; len: number }): boolean =>
    a.width < best.width || (a.width === best.width && a.len < best.len - 1);
  if (!cross.arms.some(minor)) return out;
  for (const arm of cross.arms) {
    if (!minor(arm)) continue;
    const { dx, dy, width } = arm;
    const nx = dy;
    const ny = -dx;
    const half = width / 2;
    // Where the crossing's own tarmac ends, on exactly the terms the crossing
    // paint uses (§51.1).
    const at = armReach(cross, arm, ground) + GIVE_WAY_SETBACK;
    // Room, and ground, on the same terms the signalised kit asks for — a
    // give-way line in the creek is no better than a zebra in it.
    let room = Infinity;
    for (const o of neighbours) {
      const t = (o.x - cross.x) * dx + (o.y - cross.y) * dy;
      if (t <= 0.01) continue;
      const p = Math.abs((o.x - cross.x) * nx + (o.y - cross.y) * ny);
      if (p > Math.max(half, o.r) + 0.5) continue;
      room = Math.min(room, t - o.r);
    }
    if (room < at + 1) continue;
    if (ground) {
      let ok = true;
      for (const off of [-half / 2, 0, half / 2]) {
        const px = cross.x + dx * at + nx * off;
        const py = cross.y + dy * at + ny * off;
        if (!ground.paintable(Math.floor(px), Math.floor(py))) ok = false;
      }
      // The same mouth test the crossings get: a give-way line laid across an
      // apron is as much debris as a zebra is, and the junctions read out of
      // the tile plane are exactly the ones that can be aprons.
      if (ok && ground.spread) {
        const wide = ground.spread(cross.x + dx * at, cross.y + dy * at, nx, ny);
        if (wide > width + MOUTH_SLACK) ok = false;
      }
      if (!ok) continue;
    }
    // Broken, not solid: a solid line is a stop line, and this is not one.
    // Across the approaching half only, like the stop line, so it speaks to
    // the traffic coming in.
    const span = half;
    const dashes = Math.max(2, Math.round(span / GIVE_WAY_PITCH));
    for (let d = 0; d < dashes; d++) {
      const off = ((d + 0.5) * span) / dashes;
      const bar = (span / dashes) * 0.55;
      out.push(
        quad(
          cross.x + dx * at + nx * off,
          cross.y + dy * at + ny * off,
          (dx * GIVE_WAY_THICK) / 2,
          (dy * GIVE_WAY_THICK) / 2,
          (nx * bar) / 2,
          (ny * bar) / 2,
        ),
      );
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
    const reach = Math.max(0.18, a.hook);
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
