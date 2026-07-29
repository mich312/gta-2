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
