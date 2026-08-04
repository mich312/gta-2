import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import { T_BRIDGE, T_ROAD } from '../src/world/types.js';

/**
 * The street courses (WORLDGEN.md §16): the authored roads' centrelines,
 * shipped so the renderer can stroke a curved road as one line. The ribbon
 * contradicting the tiles — asphalt painted where the map is not road — is
 * the failure mode the bake's trim pass exists to prevent, so it is the
 * invariant this file holds.
 */
describe('street courses', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));

  it('ships the authored roads: the ring carriageways and the avenues', () => {
    expect(city.courses.length).toBeGreaterThan(10);
    expect(city.courses.filter((c) => c.kind === 'ring').length).toBeGreaterThanOrEqual(2);
    expect(city.courses.every((c) => c.width >= 2)).toBe(true);
  });

  it('keeps every centreline on the carriageway it was carved as', () => {
    const W = city.widthTiles;
    const on = (x: number, y: number): boolean => {
      const t = city.tiles[Math.floor(y) * W + Math.floor(x)] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    for (const c of city.courses) {
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k] as readonly [number, number];
        const [bx, by] = c.points[k + 1] as readonly [number, number];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
        for (let s = 0; s <= steps; s++) {
          const x = ax + ((bx - ax) * s) / steps;
          const y = ay + ((by - ay) * s) / steps;
          // Quantised to the hundredth of a tile on encode, so a sample can
          // sit a hair off the trimmed line; the tile under it must still
          // be carriageway.
          expect(on(x, y), `course off carriageway at ${x.toFixed(1)},${y.toFixed(1)}`).toBe(true);
        }
      }
    }
  });

  it('round-trips through the wire form unchanged', () => {
    expect(city.courses.length).toBeGreaterThan(0);
    for (const c of city.courses) {
      expect(c.points.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of c.points) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBe(Math.round(x * 100) / 100);
        expect(y).toBe(Math.round(y * 100) / 100);
      }
    }
  });
});
