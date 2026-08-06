import { describe, expect, it } from 'vitest';
import {
  deriveShores,
  shoreChains,
  shoreHalf,
  T_BRIDGE,
  T_FIELD,
  T_WATER,
  type ShoreLoop,
} from '../src/index.js';

/**
 * The coast, drawn in one line (WORLDGEN.md §18).
 *
 * What the loops have to be true of, in order of how much depends on them:
 * closed, on the boundary, wound so the water is on the right, and — the one
 * that decides whether the coast LOOKS continuous — cut into per-tile chains
 * that share their ends with their neighbours'.
 */

/** A tile plane with a rectangle of land in a sea. */
function island(W: number, H: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const tiles = new Uint8Array(W * H).fill(T_WATER);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tiles[y * W + x] = T_FIELD;
  return tiles;
}

/** Every point of every loop, as world tile coordinates. */
function points(loops: ShoreLoop[]): Array<readonly [number, number]> {
  return loops.flatMap((l) => l.points);
}

describe('the coastline as polylines', () => {
  it('closes one loop round an island, on its boundary', () => {
    // Raw: no smoothing, no thinning, so the ring is the tile boundary itself
    // and can be checked exactly.
    const loops = deriveShores(island(20, 20, 5, 5, 15, 15), 20, 20, 0, 0);
    expect(loops).toHaveLength(1);
    const loop = loops[0] as ShoreLoop;
    expect(loop.land).toBe(true);
    // Ten tiles a side: forty unit edges, and one ring point per edge.
    expect(loop.points).toHaveLength(40);
    expect(loop.area).toBe(100);
    for (const [x, y] of loop.points) {
      expect(x >= 5 && x <= 15 && y >= 5 && y <= 15).toBe(true);
      // Every corner is a lattice point on the rectangle's own outline.
      expect(x === 5 || x === 15 || y === 5 || y === 15).toBe(true);
    }
  });

  it('winds with the water on the right, so land is on the left', () => {
    const loops = deriveShores(island(20, 20, 5, 5, 15, 15), 20, 20, 0, 0);
    const ring = (loops[0] as ShoreLoop).points;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i] as readonly [number, number];
      const [bx, by] = ring[(i + 1) % ring.length] as readonly [number, number];
      // A quarter turn clockwise on screen (y down) is the wet side — east
      // turns to south — so step that way from the edge's midpoint and you
      // should be off the island. Half a tile, which lands in the middle of
      // the neighbouring cell.
      const mx = (ax + bx) / 2 - (by - ay) * 0.5;
      const my = (ay + by) / 2 + (bx - ax) * 0.5;
      expect(mx < 5 || mx > 15 || my < 5 || my > 15).toBe(true);
    }
  });

  it('gives a lake its own loop, wound the other way', () => {
    const tiles = new Uint8Array(30 * 30).fill(T_FIELD);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) tiles[y * 30 + x] = T_WATER;
    const loops = deriveShores(tiles, 30, 30, 0, 0);
    // One loop, and it encloses WATER — which is the whole content of the
    // `land` flag: a painter filling one side has to know which side it has.
    expect(loops).toHaveLength(1);
    expect((loops[0] as ShoreLoop).land).toBe(false);
    expect((loops[0] as ShoreLoop).area).toBe(100);
  });

  it('draws no coast along the edge of the world', () => {
    // Land running off the map gets no waterline there. Every plan keeps a
    // margin of open sea round the whole map, so a city cannot hit it — and
    // a coastline round the border would be a worse answer than none.
    const tiles = new Uint8Array(20 * 20).fill(T_FIELD);
    expect(deriveShores(tiles, 20, 20, 0, 0)).toHaveLength(0);
  });

  it('runs the coast UNDER a bridge rather than round it', () => {
    const tiles = island(20, 20, 5, 5, 15, 15);
    // A deck out over the water off the east shore.
    for (let x = 15; x < 19; x++) tiles[10 * 20 + x] = T_BRIDGE;
    const loops = deriveShores(tiles, 20, 20, 0, 0);
    // Still one loop, still the island's own outline: the deck is not land.
    expect(loops).toHaveLength(1);
    expect((loops[0] as ShoreLoop).area).toBe(100);
    for (const [x] of (loops[0] as ShoreLoop).points) expect(x).toBeLessThanOrEqual(15);
  });

  it('ignores a puddle too small to be a coast', () => {
    const tiles = new Uint8Array(20 * 20).fill(T_FIELD);
    tiles[10 * 20 + 10] = T_WATER;
    // One wet tile is four corners of ring, under the floor; the map border
    // is the only coast left.
    const loops = deriveShores(tiles, 20, 20, 0, 0);
    expect(loops.every((l) => l.area !== 1)).toBe(true);
  });

  it('is a pure function of the tiles', () => {
    const tiles = island(40, 40, 8, 6, 30, 33);
    const a = deriveShores(tiles, 40, 40);
    const b = deriveShores(tiles, 40, 40);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('smooths without wandering off the coast it came from', () => {
    // The smoothed line is what the renderers draw and the TILES are still
    // what collision reads, so the two may not part company by much. Chaikin
    // twice moves a corner by at most a bit over a third of a tile and the
    // thinning adds a third; a whole tile is the line nobody may cross.
    const tiles = island(40, 40, 8, 6, 30, 33);
    const raw = points(deriveShores(tiles, 40, 40, 0, 0));
    for (const [px, py] of points(deriveShores(tiles, 40, 40))) {
      let near = Infinity;
      for (const [rx, ry] of raw) near = Math.min(near, Math.hypot(px - rx, py - ry));
      expect(near).toBeLessThan(1);
    }
  });
});

