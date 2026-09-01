# Iteration 11 — the 508 tiles of road that were not there

Six `citybake --check` warnings, stable for eleven iterations and read as a
pass condition every run, were **508 tiles of authored course carrying no
carriageway**. Five are closed. The sixth is escalated with the measurement
that says why it is not a polyline nudge.

|   | road | span | tiles | what it actually was | outcome |
| - | --- | --- | --- | --- | --- |
| 1 | The Ring | 641,309 → 644,381 | 77 | a real crossing; 73 tiles of water on its line, `maxBridgeSpan` 72 | **built** |
| 2 | The Ring | 649,306 → 652,380 | 80 | a real crossing; 75 tiles of water | **built** |
| 3 | Marsh Causeway | 566,292 → 571,373 | 81 | north end drawn 8 tiles out in the estuary, **and** 96 tiles of water on the line | **built** |
| 4 | Coast Road | 360,685 → 520,681 | **169** | not a crossing — the road drawn out at sea, parallel to its own shore, where the ring road already has the beach | **NOT FIXED — escalated** |
| 5 | Coast Road | 542,675 → 612,648 | 79 | same, but with 12–27 tiles of shore to move onto | **rerouted onto the coast** |
| 6 | Coast Road | 679,606 → 694,596 | 22 | course ended in open water, 11 tiles short of an empty islet | **course ended on the headland; those 22 tiles are sea and stay sea** |

**317 of the 508 tiles are settled.** Rows 1, 2, 3 and 5 put 317 tiles of
course onto carriageway (77 + 80 + 81 + 79); row 6 shortened the course by the
22 tiles that were over open sea, so those are settled without becoming road;
and row 4's 169 tiles are unchanged and still warn.

## The three failure modes were three different bugs

`bridgeable()` asks for land within `maxBridgeSpan` **along the direction of
travel**; `trimBridges()` then removes any deck whose narrowest axis run
exceeds the same number; the no-piers pass removes any deck that lands in
fewer than two places. The six spans failed on all three gates:

* **1, 2, 3** failed the span. Their water is genuinely 73, 75 and 96 tiles
  wide on the line the road takes (`probe-spans-before.txt`). `maxBridgeSpan`
  72 → 96 — plangen's own default for a generated city — is the whole fix for
  1 and 2 and half of 3. Blast radius of that number alone, measured: **596
  tiles, every one inside the two Ring crossings**, block and building counts
  unmoved (`bake-diff.mjs`).
* **3 and 6** additionally failed the no-piers gate, because a control point
  was authored in open water and the deck had a bank on one side only.
* **4 and 5** failed the span too, but **raising it would have been the wrong
  fix**. `probe-points-before.txt`: the nearest land to every one of Coast
  Road's five wet control points is the SAME landmass it starts from. The road
  is not crossing anything; it is drawn seaward of its own beach, and
  `bridgeable` only found "land ahead and behind" because the road runs along
  the water. A `maxBridgeSpan` of 88 and 106 would have laid a 169-tile and a
  79-tile causeway out to sea — the exact pathology the limit exists to stop
  (`layout.ts`, "No causeways").

## Why the 169 is not fixed, in numbers

`probe-room.txt` walks the south shore column by column and reports the clear
gap between the lowest carriageway and the waterline:

```
x=345  lowest carriageway y=685  waterline y=690  clear gap   4
x=355  lowest carriageway y=685  waterline y=687  clear gap   1
x=365  lowest carriageway y=678  waterline y=682  clear gap   3
x=375  lowest carriageway y=671  waterline y=675  clear gap   3
x=385  lowest carriageway y=667  waterline y=671  clear gap   3
x=395  lowest carriageway y=667  waterline y=670  clear gap   2
x=405  lowest carriageway y=670  waterline y=674  clear gap   3
x=415  lowest carriageway y=673  waterline y=676  clear gap   2
x=425  lowest carriageway y=664  waterline y=678  clear gap  13   <- room again
```

Between x=348 and x=415 there is **one to four tiles of land** between the
existing carriageway and the sea. The ring road IS the coast road on that
stretch. A second four-wide carriageway laid beside it merges with it, and the
suite already has the instrument that says so: `shared/test/city.test.ts`,
"keeps merged tarmac sheets rare, and shrinking", counts tiles at the centre
of a 7×7 all-carriageway window and holds a ceiling of 230 against a baseline
of 215.

