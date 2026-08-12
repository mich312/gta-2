import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { AT_ROOT, buildRoadNet, routeNodes, tilesToJunction } from '../src/sim/roadnet.js';
import { drivableTile, planRoute, ROUTE_SEGMENT_TILES } from '../src/sim/roadgrid.js';
import { T_BRIDGE, T_ROAD, TILE_SIZE } from '../src/world/types.js';

/**
 * The road network as a graph (WORLDGEN.md §40).
 *
 * Routing used to search the hundred thousand tiles the streets are painted
 * on; it searches a thousand junctions now. The invariants that matter are
 * that the graph covers every road, that it agrees with the tiles about what
 * connects to what, and that the paths it hands a driver are drivable — the
 * three ways a graph laid over a raster silently stops describing it.
 */
describe('the road network', () => {
  const map = generateCity(66, parseWorldgenParams(worldgenJson));
  const net = map.roadNet!;
  const W = map.widthTiles;
  const H = map.heightTiles;
  const N = W * H;
  const isRoad = (i: number): boolean => map.tiles[i] === T_ROAD || map.tiles[i] === T_BRIDGE;

  it('covers every drivable tile in the city', () => {
    // Not a quota — a property. Every piece of carriageway belongs to some
    // junction, so there is nowhere a car can be that routing cannot start
    // from. (The courses cover four fifths, which is why the graph is not
    // built from them; see the module header.)
    let drivable = 0;
    let orphan = 0;
    for (let i = 0; i < N; i++) {
      if (!isRoad(i)) continue;
      drivable++;
      if ((net.owner[i] as number) < 0) orphan++;
    }
    expect(drivable).toBeGreaterThan(50_000);
    expect(orphan).toBe(0);
  });

  it('gets every tile home along the tree, one step at a time', () => {
    // The first and last leg of every route is this walk, so it has to be a
    // real path over real road and it has to terminate. A cycle here would
    // hang the sim.
    for (let i = 0; i < N; i += 37) {
      if (!isRoad(i) || (net.owner[i] as number) < 0) continue;
      const walk = tilesToJunction(net, i);
      expect(walk.length).toBeLessThan(N);
      expect(net.fromDir[walk[walk.length - 1] as number]).toBe(AT_ROOT);
      for (let k = 0; k < walk.length; k++) {
        const t = walk[k] as number;
        expect(isRoad(t)).toBe(true);
        expect(net.owner[t]).toBe(net.owner[i]);
        if (k === 0) continue;
        const p = walk[k - 1] as number;
        const step = Math.abs((t % W) - (p % W)) + Math.abs(Math.floor(t / W) - Math.floor(p / W));
        expect(step).toBe(1);
      }
    }
  });

  it('joins its nodes with paths a car could actually drive', () => {
    for (let e = 0; e < net.edgeA.length; e++) {
      const lo = net.pathOff[e] as number;
      const hi = net.pathOff[e + 1] as number;
      expect(hi).toBeGreaterThan(lo);
      expect(net.owner[net.pathTiles[lo] as number]).toBe(net.edgeA[e]);
      expect(net.owner[net.pathTiles[hi - 1] as number]).toBe(net.edgeB[e]);
      for (let k = lo; k < hi; k++) {
        const t = net.pathTiles[k] as number;
        expect(isRoad(t)).toBe(true);
        if (k === lo) continue;
        const p = net.pathTiles[k - 1] as number;
        const step = Math.abs((t % W) - (p % W)) + Math.abs(Math.floor(t / W) - Math.floor(p / W));
        expect(step).toBe(1);
      }
    }
  });

  it('agrees with the tiles about what connects to what', () => {
    // The load-bearing one. Flood the drivable tiles for their true connected
    // components, flood the graph for its own, and assert the two partitions
    // are the same — so the graph can never claim a route the roads do not
    // have, nor deny one they do.
    const comp = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    let components = 0;
    for (let seed = 0; seed < N; seed++) {
      if (!isRoad(seed) || comp[seed] >= 0) continue;
      const c = components++;
      let sp = 0;
      stack[sp++] = seed;
      comp[seed] = c;
      while (sp > 0) {
        const i = stack[--sp] as number;
        const x = i % W;
        const y = (i - x) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!isRoad(j) || comp[j] >= 0) continue;
          comp[j] = c;
          stack[sp++] = j;
        }
      }
    }

    // Graph components, by flooding the adjacency.
    const nodes = net.nodeX.length;
    const nComp = new Int32Array(nodes).fill(-1);
    let nCount = 0;
    for (let s = 0; s < nodes; s++) {
      if (nComp[s] >= 0) continue;
      const c = nCount++;
      const bag = [s];
      nComp[s] = c;
      for (let q = 0; q < bag.length; q++) {
        const n = bag[q] as number;
        for (let k = net.nodeOff[n] as number; k < (net.nodeOff[n + 1] as number); k++) {
          const e = net.nodeEdges[k] as number;
          const o = (net.edgeA[e] as number) === n ? (net.edgeB[e] as number) : (net.edgeA[e] as number);
          if (nComp[o] >= 0) continue;
          nComp[o] = c;
          bag.push(o);
        }
      }
    }

    // Every tile component maps onto exactly one graph component, and vice
    // versa: one junction per tile component decides it, and every other tile
    // in that component must agree.
    const decided = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      if (!isRoad(i)) continue;
      const gc = nComp[net.owner[i] as number] as number;
      const tc = comp[i] as number;
      const held = decided.get(tc);
      if (held === undefined) decided.set(tc, gc);
      else expect(gc).toBe(held);
    }
    expect(decided.size).toBe(components);
    // and no two tile components share a graph component
    expect(new Set(decided.values()).size).toBe(components);
  });

  it('routes only over carriageway, in steps a driver can follow', () => {
    let h = 7;
    const rnd = (): number => {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      return h / 0x7fffffff;
    };
    const spots: Array<{ x: number; y: number }> = [];
    while (spots.length < 120) {
      const tx = Math.floor(rnd() * W);
      const ty = Math.floor(rnd() * H);
      if (drivableTile(map, tx, ty)) spots.push({ x: tx * 16 + 8, y: ty * 16 + 8 });
    }
    let routed = 0;
    for (let i = 0; i + 1 < spots.length; i += 2) {
      const a = spots[i] as { x: number; y: number };
      const b = spots[i + 1] as { x: number; y: number };
      const r = planRoute(map, a.x, a.y, b.x, b.y);
      if (r === null) continue;
      routed++;
      expect(r.length).toBeGreaterThan(0);
      let px = a.x;
      let py = a.y;
      for (let k = 0; k < r.length; k += 2) {
        const x = r[k] as number;
        const y = r[k + 1] as number;
        expect(drivableTile(map, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))).toBe(true);
        // The follower calls itself lost past eight tiles from its corner, so
        // no two corners may be further apart than that.
        expect(Math.abs(x - px) + Math.abs(y - py)).toBeLessThanOrEqual(ROUTE_SEGMENT_TILES * TILE_SIZE);
        px = x;
        py = y;
      }
      // It ends where it was sent, near enough to be the same street.
      const ex = r[r.length - 2] as number;
      const ey = r[r.length - 1] as number;
      expect(Math.hypot(ex - b.x, ey - b.y)).toBeLessThan(4 * TILE_SIZE);
    }
    expect(routed).toBeGreaterThan(40);
  });

  it('is a pure function of the map: rebuilding changes nothing', () => {
    const again = buildRoadNet(map);
    expect(Array.from(again.edgeA)).toEqual(Array.from(net.edgeA));
    expect(Array.from(again.edgeB)).toEqual(Array.from(net.edgeB));
    expect(Array.from(again.edgeCost)).toEqual(Array.from(net.edgeCost));
    expect(Array.from(again.pathTiles)).toEqual(Array.from(net.pathTiles));
    expect(Array.from(again.owner)).toEqual(Array.from(net.owner));
    expect(Array.from(again.fromDir)).toEqual(Array.from(net.fromDir));
  });

  it('answers a search over a thousand nodes, not a hundred thousand tiles', () => {
    expect(net.nodeX.length).toBeLessThan(5000);
    expect(net.edgeA.length).toBeLessThan(10_000);
    // Same node both ends is the empty path, not a null.
    expect(routeNodes(net, 3, 3)).toEqual([]);
    // Every node the search reaches comes back as a run of joined edges.
    const path = routeNodes(net, 0, net.nodeX.length - 1);
    if (path !== null) {
      let at = 0;
      for (const e of path) {
        expect((net.edgeA[e] as number) === at || (net.edgeB[e] as number) === at).toBe(true);
        at = (net.edgeA[e] as number) === at ? (net.edgeB[e] as number) : (net.edgeA[e] as number);
      }
      expect(at).toBe(net.nodeX.length - 1);
    }
  });
});
