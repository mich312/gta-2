import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bakeCity,
  buildLayout,
  encodeBakedCity,
  parseCityPlan,
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FLOOR,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  LANDMARK_KINDS,
  type BakedCity,
} from 'shared';

/**
 * `pnpm citybake` — draw the city from `shared/data/city-plan.json`, check it
 * over, and freeze it into `shared/src/world/city.data.ts`.
 *
 * This is the only thing that ever generates the map. It runs when somebody
 * edits the plan, never when somebody plays; the checks below therefore get
 * to be exhaustive rather than fast, and a city that fails them does not get
 * committed. That trade — all the validation up front, none at runtime — is
 * most of the argument for a drawn map over a rolled one.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLAN = new URL('../../../shared/data/city-plan.json', import.meta.url);
const OUT = new URL('../../../shared/src/world/city.data.ts', import.meta.url);

/**
 * Ground a car can occupy — the same rule the simulation uses (`isSolidTile`):
 * everything except walls, water and woodland. Connectivity is measured over
 * this rather than over roads alone, because a courtyard you can only reach
 * by mounting the kerb is still reachable, and the question being asked is
 * whether a player can get there.
 */
function drivable(t: number): boolean {
  return t !== T_BUILDING && t !== T_WATER && t !== T_TREES;
}

interface Problem {
  severity: 'error' | 'warning';
  message: string;
}

function check(city: BakedCity): Problem[] {
  const problems: Problem[] = [];
  const W = city.widthTiles;
  const H = city.heightTiles;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (city.tiles[y * W + x] as number);

  // 1. One road network. A borough you cannot drive to is the failure mode
  //    the old generator shipped constantly — an island of streets with the
  //    river through the only crossing — and it is the one thing a map has
  //    to get right.
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  let total = 0;
  for (let s0 = 0; s0 < city.tiles.length; s0++) {
    if (!drivable(city.tiles[s0] as number) || (label[s0] as number) >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [s0];
    label[s0] = id;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      n++;
      const x = i % W;
      const y = (i - x) / W;
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
        if ((label[j] as number) >= 0 || !drivable(city.tiles[j] as number)) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    sizes.push(n);
    total += n;
  }
  let main = 0;
  for (const [id, n] of sizes.entries()) if (n > (sizes[main] as number)) main = id;
  const reached = sizes[main] ?? 0;
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < label.length; i++) if (label[i] === main) seen[i] = 1;
  if (reached < total) {
    const orphan = total - reached;
    problems.push({
      severity: orphan > total * 0.02 ? 'error' : 'warning',
      message:
        `${orphan} of ${total} drivable tiles sit outside the main road network ` +
        `(${sizes.length} separate pieces)`,
    });
  }

  // 1b. And one STREET network on top of it. Connectivity over open ground
  //     is what a player experiences; connectivity over carriageway is what
  //     the traffic model and the route planner see, and a stranded street is
  //     a car that can never get anywhere.
  {
    const roadLabel = new Int32Array(W * H).fill(-1);
    let pieces = 0;
    let stranded = 0;
    for (let s0 = 0; s0 < city.tiles.length; s0++) {
      const t0 = city.tiles[s0] as number;
      if ((t0 !== T_ROAD && t0 !== T_BRIDGE) || (roadLabel[s0] as number) >= 0) continue;
      const id = pieces++;
      let n = 0;
      const stack = [s0];
      roadLabel[s0] = id;
      while (stack.length > 0) {
        const i = stack.pop() as number;
        n++;
        const x = i % W;
        const y = (i - x) / W;
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
          const t = city.tiles[j] as number;
          if ((roadLabel[j] as number) >= 0 || (t !== T_ROAD && t !== T_BRIDGE)) continue;
          roadLabel[j] = id;
          stack.push(j);
        }
      }
      if (id > 0) stranded += n;
    }
    if (pieces > 1) {
      problems.push({
        severity: 'error',
        message: `the street network is in ${pieces} pieces (${stranded} tiles off the main one)`,
      });
    }
  }

  // 2. Every landmark on the map, and every landmark reachable.
  for (const kind of LANDMARK_KINDS) {
    if (!city.landmarks.some((l) => l.kind === kind)) {
      problems.push({ severity: 'error', message: `no ${kind} in the city` });
    }
  }
  for (const l of city.landmarks) {
    const dx = Math.floor(l.doorX / 16);
    const dy = Math.floor(l.doorY / 16);
    let near = false;
    for (let r = 0; r <= 6 && !near; r++) {
      for (let oy = -r; oy <= r && !near; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const j = (dy + oy) * W + (dx + ox);
          if (dy + oy >= 0 && dy + oy < H && dx + ox >= 0 && dx + ox < W && seen[j] === 1) {
            near = true;
            break;
          }
        }
      }
    }
    if (!near) {
      problems.push({ severity: 'error', message: `${l.name} (${l.kind}) has no road to it` });
    }
    if (at(l.x, l.y) === T_WATER) {
      problems.push({ severity: 'error', message: `${l.name} (${l.kind}) is in the water` });
    }
  }

  // 3. Shops: every kind present, every door on a pavement, every interior
  //    walkable. A shop you cannot get into is a shop that is not there.
  for (const kind of ['gun', 'clothing', 'spray'] as const) {
    const n = city.shops.filter((s) => s.kind === kind).length;
    if (n === 0) problems.push({ severity: 'error', message: `no ${kind} shop in the city` });
  }
  for (const s of city.shops) {
    if (at(s.doorX, s.doorY) !== T_SIDEWALK) {
      problems.push({
        severity: 'error',
        message: `${s.kind} shop door at ${s.doorX},${s.doorY} is not on a pavement`,
      });
    }
    if (at(s.entryX, s.entryY) !== T_FLOOR) {
      problems.push({
        severity: 'error',
        message: `${s.kind} shop doorway at ${s.entryX},${s.entryY} is walled up`,
      });
    }
  }

  // 4. No road that simply stops in the sea without a quay to stop at.
  let drowned = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (at(x, y) !== T_ROAD) continue;
      if (at(x + 1, y) === T_WATER || at(x - 1, y) === T_WATER) drowned++;
      else if (at(x, y + 1) === T_WATER || at(x, y - 1) === T_WATER) drowned++;
    }
  }
  if (drowned > 0) {
    problems.push({ severity: 'warning', message: `${drowned} road tiles run straight into water` });
  }

  return problems;
}