Two full reroutes of the western half were built and scored
(`score-candidate.mjs`), and both grew that sheet past the ceiling:

| candidate | merged tarmac | blocks | verdict |
| --- | --- | --- | --- |
| baseline | 215 | 1184 | — |
| west + east rerouted, threading the ring's median | **231** | 1190 | fails the pin |
| west + east rerouted, pushed south of the ring | **238** | 1190 | fails worse |
| **east only (shipped)** | **216** | 1185 | passes |

Any route through x 360–430 either crosses the ring at a shallow angle or lies
a tile or two off its carriageway, and both widen the tarmac into one sheet.

**The proposal for the author**, with the numbers: the island is not wide
enough for two coastal roads between x=348 and x=415. Either (a) accept that
the ring carries the coast there and split the Coast Road into two named
roads, west and east of the narrows, or (b) move the ring inland over that
stretch and give the shore back to the Coast Road. Both are design decisions
about which road owns that beach; neither is a fixer's call. Until one is
taken, the bridging rule in `cityCheck.ts` stays a `warning` — the comment
there says so and says what to change when it is taken.

## What the change enabled, and what it cost

* **`client/test/bridgeParapet.test.ts`, "still refuses an abutment"** went
  red: 65 loose parapet ends against a bound of 60. The bound was described as
  "generous room ... on a map with four spans" and was in fact exact — the map
  had **13** separate decks and 4 x 13 + 8 = 60 — so the first change to add a
  span was always going to fail it for a reason unrelated to parapets. This
  change adds three decks (13 -> 16, `probe-pins.txt`), and 65 on 16 runs is
  the same ratio as 59 on 13. The bound now counts the runs, which reproduces
  60 exactly on the old map. The properties the test asserts — no parapet
  standing on dry land, no gap in a parapet — are untouched and still pass.
* **`shared/test/city.test.ts`, "keeps the ring limited-access"** went red the
  other way: it pins seven exact mouths that join the ring outside an authored
  junction, and there are now six. The one that went is `641,307`, described in
  that pin as "the ring's own authored plumbing" — it was the tile where the
  ring's eastern carriageway stopped dead at the water. With the deck built it
  is no longer a street meeting the ring; it is the ring. Mouths held short of
  the ring went 150 -> 151, so the shave is still doing its work.
  `probe-ringjoins.mjs` prints the list from a bake and reproduces all seven
  on the pre-fix asset before it was used to edit the pin.
* **`shared/test/city.test.ts`, "keeps merged tarmac sheets rare"** passes:
  215 -> 216 against a ceiling of 230. That pin is the reason the 169-tile
  span is escalated rather than rerouted.
* **`pnpm mapaudit`** moved TOTAL 48 -> 49, SCORE 2653.8 -> 2656.8, DRAWN
  2522.5 -> 2523.5. One new finding, `edge-notch` m=1: a single water tile at
  625,642 now enclosed on three sides by sand where the Coast Road's bay
  crossing meets the headland. `road-stops-short` is unmoved at 13, and no
  other signature changed.
* **Block count moved 1184 -> 1185**, buildings 4005 -> 4005. Downstream land
  use is index-coupled to block count (iteration 6: 1182 -> 1184 re-rolled
  land use city-wide and churned 401 tiles in boroughs it never touched), so
  this is reported rather than assumed harmless — and this time it did not
  wash: `bake-diff-before-after.txt` puts **every one of the 1,840 changed
  tiles inside three boxes**, [504,600]-[695,695], [624,288]-[671,383] and
  [552,264]-[575,383], which are the three roads that were touched. Land use
  outside those boxes did not move at all, and all six untouched borough watch
  crops read zero.
* **Reachability improved**: carriageway 100,833 -> 102,059 tiles, still one
  component, mean landmark-to-landmark distance **491.6 -> 473.9** over the
  same 702 ordered pairs, 0 unreachable on both sides.

## Retaking everything here

`pnpm build` first — every probe reads `shared/dist`, and `mapgen` renders
from `shared/dist`, not from the asset, so a stale dist redraws the previous
bake and reads exactly like "the renderer cannot show it".

The "before" readings need the pre-fix bytes, taken out of git rather than out
of a stash (`refs/stash` is shared between worktrees):

```
git show d7b4256:shared/src/world/city.data.ts > /tmp/before-city.data.ts
git show d7b4256:shared/data/city-plan.json    > /tmp/before-city-plan.json
```

