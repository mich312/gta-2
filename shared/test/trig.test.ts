import { describe, expect, it } from 'vitest';
import { dSin, dCos, dAtan2, wrapAngle, PI, TWO_PI } from '../src/math/trig.js';

// Tests may reference Math trig — the rule is only that SIM code never does.
describe('deterministic trig', () => {
  it('dSin matches Math.sin within 1e-6 across many revolutions', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i * 0.037;
      expect(Math.abs(dSin(x) - Math.sin(x))).toBeLessThan(1e-6);
    }
  });

  it('dCos matches Math.cos within 1e-6', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i * 0.041;
      expect(Math.abs(dCos(x) - Math.cos(x))).toBeLessThan(1e-6);
    }
  });

  it('dAtan2 matches Math.atan2 within 1e-4 in all quadrants', () => {
    const vals = [-10, -2, -1, -0.5, -0.01, 0, 0.01, 0.5, 1, 2, 10];
    for (const y of vals) {
      for (const x of vals) {
        if (x === 0 && y === 0) continue;
        expect(Math.abs(dAtan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-4);
      }
    }
    expect(dAtan2(0, 0)).toBe(0);
  });

  it('wrapAngle lands in [-PI, PI)', () => {
    for (let i = -100; i <= 100; i++) {
      const w = wrapAngle(i * 1.7);
      expect(w).toBeGreaterThanOrEqual(-PI);
      expect(w).toBeLessThan(PI);
      // wrapped angle is equivalent modulo 2*PI
      const k = (i * 1.7 - w) / TWO_PI;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
  });
});
