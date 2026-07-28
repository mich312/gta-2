import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { TICK_RATE } from '../src/constants.js';
import { crowdScale, nightAmount, timeOfDay } from '../src/sim/daynight.js';
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
