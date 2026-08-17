import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { buildCourseIndex, nearestCourse } from '../src/world/courseIndex.js';
import { routeNodes, type RoadNet } from '../src/sim/roadnet.js';

/**
 * The street centrelines, indexed at a point (WORLDGEN.md §41), and the width
 * the road graph reads off them.
 *
 * The index is an accelerator, so the invariant that matters is that it
 * accelerates without changing the answer: what it returns must be what a
 * brute-force scan of every segment would have returned.
 */
describe('the course index', () => {
  const map = generateCity(66, parseWorldgenParams(worldgenJson));
  const idx = map.courseIndex!;
  // The index is a ROAD index: `generate` filters the park walks out before
  // building it (3.2), so the obviously-correct scan it is held against must
  // scan the same set — a walk is deliberately not an answer to "where is
  // the road", and near the big parks it would otherwise be the nearest line.
  const courses = (map.courses ?? []).filter((c) => c.kind !== 'path');

  /** The same question asked the slow, obviously-correct way. */
  const brute = (x: number, y: number, maxDist: number): number => {
    let best = maxDist * maxDist;
    for (const c of courses) {
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k] as readonly [number, number];
        const [bx, by] = c.points[k + 1] as readonly [number, number];
        const vx = bx - ax;
        const vy = by - ay;
        const len2 = vx * vx + vy * vy;
        let t = len2 === 0 ? 0 : ((x - ax) * vx + (y - ay) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + vx * t - x;
        const py = ay + vy * t - y;
        const d2 = px * px + py * py;
        if (d2 < best) best = d2;
      }
    }
    return best;
  };

  it('answers what a scan of every segment would answer', () => {
    let h = 4242;
    const rnd = (): number => {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      return h / 0x7fffffff;
    };
    let checked = 0;
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const x = rnd() * map.widthTiles;
      const y = rnd() * map.heightTiles;
      for (const reach of [3, 8]) {
        const got = nearestCourse(idx, x, y, reach);
        const want = brute(x, y, reach);
        checked++;
        if (want >= reach * reach) {
          expect(got, `bucketed found a course the scan did not, at ${x},${y}`).toBeNull();
          continue;
        }
        hits++;
        expect(got, `bucketed missed a course at ${x},${y}`).not.toBeNull();
        expect(Math.abs((got as { dist: number }).dist - Math.sqrt(want))).toBeLessThan(1e-9);
      }
    }
    expect(checked).toBe(8000);
    expect(hits).toBeGreaterThan(500);
  });

  it('returns a unit direction and the carriageway it belongs to', () => {
    const near = nearestCourse(idx, map.widthTiles / 2, map.heightTiles / 2, 8);
    if (near) {
      expect(Math.abs(Math.hypot(near.dx, near.dy) - 1)).toBeLessThan(1e-9);
      expect(near.width).toBeGreaterThan(0);
    }
    // An empty set of courses is not a crash: it is "no centreline anywhere".
    expect(nearestCourse(buildCourseIndex([]), 10, 10, 8)).toBeNull();
  });

  it('gives the road graph the width its streets are made of', () => {
    // §40.5 recorded that an edge knew its length and nothing else. It knows
    // this now — for seven eighths of them; the rest is carriageway no
    // centreline covers (§26.1), and 0 says so rather than guessing.
    const net = map.roadNet!;
    expect(net.edgeWidth.length).toBe(net.edgeA.length);
    let known = 0;
    for (let e = 0; e < net.edgeWidth.length; e++) {
      const w = net.edgeWidth[e] as number;
      expect(w === 0 || (w >= 2 && w <= 8)).toBe(true);
      if (w > 0) known++;
    }
    expect(known / net.edgeWidth.length).toBeGreaterThan(0.8);
  });

  it('does not let the width change a single route', () => {
    // The width ships and the search ignores it, deliberately: weighting by
    // it routes over more, shorter streets, every one of them another
    // junction for the follower to stall at, and a cross-city errand stopped
    // arriving (§41.3). This pins the decision so it cannot drift back in.
    const net = map.roadNet!;
    const real = net.edgeWidth.slice();
    const routeOf = (n: RoadNet): string => {
      const out: string[] = [];
      for (let a = 0; a < 40 && a + 400 < n.nodeX.length; a++) {
        out.push(JSON.stringify(routeNodes(n, a, a + 400)));
      }
      return out.join('|');
    };
    const withWidth = routeOf(net);
    net.edgeWidth.fill(4);
    const withoutWidth = routeOf(net);
    net.edgeWidth.set(real);
    expect(withWidth).toBe(withoutWidth);
  });
});
