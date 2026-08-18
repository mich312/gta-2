import { readFileSync } from 'node:fs';
import {
  generateCity,
  parseCityPlan,
  pointInPoly,
  T_BRIDGE,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_TREES,
  T_WATER,
  type CityMap,
} from 'shared';
import { loadWorldgenParams } from '../tuning.js';

/**
 * `pnpm mapaudit` — the numbers a map review argues from, in one command.
 *
 * Every figure here was measured at least once during `REVIEW-MAPDESIGN.md`
 * and its fixes by a script written for the occasion and thrown away, which is
 * exactly how §47.2's surprise stayed hidden for an hour: the four citywide
 * pins live in three test files and a tool, so "did that change move anything
 * else" was a question nobody could ask cheaply. It is one command now.
 *
 * It measures; it never fails. `citybake --check` is the thing with a verdict
 * and `vitest` is the thing with pins — this is the instrument you read before
 * and after a change, and the report is meant to be diffed.
 */

interface Audit {
  /** The four citywide pins, with the bar each is held to. */
  emptyBlocks: number;
  mergedTarmac: number;
  longCourses: number;
  angleCutShare: number;
  /** Crossings, and how the map hangs together. */
  deckEdges: number;
  decks: Array<{ tiles: number; x: number; y: number }>;
  detourP50: number;
  detourP90: number;
  detourWorst: { a: string; b: string; straight: number; drive: number };
  /** Ground doing no work. */
  barePct: number;
  barePatches: Array<{ tiles: number; x: number; y: number }>;
  /** Territory. */
  turfLand: Array<{ gang: number; land: number }>;
  turfSpread: number;
}

function carriageway(t: number): boolean {
  return t === T_ROAD || t === T_BRIDGE;
}

/** Blocks with a street through them, ground to build on, and nothing built. */
function emptyBlocks(map: CityMap): number {
  const W = map.widthTiles;
  let empty = 0;
  for (const b of map.blocks) {
    if (b.district === 'park') continue;
    let road = 0;
    let buildable = 0;
    for (let y = b.y + 1; y < b.y + b.h - 1; y++) {
      for (let x = b.x + 1; x < b.x + b.w - 1; x++) {
        const t = map.tiles[y * W + x] as number;
        if (carriageway(t)) road++;
        if (t === T_LOT || t === T_PARK || t === T_FIELD) buildable++;
      }
    }
    if (road === 0 || buildable < 20) continue;
    const built = map.buildings.some(
      (bd) => bd.x < b.x + b.w && bd.x + bd.w > b.x && bd.y < b.y + b.h && bd.y + bd.h > b.y,
    );
    if (!built) empty++;
  }
  return empty;
}

/** Tarmac so wide in both axes that a 7x7 box lands entirely on it. */
function mergedTarmac(map: CityMap): number {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const cw = (x: number, y: number): boolean => carriageway(map.tiles[y * W + x] as number);
  let merged = 0;
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      if (!cw(x, y)) continue;
      let all = true;
      for (let dy = -3; dy <= 3 && all; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (!cw(x + dx, y + dy)) {
            all = false;
            break;
          }
        }
      }
      if (all) merged++;
    }
  }
  return merged;
}

/** Eight-connected components of one tile type, biggest first. */
function patches(
  map: CityMap,
  keep: (t: number) => boolean,
  least: number,
): Array<{ tiles: number; x: number; y: number }> {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const seen = new Uint8Array(W * H);
  const out: Array<{ tiles: number; x: number; y: number }> = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] === 1 || !keep(map.tiles[s] as number)) continue;
    seen[s] = 1;
    stack.push(s);
    let n = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      n++;
      const x = i % W;
      const y = (i - x) / W;
      sx += x;
      sy += y;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] === 1 || !keep(map.tiles[j] as number)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (n >= least) out.push({ tiles: n, x: Math.round(sx / n), y: Math.round(sy / n) });
  }
  out.sort((a, b) => b.tiles - a.tiles);
  return out;
}

