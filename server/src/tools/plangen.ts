import { writeFileSync } from 'node:fs';
import {
  bakeCity,
  deriveBevels,
  generateCityPlan,
  parseCityPlan,
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  type CityPlan,
} from 'shared';
import { checkCity } from './cityCheck.js';
import { loadPalette, render } from './mapRender.js';
import { encodePng } from './png.js';

/**
 * `pnpm plangen` — generate a city PLAN, bake it, and hold it to the same
 * checks the drawn city passes (WORLDGEN.md §17).
 *
 *   pnpm plangen [--seed=N] [--size=640] [--png=path] [--json=path]
 *   pnpm plangen --crop=90,216,90  a close-up on those tiles, scaled to read
 *   pnpm plangen --sweep=20        generate twenty cities, report what failed
 *
 * What this is NOT is a second way to ship a map. It writes a plan and a
 * picture; it does not touch `shared/data/city-plan.json` and it does not
 * write `city.data.ts`. The one city is still the drawn one, and the way a
 * generated city would become it is the way any city does: somebody looks at
 * the plan, edits it, and runs `pnpm citybake`.
 *
 * The sweep is the real deliverable. A generator that produces a good city
 * for the seed its author looked at is a drawing with extra steps; what makes
 * it a generator is the pass rate over seeds nobody has seen, measured
 * against a checker that was written before it existed.
 */

interface Args {
  seed: number;
  size: number;
  png: string;
  json: string;
  sweep: number;
  /** A close-up, in tiles: x,y,w centred on x,y. Scaled up so it reads. */
  crop: [number, number, number] | null;
}

function parseArgs(): Args {
  const out: Args = { seed: 1, size: 640, png: '', json: '', sweep: 0, crop: null };
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z]+)(?:=(.+))?$/.exec(a);
    if (!m) continue;
    const key = m[1] as string;
    const val = m[2] ?? '';
    if (key === 'seed') out.seed = Number.parseInt(val, 10);
    if (key === 'size') out.size = Number.parseInt(val, 10);
    if (key === 'png') out.png = val;
    if (key === 'json') out.json = val;
    if (key === 'sweep') out.sweep = Number.parseInt(val || '10', 10);
    if (key === 'crop') {
      const parts = val.split(',').map((v) => Number.parseInt(v, 10));
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
        throw new Error(`--crop wants x,y,w in tiles, got "${val}"`);
      }
      out.crop = parts as [number, number, number];
    }
  }
  return out;
}

/**
 * The waterfront, measured.
 *
 * What a coast is MADE of decides whether it can be smooth at all: a quay is
 * coursed masonry and stays square on purpose (WORLDGEN.md §15.2), so the
 * fraction of the waterline that bevels into a 45° line is capped by the
 * fraction of it that is beach. This is the number the shore parishes moved
 * and the number that would quietly go back if they broke, so every run
 * prints it and every sweep line carries it.
 */
interface Waterfront {
  /** Shore tiles by material, most of it first, already named. */
  made: string;
  /** Water tiles against the land, and how many of them the bevel pass cut. */
  edge: number;
  cut: number;
  beach: number;
}

