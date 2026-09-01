// Score a candidate plan patch against everything that has to stay true:
// the checker, the suite's merged-tarmac ceiling, and the block/building
// counts. Bakes in memory; touches nothing.
//   node evidence/iter11/score-candidate.mjs <patch.json>
import { readFileSync } from 'node:fs';
import { bakeCity, parseCityPlan, T_ROAD, T_BRIDGE } from '../../shared/dist/index.js';
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
const W = city.widthTiles;
const H = city.heightTiles;
const cw = (x, y) => {
  const t = city.tiles[y * W + x];
  return t === T_ROAD || t === T_BRIDGE;
};
let merged = 0;
const where = [];
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
    if (all) {
      merged++;
      where.push(`${x},${y}`);
    }
  }
}
const problems = checkCity(city, plan);
console.log(`blocks ${city.blocks.length}  buildings ${city.buildings.length}`);
console.log(`merged tarmac ${merged}  (suite ceiling 230, baseline 215)${merged > 230 ? '   <-- FAILS' : ''}`);
console.log(`  south-shore ones: ${where.filter((h) => { const [x, y] = h.split(',').map(Number); return y > 600; }).join(' ') || '(none)'}`);
console.log(`checker: ${problems.length} problem(s)`);
for (const p of problems) console.log(`  ${p.severity}  ${p.message}`);
