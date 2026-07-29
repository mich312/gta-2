import { rayWallDistance } from '../src/sim/weapons.js';
import { drivableTile } from '../src/sim/roadgrid.js';
import { isSolidAtWorld } from '../src/world/collide.js';
import { TILE_SIZE, type CityMap, type VehicleSpawn } from '../src/world/types.js';

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
export function roadLane(
  map: CityMap,
  need = 120,
  marginPx = 64,
  /**
   * Longest run the lane may have, for tests that need the car to ARRIVE at
   * something solid rather than merely have room to get going.
   *
   * A crash test staged with `roadLane` alone is really asking for a wall
   * within the ticks it runs for, and got one only because the first lane on
   * the map happened to be short. Any change to worldgen can hand it a
   * kilometre of straight instead, and the test then fails describing a
   * physics bug that is not there.
   */
  most = Infinity,
): VehicleSpawn {
  const probe = Number.isFinite(most) ? most + 20 : need + 20;
  for (const s of map.vehicleSpawns) {
    if (
      s.x < marginPx ||
      s.y < marginPx ||
      s.x > map.widthPx - marginPx ||
      s.y > map.heightPx - marginPx
    ) {
      continue;
    }
    const d = rayWallDistance(map, s.x, s.y, Math.cos(s.heading), Math.sin(s.heading), probe);
    if (d >= need && d <= most) return s;
  }
  throw new Error('no clear lane on this map');
}

/**
 * The right-hand (southern) lane at the west end of a straight, junction-free
 * east–west street: `runTiles` of three-wide carriageway with unbroken kerbs
 * both sides, so nothing can turn off mid-test.
 *
 * The predecessor of this helper required an exactly-two-tile road and only
 * checked for cross-streets at the start tile. Two-tile roads are rare
 * accidents of the generator (secondaries are three wide), and a junction
 * part-way down the run let the ambient driver turn off before reaching
 * whatever the test had staged in the lane — which looks like an AI bug and
 * is really a staging bug.
 */
export function straightEastLane(
  map: CityMap,
  runTiles = 14,
  widthTiles = 3,
): { x: number; y: number } {
  for (let ty = 6; ty < map.heightTiles - 6; ty++) {
    for (let tx = 6; tx < map.widthTiles - 6; tx++) {
      let ok = true;
      for (let i = 0; i < runTiles && ok; i++) {
        for (let r = 0; r < widthTiles && ok; r++) ok = drivableTile(map, tx + i, ty + r);
        if (ok) ok = !drivableTile(map, tx + i, ty - 1) && !drivableTile(map, tx + i, ty + widthTiles);
      }
      // Right-hand traffic: eastbound keeps to the southern row.
      if (ok) return { x: (tx + 0.5) * TILE_SIZE, y: (ty + widthTiles - 0.5) * TILE_SIZE };
    }
  }
  throw new Error('no straight junction-free street on this map');
}

/**
 * The centre of a size×size square of ground that is open in every
 * direction — for movement tests that need to run without clipping a wall.
 * The countryside makes these plentiful; hard-coding "the spawn has room
 * up-and-right" stopped being true the day the map stopped being a grid.
 */
export function openSquare(map: CityMap, size = 12): { x: number; y: number } {
  for (let ty = 2; ty < map.heightTiles - size - 2; ty++) {
    for (let tx = 2; tx < map.widthTiles - size - 2; tx++) {
      let open = true;
      for (let dy = 0; dy < size && open; dy++) {
        for (let dx = 0; dx < size; dx++) {
          if (isSolidAtWorld(map, (tx + dx + 0.5) * TILE_SIZE, (ty + dy + 0.5) * TILE_SIZE)) {
            open = false;
            break;
          }
        }
      }
      if (open) return { x: (tx + size / 2) * TILE_SIZE, y: (ty + size / 2) * TILE_SIZE };
    }
  }
  throw new Error('no open square on this map');
}

/**
 * A mooring with `need` px of open water ahead of its heading, for boat tests.
 *
 * Same trap as `roadLane`: taking `boatSpawns[0]` and opening the throttle
 * assumes the first mooring on the map happens to point down the river rather
 * than at the bank three metres away, and any change to worldgen quietly turns
 * a navigation test into a test of how fast a boat hits a wall.
 */
export function openWater(map: CityMap, need = 60, marginPx = 64): VehicleSpawn {
  for (const s of map.boatSpawns) {
    if (
      s.x < marginPx ||
      s.y < marginPx ||
      s.x > map.widthPx - marginPx ||
      s.y > map.heightPx - marginPx
    ) {
      continue;
    }
    const dx = Math.cos(s.heading);
    const dy = Math.sin(s.heading);
    let clear = true;
    // A boat is a box, so the hull's sides have to clear the bank too.
    for (let d = 0; d <= need && clear; d += 4) {
      for (const off of [-11, 0, 11]) {
        const x = s.x + dx * d - dy * off;
        const y = s.y + dy * d + dx * off;
        if (isSolidAtWorld(map, x, y, 'water')) {
          clear = false;
          break;
        }
      }
    }
    if (clear) return s;
  }
  throw new Error('no navigable mooring on this map');
}
