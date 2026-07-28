/**
 * Stable, cheap 2D hash — the source of every "random" detail that has to look
 * the same on every client and on every frame.
 *
 * Lives on its own because three layers now want it: the tile layer's paving
 * and roof clutter, the lighting pass's per-lamp flicker character, and the
 * window emissives, which are a function of the building rect and nothing
 * else. A `Math.random()` in any of those would shimmer.
 */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Value noise over a single axis: smooth, deterministic, period-1 wobble.
 *
 * Used by the flicker model, where a sine is too regular to read as a failing
 * lamp and `Math.random()` per frame is frame-rate dependent — the same tube
 * has to strobe the same way at 30 fps and at 144.
 */
export function noise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash2(i, seed, 0x51ed);
  const b = hash2(i + 1, seed, 0x51ed);
  // Smoothstep between the lattice points: no discontinuity at the boundary.
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}
