import { describe, expect, it } from 'vitest';
import {
  coastRings,
  contourRings,
  rasteriseRings,
  ringArea2,
  ringHasInterior,
  sampleField,
  type Ring,
} from '../src/world/geometry.js';

/**
 * Boundaries as curves (VECTOR.md §2, WORLDGEN.md §25).
 *
 * Two properties carry everything downstream. The rings must be wound with
 * the water on the right, because three painters have assumed that since §18.
 * And rasterising the rings must reproduce the field they came from, because
 * that is the whole claim: the tile plane is a function of the curve, not a
 * second opinion about where the edge is.
 */

/** A disc of radius `r` about the map centre: positive inside. */
const disc = (cx: number, cy: number, r: number) => (x: number, y: number): number =>
  r - Math.hypot(x - cx, y - cy);

describe('the zero contour of a field', () => {
  it('closes one ring round a disc, on the circle', () => {
    const f = sampleField(disc(32, 32, 20), 64, 64, 0.5);
    const rings = contourRings(f);
    expect(rings).toHaveLength(1);
    for (const [x, y] of rings[0] as Ring) {
      // Interpolated marching squares puts every vertex on the true circle to
      // within the curvature error over one cell — far inside a tile.
      expect(Math.abs(Math.hypot(x - 32, y - 32) - 20)).toBeLessThan(0.05);
    }
  });

  it('is smooth, not stepped — which is the entire point', () => {
    // The failure this replaces: a contour traced from a MASK has vertices on
    // lattice lines and turns only at right angles. An interpolated one has
    // its vertices anywhere, and its turns are gentle. Measured as the share
    // of segments running within 7.5° of an axis — the metric the audit used
    // on the old coast, where it was 55%.
    const f = sampleField(disc(32, 32, 20), 64, 64, 0.5);
    const r = rings1(f);
    let axial = 0;
    let total = 0;
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i] as readonly [number, number];
      const [bx, by] = r[(i + 1) % r.length] as readonly [number, number];
      const a = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
      const off = Math.min(...[0, 90, 180, -90, -180].map((k) => Math.abs(a - k)));
      if (off < 7.5) axial++;
      total++;
    }
    expect(axial / total).toBeLessThan(0.25);
  });

  it('winds with the water on the right, so land is on the left', () => {
    const f = sampleField(disc(32, 32, 20), 64, 64, 0.5);
    const r = rings1(f);
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i] as readonly [number, number];
      const [bx, by] = r[(i + 1) % r.length] as readonly [number, number];
      // A quarter turn clockwise on screen (y down) from the direction of
      // travel is the wet side: step a whole tile that way and you are off
      // the island. A UNIT normal, so the assertion does not quietly weaken
      // wherever the contour happens to emit a short segment.
      const len = Math.hypot(bx - ax, by - ay);
      expect(len, 'zero-length segment in a ring').toBeGreaterThan(0);
      const mx = (ax + bx) / 2 - ((by - ay) / len);
      const my = (ay + by) / 2 + ((bx - ax) / len);
      expect(Math.hypot(mx - 32, my - 32)).toBeGreaterThan(20);
    }
  });

  it('gives a lake its own ring, wound the other way', () => {
    // Land everywhere except a disc: the ring encloses WATER.
    const f = sampleField((x, y) => Math.hypot(x - 32, y - 32) - 12, 64, 64, 0.5);
    const rings = coastRings(f, 10);
    expect(rings).toHaveLength(1);
    expect((rings[0] as { land: boolean }).land).toBe(false);
  });
});

describe('rings back to a mask', () => {
  it('reproduces the field the rings came from', () => {
    // THE claim of VECTOR.md: the tile plane is a pure function of the curve.
    // Every tile whose centre is clearly one side of the true boundary must
    // come back on that side. Tiles the boundary actually crosses are
    // excluded — a rasteriser has to round somewhere, and half a tile from
    // the line is where.
    const at = disc(32, 32, 20);
    const f = sampleField(at, 64, 64, 0.5);
    const mask = rasteriseRings(coastRings(f, 10).map((c) => c.points), 64, 64);
    let checked = 0;
    for (let ty = 0; ty < 64; ty++) {
      for (let tx = 0; tx < 64; tx++) {
        const v = at(tx + 0.5, ty + 0.5);
        if (Math.abs(v) < 1) continue;
        expect(mask[ty * 64 + tx], `${tx},${ty} field=${v.toFixed(2)}`).toBe(v > 0 ? 1 : 0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('cuts a lake out of the land it sits in', () => {
    const f = sampleField(
      (x, y) => Math.min(28 - Math.hypot(x - 32, y - 32), Math.hypot(x - 32, y - 32) - 10),
      64,
      64,
      0.5,
    );
    const mask = rasteriseRings(coastRings(f, 10).map((c) => c.points), 64, 64);
    expect(mask[32 * 64 + 32]).toBe(0); // the middle of the lake
    expect(mask[32 * 64 + 50]).toBe(1); // the ring of land round it
    expect(mask[32 * 64 + 62]).toBe(0); // the sea outside
  });
});

describe('an island, and a bar pretending to be one', () => {
  const rect = (w: number, h: number): Ring => [
    [10, 10],
    [10 + w, 10],
    [10 + w, 10 + h],
    [10, 10 + h],
  ];

  it('keeps a shape with an interior and drops one without', () => {
    // Area cannot tell these apart: 4x50 = 200 tiles and 14x14 = 196. Width
    // can, and width is what makes an island an island rather than a sandbar
    // standing in open water with nothing behind it.
    expect(Math.abs(ringArea2(rect(4, 50)) / 2)).toBeCloseTo(200, 6);
    expect(ringHasInterior(rect(14, 14))).toBe(true);
    expect(ringHasInterior(rect(4, 50))).toBe(false);
  });
});

/** The single ring of a one-island field, for brevity above. */
function rings1(f: Parameters<typeof contourRings>[0]): Ring {
  const rings = contourRings(f);
  expect(rings.length).toBe(1);
  return rings[0] as Ring;
}
