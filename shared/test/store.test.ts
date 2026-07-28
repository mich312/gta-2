import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { WorldStore } from '../src/world/store.js';

const base = parseWorldgenParams(worldgenJson);

/**
 * THE B1 gate (WORLDGEN.md §11.2): the store and a directly-generated
 * window must agree bit-for-bit on the window's interior. The margin is
 * the established rim allowance — carving passes suppress near a window
 * edge, and the store's padded cells have no rim there.
 */
describe('WorldStore (B1)', () => {
  it('serves tiles bit-identical to a generated window, away from its rim', () => {
    for (const seed of [7, 1234]) {
      const window = generateCity(seed, base);
      const store = new WorldStore(seed, base);
      const margin = base.arterialSpacing + Math.ceil(base.arterialSpacing / 2);
      let checked = 0;
      for (let ty = margin; ty < base.heightTiles - margin; ty += 1) {
        for (let tx = margin; tx < base.widthTiles - margin; tx += 1) {
          const w = window.tiles[ty * window.widthTiles + tx];
          const s = store.tileAt(base.windowX + tx, base.windowY + ty);
          if (w !== s) {
            expect(`tile mismatch at (${tx}, ${ty}): window=${w} store=${s}`).toBe('');
          }
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1000);
    }
  });

  it('eviction never changes what regeneration produces', () => {
    // Tiny capacity forces churn; a re-read after eviction must reproduce
    // the evicted cell exactly. Cells are pure functions — pinned here so
    // an impure cache can never sneak in.
    const store = new WorldStore(7, base, 2);
    const probes: Array<[number, number]> = [
      [100, 100],
      [400, 100],
      [700, 100],
      [100, 400],
    ];
    const first = probes.map(([gx, gy]) => store.tileAt(gx, gy));
    // Touch enough distinct cells that every earlier one is evicted.
    for (const [gx, gy] of probes) store.tileAt(gx + 3000, gy + 3000);
    const again = probes.map(([gx, gy]) => store.tileAt(gx, gy));
    expect(again).toEqual(first);
    expect(store.size()).toBeLessThanOrEqual(2);
  });

  it('finds landmarks by region, in global coordinates', { timeout: 60_000 }, () => {
    const store = new WorldStore(7, base);
    const found = store.landmarksIn(0, 0, base.widthTiles, base.heightTiles);
    expect(found.length).toBeGreaterThan(3);
    for (const l of found) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThan(base.widthTiles);
    }
    // Hospitals appear — the coverage lattice streams by construction.
    expect(found.some((l) => l.kind === 'hospital')).toBe(true);
  });
});
