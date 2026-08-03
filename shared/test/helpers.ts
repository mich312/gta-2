import { rayWallDistance } from '../src/sim/weapons.js';
import { drivableTile } from '../src/sim/roadgrid.js';
import { isSolidAtWorld, isSolidTile } from '../src/world/collide.js';
import { T_BUILDING, TILE_SIZE, type CityMap, type VehicleSpawn } from '../src/world/types.js';

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
 *
 * They all search from the FIRST PLAYER SPAWN outwards rather than from the
 * top-left corner of the map. That mattered the moment the city stopped being
 * a uniform grid: the corner of a drawn map is sea, and the first land under
 * it is a dock road with no crowd, no traffic and no kerbside parking — so a
 * pursuit test staged there was really testing what happens on the quietest
 * street in the world. Player spawns are picked to be in built-up parts of
 * town (`amenities.placePlayerSpawns`), so "near a spawn" is the closest
 * thing the map has to "somewhere a player would be".
 */

/**
 * Tiles in rings outward from the first player spawn: every tile of the map
 * exactly once, nearest first, deterministically.
 */
function* fromSpawn(map: CityMap, margin: number): Generator<readonly [number, number]> {
  const sx = Math.floor((map.playerSpawns[0]?.x ?? map.widthPx / 2) / TILE_SIZE);
  const sy = Math.floor((map.playerSpawns[0]?.y ?? map.heightPx / 2) / TILE_SIZE);
  const reach = Math.max(map.widthTiles, map.heightTiles);
  for (let r = 0; r <= reach; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const edgeRow = dy === -r || dy === r;
      for (let dx = -r; dx <= r; dx += edgeRow ? 1 : 2 * r) {
        const tx = sx + dx;
        const ty = sy + dy;
        if (tx < margin || ty < margin) continue;
        if (tx >= map.widthTiles - margin || ty >= map.heightTiles - margin) continue;
        yield [tx, ty] as const;
        if (r === 0) break;
      }
    }
  }
}

/** How far a point is from the first player spawn, in px. */
export function fromSpawnPx(map: CityMap, x: number, y: number): number {
  const s = map.playerSpawns[0] ?? { x: map.widthPx / 2, y: map.heightPx / 2 };
  return Math.hypot(x - s.x, y - s.y);
}

/** Tiles nearest the first player spawn first. Exported for bespoke scans. */
export function tilesFromSpawn(map: CityMap, margin = 4): Array<readonly [number, number]> {
  return [...fromSpawn(map, margin)];
}

/**
 * A direction from `from` with at least `need` px of clear line. Cardinals
 * first — most callers stage on a street and the street is usually axis —
 * then sixteen compass points, because on the rotated and contour fabrics
 * (WORLDGEN.md §13.4) the open direction from a kerb is the street's own
 * bearing and no cardinal at all.
 */
export function clearAim(map: CityMap, from: { x: number; y: number }, need = 60): number {
  const angles = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
  for (let i = 0; i < 16; i++) angles.push((i * Math.PI) / 8);
  for (const angle of angles) {
    const d = rayWallDistance(map, from.x, from.y, Math.cos(angle), Math.sin(angle), need + 20);
    if (d >= need) return angle;
  }
  throw new Error('no clear direction from that point — pick another seed');
}

/**
 * Somewhere to stand with a wall in front of you: an open tile with a
 * building between `near` and `far` px away along one axis, and the angle to
 * it. For tests about what happens when a shot ARRIVES.
 */
export function spotFacingWall(
  map: CityMap,
  near = 60,
  far = 300,
): { x: number; y: number; angle: number } {
  for (const [tx, ty] of fromSpawn(map, 4)) {
    const x = (tx + 0.5) * TILE_SIZE;
    const y = (ty + 0.5) * TILE_SIZE;
    if (isSolidAtWorld(map, x, y)) continue;
    for (const angle of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const d = rayWallDistance(map, x, y, Math.cos(angle), Math.sin(angle), far);
      if (d >= near && d < far) return { x, y, angle };
    }
  }
  throw new Error('nowhere on this map has a wall in front of it');
}

/**
 * A point roughly `dist` px away with open ground under it — no line of sight
 * required.
 *
 * `clearSpot` needs an unbroken straight line, which on a drawn city is asking
 * for an avenue: half a kilometre of clear axis simply does not exist in a
 * residential block. Where the test only needs a bystander well out of the
 * blast, this is the honest question to ask.
 */
