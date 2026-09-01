// Bake a plan (optionally with JSON patches applied) and dump the tile plane
// plus the headline counts, so two bakes can be diffed tile for tile.
//   node evidence/iter11/bake-dump.mjs <out.bin> [patch.json]
// patch.json: { "maxBridgeSpan": 76, "roads": { "Coast Road": [[x,y],...] } }
import { readFileSync, writeFileSync } from 'node:fs';
import { bakeCity, parseCityPlan } from '../../shared/dist/index.js';

const src = JSON.parse(
  readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8'),
);
if (process.argv[3]) {
  const patch = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  if (patch.maxBridgeSpan !== undefined) src.maxBridgeSpan = patch.maxBridgeSpan;
  for (const [name, points] of Object.entries(patch.roads ?? {})) {
    const road = src.roads.find((r) => r.name === name);
    if (!road) throw new Error(`no road ${name}`);
    road.points = points;
  }
}
const plan = parseCityPlan(src);
const city = bakeCity(plan);
writeFileSync(process.argv[2], Buffer.from(city.tiles));
console.log(
  JSON.stringify({
    blocks: city.blocks.length,
    buildings: city.buildings.length,
    landmarks: city.landmarks.length,
    shops: city.shops.length,
  }),
);
