import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import { T_BRIDGE, T_ROAD, T_SIDEWALK } from '../src/world/types.js';

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

  it('records a straight street as a straight line, not as jitter', () => {
    // §19. A recovered course is chained out of TILE CENTRES, so it carries
    // the lattice's own quantisation — and the painter strokes every point of
    // it through a spline, which turns that quantisation into a visible waver
    // along streets whose tiles run dead straight.
    //
    // The measure is the sagitta at each interior point over the local point
    // spacing. A smooth curve sampled at h has sagitta h²/8R, which is small
    // when the points are close relative to the radius; jitter of amplitude a
    // has sagitta about a, which is not. Before simplification the spine
    // fabric measured 0.052 by this and the grid fabric 0.002 — the ceiling
    // below is set an order of magnitude under the former and well over the
    // latter, so the noise cannot come back without failing.
    const wander = (points: ReadonlyArray<readonly [number, number]>): number => {
      let acc = 0;
      let n = 0;
      for (let i = 1; i + 1 < points.length; i++) {
        const [ax, ay] = points[i - 1] as readonly [number, number];
        const [px, py] = points[i] as readonly [number, number];
        const [bx, by] = points[i + 1] as readonly [number, number];
        const h =
          (Math.hypot(px - ax, py - ay) + Math.hypot(bx - px, by - py)) / 2;
        if (h < 1e-6) continue;
        acc += Math.hypot(px - (ax + bx) / 2, py - (ay + by) / 2) / h;
        n++;
      }
      return n === 0 ? 0 : acc / n;
    };
    // Roads only: this pin exists to catch RECOVERED courses shipping their
    // lattice quantisation as waver. A park walk (3.2) is authored the other
    // way round — `meanderPolyline` makes it wavy on purpose, and the §19
    // simplifier never runs on it — so its wander is signal, not noise.
    const all = city.courses
      .filter((c) => c.kind !== 'path' && c.points.length >= 5)
      .map((c) => wander(c.points))
      .sort((a, b) => a - b);
    const mean = all.reduce((s, v) => s + v, 0) / all.length;
    const p95 = all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] as number;
    // Averaged over every course in the city, and at the 95th percentile so a
    // handful of short hooks round a headland cannot fail it. Measured 0.019
    // and 0.098; before simplification the spine fabric alone averaged 0.052.
    //
    // Neither floor is zero and neither should be. A contour band's ground is
    // genuinely faceted — its distance field is a 3x3 chamfer, whose iso-lines
    // are octagons rather than circles — so the last of it is in the tarmac,
    // and smoothing it out of the RECORD would only move the drawn road off
    // the road.
    expect(mean).toBeLessThan(0.03);
    expect(p95).toBeLessThan(0.15);
  });

  it('keeps every centreline on the ground it was carved as', () => {
    // Per kind (3.2): a road course over carriageway and its decks, a park
    // walk over the pavement its carve laid. One rule, two grounds — the
    // same split `trimCourses` enforces.
    const W = city.widthTiles;
    const on = (kind: string, x: number, y: number): boolean => {
      const t = city.tiles[Math.floor(y) * W + Math.floor(x)] as number;
      if (kind === 'path') return t === T_SIDEWALK;
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
          expect(on(c.kind, x, y), `${c.kind} course off its ground at ${x.toFixed(1)},${y.toFixed(1)}`).toBe(true);
        }
      }
    }
  });

  it('ships no stub short enough to hide inside a junction', () => {
    // The trim's old three-tile floor let a course survive on nothing but the
    // crossroads it happened to cross: a junction is road in all directions,
    // so every centreline sample lands on carriageway and the test above is
    // satisfied by a four-tile streak lying at 20° across a square four-way.
    // Nothing local tells that stub from a road — perpendicular to it the
    // road runs three tiles either way and its band is fully covered, because
    // inside a crossroads all of that is true of any direction. Its length is
    // the whole of what is wrong with it, so its length is what is asserted.
    // See `MIN_RUN_WIDTHS` in bake.ts.
    for (const c of city.courses) {
      let len = 0;
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k] as readonly [number, number];
        const [bx, by] = c.points[k + 1] as readonly [number, number];
        len += Math.hypot(bx - ax, by - ay);
      }
      expect(
        len,
        `${c.kind} course of width ${c.width} at ${(c.points[0] as readonly [number, number]).join(',')}`,
      ).toBeGreaterThanOrEqual(c.width * 3);
    }
  });

  it('still ships the long roads the ribbon was drawn for', () => {
    // The floor above drops stubs, and only stubs. The ring, the avenues and
    // the borough-length streets are what §16 is FOR, so their survival is
    // held here rather than left to the eye: dropping a hundred short courses
    // must not have cost a metre of the curves anybody navigates by.
    const long = city.courses.filter((c) => {
      let len = 0;
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k] as readonly [number, number];
        const [bx, by] = c.points[k + 1] as readonly [number, number];
        len += Math.hypot(bx - ax, by - ay);
      }
      return len >= 100;
    });
    expect(long.length).toBeGreaterThanOrEqual(90);
    expect(long.some((c) => c.kind === 'ring')).toBe(true);
  });

  it('ships the park walks as path courses', () => {
    // 3.2's gate: the big parks' meander walks were always polylines before
    // they were rasterised, and now the polylines ship. Kind `path`, two
    // wide like the carve, and never in the road machinery — the course
    // index, the road net and the junction discs all filter them by kind.
    const walks = city.courses.filter((c) => c.kind === 'path');
    expect(walks.length).toBeGreaterThanOrEqual(10);
    expect(walks.every((c) => c.width === 2)).toBe(true);
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
