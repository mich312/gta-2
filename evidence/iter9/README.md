# Iteration 9 — `road-stops-short`, settled

The signature has carried a note since early in the loop that it is "the ring
shave working as specified". Nobody had measured it. This is the measurement.

**Verdict: one mechanism, all thirteen, and the note is right.** No generation
code changed. One regression test added, because the thing that was true was
asserted nowhere and the next round could have "fixed" it.

---

## Retaking everything here

`pnpm build` first — every probe reads `shared/dist`, the same decoder
`mapAudit` uses, and `mapgen` renders from `shared/dist` and not from the
asset (iteration 8, §"a trap that could have invalidated the whole visual
record").

| file | command |
| --- | --- |
| `mapaudit-before.txt`, `mapaudit-before-all.txt` | `pnpm mapaudit`, `node server/dist/tools/mapAudit.js --all` |
| `mapaudit-after-all.txt` | same, after the change — byte-identical, as it must be |
| `attribute.txt` | `node evidence/iter9/attribute.mjs` |
| `population.txt` | `node evidence/iter9/population.mjs` |
| `cleared.txt` | `node evidence/iter9/cleared.mjs` |
| `cutcost.txt` | `node evidence/iter9/cutcost.mjs` |
| `invariant.txt` | `node evidence/iter9/invariant.mjs` |
| `leaks.txt` | `node evidence/iter9/leaks.mjs` |
| `layout-vs-bake.txt` | `node evidence/iter9/layout-vs-bake.mjs` |
| `junction-census.txt` | a **temporary** patch to `layout.ts` (see below) |
| `crop-*`, `site-*`, `group-*`, `ring-*` | `node server/dist/tools/mapgen.js --crop=x,y,w --scale=N --out=...` |
| `eye-*` | `pnpm --filter client dev`, then `WAIT_GROUND=20 VIEW=1400x700 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=X,Y&h=H&pitch=P&night=0" out.png` |

`junction-census.txt` is the one reading that cannot be retaken from a clean
tree: it came from `console.log`s temporarily inserted into
`cutMissedJunctions` and `guardRingAccess`, run under `JUNCTION_CENSUS=1`, and
removed again (`layout.ts` md5 `cba45e05224899eba7398050fde07476` before and
after). `leak-trace.txt` came the same way, from a per-pass watch on seven
tiles under `PASS_TRACE=1`.

---

## What the thirteen are

All thirteen are one mechanism: **§14.3 D6, the ring shave.**
`guardRingAccess` in `shared/src/world/layout.ts` takes out every carriageway
tile within Chebyshev 2 of the ring's own carriageways, outside a nine-tile
dilation of the authored crossings, so a lattice line that would T into a
motorway is held two tiles short instead.

Four independent measurements, each with a control:

1. **What is on the far side** (`attribute.txt`). The caps are re-derived with
   `mapAudit`'s own geometry, copied rather than imported. It reproduces the
   audit's thirteen exactly — same coordinates, widths, gap depths and gap
   materials — and then asks what carriageway each one stops short of:
   **RING 13, avenue 0, street 0.**
2. **Where the gap sits.** Gap entirely inside the ring's Chebyshev-2 shave
   band: **13 of 13.** Gap touching the authored-junction dilation:
   **0 of 13.**
3. **Was the gap ever road** (`cleared.txt`). `buildLayout` returns
   `cleared`, the mask `unlay` sets on every tile a removal pass took
   carriageway out of. **13 of 13 mouths have cleared ground across them.**
   Control: 4,000 sampled tiles of bare ground beside a carriageway read
   98 CLEARED / 3,902 never-road, so the mask is not stuck high.
4. **The pass that could have cut them, asked directly**
   (`junction-census.txt`). `cutMissedJunctions` runs last, after the
   removals, precisely to cut junctions nobody cut. It **saw 19 mouths, cut 7,
   and refused 12 — every one of the 12 because a removal pass had cleared the
   ground.** The twelve are twelve of the audit's thirteen. The thirteenth,
   `282,407`, never reached that test: only one of its three cap tiles has
   ring carriageway squarely across, so the pass classifies it as a road
   passing by. Same mechanism; `cleared.txt` shows all six of its gap tiles
   CLEARED.

## The population, at the real scale

The thirteen are a **sample of a uniform city-wide condition**, not a defect
with thirteen instances.

| | |
| --- | --- |
| carriageway `guardRingAccess` removed | **1,802 tiles net** (1,808 shaved, 6 put back by the pothole rule) — 70% of the whole `cleared` mask |
| street mouths ≥2 tiles wide pointing at the ring | **150** |
| of those, outside the authored-junction dilation | **125** |
| of those 125, that *reach* the ring | **0** |
| gap depth, those 125 | 2 tiles ×43, 3 tiles ×82 |
| the ring's frontage that is cleared verge | **6,753 of 7,296 faces (92.6%)** — sidewalk 3,547, field 2,237, park 588 |

The thirteen findings are **10.4% of the mouths and 6.3% of the shave.** The
other 112 are indistinguishable from them; the audit's cap shape (width 2–6,
square, same width three tiles back, no road off either end, no landmark
within ten) is what picks these thirteen out.

## Is it visible? Yes — and what is visible is the design

