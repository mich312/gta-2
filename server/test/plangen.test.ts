import { describe, expect, it } from 'vitest';
import { bakeCity, deriveBevels, parseCityPlan, T_SAND, T_WATER } from 'shared';
import { generateCityPlan } from 'shared/plangen';
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

  it('has a beach on its sheltered coast, and the beach runs at 45 degrees', () => {
    // §17.4. The bevel pass can only smooth soft ground — a quay stays square
    // on purpose — so "is the coast smooth" is really "how much of the coast
    // is beach", and the shore parishes are what decides that. Before them a
    // generated city was 3.7% bevelled against the drawn city's 4.2%; the
    // floor below is set under the worst seed measured, not at the average.
    const drafted = generateCityPlan({ seed: 1, widthTiles: 384, heightTiles: 384 });
    const city = bakeCity(parseCityPlan(JSON.parse(JSON.stringify(drafted))));
    const W = city.widthTiles;
    const H = city.heightTiles;
    const bevel = deriveBevels(city.tiles, W, H);
    const at = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (city.tiles[y * W + x] as number);
    let beach = 0;
    let edge = 0;
    let cut = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (city.tiles[i] === T_SAND) beach++;
        if (city.tiles[i] !== T_WATER) continue;
        const dry =
          at(x + 1, y) !== T_WATER || at(x - 1, y) !== T_WATER ||
          at(x, y + 1) !== T_WATER || at(x, y - 1) !== T_WATER;
        if (!dry) continue;
        edge++;
        if (bevel[i] !== 0) cut++;
      }
    }
    expect(beach).toBeGreaterThan(200);
    expect(cut / edge).toBeGreaterThan(0.05);
  }, 120_000);
});
