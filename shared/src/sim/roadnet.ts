import { T_BRIDGE, T_ROAD, TILE_SIZE, type CityMap } from '../world/types.js';

/**
 * The road network as a graph (WORLDGEN.md §40).
 *
 * §9.2's L2 asked for roads to stop being paint that every consumer
 * reverse-engineers, and to become typed nodes and typed edges. This is that,
 * at the level routing needs it: **junctions are nodes, the streets between
 * them are edges**, and finding a way across the city is a search over about
 * a thousand of them instead of over the hundred thousand tiles they are
 * drawn on.
 *
 * **Why this one is built from the tiles, when §25 says a boundary must not
 * be.** That rule is about GEOMETRY: a curve traced out of a raster can never
 * be better than the staircase it started from, which is why the coast is
 * extracted from its field and the water tiles are its rasterisation.
 * Topology is not damaged by rasterisation. A junction is a junction whatever
 * it is drawn on, and which junction connects to which is exactly as true in
 * the bytes as in the drawing.
 *
 * That distinction is what lets routing move now rather than waiting for
 * VECTOR phase 2. §26.1 declined to retire the per-tile marking system on a
 * number — courses cover 76.1% of carriageway tiles — and the same number
 * blocks a graph built from them: measured from the other direction, a fifth
 * of drivable tiles sit more than three tiles from any centreline, so a
 * course graph would leave a fifth of the city unroutable. The tiles cover
 * all of it. What they cannot supply is where an edge RUNS — the paths here
 * are chains of tile centres, staircase and all — and marrying them to the
 * courses is exactly the work §26.1 wants doing once, deliberately, when
 * coverage is raised.
 *
 * **How it is built: one flood, not a thousand.** Every junction tile seeds a
 * multi-source breadth-first search at distance zero, and the wave spreads
 * over the carriageway between them. Each tile ends up owned by the junction
 * nearest it along the road, with a parent pointing back the way the wave
 * came — so every tile in the city already knows its route to its own
 * junction, and no search is needed for the first or last leg of anything.
 * Where two owners meet, the junctions they belong to have a street between
 * them, and its length is what the two waves had travelled. One pass over the
 * drivable tiles builds every node, every edge and every path.
 *
 * Deterministic by construction: the seed order is tile order, the four
 * neighbours are visited in a fixed order, and a queue is a queue. No rng, no
 * floats in the topology, and both hosts build the identical graph from the
 * identical tiles — so, like `junctions` and `shoreIndex`, it never goes on
 * the wire.
 */

/** Cardinal steps, in the fixed order the flood visits them. */
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export interface RoadNet {
  widthTiles: number;
  /** Junction centroids in world px, one per node. */
  nodeX: Float64Array;
  nodeY: Float64Array;
  /** Edges leaving node i are `nodeEdges[nodeOff[i] .. nodeOff[i + 1])`. */
  nodeOff: Int32Array;
  nodeEdges: Int32Array;
  /** The two nodes each edge joins, and its length in tiles. */
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeCost: Int32Array;
  /** Tile indices along each edge, A to B: `pathTiles[pathOff[e] .. pathOff[e+1])`. */
  pathOff: Int32Array;
  pathTiles: Int32Array;
  /**
   * Which node owns each tile, and which way the flood came in — the tree
   * that makes "get me from here to my junction" a walk rather than a search.
   * -1 on anything not drivable, and on carriageway no junction reaches (an
   * islet's lane with no intersection on it anywhere).
   *
   * `fromDir` is an index into `STEPS` rather than the parent tile, and
   * `depth` is not kept at all: three `Int32` planes over a 768-square city
   * is seven megabytes of session memory to say what a byte and a short can
   * hold, and this is a per-session structure on every client.
   */
  owner: Int16Array;
  fromDir: Uint8Array;
}

/** `fromDir` for a junction tile: the walk home ends here. */
export const AT_ROOT = 255;

/** Walk the flood tree from a tile out to its own junction. */
export function tilesToJunction(net: RoadNet, tile: number): number[] {
  const out: number[] = [];
  for (let k = tile; ; ) {
    out.push(k);
    const d = net.fromDir[k] as number;
    if (d === AT_ROOT) break;
    const [dx, dy] = STEPS[d] as readonly [number, number];
    k -= dy * net.widthTiles + dx;
  }
  return out;
}

