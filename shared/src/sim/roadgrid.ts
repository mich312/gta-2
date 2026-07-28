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

/**
 * Nearest drivable tile to a point, as a tile index, or -1 within 3 tiles of
 * nothing. The same spiral the traffic AI uses to recover a car that has ended
 * up off the carriageway.
 */
function nearestDrivable(map: CityMap, x: number, y: number): number {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (drivableTile(map, tx, ty)) return ty * map.widthTiles + tx;
  let best = -1;
  let bestD = Infinity;
  for (let r = 1; r <= 3 && best < 0; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!drivableTile(map, tx + dx, ty + dy)) continue;
        const cx = (tx + dx + 0.5) * TILE_SIZE - x;
        const cy = (ty + dy + 0.5) * TILE_SIZE - y;
        const d = cx * cx + cy * cy;
        if (d < bestD) {
          bestD = d;
          best = (ty + dy) * map.widthTiles + tx + dx;
        }
      }
    }
  }
  return best;
}

/**
 * A route across the road grid, as a flat list of corner points
 * [x0,y0, x1,y1, ...] in px — the tile centres where the path changes
 * direction, ending on the tile nearest the destination. Null when either end
 * is nowhere near a road or no road connects them.
 *
 * Plain A* over drivable tiles, 4-connected, unit step cost, Manhattan
 * heuristic. Everything the genre ever does with a car that must get
 * somewhere sits on a search like this (see CAR-AI.md §2.2, §3.1); the output
 * is deliberately just corners, because the lane controller in sim/traffic.ts
 * already knows how to drive a cardinal — a route only has to tell it which
 * cardinal comes next.
 *
 * Deterministic by construction: the open list is a binary heap keyed on
 * (f, tile index) packed into one integer, so ties in f always resolve to the
 * lower tile index on every host. Integer arithmetic throughout; the packed
 * keys stay far under 2^53. No rng.
 */
export function planRoute(
  map: CityMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number[] | null {
  const w = map.widthTiles;
  const size = w * map.heightTiles;
  const start = nearestDrivable(map, fromX, fromY);
  const goal = nearestDrivable(map, toX, toY);
  if (start < 0 || goal < 0) return null;
  if (start === goal) {
    const x = goal % w;
    return [(x + 0.5) * TILE_SIZE, ((goal - x) / w + 0.5) * TILE_SIZE];
  }

  const gScore = new Int32Array(size).fill(-1);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const goalX = goal % w;
  const goalY = (goal - goalX) / w;
  const heuristic = (idx: number): number => {
    const x = idx % w;
    return Math.abs(x - goalX) + Math.abs((idx - x) / w - goalY);
  };

  const heap: number[] = [];
  const push = (key: number): void => {
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pv = heap[parent] as number;
      const iv = heap[i] as number;
      if (pv <= iv) break;
      heap[parent] = iv;
      heap[i] = pv;
      i = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0] as number;
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l] as number) < (heap[m] as number)) m = l;
        if (r < heap.length && (heap[r] as number) < (heap[m] as number)) m = r;
        if (m === i) break;
        const t = heap[m] as number;
        heap[m] = heap[i] as number;
        heap[i] = t;
        i = m;
      }
    }
    return top;
  };

  gScore[start] = 0;
  push(heuristic(start) * size + start);
  let found = false;
  while (heap.length > 0) {
    const idx = pop() % size;
    if (closed[idx]) continue; // a stale entry superseded by a better g
    closed[idx] = 1;
    if (idx === goal) {
      found = true;
      break;
    }
    const x = idx % w;
    const y = (idx - x) / w;
    const ng = (gScore[idx] as number) + 1;
    for (const [dx, dy] of CARDINALS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!drivableTile(map, nx, ny)) continue;
      const nIdx = ny * w + nx;
      if (closed[nIdx]) continue;
      const known = gScore[nIdx] as number;
      if (known !== -1 && known <= ng) continue;
      gScore[nIdx] = ng;
      cameFrom[nIdx] = idx;
      push((ng + heuristic(nIdx)) * size + nIdx);
    }
  }
  if (!found) return null;

  // Walk back to the start, then compress the tile path to waypoints: the
  // corners where it turns, plus one every few tiles along a straight. Pure
  // corners would be enough to drive by, but the follower judges "off the
  // plan" by distance to its current waypoint — against a corner half a
  // street away, every long straight reads as hopelessly lost and the route
  // is re-planned into a livelock. Bounded spacing keeps waypoint distance an
  // honest proxy for off-route distance, at a few extra cloned numbers per
  // straight.
  const tiles: number[] = [];
  for (let idx = goal; idx !== -1; idx = cameFrom[idx] as number) tiles.push(idx);
  tiles.reverse();
  const out: number[] = [];
  let sinceEmit = 0;
  for (let i = 1; i < tiles.length; i++) {
    const isLast = i === tiles.length - 1;
    // Index deltas encode direction (+-1 along x, +-w along y): a change of
    // delta is a turn.
    const turn =
      !isLast &&
      (tiles[i] as number) - (tiles[i - 1] as number) !==
        (tiles[i + 1] as number) - (tiles[i] as number);
    sinceEmit++;
    if (turn || isLast || sinceEmit >= ROUTE_SEGMENT_TILES) {
      const x = (tiles[i] as number) % w;
      out.push((x + 0.5) * TILE_SIZE, (((tiles[i] as number) - x) / w + 0.5) * TILE_SIZE);
      sinceEmit = 0;
    }
  }
  return out;
}

/** Longest straight between route waypoints, in tiles. See planRoute. */
export const ROUTE_SEGMENT_TILES = 6;
