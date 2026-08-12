import { HALF_PI, PI, wrapAngle } from '../math/trig.js';
import { T_BRIDGE, T_ROAD, TILE_SIZE, type CityMap } from '../world/types.js';
import { joinWithin, routeNodes, tilesToJunction, type RoadNet } from './roadnet.js';

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

/**
 * Which way is the driver's right, along the axis across their travel,
 * indexed by cardinal: heading east your right is +y, heading south it is -x.
 *
 * This city drives on the right. Everything that has to agree about which half
 * of a carriageway belongs to which direction reads it from here — the lane
 * model in `traffic.ts` picks its lanes with it, and the signal heads in
 * `signals.ts` stand on the kerb it points at. The two used to be separate
 * facts, and a signal on the wrong side of the road is the kind of thing that
 * looks like an art bug rather than a disagreement about traffic law.
 */
export const RIGHT_SIGN = [1, -1, -1, 1] as const;

/** The unit step towards the driver's right, in tiles, indexed by cardinal. */
export const RIGHT_STEP: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
];

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
 * lower tile index on every host. Integer arithmetic throughout. The packed
 * key is f * size + idx, so it stays exact while size is under about 2^26 —
 * a map of ninety million tiles, against the six hundred thousand this one
 * has. No rng.
 */
/**
 * The A* working set, allocated once and reused.
 *
 * It used to be three fresh typed arrays per call — five megabytes on a city
 * this size, plus two full `.fill(-1)` passes before the search had looked at
 * a single tile. Traffic replans, ambulance dispatch and errand assignment
 * between them call this several times a second, so that was tens of
 * megabytes a second of pure scratch and a measurable slice of a core spent
 * zeroing memory.
 *
 * `stamp` is what makes reuse safe without clearing: every call takes a fresh
 * era, a cell is "seen this call" when its stamp is +era and "closed" when it
 * is -era, and anything left over from a previous call is simply neither.
 * Module state, but not shared state in any sense the simulation can observe:
 * the search reads the map and writes only here, and two hosts running the
 * same query still walk the same tiles in the same order.
 */
interface RouteScratch {
  size: number;
  gScore: Int32Array;
  cameFrom: Int32Array;
  stamp: Int32Array;
  era: number;
}
let scratchStore: RouteScratch | null = null;

/** Never expand more tiles than this in one search. See the call site. */
const MAX_EXPANSIONS = 60_000;

function routeScratch(size: number): RouteScratch {
  if (scratchStore === null || scratchStore.size < size) {
    scratchStore = {
      size,
      gScore: new Int32Array(size),
      cameFrom: new Int32Array(size),
      stamp: new Int32Array(size),
      era: 0,
    };
  }
  return scratchStore;
}

