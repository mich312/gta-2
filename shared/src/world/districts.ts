import { makeFields, type CityFields } from './fields.js';
import type { WorldgenParams } from './params.js';
import { DISTRICT_TYPES, type DistrictType } from './types.js';

/**
 * L1 of the layer stack (WORLDGEN.md §9.2): land-use classification,
 * *scored from the fields* rather than painted from Voronoi seed points.
 *
 * The Voronoi version gave every district type equal-sized confetti cells
 * with cliff borders: an industrial patch could sit in the middle of town
 * and downtown could land in a corner. Scoring from a radial density field
 * gives the city the structure players orient by — a downtown core that
 * *is* the centre, commercial around it, residential beyond, industry on
 * the low-rent rim — and because density is continuous, the borders land
 * where the field crosses a threshold: ragged where the noise is, never a
 * straight painted line, and every ring transitions into its neighbour
 * rather than into whatever happened to be adjacent.
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
  tx: number,
  ty: number,
): number {
  const f = params.fields;
  const d = fields.density(tx, ty);
  // The core is downtown no matter what — a park does not evict the CBD.
  if (d >= f.downtown) return IDX.downtown;
  // Green pockets anywhere the ground is wild enough and not core.
  if (fields.wildness(tx, ty) >= f.parkWildness) return IDX.park;
  if (d >= f.commercial) return IDX.commercial;
  if (d >= f.residential) return IDX.residential;
  // The rim: industrial where the grit says so, quiet residential fringe
  // where it does not.
  return fields.grit(tx, ty) >= f.grit ? IDX.industrial : IDX.residential;
}

/** The classifier for one city: fields built once, sampled per tile. */
export function districtClassifier(
  seed: number,
  params: WorldgenParams,
): (tx: number, ty: number) => number {
  const fields = makeFields(seed, params);
  return (tx: number, ty: number): number => classifyDistrict(fields, params, tx, ty);
}
