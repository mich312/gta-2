// The control for the regression pin in server/test/shippedCity.test.ts
// ("carries only the one crossing its plan is still known to be wrong about").
//
// A pin that only ever runs against the tree it was written on cannot tell
// "fixed" from "never fired". This runs the SAME assertion, through the SAME
// checkCity, against two sets of shipped bytes: the pre-fix asset and plan at
// d7b4256, and the ones in the tree now. The first must go RED with six
// messages; the second must be GREEN with exactly the one that is left.
//
//   node evidence/iter11/control-bridging-gate.mjs <before-city.data.ts> <before-city-plan.json>
//
// Take the two "before" files out of git rather than out of a stash
// (refs/stash is shared between worktrees):
//   git show d7b4256:shared/src/world/city.data.ts   > /tmp/before-city.data.ts
//   git show d7b4256:shared/data/city-plan.json      > /tmp/before-city-plan.json
import { readFileSync } from 'node:fs';
import { decodeBakedCity, parseCityPlan } from '../../shared/dist/index.js';
import { checkCity } from '../../server/dist/tools/cityCheck.js';

// The pin, verbatim.
const PIN = [
  "Coast Road may bridge but 169 tiles of its course carry no carriageway at all, from 360,685 to 520,681 — a crossing longer than the plan's maxBridgeSpan of 96",
];

const loadBake = (p) => {
  const s = readFileSync(p, 'utf8');
  return decodeBakedCity(JSON.parse(JSON.parse(s.slice(s.indexOf('"'), s.lastIndexOf('"') + 1))));
};

const cases = [
  ['BEFORE  d7b4256', process.argv[2], process.argv[3]],
  [
    'AFTER   this tree',
    new URL('../../shared/src/world/city.data.ts', import.meta.url).pathname,
    new URL('../../shared/data/city-plan.json', import.meta.url).pathname,
  ],
];

const results = [];
for (const [label, dataPath, planPath] of cases) {
  const city = loadBake(dataPath);
  const plan = parseCityPlan(JSON.parse(readFileSync(planPath, 'utf8')));
  const problems = checkCity(city, plan);
  const warnings = problems.filter((p) => p.severity === 'warning').map((p) => p.message);
  const errors = problems.filter((p) => p.severity === 'error').map((p) => p.message);
  console.log(`\n${label}   maxBridgeSpan ${plan.maxBridgeSpan}`);
  console.log(`  errors: ${errors.length}   warnings: ${warnings.length}`);
  for (const m of warnings) console.log(`    - ${m}`);
  const pass =
    errors.length === 0 &&
    warnings.length === PIN.length &&
    warnings.every((m, i) => m === PIN[i]);
  console.log(`  => the pin would be ${pass ? 'GREEN' : 'RED'}`);
  results.push(pass);
}

console.log(
  results[0] === false && results[1] === true
    ? '\ncontrol fired: RED on the pre-fix bytes, GREEN on these — the pin can go red'
    : '\nCONTROL DID NOT FIRE — the probe is broken, not the code',
);
