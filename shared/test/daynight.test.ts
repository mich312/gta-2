import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { TICK_RATE } from '../src/constants.js';
import { crowdScale, nightAmount, timeOfDay, wetness } from '../src/sim/daynight.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';

const DAY = worldgenJson.dayLengthSec;

describe('the clock (L1)', () => {
  it('is a pure function of the tick, so two hosts cannot disagree', () => {
    // The whole design. If this ever needs a GameState to answer, the clock
    // has grown a desync surface and a message to carry it.
    for (const tick of [0, 1, 997, 50_000, 1_234_567]) {
      expect(timeOfDay(tick, DAY)).toBe(timeOfDay(tick, DAY));
    }
  });

  it('wraps, and covers a whole day', () => {
    const ticksPerDay = Math.round(DAY * TICK_RATE);
    expect(timeOfDay(0, DAY)).toBeCloseTo(timeOfDay(ticksPerDay, DAY), 10);
    let min = 1;
    let max = 0;
    for (let i = 0; i < ticksPerDay; i += 37) {
      const t = timeOfDay(i, DAY);
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    expect(min).toBeLessThan(0.02);
    expect(max).toBeGreaterThan(0.98);
  });

  it('starts in daylight, because 3am is a miserable first impression', () => {
    expect(nightAmount(timeOfDay(0, DAY))).toBeLessThan(0.35);
  });

  it('is darkest at midnight and brightest at midday', () => {
    expect(nightAmount(0)).toBeGreaterThan(0.95);
    expect(nightAmount(0.5)).toBeLessThan(0.05);
    // ...and it gets there smoothly, with no step between keyframes: a jump
    // would read as a seam across the whole screen.
    let biggest = 0;
    let prev = nightAmount(0);
    for (let i = 1; i <= 400; i++) {
      const now = nightAmount(i / 400);
      biggest = Math.max(biggest, Math.abs(now - prev));
      prev = now;
    }
    expect(biggest).toBeLessThan(0.02);
  });

  it('thins the crowd overnight and fills it again by day', () => {
    const scale = worldgenJson.nightCrowdScale;
    expect(crowdScale(0.5, scale)).toBeCloseTo(1, 2); // midday, everybody out
    expect(crowdScale(0, scale)).toBeCloseTo(scale, 2); // midnight
    expect(crowdScale(0, scale)).toBeLessThan(crowdScale(0.5, scale));
  });

  it('the map carries the day length, so client and server share one clock', () => {
    const map = generateCity(777, parseWorldgenParams(worldgenJson));
    expect(map.dayLengthSec).toBe(DAY);
  });

  it('an older worldgen block with no clock still parses', () => {
    // Replay headers and saved configs predate this field; a city with no
    // clock is simply the fixed-dusk city this one used to be.
    const raw = { ...worldgenJson } as Record<string, unknown>;
    delete raw['dayLengthSec'];
    delete raw['nightCrowdScale'];
    const p = parseWorldgenParams(raw);
    expect(p.dayLengthSec).toBeGreaterThan(0);
    expect(p.nightCrowdScale).toBeGreaterThan(0);
  });
});

describe('the weather', () => {
  it('is a pure function of the tick, like the clock', () => {
    // The reason there is no rain message on the wire. If this ever needs
    // state, two players on the same corner can disagree about whether the
    // street is wet, which is exactly the class of desync the clock avoids.
    for (const tick of [0, 1, 997, 50_000, 1_234_567]) {
      expect(wetness(tick, DAY)).toBe(wetness(tick, DAY));
    }
  });

  it('stays inside 0 and 1', () => {
    for (let t = 0; t < DAY * TICK_RATE * 8; t += 53) {
      const w = wetness(t, DAY);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the city dry most of the time, and soaks it sometimes', () => {
    // Both halves matter. Permanent rain is a repaint, not weather; rain that
    // never happens is a shader nobody sees.
    let dry = 0;
    let soaked = 0;
    let n = 0;
    for (let t = 0; t < DAY * TICK_RATE * 40; t += 31) {
      const w = wetness(t, DAY);
      n++;
      if (w < 0.02) dry++;
      if (w > 0.5) soaked++;
    }
    expect(dry / n).toBeGreaterThan(0.4);
    expect(dry / n).toBeLessThan(0.8);
    expect(soaked / n).toBeGreaterThan(0.05);
  });

  it('arrives faster than it leaves', () => {
    // Rain wets a road in a minute and the road takes ten to dry. A symmetric
    // ramp reads as a crossfade between two paint jobs rather than as weather.
    const step = 60; // two seconds
    let rising = 0;
    let falling = 0;
    for (let t = 0; t < DAY * TICK_RATE * 20; t += step) {
      const d = wetness(t + step, DAY) - wetness(t, DAY);
      if (d > 1e-6) rising++;
      else if (d < -1e-6) falling++;
    }
    expect(falling).toBeGreaterThan(rising * 3);
  });

  it('does not repeat on any span short enough to learn', () => {
    // Two fronts of different lengths, so the interesting property is that
    // the second does not line up with the first for a very long time.
    const at = (days: number): number => wetness(days * DAY * TICK_RATE, DAY);
    let same = 0;
    for (let d = 0; d < 8; d += 0.01) {
      if (Math.abs(at(d) - at(d + 0.62)) < 0.01) same++;
    }
    // A single front of period 0.62 would score 800 here.
    expect(same).toBeLessThan(500);
  });

  it('gives a longer day longer weather, so the sky and the street agree', () => {
    // Both are fractions of a day. A server with a two-hour day should not get
    // a sky that turns over in two hours and rain that turns over in seven
    // minutes.
    const short = wetness(1000, 600);
    const long = wetness(1000 * 4, 600 * 4);
    expect(long).toBeCloseTo(short, 10);
  });
});
