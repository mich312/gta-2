# PLAN-WORLDGEN.md — fixing the map generation, and everything the flyover saw

The fix plan for `REVIEW-WORLDGEN.md`, sequenced the way this codebase already
knows works: safety rails before anything that can change the bake, paint-only
fixes next (they ship without touching the city), then **one** declared rebake
carrying every tile-changing fix at once, then the larger visual features, then
the structural debt that makes all later changes cheaper. Nothing here touches
the sim's hot loop; the one candidate that could (ramp geometry, 3.5) is
renderer-only by design.

House rules this plan inherits:

- **A bake-changing fix does not ship alone.** Every change that moves a tile
  lands in Wave 2's single rebake, declared in `PROGRESS.md`, with the
  evidence renders retaken. Two rebakes in a wave means someone reviews the
  city twice for one change's worth of difference.
- **Every fix ships with its invariant** — a test that would have caught it,
  not just the repair.
- **Every evidence PNG names its retake command.** The flyover shots use
  `WAIT_GROUND=40 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=<tx>,<ty>&h=300..360&pitch=8&night=0" <out>` —
  and never shoot before `__ground.resident` says the painting caught up.

---

## Wave 0 — safety rails (all S, no bake change, land first)

The point of this wave: after it, a bad bake *cannot* be committed silently,
so every later wave gets to move fast.

| # | Fix | Where | Gate |
|---|---|---|---|
| 0.1 | **`citybake` must not write a failing city.** Move the `writeFileSync` below the `errors > 0` test; on errors print them and exit 1 with `city.data.ts` untouched. | `server/src/tools/citybake.ts` | A deliberately broken plan (landmark in water) leaves the asset byte-identical and exits non-zero |
| 0.2 | **The shipped city meets its own checker, in a test.** The freshness test already pays for a full `bakeCity(plan)`; add `checkCity(city, plan)` in the same `describe` and assert zero errors — and pin the warning count (today: one, "8 road tiles run straight into water") so it can shrink but not grow. | `shared/test/city.test.ts` | Red if anyone bakes in a checker error or a ninth wet road tile |
| 0.3 | **Make the freshness gate exact.** The `tiles.length / 1000` (589-tile) slack exists for ~230 session-carved ramp tiles. Skip tiles where `loaded.tiles[i] === T_RAMP` and assert **zero** other differences. | `shared/test/city.test.ts:88` | Any plan/asset drift that is not a ramp fails |
| 0.4 | **CI runs the tests.** A workflow job: `pnpm install`, `pnpm build`, `vitest run`; deploy depends on it. Today `deploy.yml` deploys unconditionally and every invariant in the repo is opt-in. | `.github/workflows/` | A red suite blocks deploy |

## Wave 1 — paint-only visual fixes (renderer only, no bake change)

Each item is independently shippable and retakes its evidence PNG.

**1.1 The runway centreline (S).** Both painters mark every interior row of
the strip — the predicate is "runway above AND below" (`client/src/render/tiles.ts:2119`,
`client/src/three/cityGeometry.ts:542`), so a 7-row strip carries five dashed
lines (`evidence/topdown-runway-grid.png`). Fix: walk to the strip's north
and south edges and mark only the row equidistant from them (even strips:
the northerly of the middle pair), keeping the every-other-column cadence.
One rule, stated once, imported by both painters — the same treatment
`RUN_ROAD` got in BUGS.md §7.1. *Invariant:* `cityTerrain.test.ts` — for
every column of both airstrips, exactly one marked row.

**1.2 Clip course ribbons to ground that carries a road (S, stopgap).** The
ribbon pass clips only against `T_WATER` and `T_BUILDING`
(`tiles.ts:474-485`), so courses whose carriageway the bake reverted paint
casing, fill and dashes across lots and beaches
(`evidence/topdown-lot-dashes.png`, the beach fragments in
`evidence/topdown-bridge-wedges.png`). Widen the clip's exclusion to
lot/sand/grass/park/trees — the casing is meant to reach the *kerb band*, so
sidewalk stays in. This is the stopgap; the honest fix is 2.1, and this clip
stays afterwards as defence in depth. *Invariant:* a painter test that bakes
the Kessler chunk and asserts no marking pixel lands on a lot tile.