| file | command |
| --- | --- |
| `before-citybake-check.txt`, `after-citybake-check.txt` | `node server/dist/tools/citybake.js --check` |
| `control-bridging-gate.txt` | `node evidence/iter11/control-bridging-gate.mjs /tmp/before-city.data.ts /tmp/before-city-plan.json` |
| `probe-spans-before.txt` / `-after.txt` | `node evidence/iter11/probe-spans.mjs` — per-course water runs and the per-tile `shortest` that `trimBridges` compares to `maxBridgeSpan` |
| `probe-points-before.txt` / `-after.txt` | `node evidence/iter11/probe-points.mjs` — is each control point dry, and which landmass is nearest |
| `probe-room.txt` | `node evidence/iter11/probe-room.mjs /tmp/before-city.data.ts 340 620 5` |
| `probe-pins.txt` | `node evidence/iter11/probe-pins.mjs /tmp/before-city.data.ts` — merged-tarmac tiles and deck runs, both bakes |
| `probe-deckspan.txt` | `node evidence/iter11/probe-deckspan.mjs` — the suite's own causeway rule, run outside vitest |
| `reachability.txt` | `LABEL=before node evidence/iter5/measure-reachability.mjs /tmp/before-city.data.ts`, then without the path for after |
| `mapaudit-before.txt` | `node server/dist/tools/mapAudit.js --data=/tmp/before-city.data.ts --plan=/tmp/before-city-plan.json` |
| `mapaudit-after.txt` | `pnpm mapaudit` |
| `mapwatch-tiles.txt` | `node ci/mapwatch.mjs --tiles-only --tiles-prev /tmp/before-city.data.ts --tiles shared/src/world/city.data.ts` |
| `bake-diff-before-after.txt` | `bake-dump.mjs` on the old plan, then `bake-diff.mjs base.bin final.bin` |
| `before-*.png` | rendered on the pre-fix tree; `after-*.png` on this one, same crop and scale |
| `probe-ringjoins.txt` | `node evidence/iter11/probe-ringjoins.mjs <asset>` on both bakes |
| `full-suite.txt` | the tail of `node ci/test.mjs` — 93 files, 999 tests, 0 failures |

Renders, same crop and scale on both sides:

```
node server/dist/tools/mapgen.js --crop=340,600,200,160 --scale=5 --out=...coastroad-169.png
node server/dist/tools/mapgen.js --crop=560,580,140,120 --scale=7 --out=...coastroad-cap612.png
node server/dist/tools/mapgen.js --crop=520,255,110,160 --scale=6 --out=...marsh-causeway.png
node server/dist/tools/mapgen.js --crop=610,280,90,120  --scale=8 --out=...ring-crossings.png
node server/dist/tools/mapgen.js --out=...city.png
```

The rest are search tools rather than readings, and take arguments:
`probe-map.mjs x0 y0 x1 y1 step` (ASCII water mask with the authored courses on
it), `probe-tiles.mjs <asset> x0 y0 x1 y1` (ASCII of the baked carriageway),
`probe-coast.mjs x0 x1 ylo yhi xstep` (where the south coast actually runs),
`probe-strait.mjs x0 x1 step` (the north-island-to-south-island gap per
column), `probe-try.mjs '<points>' [curve]` and `probe-shift.mjs '<points>'`
(score a candidate polyline without rebaking), `bake-check.mjs [patch.json]`,
`score-candidate.mjs [patch.json]` and `bake-variant.mjs <patch.json> <prefix>`
(bake a candidate plan without touching the committed asset).

## Every instrument here was given a control

* `control-bridging-gate.mjs` runs the shipped-city pin against the pre-fix
  bytes and the current ones. It prints `RED` then `GREEN`, and says out loud
  if it fails to go red.
* `probe-spans.mjs` reproduces the checker's six messages to the tile before
  anything was changed (`probe-spans-before.txt` against
  `before-citybake-check.txt`).
* `measure-reachability.mjs` on the pre-fix asset reproduces iteration 5's
  published numbers exactly — 100,833 tiles, 1 component, 491.6 over 702
  pairs, 0 unreachable.
* `mapAudit` on the pre-fix asset reproduces the final review's TOTAL 48 /
  SCORE 2653.8 / DRAWN 2522.5.
* `ci/mapwatch.mjs --selftest` was run and passed, including its own
  deliberately-contaminated case going red.
* `score-candidate.mjs` reproduces the suite's merged-tarmac count (215) on
  the baseline plan before it was used to reject two candidates.
