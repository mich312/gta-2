/**
 * Deterministic hash and value noise.
 *
 * This file used to be L0 of a procedural stack: density, wildness and grit
 * fields sampled over an unbounded plane, with city cores on a lattice, and a
 * classifier above them deciding where downtown was. That whole layer is gone
 * — the city is drawn now (`plan.ts`), not scored — and what survives is the
 * arithmetic underneath it, which several passes still want: a stable 0..1
 * from a pair of integers, and smooth noise built out of it.
 *
 * Integer-hash value noise with polynomial smoothing: no transcendentals, no
 * lookup tables, bit-identical on every host.
 */

/** Deterministic 0..1 from a lattice point. */
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