/** Drivable by a car: road, and the bridges that carry it. */
function drivable(map: CityMap, i: number): boolean {
  const t = map.tiles[i] as number;
  return t === T_ROAD || t === T_BRIDGE;
}

/**
 * Build the graph. One flood over the carriageway, then the edges its
 * collisions imply.
 */
export function buildRoadNet(map: CityMap): RoadNet {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const N = W * H;
  const idOf = map.junctions.idOf;
  const nodes = map.junctions.count;

  const owner = new Int16Array(N).fill(-1);
  const fromDir = new Uint8Array(N).fill(AT_ROOT);
  // Only the build needs how far each tile is from its junction — it is what
  // an edge's length is made of — so it stays here rather than in the graph.
  const depth = new Int32Array(N).fill(-1);

  // Seeds: every junction tile, at distance zero from its own junction.
  // Tile order, so the queue is the same on every host.
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  const sumX = new Float64Array(nodes);
  const sumY = new Float64Array(nodes);
  const count = new Int32Array(nodes);
  for (let i = 0; i < N; i++) {
    const j = idOf[i] as number;
    if (j < 0 || !drivable(map, i)) continue;
    owner[i] = j;
    depth[i] = 0;
    queue[tail++] = i;
    const x = i % W;
    sumX[j] = (sumX[j] as number) + x;
    sumY[j] = (sumY[j] as number) + (i - x) / W;
    count[j] = (count[j] as number) + 1;
  }

  // Where two floods meet there is a street between their junctions. Keyed on
  // the ordered pair so the two directions collapse into one edge; the
  // cheapest meeting wins, and ties go to the lower tile so the choice does
  // not depend on which side the wave arrived from first.
  const best = new Map<number, { cost: number; u: number; v: number }>();
  const consider = (u: number, v: number): void => {
    const a = owner[u] as number;
    const b = owner[v] as number;
    if (a === b) return;
    const cost = (depth[u] as number) + (depth[v] as number) + 1;
    const key = a < b ? a * nodes + b : b * nodes + a;
    const held = best.get(key);
    if (held !== undefined && (held.cost < cost || (held.cost === cost && held.u <= u))) return;
    best.set(key, a < b ? { cost, u, v } : { cost, u: v, v: u });
  };

  while (head < tail) {
    const i = queue[head++] as number;
    const x = i % W;
    const y = (i - x) / W;
    for (let d = 0; d < STEPS.length; d++) {
      const [dx, dy] = STEPS[d] as readonly [number, number];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!drivable(map, j)) continue;
      if ((owner[j] as number) === -1) {
        // Junction tiles are all seeded, so anything the wave claims is a run
        // tile and belongs to the junction whose wave got there first.
        owner[j] = owner[i] as number;
        fromDir[j] = d;
        depth[j] = (depth[i] as number) + 1;
        queue[tail++] = j;
      } else {
        consider(i, j);
      }
    }
  }

  const edges = [...best.values()];
  const m = edges.length;
  const edgeA = new Int32Array(m);
  const edgeB = new Int32Array(m);
  const edgeCost = new Int32Array(m);
  const pathOff = new Int32Array(m + 1);
  const paths: number[][] = [];
  const toRoot = (t: number): number[] => {
    const out: number[] = [];
    for (let k = t; ; ) {
      out.push(k);
      const d = fromDir[k] as number;
      if (d === AT_ROOT) break;
      const [dx, dy] = STEPS[d] as readonly [number, number];
      k -= dy * W + dx;
    }
    return out;
  };
  for (let e = 0; e < m; e++) {
    const { cost, u, v } = edges[e] as { cost: number; u: number; v: number };
    edgeA[e] = owner[u] as number;
    edgeB[e] = owner[v] as number;
    edgeCost[e] = cost;
    // A to the meeting, then across it and out to B: the two halves of the
    // tree walk, spliced at the tiles where the waves touched.
    const path = toRoot(u).reverse();
    for (const t of toRoot(v)) path.push(t);
    paths.push(path);
    pathOff[e + 1] = (pathOff[e] as number) + path.length;
  }
  const pathTiles = new Int32Array(pathOff[m] as number);
  for (let e = 0, at = 0; e < m; e++) for (const t of paths[e] as number[]) pathTiles[at++] = t;

  // Adjacency, CSR, both directions.
  const nodeOff = new Int32Array(nodes + 1);
  for (let e = 0; e < m; e++) {
    nodeOff[(edgeA[e] as number) + 1] = (nodeOff[(edgeA[e] as number) + 1] as number) + 1;
    nodeOff[(edgeB[e] as number) + 1] = (nodeOff[(edgeB[e] as number) + 1] as number) + 1;
  }
  for (let i = 0; i < nodes; i++) nodeOff[i + 1] = (nodeOff[i + 1] as number) + (nodeOff[i] as number);
  const nodeEdges = new Int32Array(2 * m);
  const at = new Int32Array(nodes);
  for (let e = 0; e < m; e++) {
    for (const n of [edgeA[e] as number, edgeB[e] as number]) {
      nodeEdges[(nodeOff[n] as number) + (at[n] as number)] = e;
      at[n] = (at[n] as number) + 1;
    }
  }

  const nodeX = new Float64Array(nodes);
  const nodeY = new Float64Array(nodes);
  for (let j = 0; j < nodes; j++) {
    const c = (count[j] as number) || 1;
    nodeX[j] = ((sumX[j] as number) / c + 0.5) * TILE_SIZE;
    nodeY[j] = ((sumY[j] as number) / c + 0.5) * TILE_SIZE;
  }

  return {
    widthTiles: W,
    nodeX,
    nodeY,
    nodeOff,
    nodeEdges,
    edgeA,
    edgeB,
    edgeCost,
    pathOff,
    pathTiles,
    owner,
    fromDir,
  };
}

