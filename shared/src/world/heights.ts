import type { Building, DistrictType } from './types.js';

/**
 * How tall a building is, in storeys.
 *
 * Derived rather than stored, and derived without touching the rng, for two
 * reasons that are both invariants:
 *
 * - Drawing from `state.rng` during worldgen would shift every downstream
 *   draw (`ROADMAP.md` §0, invariant 2), which invalidates every recorded
 *   replay for a purely cosmetic field. A hash of the footprint costs nothing
 *   and shifts nothing.
 * - It is a pure function of things both hosts already agree on, so it never
 *   goes on the wire and cannot desync — the same argument that made traffic
 *   signals and the day/night clock formulas over `tick` rather than state.
 *
 * When U1 turns the generator into a tool and a designer wants an authored
 * skyline, this becomes the *default* for a `height` field on `Building`
 * rather than the only answer. That is the same shape U1 gives everything
 * else: generate a starting point, let a human overrule it.
 */

/** Storey heights per district: [min, max], inclusive. */
const STOREYS: Record<DistrictType, [number, number]> = {
  downtown: [4, 12],
  commercial: [2, 6],
  industrial: [1, 3],
  residential: [1, 3],
  park: [1, 2],
};

/** Deterministic 32-bit hash of a footprint. No rng, no state. */
function hashRect(x: number, y: number, w: number, h: number): number {
  let v = 0x811c9dc5;
  for (const n of [x, y, w, h]) {
    v ^= n & 0xffff;
    v = Math.imul(v, 0x01000193) >>> 0;
  }
  // Final avalanche, so adjacent footprints do not land on adjacent heights.
  v ^= v >>> 15;
  v = Math.imul(v, 0x2545f491) >>> 0;
  v ^= v >>> 13;
  return v >>> 0;
}

/**
 * Storeys for a building. Bigger footprints lean taller — a tower block reads
 * wrong as a bungalow, and a shed reads wrong as a tower — but the hash still
 * does most of the work, so a street is varied rather than graded.
 */
export function buildingStoreys(b: Building): number {
  // The authored height, when the bake set one — the "designer overrules the
  // hash" seam the header always promised, arrived via landmark recipes.
  if (b.storeys !== undefined) return b.storeys;
  const range = STOREYS[b.district] ?? STOREYS.residential;
  const [lo, hi] = range;
  const roll = hashRect(b.x, b.y, b.w, b.h) / 0xffffffff;
  // Footprint area nudges the roll upward, capped so it never dominates.
  const area = b.w * b.h;
  const bulk = Math.min(0.35, area / 160);
  const t = Math.min(1, roll * (1 - bulk) + bulk);
  return Math.max(lo, Math.min(hi, Math.round(lo + t * (hi - lo))));
}

/** World pixels of apparent height, for extrusion and shadow length. */
export function buildingHeightPx(b: Building, pxPerStorey: number): number {
  return buildingStoreys(b) * pxPerStorey;
}

/**
 * The mass a building DRAWS, as a rotated rectangle in tile units.
 *
 * The footprint is axis-aligned and stays that way; this is the box the
 * renderers stand on it. Rotating a rectangle grows its bounding box, so the
 * mass is scaled to fit back inside its own footprint plus `slack` tiles —
 * enough to lean into its own pavement and not one tile further, because the
 * corner of a building in the carriageway is worse than a building that is
 * square to the world.
 *
 * One helper, three renderers. The 2D chunk painter, the parallax extrusion
 * and the 3D instanced city must agree on this box to the pixel, or a
 * building is in three places depending on which one drew it.
 */
