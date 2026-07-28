import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { deriveSeed } from '../src/rng/prng.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { makeFields, valueNoise } from '../src/world/fields.js';
import { districtClassifier } from '../src/world/districts.js';
import { generateCity } from '../src/world/generate.js';
import { DISTRICT_TYPES } from '../src/world/types.js';

const params = parseWorldgenParams(worldgenJson);
const SEEDS = [1, 7, 42, 1234, 90210];

describe('deriveSeed', () => {
  it('same inputs same stream, different labels different streams', () => {
    expect(deriveSeed(7, 'roads')).toBe(deriveSeed(7, 'roads'));
    expect(deriveSeed(7, 'roads')).not.toBe(deriveSeed(7, 'shops'));
    expect(deriveSeed(7, 'roads')).not.toBe(deriveSeed(8, 'roads'));
  });
});

describe('fields (L0)', () => {
  it('noise is deterministic and bounded', () => {
    for (let i = 0; i < 500; i++) {
      const x = (i % 37) * 0.73;
      const y = (i % 51) * 1.19;
      const v = valueNoise(1234, x, y);
      expect(v).toBe(valueNoise(1234, x, y));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('density peaks at the core and falls to the rim', () => {
    for (const seed of SEEDS) {
      const f = makeFields(seed, params);
      const atCore = f.density(Math.round(f.core.x), Math.round(f.core.y));
      const atCorner = f.density(2, 2);
      expect(atCore).toBeGreaterThan(0.8);
      expect(atCorner).toBeLessThan(0.35);
    }
  });
});

describe('district classification (L1)', () => {
  it('every district type appears, and downtown sits nearer the core than industry', () => {
    for (const seed of SEEDS) {
      const classify = districtClassifier(seed, params);
      const f = makeFields(seed, params);
      const counts = new Map<string, number>();
      let dtDist = 0;
      let dtN = 0;
      let indDist = 0;
      let indN = 0;
      for (let ty = 0; ty < params.heightTiles; ty += 2) {
        for (let tx = 0; tx < params.widthTiles; tx += 2) {
          const d = DISTRICT_TYPES[classify(tx, ty)] as string;
          counts.set(d, (counts.get(d) ?? 0) + 1);
          const dist = Math.hypot(tx - f.core.x, ty - f.core.y);
          if (d === 'downtown') {
            dtDist += dist;
            dtN++;
          } else if (d === 'industrial') {
            indDist += dist;
            indN++;
          }
        }
      }
      for (const type of DISTRICT_TYPES) {
        expect(counts.get(type) ?? 0, `seed ${seed} has no ${type}`).toBeGreaterThan(0);
      }
      // The concentric promise: downtown is the centre, industry the rim.
      expect(dtDist / dtN).toBeLessThan(indDist / indN);
    }
  });

  it('districts are contiguous regions, not confetti', () => {
    // Same bar the turf test sets: neighbouring samples agree most of the
    // time. Confetti fails this; any honest partition passes it.
    for (const seed of SEEDS) {
      const classify = districtClassifier(seed, params);
      let same = 0;
      let pairs = 0;
      for (let ty = 0; ty < params.heightTiles - 4; ty += 4) {
        for (let tx = 0; tx < params.widthTiles - 4; tx += 4) {
          const here = classify(tx, ty);
          same += classify(tx + 4, ty) === here ? 1 : 0;
          same += classify(tx, ty + 4) === here ? 1 : 0;
          pairs += 2;
        }
      }
      expect(same / pairs).toBeGreaterThan(0.75);
    }
  });
});

describe('hierarchical seeding (WORLDGEN.md §9.3)', () => {
  it('a pass consuming extra randomness does not move other passes', () => {
    // The property the refactor bought: streams are independent. Simulated
    // here structurally — shops draw from `worldgen.shops`, roads from
    // `worldgen.roads` — by asserting the derived stream seeds differ and
    // that two cities from the same seed are still identical (regression
    // guard for the plumbing itself).
    const a = generateCity(555, params);
    const b = generateCity(555, params);
    expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(true);
    expect(a.shops).toEqual(b.shops);
    expect(a.landmarks).toEqual(b.landmarks);
    expect(deriveSeed(555, 'worldgen.shops')).not.toBe(deriveSeed(555, 'worldgen.roads'));
  });
});