describe('the coast, cut up per tile', () => {
  const tiles = island(40, 40, 8, 6, 30, 33);
  const loops = deriveShores(tiles, 40, 40);
  const chains = shoreChains(loops, 40, 40);

  it('starts and ends every chain on the tile it belongs to', () => {
    expect(chains.size).toBeGreaterThan(40);
    for (const chain of chains.values()) {
      expect(chain.length).toBeGreaterThanOrEqual(4);
      for (let k = 0; k < chain.length; k += 2) {
        expect(chain[k] as number).toBeGreaterThanOrEqual(-1e-6);
        expect(chain[k] as number).toBeLessThanOrEqual(1 + 1e-6);
        expect(chain[k + 1] as number).toBeGreaterThanOrEqual(-1e-6);
        expect(chain[k + 1] as number).toBeLessThanOrEqual(1 + 1e-6);
      }
      // Both ends on an edge of the square — which is what lets the chain in
      // the next tile begin exactly where this one stops. A chain ending in
      // the middle of a tile is a coast with a hole in it.
      const onEdge = (x: number, y: number): boolean =>
        Math.abs(x) < 1e-6 || Math.abs(x - 1) < 1e-6 || Math.abs(y) < 1e-6 || Math.abs(y - 1) < 1e-6;
      expect(onEdge(chain[0] as number, chain[1] as number)).toBe(true);
      expect(
        onEdge(chain[chain.length - 2] as number, chain[chain.length - 1] as number),
      ).toBe(true);
    }
  });

  it('hands neighbouring tiles the same crossing point', () => {
    // The whole reason the coast is split rather than approximated by one
    // chord per tile: where two tiles meet, both must think the coast crosses
    // their shared edge at the same place, or the line has a step in it at
    // every tile boundary.
    let checked = 0;
    for (const [tile, chain] of chains) {
      const tx = tile % 40;
      const ty = (tile - tx) / 40;
      const right = chains.get(ty * 40 + tx + 1);
      if (right === undefined) continue;
      // Points of this chain on the east edge, and of that one on its west.
      const mine: number[] = [];
      for (let k = 0; k < chain.length; k += 2) {
        if (Math.abs((chain[k] as number) - 1) < 1e-6) mine.push(chain[k + 1] as number);
      }
      const theirs: number[] = [];
      for (let k = 0; k < right.length; k += 2) {
        if (Math.abs(right[k] as number) < 1e-6) theirs.push(right[k + 1] as number);
      }
      if (mine.length === 0 || theirs.length === 0) continue;
      for (const y of mine) {
        expect(theirs.some((v) => Math.abs(v - y) < 1e-5)).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('splits each tile into a wet half and a dry half that add up', () => {
    const area = (poly: Array<[number, number]>): number => {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i] as [number, number];
        const [x1, y1] = poly[(i + 1) % poly.length] as [number, number];
        a += x0 * y1 - x1 * y0;
      }
      return Math.abs(a) / 2;
    };
    for (const chain of chains.values()) {
      const dry = shoreHalf(chain, false);
      const sea = shoreHalf(chain, true);
      expect(area(dry) + area(sea)).toBeCloseTo(1, 5);
    }
  });
});
