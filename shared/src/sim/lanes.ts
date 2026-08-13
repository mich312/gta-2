import { dAtan2 } from '../math/trig.js';
import { nearestCourse } from '../world/courseIndex.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import { drivableTile } from './roadgrid.js';
import type { RoadNet } from './roadnet.js';

/**
 * Lanes on the road graph (WORLDGEN.md §42).
 *
 * §40 gave the city a graph — junctions as nodes, streets as edges — and §41
 * gave every edge the width of the carriageway it carries. Neither gave a
 * street a LINE. An edge's geometry was still the chain of tile centres the
 * flood happened to walk, staircase and all, and the driver on top of it was
 * still feeling for the edges of the tarmac with a fan of probes.
 *
 * §41.2 tried to replace that fan with the courses' own centrelines and
 * measured worse every time — the last attempt kept the fan's criterion and
 * merely OFFERED the road's true direction as its first candidate, and still
 * doubled the off-road rate. The conclusion recorded there is the design here:
 *
 * > the fan is not finding the road's direction, it is keeping the car on the
 * > road, and a bearing chosen for how far it stays on tarmac carries
 * > information about where the car sits across the band that no geometric
 * > ideal contains.
 *
 * So this does not supply a better bearing. It supplies the thing the bearing
 * was standing in for: **which street the car is on, which way along it, and
 * where it sits across it.** That is three facts the nearest centreline cannot
 * give — a centreline query answers with whatever line is closest, which on
 * 9.5% of edges is a crossing street (§41.3), has no direction of travel, and
 * says nothing about sides.
 *
 * Three pieces:
 *
 *  - **A line per edge.** The path's tile centres, each snapped onto the
 *    course running down that street where one covers it, then smoothed.
 *    Where no course covers it the tile centres are all there is, and
 *    smoothing is what takes the staircase off them.
 *  - **Sides.** Half the carriageway each way, and two lanes each way where it
 *    is wide enough — the same 0.75/0.25 split `laneOptions` already drives,
 *    so a car in the kerb lane sits where it used to sit.
 *  - **A tile that names its edge.** One `Int16` plane, so a car asks where it
 *    is by reading one array element rather than searching.
 *
 * **Where it drives the car**: on the diagonal bands, and nowhere else yet.
 * That is `bandTarget` in `traffic.ts`, and the scope is a measurement rather
 * than caution — driving the whole city off this is better on lane behaviour
 * and worse on flow, and stops the cross-city errand arriving. §42.3 has the
 * table and the eight defects the attempt turned up.
 *
 * Deterministic: built from the graph and the baked courses with exact ops
 * only, no rng, so both hosts derive identical lanes and it never goes on the
 * wire — like `junctions`, `roadNet` and `courseIndex` before it.
 */

/** Sentinel in `edgeOf`: this tile belongs to no street. */
const NO_EDGE = -1;

/**
 * How close a tile centre must be to a course, in tiles, before the course is
 * believed to be THIS street's centreline rather than a neighbour's. Two
 * tiles: half the widest carriageway, so a centre anywhere on the road
 * reaches its own line and nothing reaches across a block.
 */
const SNAP_TILES = 2;
/**
 * How nearly a course must run the way the path runs before it is taken for
 * the same street. `cos 45°`: a crossing street is at a right angle and
 * scores zero, a curving one still scores well inside this.
 */
const SNAP_ALIGN = 0.7071;

/**
 * Widest carriageway that still has sides to keep to, in tiles — the same
 * bound `laneOptions` uses, and for the same reason: wider than this and the
 * measurement is running down a crossing road.
 */
const MAX_LANE_TILES = 4;

/** How far a street's name may spread from its own path. See `spreadEdges`. */
const SPREAD_TILES = MAX_LANE_TILES / 2 + 1;