**1.3 Bridge bevels must be deck or water, never land (S–M).** Parapet
stair-step notches on the strait and sound bridges render grass wedges over
open sea, and thin water slivers show between the smooth ribbon and the
stepped deck (`evidence/topdown-bridge-wedges.png`,
`evidence/topdown-sound-bridge.png`). Diagnose which neighbour's palette the
wedge inherits on `T_WATER → T_BRIDGE` bevel pairs (`bevel.ts:102-109` built
these deliberately in §31; the *painter's* ground pick is where land leaks
in), then constrain: on a bridge tile the yielded wedge paints deck, the
yielding side paints water. The ribbon/deck sliver closes from the same
place — the deck fill under the ribbon edge extends to the bevel line.
*Invariant:* no pixel of grass palette inside any bridge deck's bounding
strip over water, asserted on the two named crossings' chunks.

**1.4 No zebra on a bridge approach (S).** One zebra fragment floats where
the east strait bridge meets the shore with no crossing street. §35 gates
zebras on course crossings; the approach pocket passes the junction test
without a crossing course. Extend the gate: a zebra needs the crossing
course to *exist at that junction*, not just a junction-shaped widening.
*Invariant:* extend the §35 test with the bridgehead case.

**1.5 Forecourt quads stay inside their block (S). — INVESTIGATED, DEFERRED
to 3.x.** The clip this item asked for already exists: `paintMassApron`
confines the turned apron to the building's own tiles plus the soft ring
beside them, and never over carriageway or water. The softness is canvas
antialiasing on rotated path fills — which 2D canvas cannot turn off — made
larger by the ground texture's upscale. A real fix is a different drawing
strategy (rasterise the quad per texel, or give the apron a deliberate
crisp edge treatment), which is Wave 3 polish, not a paint-pass tweak.

**1.6 Chunk-seam banding (S, diagnosed — residual DEFERRED).** The known
seam cause is already fixed in `ground.ts` (nearest magnification, no
mipmaps, per the comment at its texture setup — the mip chain's clamped
edge texels were the earlier seam grid). The faint residual banding in the
flyover captures needs a machine with a real GPU to chase — under
SwiftShader the render path differs enough that a "fix" verified here
proves nothing about the shipped experience. Revisit when a GPU box is in
the loop.

**1.7 (found while fixing 1.2) Parking bays only where cars park (S).**
The dash columns §2.2's screenshot shows were not course paint at all:
`paintLot` striped every third column of EVERY lot tile in the city as
parking bays, so quarry floors, factory yards and the airfield apron all
read as car parks from the air. Bays now paint only within a tile of an
actual `parkingSpots`/`vehicleHomes` entry (`indexParking`). The clip fix
(1.2) stays — it closes the real §23.2 overhang class — and the beach
fragments at the bridgeheads resolved as boat-mooring furniture, not paint.

## Wave 2 — the one declared rebake (worldgen; every tile change batched)

**DELIVERED — see PROGRESS.md.** What the doing taught, recorded against
each item below: 2.1's trim already ran against the finished tiles, so the
item collapsed to measuring (100.0%) and pinning; 2.2's "110 blocks" was
really 15 once coastal road corridors with no buildable ground were
filtered out, and the fix that mattered was trimming carved bands off
block interiors, not only the unit-slide; 2.3's "streets across the
runway" was the `T_RUNWAY` apron the whole time; and the four
bake-sensitive tests that broke were restaged on found ground — including
`journey()` learning to reject routes with sub-car-length jinks, §41's
follower ceiling surfacing in staging rather than on the road.

All of these change `city.data.ts`. They land as **one** `pnpm citybake`,
one commit, declared in `PROGRESS.md`, evidence renders retaken together.
Wave 0 must already be in (a bad bake cannot slip through while doing this).

**2.1 Trim courses to the finished carve (M).** The root cause behind 1.2:
passes downstream of the carve (quay scraps, stranded-carriageway repair)
remove road but not the course over it — §26.1 named this "wants doing once,
deliberately". Extend `trimCourses` (`bake.ts:767`) to run against the FINAL
tile plane: split a course where its samples leave carriageway (bridge
counts), drop fragments shorter than the §19 stub floor. This attacks the
76%-coverage gap from the course side and empties 1.2's clip of real work.
*Invariant:* course-sample-over-carriageway ≥ 99% (measured by the §26
coverage tool), and zero samples over lot/sand/water.

