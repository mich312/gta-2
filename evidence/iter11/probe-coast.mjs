// For each column x, the southernmost DRY tile of the main landmass between
// y0 and y1 — i.e. where the south coast actually runs, which is the line a
// road called "Coast Road" is supposed to follow.
//   node evidence/iter11/probe-coast.mjs <x0> <x1> <ystep-lo> <ystep-hi> <xstep>
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan } from '../../shared/dist/index.js';

const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const L = buildLayout(plan);
const { widthTiles: W, water } = L;
const [x0, x1, ylo, yhi, xstep] = process.argv.slice(2).map(Number);

for (let x = x0; x <= x1; x += xstep) {
  let last = null;
  const runs = [];
  for (let y = ylo; y <= yhi; y++) {
    const dry = water[y * W + x] !== 1;
    if (dry && last === null) last = y;
    if (!dry && last !== null) {
      runs.push([last, y - 1]);
      last = null;
    }
  }
  if (last !== null) runs.push([last, yhi]);
  console.log(
    `x=${String(x).padStart(3)}  dry runs: ${runs.map(([a, b]) => `${a}-${b}`).join(' ') || '(none)'}`,
  );
}
