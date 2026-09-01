import { describe, expect, it } from 'vitest';
import cityPlanJson from '../data/city-plan.json';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import { parseCityPlan, pointInPoly } from '../src/world/plan.js';
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
  // The plan, for the borough outlines: the baked `district` plane records a
  // district TYPE (downtown, commercial), so it cannot tell The Spine from
  // Old Quarter — and telling one borough from another is the whole point of
  // the per-borough coverage gate below.
  const plan = parseCityPlan(cityPlanJson);

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

  it('gives every borough centrelines, not just the ones with a shaped fabric', () => {
    // The defect this pins: coverage was reported as ONE city-wide number
    // (76.1%, §26.1) and the average hid its shape. Measured per borough, it
    // was not spread thin — it was missing in lumps. The Spine sat at 23.8%
    // and Old Suburbs at 30.2% against an 83.8% median, because the plain
    // axis-aligned grid was the one fabric branch in `weaveFabrics` that
    // carved its lattice without recording the centrelines, and those two are
    // the only non-rural boroughs the plan leaves at `angle: 0` with no
    // `fabric`. Everything from §16 on — kerb casing, junction punch-out,
    // ribbon markings, the follower, the diagonal bevel — is keyed on
    // `courses`, so a quarter of the city was drawn to the pre-§16 recipe.
    //
    // NOT about paint: `paintRoad` falls through to `paintLaneMarks` for any
    // tile the cover mask misses, so those streets always had lane marks.
    // They had no CURVES, which is why the eye and not the checker found it.
    //
    // Coverage is the renderer's own rule — `TileLayer.indexCourses`'
    // `courseCover`, a tile centre within `width / 2 + 0.05` of a non-`path`
    // centreline — so this measures what the game actually does. The gate is
    // relative to the MEDIAN borough rather than an absolute percentage, so
    // it says "no borough is unlike the rest of the city" and cannot be
    // satisfied or broken by coverage moving everywhere at once. Median, not
    // mean, so one wrecked borough cannot move the bar that catches it.
    const W = city.widthTiles;
    const H = city.heightTiles;
    const cover = new Uint8Array(W * H);
    for (const c of city.courses) {
      if (c.kind === 'path') continue;
      const inner = c.width / 2 + 0.05;
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k] as readonly [number, number];
        const [bx, by] = c.points[k + 1] as readonly [number, number];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - inner - 1));
        const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + inner + 1));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - inner - 1));
        const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + inner + 1));
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const px = tx + 0.5 - ax;
            const py = ty + 0.5 - ay;
            const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
            const qx = px - t * dx;
            const qy = py - t * dy;
            if (qx * qx + qy * qy <= inner * inner) cover[ty * W + tx] = 1;
          }
        }
      }
    }

    // A borough too small for a rate to mean anything is not rated: a park
    // with a lane through it can be 40% on a hundred tiles and say nothing.
    const MIN_ROAD = 500;
    const rates: Array<{ name: string; rate: number }> = [];
    for (const d of plan.districts) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [px, py] of d.area) {
        x0 = Math.min(x0, px);
        y0 = Math.min(y0, py);
        x1 = Math.max(x1, px);
        y1 = Math.max(y1, py);
      }
      let road = 0;
      let covered = 0;
      for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
        for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
          const t = city.tiles[ty * W + tx] as number;
          if (t !== T_ROAD && t !== T_BRIDGE) continue;
          if (!pointInPoly(d.area, tx + 0.5, ty + 0.5)) continue;
          road++;
          if (cover[ty * W + tx] === 1) covered++;
        }
      }
      if (road >= MIN_ROAD) rates.push({ name: d.name, rate: covered / road });
    }

    expect(rates.length).toBeGreaterThanOrEqual(10);
    const sorted = rates.map((r) => r.rate).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    const worst = rates.reduce((a, b) => (a.rate <= b.rate ? a : b));
    // Half the median. The two boroughs the grid fabric skipped came in at
    // 0.284 of it; every borough that HAS its centrelines sits at 0.86 or
    // better, so the gate has a wide gap on both sides and is not a
    // high-water mark that the next bake trips by drifting a point. The
    // borough is named in the message, because "coverage regressed" is not
    // actionable and "The Spine has no centrelines" is.
    expect(
      worst.rate,
      `${worst.name}: ${(worst.rate * 100).toFixed(1)}% of its carriageway under a course, ` +
        `${(worst.rate / median).toFixed(2)}x the ${(median * 100).toFixed(1)}% median borough`,
    ).toBeGreaterThanOrEqual(median * 0.5);
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
