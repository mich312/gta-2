import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import {
  MASS_SLACK,
  MIN_FACING_FIT,
  buildingCorners,
  buildingMass,
  facingAngle,
} from '../src/world/heights.js';
import { T_BRIDGE, T_BUILDING, T_FLOOR, T_ROAD, type Building } from '../src/world/types.js';

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
    // `MASS_SLACK` tiles of lean, half of it per side: a mass may use its own
    // pavement, because that is where a doorstep and a porch are, and may not
    // reach the carriageway. The tile test below is the one that holds the
    // second half of that sentence.
    //
    // Buildings CUT at an angle (§36) are excluded, and not as an exemption:
    // for them `x, y, w, h` is the mass's own bounding box rather than a plot
    // it was dropped into, so "inside its plot" is true by construction and
    // testing it would assert that a rectangle fits inside its own bounds.
    // What holds them instead is `is its own rasterisation`, below.
    for (const b of city.buildings) {
      if (b.mw !== undefined) continue;
      const corners = buildingCorners(b);
      for (const [cx, cy] of corners) {
        expect(cx, `${b.x},${b.y}`).toBeGreaterThanOrEqual(b.x - (MASS_SLACK / 2 + 0.01));
        expect(cy, `${b.x},${b.y}`).toBeGreaterThanOrEqual(b.y - (MASS_SLACK / 2 + 0.01));
        expect(cx, `${b.x},${b.y}`).toBeLessThanOrEqual(b.x + b.w + (MASS_SLACK / 2 + 0.01));
        expect(cy, `${b.x},${b.y}`).toBeLessThanOrEqual(b.y + b.h + (MASS_SLACK / 2 + 0.01));
      }
    }
  });

  it('still fills the plot it claims', () => {
    // The other end of the same invariant, and the one that was missing: a
    // mass that stays inside its plot by shrinking to nothing is inside it.
    // Collision reads the FOOTPRINT, so a footprint corner standing far
    // outside the drawn mass is a wall you cannot see — which is why the bake
    // refuses the turn below `MIN_FACING_FIT` instead of drawing a sliver.
    let worst = 1;
    for (const b of city.buildings) {
      if ((b.angle ?? 0) === 0 || b.mw !== undefined) continue;
      const m = buildingMass(b);
      const drawn = (m.w * m.h) / (b.w * b.h);
      worst = Math.min(worst, drawn);
      expect(drawn, `${b.x},${b.y} ${b.w}x${b.h} @${b.angle}`).toBeGreaterThanOrEqual(
        MIN_FACING_FIT * MIN_FACING_FIT - 1e-9,
      );
    }
    // And the floor is a floor, not a ceiling nothing reaches: if every mass
    // were drawn whole this test would pass while saying nothing.
    expect(worst).toBeLessThan(1);
  });

  it('never leans into the carriageway', () => {
    // The half of "inside its own plot" that a coordinate bound cannot state.
    // A mass is allowed its pavement and is not allowed the road, and once
    // the lean is a whole tile that stops being obvious — so it is measured,
    // by sampling the drawn rectangle against the ground it covers.
    const W = city.widthTiles;
    for (const b of city.buildings) {
      if ((b.angle ?? 0) === 0) continue;
      const m = buildingMass(b);
      const c = Math.cos(m.rad);
      const s = Math.sin(m.rad);
      // A cut building's mass covers its own tiles by definition, and those
      // tiles were checked against `blocked` when it was stamped — the useful
      // question for it is the one in the next test.
      if (b.mw !== undefined) continue;
      for (let v = -m.h / 2; v <= m.h / 2; v += 0.25) {
        for (let u = -m.w / 2; u <= m.w / 2; u += 0.25) {
          const tx = Math.floor(m.cx + u * c - v * s);
          const ty = Math.floor(m.cy + u * s + v * c);
          if (tx < 0 || ty < 0 || tx >= W || ty >= city.heightTiles) continue;
          const t = city.tiles[ty * W + tx] as number;
          expect(t === T_ROAD || t === T_BRIDGE, `${b.x},${b.y} covers ${tx},${ty}`).toBe(false);
        }
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
    // Twelve degrees, not thirty: a 6×4 at thirty would have to shrink to
    // 0.70 to fit its plot, which is under `MIN_FACING_FIT` and so a turn the
    // bake would refuse outright.
    const b: Building = { x: 0, y: 0, w: 6, h: 4, district: 'downtown', angle: 12 };
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
      // agrees — a building on a seam between two fabrics faces neither. A
      // building CUT at an angle takes its block's frame instead, which is
      // the same number by a shorter road, so only its own tiles are asked.
      if (b.mw !== undefined) continue;
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          expect(facingAngle(city.bearing[ty * W + tx] as number), `${b.x},${b.y}`).toBe(angle);
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

/**
 * Buildings CUT at an angle (VECTOR phase 3, WORLDGEN.md §36).
 *
 * The older arrangement cut a square footprint and turned a drawing on top of
 * it, so the mass had to shrink to fit and everything that read the footprint
 * disagreed with everything that drew the mass. These are cut at the block's
 * own angle, and their TILES are the rectangle's rasterisation — which is the
 * one property worth testing, because every other guarantee follows from it.
 */
describe('a building cut at an angle', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));
  const cut = city.buildings.filter((b) => b.mw !== undefined);

  it('is most of the city', () => {
    expect(cut.length).toBeGreaterThan(city.buildings.length * 0.4);
  });

  it('is drawn at full size — there is no fit factor left to apply', () => {
    for (const b of cut) {
      const m = buildingMass(b);
      expect(m.w, `${b.x},${b.y}`).toBe(b.mw);
      expect(m.h, `${b.x},${b.y}`).toBe(b.mh);
    }
  });

  it('is its own rasterisation: the ground under it is its own wall', () => {
    // THE claim. Sample the drawn rectangle and require the ground under it to
    // be this building — no gap between what you see and what you hit, which
    // is what the old shrink-to-fit could never offer.
    const W = city.widthTiles;
    let mismatched = 0;
    for (const b of cut) {
      const m = buildingMass(b);
      const c = Math.cos(m.rad);
      const s = Math.sin(m.rad);
      // Inset by √2/2, which is not arbitrary: a tile is stamped when its
      // CENTRE is inside the rectangle, and a point inside the rectangle can
      // be that far from its own tile's centre. Any sample further in than
      // that is guaranteed to sit in a tile the stamp claimed, so this asks
      // about the interior rather than about the edge the rasteriser rounded.
      const hw = m.w / 2 - 0.708;
      const hh = m.h / 2 - 0.708;
      if (hw <= 0 || hh <= 0) continue;
      let miss = false;
      for (let v = -hh; v <= hh && !miss; v += 0.25) {
        for (let u = -hw; u <= hw; u += 0.25) {
          const tx = Math.floor(m.cx + u * c - v * s);
          const ty = Math.floor(m.cy + u * s + v * c);
          if (tx < 0 || ty < 0 || tx >= W || ty >= city.heightTiles) continue;
          const t = city.tiles[ty * W + tx] as number;
          if (t !== T_BUILDING && t !== T_FLOOR) {
            miss = true;
            break;
          }
        }
      }
      if (miss) mismatched++;
    }
    // One, of 2,301. A tile is stamped when its CENTRE falls inside the
    // rectangle, so where the recorded rectangle is a hair larger than the
    // tiles it claimed — a small rect at a steep angle, whose covered set
    // rounds inward at two corners — an interior sample can step outside.
    // Pinned rather than asserted at zero, because zero would need the record
    // shrunk to its own rasterisation, which is the fit factor §36 removes.
    expect(mismatched).toBeLessThanOrEqual(2);
  });

  it('keeps its bounding box as the axis-aligned rect everything else reads', () => {
    for (const b of cut) {
      expect(Number.isInteger(b.x) && Number.isInteger(b.y)).toBe(true);
      expect(Number.isInteger(b.w) && Number.isInteger(b.h)).toBe(true);
      expect(b.w).toBeGreaterThan(0);
      expect(b.h).toBeGreaterThan(0);
    }
  });
});