export function buildingMass(
  b: Building,
  slack = MASS_SLACK,
): { cx: number; cy: number; w: number; h: number; rad: number } {
  const rad = ((b.angle ?? 0) * Math.PI) / 180;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (rad === 0) return { cx, cy, w: b.w, h: b.h, rad: 0 };
  // Cut at an angle (§36): the rectangle is given, the tiles under it are its
  // rasterisation, and there is nothing to fit — no factor, no shrink, and no
  // gap between the thing you see and the thing you collide with. `x, y, w, h`
  // is its bounding box, so the centre is still the centre.
  if (b.mw !== undefined && b.mh !== undefined) {
    return { cx, cy, w: b.mw, h: b.mh, rad };
  }
  const k = massFit(b.w, b.h, b.angle ?? 0, slack);
  return { cx, cy, w: b.w * k, h: b.h * k, rad };
}

/**
 * How far a `w`×`h` footprint has to shrink to be turned `deg` degrees and
 * still sit inside its own plot plus `slack`.
 *
 * A rotated rectangle's bounding box grows, and the mass keeps its aspect
 * ratio, so the scale is set by whichever side overflows worse. For a nearly
 * square footprint at a shallow angle that is a few percent; for an elongated
 * one turned across its long axis it is brutal — a 2×4 shed at 112° has to
 * come down to 0.56, drawing under a third of its own area.
 *
 * Which is why this is a public number rather than an implementation detail
 * of `buildingMass`: `bakeCity` asks it BEFORE recording a facing, and leaves
 * a building square when the turn would cost more than `MIN_FACING_FIT`.
 */
export function massFit(w: number, h: number, deg: number, slack = MASS_SLACK): number {
  const rad = (deg * Math.PI) / 180;
  if (rad === 0) return 1;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  // The rotated box's own bounding extent, per unit of scale.
  return Math.min(1, (w + slack) / (w * c + h * s), (h + slack) / (w * s + h * c));
}

/**
 * How far out of its plot a mass may lean, in tiles — half of it per side.
 *
 * A whole tile, not the half tile §22 first tried. The plot a building stands
 * in is bounded by its own pavement, and a doorstep, a porch and a bay window
 * all live in that ring; a mass allowed to use it needs to shrink far less to
 * turn, which is the difference between a diagonal borough that faces its
 * streets and one that gives up (§22.4). What it may still not touch is the
 * carriageway, and half a tile of lean does not reach it.
 */
export const MASS_SLACK = 1;

/**
 * The least a mass may shrink and still be worth turning (§20).
 *
 * Linear, so it costs the drawn area its square: 0.85 means a turned building
 * always draws at least 72% of its footprint. Below that the mass stops
 * reading as the building the tiles describe and starts being an invisible
 * wall — collision reads the full rect, and a corner of it standing well
 * outside the thing you can see is worse than a house square to the world.
 */
export const MIN_FACING_FIT = 0.85;

/**
 * The angle a mass is drawn at, given the street bearing its tiles carry.
 *
 * A rectangle turned θ and turned θ−90 puts its walls on the same two lines;
 * all that changes is which of its own axes runs ALONG the street. So a
 * bearing is folded into (−45°, 45°]: the building still fronts its street,
 * and it fronts it with whichever side fits the plot, instead of being turned
 * across itself. A 2×4 shed on a 112° street costs a fit of 0.56 taken raw
 * and 0.75 folded to 22°; a bearing of exactly 90° folds to 0, which is the
 * truth — a rectangle square to a north-south street IS square to the world.
 */
export function facingAngle(deg: number): number {
  let a = ((deg % 180) + 180) % 180;
  if (a > 90) a -= 180;
  if (a > 45) a -= 90;
  else if (a <= -45) a += 90;
  return a;
}

/** The mass's four corners, in tile units, clockwise from the north-west. */
export function buildingCorners(
  b: Building,
  slack = MASS_SLACK,
): Array<[number, number]> {
  const { cx, cy, w, h, rad } = buildingMass(b, slack);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const hw = w / 2;
  const hh = h / 2;
  return ([
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as Array<[number, number]>).map(([px, py]) => [cx + px * c - py * s, cy + px * s + py * c]);
}
