import { describe, expect, it } from 'vitest';
import cityPlanJson from 'shared/data/city-plan.json';
import { bakeCity, parseCityPlan } from 'shared';
import { checkCity } from '../src/tools/cityCheck.js';

/**
 * A road that says it bridges has to actually be there (R1-A01).
 *
 * `bridges: true` is a promise the plan makes — this road crosses that water
 * — and until this rule nothing in the pipeline checked that the bake kept
 * it. Kelvin Bridge's course was drawn to y=400 with the warped south bank at
 * y=415, so `lay()` decked it, the no-causeway pass kept the deck, and the
 * no-piers pass then found one landfall and correctly reverted the whole span
 * to sea. Every stage behaved: `parseCityPlan` accepted the plan, `checkCity`
 * returned nothing, `shippedCity.test.ts` was green, and the shipped city had
 * a four-lane carriageway with a painted centre line stopping in a rounded
 * cap on a bare bank.
 *
 * The rule is in `checkCity` rather than `parseCityPlan` for the reason
 * `plan.ts` already gives about `bandShore`: the geography has not been
 * rasterised at parse time, so "is there land at the end of this line" is not
 * a question the schema can ask. It is a question about a finished map.
 */
describe('a road that may bridge', () => {
  it(
    'is reported when its course stops in the water instead of reaching the far bank',
    { timeout: 120_000 },
    () => {
      // Kelvin Bridge exactly as it shipped before the fix: fifteen tiles
      // short of its own far bank. Nothing else about the plan is touched.
      const short = JSON.parse(JSON.stringify(cityPlanJson)) as typeof cityPlanJson;
      const kelvin = (short.roads as Array<{ name: string; points: number[][] }>).find(
        (r) => r.name === 'Kelvin Bridge',
      );
      expect(kelvin, 'the plan still has a road called Kelvin Bridge').toBeTruthy();
      (kelvin as { points: number[][] }).points = [
        [452, 288],
        [452, 400],
      ];
      const plan = parseCityPlan(short);
      const problems = checkCity(bakeCity(plan), plan);
      const named = problems.filter((p) => p.message.startsWith('Kelvin Bridge')).map((p) => p.message);
      expect(named.join('\n')).toMatch(/carry no carriageway at all/);
      expect(named.join('\n')).toMatch(/land on one side only/);
    },
  );
});
