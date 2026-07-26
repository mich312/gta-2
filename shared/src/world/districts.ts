import { nextIntRange, nextRange } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import { DISTRICT_TYPES, type DistrictType } from './types.js';

export interface DistrictSeed {
  x: number;
  y: number;
  type: DistrictType;
}

/**
 * Place Voronoi seeds for districts. Downtown is pulled toward the centre,
 * industrial toward an edge, everything else scattered. Consumes rng in a
 * fixed order; returns the new rng state.
 */
export function placeDistrictSeeds(
  params: WorldgenParams,
  rng: number,
): [DistrictSeed[], number] {
  const seeds: DistrictSeed[] = [];
  const W = params.widthTiles;
  const H = params.heightTiles;

  for (const type of DISTRICT_TYPES) {
    const count = params.districtSeeds[type];
    for (let i = 0; i < count; i++) {
      let x: number;
      let y: number;
      if (type === 'downtown') {
        [x, rng] = nextRange(rng, W * 0.35, W * 0.65);
        [y, rng] = nextRange(rng, H * 0.35, H * 0.65);
      } else if (type === 'industrial') {
        // Hug one of the four edges.
        let edge: number;
        [edge, rng] = nextIntRange(rng, 0, 4);
        let along: number;
        let depth: number;
        [along, rng] = nextRange(rng, 0.1, 0.9);
        [depth, rng] = nextRange(rng, 0.02, 0.15);
        if (edge === 0) [x, y] = [along * W, depth * H];
        else if (edge === 1) [x, y] = [along * W, (1 - depth) * H];
        else if (edge === 2) [x, y] = [depth * W, along * H];
        else [x, y] = [(1 - depth) * W, along * H];
      } else {
        [x, rng] = nextRange(rng, W * 0.05, W * 0.95);
        [y, rng] = nextRange(rng, H * 0.05, H * 0.95);
      }
      seeds.push({ x, y, type });
    }
  }
  return [seeds, rng];
}

/** Nearest-seed lookup (squared euclidean; ties break to the earlier seed). */
export function districtLookup(seeds: DistrictSeed[]): (tx: number, ty: number) => number {
  return (tx: number, ty: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i] as DistrictSeed;
      const dx = s.x - tx;
      const dy = s.y - ty;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return DISTRICT_TYPES.indexOf((seeds[best] as DistrictSeed).type);
  };
}
