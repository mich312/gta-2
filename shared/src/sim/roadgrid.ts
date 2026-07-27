import { HALF_PI, PI, wrapAngle } from '../math/trig.js';
import { T_BRIDGE, T_ROAD, TILE_SIZE, type CityMap } from '../world/types.js';

/**
 * The road grid as a navigation aid.
 *
 * Neither vehicle AI uses a graph: they probe the tile grid for road ahead in
 * one of four directions and steer accordingly. The grid does the heavy
 * lifting, which is what makes both of them look smarter than they are.
 *
 * Shared by ambient traffic (which follows lanes) and by police pursuit
 * (which does not, but still has to get round a building).
 */

/** Cardinal directions, indexed 0..3: +x, +y, -x, -y (screen axes). */
export const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** Heading of each cardinal direction. */
export const CARDINAL_ANGLE = [0, HALF_PI, PI, -HALF_PI] as const;

/** Drivable by a car: road, and the bridges that carry it. */
export function drivableTile(map: CityMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
  const tile = map.tiles[ty * map.widthTiles + tx];
  return tile === T_ROAD || tile === T_BRIDGE;
}

export function drivableAt(map: CityMap, x: number, y: number): boolean {
  return drivableTile(map, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
}

/** Cardinal index nearest to a heading. Wrapped first, so any angle works. */
export function nearestCardinal(heading: number): number {
  const raw = Math.round(wrapAngle(heading) / HALF_PI);
  return ((raw % 4) + 4) % 4;
}

/** Worth following: is there road that way for a couple of tiles? */
export function dirIsOpen(map: CityMap, x: number, y: number, dirIdx: number): boolean {
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  return (
    drivableAt(map, x + dx * TILE_SIZE * 1.5, y + dy * TILE_SIZE * 1.5) &&
    drivableAt(map, x + dx * TILE_SIZE * 2.5, y + dy * TILE_SIZE * 2.5)
  );
}
