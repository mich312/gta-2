import { describe, expect, it } from 'vitest';
import { extrusionOf, parallaxOffset } from '../src/render/extrudeGeom.js';
import { buildingStoreys } from '../../shared/src/world/heights.js';
import type { Building } from '../../shared/src/world/types.js';

const base = { x: 100, y: 100, w: 40, h: 40 };
const CAM = { x: 500, y: 500, hw: 500, hh: 500 };

describe('parallax offset', () => {
  it('leans a building away from the screen centre, never towards it', () => {
    // Right of centre leans right; left of centre leans left. If this is ever
    // inverted the city closes in around the camera instead of opening out,
    // which reads as a fisheye rather than as height.
    const right = parallaxOffset(900, 500, CAM.x, CAM.y, CAM.hw, CAM.hh, 10);
    expect(right.x).toBeGreaterThan(0);
    const left = parallaxOffset(100, 500, CAM.x, CAM.y, CAM.hw, CAM.hh, 10);
    expect(left.x).toBeLessThan(0);
    const below = parallaxOffset(500, 900, CAM.x, CAM.y, CAM.hw, CAM.hh, 10);
    expect(below.y).toBeGreaterThan(0);
  });

  it('does not lean a building directly under the camera', () => {
    const under = parallaxOffset(500, 500, CAM.x, CAM.y, CAM.hw, CAM.hh, 10);
    expect(under.x).toBe(0);
    expect(under.y).toBe(0);
  });

  it('leans in proportion to height', () => {
    const short = parallaxOffset(900, 500, CAM.x, CAM.y, CAM.hw, CAM.hh, 5);
    const tall = parallaxOffset(900, 500, CAM.x, CAM.y, CAM.hw, CAM.hh, 20);
    expect(Math.abs(tall.x)).toBeGreaterThan(Math.abs(short.x));
  });

  it('is independent of window size at the screen edge', () => {
    // The lean is normalised by the half-extent, so a building at the right
    // edge leans by the same amount whatever the window is. Without this a
    // wider monitor would show a differently-proportioned city.
    const small = parallaxOffset(400, 0, 0, 0, 400, 300, 10);
    const large = parallaxOffset(800, 0, 0, 0, 800, 600, 10);
    expect(small.x).toBeCloseTo(large.x, 6);
  });
});

describe('exposed walls', () => {
  it('puts the wall on the edge the roof moved away from', () => {
    // Roof displaced left+up uncovers the base's right and bottom strips.
    const e = extrusionOf(base, -8, -6);
    expect(e.roof.x).toBe(92);
    expect(e.roof.y).toBe(94);
    const vertical = e.faces.find((f) => f.nx !== 0);
    const horizontal = e.faces.find((f) => f.ny !== 0);
    // The vertical face sits at the base's RIGHT edge (x=140), not the left.
    expect(vertical?.pts[0]).toBe(140);
    expect(vertical?.nx).toBe(1);
    // The horizontal face sits at the base's BOTTOM edge (y=140).
    expect(horizontal?.pts[1]).toBe(140);
    expect(horizontal?.ny).toBe(1);
  });

  it('mirrors for the opposite lean', () => {
    const e = extrusionOf(base, 8, 6);
    const vertical = e.faces.find((f) => f.nx !== 0);
    const horizontal = e.faces.find((f) => f.ny !== 0);
    expect(vertical?.pts[0]).toBe(100); // left edge
    expect(vertical?.nx).toBe(-1);
    expect(horizontal?.pts[1]).toBe(100); // top edge
    expect(horizontal?.ny).toBe(-1);
  });

  it('exposes no wall for a building with no lean', () => {
    const e = extrusionOf(base, 0, 0);
    expect(e.faces).toEqual([]);
    expect(e.roof).toEqual(base);
  });

  it('draws at most two faces, however far it leans', () => {
    for (const [dx, dy] of [
      [40, 40],
      [-40, 40],
      [40, -40],
      [-40, -40],
      [0, 25],
      [25, 0],
    ]) {
      expect(extrusionOf(base, dx as number, dy as number).faces.length).toBeLessThanOrEqual(2);
    }
  });

  it('joins the wall to the roof edge, so no gap opens between them', () => {
    const e = extrusionOf(base, -8, -6);
    const vertical = e.faces.find((f) => f.nx !== 0);
    // Far edge of the wall quad must land on the roof's right edge.
    expect(vertical?.pts[4]).toBe(e.roof.x + e.roof.w);
    expect(vertical?.pts[5]).toBe(e.roof.y + e.roof.h);
  });
});

describe('building storeys', () => {
  const mk = (x: number, y: number, w: number, h: number, district: string): Building =>
    ({ x, y, w, h, district }) as Building;

  it('is deterministic — the same footprint is always the same height', () => {
    const b = mk(12, 34, 5, 6, 'downtown');
    expect(buildingStoreys(b)).toBe(buildingStoreys(mk(12, 34, 5, 6, 'downtown')));
  });

  it('keeps every district inside its own range', () => {
    const ranges: Record<string, [number, number]> = {
      downtown: [4, 12],
      commercial: [2, 6],
      industrial: [1, 3],
      residential: [1, 3],
      park: [1, 2],
    };
    for (const [district, [lo, hi]] of Object.entries(ranges)) {
      for (let x = 0; x < 40; x++) {
        for (let w = 2; w < 8; w++) {
          const s = buildingStoreys(mk(x, x * 3, w, w + 1, district));
          expect(s).toBeGreaterThanOrEqual(lo);
          expect(s).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('varies along a street rather than grading smoothly', () => {
    // Neighbouring footprints must not land on neighbouring heights, or a
    // block reads as a ramp. Count distinct heights across a row of shops.
    const heights = new Set<number>();
    for (let x = 0; x < 20; x++) heights.add(buildingStoreys(mk(x, 10, 3, 3, 'commercial')));
    expect(heights.size).toBeGreaterThan(1);
  });
});

describe('the flat-centre problem', () => {
  it('records that true parallax leaves the screen centre with no walls', () => {
    // Physically correct and visually a loss: the baked path gave every
    // building a constant 5 px sweep wherever it stood, so a house under the
    // camera still read as solid. True parallax gives it nothing, and the
    // middle of the screen — where the player is looking — goes flat.
    //
    // This test exists to pin the behaviour, not to bless it. The fix is a
    // floor on the lean (SHIP.md U2 notes), which would make this assertion
    // change deliberately rather than by accident.
    const under = parallaxOffset(500, 500, 500, 500, 500, 500, 30);
    expect(extrusionOf({ x: 0, y: 0, w: 40, h: 40 }, under.x, under.y).faces).toEqual([]);

    // A building one-tenth of the way to the edge leans by a tenth of its
    // height, which at 3 px a storey and two storeys is sub-pixel.
    const near = parallaxOffset(550, 500, 500, 500, 500, 500, 2 * 3);
    expect(Math.abs(near.x)).toBeLessThan(1);
  });
});
