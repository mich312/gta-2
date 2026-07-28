import { makeFields, type CityFields } from './fields.js';
import type { WorldgenParams } from './params.js';
import { DISTRICT_TYPES, type DistrictType } from './types.js';

/**
 * L1 of the layer stack (WORLDGEN.md §9.2): land-use classification,
 * *scored from the fields* rather than painted from Voronoi seed points —
 * and, like the fields, a pure function of GLOBAL coordinates on an
 * unbounded plane.
 *
 * Each city core projects the concentric structure players orient by:
 * downtown at the peak, commercial around it, residential beyond, industry
 * on the low-rent fringe. Below the city fringe the ground is open country
 * (park blocks: green, sparse lanes) until the next city's falloff picks
 * up. Borders land where a continuous field crosses a threshold: ragged
 * where the noise is, never a straight painted line.
 */
const IDX: Record<DistrictType, number> = {
  downtown: DISTRICT_TYPES.indexOf('downtown'),
  residential: DISTRICT_TYPES.indexOf('residential'),
  industrial: DISTRICT_TYPES.indexOf('industrial'),
  commercial: DISTRICT_TYPES.indexOf('commercial'),
  park: DISTRICT_TYPES.indexOf('park'),
};

export function classifyDistrict(
  fields: CityFields,
  params: WorldgenParams,
  gx: number,
  gy: number,
): number {
  const f = params.fields;
  const d = fields.density(gx, gy);
  // The core is downtown no matter what — a park does not evict the CBD.
  if (d >= f.downtown) return IDX.downtown;
  // Green pockets anywhere the ground is wild enough and not core.
  if (fields.wildness(gx, gy) >= f.parkWildness) return IDX.park;
  if (d >= f.commercial) return IDX.commercial;
  if (d >= f.residential) return IDX.residential;
  // The city fringe: industrial where the grit says so, quiet outskirts
  // where it does not.
  if (d >= f.residential * 0.5) {
    return fields.grit(gx, gy) >= f.grit ? IDX.industrial : IDX.residential;
  }
  // Open country between cities.
  return IDX.park;
}

/** The classifier for one world: fields built once, sampled anywhere. */
export function districtClassifier(
  seed: number,
  params: WorldgenParams,
): (gx: number, gy: number) => number {
  const fields = makeFields(seed, params);
  return (gx: number, gy: number): number => classifyDistrict(fields, params, gx, gy);
}