export function farOpenSpot(
  map: CityMap,
  from: { x: number; y: number },
  dist: number,
): { x: number; y: number } {
  for (const [tx, ty] of fromSpawn(map, 2)) {
    const x = (tx + 0.5) * TILE_SIZE;
    const y = (ty + 0.5) * TILE_SIZE;
    const d = Math.hypot(x - from.x, y - from.y);
    if (d < dist || d > dist * 1.6) continue;
    if (isSolidAtWorld(map, x, y)) continue;
    return { x, y };
  }
  throw new Error('nowhere open at that range');
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
  /**
   * Clear ground REQUIRED behind the spot too, in px. A test that stages a
   * second party `n` px behind the lane and rolls it forward is validating
   * the ground ahead and trusting the ground behind — which held while the
   * nearest lanes were long axis straights, and stopped holding when the
   * rotated boroughs made the nearest lane a short diagonal with a junction
   * at its tail.
   */
  back = 0,
): VehicleSpawn {
  const probe = Number.isFinite(most) ? most + 20 : need + 20;
  const near = [...map.vehicleSpawns].sort(
    (a, b) => fromSpawnPx(map, a.x, a.y) - fromSpawnPx(map, b.x, b.y),
  );
  for (const s of near) {
    if (
      s.x < marginPx ||
      s.y < marginPx ||
      s.x > map.widthPx - marginPx ||
      s.y > map.heightPx - marginPx
    ) {
      continue;
    }
    const d = rayWallDistance(map, s.x, s.y, Math.cos(s.heading), Math.sin(s.heading), probe);
    if (d < need || d > most) continue;
    if (back > 0) {
      const b = rayWallDistance(map, s.x, s.y, -Math.cos(s.heading), -Math.sin(s.heading), back + 20);
      if (b < back) continue;
    }
    return s;
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
  // Not the FIRST qualifying lane: the one the police can actually turn out
  // to. Waves stage at kerbside spawn points in a 260-640 px ring around
  // the suspect (`police.json` spawnMinDist/MaxDist), and a whole wave
  // wants company — kerbs near other kerbs — before it fields. The first
  // qualifying lane used to sit deep in the grid where kerbs are thick;
  // once the city gained avenues and a coastline it landed on a quiet edge
  // whose ring held thirteen lonely spots, the wave never assembled, and a
  // test about pursuit measured kerb scarcity instead. So score a fistful
  // of candidates by ring density and take the busiest.
  const ringKerbs = (fx: number, fy: number): number => {
    let n = 0;
    for (const s of map.vehicleSpawns) {
      const d = Math.hypot(s.x - fx, s.y - fy);
      if (d >= 260 && d <= 640) n++;
    }
    return n;
  };
  let best: { x: number; y: number } | null = null;
  let bestKerbs = -1;
  let seen = 0;
  for (const [tx, ty] of fromSpawn(map, 6 + runTiles)) {
    let ok = true;
    for (let i = 0; i < runTiles && ok; i++) {
      for (let r = 0; r < widthTiles && ok; r++) ok = drivableTile(map, tx + i, ty + r);
      if (ok) ok = !drivableTile(map, tx + i, ty - 1) && !drivableTile(map, tx + i, ty + widthTiles);
    }
    if (!ok) continue;
    // Right-hand traffic: eastbound keeps to the southern row.
    const lane = { x: (tx + 0.5) * TILE_SIZE, y: (ty + widthTiles - 0.5) * TILE_SIZE };
    const kerbs = ringKerbs(lane.x + 5 * TILE_SIZE, lane.y);
    if (kerbs > bestKerbs) {
      best = lane;
      bestKerbs = kerbs;
    }
    if (++seen >= 40) break;
  }
  if (best) return best;
  throw new Error('no straight junction-free street on this map');
}

/**
 * Somewhere to stand INSIDE a wall, with twenty tiles of clear approach to
 * the west of it — for tests that hide a suspect where nobody at street
 * level can see or reach them, while a cruiser staged on the approach can
 * genuinely DRIVE at the wall.
 *
 * Found rather than assumed: the first building in scan order used to do,
 * until the first building in scan order became one on a dockside with the
 * harbour behind it. The wall is five tall and three deep, and the point
 * returned is the middle of its west face. In a one-tile wall the suspect's
 * body pokes to within a couple of pixels of both faces, and an officer
 * casting about on the far side can catch a sliver of them through it — one
 * glimpse resets the search clock through the radio, and "gives up" never
 * comes. Hidden must mean hidden.
 */
export function spotInsideWall(map: CityMap): { x: number; y: number } | null {
  for (const [tx, ty] of tilesFromSpawn(map, 24)) {
    if (map.tiles[ty * map.widthTiles + tx] !== T_BUILDING) continue;
    let open = true;
    for (let i = 1; i <= 20 && open; i++) {
      for (let dy = -1; dy <= 1; dy++) open = open && !isSolidTile(map, tx - i, ty + dy, 'land');
    }
    // ...and a wall deep enough that driving round it is not the easy way,
    // in both axes.
    for (let dy = -2; dy <= 2 && open; dy++) {
      for (let dx = 0; dx <= 2 && open; dx++) {
        open = map.tiles[(ty + dy) * map.widthTiles + tx + dx] === T_BUILDING;
      }
    }
    if (!open) continue;
    return { x: (tx + 1.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
  }
  return null;
}

/**
 * The centre of a size×size square of ground that is open in every
 * direction — for movement tests that need to run without clipping a wall.
 * The countryside makes these plentiful; hard-coding "the spawn has room
 * up-and-right" stopped being true the day the map stopped being a grid.
 */
export function openSquare(map: CityMap, size = 12): { x: number; y: number } {
  for (const [tx, ty] of fromSpawn(map, size + 2)) {
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
  throw new Error('no open square on this map');
}

/**
 * The kerb with the most other kerbs around it, in the ring police turn out
 * from (`police.json`'s spawnMinDist..spawnMaxDist).
 *
 * For tests about how big a FORCE arrives, rather than about pursuit: the
 * spawner draws officers from kerbside parking inside that ring, so on a
 * quiet lane a six-star wave is two officers and a test about wave
 * composition is really a test about the street it was staged on. This picks
 * the busiest corner of the city and says so, instead of taking whatever the
 * first kerb in scan order happens to be.
 */
export function busyKerb(map: CityMap, near = 260, far = 640): VehicleSpawn {
  let best = map.vehicleSpawns[0];
  let bestCount = -1;
  for (const s of map.vehicleSpawns) {
    let n = 0;
    for (const o of map.vehicleSpawns) {
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d >= near && d <= far) n++;
    }
    if (n > bestCount) {
      bestCount = n;
      best = s;
    }
  }
  if (!best) throw new Error('no kerbside parking on this map');
  return best;
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
  const near = [...map.boatSpawns].sort(
    (a, b) => fromSpawnPx(map, a.x, a.y) - fromSpawnPx(map, b.x, b.y),
  );
  for (const s of near) {
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
