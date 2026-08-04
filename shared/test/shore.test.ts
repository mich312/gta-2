import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import {
  SHORE_QUANTUM,
  maskDiff,
  rasteriseRings,
  signedArea,
  simplifyRing,
  traceShore,
  type ShoreRing,
} from '../src/world/shore.js';
import { T_WATER } from '../src/world/types.js';

/**
 * The shore as a curve (WORLDGEN.md §17): the waterline shipped as closed
 * rings instead of only as the staircase of water tiles.
 *
 * The invariant that makes it adoptable one consumer at a time is that it
 * cannot disagree with the tile plane it was traced from — so that is the
 * first and load-bearing test here, and everything else supports it.
 */
describe('the shore', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));
  const W = city.widthTiles;
  const H = city.heightTiles;

  /** Dry land per the shipped tiles: what the rings claim to outline. */
  const dry = new Uint8Array(W * H);
  for (let i = 0; i < dry.length; i++) dry[i] = city.tiles[i] === T_WATER ? 0 : 1;

  it('fills back to the shipped tile plane, exactly', () => {
    // The whole safety net. Not "close to": every one of the 589,824 tile
    // centres must land on the same side of the curve as its own byte, or
    // the vector city and the raster city are two different cities and no
    // consumer can be moved from one to the other.
    expect(maskDiff(rasteriseRings(city.shore, W, H), dry)).toBe(0);
  });

  it('says the same thing about area that the tiles do', () => {
    // Land outlines wind positive and holes negative, so the signed areas of
    // the whole set sum to the land area — measured in tiles by one
    // representation and in square tiles by the other. They agree to a
    // fraction of a percent; they cannot agree exactly, because a curve that
    // cuts a corner encloses slightly less than the squares it replaces.
    const total = city.shore.reduce((s, r) => s + r.area, 0);
    const tiles = dry.reduce((s: number, v: number) => s + v, 0);
    expect(Math.abs(total / tiles - 1)).toBeLessThan(0.005);
    expect(city.shore.some((r) => r.area > 0)).toBe(true);
    expect(city.shore.some((r) => r.area < 0)).toBe(true);
  });

  it('is a set of closed rings with no hair in it', () => {
    expect(city.shore.length).toBeGreaterThan(3);
    for (const ring of city.shore) {
      expect(ring.points.length).toBeGreaterThanOrEqual(3);
      for (let i = 0, j = ring.points.length - 1; i < ring.points.length; j = i++) {
        const [x, y] = ring.points[i] as readonly [number, number];
        const [px, py] = ring.points[j] as readonly [number, number];
        // Inside the map, on the shipped grid, and no zero-length edge: the
        // three ways a polygon soup goes bad before anybody notices.
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(W);
        expect(y).toBeLessThanOrEqual(H);
        expect(Math.abs(Math.round(x / SHORE_QUANTUM) * SHORE_QUANTUM - x)).toBeLessThan(1e-9);
        expect(x !== px || y !== py).toBe(true);
      }
    }
  });

  it('is a curve, not a staircase', () => {
    // The point of the exercise, stated as a number. A contour of the tile
    // plane can only run along tile edges, so every one of its segments is
    // axis-aligned; this one is placed by bisecting the coastline field, so
    // most of it is not. (The straight runs that remain are real: the map's
    // sea margin, and quay built on the grid.)
    let diagonal = 0;
    let total = 0;
    for (const ring of city.shore) {
      for (let i = 0, j = ring.points.length - 1; i < ring.points.length; j = i++) {
        const [x, y] = ring.points[i] as readonly [number, number];
        const [px, py] = ring.points[j] as readonly [number, number];
        total++;
        if (Math.abs(x - px) > 1e-9 && Math.abs(y - py) > 1e-9) diagonal++;
      }
    }
    expect(diagonal / total).toBeGreaterThan(0.5);
  });

  it('costs a fraction of the boundary it replaces', () => {
    // 64,376 tile faces separate land from water in this city, 4,904 of them
    // once collinear runs are merged. The curve is allowed to be no worse
    // than the merged staircase, and it is better.
    const points = city.shore.reduce((s, r) => s + r.points.length, 0);
    expect(points).toBeLessThan(4904 * 2);
  });
});

/**
 * The tracer itself, on shapes small enough to check by hand. The city test
 * above proves it agrees with one particular map; these prove it is right.
 */
describe('tracing a mask', () => {
  const box = (W: number, H: number, x0: number, y0: number, x1: number, y1: number): Uint8Array => {
    const m = new Uint8Array(W * H);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * W + x] = 1;
    return m;
  };
  /** No opinion anywhere: every crossing falls to the middle of its gap. */
  const flat = (): number => 0;

  it('wraps a square in one positively-wound ring', () => {
    const mask = box(12, 12, 3, 3, 8, 8);
    const rings = traceShore(mask, 12, 12, flat);
    expect(rings.length).toBe(1);
    expect((rings[0] as ShoreRing).area).toBeGreaterThan(0);
    expect(maskDiff(rasteriseRings(rings, 12, 12), mask)).toBe(0);
  });

  it('winds a hole the other way and still fills right', () => {
    const mask = box(16, 16, 2, 2, 13, 13);
    for (let y = 6; y <= 9; y++) for (let x = 6; x <= 9; x++) mask[y * 16 + x] = 0;
    const rings = traceShore(mask, 16, 16, flat);
    expect(rings.length).toBe(2);
    expect(rings.filter((r) => r.area > 0).length).toBe(1);
    expect(rings.filter((r) => r.area < 0).length).toBe(1);
    expect(maskDiff(rasteriseRings(rings, 16, 16), mask)).toBe(0);
  });

  it('separates land that only touches at a corner', () => {
    // The saddle. Two land cells meeting diagonally are two rings, not one
    // pinched figure of eight — which is what the tile plane means too,
    // since the diagonal gap is a pair of solid water tiles.
    const mask = new Uint8Array(9 * 9);
    mask[3 * 9 + 3] = 1;
    mask[4 * 9 + 4] = 1;
    const rings = traceShore(mask, 9, 9, flat);
    expect(rings.length).toBe(2);
    expect(maskDiff(rasteriseRings(rings, 9, 9), mask)).toBe(0);
  });

  it('puts the line where the field says, not down the middle', () => {
    // A field whose zero crossing sits three quarters of the way from x=4
    // to x=5 must put the waterline there, because that is the entire
    // reason for tracing the field rather than the bytes.
    const mask = box(12, 12, 2, 2, 4, 9);
    const rings = traceShore(mask, 12, 12, (x) => 4.75 - x);
    const xs = (rings[0] as ShoreRing).points.map(([x]) => x).filter((x) => x > 4);
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(Math.abs(x - 4.75)).toBeLessThan(0.05);
  });

  it('never lets simplification move the curve across a tile centre', () => {
    const mask = box(20, 20, 4, 4, 15, 15);
    for (let y = 4; y <= 7; y++) mask[y * 20 + 9] = 0;
    const rings = traceShore(mask, 20, 20, flat).map((r) => {
      const points = simplifyRing(r.points, 0.25);
      return { points, area: signedArea(points) };
    });
    expect(maskDiff(rasteriseRings(rings, 20, 20), mask)).toBe(0);
  });
});
