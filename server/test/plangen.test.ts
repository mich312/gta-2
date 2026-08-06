import { describe, expect, it } from 'vitest';
import { bakeCity, generateCityPlan, parseCityPlan } from 'shared';
import { checkCity } from '../src/tools/cityCheck.js';

/**
 * A generated city, held to the checks the drawn one passes (WORLDGEN.md §17).
 *
 * This is the test that makes the whole approach worth anything. `checkCity`
 * is the function `pnpm citybake` runs on `shared/data/city-plan.json` — not
 * a relaxed copy of it, not a subset — and a generated plan either satisfies
 * it or the generator has a bug. One road network, every kind of landmark
 * present and reachable, every shop door on a pavement with a walkable room
 * behind it, nothing built in the sea.
 *
 * One seed here, deliberately: a bake is seconds of work and this suite runs
 * on every commit. The wide net is `pnpm plangen --sweep=N`, which is where
 * a pass rate over seeds nobody has looked at gets measured.
 */
describe('a generated city', () => {
  it('passes the same checker the drawn city passes', () => {
    const drafted = generateCityPlan({ seed: 1, widthTiles: 384, heightTiles: 384 });
    const plan = parseCityPlan(JSON.parse(JSON.stringify(drafted)));
    const city = bakeCity(plan);
    const problems = checkCity(city, plan);
    const errors = problems.filter((p) => p.severity === 'error').map((p) => p.message);
    expect(errors).toEqual([]);
    // And it is a city, not an empty island: the checks above would all pass
    // on a plan with three blocks in it.
    expect(city.blocks.length).toBeGreaterThan(80);
    expect(city.buildings.length).toBeGreaterThan(150);
    expect(city.shops.length).toBeGreaterThan(3);
  }, 120_000);
});