export interface Lanes {
  widthTiles: number;
  /** Which edge each tile belongs to, or `NO_EDGE`. */
  edgeOf: Int16Array;
  /** Points of edge e: `x[off[e] .. off[e+1])`, world px, running A to B. */
  off: Int32Array;
  x: Float64Array;
  y: Float64Array;
  /** Distance along the edge to each point, px. */
  s: Float64Array;
  /**
   * How far the tarmac reaches from the line at each point, px, to the left
   * and the right of the edge's own direction.
   *
   * Per point and per side, not one number per street, because neither
   * simplification survives contact with the city. A street narrows where it
   * passes a building line and widens at a lay-by, and the line itself is not
   * always down the middle: it is the course where a course covers the street
   * and the smoothed tile centres where none does, and neither is guaranteed
   * to sit centred in the tarmac. Measured at the build, the lane can be
   * placed as a FRACTION of the room actually there, which is what stops a
   * "kerb lane" being computed onto the pavement.
   */
  halfL: Float64Array;
  halfR: Float64Array;
  /**
   * Lanes in EACH direction: 1, or 2 on an avenue.
   *
   * There is no "shared track" code. A one-tile lane falls out of the
   * measurement on its own — six pixels of room either side of the line means
   * a kerb lane three pixels off the middle, which is where a car in a
   * one-tile lane belongs — so a special case for it would be a branch the
   * city never takes.
   */
  edgeLanes: Int8Array;
}

/** Where along a street a car is, and which way along it it is going. */
export interface LanePoint {
  /** The edge the car is on. */
  edge: number;
  /** +1 when travelling A to B along the edge, -1 the other way. */
  dir: number;
  /** How far along the edge the car is, px from A. */
  at: number;
  /**
   * How far the car sits from the street's line, positive to the RIGHT of
   * travel. The one number the fan could never produce and the whole reason
   * a geometric centreline was not enough on its own (§41.2).
   */
  across: number;
  /** The street's bearing at the car, in the direction of travel. */
  tangent: number;
}

/**
 * Build the lanes. One pass over the graph's edges; nothing searches.
 */
