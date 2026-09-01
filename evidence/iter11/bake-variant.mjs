// Bake a patched plan into a throwaway city.data.ts + plan pair that
// `mapAudit --data= --plan=` can read, so a candidate can be scored WITHOUT
// touching the committed asset.
//   node evidence/iter11/bake-variant.mjs <patch.json> <out-prefix>
// writes <out-prefix>.city.data.ts and <out-prefix>.plan.json
import { readFileSync, writeFileSync } from 'node:fs';
import { bakeCity, encodeBakedCity, parseCityPlan } from '../../shared/dist/index.js';

const src = JSON.parse(
  readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8'),
);
const patch = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (patch.maxBridgeSpan !== undefined) src.maxBridgeSpan = patch.maxBridgeSpan;
for (const [name, points] of Object.entries(patch.roads ?? {})) {
  const road = src.roads.find((r) => r.name === name);
  if (!road) throw new Error(`no road ${name}`);
  road.points = points;
}
const city = bakeCity(parseCityPlan(src));
const out = process.argv[3];
writeFileSync(`${out}.plan.json`, JSON.stringify(src, null, 2) + '\n');
writeFileSync(
  `${out}.city.data.ts`,
  `export const CITY_DATA = ${JSON.stringify(encodeBakedCity(city))};\n`,
);
console.log(`${out}: ${city.blocks.length} blocks, ${city.buildings.length} buildings`);
