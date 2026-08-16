import { describe, expect, it } from 'vitest';
import cityPlanJson from 'shared/data/city-plan.json';
import { CITY_DATA, decodeBakedCity, parseCityPlan } from 'shared';
import { checkCity } from '../src/tools/cityCheck.js';

/**
 * The shipped city meets its own checker (PLAN-WORLDGEN.md wave 0.2).
 *
 * `checkCity` gets to be exhaustive because it runs offline — but until this
 * test it guarded only the tools: `citybake` on a bake somebody remembered to
 * run, `plangen` on cities nobody ships. The asset players actually load —
 * `city.data.ts`, decoded here exactly the way `generateCity` decodes it —
 * never met the checker again after being committed. So a regression in the
 * committed bytes, or a checker rule added after the last bake, had nothing
 * to fail. Now it fails here.
 */
describe('the shipped city', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));
  const plan = parseCityPlan(cityPlanJson);
  const problems = checkCity(city, plan);

  it('passes the checker with zero errors, byte-for-byte as committed', () => {
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.message)).toEqual([]);
  });

  it('carries no warnings beyond the ones written down here', () => {
    // Warnings are pinned, not waved through: this list is every warning the
    // committed city is ALLOWED to carry, and the counts may only shrink.
    // A ninth wet road tile — or a warning kind not on the list — is a red
    // test, not a log line scrolling past in `pnpm citybake`. When wave 2.4
    // fixes the eight and promotes the rule to an error, this pin goes with it.
    const warnings = problems.filter((p) => p.severity === 'warning').map((p) => p.message);
    for (const w of warnings) {
      const wet = /^(\d+) road tiles run straight into water$/.exec(w);
      expect(wet, `a warning this test does not allow: "${w}"`).toBeTruthy();
      expect(Number(wet![1])).toBeLessThanOrEqual(8);
    }
    expect(warnings.length).toBeLessThanOrEqual(1);
  });
});
