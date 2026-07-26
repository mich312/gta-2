import { describe, expect, it } from 'vitest';
import { seedRng, nextU32, nextFloat01, nextIntRange } from '../src/rng/prng.js';

describe('prng', () => {
  it('matches the pinned known-answer sequence (mulberry32)', () => {
    // If this test fails, the PRNG algorithm changed — which silently breaks
    // every recorded replay and every seed-shared city. Never "fix" the
    // expected values without understanding what changed.
    const first5 = (seed: number): number[] => {
      let s = seedRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        let v: number;
        [v, s] = nextU32(s);
        out.push(v);
      }
      return out;
    };
    expect(first5(42)).toEqual([2581720956, 1925393290, 3661312704, 2876485805, 750819978]);
    expect(first5(20260726)).toEqual([3567755325, 1331168790, 4178261331, 332091306, 92361997]);
  });

  it('is deterministic for the same seed', () => {
    const run = (seed: number) => {
      let s = seedRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 100; i++) {
        let v: number;
        [v, s] = nextU32(s);
        out.push(v);
      }
      return out;
    };
    expect(run(1234)).toEqual(run(1234));
    expect(run(1234)).not.toEqual(run(1235));
  });

  it('nextFloat01 stays in [0, 1)', () => {
    let s = seedRng(99);
    for (let i = 0; i < 10_000; i++) {
      let f: number;
      [f, s] = nextFloat01(s);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('nextIntRange stays in range and hits both ends', () => {
    let s = seedRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      let v: number;
      [v, s] = nextIntRange(s, 3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(9);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  it('does not mutate its input state', () => {
    const s0 = seedRng(42);
    const [a] = nextU32(s0);
    const [b] = nextU32(s0);
    expect(a).toBe(b);
  });
});