**Group A — eleven urban mouths, 3 tiles wide.**
`ring-west-limb-uniformity.png` is the plate that settles it: two hundred tiles
of the ring's west limb, every cross street on both sides ending in a rounded,
kerbed turning head short of the motorway, unbroken except where an authored
avenue crosses in a full interchange. `crop-285-424-zoom.png` and
`crop-264-407-zoom.png` at 40 px/tile show one head each — a continuous kerb
line round the end, the centre dash stopping short of it as a real street's
does, then verge, then the ring's own kerb and edge line. This is what a
limited-access motorway looks like from the service-road side. It does not
read as a road that gives up. `eye-264-407-urban-mouth.png` and
`eye-285-424-ring-mouth.png` are the same thing at eye level, both at
`ground resident=20`.

**Group B — two rural lanes, 2 tiles wide** (`457,649` and `503,640`).
`site-457x649-zoom.png` and `site-503x640-zoom.png` top-down,
`eye-457-649-rural-mouth.png` at eye level (`ground resident=20`, so it is a
photograph of the city and not of flat slabs). Same mechanism, different
presentation: a country lane has no kerb band, so it gets no rounded turning
head — top-down the tarmac stops with a blunt transverse edge two or three
tiles from the carriageway. At eye level it reads better than the top-down
suggests: the lane's own edge lines close across the end, and it stops in
woodland with a tree standing in the gap, which is a lane that does not go
there rather than a lane that broke. The weaker half of the verdict, filed as
such; it is still the shave, and closing it would open the motorway.

Field is not solid to the sim (`plainSolid` in `shared/src/world/collide.ts`
answers solid only for `T_BUILDING`, `T_WATER`, `T_TREES`), so the player can
drive across the verge onto the ring at any of the 125. The chokepoints the
shave creates are for the road network — traffic, police pathing, the chase
bench — not a wall.

## The counterfactual, costed

`cutcost.txt`. Opening every mouth that points at the ring costs **1,143 tiles
of new tarmac** and takes the ring from **50 places you can join it to 200** —
which is verbatim the thing §14.3 D6 exists to prevent ("a motorway with four
hundred driveways is a wide street, not a motorway"), benched on the chase
harness (3★ escapes 2/5 → 3-4/5) and shipped.

## Adjacent, not fixed: the shave is not final

`invariant.txt`, `leaks.txt`, `layout-vs-bake.txt`, `leak-trace.txt`.

Seven mouths **do** join the ring outside the authored-junction dilation. They
are not the shave failing; they are three later stages putting carriageway back
where the shave had cleared it, or laying it where the shave could no longer
see:

| site | laid by |
| --- | --- |
| `641,307` | `carveAuthoredRoads` — the ring's own plumbing, marked and protected |
| `456,664` | `weaveFabrics`, **shaved**, then re-laid by `finishShores` |
| `510,122`, `513,123` | `finishShores` (the orphan reconnect / pothole rule), after the shave |
| `461,118`, `499,107`, `570,612` | the **bake**, downstream of the layout entirely — city-wide the bake adds 126 carriageway tiles the layout did not have |

`guardRingAccess`'s own comment anticipates the orphan machinery running after
it ("a lane whose only way in was the ring is now stranded, and the standing
machinery reconnects or prunes it like any other orphan") — but reconnecting
*to the ring* restores exactly the driveway the shave removed. Reported, not
fixed: it is a pass-ordering question in `finishShores` and a bake question,
both outside this iteration's finding.

## Reported, not fixed: the detector's reason string is wrong

`mapAudit`'s `road-stops-short` prints *"the junction was never cut"*. For
twelve of the thirteen the junction **was** considered by `cutMissedJunctions`
and deliberately refused, by an explicit rule the pass documents and this
iteration confirmed. Same class as iteration 7's group-C mislabel. The detector
has no access to `cleared`, but it does have `city.courses`: a mouth whose far
side is a `kind: 'ring'` course is the ring shave, and `attribute.mjs` shows
that test alone separates the thirteen perfectly.
`server/src/tools/mapAudit.ts` belongs to another agent this iteration, so this
is filed rather than changed. Changing it would move SCORE by 113 weighted
tiles and needs a two-way instrument control.

## The regression test

`shared/test/city.test.ts`, *"keeps the ring limited-access: the lattice joins
it only at the authored junctions"*. Nothing asserted this. The test above it
asserts the converse — that a gap over ground **nothing ever carved** gets cut —
and has since iteration 2; this one asserts that a gap over ground the shave
**cleared** stays a gap, so a future round cannot close `road-stops-short` by
quietly reversing a benched design decision.

It measures the shipped map rather than the layout on purpose: three of the
seven mouths above are laid by the bake, and the player drives the bake.

Two-way control, both quoted:

- `regression-control-shipped.txt` — passes on the shipped asset.
- `regression-control-planted.txt` — with six tiles of tarmac planted across
  the `264,407` mouth (exactly what "fix `road-stops-short`" would lay), it
  goes red and names `266,407`. The plant asserts its own size first, so it
  cannot pass on `0 === 0` the way iteration 7's watch control did.

## Chain

- `pnpm build` — clean.
- `node ci/test.mjs` — **93 files, 999 tests, 0 failures** (`suite.txt`).
- `node server/dist/tools/citybake.js --check` — **six warnings, The Ring ×2,
  Marsh Causeway, Coast Road ×3** (`citybake-check.txt`).
- reachability, `evidence/iter5/measure-reachability.mjs` — **100,833
  carriageway tiles, 1 component, mean 491.6 over 702 pairs, 0 unreachable**
  (`reachability.txt`) — unchanged.
- **blocks 1184, buildings 4005** — unchanged; no generation code was touched.
- `mapaudit` before vs after — **byte-identical, TOTAL 49, SCORE 2911.8.**
