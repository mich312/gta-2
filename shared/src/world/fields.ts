import { deriveSeed, nextRange, seedRng } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';

/**
 * L0 of the worldgen layer stack (WORLDGEN.md §9.2): continuous scalar
 * fields over the map. Everything downstream that should *fade* — district
 * intensity, and later block density, lamp spacing, ped counts — samples a
 * field instead of asking "which district am I in".
 *
 * All noise here is integer-hash value noise with polynomial smoothing:
 * no transcendentals, no lookup tables, no state. A field is a pure
 * function of (seed, x, y), bit-identical on every host, sampleable in any
 * order — which is what makes this layer safe to consult from anywhere
 * without the ordering discipline the rng-threaded passes need.
 */

/** Deterministic 0..1 from a lattice point. Same mixing family as turf's. */
function latticeHash(seed: number, xi: number, yi: number): number {
  let h = seed ^ Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep-interpolated value noise in [0, 1), one octave. */
export function valueNoise(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = latticeHash(seed, xi, yi);
  const b = latticeHash(seed, xi + 1, yi);
  const c = latticeHash(seed, xi, yi + 1);
  const d = latticeHash(seed, xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Fractal sum: three octaves, halving wavelength and amplitude. Output is
 * normalised back to roughly [0, 1] with 0.5 as the centre of mass.
 */
export function fbm(seed: number, x: number, y: number): number {
  const n0 = valueNoise(seed, x, y);
  const n1 = valueNoise(seed ^ 0x9e3779b9, x * 2, y * 2);
  const n2 = valueNoise(seed ^ 0x3c6ef372, x * 4, y * 4);
  return (n0 + n1 * 0.5 + n2 * 0.25) / 1.75;
}

export interface CityFields {
  /**
   * Urban intensity, 0..1: radial falloff from the city core plus noise
   * wobble. 1 is the middle of downtown, 0 is the map's rural-most corner.
   */
  density(tx: number, ty: number): number;
  /** How un-urban a spot wants to be. Independent of density: pockets. */
  wildness(tx: number, ty: number): number;
  /** Which low-density ground reads industrial rather than residential. */
  grit(tx: number, ty: number): number;
  /** Where downtown's density peak sits, in tiles. */
  core: { x: number; y: number };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Build the field set for one city. The core position is the only random
 * decision — everything else is hashed straight off the coordinates.
 */
export function makeFields(seed: number, params: WorldgenParams): CityFields {
  const W = params.widthTiles;
  const H = params.heightTiles;
  const f = params.fields;
  const span = Math.min(W, H);

  // The core is jittered off-centre so seeds differ at the macro level,
  // from this layer's own derived stream.
  let rng = seedRng(deriveSeed(seed, 'fields.core'));
  let coreX: number;
  let coreY: number;
  [coreX, rng] = nextRange(rng, W * 0.38, W * 0.62);
  [coreY, rng] = nextRange(rng, H * 0.38, H * 0.62);

  const densitySeed = deriveSeed(seed, 'fields.density');
  const wildSeed = deriveSeed(seed, 'fields.wildness');
  const gritSeed = deriveSeed(seed, 'fields.grit');
  const radius = f.coreRadius * span;
  const wave = f.noiseTiles;

  return {
    core: { x: coreX, y: coreY },
    density(tx: number, ty: number): number {
      const dx = tx - coreX;
      const dy = ty - coreY;
      const radial = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / radius);
      const n = fbm(densitySeed, tx / wave, ty / wave);
      return clamp01(radial + (n - 0.5) * f.densityNoise * 2);
    },
    wildness(tx: number, ty: number): number {
      return fbm(wildSeed, tx / wave, ty / wave);
    },
    grit(tx: number, ty: number): number {
      // Noise plus an edge affinity: heavy industry wants the city rim,
      // where land is cheap and neighbours don't complain.
      const edge = Math.min(tx, ty, W - 1 - tx, H - 1 - ty);
      const edgeBoost = Math.max(0, 1 - edge / (span * 0.14)) * 0.35;
      return clamp01(fbm(gritSeed, tx / wave, ty / wave) + edgeBoost);
    },
  };
}
