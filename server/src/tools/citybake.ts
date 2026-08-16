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
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_WATER,
} from 'shared';
import { checkCity } from './cityCheck.js';

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
    // Plazas WANT streets through their footprint (bake.ts OPEN_TO_ROAD):
    // "there is a road on this square" is the point, not a misfit, and the
    // rect-must-be-clear test below would exile every one of them to a
    // field. Their real constraints (no water, monument in the median) are
    // the bake's errors, checked there.
    if (l.kind === 'square' || l.kind === 'green' || l.kind === 'circus') continue;
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

  const problems = checkCity(city, plan);
  for (const p of problems) console.log(`  ${p.severity === 'error' ? 'ERROR' : 'warn '}  ${p.message}`);
  const errors = problems.filter((p) => p.severity === 'error').length;

  if (process.argv.includes('--check')) {
    if (errors > 0) process.exitCode = 1;
    return;
  }
  // The write comes AFTER the verdict. This file's whole argument is "a city
  // that fails the checks does not get committed" — which was a lie while the
  // asset was written first and the exit code set second: a failing bake
  // overwrote `city.data.ts` and left the error scroll as the only witness.
  if (errors > 0) {
    console.log(`  ${errors} error(s): ${fileURLToPath(OUT).replace(HERE, '')} left untouched`);
    process.exitCode = 1;
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