export function buildLanes(map: CityMap, net: RoadNet): Lanes {
  const W = map.widthTiles;
  const m = net.edgeA.length;
  const idx = map.courseIndex;

  const edgeOf = new Int16Array(map.tiles.length).fill(NO_EDGE);
  const off = new Int32Array(m + 1);
  const xs: number[] = [];
  const ys: number[] = [];
  const ss: number[] = [];
  const edgeLanes = new Int8Array(m);
  const seeds: number[] = [];

  for (let e = 0; e < m; e++) {
    const lo = net.pathOff[e] as number;
    const hi = net.pathOff[e + 1] as number;
    const n = hi - lo;

    // The raw line: tile centres, in path order.
    const px: number[] = [];
    const py: number[] = [];
    for (let k = lo; k < hi; k++) {
      const t = net.pathTiles[k] as number;
      const tx = t % W;
      px.push((tx + 0.5) * TILE_SIZE);
      py.push(((t - tx) / W + 0.5) * TILE_SIZE);
      // Claimed for this edge, unless an earlier one already has it — which
      // happens where two streets run through the same trunk before parting.
      // First wins so the order is fixed rather than "whichever ran last",
      // and either answer is a street the car is genuinely on.
      if ((edgeOf[t] as number) === NO_EDGE) {
        edgeOf[t] = e;
        seeds.push(t);
      }
    }

    // Snapped: each centre pulled onto the course running down this street,
    // where one does. The test is not "is a course near" but "is a course
    // near AND running the way we are" — the nearest line to a point on a
    // street is the crossing street's own on nearly a tenth of them (§41.3).
    if (idx !== undefined) {
      for (let k = 0; k < n; k++) {
        const a = k > 0 ? k - 1 : k;
        const b = k + 1 < n ? k + 1 : k;
        const vx = (px[b] as number) - (px[a] as number);
        const vy = (py[b] as number) - (py[a] as number);
        const len = Math.sqrt(vx * vx + vy * vy);
        if (len === 0) continue;
        const near = nearestCourse(
          idx,
          (px[k] as number) / TILE_SIZE,
          (py[k] as number) / TILE_SIZE,
          SNAP_TILES,
        );
        if (near === null) continue;
        const along = (vx / len) * near.dx + (vy / len) * near.dy;
        if (along < SNAP_ALIGN && along > -SNAP_ALIGN) continue;
        px[k] = near.x * TILE_SIZE;
        py[k] = near.y * TILE_SIZE;
      }
    }

    // Smoothed: one pass of a three-point average over the interior. What is
    // left after the snap is the staircase on the stretches no course covers,
    // and a staircase is exactly what an average of three removes. The ends
    // are held: they sit in the junctions this street joins, and moving them
    // would part the street from its own node.
    //
    // One pass, and measured rather than assumed. Simplifying first
    // (Douglas-Peucker at half a tile) and corner-cutting after (Chaikin,
    // twice or three times) makes a visibly rounder line and a slightly
    // steadier aim bearing — 2.25 degrees of swing per 4 px against 2.30 —
    // and drives WORSE: off the carriageway 2.23% against 1.57%, at
    // identical speed. The line is not what was costing the traffic its
    // speed (see the note in traffic.ts), and a rounder line cuts corners
    // that the tarmac does not.
    const rx = px.slice();
    const ry = py.slice();
    for (let k = 1; k + 1 < n; k++) {
      rx[k] = ((px[k - 1] as number) + 2 * (px[k] as number) + (px[k + 1] as number)) / 4;
      ry[k] = ((py[k - 1] as number) + 2 * (py[k] as number) + (py[k + 1] as number)) / 4;
    }

    // Emitted, dropping any point that did not move on from the last: the
    // snap can put two centres on the same spot on the course, and a
    // zero-length segment has no direction to steer by.
    let last = -1;
    for (let k = 0; k < rx.length; k++) {
      const cx = rx[k] as number;
      const cy = ry[k] as number;
      if (last >= 0) {
        const dx = cx - (xs[last] as number);
        const dy = cy - (ys[last] as number);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) continue;
        ss.push((ss[last] as number) + d);
      } else {
        ss.push(0);
      }
      xs.push(cx);
      ys.push(cy);
      last = xs.length - 1;
    }
    off[e + 1] = xs.length;


    // How many lanes each way — the count only, from the width the courses
    // gave the edge (§41.3). WHERE those lanes sit is measured below, point
    // by point, because one number per street cannot say where the tarmac
    // actually is at any given yard of it.
    edgeLanes[e] = (net.edgeWidth[e] as number) >= MAX_LANE_TILES ? 2 : 1;
  }

  // How much room there is either side of the line, point by point.
  const halfL = new Float64Array(xs.length);
  const halfR = new Float64Array(xs.length);
  for (let e = 0; e < m; e++) {
    const lo = off[e] as number;
    const hi = off[e + 1] as number;
    for (let k = lo; k < hi; k++) {
      const a = k > lo ? k - 1 : k;
      const b = k + 1 < hi ? k + 1 : k;
      const vx = (xs[b] as number) - (xs[a] as number);
      const vy = (ys[b] as number) - (ys[a] as number);
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len === 0) continue;
      // The right of a direction, y down, is that direction turned a quarter
      // turn clockwise.
      const rx = -vy / len;
      const ry = vx / len;
      halfR[k] = reachAcross(map, xs[k] as number, ys[k] as number, rx, ry);
      halfL[k] = reachAcross(map, xs[k] as number, ys[k] as number, -rx, -ry);
    }
  }

  spreadEdges(map, net, edgeOf, seeds);

  return {
    widthTiles: W,
    edgeOf,
    off,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    s: Float64Array.from(ss),
    halfL,
    halfR,
    edgeLanes,
  };
}

/** How far the tarmac reaches from a point along one direction, in px. */
function reachAcross(map: CityMap, x: number, y: number, dx: number, dy: number): number {
  const limit = (MAX_LANE_TILES / 2) * TILE_SIZE;
  let out = 0;
  // Two-pixel steps: fine enough that the answer is never half a lane out,
  // coarse enough that a whole street costs a few hundred tile reads at the
  // build and none at all afterwards.
  for (let d = 2; d <= limit; d += 2) {
    const tx = Math.floor((x + dx * d) / TILE_SIZE);
    const ty = Math.floor((y + dy * d) / TILE_SIZE);
    if (!drivableTile(map, tx, ty)) break;
    out = d;
  }
  return out;
}