/** Shortest drive between every pair of named places, over the road graph. */
function detours(
  map: CityMap,
  plan: ReturnType<typeof parseCityPlan>,
): Pick<Audit, 'detourP50' | 'detourP90' | 'detourWorst'> {
  const net = map.roadNet;
  const places = plan.landmarks
    .filter((l) => !l.byAir)
    .map((l) => ({ name: l.name, x: l.rect[0] + l.rect[2] / 2, y: l.rect[1] + l.rect[3] / 2 }));
  if (!net || places.length < 2) {
    return { detourP50: 0, detourP90: 0, detourWorst: { a: '', b: '', straight: 0, drive: 0 } };
  }
  const nearest = (x: number, y: number): number => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < net.nodeX.length; i++) {
      const d = Math.hypot((net.nodeX[i] as number) / 16 - x, (net.nodeY[i] as number) / 16 - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const dijkstra = (src: number): Float64Array => {
    const n = net.nodeX.length;
    const dist = new Float64Array(n).fill(Infinity);
    dist[src] = 0;
    const q: Array<[number, number]> = [[0, src]];
    while (q.length > 0) {
      q.sort((a, b) => a[0] - b[0]);
      const [d, u] = q.shift() as [number, number];
      if (d > (dist[u] as number)) continue;
      for (let k = net.nodeOff[u] as number; k < (net.nodeOff[u + 1] as number); k++) {
        const e = net.nodeEdges[k] as number;
        const v = net.edgeA[e] === u ? (net.edgeB[e] as number) : (net.edgeA[e] as number);
        const nd = d + (net.edgeCost[e] as number);
        if (nd < (dist[v] as number)) {
          dist[v] = nd;
          q.push([nd, v]);
        }
      }
    }
    return dist;
  };
  const nodes = places.map((p) => nearest(p.x, p.y));
  const ratios: number[] = [];
  let worst = { a: '', b: '', straight: 0, drive: 0 };
  for (const [i, p] of places.entries()) {
    const dist = dijkstra(nodes[i] as number);
    for (const [j, q] of places.entries()) {
      if (j <= i) continue;
      const straight = Math.hypot(p.x - q.x, p.y - q.y);
      const drive = dist[nodes[j] as number] as number;
      // Under 40 tiles apart the ratio is noise: the graph snaps to junctions.
      if (straight < 40 || !Number.isFinite(drive)) continue;
      ratios.push(drive / straight);
      if (drive / straight > (worst.drive || 0) / (worst.straight || 1)) {
        worst = { a: p.name, b: q.name, straight, drive };
      }
    }
  }
  ratios.sort((a, b) => a - b);
  return {
    detourP50: ratios[ratios.length >> 1] ?? 0,
    detourP90: ratios[Math.floor(ratios.length * 0.9)] ?? 0,
    detourWorst: worst,
  };
}

export function auditCity(map: CityMap, plan: ReturnType<typeof parseCityPlan>): Audit {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const net = map.roadNet;

  let deckEdges = 0;
  if (net) {
    for (let e = 0; e < net.edgeA.length; e++) {
      for (let k = net.pathOff[e] as number; k < (net.pathOff[e + 1] as number); k++) {
        if (map.tiles[net.pathTiles[k] as number] === T_BRIDGE) {
          deckEdges++;
          break;
        }
      }
    }
  }

  let dry = 0;
  let bare = 0;
  for (let i = 0; i < W * H; i++) {
    const t = map.tiles[i] as number;
    if (t === T_WATER) continue;
    dry++;
    if (t === T_FIELD || t === T_TREES) bare++;
  }

  const turf = new Map<number, number>();
  if (map.turfCellsWide > 0) {
    const cell = map.turfCellTiles;
    const cw = map.turfCellsWide;
    for (let i = 0; i < map.turfCells.length; i++) {
      const g = map.turfCells[i] as number;
      if (g === 0) continue;
      const cx = i % cw;
      const cy = (i - cx) / cw;
      let land = 0;
      for (let y = cy * cell; y < Math.min(H, (cy + 1) * cell); y++) {
        for (let x = cx * cell; x < Math.min(W, (cx + 1) * cell); x++) {
          if (map.tiles[y * W + x] !== T_WATER) land++;
        }
      }
      turf.set(g, (turf.get(g) ?? 0) + land);
    }
  }
  const turfLand = [...turf].map(([gang, land]) => ({ gang, land })).sort((a, b) => a.gang - b.gang);
  const acres = turfLand.map((g) => g.land);

  const cut = map.buildings.filter((b) => b.angle !== undefined && b.angle !== 0).length;

  return {
    emptyBlocks: emptyBlocks(map),
    mergedTarmac: mergedTarmac(map),
    longCourses: (map.courses ?? []).filter((c) => {
      let len = 0;
      for (let i = 1; i < c.points.length; i++) {
        const a = c.points[i - 1] as readonly [number, number];
        const b = c.points[i] as readonly [number, number];
        len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      return len >= 100;
    }).length,
    angleCutShare: map.buildings.length > 0 ? cut / map.buildings.length : 0,
    deckEdges,
    decks: patches(map, (t) => t === T_BRIDGE, 20),
    ...detours(map, plan),
    barePct: dry > 0 ? bare / dry : 0,
    barePatches: patches(map, (t) => t === T_FIELD || t === T_TREES, 900).slice(0, 6),
    turfLand,
    turfSpread: acres.length > 0 ? Math.max(...acres) / Math.min(...acres) : 0,
  };
}

/** A line per figure, with the bar beside it, so two runs diff usefully. */
function report(a: Audit): void {
  const bar = (ok: boolean): string => (ok ? 'ok  ' : 'OVER');
  console.log('the four pins');
  console.log(`  ${bar(a.emptyBlocks <= 3)} empty blocks        ${a.emptyBlocks}  (pin <= 3)`);
  console.log(`  ${bar(a.mergedTarmac <= 230)} merged tarmac       ${a.mergedTarmac}  (pin <= 230)`);
  console.log(`  ${bar(a.longCourses >= 90)} long courses        ${a.longCourses}  (pin >= 90)`);
  console.log(
    `  ${bar(a.angleCutShare > 0.4)} buildings cut at an angle  ${(a.angleCutShare * 100).toFixed(1)}%  (pin > 40%)`,
  );

  console.log('\ncrossings');
  console.log(`       road-net edges over a deck  ${a.deckEdges}`);
  for (const d of a.decks) console.log(`       deck ${String(d.tiles).padStart(4)} tiles at ${d.x},${d.y}`);

  console.log('\nhow far things are, landmark to landmark');
  console.log(`  ${bar(a.detourP90 <= 2)} detour p50 x${a.detourP50.toFixed(2)}  p90 x${a.detourP90.toFixed(2)}  (pin p90 <= 2.00)`);
  console.log(
    `       worst: ${a.detourWorst.a} -> ${a.detourWorst.b}, straight ${a.detourWorst.straight.toFixed(0)}, drive ${a.detourWorst.drive.toFixed(0)} (x${(a.detourWorst.drive / a.detourWorst.straight).toFixed(2)})`,
  );

  console.log('\nground doing no work');
  console.log(`       bare ${(a.barePct * 100).toFixed(1)}% of dry land`);
  for (const p of a.barePatches) console.log(`       ${String(p.tiles).padStart(5)} tiles centred ${p.x},${p.y}`);

  console.log('\nterritory');
  console.log(
    `       land per gang ${a.turfLand.map((g) => `${g.gang}:${g.land}`).join(' ')}  spread x${a.turfSpread.toFixed(2)}`,
  );
}

function main(): void {
  const seed = Number.parseInt(
    process.argv.find((a) => a.startsWith('--seed='))?.slice(7) ?? '1',
    10,
  );
  const plan = parseCityPlan(
    JSON.parse(readFileSync(new URL('../../../shared/data/city-plan.json', import.meta.url), 'utf8')),
  );
  const map = generateCity(seed, loadWorldgenParams());
  console.log(`${map.name}, seed ${seed}: ${map.blocks.length} blocks, ${map.buildings.length} buildings\n`);
  report(auditCity(map, plan));
}

main();