/**
 * A* over the junction graph. Returns the edges to traverse, in order, or
 * null when no street connects the two.
 *
 * The same determinism trick the tile search used: the open list is a binary
 * heap keyed on `f * nodes + node` packed into one integer, so ties in `f`
 * always resolve to the lower node on every host. Costs are whole tiles, so
 * the packing is exact — a thousand nodes and a city-wide route of a few
 * thousand tiles leaves the product six orders of magnitude inside the range
 * an integer double holds.
 */
export function routeNodes(net: RoadNet, from: number, to: number): number[] | null {
  const nodes = net.nodeX.length;
  if (from === to) return [];
  const g = new Int32Array(nodes).fill(-1);
  const cameEdge = new Int32Array(nodes).fill(-1);
  const done = new Uint8Array(nodes);
  const heuristic = (n: number): number =>
    Math.floor(
      (Math.abs((net.nodeX[n] as number) - (net.nodeX[to] as number)) +
        Math.abs((net.nodeY[n] as number) - (net.nodeY[to] as number))) /
        TILE_SIZE,
    );

  const heap: number[] = [];
  const push = (key: number): void => {
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p] as number) <= (heap[i] as number)) break;
      const t = heap[p] as number;
      heap[p] = heap[i] as number;
      heap[i] = t;
      i = p;
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
        let s = i;
        if (l < heap.length && (heap[l] as number) < (heap[s] as number)) s = l;
        if (r < heap.length && (heap[r] as number) < (heap[s] as number)) s = r;
        if (s === i) break;
        const t = heap[s] as number;
        heap[s] = heap[i] as number;
        heap[i] = t;
        i = s;
      }
    }
    return top;
  };

  g[from] = 0;
  push(heuristic(from) * nodes + from);
  let found = false;
  while (heap.length > 0) {
    const n = pop() % nodes;
    if (done[n] === 1) continue;
    done[n] = 1;
    if (n === to) {
      found = true;
      break;
    }
    for (let k = net.nodeOff[n] as number; k < (net.nodeOff[n + 1] as number); k++) {
      const e = net.nodeEdges[k] as number;
      const other = (net.edgeA[e] as number) === n ? (net.edgeB[e] as number) : (net.edgeA[e] as number);
      if (done[other] === 1) continue;
      const ng = (g[n] as number) + (net.edgeCost[e] as number);
      const known = g[other] as number;
      if (known !== -1 && known <= ng) continue;
      g[other] = ng;
      cameEdge[other] = e;
      push((ng + heuristic(other)) * nodes + other);
    }
  }
  if (!found) return null;

  const out: number[] = [];
  for (let n = to; n !== from; ) {
    const e = cameEdge[n] as number;
    out.push(e);
    n = (net.edgeA[e] as number) === n ? (net.edgeB[e] as number) : (net.edgeA[e] as number);
  }
  out.reverse();
  return out;
}
