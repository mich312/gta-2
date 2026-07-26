import { HALF_PI, PI } from '../math/trig.js';
import type { WorldgenParams } from './params.js';
import { T_SAND, T_SIDEWALK, T_WATER, TILE_SIZE, type CityMap } from './types.js';

/**
 * Waterfront: one map edge becomes open water with a wavy shoreline, a sand
 * beach, and a two-tile sidewalk promenade the city butts up against.
 * Everything here is a pure function of the seed — no rng stream is consumed,
 * so a `waterWidth` of 0 (pre-waterfront replay headers) leaves the entire
 * generation byte-identical to the land-locked city.
 */

/** Inclusive/exclusive tile bounds of the land the road grid may use. */
export interface LandRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Small pure integer hash — worldgen-local, never touches the sim PRNG. */
function h32(seed: number, a: number, b: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ a, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ b, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function h01(seed: number, a: number, b: number): number {
  return h32(seed, a, b) / 0x1_0000_0000;
}

/** Which map edge holds the water: 0 west, 1 east, 2 north, 3 south. */
export function waterSide(seed: number): number {
  return h32(seed ^ 0x7a7e4, 1, 1) & 3;
}

/** Water extent (tiles from the edge) at position `u` along the shore. */
function shoreExtent(seed: number, width: number, u: number): number {
  const k = Math.floor(u / 8);
  const t = (u - k * 8) / 8;
  const a = h01(seed ^ 0x5ea, k, 0) * 4;
  const b = h01(seed ^ 0x5ea, k + 1, 0) * 4;
  return width - 2 + Math.round(a + (b - a) * t); // width-2 .. width+2
}

/** Map shore-axis coords (u along shore, v out from the edge) to tiles. */
function uvToTile(map: CityMap, side: number, u: number, v: number): [number, number] {
  switch (side) {
    case 0:
      return [v, u]; // west
    case 1:
      return [map.widthTiles - 1 - v, u]; // east
    case 2:
      return [u, v]; // north
    default:
      return [u, map.heightTiles - 1 - v]; // south
  }
}

/**
 * Carve water, beach, and promenade onto one edge; returns the land rect the
 * road grid must stay inside. With waterWidth 0 this is a no-op full rect.
 */
export function carveWaterfront(map: CityMap, params: WorldgenParams): LandRect {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const full: LandRect = { x0: 0, y0: 0, x1: W, y1: H };
  const width = params.waterWidth;
  if (width <= 0) return full;

  const side = waterSide(map.seed);
  const along = side < 2 ? H : W;
  const maxWater = width + 2;
  const sandEnd = maxWater + 2; // beach reaches at least 2, up to 6 tiles
  const promEnd = sandEnd + 2; // two-tile promenade

  for (let u = 0; u < along; u++) {
    const ext = shoreExtent(map.seed, width, u);
    for (let v = 0; v < promEnd; v++) {
      const [tx, ty] = uvToTile(map, side, u, v);
      const t = v < ext ? T_WATER : v < sandEnd ? T_SAND : T_SIDEWALK;
      map.tiles[ty * W + tx] = t;
    }
  }

  switch (side) {
    case 0:
      return { x0: promEnd, y0: 0, x1: W, y1: H };
    case 1:
      return { x0: 0, y0: 0, x1: W - promEnd, y1: H };
    case 2:
      return { x0: 0, y0: promEnd, x1: W, y1: H };
    default:
      return { x0: 0, y0: 0, x1: W, y1: H - promEnd };
  }
}

/** Heading along the shore for a given side; sign alternates per spawn. */
function shoreHeading(side: number, positive: boolean): number {
  if (side < 2) return positive ? HALF_PI : -HALF_PI; // west/east shores run north-south
  return positive ? 0 : PI; // north/south shores run east-west
}

/**
 * Boat spawn points: moored rows close to the beach (near enough to board
 * from the sand) and cruising lanes further out. Deterministic scan.
 */
export function placeBoatSpawns(map: CityMap, params: WorldgenParams): void {
  map.boatSpawns = [];
  const width = params.waterWidth;
  if (width <= 0) return;
  const side = waterSide(map.seed);
  const along = side < 2 ? map.heightTiles : map.widthTiles;

  for (let u = 4; u < along - 4; u++) {
    const ext = shoreExtent(map.seed, width, u);
    if (u % 9 === 0 && ext >= 3) {
      // Moored: just off the sand, bow along the shore.
      const [tx, ty] = uvToTile(map, side, u, ext - 2);
      map.boatSpawns.push({
        x: (tx + 0.5) * TILE_SIZE,
        y: (ty + 0.5) * TILE_SIZE,
        heading: shoreHeading(side, (u / 9) % 2 === 0),
        kind: 'boat',
        moored: true,
      });
    } else if (u % 17 === 0 && ext >= 6) {
      // Cruising lane: open water, halfway out.
      const [tx, ty] = uvToTile(map, side, u, Math.max(1, Math.floor(ext / 2) - 1));
      map.boatSpawns.push({
        x: (tx + 0.5) * TILE_SIZE,
        y: (ty + 0.5) * TILE_SIZE,
        heading: shoreHeading(side, (u / 17) % 2 === 0),
        kind: 'boat',
        moored: false,
      });
    }
  }
}
