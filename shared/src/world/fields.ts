import { deriveSeed } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';

/**
 * L0 of the worldgen layer stack (WORLDGEN.md §9.2): continuous scalar
 * fields over an UNBOUNDED plane. Everything here is a pure function of
 * (seed, global tile coordinate) — no map dimensions, no window, no state —
 * which is what makes the world (nearly) infinite: any viewport evaluates
 * the same fields and gets the same answer, forever, in any direction.
 *
 * All noise is integer-hash value noise with polynomial smoothing: no
 * transcendentals, no lookup tables. Bit-identical on every host.
 */

/** Deterministic 0..1 from a lattice point. Same mixing family as turf's. */
export function latticeHash(seed: number, xi: number, yi: number): number {
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

export interface CityCore {
  /** Global tile position of the core. */
  x: number;
  y: number;
  /** Peak density this core projects: ~1 is a metropolis, ~0.8 a town. */
  strength: number;
}

/**
 * The city-core lattice: one core per citySpacing×citySpacing cell, at a
 * hashed position inside the cell (kept off the cell edge so the core lands
 * well inside any window that contains its cell), with hashed strength.
 * Cities forever, in every direction, with countryside between them.
 */
export function cityCore(seed: number, params: WorldgenParams, ci: number, cj: number): CityCore {
  return coreAt(deriveSeed(seed, 'fields.cores'), params.fields.citySpacing, ci, cj);
}

/**
 * The same thing with the label already hashed and the spacing already read.
 *
 * `deriveSeed` walks a twelve-character string, and `density` asks for NINE
 * cores per sample: generating a 240×240 window samples density at least once
 * per tile, so that string was being hashed over half a million times per
 * city — enough to be, on its own, a visible fraction of the regeneration
 * stall a player sees when the window moves. Same numbers out, by
 * construction: `cityCore` is now a thin wrapper over this.
 */
function coreAt(coreSeed: number, spacing: number, ci: number, cj: number): CityCore {
  const ux = latticeHash(coreSeed, ci * 3 + 1, cj * 3);
  const uy = latticeHash(coreSeed, ci * 3, cj * 3 + 2);
  const us = latticeHash(coreSeed, ci * 3 + 2, cj * 3 + 1);
  return {
    x: (ci + 0.2 + ux * 0.6) * spacing,
    y: (cj + 0.2 + uy * 0.6) * spacing,
    strength: 0.8 + us * 0.3,
  };
}

export interface CityFields {
  /**
   * Urban intensity, 0..1 at a GLOBAL tile coordinate: the strongest nearby
   * city core's falloff plus noise wobble. 1 is the middle of a downtown,
   * 0 is open country between cities.
   */
  density(gx: number, gy: number): number;
  /** How un-urban a spot wants to be. Independent of density: pockets. */
  wildness(gx: number, gy: number): number;
  /** Which low-density ground reads industrial rather than residential. */
  grit(gx: number, gy: number): number;
  /** Waterway field: water where |value - 0.5| < params.water.width. */
  water(gx: number, gy: number): boolean;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Build the field set. Pure functions of global coordinates throughout. */
export function makeFields(seed: number, params: WorldgenParams): CityFields {
  const f = params.fields;
  const densitySeed = deriveSeed(seed, 'fields.density');
  const wildSeed = deriveSeed(seed, 'fields.wildness');
  const gritSeed = deriveSeed(seed, 'fields.grit');
  const waterSeed = deriveSeed(seed, 'fields.water');
  const spacing = f.citySpacing;
  const radius = f.coreRadius * spacing;
  const wave = f.noiseTiles;
  const wScale = params.water.scale;
  const wWidth = params.water.width;
  const coreSeed = deriveSeed(seed, 'fields.cores');

  /**
   * Cores already worked out, by cell.
   *
   * A memo, not state: `coreAt` is a pure function of its arguments, so this
   * changes no answer — it only stops the same nine cells being recomputed for
   * every tile of the 25×25-tile cell they sit in. Generation walks the window
   * in scanline order and asks for density at every tile, so the hit rate is
   * essentially total, and the whole table is a few hundred entries for a
   * window; it lives and dies with the closure.
   */
  const cores = new Map<number, CityCore>();
  const coreOf = (ci: number, cj: number): CityCore => {
    // Two smallish signed integers into one key. Multiplying by a prime rather
    // than packing bits: the world is unbounded, so neither index has a range
    // a bit-field could be sized against, and a collision here would be a
    // wrong city rather than a slow one.
    const key = ci * 46337 + cj;
    let core = cores.get(key);
    if (core === undefined) {
      core = coreAt(coreSeed, spacing, ci, cj);
      cores.set(key, core);
    }
    return core;
  };

  return {
    density(gx: number, gy: number): number {
      // The strongest projection of the 3×3 neighbourhood of cores. One
      // ring is enough: radius < citySpacing, so a core two cells away
      // cannot reach here.
      const ci = Math.floor(gx / spacing);
      const cj = Math.floor(gy / spacing);
      let best = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const core = coreOf(ci + di, cj + dj);
          const dx = gx - core.x;
          const dy = gy - core.y;
          const fall = 1 - Math.sqrt(dx * dx + dy * dy) / radius;
          if (fall > 0) best = Math.max(best, core.strength * fall);
        }
      }
      const n = fbm(densitySeed, gx / wave, gy / wave);
      return clamp01(best + (n - 0.5) * f.densityNoise * 2);
    },
    wildness(gx: number, gy: number): number {
      return fbm(wildSeed, gx / wave, gy / wave);
    },
    grit(gx: number, gy: number): number {
      return fbm(gritSeed, gx / wave, gy / wave);
    },
    water(gx: number, gy: number): boolean {
      const n = fbm(waterSeed, gx / wScale, gy / wScale);
      return Math.abs(n - 0.5) < wWidth;
    },
  };
}
