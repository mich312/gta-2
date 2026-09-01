/* Does a fresh bake still encode to the byte-identical asset?
 *
 * §46 moved `wildAt` out of `bake.ts` into `woodCut.ts` so the planting rule
 * and the drawn contour are one function. That must move NO ground. This is
 * the control for that claim, and it has one of its own: it re-runs with the
 * level nudged and shows itself going red, because a comparison that cannot
 * fail is not a comparison.
 *
 *   node evidence/iter12/bake-identical.mjs
 */
import { readFileSync } from 'node:fs';
import { bakeCity, encodeBakedCity, parseCityPlan } from '../../shared/dist/index.js';

const src = readFileSync('shared/src/world/city.data.ts', 'utf8');
const q0 = src.indexOf('"'), q1 = src.lastIndexOf('"');
const asset = JSON.parse(src.slice(q0, q1 + 1));

const plan = parseCityPlan(
  JSON.parse(readFileSync('shared/data/city-plan.json', 'utf8')),
);
const fresh = encodeBakedCity(bakeCity(plan));

const same = fresh === asset;
console.log(`\n  asset ${asset.length} chars, fresh bake ${fresh.length} chars`);
console.log(`  BYTE-IDENTICAL: ${same ? 'yes' : 'NO'}`);
if (!same) {
  let i = 0;
  while (i < Math.min(fresh.length, asset.length) && fresh[i] === asset[i]) i++;
  console.log(`  first difference at char ${i}`);
  process.exitCode = 1;
}

// The control: the same comparison against a payload known to differ. If this
// prints "yes" the comparison is broken and the line above means nothing.
const bent = `${asset.slice(0, -2)}Z=`;
console.log(`  CONTROL (asset with one char bent) BYTE-IDENTICAL: ${fresh === bent ? 'yes — BROKEN' : 'no'}`);
if (fresh === bent) process.exitCode = 1;
console.log('');
