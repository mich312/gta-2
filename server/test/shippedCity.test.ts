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
  T_TREES,
  T_WATER,
  T_FIELD,
  hedgerowAt,
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

  it('carries only the one crossing its plan is still known to be wrong about', () => {
    // Warnings are pinned, not waved through. When this test was written the
    // city carried one — eight road tiles running into open water — and the
    // pin allowed exactly that, shrinking only. Wave 2.4 quayed the eight
    // and promoted the rule to an error, so the allowance is gone: any
    // warning on the shipped city is now a red test, and whoever adds a new
    // warning kind to the checker decides here whether the city may carry it.
    //
    // R1-A01 added such a kind — a `bridges: true` road the bake did not
    // build end to end — and this pin then listed SIX of them, on three
    // roads, as crossings the plan was "known to be wrong about". That list
    // was the defect, not the record of it: 508 tiles of authored course with
    // no carriageway on them, green for eleven iterations because they were
    // written down. Iteration 11 took five of the six decisions the pin was
    // deferring (`evidence/iter11/`):
    //
    //   The Ring, both carriageways (77 and 80 tiles). The eastern bay is 73
    //     and 75 tiles of water on the ring's line; `maxBridgeSpan` was 72,
    //     so it missed by one to three tiles. The plan now allows 96 —
    //     plangen's own default for a generated city. Measured blast radius
    //     of that number alone: 596 tiles, every one inside those two
    //     crossings, with block and building counts unmoved.
    //   Marsh Causeway (81 tiles). Its north end was drawn eight tiles out in
    //     the estuary, so the deck had land on one side only and the no-piers
    //     pass reverted the lot. The polyline now starts on the bank, and the
    //     96 tiles of water it crosses are what set `maxBridgeSpan`.
    //   Coast Road at 542,675 and at 679,606 (79 and 22 tiles). Neither was a
    //     crossing: the road was drawn on a shoreline the geography warp no
    //     longer produces, so it ran out at sea PARALLEL to the beach, and
    //     `bridgeable` only found "land ahead and behind" because the far
    //     bank was the same island. Raising the span would have built a
    //     79-tile causeway out to sea, which is the pathology `trimBridges`
    //     exists to stop. The east half of the course was moved back onto its
    //     own coast instead, and now ends on the headland by Gannet Light.
    //
    // The sixth is below, and it is left deliberately. It is the same defect
    // as the two above and none of the three cures fits it: between x=348 and
    // x=415 there is 1 to 4 tiles of land between the ring road and the
    // waterline (`evidence/iter11/probe-room.txt`), so the ring IS the coast
    // road on that stretch and a second carriageway laid beside it merges
    // with it — measured, +16 tiles on the "merged tarmac sheets" pin above,
    // which is what that pin is for. Deciding which road owns that shore is
    // an authoring call, not a fixer's.
    expect(problems.filter((p) => p.severity === 'warning').map((p) => p.message)).toEqual([
      "Coast Road may bridge but 169 tiles of its course carry no carriageway at all, from 360,685 to 520,681 — a crossing longer than the plan's maxBridgeSpan of 96",
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

  it('carries the hedgerow ACROSS a block edge, not up to it', () => {
    // Iteration 8, `country-outside-blocks`.
    //
    // The rural fill's rule is not one rule. `fillBlock`'s rural branch plants
    // woodland where the wildness field says wood, AND a hedgerow one verge
    // back from every lane, AND — inside the fringe band — orchard rows.
    // Iteration 3 taught the bake to ask the ground no block covers what it
    // is, and asked it only the first of the three. So a hedge run whose hash
    // is deliberately "keyed on the world grid, not the block, so a run
    // crosses block corners unbroken" reached the edge of the last block and
    // stopped dead on a line nothing draws, with bare verge beyond it.
    //
    // Asked of the artifact, with the bake's own predicate rather than a copy
    // of it: on rural country that no block's box covers, how many positions
    // does `hedgerowAt` claim that carry no tree? The bake refuses two kinds
    // on purpose and those are counted apart — a tree across a held-short
    // mouth is not a hedge, it is a street walled up.
    //
    //   pre-fix bake:  planted  66, missing 182, 26 across a mouth -> 156 unexplained
    //   this bake:     planted 220, missing  28, 26 across a mouth ->   2 unexplained
    //
    // `planted` is asserted too, and that is not decoration: a rule that
    // stopped firing at all would leave nothing to be missing and would pass
    // the first assertion on 0 === 0, which is how the seventh blind
    // instrument in this exercise passed its own control (iteration 7).
    const W = city.widthTiles;
    const H = city.heightTiles;
    const rural = new Uint8Array(W * H);
    for (const d of plan.districts) {
      if ((d as { rural?: boolean }).rural !== true) continue;
      for (let ty = 0; ty < H; ty++) {
        for (let tx = 0; tx < W; tx++) {
          if (rural[ty * W + tx] === 0 && pointInPoly(d.area, tx + 0.5, ty + 0.5)) rural[ty * W + tx] = 1;
        }
      }
    }
    // A block's bounding BOX, which is what the audit uses and is the larger
    // of the two readings — the bake's pass works off the block's mask, so
    // this can only understate the ground it was responsible for.
    const covered = new Uint8Array(W * H);
    for (const b of city.blocks) {
      for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
        for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) covered[y * W + x] = 1;
      }
    }
    const census = (tiles: Uint8Array): { planted: number; missing: number; mouth: number } => {
      const at = (x: number, y: number): number =>
        x < 0 || y < 0 || x >= W || y >= H ? -1 : (tiles[y * W + x] as number);
      const roadWithin3 = (x: number, y: number, dx: number, dy: number): boolean => {
        for (let k = 1; k <= 3; k++) {
          const v = at(x + dx * k, y + dy * k);
          if (v === T_ROAD || v === T_BRIDGE) return true;
        }
        return false;
      };
      const acrossAMouth = (x: number, y: number): boolean =>
        (roadWithin3(x, y, 1, 0) && roadWithin3(x, y, -1, 0)) ||
        (roadWithin3(x, y, 0, 1) && roadWithin3(x, y, 0, -1));
      let planted = 0;
      let missing = 0;
      let mouth = 0;
      for (let i = 0; i < W * H; i++) {
        if (rural[i] === 0 || covered[i] === 1) continue;
        const x = i % W;
        const y = (i - x) / W;
        const t = tiles[i] as number;
        if (t === T_TREES) {
          // A tree standing where the rule would have put one had the ground
          // still been bare. `hedgerowAt` asks for `T_FIELD`, so the tile is
          // put back for the length of the question and restored after.
          tiles[i] = T_FIELD;
          if (hedgerowAt(tiles, W, H, x, y)) planted++;
          tiles[i] = T_TREES;
          continue;
        }
        if (t !== T_FIELD) continue;
        if (!hedgerowAt(tiles, W, H, x, y)) continue;
        missing++;
        if (acrossAMouth(x, y)) mouth++;
      }
      return { planted, missing, mouth };
    };

    const shipped = census(decodeBakedCity(JSON.parse(CITY_DATA)).tiles);
    // Where the rule fires, the tree is there — except across a mouth, which
    // is the bake refusing on purpose. A ceiling, so a later bake may only do
    // better. 156 on the pre-fix bake.
    expect(shipped.missing - shipped.mouth).toBeLessThanOrEqual(2);
    // And the rule fires on this ground at all. 66 before the fix, 220 after.
    expect(shipped.planted).toBeGreaterThanOrEqual(200);

    // The control: the census can go red. Take one planted hedgerow tile back
    // to bare ground and it must show up as missing, or the two assertions
    // above are measuring nothing.
    const cut = decodeBakedCity(JSON.parse(CITY_DATA));
    let felled = -1;
    for (let i = 0; i < W * H && felled < 0; i++) {
      if (rural[i] === 0 || covered[i] === 1 || cut.tiles[i] !== T_TREES) continue;
      const x = i % W;
      const y = (i - x) / W;
      cut.tiles[i] = T_FIELD;
      if (hedgerowAt(cut.tiles, W, H, x, y)) felled = i;
      else cut.tiles[i] = T_TREES;
    }
    expect(felled).toBeGreaterThanOrEqual(0);
    const after = census(cut.tiles);
    expect(after.missing).toBe(shipped.missing + 1);
    expect(after.planted).toBe(shipped.planted - 1);
  });

  it('builds Kelvin Bridge, the crossing its own plan calls the signature span', () => {
    // The half of R1-A01 that was fixed, pinned on the shipped bytes rather
    // than on a re-bake: the deck is there, and it is the checker's own rule
    // that says so.
    expect(problems.filter((p) => p.message.startsWith('Kelvin Bridge'))).toEqual([]);
  });
});
