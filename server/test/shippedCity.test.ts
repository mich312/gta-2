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

  it('carries no warnings at all', () => {
    // Warnings are pinned, not waved through. When this test was written the
    // city carried one — eight road tiles running into open water — and the
    // pin allowed exactly that, shrinking only. Wave 2.4 quayed the eight
    // and promoted the rule to an error, so the allowance is gone: any
    // warning on the shipped city is now a red test, and whoever adds a new
    // warning kind to the checker decides here whether the city may carry it.
    expect(problems.filter((p) => p.severity === 'warning').map((p) => p.message)).toEqual([]);
  });
});
