import { describe, expect, it } from 'vitest';
import { type CityMap, T_BUILDING, T_ROAD, TILE_SIZE } from 'shared';
import { occluderEdges, punchShadows } from '../src/render/shadows.js';

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
  // One device pixel per world pixel and the light at the origin keeps the
  // recorded polygons in world coordinates.
  punchShadows(ctx, segs, count, light[0], light[1], light[0], light[1], 1, radius);
  return polys.some((p) => inside(p, point[0], point[1]));
}

describe('occluderEdges', () => {
  it('takes only the faces that look at the light', () => {
    // A single building with the light due west of it: one edge, the west one.
    const map = mapOf(['....', '.#..', '....']);
    const segs: number[] = [];
    const count = occluderEdges(map, ...at(0, 1), 60, segs);
    expect(count).toBe(1);
    expect(segs).toEqual([TILE_SIZE, TILE_SIZE, TILE_SIZE, TILE_SIZE * 2]);
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
      const x0 = segs[i * 4] as number;
      const x1 = segs[i * 4 + 2] as number;
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
    punchShadows(ctx, [], 0, 0, 0, 0, 0, 1, 40);
    expect(polys).toHaveLength(0);
  });
});
