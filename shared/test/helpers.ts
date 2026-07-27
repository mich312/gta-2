import { rayWallDistance } from '../src/sim/weapons.js';
import type { CityMap, VehicleSpawn } from '../src/world/types.js';

/**
 * Geometry helpers for tests.
 *
 * Several tests used to assume that +x from wherever a player happened to
 * spawn was open ground. That held only by luck, and any change to worldgen's
 * rng order — adding a shop kind, carving a river, placing one fewer building
 * — moves every spawn point and silently parks a shooter against a wall with
 * their target behind it. The failures look like combat bugs and are not.
 *
 * Use these instead of hard-coded offsets.
 */

/** An axis direction from `from` with at least `need` px of clear line. */
export function clearAim(map: CityMap, from: { x: number; y: number }, need = 60): number {
  for (const angle of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
    const d = rayWallDistance(map, from.x, from.y, Math.cos(angle), Math.sin(angle), need + 20);
    if (d >= need) return angle;
  }
  throw new Error('no clear direction from that point — pick another seed');
}

/** A point `dist` px along a clear direction from `from`. */
export function clearSpot(
  map: CityMap,
  from: { x: number; y: number },
  dist: number,
): { x: number; y: number; angle: number } {
  const angle = clearAim(map, from, dist + 10);
  return { x: from.x + Math.cos(angle) * dist, y: from.y + Math.sin(angle) * dist, angle };
}

/**
 * A kerbside spawn with clear road ahead of it, for driving tests.
 *
 * The margin matters: rayWallDistance probes from a POINT, but a car is a box
 * with a half-extent, so a lane flush against the map edge looks clear to the
 * ray and still has the vehicle's near side outside the world — which is
 * solid. The car then bounces on its first tick and drops below every
 * speed threshold the test was about.
 */
export function roadLane(map: CityMap, need = 120, marginPx = 64): VehicleSpawn {
  for (const s of map.vehicleSpawns) {
    if (
      s.x < marginPx ||
      s.y < marginPx ||
      s.x > map.widthPx - marginPx ||
      s.y > map.heightPx - marginPx
    ) {
      continue;
    }
    const d = rayWallDistance(map, s.x, s.y, Math.cos(s.heading), Math.sin(s.heading), need + 20);
    if (d >= need) return s;
  }
  throw new Error('no clear lane on this map');
}