**2.2 The ring's 110 buildingless blocks (M).** The known §7.6 fix — the
frontage fill writes off a whole unit at every brush with carved road; slide
one tile past blocked ground instead. **First** restage the two police tests
that are locked to the current bake's geometry (`a cruiser facing the wrong
way…`, `an officer keeps the uniform…`) onto found, guaranteed-suitable
ground — the `sparseInput` treatment, already named as the remedy. Then the
one-line fill fix rides the rebake. *Invariant:* buildingless blocks crossed
by arterials < 80 (from 110), asserted in `city.test.ts`.

**2.3 The airfields, tidied in the plan (S).** Marsh End's hut stands on the
runway slab and two streets cross the strip mid-length
(`evidence/topdown-airfield.png`); Gannet Rock's hut likewise abuts its
strip. Move the huts beside the slabs in `city-plan.json`, reroute the two
crossing streets around the strip (or terminate them at its apron), and
teach the checker a new warning: *no street tile inside a runway rect*.
`citybake --fit` names the replacement hut positions.

**2.4 Wet road tiles: from warning to error (S).** Fix the 8 tiles of road
running into water in the plan (they are visible in `--check`'s output), then
promote `cityCheck.ts:280`'s warning to an error so the count stays zero.
The §23.1 bridge-stub class then *fails* a bake instead of warning it.

## Wave 3 — the visual features (bigger, each its own item)

**Status after the wave-3 pass** (details in PROGRESS.md): 3.1 DELIVERED
(stadium/power/quarry recipes with authored `storeys`, one rebake, slab
test inverted and pinned); 3.3 DELIVERED as canopy density — the raised
box stays because it IS `volume.ts`'s collision promise, and dropping it
would draw walkable-looking woodland that is solid; 3.5's list settled as:
pickups offset off the bodies they drop from (done), window salt found
ALREADY fixed (salted per wall plane in `facade.ts`), ramp wedge
DECLINED — the flat ramp is a pinned decision (`cityTerrain.test.ts`
"lays a ramp at street level too") that belongs with `collide3` adoption,
not before it; night grade, `Lights3dLayer` wiring and outline weight
DEFERRED to a GPU box for the same reason as 1.6. 3.2 (paths as courses)
was DEFERRED whole here and has since been DELIVERED — the per-kind
ground rule through the trim, the index, the road net and the painters
is exactly what it took; see the status under 3.2. 3.4 (material transitions)
deferred with it — painted-first remains the right approach when it
comes up.

**3.1 Landmarks with interiors (L, rebake).** The stadium and the power
station are featureless slabs from any altitude
(`evidence/topdown-stadium-slab.png`). The recipe mechanism already exists
(`RECIPES` in `bake.ts`) — this is content, not architecture: Ironside and
The Bowl get a ring of stand-mass with tiered roof heights, an infield of
`T_PARK` with pitch markings, and two gates; Kessler gets turbine halls, a
switchyard, and stacks (tall thin masses the 3D renderer already knows how
to extrude); the quarry gets terraced benches. Each recipe keeps the
approach contract (§6.5). Batch with any other pending rebake. *Gate:*
`citybake` validations green; flyover retakes at the three sites; roof-height
variance inside each landmark footprint > 0 (the slab test, inverted).

**3.2 Paths become courses (M, rebake).** Park and countryside footpaths are
raw tile staircases beside vector-smooth roads
(`evidence/topdown-ring-path.png`). Emit a course per path polyline in the
layout (they are already drawn as polylines before rasterisation), stroked
narrow, no markings, path palette. One mechanism (§16's), second consumer —
which is also the forcing function that keeps course plumbing honest.
*Invariant:* paths appear in `courses` with kind `path`; the §19 recovered-
course simplifier never runs on them (they are authored, not recovered).

*Status: DELIVERED (after 4.5).* The big parks' meander walks ship as
`kind: 'path'` courses — collected where `fillPark` carves them (the same
sink pattern as the pond rings), trimmed by `trimCourses` against their
own ground (pavement, not carriageway — the per-kind rule the deferral
note asked for), validated by the decode, and pinned per kind by the
coverage tests. The road machinery never sees them: the course index, the
road net, the junction discs and the §19 wander pin all filter by kind.
The painter strokes a walk as one smooth pavement ribbon clipped to lawn
and pavement, and pavement tiles under a walk ribbon go back to lawn
per-tile (`pathCover`), so the staircase the carve rasterised never shows
beside the curve that replaced it. The "countryside footpaths" half of
the original wording found no owner: outside the parks nothing carves
footpath tiles from a polyline, and the small parks' straight cross-walks
are axis-aligned (no staircase to fix) — both left as tiles, deliberately.
Two corrections from the retakes' review: the walk is stroked in a real
path palette (packed stone, `palette.path`) after the first cut's
sidewalk grey read as a pale road through the woods; and the retakes
exposed the RURAL saw-tooth — wave 1's clip held road ribbons to the
rasterised band, which the city's kerb bands absorbed and open country
did not — fixed by letting flat open ground under a ribbon's own
apron take the paint — grass, field, sand, and lots, the last added
after a map-wide census of every remaining clip cut found the angled
boroughs' yard edges saw-toothed on every diagonal street (water, walls
and woodland stay refused; the census's full residue is in
PROGRESS.md). Retakes: `evidence/fixed-park-paths.png`,
`fixed-park-paths-south.png`.

**3.3 Woodland stops being a plinth (M, renderer only).** `T_TREES` renders
as a flat 1-tile-high green slab that reads as a stain from above. The
scenery layer already instances canopy blobs; extend it to cover `T_TREES`
areas with clustered canopies (position-hashed, like §34's jitter) over an
understory ground colour, and drop the extruded plinth. Collision is
untouched — trees stay walls. *Gate:* flyover retake at the forest island
and Gannet Rock; draw-call budget unchanged (instanced).

**3.4 Material transitions at built edges (M, rebake or paint).** Sand
meeting quay and cliff-foot is a hard tile edge (§38's open note). Where the
*shore band* already blends by density (A2), the built edges want a 1-tile
transition course of the §9.4 ladder — sand→revetment→quay — either painted
(corner-sampled, no bake change) or baked as a band tile. Decide painted
first; bake only if the painter cannot read enough context.

**3.5 The REVIEW-3D top-down leftovers (S–M each, renderer only).**
In priority order for an overhead camera:
1. **Stunt ramps get geometry** — a wedge mesh at `T_RAMP` plus the 2D
   chevron decal on its face; today frenzy launches cars off flat paint.
2. **Pickups stop occluding bodies** — offset the float or draw pickups
   under corpses in the sort.
3. **Per-building window-hash salt** — kills the global lit-window grid at
   night.
4. **Night becomes a colour grade** — port the 2D blue/red shift + vignette
   into the 3D post pass; wire `Lights3dLayer` into `city3d.html` so the
   night evidence photographs what it claims to.
5. **Outline weight in one unit** — buildings ~1 device px vs cars ~2.8.

## Wave 4 — structural debt (makes every later change cheaper)

**4.1 One district list (S).** `bake.ts:338` and `bake.ts:598` hardcode
`['downtown',…]` positionally. Import `DISTRICT_TYPES` (`types.ts:71`) and
derive the index map; add a compile-time exhaustiveness check. A reorder
today silently mislabels every building.

**4.2 Validate the decoded asset (M).** `decodeBakedCity` (`bake.ts:962`)
blind-casts a ~1 MB generated file while the hand-edited plan gets 170 lines
of validation. Add a structural check (plane lengths, tile-value ranges,
building/shop/landmark bounds, course refs) that runs once at decode; delete
the three dead "pre-X bake" fallbacks. Cost: one pass over the asset at
load; budget it with 4.4.

**4.3 Retire the generator's scaffolding (M).** `fields.ts` shrinks to the
hash/value-noise primitives `bake.ts` actually calls; `params.ts` loses
everything a session cannot vary; `BAKE_SEED`/`WILD_SEED` move next to their
single callers. `plangen.ts` (1,596 lines) is kept **deliberately** — it is
the checker's fuzz harness and the only honest test `checkCity` has — but it
moves out of the client's module graph (server-only export) and its role is
written at the top of the file so the next audit doesn't re-litigate it.

**4.4 A budget for session dressing (M).** `generateCity` costs 1.3–2.1 s
(amenity scans + bevels + shore cut + junctions + road net + lanes), plus a
~210 ms module-scope decode every importer pays. Make the decode lazy,
stop copying the never-written `district` plane (590 KB/session), and time-
box the dressing passes in a perf test with a generous bound (fail at 2× the
p95, so it catches compounding, not noise — the §27.5 worry).

**4.5 `buildLayout` becomes passes (L, the big one).** 2,060 lines whose
correctness is ordering held in prose. Strangler-fig it: name each pass
(`coast`, `boroughs`, `avenues`, `streets`, `blocks`, `shores`, `quays`,
`prune`, …) as a function with declared reads/writes over a shared layout
struct, in an ordered list; the ordering comments become the list itself.
**Gate: the bake is bit-identical before and after every extraction step**
(the `coastCache` equality style, applied to refactoring). Do 2.1 first —
course+carve editing together is the hardest coupling, and the refactor
should inherit it already fixed.

*Wave-4 status: DELIVERED (after 4.6).* `buildLayout` is now ten named
passes — `paintOwnership`, `carveAuthoredRoads`, `layEsplanade`,
`laySeamStreets`, `weaveFabrics`, `stitchBoroughs`, `guardRingAccess`,
`trimBridges`, `mapCliffIslands`, `finishShores` — run from one ordered
list just before the return, so the ordering the section comments held
in prose is now stated once, executably. Three gated steps (wrap the
first four sections, wrap the remaining six, move the invocations into
the list), each verified by `tsc` and the bake hash: sha-256 of
`encodeBakedCity(bakeCity(plan))` stayed `aa344019f39c43111679a052`
through every step, and the full suite is green (942/942). Two
deliberate deviations from the sketch above: the passes are closures
over the function-scope planes rather than readers of a threaded
struct — the planes were already shared state, and closures let every
step be a pure wrap the hash could hold to — and the coast was already
its own function (`paintCoast`), so the first wrap was ownership, with
the block cut staying inside `weaveFabrics` where lattice carving and
block records are one loop. Only two declarations needed hoisting:
`preEsp` (the pre-esplanade tile snapshot, now taken at the top of
`layEsplanade`) and `bandInner` (the §39 band curve the return ships as
`banks`); every other shared declaration was audited as order-insensitive
— computed from the coast masks and the plan alone — before any wrapping.

**4.6 The lattice-merging design change (L, design doc first).** §28.3
measured that suppression cannot finish it: 1,289 street-on-street tiles,
34.3% of dry land is road against 13.6% building. The identified fix is a
*design* change — band each borough against ONE shore instead of the nearest
water — which changes how borough fabrics are laid, so it wants a short
design note (which shore per borough, what happens at the Old Quarter's two
waterfronts) agreed **before** code, then lands as its own rebake with the
§28 measurements as the gate: merged tiles < 700, road share of dry land
< 30%, and the flyover retake of the Old Quarter no longer showing a tarmac
lake (`evidence/topdown-oldquarter-tarmac.png` is the before picture).

### 4.6.1 The design note — APPROVED AND DELIVERED (see PROGRESS.md)

Delivered with one correction the code made to the note: the two-family
merge lived in the contour fabrics (The Terraces, Beachfront, The Docks),
not the Old Quarter, whose fabric is an angled grid — the note's mechanism
was right and its borough map was wrong. Gates, measured: merged sheet
centres 276 → 211 with the contour class gone (pinned ≤ 230); road share
34.2% → 32.9% — the <30% gate is not met and cannot be met by banding
alone, because the residual is §28's avenue-crossing ceiling; +213
buildings on the freed ground. The original note follows, kept for the
record.

The mechanism today: a shore borough's long streets are traced as
iso-lines of the water's distance field (§16's contour fabric), and that
field answers "distance to the NEAREST water". A borough with water on two
sides — the Old Quarter between the harbour and the strait, Sunridge
between seafront and lagoon — therefore lays two contour families that
meet mid-borough, and where they meet, streets land on streets: the
merged tarmac sheets of `topdown-oldquarter-tarmac.png`, unfixable by
suppression because neither family is wrong.

**The proposal.** Each borough names its banding shore in the plan — one
per borough, authored like everything else in `city-plan.json`
(`bandShore: "harbour" | "strait" | …`, naming a geography feature). The
distance field a borough's contour streets trace is computed from THAT
shore's ring only. Consequences, borough by borough:

- **Kelvin (Old Quarter)** bands against the harbour — the historic
  waterfront its fabric already visually follows. Its strait side then
  gets what a one-shore fabric gives every far edge: the LAST contour
  street runs roughly parallel to the strait, and the §14 seam machinery
  (which already handles borough-to-borough edges) closes the gap to the
  water with short connector streets, not a second contour family.
- **Sunridge** bands against the seafront; the lagoon side becomes a
  seam-closed edge the same way.
- **Ravenhill, Marsh End, Port Vasco** each have one dominant shore
  already; naming it changes little and costs nothing.
- The checker learns: `bandShore` must name a geography feature whose
  ring touches the borough polygon, and every borough with a contour
  fabric must name one.

**Open question for the owner** (the reason this is a note, not a diff):
whether the Old Quarter's strait frontage should keep a genuine
water-following esplanade street (one authored road in the plan would do
it — the §33 esplanade treatment) or take the seam-closure default. The
note recommends the authored esplanade: the strait is the city's centre
stage, and its frontage deserves a drawn line, not a fallback.

**Gates, unchanged from above:** merged street-on-street tiles < 700
(from 1,289), road share of dry land < 30% (from 34.2%), Old Quarter
retake with no tarmac lake, and the §14 permeability floors still met on
every seam the change touches. Own rebake, own commit, after approval.

---

## Sequence, size, risk

| # | Work | Size | Risk | Rebake? | Gate |
|---|---|---|---|---|---|
| 0.1–0.4 | Safety rails | S | none | no | broken plan can't ship; CI red blocks deploy |
| 1.1 | Runway centreline | S | none | no | one marked row per column |
| 1.2 | Course clip stopgap | S | low | no | no markings on lot chunks |
| 1.3 | Bridge bevel palette | S–M | low | no | no grass in deck strips |
| 1.4 | Zebra approach gate | S | none | no | §35 test + bridgehead case |
| 1.5–1.6 | Forecourt clip, chunk seams | S | none | no | retakes |
| 2.1–2.4 | **The rebake**: course trim, ring blocks, airfield plan, wet roads | M | medium | **one** | coverage ≥99%; blocks <80; new checker rules; all renders retaken |
| 3.1 | Landmark interiors | L | low | yes (batch) | roof-variance test; retakes |
| 3.2 | Paths as courses | M | low | yes (batch) | path courses exist; retake |
| 3.3 | Woodland canopy | M | low | no | retake; draw budget |
| 3.4 | Material transitions | M | low | maybe | ladder test at built edges |
| 3.5 | REVIEW-3D leftovers | S–M | low | no | per-item |
| 4.1–4.4 | Enum, decode validation, scaffolding, perf budget | S–M | low | no | suite green; perf bound |
| 4.5 | Layout passes | L | **medium** | no (bit-identical) | bake equality per step |
| 4.6 | One-shore banding | L | **high** | yes (own) | §28 metrics; Old Quarter retake |

Risks, ranked: **(1)** 4.6 changes the fabric of every waterside borough —
design note first, own rebake, and it goes last for a reason. **(2)** 2.2's
police-test restaging is the only place this plan touches server test
staging; do it before the fill fix, not with it. **(3)** 2.1 can eat courses
players' traffic follows — run the full bot suite on the rebake, not just
worldgen tests. **(4)** 3.3 trades a plinth for instanced canopies; watch
the draw stats the flyover HUD already prints.

What this plan deliberately does not do: no new generator, no procedural
revival, no touching `collide3`/volume adoption (that is a sim feature with
its own plan in `BUGS.md` §6, not a worldgen fix), and no second rebake
inside a wave. The city changes shape twice in this whole plan — Wave 2 and
4.6 — and both times the diff is reviewable because Wave 0 made it so.
