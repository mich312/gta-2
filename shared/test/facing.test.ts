import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import { buildingCorners, buildingMass } from '../src/world/heights.js';
import { T_BUILDING, T_FLOOR, type Building } from '../src/world/types.js';

/**
 * Which way a building faces (WORLDGEN.md §20).
 *
 * The invariant that matters is not that the mass is turned — it is that
 * turning it changed nothing but the drawing. The footprint is what collision,
 * the volume grid, doorways and every placement pass read, and it is exactly
 * the rect it always was; the mass is a renderer's business and has to stay
 * inside the plot the footprint claims.
 */
describe('a building that faces its street', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));

  it('keeps its mass inside its own plot', () => {
    // Half a tile of slack, and not one tile: a mass may lean into its own
    // pavement, because that is where a doorstep is, and may not lean into
    // the carriageway.
    for (const b of city.buildings) {
      const corners = buildingCorners(b);
      for (const [cx, cy] of corners) {
        expect(cx, `${b.x},${b.y}`).toBeGreaterThanOrEqual(b.x - 0.26);
        expect(cy, `${b.x},${b.y}`).toBeGreaterThanOrEqual(b.y - 0.26);
        expect(cx, `${b.x},${b.y}`).toBeLessThanOrEqual(b.x + b.w + 0.26);
        expect(cy, `${b.x},${b.y}`).toBeLessThanOrEqual(b.y + b.h + 0.26);
      }
    }
  });

  it('leaves a square building exactly square', () => {
    const b: Building = { x: 10, y: 20, w: 4, h: 6, district: 'downtown' };
    const m = buildingMass(b);
    expect(m).toEqual({ cx: 12, cy: 23, w: 4, h: 6, rad: 0 });
    expect(buildingCorners(b)).toEqual([
      [10, 20],
      [14, 20],
      [14, 26],
      [10, 26],
    ]);
  });

  it('turns about the footprint centre, keeping its area in proportion', () => {
    const b: Building = { x: 0, y: 0, w: 6, h: 4, district: 'downtown', angle: 30 };
    const m = buildingMass(b);
    expect(m.cx).toBe(3);
    expect(m.cy).toBe(2);
    // Same aspect ratio, scaled down enough to fit back inside the plot.
    expect(m.w / m.h).toBeCloseTo(6 / 4, 6);
    expect(m.w).toBeLessThan(6);
    // The corners are a rectangle: opposite sides equal, diagonals equal.
    const c = buildingCorners(b);
    const d = (i: number, j: number): number =>
      Math.hypot(
        (c[i] as [number, number])[0] - (c[j] as [number, number])[0],
        (c[i] as [number, number])[1] - (c[j] as [number, number])[1],
      );
    expect(d(0, 1)).toBeCloseTo(d(2, 3), 6);
    expect(d(1, 2)).toBeCloseTo(d(3, 0), 6);
    expect(d(0, 2)).toBeCloseTo(d(1, 3), 6);
  });

  it('faces what its own tiles say the street does', () => {
    const W = city.widthTiles;
    let turned = 0;
    for (const b of city.buildings) {
      const angle = b.angle ?? 0;
      if (angle === 0) continue;
      turned++;
      // Derived from the bearing plane, and only where the whole footprint
      // agrees — a building on a seam between two fabrics faces neither.
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          expect(city.bearing[ty * W + tx], `${b.x},${b.y}`).toBe(angle);
        }
      }
    }
    // The rotated boroughs and the curved fabrics between them: about two
    // fifths of the city. If this collapses, the bearing plane or the fabric
    // that writes it has gone quiet.
    expect(turned).toBeGreaterThan(city.buildings.length * 0.25);
  });

  it('is still bookkept as the axis-aligned rect the ground says it is', () => {
    // The footprint is the contract with everything that is not a renderer.
    // A turned building whose TILES moved would move collision with them.
    const W = city.widthTiles;
    for (const b of city.buildings) {
      if ((b.angle ?? 0) === 0) continue;
      expect(Number.isInteger(b.x) && Number.isInteger(b.y)).toBe(true);
      expect(Number.isInteger(b.w) && Number.isInteger(b.h)).toBe(true);
      // Its centre tile is still its own ground. Building OR shop floor: a
      // shop is a room punched out of a footprint and open to the sky, which
      // is exactly why the renderers refuse to draw those as one mass — but
      // the FACING is recorded for every building, because the angle is a
      // property of the street it fronts and not of how it is drawn.
      const cx = b.x + (b.w >> 1);
      const cy = b.y + (b.h >> 1);
      const t = city.tiles[cy * W + cx] as number;
      expect(t === T_BUILDING || t === T_FLOOR, `${b.x},${b.y} is ${t}`).toBe(true);
    }
  });
});
