// Are the two "deliberate" road-deadends really deliberate?
//
//  415,672  layEsplanade lays over the band 3 <= shoreDist < 6. If shoreDist
//           leaves that window at the cap, the band ran out because the shore
//           turned away — the pass did what it says. CONTROL: the same walk at
//           a stretch of esplanade in the MIDDLE of a run must stay in-window.
//
//  478,600  carveWavy's `drop` hash skips a whole `dropLen` stretch when
//           latticeHash(0xd50b ^ di, at, m) < 0.38 — "every gap is a dead end
//           or a loop that the §13.5 budget owns" (layout.ts:1757). If the cap
//           sits at a dropped stretch, the dead end is the documented product
//           of the hash. Measured as the run/gap pattern down the whole line.
//
//   node evidence/iter10/deliberate.mjs
import { S, plan, loadBake, NEW } from './lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

const W = plan.widthTiles;
const H = plan.heightTiles;
const layout = buildLayout(plan);
const city = loadBake(NEW);
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const rd = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? false : isRoad(city.tiles[y * W + x]));

/* distanceField, copied from layout.ts:162 so the numbers are the pass's own */
function distanceField(mask, want) {
  const D = new Float32Array(W * H).fill(1e9);
  for (let i = 0; i < D.length; i++) if (mask[i] === want) D[i] = 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 1e9 : D[y * W + x]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      D[y * W + x] = Math.min(D[y * W + x], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--)
      D[y * W + x] = Math.min(D[y * W + x], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
  return D;
}
const shoreDist = distanceField(layout.water, 1);

console.log('=== 415,672 — layEsplanade: did the shore band run out? ===');
console.log('the esplanade lays only where 3 <= shoreDist < 6\n');
console.log('  x     shoreDist  in-band?  road?');
for (let x = 405; x <= 428; x++) {
  const sd = shoreDist[672 * W + x];
  console.log(`  ${String(x).padStart(3)}   ${sd.toFixed(2).padStart(7)}    ${sd >= 3 && sd < 6 ? 'YES' : 'no '}       ${rd(x, 672) ? 'ROAD' : '-'}`);
}
// CONTROL: mid-run esplanade must stay in-band
console.log('\n  CONTROL — 20 tiles of esplanade back from the cap (must stay in-band):');
let inBand = 0, n = 0;
for (let x = 395; x < 415; x++) { n++; const sd = shoreDist[672 * W + x]; if (sd >= 3 && sd < 6) inBand++; }
console.log(`    ${inBand}/${n} in-band behind the cap;  ahead of it: ` +
  `${[...Array(12)].filter((_, k) => { const sd = shoreDist[672 * W + 416 + k]; return sd >= 3 && sd < 6; }).length}/12`);

console.log('\n=== 478,600 — the crescent drop hash ===');
// Walk south down the line the cap belongs to and print the run/gap pattern.
const col = 478;
let runs = [];
let cur = null;
for (let y = 560; y <= 700; y++) {
  const r = rd(col, y) || rd(col - 1, y) || rd(col + 1, y);
  if (r) { if (!cur) cur = { y0: y, y1: y }; else cur.y1 = y; }
  else if (cur) { runs.push(cur); cur = null; }
}
if (cur) runs.push(cur);
console.log(`  carriageway runs down x=${col}, y 560..700:`);
for (let k = 0; k < runs.length; k++) {
  const g = k + 1 < runs.length ? runs[k + 1].y0 - runs[k].y1 - 1 : null;
  console.log(`    road ${runs[k].y0}..${runs[k].y1} (${runs[k].y1 - runs[k].y0 + 1} tiles)` + (g !== null ? `   then GAP of ${g} tiles` : ''));
}
const nsIdx = plan.districts.findIndex((d) => d.name === 'New Suburbs');
const ns = plan.districts[nsIdx];
console.log(`  New Suburbs district #${nsIdx} fabric=${ns.street.fabric} pitchX=${ns.street.pitchX ?? '?'} pitchY=${ns.street.pitchY ?? '?'}`);
console.log(`  dropLen = max(10, pitch) => gaps should come in ~pitch-length units, roughly 2 in 5 stretches`);
const gaps = runs.slice(0, -1).map((r, k) => runs[k + 1].y0 - r.y1 - 1);
console.log(`  observed gaps: ${gaps.join(', ')}`);
console.log(`  observed runs: ${runs.map((r) => r.y1 - r.y0 + 1).join(', ')}`);
const total = runs.reduce((s, r) => s + (r.y1 - r.y0 + 1), 0);
const gapTotal = gaps.reduce((s, g) => s + g, 0);
console.log(`  carved ${total} of ${total + gapTotal} tiles down this line = ${((gapTotal / (total + gapTotal)) * 100).toFixed(0)}% dropped (hash says ~38%)`);

console.log('\n=== the other two: how far does open ground run past the cap? ===');
for (const [x, y, dx, dy, name] of [[321, 327, 0, 1, '321,327 Ravenhill spine'], [342, 312, 0, 1, '342,312 Ravenhill spine'], [415, 672, 1, 0, '415,672 esplanade'], [478, 600, 0, 1, '478,600 crescent']]) {
  let s = 1;
  while (s < 200 && !rd(x + dx * s, y + dy * s)) s++;
  console.log(`  ${name}: next carriageway straight ahead is ${s >= 200 ? '>200' : s} tiles away`);
}
