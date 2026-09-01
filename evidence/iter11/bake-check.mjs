// Run the real checker over a patched plan, without touching the asset.
//   node evidence/iter11/bake-check.mjs [patch.json]
import { readFileSync } from 'node:fs';
import { bakeCity, parseCityPlan } from '../../shared/dist/index.js';
import { checkCity } from '../../server/dist/tools/cityCheck.js';

const src = JSON.parse(
  readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8'),
);
if (process.argv[2]) {
  const patch = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (patch.maxBridgeSpan !== undefined) src.maxBridgeSpan = patch.maxBridgeSpan;
  for (const [name, points] of Object.entries(patch.roads ?? {})) {
    const road = src.roads.find((r) => r.name === name);
    if (!road) throw new Error(`no road ${name}`);
    road.points = points;
  }
}
const plan = parseCityPlan(src);
const city = bakeCity(plan);
console.log(`${city.blocks.length} blocks, ${city.buildings.length} buildings`);
for (const p of checkCity(city, plan)) {
  console.log(`  ${p.severity === 'error' ? 'ERROR' : 'warn '}  ${p.message}`);
}