/**
 * `--fit`: for every landmark the plan puts somewhere it will not go, name the
 * nearest block that would hold it.
 *
 * Placing two dozen buildings on a 768-tile island by eye means missing, and
 * the bake is right to refuse a hospital built across a street. This turns
 * that refusal into an edit you can paste back into the plan, which is the
 * difference between a strict validator and a usable one.
 */
function fit(plan: ReturnType<typeof parseCityPlan>): void {
  const layout = buildLayout(plan);
  const W = layout.widthTiles;
  const clear = (x: number, y: number, w: number, h: number): boolean => {
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= layout.heightTiles) return false;
        const t = layout.tiles[ty * W + tx] as number;
        if (t === T_ROAD || t === T_BRIDGE || t === T_WATER || t === T_BANK || t === T_SAND) {
          return false;
        }
      }
    }
    return true;
  };
  let bad = 0;
  for (const l of plan.landmarks) {
    const [lx, ly, lw, lh] = l.rect;
    if (clear(lx, ly, lw, lh)) continue;
    bad++;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const b of layout.blocks) {
      if (b.w - 2 < lw || b.h - 2 < lh) continue;
      const x = b.x + 1 + Math.floor((b.w - 2 - lw) / 2);
      const y = b.y + 1 + Math.floor((b.h - 2 - lh) / 2);
      if (!clear(x, y, lw, lh)) continue;
      const d = Math.abs(x - lx) + Math.abs(y - ly);
      if (d < bestD) {
        bestD = d;
        best = [x, y];
      }
    }
    console.log(
      `  MOVE  ${l.name.padEnd(22)} [${lx}, ${ly}, ${lw}, ${lh}] -> ` +
        (best ? `[${best[0]}, ${best[1]}, ${lw}, ${lh}]  (${bestD} tiles)` : 'NO BLOCK FITS IT'),
    );
  }
  console.log(`  ${plan.landmarks.length - bad} of ${plan.landmarks.length} landmarks already fit`);
}

function main(): void {
  const plan = parseCityPlan(JSON.parse(readFileSync(PLAN, 'utf8')));
  if (process.argv.includes('--fit')) {
    fit(plan);
    return;
  }
  const t0 = performance.now();
  const city = bakeCity(plan);
  const ms = performance.now() - t0;

  const counts = new Map<number, number>();
  for (const t of city.tiles) counts.set(t, (counts.get(t) ?? 0) + 1);
  const pct = (t: number): string =>
    `${(((counts.get(t) ?? 0) / city.tiles.length) * 100).toFixed(1)}%`;

  const land = city.tiles.length - (counts.get(T_WATER) ?? 0);
  const ofLand = (t: number): string => `${(((counts.get(t) ?? 0) / land) * 100).toFixed(1)}%`;
  console.log(`${city.name}: ${city.widthTiles}x${city.heightTiles} tiles, baked in ${ms.toFixed(0)}ms`);
  console.log(`  of dry land: road ${ofLand(T_ROAD)}  building ${ofLand(T_BUILDING)}  bare ${ofLand(0)}`);
  console.log(
    `  road ${pct(T_ROAD)}  pavement ${pct(T_SIDEWALK)}  building ${pct(T_BUILDING)}  ` +
      `lot ${pct(T_LOT)}  park ${pct(T_PARK)}  water ${pct(T_WATER)}  sand ${pct(T_SAND)}`,
  );
  console.log(
    `  ${city.blocks.length} blocks, ${city.buildings.length} buildings, ` +
      `${city.landmarks.length} landmarks, ${city.shops.length} shops`,
  );

  const problems = check(city);
  for (const p of problems) console.log(`  ${p.severity === 'error' ? 'ERROR' : 'warn '}  ${p.message}`);
  const errors = problems.filter((p) => p.severity === 'error').length;

  if (process.argv.includes('--check')) {
    if (errors > 0) process.exitCode = 1;
    return;
  }
  const encoded = encodeBakedCity(city);
  writeFileSync(
    OUT,
    `/*\n * GENERATED by \`pnpm citybake\` from shared/data/city-plan.json.\n` +
      ` * Do not edit: edit the plan and bake again.\n *\n` +
      ` * ${city.name}, ${city.widthTiles}x${city.heightTiles} tiles — ` +
      `${city.blocks.length} blocks, ${city.buildings.length} buildings,\n` +
      ` * ${city.landmarks.length} landmarks, ${city.shops.length} shops. The tile and district\n` +
      ` * planes are run-length encoded and base64'd; see world/bake.ts.\n */\n` +
      `export const CITY_DATA = ${JSON.stringify(encoded)};\n`,
  );
  console.log(`  -> ${fileURLToPath(OUT).replace(HERE, '')} (${(encoded.length / 1024).toFixed(0)} kB)`);
  if (errors > 0) process.exitCode = 1;
}

main();