export function planRoute(
  map: CityMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number[] | null {
  const start = nearestDrivable(map, fromX, fromY);
  const goal = nearestDrivable(map, toX, toY);
  if (start < 0 || goal < 0) return null;
  const net = map.roadNet;
  if (net !== undefined) {
    const tiles = routeOverNet(net, start, goal);
    if (tiles !== null) return waypoints(tiles, map.widthTiles);
    // Owned by no junction at either end — a lane on an islet with no
    // intersection anywhere on it. Rare, and the tile search still answers it.
    if ((net.owner[start] as number) >= 0 && (net.owner[goal] as number) >= 0) return null;
  }
  return planRouteOverTiles(map, start, goal);
}

/**
 * The tile path from one drivable tile to another, over the junction graph.
 *
 * Three pieces, and only the middle one is a search: walk the flood tree from
 * the start out to its own junction, cross the city junction by junction,
 * then walk the tree in from the destination's junction to the destination.
 * The first and last legs cost nothing at all — every tile already knows its
 * way home, which is what the flood built.
 *
 * Null when either end belongs to no junction, or when no street joins the
 * two. It does NOT fall back to searching tiles on a genuine disconnection:
 * "these two are not joined" is a question the graph answers in microseconds
 * and the tile search answered by flooding the whole city, which is the
 * twenty-millisecond spike `MAX_EXPANSIONS` existed to cap.
 */
function routeOverNet(net: RoadNet, start: number, goal: number): number[] | null {
  const a = net.owner[start] as number;
  const b = net.owner[goal] as number;
  if (a < 0 || b < 0) return null;
  const raw: number[] = [];
  // Every tile appended has to be a STEP from the one before it. The three
  // pieces below each begin at whichever junction tile they begin at, so the
  // seams between them are filled in rather than jumped.
  const append = (tiles: readonly number[]): void => {
    for (const t of tiles) {
      const last = raw[raw.length - 1];
      if (last !== undefined && last !== t) {
        const dx = Math.abs((t % net.widthTiles) - (last % net.widthTiles));
        const dy = Math.abs(Math.floor(t / net.widthTiles) - Math.floor(last / net.widthTiles));
        if (dx + dy !== 1) for (const mid of joinWithin(net, last, t)) raw.push(mid);
      }
      raw.push(t);
    }
  };
  append(tilesToJunction(net, start));
  if (a !== b) {
    const edges = routeNodes(net, a, b);
    if (edges === null) return null;
    let at = a;
    for (const e of edges) {
      const forward = (net.edgeA[e] as number) === at;
      const lo = net.pathOff[e] as number;
      const hi = net.pathOff[e + 1] as number;
      const span: number[] = [];
      if (forward) for (let k = lo; k < hi; k++) span.push(net.pathTiles[k] as number);
      else for (let k = hi - 1; k >= lo; k--) span.push(net.pathTiles[k] as number);
      append(span);
      at = forward ? (net.edgeB[e] as number) : (net.edgeA[e] as number);
    }
  }
  append(tilesToJunction(net, goal).reverse());

  // Cut every loop out of it. The walk to a junction goes to whichever of its
  // tiles the flood happened to seed from, and the street out of it leaves
  // from another, so the spliced path doubles back on itself around every
  // node — and around the start too, when the destination lies back down the
  // street the car is already on. Dropping everything between a tile and its
  // own second appearance leaves the simple path through the same corridor.
  const seen = new Map<number, number>();
  const out: number[] = [];
  for (const t of raw) {
    const p = seen.get(t);
    if (p === undefined) {
      seen.set(t, out.length);
      out.push(t);
      continue;
    }
    for (let k = out.length - 1; k > p; k--) seen.delete(out[k] as number);
    out.length = p + 1;
  }
  return out;
}

/**
 * A tile path compressed to the corners a driver steers at: where it turns,
 * plus one every few tiles along a straight.
 *
 * Pure corners would be enough to drive by, but the follower judges "off the
 * plan" by distance to its current waypoint — against a corner half a street
 * away, every long straight reads as hopelessly lost and the route is
 * re-planned into a livelock. Bounded spacing keeps waypoint distance an
 * honest proxy for off-route distance, at a few extra cloned numbers per
 * straight.
 */
function waypoints(tiles: readonly number[], w: number): number[] {
  const out: number[] = [];
  let sinceEmit = 0;
  // From index 0, so the FIRST corner is the tile the query snapped to. The
  // emitter bounds every later gap at `ROUTE_SEGMENT_TILES`, but it bounded
  // nothing at the head: a car starting on a junction tile got its first
  // corner up to nine tiles away, against a follower that calls itself lost
  // at eight and then re-plans every tick without ever steering.
  for (let i = 0; i < tiles.length; i++) {
    const isLast = i === tiles.length - 1;
    // Index deltas encode direction (+-1 along x, +-w along y): a change of
    // delta is a turn. A splice between two junction tiles is not adjacent at
    // all, which reads as a turn and earns a waypoint, which is right.
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
  if (out.length === 0 && tiles.length > 0) {
    const last = tiles[tiles.length - 1] as number;
    const x = last % w;
    out.push((x + 0.5) * TILE_SIZE, ((last - x) / w + 0.5) * TILE_SIZE);
  }
  return out;
}

/**
 * The original search, kept for the carriageway the graph does not reach: a
 * lane on an islet with no intersection on it, and the bare test fixtures
 * that have no junction table to build a graph from.
 */
function planRouteOverTiles(map: CityMap, start: number, goal: number): number[] | null {
  const w = map.widthTiles;
  const size = w * map.heightTiles;
  if (start === goal) {
    const x = goal % w;
    return [(x + 0.5) * TILE_SIZE, ((goal - x) / w + 0.5) * TILE_SIZE];
  }

  const scratch = routeScratch(size);
  const { gScore, cameFrom, stamp } = scratch;
  const era = ++scratch.era;
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
  stamp[start] = era;
  push(heuristic(start) * size + start);
  let found = false;
  let expanded = 0;
  while (heap.length > 0) {
    const idx = pop() % size;
    if (stamp[idx] === -era) continue; // a stale entry superseded by a better g
    stamp[idx] = -era;
    if (++expanded > MAX_EXPANSIONS) return null;
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
      if (stamp[nIdx] === -era) continue;
      const known = stamp[nIdx] === era ? (gScore[nIdx] as number) : -1;
      if (known !== -1 && known <= ng) continue;
      stamp[nIdx] = era;
      gScore[nIdx] = ng;
      cameFrom[nIdx] = idx;
      push((ng + heuristic(nIdx)) * size + nIdx);
    }
  }
  if (!found) return null;

  // Terminated on the START, not on a sentinel. `cameFrom` is reused scratch
  // that is never cleared, so a leftover value from an earlier search is not
  // -1 and walking until it is walks into another route, or into a cycle.
  const tiles: number[] = [];
  for (let idx = goal; ; idx = cameFrom[idx] as number) {
    tiles.push(idx);
    if (idx === start) break;
  }
  tiles.reverse();
  return waypoints(tiles, w);
}

/** Longest straight between route waypoints, in tiles. See planRoute. */
export const ROUTE_SEGMENT_TILES = 6;
