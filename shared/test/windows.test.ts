import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';

/**
 * THE infinite-world invariant: the world is a pure function of (seed,
 * global coordinate), and a window is a viewport onto it. Two overlapping
 * windows must therefore agree tile-for-tile in their shared interior.
 *
 * The rim is excluded: carving passes (shops, landmarks) skip footprints
 * not fully inside their own window, so within one arterial-cell span of a
 * window's edge the two views may differ. That is the documented edge
 * effect — confined to the rim by construction — and the margin below is
 * sized to it.
 */

const base = parseWorldgenParams(worldgenJson);

function windowAt(wx: number, wy: number): typeof base {
  return { ...base, windowX: wx, windowY: wy };
}

describe('windows onto the unbounded world', () => {
  it('overlapping windows agree tile-for-tile away from their rims', () => {
    for (const seed of [7, 1234]) {
      // 320-tile windows so the overlap interior survives the rim margins.
      const size = { widthTiles: 320, heightTiles: 320 };
      const a = generateCity(seed, { ...windowAt(0, 0), ...size });
      const b = generateCity(seed, { ...windowAt(96, 48), ...size });
      // Overlap in global tiles: [96, 320) × [48, 320). Margin: one full
      // cell span (a rim cell can reach that far inward) plus jitter.
      const margin = base.arterialSpacing + Math.ceil(base.arterialSpacing / 2);
      const gx0 = 96 + margin;
      const gy0 = 48 + margin;
      const gx1 = 320 - margin;
      const gy1 = 320 - margin;
      expect(gx1 - gx0).toBeGreaterThan(40); // the test actually tests something
      let checked = 0;
      for (let gy = gy0; gy < gy1; gy++) {
        for (let gx = gx0; gx < gx1; gx++) {
          const ta = a.tiles[gy * a.widthTiles + gx];
          const tb = b.tiles[(gy - 48) * b.widthTiles + (gx - 96)];
          if (ta !== tb) {
            // One expect per mismatch would drown the output; fail loudly
            // on the first with coordinates in the message.
            expect(
              `tile mismatch at global (${gx}, ${gy}): windowA=${ta} windowB=${tb}`,
            ).toBe('');
          }
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1000);
    }
  });

  it('a window a million tiles out is still a city, generated at the same cost', () => {
    const far = generateCity(7, windowAt(1_000_128, -777_600));
    let roads = 0;
    for (const t of far.tiles) if (t === 1) roads++;
    expect(roads / far.tiles.length).toBeGreaterThan(0.05);
    expect(far.buildings.length).toBeGreaterThan(100);
    expect(far.playerSpawns.length).toBeGreaterThanOrEqual(8);
    // Coverage lattice holds anywhere in the world.
    expect(far.hospitals.length).toBeGreaterThan(0);
    expect(far.policeStations.length).toBeGreaterThan(0);
  });

  it('distant windows are different places, same seed', () => {
    const here = generateCity(42, windowAt(0, 0));
    const there = generateCity(42, windowAt(100_000, 100_000));
    expect(Buffer.from(here.tiles).equals(Buffer.from(there.tiles))).toBe(false);
  });

  it('negative coordinates are as good as positive ones', () => {
    const m = generateCity(99, windowAt(-5_000, -12_345));
    let buildings = 0;
    for (const t of m.tiles) if (t === 3) buildings++;
    expect(buildings).toBeGreaterThan(0);
    expect(m.hospitals.length).toBeGreaterThan(0);
  });
});
