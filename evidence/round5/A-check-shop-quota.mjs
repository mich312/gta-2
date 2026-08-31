// Round 5, lens A. Run from the repo root after `pnpm build`:
//   node evidence/round5/A-check-shop-quota.mjs
//
// Bakes the plan fresh and prints the shop quota, its per-kind distribution,
// and how many shops the bake hung on a LANDMARK's own stamped mass. The
// claim R5-A01 rests on is that excluding the landmark masses costs zero
// shops: 66 {gun:20, clothing:20, spray:26} either way, landmark-hosted 8
// before the fix and 0 after.
import { readFileSync } from 'node:fs';
import { bakeCity } from '../../shared/dist/world/bake.js';
import { parseCityPlan } from '../../shared/dist/world/plan.js';

const plan = parseCityPlan(JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')));
const c = bakeCity(plan);

const dist = {};
for (const s of c.shops) dist[s.kind] = (dist[s.kind] ?? 0) + 1;

let hosted = 0;
for (const s of c.shops) {
  const b = c.buildings[s.buildingIndex];
  if (!b) continue;
  if (c.landmarks.some((l) => b.x < l.x + l.w && b.x + b.w > l.x && b.y < l.y + l.h && b.y + b.h > l.y)) {
    hosted++;
    console.log(`  ${s.kind} shop at ${s.doorX},${s.doorY} is hosted by a landmark mass`);
  }
}
console.log(`fresh bake: ${c.shops.length} shops ${JSON.stringify(dist)}  landmark-hosted: ${hosted}`);