/** Cardinal steps, in the fixed order the spread visits them. */
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * Widen the ribbon: give every drivable tile the edge of the nearest tile the
 * flood's path ran through.
 *
 * An edge's path is ONE tile wide, because it is the chain the flood walked.
 * A street is up to four. Left as it came, two thirds of the carriageway
 * named no street at all — including most of the kerb lanes, which is exactly
 * where the cars are — and a car standing on an unnamed tile has no lane to
 * keep to. Breadth-first from the path tiles in edge order, so the seeds and
 * the sweep are the same on every host.
 *
 * Junction tiles are cleared afterwards rather than skipped: a junction is a
 * hole in the lane model on purpose, and the paths run right through it.
 *
 * BOUNDED, at half the widest carriageway plus a tile. Unbounded it does not
 * stop at the edges of a street: a dead-end spur or a long lane with no
 * intersection on it anywhere has no edge of its own, so the flood pours
 * down it from the junction at its mouth and names the whole thing after some
 * hundred-pixel street back at the corner. Measured, the worst tile in the
 * city was named a street whose line is 147 TILES away, and a car standing
 * there would have steered at it. Past the bound the answer is "no street
 * here", which is true, and the tarmac-following fallback handles it.
 */
function spreadEdges(map: CityMap, net: RoadNet, edgeOf: Int16Array, seeds: number[]): void {
  const W = net.widthTiles;
  const H = map.heightTiles;
  const queue = seeds;
  const depth = new Uint8Array(edgeOf.length);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    const d = depth[i] as number;
    if (d >= SPREAD_TILES) continue;
    const x = i % W;
    const y = (i - x) / W;
    const e = edgeOf[i] as number;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if ((edgeOf[j] as number) !== NO_EDGE) continue;
      if (!drivableTile(map, nx, ny)) continue;
      edgeOf[j] = e;
      depth[j] = d + 1;
      queue.push(j);
    }
  }

  const idOf = map.junctions.idOf;
  for (let i = 0; i < edgeOf.length; i++) if ((idOf[i] as number) >= 0) edgeOf[i] = NO_EDGE;
}

/**
 * Where the centre of lane `lane` sits, as a signed offset to the right of
 * travel in px, given how much room the tarmac leaves on each side here.
 *
 * A FRACTION of the room MEASURED, not a fraction of a nominal width: the
 * same 0.5 / 0.75 / 0.25 split `laneOptions` already drives, so a car in the
 * kerb lane sits where it used to, but taken against tarmac that is known to
 * be there rather than against a width averaged over a whole street. On a
 * one-tile lane it collapses on its own — there are six pixels of room, so
 * the "kerb lane" is three pixels off the middle, which is where a car in a
 * one-tile lane belongs.
 *
 * Lane 0 is the kerb lane of the car's own half, lane 1 the inner one where
 * the road is wide enough to have one, and lane 2 the oncoming half — the
 * same ordered list `laneOptions` offers, so that when a driver comes to
 * choose between them it chooses between the same three.
 *
 * **Only lane 0 is driven today**, and that is deliberate rather than
 * unfinished. The band driver (`bandTarget`) is the one consumer, and a car
 * on a curved band picking its way between three lanes measures worse than
 * one that keeps to the kerb; the overtaking rule stays where it already
 * works, on the cardinal model. The other two are here because a lane model
 * without sides is not a lane model, and because the tests pin them.
 */
export function laneOffset(
  perSide: number,
  roomRight: number,
  roomLeft: number,
  lane: number,
): number {
  // The LAST option is always the oncoming half, whether that is option 1 on
  // an ordinary street or option 2 on an avenue. Getting this wrong is not a
  // rounding error: with the oncoming half unreachable on a two-lane street,
  // a single parked car is a permanent roadblock, everything behind it
  // queues, and queues wedge.
  if (perSide < 2) return lane === 0 ? roomRight * 0.5 : -roomLeft * 0.5;
  return lane === 0 ? roomRight * 0.75 : lane === 1 ? roomRight * 0.25 : -roomLeft * 0.5;
}

/**
 * Which street a point is on, or -1 for a junction, a kerb or a field.
 */
export function edgeAt(lanes: Lanes, x: number, y: number): number {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= lanes.widthTiles) return NO_EDGE;
  const i = ty * lanes.widthTiles + tx;
  if (i < 0 || i >= lanes.edgeOf.length) return NO_EDGE;
  return lanes.edgeOf[i] as number;
}