function waterfront(city: ReturnType<typeof bakeCity>): Waterfront {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const bevel = deriveBevels(city.tiles, W, H);
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (city.tiles[y * W + x] as number);
  const shore = new Map<number, number>();
  let edge = 0;
  let cut = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (city.tiles[i] === T_WATER) {
        const dry =
          at(x + 1, y) !== T_WATER || at(x - 1, y) !== T_WATER ||
          at(x, y + 1) !== T_WATER || at(x, y - 1) !== T_WATER;
        if (dry) {
          edge++;
          if (bevel[i] !== 0) cut++;
        }
        continue;
      }
      const wet =
        at(x + 1, y) === T_WATER || at(x - 1, y) === T_WATER ||
        at(x, y + 1) === T_WATER || at(x, y - 1) === T_WATER;
      if (wet) shore.set(city.tiles[i] as number, (shore.get(city.tiles[i] as number) ?? 0) + 1);
    }
  }
  const nameOf: Record<number, string> = {
    [T_BANK]: 'quay',
    [T_SAND]: 'beach',
    [T_TREES]: 'cliff',
    [T_ROAD]: 'road',
    [T_BRIDGE]: 'bridge',
  };
  return {
    made: [...shore]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${nameOf[t] ?? `t${t}`} ${n}`)
      .join(', '),
    edge,
    cut,
    beach: shore.get(T_SAND) ?? 0,
  };
}

interface Outcome {
  seed: number;
  name: string;
  plan: CityPlan;
  errors: string[];
  warnings: string[];
  blocks: number;
  buildings: number;
  shops: number;
  ms: number;
  city: ReturnType<typeof bakeCity>;
  shore: Waterfront;
}

/**
 * One city, end to end: generate, ROUND-TRIP THROUGH JSON, bake, check.
 *
 * The round trip is not ceremony. `parseCityPlan` is the schema, and a
 * generator that hands `bakeCity` a TypeScript object it built in memory can
 * emit a plan that is only nearly legal — a width over `MAX_CARRIAGEWAY`, a
 * spine naming a road that is not there — and never find out until somebody
 * commits the file. Everything the checker says below is said about a plan
 * that came off disk.
 */
function run(seed: number, size: number): Outcome {
  const t0 = performance.now();
  const drafted = generateCityPlan({ seed, widthTiles: size, heightTiles: size });
  const plan = parseCityPlan(JSON.parse(JSON.stringify(drafted)));
  const city = bakeCity(plan);
  const problems = checkCity(city, plan);
  return {
    seed,
    name: plan.name,
    plan,
    errors: problems.filter((p) => p.severity === 'error').map((p) => p.message),
    warnings: problems.filter((p) => p.severity === 'warning').map((p) => p.message),
    blocks: city.blocks.length,
    buildings: city.buildings.length,
    shops: city.shops.length,
    ms: performance.now() - t0,
    city,
    shore: waterfront(city),
  };
}

function report(o: Outcome): void {
  const city = o.city;
  const counts = new Map<number, number>();
  for (const t of city.tiles) counts.set(t, (counts.get(t) ?? 0) + 1);
  const pct = (t: number): string =>
    `${(((counts.get(t) ?? 0) / city.tiles.length) * 100).toFixed(1)}%`;
  const land = city.tiles.length - (counts.get(T_WATER) ?? 0);
  const ofLand = (t: number): string => `${(((counts.get(t) ?? 0) / land) * 100).toFixed(1)}%`;

  console.log(
    `${o.name} (seed ${o.seed}): ${city.widthTiles}x${city.heightTiles} tiles in ${o.ms.toFixed(0)}ms`,
  );
  console.log(
    `  ${o.plan.districts.length - 1} boroughs, ${o.plan.roads.length} roads, ` +
      `${o.plan.landmarks.length} landmarks, ${o.blocks} blocks, ${o.buildings} buildings, ${o.shops} shops`,
  );
  console.log(`  of dry land: road ${ofLand(T_ROAD)}  building ${ofLand(T_BUILDING)}  bare ${ofLand(0)}`);
  console.log(
    `  road ${pct(T_ROAD)}  pavement ${pct(T_SIDEWALK)}  building ${pct(T_BUILDING)}  ` +
      `lot ${pct(T_LOT)}  park ${pct(T_PARK)}  water ${pct(T_WATER)}  sand ${pct(T_SAND)}`,
  );
  console.log(
    `  waterline: ${o.shore.made} — ${o.shore.cut}/${o.shore.edge} tiles bevelled ` +
      `(${((o.shore.cut / Math.max(1, o.shore.edge)) * 100).toFixed(1)}%)`,
  );

  const fabrics = new Map<string, number>();
  for (const d of o.plan.districts.slice(1)) {
    const key = d.rural ? 'rural' : d.street.pitchX === 0 ? 'park' : d.street.fabric;
    fabrics.set(key, (fabrics.get(key) ?? 0) + 1);
  }
  console.log(
    `  fabrics: ${[...fabrics].map(([k, n]) => `${k} ${n}`).join(', ')}`,
  );
  for (const w of o.warnings) console.log(`  warn   ${w}`);
  for (const e of o.errors) console.log(`  ERROR  ${e}`);
}

function main(): void {
  const args = parseArgs();

  if (args.sweep > 0) {
    let clean = 0;
    const tally = new Map<string, number>();
    for (let k = 0; k < args.sweep; k++) {
      const seed = args.seed + k;
      let o: Outcome | null = null;
      let threw = '';
      try {
        o = run(seed, args.size);
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      if (o === null) {
        console.log(`  seed ${String(seed).padEnd(5)} THREW  ${threw}`);
        // A throw and an error are the same outcome for a sweep: this seed
        // does not produce a city. Bucketed by the first clause of the
        // message so twenty seeds do not print twenty near-identical lines.
        tally.set(threw.split('—')[0] as string, (tally.get(threw.split('—')[0] as string) ?? 0) + 1);
        continue;
      }
      if (o.errors.length === 0) {
        clean++;
        console.log(
          `  seed ${String(seed).padEnd(5)} ok     ${o.name.padEnd(16)} ` +
            `${String(o.plan.districts.length - 1).padStart(2)} boroughs, ` +
            `${String(o.plan.roads.length).padStart(2)} roads, ${String(o.blocks).padStart(4)} blocks, ` +
            `${String(Math.round((o.shore.cut / Math.max(1, o.shore.edge)) * 100)).padStart(2)}% shore bevelled` +
            (o.warnings.length > 0 ? `  (${o.warnings.length} warn)` : ''),
        );
      } else {
        console.log(`  seed ${String(seed).padEnd(5)} FAIL   ${o.errors[0] as string}`);
        for (const e of o.errors) {
          const bucket = e.replace(/\d+/g, 'N');
          tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
        }
      }
    }
    console.log(`\n  ${clean}/${args.sweep} seeds pass the checker with no errors`);
    for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}x  ${k}`);
    }
    if (clean < args.sweep) process.exitCode = 1;
    return;
  }

  const o = run(args.seed, args.size);
  report(o);

  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(o.plan, null, 2)}\n`);
    console.log(`  -> ${args.json}`);
  }
  const city = o.city;
  const png =
    args.png ||
    (args.crop
      ? `plangen-seed${args.seed}-crop${args.crop[0]}-${args.crop[1]}.png`
      : `plangen-seed${args.seed}.png`);
  // A close-up gets the bevels: at two pixels a tile a half-tile cut is one
  // pixel, which is the same as not drawing it, and the shoreline is exactly
  // what a crop is usually opened to look at.
  const [cx, cy, cw] = args.crop ?? [0, 0, 0];
  const picture = render(
    {
      widthTiles: city.widthTiles,
      heightTiles: city.heightTiles,
      tiles: city.tiles,
      district: city.district,
      bevel: deriveBevels(city.tiles, city.widthTiles, city.heightTiles),
      shops: city.shops,
    },
    loadPalette(),
    args.crop ? cx - (cw >> 1) : 0,
    args.crop ? cy - (cw >> 1) : 0,
    args.crop ? cw : city.widthTiles,
    args.crop ? cw : city.heightTiles,
    args.crop ? Math.max(2, Math.min(10, Math.floor(900 / cw))) : 2,
  );
  writeFileSync(png, encodePng(picture.w, picture.h, picture.rgba));
  console.log(`  -> ${png}`);
  if (o.errors.length > 0) process.exitCode = 1;
}

main();
