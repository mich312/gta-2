import { describe, expect, it } from 'vitest';
import { type FlickerKind, flicker, lampCharacter } from '../src/render/lighting.js';
import { hash2, noise1 } from '../src/render/noise.js';

const KINDS: FlickerKind[] = ['steady', 'buzz', 'failing', 'dead', 'fire', 'neon'];

describe('flicker', () => {
  it('stays in a sane range for every kind', () => {
    for (const kind of KINDS) {
      let lo = Infinity;
      let hi = -Infinity;
      let finite = true;
      for (let id = 0; id < 24; id++) {
        for (let ms = 0; ms < 40000; ms += 37) {
          const v = flicker(kind, id, ms);
          finite = finite && Number.isFinite(v);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      expect(finite, kind).toBe(true);
      expect(lo, `${kind} floor`).toBeGreaterThanOrEqual(0);
      // Fire is the only one allowed to overshoot, and not by much: a
      // multiplier above ~1.25 blows the light out to white.
      expect(hi, `${kind} ceiling`).toBeLessThanOrEqual(1.25);
    }
  });

  it('is a function of wall-clock, not of frame rate', () => {
    // The same instant has to give the same answer however you arrived at it,
    // or a 144 Hz display gets a different lamp from a 30 Hz one.
    for (const kind of KINDS) {
      expect(flicker(kind, 3, 5123.5)).toBe(flicker(kind, 3, 5123.5));
    }
  });

  it('actually varies, and differs between lamps', () => {
    for (const kind of KINDS) {
      // Per lamp rather than for one chosen lamp: a dead one only tries to
      // come back on every half-minute, and a neon that never stutters over
      // the minute sampled is a working neon, not a broken model.
      let moved = 0;
      for (let id = 0; id < 40; id++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let ms = 0; ms < 60000; ms += 40) {
          const v = flicker(kind, id, ms);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > 0.05) moved++;
      }
      expect(moved, `${kind} lamps that move`).toBeGreaterThan(0);

      // Out of phase with each other, too, or a street breathes in unison.
      // Compared as time series rather than at one instant: a neon sign is
      // lit 93% of the time, so a snapshot of a hundred of them is a hundred
      // identical numbers and says nothing about whether they are in step.
      let apart = 0;
      for (let id = 0; id < 20; id++) {
        for (let ms = 0; ms < 60000; ms += 40) {
          if (Math.abs(flicker(kind, id, ms) - flicker(kind, id + 1, ms)) > 0.015) {
            apart++;
            break;
          }
        }
      }
      expect(apart, `${kind} pairs out of step`).toBeGreaterThanOrEqual(15);
    }
  });

  it('keeps a steady lamp steady and a dead one dark', () => {
    let steadyMin = 1;
    let deadMean = 0;
    let n = 0;
    for (let ms = 0; ms < 30000; ms += 17) {
      steadyMin = Math.min(steadyMin, flicker('steady', 5, ms));
      deadMean += flicker('dead', 5, ms);
      n++;
    }
    expect(steadyMin).toBeGreaterThan(0.9);
    expect(deadMean / n).toBeLessThan(0.25);
  });
});

describe('lampCharacter', () => {
  it('is stable for an id', () => {
    expect(lampCharacter(42)).toBe(lampCharacter(42));
  });

  it('leaves most of the street working', () => {
    const counts = new Map<FlickerKind, number>();
    const n = 4000;
    for (let id = 0; id < n; id++) {
      const k = lampCharacter(id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // A street where every third lamp is broken reads as a set, not a city.
    expect((counts.get('steady') ?? 0) / n).toBeGreaterThan(0.5);
    // But every character has to actually turn up, or the model is decoration.
    for (const k of ['steady', 'buzz', 'failing', 'dead'] as FlickerKind[]) {
      expect(counts.get(k) ?? 0, k).toBeGreaterThan(20);
    }
  });
});

describe('noise', () => {
  it('hashes to the unit interval', () => {
    for (let x = -50; x < 50; x++) {
      for (let y = -3; y < 3; y++) {
        const v = hash2(x, y, 7);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('interpolates without a step at the lattice', () => {
    // A discontinuity here is a visible pop in every lamp that uses it.
    for (let i = -4; i < 4; i++) {
      const before = noise1(i - 1e-6, 3);
      const at = noise1(i, 3);
      expect(Math.abs(before - at)).toBeLessThan(1e-4);
    }
  });
});
