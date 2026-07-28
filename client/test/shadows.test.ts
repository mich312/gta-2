import { describe, expect, it } from 'vitest';
import { type CityMap, T_BUILDING, T_ROAD, TILE_SIZE } from 'shared';
import {
  type Occluder,
  SEG_STRIDE,
  entityEdges,
  lengthFactor,
  occluderEdges,
  punchShadows,
  sampleAlpha,
  sampleOffset,
} from '../src/render/shadows.js';

/** A tile grid from an ASCII sketch: `#` is a building, anything else is road. */
function mapOf(rows: string[]): CityMap {
  const h = rows.length;
  const w = (rows[0] as string).length;
  const tiles = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tiles[y * w + x] = (rows[y] as string)[x] === '#' ? T_BUILDING : T_ROAD;
    }
  }
  return { widthTiles: w, heightTiles: h, tiles } as unknown as CityMap;
}

/** Centre of a tile, in world px. */
function at(tx: number, ty: number): [number, number] {
  return [(tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE];
}

/**
 * A canvas context that records the polygons a fill would have covered, so the
 * shadow volumes can be tested as geometry rather than as pixels.
 */
function recorder(): { ctx: CanvasRenderingContext2D; polys: Array<Array<[number, number]>> } {
  const polys: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  const ctx = {
    beginPath(): void {
      polys.length = 0;
      current = [];
    },
    moveTo(x: number, y: number): void {
      current = [[x, y]];
      polys.push(current);
    },
    lineTo(x: number, y: number): void {
      current.push([x, y]);
    },
    closePath(): void {},
    fill(): void {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, polys };
}

function inside(poly: Array<[number, number]>, px: number, py: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Whether a world point falls inside any shadow cast by a light. Runs the real
 * extrusion through the recorder and asks the resulting polygons.
 */
function shadowed(
  map: CityMap,
  light: [number, number],
  radius: number,
  point: [number, number],
): boolean {
  const segs: number[] = [];
  const count = occluderEdges(map, light[0], light[1], radius, segs);
  const { ctx, polys } = recorder();
  // One device pixel per world pixel, no sample offset, and the light at the
  // origin keeps the recorded polygons in world coordinates.
  punchShadows(ctx, segs, count, light[0], light[1], 0, 0, light[0], light[1], 1, radius);
  return polys.some((p) => inside(p, point[0], point[1]));
}

describe('occluderEdges', () => {
  it('takes only the faces that look at the light', () => {
    // A single building with the light due west of it: one edge, the west one.
    const map = mapOf(['....', '.#..', '....']);
    const segs: number[] = [];
    const count = occluderEdges(map, ...at(0, 1), 60, segs);
    expect(count).toBe(1);
    expect(segs).toEqual([TILE_SIZE, TILE_SIZE, TILE_SIZE, TILE_SIZE * 2, Infinity]);
  });

  it('takes two faces from a corner', () => {
    // North-west of the block: both the west and the north face are visible.
    const map = mapOf(['....', '.#..', '....']);
    const segs: number[] = [];
    expect(occluderEdges(map, ...at(0, 0), 60, segs)).toBe(2);
  });

  it('ignores the seams inside a block', () => {
    // A terrace of four seen from the north-west is four north faces and one
    // west face — the seams between the tiles are already in shadow, and
    // emitting them would multiply the fill count for no visible difference.
    const map = mapOf(['......', '.####.', '......']);
    const segs: number[] = [];
    const count = occluderEdges(map, ...at(0, 0), 200, segs);
    expect(count).toBe(5);
    // The only vertical face is the west end of the terrace.
    for (let i = 0; i < count; i++) {
      const x0 = segs[i * SEG_STRIDE] as number;
      const x1 = segs[i * SEG_STRIDE + 2] as number;
      if (x0 === x1) expect(x0).toBe(TILE_SIZE);
    }
  });

  it('finds nothing when nothing is standing there', () => {
    const segs: number[] = [];
    expect(occluderEdges(mapOf(['...', '...']), ...at(1, 1), 60, segs)).toBe(0);
  });

  it('stays inside the map at its edges', () => {
    const map = mapOf(['#.', '..']);
    const segs: number[] = [];
    expect(() => occluderEdges(map, -400, -400, 900, segs)).not.toThrow();
    expect(() => occluderEdges(map, 9999, 9999, 900, segs)).not.toThrow();
  });
});

describe('punchShadows', () => {
  it('puts the far side of a wall in shadow', () => {
    const map = mapOf(['.....', '.....', '..#..', '.....', '.....']);
    const light = at(0, 2);
    // Directly behind the building from the light.
    expect(shadowed(map, light, 200, at(4, 2))).toBe(true);
    // Past the top and bottom of the umbra, in the open.
    expect(shadowed(map, light, 200, at(4, 0))).toBe(false);
    expect(shadowed(map, light, 200, at(4, 4))).toBe(false);
    // And between the light and the wall, which is lit by definition.
    expect(shadowed(map, light, 200, at(1, 2))).toBe(false);
  });

  it('lets light out through a doorway', () => {
    // A room with one gap in its wall: the light inside must reach the street
    // through the gap and nowhere else. This is the shop-interior case, and
    // getting it wrong is the difference between a lit doorway and a lit block.
    const map = mapOf(['#####', '#...#', '#....', '#####']);
    const light = at(2, 2);
    // Straight out through the gap at (4, 2).
    expect(shadowed(map, light, 200, [TILE_SIZE * 5.5, TILE_SIZE * 2.5])).toBe(false);
    // Through the wall, one row up.
    expect(shadowed(map, light, 200, [TILE_SIZE * 5.5, TILE_SIZE * 1.5])).toBe(true);
    // Through the wall behind.
    expect(shadowed(map, light, 200, [-TILE_SIZE * 0.5, TILE_SIZE * 2.5])).toBe(true);
  });

  it('covers the whole umbra of a wall it is standing against', () => {
    // The degenerate case: a lamp hard against a wall subtends nearly half a
    // turn, and a shadow quad whose far edge is one straight chord cuts back
    // inside the arc — which shows up in play as a bright wedge sitting on top
    // of a building.
    const map = mapOf([
      '.........',
      '.#.......',
      '.........',
    ]);
    const light: [number, number] = [TILE_SIZE - 0.5, TILE_SIZE * 1.5];
    const radius = 120;
    // Sweep the whole umbra out to the edge of the light's own reach, which is
    // where a single chord goes wrong — near the wall it is still inside it.
    for (let d = 4; d < radius; d += 4) {
      for (const y of [TILE_SIZE * 1.1, TILE_SIZE * 1.5, TILE_SIZE * 1.9]) {
        expect(shadowed(map, light, radius, [TILE_SIZE + d, y]), `d=${d} y=${y}`).toBe(true);
      }
    }
  });

  it('draws nothing when there is nothing to draw', () => {
    const { ctx, polys } = recorder();
    punchShadows(ctx, [], 0, 0, 0, 0, 0, 0, 0, 1, 40);
    expect(polys).toHaveLength(0);
  });
});

/** How many of `n` samples across the light's face put this point in shadow. */
function coverage(
  segs: number[],
  count: number,
  light: [number, number],
  point: [number, number],
  source: number,
  n: number,
  radius: number,
): number {
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const [ox, oy] = sampleOffset(i, n, source);
    const { ctx, polys } = recorder();
    punchShadows(ctx, segs, count, light[0], light[1], ox, oy, light[0], light[1], 1, radius);
    if (polys.some((p) => inside(p, point[0], point[1]))) hits++;
  }
  return hits;
}

describe('penumbra', () => {
  const map = mapOf(['.....', '.....', '..#..', '.....', '.....']);
  const light: [number, number] = at(0, 2);
  const radius = 200;
  const segs: number[] = [];
  const count = occluderEdges(map, light[0], light[1], radius, segs);
  const N = 8;

  it('agrees everywhere in the umbra', () => {
    // Dead behind the wall, every sample across the lamp's face is blocked.
    expect(coverage(segs, count, light, at(4, 2), 4, N, radius)).toBe(N);
  });

  it('agrees nowhere in full light', () => {
    expect(coverage(segs, count, light, at(4, 4), 4, N, radius)).toBe(0);
  });

  /**
   * How many probe points down a line at `dist` past the wall land in a
   * penumbra — lit by some of the lamp's face but not all of it. That count is
   * the width of the soft edge, in half-pixels.
   */
  function softWidth(dist: number, source: number): number {
    let partial = 0;
    for (let y = 0; y < TILE_SIZE * 5; y += 0.5) {
      const c = coverage(segs, count, light, [TILE_SIZE * 3 + dist, y], source, N, radius);
      if (c > 0 && c < N) partial++;
    }
    return partial;
  }

  it('widens with distance from the occluder', () => {
    // Sharp where the wall meets the ground, soft where its shadow ends. A
    // blur cannot do this at any radius — it softens the root as much as the
    // tip, which is exactly what it used to look like.
    expect(softWidth(60, 6)).toBeGreaterThan(softWidth(4, 6) * 3);
  });

  it('collapses to a hard edge for a point source', () => {
    expect(softWidth(60, 0)).toBe(0);
  });
});

describe('sampleAlpha', () => {
  it('lands the umbra on exactly the light that should survive it', () => {
    // destination-out is multiplicative: N punches at alpha a leave (1-a)^N.
    // Assuming the alphas add is what leaves an umbra 37% too bright.
    for (const keep of [0.04, 0.06, 0.17, 0.3]) {
      for (const n of [1, 2, 3, 6, 8]) {
        const a = sampleAlpha(keep, n);
        expect(Math.pow(1 - a, n)).toBeCloseTo(keep, 6);
      }
    }
  });
});

describe('sampleOffset', () => {
  it('stays on the lamp face and spreads across it', () => {
    const r = 3;
    const seen: Array<[number, number]> = [];
    for (let i = 0; i < 6; i++) {
      const [x, y] = sampleOffset(i, 6, r);
      expect(Math.hypot(x, y)).toBeCloseTo(r, 6);
      seen.push([x, y]);
    }
    // Not all bunched on one side, or the penumbra is one-sided.
    const meanX = seen.reduce((a, p) => a + p[0], 0) / seen.length;
    const meanY = seen.reduce((a, p) => a + p[1], 0) / seen.length;
    expect(Math.hypot(meanX, meanY)).toBeLessThan(r * 0.5);
  });

  it('is a point source when asked for one', () => {
    expect(sampleOffset(0, 1, 4)).toEqual([0, 0]);
    expect(sampleOffset(2, 6, 0)).toEqual([0, 0]);
  });
});

describe('lengthFactor', () => {
  it('never ends the shadow of something taller than the light', () => {
    // A headlight sits at 4 and a pedestrian stands at 9, which is the whole
    // reason a car throws a shadow down the length of a street.
    expect(lengthFactor(4, 9)).toBe(Infinity);
    expect(lengthFactor(9, 9)).toBe(Infinity);
  });

  it('shortens the shadow as the light climbs', () => {
    // The same pedestrian under a street lamp at 30 throws a stub.
    const low = lengthFactor(12, 9);
    const high = lengthFactor(30, 9);
    expect(high).toBeLessThan(low);
    expect(high).toBeCloseTo(30 / 21, 6);
  });
});

describe('entityEdges', () => {
  const disc = (x: number, y: number, r: number, height = 9): Occluder => ({
    x,
    y,
    r,
    halfLong: 0,
    halfWide: 0,
    heading: 0,
    height,
  });
  const box = (x: number, y: number, heading: number, height = 7): Occluder => ({
    x,
    y,
    r: 0,
    halfLong: 12,
    halfWide: 6,
    heading,
    height,
  });

  it('takes the tangent chord of a body', () => {
    const segs: number[] = [];
    const count = entityEdges([disc(100, 0, 6)], 0, 0, 400, 30, segs);
    expect(count).toBe(1);
    // Both ends sit on the body, and the chord faces the light.
    for (const [x, y] of [
      [segs[0] as number, segs[1] as number],
      [segs[2] as number, segs[3] as number],
    ]) {
      expect(Math.hypot(x - 100, y - 0)).toBeCloseTo(6, 6);
      expect(x).toBeLessThan(100);
    }
  });

  it('takes only the faces of a car the light can see', () => {
    const segs: number[] = [];
    // Square-on from the west: one long side faces the light.
    const count = entityEdges([box(100, 0, 0)], 0, 0, 400, 30, segs);
    expect(count).toBe(1);
    // From a corner, two faces do.
    segs.length = 0;
    expect(entityEdges([box(100, 100, 0)], 0, 0, 400, 30, segs)).toBe(2);
  });

  it('ignores what is out of reach, and what the light is inside', () => {
    const segs: number[] = [];
    expect(entityEdges([disc(900, 0, 6)], 0, 0, 100, 30, segs)).toBe(0);
    segs.length = 0;
    // A lamp inside somebody has no silhouette to take, and the tangent
    // construction has no answer — it must not produce a NaN either.
    expect(entityEdges([disc(2, 0, 6)], 0, 0, 100, 30, segs)).toBe(0);
  });

  it('carries the length that each height allows', () => {
    const segs: number[] = [];
    entityEdges([disc(50, 0, 6, 9)], 0, 0, 400, 30, segs);
    expect(segs[4]).toBeCloseTo(30 / 21, 6);
    segs.length = 0;
    entityEdges([disc(50, 0, 6, 9)], 0, 0, 400, 4, segs);
    expect(segs[4]).toBe(Infinity);
  });

  it('appends to the buildings rather than replacing them', () => {
    const map = mapOf(['.....', '.....', '..#..', '.....', '.....']);
    const light = at(0, 2);
    const segs: number[] = [];
    const walls = occluderEdges(map, light[0], light[1], 200, segs);
    const total = entityEdges([disc(light[0] + 20, light[1], 5)], light[0], light[1], 200, 30, segs);
    expect(total).toBe(walls + 1);
    expect(segs.length).toBe(total * SEG_STRIDE);
  });
});
