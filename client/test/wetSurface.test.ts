import { describe, expect, it } from 'vitest';
import {
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FIELD,
  T_FLOOR,
  T_LOT,
  T_PARK,
  T_RAMP,
  T_ROAD,
  T_RUNWAY,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
} from 'shared';
import { sheenOf } from '../src/render/tiles.js';

/**
 * Which surfaces the rain shows up on.
 *
 * The wet-road shader is one multiply and one add; all of the art is in this
 * table. Rain falls on the whole city evenly and what makes it read as rain
 * is that the city does not respond evenly — the carriageway turns into a
 * mirror and the park does almost nothing, and a lawn that glosses over like
 * tarmac reads instantly as a bug even to someone who could not say why.
 *
 * The failure mode this guards is silent: a new terrain type gets no entry,
 * `sheenOf` returns 0 for it, and it is simply never wet. Nothing throws and
 * no screenshot obviously differs — it just quietly stays dry for ever.
 */

/** Everything a player can stand on. Add a terrain, add it here. */
const TERRAIN = [
  T_FIELD,
  T_ROAD,
  T_SIDEWALK,
  T_BUILDING,
  T_PARK,
  T_LOT,
  T_WATER,
  T_BRIDGE,
  T_RAMP,
  T_FLOOR,
  T_BANK,
  T_TREES,
  T_SAND,
  T_RUNWAY,
];

describe('what the rain lands on', () => {
  it('gives every terrain a sheen inside 0 and 1', () => {
    for (const tile of TERRAIN) {
      const s = sheenOf(tile);
      expect(s, `tile ${tile}`).toBeGreaterThanOrEqual(0);
      expect(s, `tile ${tile}`).toBeLessThanOrEqual(1);
    }
  });

  it('turns the sealed surfaces into mirrors', () => {
    // Tarmac and concrete do not absorb, so the water stays on top. These are
    // the surfaces the effect exists for.
    for (const tile of [T_ROAD, T_BRIDGE, T_RUNWAY, T_LOT, T_SIDEWALK, T_RAMP]) {
      expect(sheenOf(tile), `tile ${tile}`).toBeGreaterThan(0.8);
    }
  });

  it('lets the soft ground drink it', () => {
    for (const tile of [T_FIELD, T_PARK, T_SAND, T_TREES]) {
      expect(sheenOf(tile), `tile ${tile}`).toBeLessThan(0.2);
    }
  });

  it('leaves water and building interiors alone', () => {
    // The river is not a wet road, and a chunk paints a building's footprint
    // only so it has something opaque to put there — nobody ever sees it.
    expect(sheenOf(T_WATER)).toBe(0);
    expect(sheenOf(T_BUILDING)).toBe(0);
  });

  it('is dry for anything it has never heard of', () => {
    // The default, stated: a terrain nobody has thought about does not
    // suddenly gloss. It is the safe direction to fail in, and it is also
    // the one that hides a missing entry, which is why the list above exists.
    expect(sheenOf(999)).toBe(0);
    expect(sheenOf(-1)).toBe(0);
  });

  it('does not make the carriageway and the verge the same surface', () => {
    // The whole read. If these ever converge, the city goes uniformly dark in
    // the rain instead of the roads standing out of it.
    expect(sheenOf(T_ROAD)).toBeGreaterThan(sheenOf(T_PARK) * 4);
  });
});
