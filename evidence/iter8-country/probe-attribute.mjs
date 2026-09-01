// Attribution probe for `country-outside-blocks`: what did the bake actually
// DECIDE on the ground the audit says was never asked?
//
//   node evidence/iter8-country/probe-attribute.mjs /tmp/orphan-probe.txt
//
// REQUIRES A TEMPORARY PATCH TO `shared/src/world/bake.ts`, which is not
// committed — the instrumentation was reverted once the answer was in, and
// this script fails loudly rather than reporting an empty attribution.
// In the blockless-country pass, wrap the woodland decision loop:
//
//     const PROBE = (globalThis as unknown as { __orphanProbe?: unknown })
//       .__orphanProbe ? ([] as string[]) : null;
//     for (let i = 0; i < W * H; i++) {
//       const x0 = i % W;
//       const y0 = (i - x0) / W;
//       if (!orphan(i)) {
//         if (PROBE) PROBE.push(`${x0} ${y0} skip cov=${covered[i]} t=${tiles[i]} ` +
//           `w=${layout.water[i]} r=${rural(i) ? 1 : 0} own=${layout.owner[i]}`);
//         continue;
//       }
//       ...
//       if (!wildAt(x, y)) { if (PROBE) PROBE.push(`${x} ${y} meadow`); continue; }
//       if (near(x, y, T_ROAD, 1) || near(x, y, T_BRIDGE, 1)) {
//         if (PROBE) PROBE.push(`${x} ${y} verge-road`); continue; }
//       if (near(x, y, T_WATER, 1)) { if (PROBE) PROBE.push(`${x} ${y} verge-water`); continue; }
//       if (acrossAMouth(x, y)) { if (PROBE) PROBE.push(`${x} ${y} mouth`); continue; }
//       if (PROBE) PROBE.push(`${x} ${y} plant`);
//       plant.push(i);
//     }
//     if (PROBE) (globalThis as unknown as { __orphanProbe?: (r: string[]) => void })
//       .__orphanProbe?.(PROBE);
//
// The probe is gated on `globalThis`, so with it in place the bake is
// unchanged when nothing installs the hook — which was checked by re-baking
// and comparing the asset byte for byte.
import { readFileSync, writeFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
let rows = null;
globalThis.__orphanProbe = (r) => {
  rows = r;
};
const city = S.bakeCity(plan);
if (rows === null) {
  throw new Error(
    'the bake never called __orphanProbe — the temporary instrumentation described ' +
      'at the top of this file is not in shared/src/world/bake.ts, or dist is stale',
  );
}
writeFileSync(process.argv[2] ?? '/tmp/orphan-probe.txt', rows.join('\n'));
console.log(
  `probe rows ${rows.length}, blocks ${city.blocks.length}, buildings ${city.buildings.length} ` +
    `-> ${process.argv[2] ?? '/tmp/orphan-probe.txt'}`,
);