/**
 * Put a car on a street: which one, which way along it, how far along, and
 * how far across.
 *
 * Null when the car is not on a street the graph knows — inside a junction,
 * off the carriageway, or on an islet's lane with no intersection anywhere on
 * it. Those are the caller's to handle, and they are handled differently.
 *
 * Which way along it comes from `(cos, sin)`: the way the car is POINTING.
 *
 * Which way along a street a car is going is a fact about the car, and the
 * alternatives were measured. Resolving it from the driver's INTENT instead —
 * a cardinal — costs half again on the mean steering error (0.48 rad against
 * 0.31), a tenth of the traffic's distance and two and a half points of lane
 * discipline, because on any street a car is about to turn off, the sign of
 * that cardinal against the street is noise and cars flip which way they
 * believe they are facing every time the turn lottery runs.
 */
export function laneAt(
  lanes: Lanes,
  x: number,
  y: number,
  cos: number,
  sin: number,
): LanePoint | null {
  const e = edgeAt(lanes, x, y);
  if (e < 0) return null;
  const lo = lanes.off[e] as number;
  const hi = lanes.off[e + 1] as number;
  if (hi - lo < 2) return null;

  // Nearest point on the line. An edge is twenty-odd segments, so this is a
  // scan; ties go to the earlier segment so two hosts land on the same one.
  let bestD = Infinity;
  let bestK = lo;
  let bestT = 0;
  for (let k = lo; k + 1 < hi; k++) {
    const ax = lanes.x[k] as number;
    const ay = lanes.y[k] as number;
    const vx = (lanes.x[k + 1] as number) - ax;
    const vy = (lanes.y[k + 1] as number) - ay;
    const l2 = vx * vx + vy * vy;
    let t = l2 === 0 ? 0 : ((x - ax) * vx + (y - ay) * vy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + vx * t - x;
    const dy = ay + vy * t - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      bestK = k;
      bestT = t;
    }
  }

  const ax = lanes.x[bestK] as number;
  const ay = lanes.y[bestK] as number;
  const vx = (lanes.x[bestK + 1] as number) - ax;
  const vy = (lanes.y[bestK + 1] as number) - ay;
  const len = Math.sqrt(vx * vx + vy * vy);
  if (len === 0) return null;
  const tx = vx / len;
  const ty = vy / len;
  const dir = tx * cos + ty * sin >= 0 ? 1 : -1;

  // Across the street: positive to the RIGHT of travel, y down.
  const px = x - (ax + vx * bestT);
  const py = y - (ay + vy * bestT);
  return {
    edge: e,
    dir,
    at: (lanes.s[bestK] as number) + bestT * len,
    across: (-ty * px + tx * py) * dir,
    tangent: dAtan2(ty * dir, tx * dir),
  };
}

/**
 * A point in lane `lane` of the car's street, `ahead` px further along it.
 *
 * Walking the line rather than projecting the tangent is what makes a car
 * follow a bend instead of cutting it, and it is why this takes an arc length
 * rather than a vector: the road, not a straight guess at it.
 */
export function lanePoint(
  lanes: Lanes,
  p: LanePoint,
  ahead: number,
  lane: number,
): { x: number; y: number } {
  const [x, y, tx, ty, k] = pointAt(lanes, p.edge, p.at + ahead * p.dir);
  const roomR = lanes[p.dir > 0 ? 'halfR' : 'halfL'][k] as number;
  const roomL = lanes[p.dir > 0 ? 'halfL' : 'halfR'][k] as number;
  const offset = laneOffset(lanes.edgeLanes[p.edge] as number, roomR, roomL, lane);
  // Out into the lane: the right of a direction, with y down, is that
  // direction turned a quarter turn clockwise.
  return { x: x - ty * p.dir * offset, y: y + tx * p.dir * offset };
}

/**
 * Where a car on a street should be aiming: `ahead` px down its own lane, and
 * ON INTO THE NEXT STREET'S when that runs it past the junction at the end.
 *
 * The lane-to-lane connection, and the piece that makes a junction something
 * a car steers THROUGH rather than something it arrives at. Aiming inside
 * one's own street and stopping at its end — which is what clamping does —
 * means the pursuit point stops moving away as the car closes on the
 * junction, so the steering has nothing to swing round and the traffic bunches
 * at every mouth. Running straight on past the end instead aims across the
 * junction and out the far side, which is off the tarmac often enough to be
 * worse than either.
 *
 * So the remainder is spent on the street we are about to take, chosen the
 * same way `laneExit` chooses it: the one leaving this junction most nearly
 * the way the driver means to go, never the one we came in on.
 */
