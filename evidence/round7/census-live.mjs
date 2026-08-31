// Round 7 — R5-A04. The landmark-mass census run over a LIVE bake rather than
// the shipped bytes, so the fix can be measured before the city is rebaked.
//
//   node evidence/round7/census-live.mjs
//
// Prints two censuses of the same defect. RECORD is round 6's question — a
// `Building` record the tile plane no longer backs — and RECIPE is the
// question `checkCity` now asks: is every tile `RECIPES[kind].parts` stamped
// still `T_BUILDING` when the bake ends?
import { readFileSync } from 'node:fs';
import { bakeCity, parseCityPlan, landmarkParts } from '../../shared/dist/index.js';

const T_BUILDING = 3;
const NAMES = {
  0: 'FIELD', 1: 'ROAD', 2: 'SIDEWALK', 3: 'BUILDING', 4: 'PARK',
  5: 'LOT', 6: 'WATER', 7: 'BANK', 8: 'SAND', 9: 'FLOOR',
};

const plan = parseCityPlan(JSON.parse(readFileSync('shared/data/city-plan.json', 'utf8')));
const city = bakeCity(plan);
const W = city.widthTiles;
const H = city.heightTiles;

let affected = 0;
for (const l of city.landmarks) {
  const recs = city.buildings.filter(
    (b) => b.x >= l.x && b.y >= l.y && b.x + b.w <= l.x + l.w && b.y + b.h <= l.y + l.h,
  );
  const lost = {};
  const where = [];
  for (const b of recs) {
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = city.tiles[ty * W + tx];
        if (t === T_BUILDING) continue;
        const k = NAMES[t] ?? String(t);
        lost[k] = (lost[k] ?? 0) + 1;
        where.push(`${tx},${ty}=${k}`);
      }
    }
  }
  if (where.length === 0) continue;
  affected++;
  console.log(
    `RECORD ${l.name} (${l.kind}) rect=[${l.x},${l.y},${l.w},${l.h}] lost=${where.length}`,
    JSON.stringify(lost),
  );
  console.log('  ' + where.join(' '));
}
console.log(`record-census affected=${affected} of ${city.landmarks.length}`);

let byRecipe = 0;
for (const l of city.landmarks) {
  const missing = [];
  for (const [dx, dy, pw, ph] of landmarkParts(l.kind, l.w, l.h)) {
    for (let ty = l.y + dy; ty < l.y + dy + ph; ty++) {
      for (let tx = l.x + dx; tx < l.x + dx + pw; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (city.tiles[ty * W + tx] !== T_BUILDING) missing.push(`${tx},${ty}`);
      }
    }
  }
  if (missing.length === 0) continue;
  byRecipe++;
  console.log(`RECIPE ${l.name} (${l.kind}) missing=${missing.length}: ${missing.join(' ')}`);
}
console.log(`recipe-census affected=${byRecipe} of ${city.landmarks.length}`);
