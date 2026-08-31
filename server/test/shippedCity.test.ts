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

  it('carries only the crossings its plan is known to be wrong about', () => {
    // Warnings are pinned, not waved through. When this test was written the
    // city carried one — eight road tiles running into open water — and the
    // pin allowed exactly that, shrinking only. Wave 2.4 quayed the eight
    // and promoted the rule to an error, so the allowance is gone: any
    // warning on the shipped city is now a red test, and whoever adds a new
    // warning kind to the checker decides here whether the city may carry it.
    //
    // R1-A01 adds such a kind: a `bridges: true` road that the bake did not
    // build end to end. Kelvin Bridge was one and is fixed. The six below, on
    // three roads, are NOT rasteriser noise and are not accepted as correct —
    // each is a crossing the plan asks for and the map refuses, and each
    // needs a decision this fixer was not entitled to take alone. They are
    // written out in full, by name and by extent, so that the day one of them
    // is decided the pin has to be edited, and so that a NEW broken crossing
    // — or one of these getting worse — is a red test rather than a line
    // further down a log. See REVIEW-QUEUE.md R1-A01 for the options and what
    // each costs.
    expect(problems.filter((p) => p.severity === 'warning').map((p) => p.message)).toEqual([
      // The Ring's east crossing, both carriageways. The eastern bay is 73
      // to 75 tiles of water on the line the ring takes; maxBridgeSpan is 72.
      // It misses by one to three tiles.
      "The Ring may bridge but 77 tiles of its course carry no carriageway at all, from 641,309 to 644,381 — a crossing longer than the plan's maxBridgeSpan of 72",
      "The Ring may bridge but 80 tiles of its course carry no carriageway at all, from 649,306 to 652,380 — a crossing longer than the plan's maxBridgeSpan of 72",
      // Marsh Causeway starts 17 tiles out in open water, and the bay it
      // aims at is 93 to 100 tiles wide on that line. Not a polyline nudge.
      'Marsh Causeway may bridge but 81 tiles of its course carry no carriageway at all, from 566,292 to 571,373 — the course begins or ends out in the water, so the deck has land on one side only',
      // The Coast Road, filed separately: the coastline warp moved the south
      // shore inland of the course it was drawn on, so the road is out at
      // sea for a third of its length. Found by this rule, not by R1-A01.
      "Coast Road may bridge but 169 tiles of its course carry no carriageway at all, from 360,685 to 520,681 — a crossing longer than the plan's maxBridgeSpan of 72",
      "Coast Road may bridge but 79 tiles of its course carry no carriageway at all, from 542,675 to 612,648 — a crossing longer than the plan's maxBridgeSpan of 72",
      'Coast Road may bridge but 22 tiles of its course carry no carriageway at all, from 679,606 to 694,596 — the course begins or ends out in the water, so the deck has land on one side only',
    ]);
  });

  it('builds Kelvin Bridge, the crossing its own plan calls the signature span', () => {
    // The half of R1-A01 that was fixed, pinned on the shipped bytes rather
    // than on a re-bake: the deck is there, and it is the checker's own rule
    // that says so.
    expect(problems.filter((p) => p.message.startsWith('Kelvin Bridge'))).toEqual([]);
  });
});
