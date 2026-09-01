import { describe, expect, it } from 'vitest';
import cityPlanJson from 'shared/data/city-plan.json';
import {
  CITY_DATA,
  decodeBakedCity,
  parseCityPlan,
  pointInPoly,
  T_BRIDGE,
  T_BUILDING,
  T_FLOOR,
  T_LOT,
  T_ROAD,
  T_WATER,
} from 'shared';
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

  it('lays no street on ground no borough was drawn on', () => {
    // R4 `lanes-serving-nothing`, pinned as a ceiling on the shipped bytes.
    //
    // The D1 ownership flood hands EVERY dry tile to a borough, so the passes
    // keyed on `owner` — the esplanade and the seam street — used to dress
    // ground the author never drew as if it were town, while the block cut,
    // which is clipped to the polygon's bounding box, never arrived. The
    // result is carriageway with nothing on either side of it: the headland
    // north of Kelvin Bridge carried 1,197 tiles of it and not one building.
    //
    // The audit reports this and the audit is not run in CI, so the number
    // lives here too. These are ceilings — a bake may take road OFF this
    // ground, never put more on — and any NEW region of unclaimed land that
    // acquires lanes is a failure with nowhere to hide.
    const W = city.widthTiles;
    const H = city.heightTiles;
    const inPoly = new Uint8Array(W * H);
    for (const d of plan.districts) {
      for (let ty = 0; ty < H; ty++) {
        for (let tx = 0; tx < W; tx++) {
          const i = ty * W + tx;
          if (inPoly[i] === 0 && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[i] = 1;
        }
      }
    }
    const seen = new Uint8Array(W * H);
    const found: string[] = [];
    for (let s = 0; s < W * H; s++) {
      if (seen[s] === 1 || inPoly[s] === 1 || city.tiles[s] === T_WATER) continue;
      const bag = [s];
      seen[s] = 1;
      let land = 0;
      let road = 0;
      let built = 0;
      let x0 = W;
      let y0 = H;
      let x1 = -1;
      let y1 = -1;
      for (let q = 0; q < bag.length; q++) {
        const i = bag[q] as number;
        const x = i % W;
        const y = (i - x) / W;
        land++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        const t = city.tiles[i] as number;
        if (t === T_ROAD || t === T_BRIDGE) road++;
        if (t === T_BUILDING || t === T_FLOOR) built++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j] === 1 || inPoly[j] === 1 || city.tiles[j] === T_WATER) continue;
          seen[j] = 1;
          bag.push(j);
        }
      }
      // The same three gates the audit uses, so the two speak about the same
      // regions: a stretch big enough to be a place, carrying enough road to
      // be a street plan rather than an arterial passing through, and with
      // too little built on it for the lanes to be serving anything. The
      // built gate is what separates empty ground from a warp fringe that is
      // doing its job — two other regions of unclaimed land carry more road
      // than these and are not this finding, because the borough's own
      // buildings stand on them.
      if (land < 1000 || road * 10 < land || built * 100 >= land) continue;
      found.push(`${x0},${y0}-${x1},${y1}: ${land} land, ${road} road, ${built} built`);
    }
    // The strait shoulder, whose promenade round an empty peninsula is gone
    // (1,343 road tiles, was 41.5% of its land, now 35.2%); and the headland
    // north of Kelvin Bridge, still at 1,197 — its remaining lanes are its
    // 241-tile bridge approach, the coast road that runs on from Ravenhill's
    // own shore, and the seam street that carries the only boundary The Spine
    // shares with Beachfront. See the iteration 5 report: taking that seam off
    // fails `city.test.ts` "leaves no ground to nobody".
    expect(found).toEqual([
      '267,312-365,375: 3237 land, 1140 road, 10 built',
      // 1,197 until iteration 6, when The Spine's grid was closed at its
      // southern edge (see the test below). The one tile is 543,312 — the
      // junction where that closing street meets the coast road already
      // running down the headland's east shore, and a junction is the road
      // this finding is not about. Nothing else on either region moved.
      '393,312-549,365: 5749 land, 1198 road, 0 built',
    ]);
  });

  it('closes an axis grid at the far edge of its rect, not only the near one', () => {
    // Iteration 6's `road-deadend` x5: The Spine's streets at x = 440, 485,
    // 500, 515 and 530, every one of them stopping on y=311 — one row past
    // the last building row, against a polygon whose southern edge is the
    // ruler-straight y=312 — and facing open ground.
    //
    // Not the D1 ownership flood, which is what the finding was escalated as.
    // All five caps are INSIDE The Spine's own polygon at claimDepth 0
    // (`evidence/iter6/probe-deadends.mjs`). The cause is one level down: the
    // lattice's cut family put a street on the NEAR edge of the borough's
    // rect and none on the far one, so a grid borough was closed on its north
    // and west and open on its south and east, and every line of the other
    // family ran out past the last cross street and stopped.
    //
    // Asked of the artifact, in the audit's own terms: along the last row of
    // the borough, a north-south street that ends there must end at a cross
    // street and not in a field. `road-deadend` excuses a cap wider than six
    // tiles as a plaza or a frontage, so a cap of 2..6 with nothing below it
    // is exactly the finding. On the pre-fix bake this reports five; the fix
    // has to hold it at none. See `evidence/iter6/`.
    const W = city.widthTiles;
    const spine = plan.districts.find((d) => d.name === 'The Spine');
    if (!spine) throw new Error('the plan no longer has a borough called The Spine');
    const EDGE = 311; // the last row inside the polygon, whose foot is y=312
    const isRoad = (x: number, y: number): boolean => {
      const t = city.tiles[y * W + x] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    const caps: string[] = [];
    let x = 0;
    while (x < W) {
      if (!isRoad(x, EDGE) || isRoad(x, EDGE + 1) || !pointInPoly(spine.area, x + 0.5, EDGE + 0.5)) {
        x++;
        continue;
      }
      let run = 0;
      while (x + run < W && isRoad(x + run, EDGE) && !isRoad(x + run, EDGE + 1)) run++;
      if (run >= 2 && run <= 6) caps.push(`${x}-${x + run - 1}`);
      x += run;
    }
    expect(caps).toEqual([]);
  });

  it('builds Kelvin Bridge, the crossing its own plan calls the signature span', () => {
    // The half of R1-A01 that was fixed, pinned on the shipped bytes rather
    // than on a re-bake: the deck is there, and it is the checker's own rule
    // that says so.
    expect(problems.filter((p) => p.message.startsWith('Kelvin Bridge'))).toEqual([]);
  });
});