export function laneAim(
  lanes: Lanes,
  net: RoadNet | undefined,
  p: LanePoint,
  ahead: number,
  lane: number,
  wantCos: number,
  wantSin: number,
): { x: number; y: number } {
  if (net !== undefined) {
    const span = lanes.s[(lanes.off[p.edge + 1] as number) - 1] as number;
    const target = p.at + ahead * p.dir;
    if (target > span || target < 0) {
      const node = (target > span ? net.edgeB[p.edge] : net.edgeA[p.edge]) as number;
      const over = target > span ? target - span : -target;
      const out = exitAim(lanes, net, node, wantCos, wantSin, over, p.edge);
      if (out !== null) return out;
    }
  }
  return lanePoint(lanes, p, ahead, lane);
}

/**
 * A point in the kerb lane of whichever street leaves `node` most nearly the
 * way we want to go, `ahead` px along it. Null for a dead end, and `notEdge`
 * excludes the street we arrived on so a car cannot aim back down it.
 */
function exitAim(
  lanes: Lanes,
  net: RoadNet,
  node: number,
  wantCos: number,
  wantSin: number,
  ahead: number,
  notEdge: number,
): { x: number; y: number } | null {
  let bestDot = 0;
  let best = -1;
  let bestForward = true;
  for (let k = net.nodeOff[node] as number; k < (net.nodeOff[node + 1] as number); k++) {
    const e = net.nodeEdges[k] as number;
    if (e === notEdge) continue;
    const forward = (net.edgeA[e] as number) === node;
    const lo = lanes.off[e] as number;
    const hi = lanes.off[e + 1] as number;
    if (hi - lo < 2) continue;
    // The way this street leaves the junction, taken at its own end.
    const ax = lanes.x[forward ? lo : hi - 1] as number;
    const ay = lanes.y[forward ? lo : hi - 1] as number;
    const bx = lanes.x[forward ? lo + 1 : hi - 2] as number;
    const by = lanes.y[forward ? lo + 1 : hi - 2] as number;
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len === 0) continue;
    // Strictly better, so the tie-break is the lowest edge on every host.
    const dot = (vx / len) * wantCos + (vy / len) * wantSin;
    if (dot > bestDot) {
      bestDot = dot;
      best = e;
      bestForward = forward;
    }
  }
  if (best < 0) return null;

  const lo = lanes.off[best] as number;
  const hi = lanes.off[best + 1] as number;
  const span = lanes.s[hi - 1] as number;
  const at = bestForward ? ahead : span - ahead;
  const [ex, ey, etx, ety, ek] = pointAt(lanes, best, at < 0 ? 0 : at > span ? span : at);
  const dir = bestForward ? 1 : -1;
  const offset = laneOffset(
    lanes.edgeLanes[best] as number,
    lanes[dir > 0 ? 'halfR' : 'halfL'][ek] as number,
    lanes[dir > 0 ? 'halfL' : 'halfR'][ek] as number,
    0,
  );
  return { x: ex - ety * dir * offset, y: ey + etx * dir * offset };
}

/**
 * A point at distance `at` along an edge, clamped to its ends, with the
 * direction there and the nearer of the two points it lies between.
 * Returns `[x, y, tx, ty, k]`.
 */
function pointAt(
  lanes: Lanes,
  e: number,
  at: number,
): [number, number, number, number, number] {
  const lo = lanes.off[e] as number;
  const hi = lanes.off[e + 1] as number;
  let k = lo;
  while (k + 2 < hi && (lanes.s[k + 1] as number) < at) k++;
  const ax = lanes.x[k] as number;
  const ay = lanes.y[k] as number;
  const vx = (lanes.x[k + 1] as number) - ax;
  const vy = (lanes.y[k + 1] as number) - ay;
  const len = Math.sqrt(vx * vx + vy * vy) || 1;
  // Clamped at the ends. Running ON along the last segment's direction was
  // tried and drives worse — the extrapolation aims across the junction and
  // out the other side, which is off the tarmac often enough to put the
  // off-carriageway rate up by half (2.69% against 2.11%). What a car
  // approaching a junction should aim at is the lane it comes OUT into, and
  // that is `laneAim`'s job, not a straight line's.
  let t = (at - (lanes.s[k] as number)) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [ax + vx * t, ay + vy * t, vx / len, vy / len, t < 0.5 ? k : k + 1];
}
