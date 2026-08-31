import { describe, expect, it } from 'vitest';
import cityPlanJson from 'shared/data/city-plan.json';
import { CITY_DATA, decodeBakedCity, parseCityPlan, T_BRIDGE, T_LOT, T_ROAD } from 'shared';
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

  it('notices when a landmark loses its street frontage', () => {
    // R1-A05. The checker said "has no road to it" and never looked for a
    // road: the rule behind that message floods over `drivable` ground — a
    // car park, a farmyard, a runway — so 285 tiles of carriageway could be
    // erased from around Mercy General and `checkCity` still returned
    // nothing. The suite was strictly stronger than the checker whose message
    // claimed the same property (`shared/test/city.test.ts`, "carries every
    // kind of landmark, each with a way in"). Now the checker asks it too,
    // which is what makes it true of a GENERATED city as well as this one.
    const cut = decodeBakedCity(JSON.parse(CITY_DATA));
    const l = cut.landmarks.find((m) => m.name === 'Mercy General');
    expect(l).toBeDefined();
    const dx = Math.floor((l as { doorX: number }).doorX / 16);
    const dy = Math.floor((l as { doorY: number }).doorY / 16);
    let erased = 0;
    for (let oy = -12; oy <= 12; oy++) {
      for (let ox = -12; ox <= 12; ox++) {
        const i = (dy + oy) * cut.widthTiles + dx + ox;
        const t = cut.tiles[i] as number;
        if (t === T_ROAD || t === T_BRIDGE) {
          cut.tiles[i] = T_LOT;
          erased++;
        }
      }
    }
    expect(erased).toBeGreaterThan(100);
    expect(checkCity(cut, plan).map((p) => p.message)).toContain(
      'Mercy General (hospital) has no road within six tiles of its door',
    );
  });

  it('tells a taxiway from a street across the runway', () => {
    // R1-A08. Wave 2.3 promised "no street tile inside a runway rect" and
    // shipped only the converse pin (`shared/test/city.test.ts`, every
    // T_RUNWAY tile inside a rect), so a borough's grid could be laid across
    // an airfield with nothing to say so. The rule cannot simply count road
    // tiles: the bake cuts a driveway from every landmark door to the nearest
    // street, and Marsh End's runs fourteen tiles up the strip to the hangar
    // — a taxiway with a job (PROGRESS.md, wave 2.3). Nor can it count the
    // sides that carriageway touches: on plangen seed 512 the door is on the
    // far side of the strip, so that same driveway crosses the whole rect and
    // touches street at both ends while still being one track to one door.
    //
    // The three cases, on fourteen tiles each. As shipped: silent.
    expect(problems.filter((p) => p.message.includes('runs through'))).toEqual([]);

    // A loop of street across the strip and back into the network at the
    // west: both ends lead to the city, so traffic crosses the runway.
    const W = city.widthTiles;
    const looped = decodeBakedCity(JSON.parse(CITY_DATA));
    for (let y = 598; y <= 608; y++) {
      for (let x = 525; x <= 526; x++) looped.tiles[y * W + x] = T_ROAD;
    }
    for (let x = 499; x <= 526; x++) {
      for (let y = 607; y <= 608; y++) looped.tiles[y * W + x] = T_ROAD;
    }
    expect(
      checkCity(looped, plan)
        .filter((p) => p.severity === 'error')
        .map((p) => p.message),
    ).toEqual([
      'a street runs through Marsh End Airfield: 14 carriageway tiles inside the strip, ' +
        'open to the network at 525,606 and 525,598',
    ]);

    // The same fourteen tiles with the far end left in the field: a track to
    // nowhere is a track, whichever way it entered. Silent, as seed 512 must
    // be.
    const stub = decodeBakedCity(JSON.parse(CITY_DATA));
    for (let y = 598; y <= 612; y++) {
      for (let x = 525; x <= 526; x++) stub.tiles[y * W + x] = T_ROAD;
    }
    expect(checkCity(stub, plan).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('builds Kelvin Bridge, the crossing its own plan calls the signature span', () => {
    // The half of R1-A01 that was fixed, pinned on the shipped bytes rather
    // than on a re-bake: the deck is there, and it is the checker's own rule
    // that says so.
    expect(problems.filter((p) => p.message.startsWith('Kelvin Bridge'))).toEqual([]);
  });
});
