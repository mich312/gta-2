import { describe, expect, it } from 'vitest';
import {
  generateCityPlan,
  parseCityPlan,
  pointInPoly,
  LANDMARK_KINDS,
  MAX_CARRIAGEWAY,
  MIN_MAP_TILES,
  type CityPlan,
} from '../src/index.js';

/**
 * The generated plan (WORLDGEN.md §17).
 *
 * What is tested here is the PLAN, not the city: that it is a legal document,
 * that it says everything the bake needs it to say, and that a seed says the
 * same thing twice. Whether the city it describes is any good is the
 * checker's question, and `server/test/plangen.test.ts` asks it — with the
 * same function `pnpm citybake` uses, which is the whole point.
 *
 * Small maps on purpose: `MIN_MAP_TILES`, the smallest city the generator
 * will draw. Everything under test is scale-free, and the floor costs a
 * second or two where the 640-tile default costs eight.
 */
const SIZE = MIN_MAP_TILES;
const plan = (seed: number): CityPlan =>
  generateCityPlan({ seed, widthTiles: SIZE, heightTiles: SIZE });

describe('generated city plans', () => {
  it('are legal plans — the schema parses what the generator emits', () => {
    // Through JSON, not by reference: the schema is what a file on disk has
    // to satisfy, and an in-memory object can be subtly more permissive.
    const parsed = parseCityPlan(JSON.parse(JSON.stringify(plan(1))));
    expect(parsed.widthTiles).toBe(SIZE);
    expect(parsed.districts.length).toBeGreaterThan(4);
    expect(parsed.roads.length).toBeGreaterThan(3);
  });

  it('are deterministic — one seed, the same numbers', () => {
    expect(JSON.stringify(plan(7))).toBe(JSON.stringify(plan(7)));
  });

  it('differ from seed to seed, in the land and not merely the furniture', () => {
    const a = plan(11);
    const b = plan(12);
    expect(JSON.stringify(a.geography.islands)).not.toBe(JSON.stringify(b.geography.islands));
    expect(a.name).not.toBe(b.name);
  });

  it('hold every kind of landmark the checker insists on', () => {
    for (const seed of [3, 21, 42]) {
      const kinds = new Set(plan(seed).landmarks.map((l) => l.kind));
      for (const kind of LANDMARK_KINDS) {
        expect(kinds.has(kind), `seed ${seed} has no ${kind}`).toBe(true);
      }
    }
  });

  it('never draw a carriageway wider than the junction labeller can bear', () => {
    for (const seed of [1, 2, 3]) {
      for (const road of plan(seed).roads) {
        expect(road.width, road.name).toBeLessThanOrEqual(MAX_CARRIAGEWAY);
      }
    }
  });

  it('name a road that exists wherever a borough hangs off a spine', () => {
    for (const seed of [1, 5, 9]) {
      const p = plan(seed);
      const names = new Set(p.roads.map((r) => r.name));
      for (const d of p.districts) {
        if (d.street.fabric !== 'spine') continue;
        expect(names.has(d.street.spine), `${d.name} hangs off "${d.street.spine}"`).toBe(true);
      }
    }
  });

  it('give the map a floor: every tile is inside some borough polygon', () => {
    // §14.3 D1 from the other end. Ground with no borough gets no fabric and
    // no invariants, and the generator's answer is one countryside polygon
    // drawn first and overwritten by every cell. If that ever stops covering
    // the map, the warp fringe becomes an accident again.
    const p = plan(4);
    for (const [x, y] of [
      [1, 1],
      [SIZE - 2, 1],
      [1, SIZE - 2],
      [SIZE - 2, SIZE - 2],
      [SIZE >> 1, SIZE >> 1],
    ] as const) {
      expect(
        p.districts.some((d) => pointInPoly(d.area, x + 0.5, y + 0.5)),
        `${x},${y} belongs to no borough`,
      ).toBe(true);
    }
  });

  it('put every landmark on the map, with room round it', () => {
    const p = plan(6);
    for (const l of p.landmarks) {
      const [x, y, w, h] = l.rect;
      expect(x, l.name).toBeGreaterThan(0);
      expect(y, l.name).toBeGreaterThan(0);
      expect(x + w, l.name).toBeLessThan(p.widthTiles - 1);
      expect(y + h, l.name).toBeLessThan(p.heightTiles - 1);
    }
    // And no two of them on top of each other.
    for (let i = 0; i < p.landmarks.length; i++) {
      for (let j = i + 1; j < p.landmarks.length; j++) {
        const [ax, ay, aw, ah] = (p.landmarks[i] as { rect: number[] }).rect as number[] as [
          number,
          number,
          number,
          number,
        ];
        const [bx, by, bw, bh] = (p.landmarks[j] as { rect: number[] }).rect as number[] as [
          number,
          number,
          number,
          number,
        ];
        const overlap = ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
        expect(overlap, `${(p.landmarks[i] as { name: string }).name} overlaps ${(p.landmarks[j] as { name: string }).name}`).toBe(false);
      }
    }
  });
});
