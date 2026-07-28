/**
 * Seeded PRNG (mulberry32). The only source of randomness allowed in
 * simulation code. State is a plain number stored in GameState so it rewinds
 * and replays with everything else. All functions are pure: they return
 * [value, nextState] and never mutate.
 */

export function seedRng(seed: number): number {
  return seed | 0;
}

export function nextU32(state: number): [number, number] {
  const s = ((state | 0) + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [(t ^ (t >>> 14)) >>> 0, s];
}

/** Uniform float in [0, 1). */
export function nextFloat01(state: number): [number, number] {
  const [u, s] = nextU32(state);
  return [u / 4294967296, s];
}

/** Uniform float in [min, max). */
export function nextRange(state: number, min: number, max: number): [number, number] {
  const [f, s] = nextFloat01(state);
  return [min + f * (max - min), s];
}

/** Uniform integer in [minIncl, maxExcl). */
export function nextIntRange(
  state: number,
  minIncl: number,
  maxExcl: number,
): [number, number] {
  const [f, s] = nextFloat01(state);
  return [minIncl + Math.floor(f * (maxExcl - minIncl)), s];
}

/**
 * An independent stream seed from a base seed and a label.
 *
 * FNV-1a over the label, xor-folded with the seed, then avalanched. Two
 * labels give two streams that never influence each other, which is what
 * lets worldgen give every pass its own randomness: adding a draw to one
 * pass can no longer shift what any other pass generates. Integer ops
 * only, so it is bit-identical on every host.
 */
export function deriveSeed(seed: number, label: string): number {
  let h = 0x811c9dc5 ^ (seed | 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h | 0;
}
