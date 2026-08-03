# WORLDGEN.md — world generation: approaches, fit, and placement doctrine

Research notes on procedural city generation for this game: what the
generator does today, what the field offers, which techniques actually fit
this codebase's constraints, and how the elements of the game should be
placed. Written the way `RESEARCH.md` and `CAR-AI.md` are written — every
claim cites the file it comes from, and the recommendations are ranked, not
listed. `ROADMAP.md` owns sequencing; this document exists so worldgen
arguments can cite something.

---

## 1. Where the generator is today

The city is a **pure function of (seed, params)** — `generateCity`
(`shared/src/world/generate.ts:33`). The server picks the seed, ships
seed+params in the welcome message, and the client regenerates the identical
map locally; geometry never crosses the wire. One rng stream is consumed in a
fixed order, offset from the sim's stream (`generate.ts:36`) so the two never
share a sequence.

The pipeline, in its load-bearing order:

| # | Pass | Technique | File |
|---|---|---|---|
| 1 | District seeds | Voronoi nearest-seed, biased (downtown centre, industrial edge) | `districts.ts:16` |
| 2 | River | Sine meander, carved **before** roads | `roads.ts:157` |
| 3 | Roads | Jittered arterial grid + recursive subdivision to district block size | `roads.ts:44` |
| 4 | Bridges | Arterial∩river tiles become `T_BRIDGE`; everything else reverts to water | `generate.ts:90` |
| 5 | Blocks | Per-district fill: packed rects, house rows, slabs-on-lots, parks with paths/ponds | `buildings.ts:116` |
| 6 | Landmarks | Named oversized structures by district preference + min-distance | `amenities.ts:569` |
| 7 | Shops | Candidate buildings by district/size, carved walk-in interiors | `amenities.ts:158` |
| 8–16 | Amenities | Deterministic predicate scans: parking, peds, props, pickups, boats, cranes, payphones, ramps, spawns | `amenities.ts` |
| 17 | Turf | Staggered-ring Voronoi over coarse cells, no rng | `turf.ts:22` |

Generation is ~56 ms for 240×240 tiles (`pnpm mapgen --seed=7`), well inside
any client budget.

**What the renders show** (seeds 7 and 42, via `pnpm mapgen`): the river is
genuinely good — it meanders, it separates, the bridges are scarce enough to
be chokepoints. The rest reads as *texture, not geography*: a uniform
rectilinear grid running wall-to-wall to all four map edges, districts as a
Voronoi patchwork of colour with no gradient or centre, arterials (4 tiles)
barely distinguishable from secondaries (3 tiles), and every block a
rectangle of rectangles. `REVIEW.md:139` called the pre-river map "honest and
boring — a texture"; the river fixed the *barrier* problem, not the
*sameness* problem.

What the codebase has already learned, the hard way (worth keeping as law):

- **Passes must not quietly feed each other** — clinics registering before
  `placeShops` moved shop placement, which moved carved floor, which moved
  player spawns, which broke a combat test (`amenities.ts:671`).
- **New content should prefer rng-free derived scans** — parking
  (`amenities.ts:277`), cranes, payphones and turf consume no randomness, so
  adding them shifted nobody else's city. Any new draw reshapes every seed;
  `ROADMAP.md:581` says to expect that but state it.
- **Records matter as much as tiles** — `fill` refuses to paint water but the
  Building *record* is what doorways derive from, so footprints touching the
  river are rejected outright (`buildings.ts:40`).

---

## 2. The constraints that decide everything

Any approach evaluated below is evaluated against these, because they are
unusual and they disqualify most of the literature's headline techniques:

1. **Bit-exact determinism across hosts.** Server and every client
   regenerate the map independently (`types.ts:99`). Anything float-order
   dependent, iteration-order dependent, or backtracking-with-heuristics is
   a desync risk, not a style choice.
2. **Tile grid, `Uint8Array`, 16 px tiles.** Collision (`collide.ts`),
   traffic's road graph (`sim/roadgrid.ts`), prediction and the renderer all
   consume tiles. Continuous-space road curves would have to quantise back
   to tiles anyway.
3. **Budgeted output.** Props are capped at 400 for the wire
   (`amenities.ts:36`); interest management (`INTEREST_RADIUS`) assumes
   entity counts stay sane. Worldgen output is bandwidth.
4. **A multiplayer sandbox, not a campaign.** The map must be *fair* (16
   spread spawns, shops shared between districts), *legible* (you respawn at
   a hospital and must know where you are), and *replayable* (each seed a
   recognisably different city).
5. **Testable invariants.** The house style is worldgen tests across many
   seeds (`shared/test/world.test.ts`, `landmarks.test.ts`,
   `water.test.ts`). A technique that can't state its invariants ("river
   always crosses edge-to-edge", "every block reachable") doesn't ship.

---

## 3. The approaches, surveyed

### 3.1 Grid + subdivision (what we have)

Jittered arterial lattice, then recursive splitting of the interstitial
regions until blocks fit the district's target size — structurally a BSP over
the ground plane. This is the *correct genre choice*: the games this one
descends from are rectilinear grid cities, top-down readability demands
axis-aligned streets, and the traffic lane-follower (`sim/traffic.ts`) and
tile collision get simple, honest geometry. Fast, deterministic, trivially
invariant-testable. Its weakness is the one on display in the renders:
self-similarity at every scale and edge-to-edge uniformity.
**Verdict: keep as the skeleton.**

### 3.2 Voronoi partitions

Used twice already (districts, turf) and both uses are sound — Voronoi is
the right tool for "contiguous ownership of space" (`turf.ts:5` argues this
well). Its failure mode is also on display: with euclidean distance and
uniform seeds, districts come out as similarly-sized confetti patches with no
macro logic. The fix is not a new algorithm but **weighted/biased distance**:
shrink downtown's effective radius, grow residential's, and blend a
distance-from-centre gradient into the lookup so the classic concentric-zone
city (dense core → commercial ring → residential ring → industrial rim)
emerges. That is a ~15-line change to `districtLookup` (`districts.ts:55`),
not a rewrite. **Verdict: keep, add weights + a centre gradient.**

### 3.3 Agent/growth-based road networks (L-systems, tensor fields)

The academic mainstream: Parish & Müller's CityEngine L-systems (2001),
tensor-field street networks (Chen et al. 2008), space-colonisation growth.
They produce beautiful organic networks — ring roads, radial avenues, curved
suburbs. Against our constraints they score badly: continuous-space output
that must be re-quantised to 16 px tiles, global snapping/intersection
resolution steps that are order-sensitive (determinism risk), no natural way
to state invariants, and the organic look actively fights top-down
at-speed readability and the lane-follower. The *one* idea worth stealing is
cheap: **a single diagonal or radial avenue** carved through the grid breaks
self-similarity at almost no cost (a Bresenham band of `T_ROAD`, carved with
the arterials so it bridges the river). **Verdict: reject the machinery,
steal one diagonal avenue.**

### 3.4 Noise fields (Perlin/simplex/value noise)

Not a generator of structure but of *variation*: land/water masks,
density gradients, per-block height or wear. Deterministic, cheap, seedable
— and the codebase already contains the seed of it: `hash2` in `turf.ts:100`
is a coordinate hash, i.e. one octave of value noise. The two highest-value
uses here: a **coastline/bay** (threshold a low-frequency field near one or
two map edges, replacing the dead map-border with a waterfront), and a
**density field** modulating block subdivision depth and building coverage so
downtown visibly *thickens* rather than merely recolouring. **Verdict:
adopt, small doses, macro scale only.**

### 3.5 Wave Function Collapse / constraint solving

Fashionable, and genuinely good at *local texture* — junction tiles, facade
variety, park furniture arrangements — from a small example set. But global
structure via WFC means contradiction/restart handling (non-deterministic
unless carefully seeded and ordered), unbounded worst-case time, and no way
to promise "the river always crosses the map". For a 240×240 map regenerated
on every client, that is the wrong risk profile. Everything WFC would give us
locally, the renderer's autotiling and the prop pass already approximate.
**Verdict: reject.**

### 3.6 Prefab stamps / chunk grammars

Hand-authored templates placed by rule — how Diablo-likes and most roguelikes
get set pieces procedural methods can't invent. The landmark pass
(`amenities.ts:569`) is already a degenerate version of this: it stamps
*solid rectangles*. The upgrade is landmarks with **interior structure**: a
stadium as a ring of building around a `T_LOT` field with two gates; a power
station as slabs + fenced yard; a container yard as rows of `T_LOT` obstacles
near the docks. Each is a small tile template with rotation, placed by the
existing candidate-block logic. Highest visual return per line of code of
anything in this survey, because landmarks are precisely the places players
navigate by and fight over. **Verdict: adopt for landmarks; never for filler.**

### 3.7 Real-map import (OSM)

Off-brand: this game's identity is a fresh seeded city per session
(`SEED` env var), and street-accurate real cities bring licensing of nothing
but problems — irregular geometry the tile grid mangles, and no seed
variety. **Verdict: reject.**

### 3.8 Multi-level geometry (the genre's elevated roads)

The second game of the genre had elevated highways and multi-storey
interchanges. Here that means a second tile layer, per-entity level state
threaded through collision — which lives **inside the prediction hot loop**
(`ROADMAP.md:467` flagged the same for water, and water was one bit of
medium, not a whole z-axis) — plus snapshot, hash and interest-management
implications. The stunt-jump `z` (`ROADMAP.md:515`) is as much vertical as
this sim should buy. **Verdict: reject, permanently is fine.**

---

## 4. What suits this game

**Keep the skeleton, fix the silhouette.** The pipeline architecture —
ordered passes over a tile array, one rng, pure function of seed — is
exactly right and matches how the sim consumes the world. The gap is that
every seed produces the *same kind* of city: same rhythm everywhere on the
map, same shape every seed. Ranked by play-value per risk:

1. **A coastline** (noise-thresholded bay along 1–2 seed-chosen edges,
   carved with the river pass, before roads). Kills the dead map edge,
   gives industrial a waterfront to hug (`districts.ts:32` already pushes it
   edge-ward), gives boats somewhere to go, and makes the minimap silhouette
   of every seed unique. The collision/medium work that made the river
   possible is already paid for.
2. **District gradient + weighted Voronoi** (§3.2). Downtown becomes *the
   centre*, density falls off with radius, industrial holds the rim. The
   city gains the single thing players orient by in every real city: a
   downtown you can see from anywhere on the minimap.
3. **Road hierarchy that reads.** Widen arterials to 5–6 tiles with a
   1-tile median strip (new cosmetic tile), and let *some* secondaries in
   residential dead-end instead of always connecting — the current
   subdivision guarantees a perfect lattice, and perfect lattices are why
   chases lack decisions. Both are changes inside `generateRoads`.
4. **One diagonal avenue** (§3.3), seed-gated so only some cities have it.
5. **Structured landmark stamps** (§3.6), plus 1–2 new kinds sited by the
   new geography: docks on the coast, a market square downtown.
6. **A city-archetype roll at the top of `generateCity`**: one early draw
   choosing river-vs-bay-vs-both, arterial counts, downtown offset. Cheap
   macro variety; every seed stops being "the same city, re-shuffled".

Items 1–2 change the game; 3–6 are polish in descending order. All of them
preserve determinism, the tile substrate, and the existing invariant tests.

---

## 5. How to make it good

Craft principles, mostly already half-present in the codebase — stated here
so they're policy rather than habit:

- **Legibility beats realism.** Every decision should serve a player at
  240 px altitude doing 300 px/s: axis-aligned streets, high-contrast
  district palettes, landmarks with unique silhouettes, the river/coast as
  the orientation spine. A generator feature no one can perceive at driving
  speed is not a feature.
- **Geography is chokepoints.** The river works because crossings are
  scarce (`roads.ts:70` refuses to bridge secondaries). Apply the same
  logic to everything new: a coastline with two piers, a stadium with two
  gates, a walled yard with one way in. Places are interesting where
  movement is constrained, and this is doubly true in multiplayer.
- **Invariants over screenshots.** Extend the house-style seed-sweep tests
  with the reachability invariant the roadmap gated D1 on
  (`ROADMAP.md:479`): flood-fill the road network, assert one component;
  assert every shop doorway, hospital door, crane and payphone is on/beside
  a reachable tile; assert quotas across 50 seeds. Any new pass ships with
  its invariant.
- **Instrument `mapgen`.** It already prints counts
  (`server/src/tools/mapgen.ts`); add per-district tile shares, block-size
  histogram, p50/p95 walk distance to nearest hospital/gun shop/spawn, and a
  `--sheet` mode rendering N seeds into one contact image. Tuning worldgen
  by eyeballing one seed is how uniformity went unnoticed; distributions
  across 20 seeds are the review tool.
- **Keep the rng discipline.** New scarce/unique things draw from the
  single stream in pipeline order; new dense filler uses rng-free ordinal
  scans (§6). Every added draw is declared in `PROGRESS.md` as a
  seed-breaking change, per `ROADMAP.md:581`.
- **Params in `worldgen.json`, invariants in tests, magic in neither.**
  The parser (`params.ts:60`) hard-fails on missing numbers — keep that; a
  silently-defaulted param was how `waterWidth` sat unread for a whole wave
  (`REVIEW.md:79`).

---

## 6. Placing the elements

The game currently places fifteen element classes, and — this is the
underappreciated strength of this codebase — they already fall into **four
placement patterns**. New content should pick a pattern, not invent one:

| Pattern | Mechanism | Used by | Use when |
|---|---|---|---|
| **Anchor draw** | rng pick from a district/size-filtered candidate list + min-distance rejection | landmarks, shops, player spawns | Scarce, unique, high-stakes things |
| **Ordinal scan** | rng-free row-major sweep over a tile predicate, take every Nth, min-distance guard | parking, peds, props, pickups, boats, cranes, payphones, ramps | Dense filler; anything added after ship |
| **Derived registration** | no placement at all — computed from earlier records | clinics-from-hospitals, parking-from-spawns | The element is a *view* of another element |
| **Field partition** | Voronoi/hashed-wobble over coarse cells | districts, turf | Contiguous ownership of area |

Doctrine for placing everything well, in the order the pipeline runs:

1. **Anchors first, filler last — always.** Landmarks stamp before shops
   pick buildings (`generate.ts:100`), and filler scans run last so they
   flow around everything. Any new set piece goes in at the landmark stage.
2. **Place by role in the death/economy loop, not by aesthetics.**
   Hospitals are respawn UX; police stations are release points; gun shops
   arm players; cranes pay them. Each has a *coverage requirement*, which
   random draws only meet by luck. The upgrade: place the first hospital
   randomly, then each subsequent one at the **farthest reachable point**
   from those placed (farthest-point sampling over a BFS distance field on
   road tiles — deterministic, no rng). Same for police stations and spray
   shops. This turns "4 hospitals somewhere" into "no death more than X
   tiles from a respawn you can predict", which is the actual requirement.
3. **Distance fields are the placement tool this codebase is missing.** One
   BFS over road/sidewalk tiles from a seed set is O(tiles), deterministic,
   and answers every question placement keeps half-answering with Manhattan
   guards: coverage (above), "near a road" (`placeCranes`' ring probe,
   `amenities.ts:716`), spawn fairness (assert every player spawn within
   walking distance of a road and a shop), and pickup siting ("a small
   detour", currently approximated by park/lot tiles). Build it once in
   `world/`, use it everywhere, test against it.
4. **Fair scarcity for contested resources.** In multiplayer, pickup and
   crane placement is balance. Spread power-ups per-turf rather than
   globally (the `PICKUP_CYCLE` at `amenities.ts:435` keeps kinds fair;
   coverage should be fair too), and deliberately site a few high-value
   pickups on turf *borders* — contested ground is where a sandbox makes
   its own missions.
5. **Doorways, approaches and reach are part of the element.** The
   codebase's best placement bugs were all "the thing exists but can't be
   used": doors in the water (`buildings.ts:33`), moored boats overlapping
   the bank (`amenities.ts:496`), garages you can't drive into
   (`amenities.ts:146`). Every placed element must state its *approach*
   (door tile, mooring clearance, run-up) and validate it at placement
   time. The invariant test then checks the approach, not the coordinate.
6. **Budget at the source.** `MAX_PROPS`-style caps, with stride sampling
   across the whole list rather than truncation (`amenities.ts:381` learned
   this) so density stays uniform under any cap.
7. **Missions/economy read placement, never extend it.** Payphones
   (`server/src/missions/missions.ts`) and jobs consume worldgen output at
   runtime. Keep that direction of dependency: the sim asks the map "where
   is the nearest X", worldgen never asks the sim anything.

---

## 7. Sequenced next steps

Smallest first inside each slot; each ships with its seed-sweep invariant:

1. **Instrument `mapgen`** (stats + `--sheet`) — the review tool everything
   below is judged with. No sim impact, no rng impact.
2. **Distance-field helper** in `shared/src/world/` + retrofit its
   invariants (road connectivity, approach reachability) into
   `world.test.ts`. Pure addition.
3. **Weighted districts + centre gradient** (§4.2) — one function, big
   legibility win. Seed-breaking; declare it.
4. **Coastline** (§4.1) — reuses the entire river/bridge/medium machinery.
   Seed-breaking; the big one.
5. **Farthest-point hospitals/police/spray** (§6.2) — placement quality
   without new content.
6. **Arterial identity + occasional dead-ends** (§4.3), then **landmark
   stamps** (§4.5), then the **archetype roll** (§4.6) once there are two
   macro features (river/bay) to choose between.

What this document deliberately does not recommend: L-system/tensor road
networks, WFC, OSM import, and multi-level geometry — rejected in §3 for
determinism, tile-substrate or scope reasons, and named here so they stay
decisions rather than omissions.

---

## 8. Scaling up: from a city to a region

Second wave of this research, for the bigger vision: a larger map, more and
different districts, custom buildings, real industry, beaches, swimming,
islands, hills, and nature outside the urban core. In one sentence: **the
map stops being "a rectangle of city with a river through it" and becomes
"a landmass with a city on it"** — and almost all of it is feasible inside
the current architecture, with exactly two genuinely expensive items:
swimming (sim/prediction) and population scaling (server spawning).

### 8.1 The ceilings, measured

Checked against the code, not assumed:

- **Wire format: no size ceiling.** Positions are zigzag-LEB128 varints of
  the sim's `q8` grid (`net/binary.ts:204`), not fixed-width — a coordinate
  costs 3 bytes from 2 048 px up to ~262 000 px (16 384 tiles). Any map we
  could ever want fits without touching the codec.
- **Worldgen time: linear.** 56 ms at 240² tiles → ~220 ms at 480². Fine
  even on the client, and `mapgen` can verify.
- **Client rendering: already viewport-bound.** Tiles bake per-chunk into a
  bounded cache (`client/src/render/tiles.ts:70`); map size doesn't change
  frame cost, only the minimap needs a scale pass.
- **The real ceiling: population is global.** `PED_COUNT=200`,
  `MAX_VEHICLES=48` and `MAX_PROPS=400` are *per session*
  (`server/src/session.ts`, `amenities.ts:36`). Double the map edge and
  density quarters: the city empties. Interest management already filters
  the wire per player (`INTEREST_RADIUS=600`), and `ROADMAP.md:141` already
  designed ped top-up *outside* every player's interest radius — the fix is
  to finish that pattern for peds AND traffic and make counts
  density-near-players rather than session totals. **This is the gate for
  any size increase**, and it's server-only (no prediction risk).
- **The design ceiling nobody measures:** 4–8 players on 4× area is a
  quieter game. `REVIEW.md:167` complained everything was 11 s away;
  the inverse failure exists too. Recommendation: **360×360 (2.25× area)
  with the spawner rework, 480×480 only after the region has content**
  (islands, nature) that makes emptiness read as *landscape* rather than
  as a bug.

### 8.2 The features, each given a verdict

**More/different districts — cheap, do freely.** `DISTRICT_TYPES`
(`types.ts:23`) is a closed list consumed by block fill, shops, landmarks,
props and palette. Adding `beach`, `harbour`, `oldtown`, `rural`, `nature`
is mechanical: an entry in `worldgen.json` blockSize/districtSeeds, a case
in `fillBlock` (`buildings.ts:132`), palette rows, and preference lists in
`amenities.ts`. The one rule: a district must earn its slot with a distinct
*fill strategy and amenity profile*, not just a colour — that was
`REVIEW.md:158`'s complaint and it stays the bar.

**Custom buildings — the §3.6 stamp system, now load-bearing.** At region
scale, prefab stamps stop being landmark polish and become the identity of
each district: harbour cranes over container rows, an oldtown church on a
square, farm clusters in `rural`, a pier with a funfair on `beach`. Stamps
are tile templates with an approach contract (§6.5), placed by the existing
candidate-block machinery. Build the stamp *mechanism* once, then districts
become content, not code.

**Industry — a district upgrade, not a system.** Industrial already exists
(slabs on lots, cranes, sparse lamps); what it lacks is *purpose and
geography*. Move it onto the waterfront the coastline creates (it already
hugs edges, `districts.ts:32`), stamp a container yard and a factory with a
walled yard, and let the existing crane/job economy live there. Fenced
yards with one gate are §5's chokepoint principle applied.

**Beaches — cheap, high charm.** A `T_SAND` band wherever land meets
sea/lake, 2–4 tiles wide from the same noise field that makes the coast
(`palette.json` has had `sand` since the beginning; `ROADMAP.md:459`
anticipated the tile). Walkable like `T_LOT`, no traffic routing, beach
props (umbrellas, towels — new prop kinds in the ordinal scan), peds spawn
there. No sim risk: sand is just ground.

**Swimming — the one real sim feature, and a design decision first.**
Mechanically it's the D1 water pattern again: a per-player swim state when
standing tiles are water, slow movement, no weapons, threaded through
`moveWithCollision` — inside the prediction hot loop, so it lands alone,
with tests, like `ROADMAP.md:577` demanded for water. But the *design*
question matters more: if everyone can swim everywhere, bridges stop being
chokepoints for on-foot play and the river's whole reason (`roads.ts:70`)
erodes. The recommendation: **split water into `T_SHALLOW` and deep.**
Shallows appear as a band off beaches and around islands — swimmable,
visibly lighter in palette; deep water stays boat-or-drown. Beaches become
the region's soft edges, bridges keep their teeth, boats keep their
monopoly on open water. One new tile, and the swim code only ever touches
`T_SHALLOW`, which also caps its prediction blast radius.

**Islands — the restructuring feature.** Everything else in this document
is a pass added or upgraded; islands change the *frame*: generation must
start from a *landmass mask* (low-frequency noise thresholded into one
guaranteed main landmass plus 1–3 satellites), and roads, districts and
blocks generate **per landmass** instead of over one rectangle. The
subdivision machinery survives — it just runs inside each landmass's
bounding regions with water clipping (which `fillBlock` and the amenity
scans already respect, `buildings.ts:26`). Connectivity policy per island,
decided by the archetype roll: causeway/bridge (drivable — an arterial
extended across shallows), or **boat-only** — which finally gives boats a
job, and gives the island whatever the map wants to gate: a gun shop with
the best stock, a frenzy site, a gang home. Invariants shift from "every
block reachable by road" to "every landmass reachable by road *or* has ≥ 2
moorings, and every landmass's interior is one connected component".

**Hills — adopt as input, keep rejecting as physics.** §3.8's rejection of
multi-level geometry stands: no z in collision, no elevation in the
prediction loop. But a **height field as a *generation* input** costs the
sim nothing and buys the region its shape: one more noise field, consumed
three ways — (1) land-use: steep tiles refuse city and become `nature`,
flat coastal land attracts downtown, so the city nestles instead of
tiling; (2) rendering: per-tile brightness/palette shift by height band,
which reads as relief from above at zero sim cost; (3) **cliff lines**:
where the height gradient crosses a threshold, a 1-tile solid `T_CLIFF`
edge — hills gain gameplay meaning (barriers, switchback roads through the
gaps, scenic dead-ends) using the same "solid tile" physics buildings
already have. That is hills with zero new movement code.

**Nature — the space between, made deliberate.** At region scale the map
gains its first non-urban land use: forest (tree props dense enough to
block driving lines, or a `T_FOREST` tile that slows nothing but blocks
building), meadows (`T_FIELD` finally used — it's tile 0 and appears
nowhere today), dirt tracks (narrow road-subdivision with a different
palette connecting rural stamps to the arterial net), and the existing
park fill promoted to open country. Nature is cheap on every budget —
few entities, no interiors, ordinal-scan props — and it's what makes
"bigger" feel like a place rather than more city. The one discipline:
nature still needs *destinations* (a campground, a lighthouse, a quarry —
stamps again) or it's dead air between fun.

### 8.3 The region pipeline

`generateCity`'s pass list, revised macro-first. Passes marked ★ are new;
everything else is today's code running inside a mask:

1. ★ Archetype roll (river / bay / archipelago, arterial counts, downtown
   offset) — one early draw
2. ★ Height field + landmass mask (noise; guarantee main landmass share)
3. ★ Water classification: deep / `T_SHALLOW` / `T_SAND` bands; river
   carved as today where the archetype has one
4. ★ Land-use: weighted-Voronoi districts *modulated by* height and coast
   (downtown flat+central, harbour/industry on water, nature on slopes)
5. Roads per landmass (today's arterials+subdivision, clipped; ★ causeways
   between bridged landmasses; ★ dirt tracks in rural)
6. ★ Cliff lines from height gradient
7. Blocks/buildings per district (today's `fillBlock` + ★ new district
   cases)
8. Landmarks → ★ stamps (harbour, oldtown, rural, beach set pieces)
9. Shops, then all amenity scans (today's passes + ★ beach props,
   ★ per-island mooring quotas)
10. Turf (urban landmass only)

### 8.4 Order of work

Dependency-honest sequence; sim-risk items isolated as house rules demand:

| # | Work | Layer | Risk |
|---|---|---|---|
| 1 | Stamp mechanism + 2 new districts (harbour, rural) on the current map | worldgen | low |
| 2 | Height field + landmass mask + coast/`T_SAND` beaches (map still one landmass) | worldgen | low, seed-breaking |
| 3 | Population spawner rework: density-near-players peds/traffic (finishes `ROADMAP.md:141`) | server | medium |
| 4 | Map to 360×360; re-measure bandwidth + bot gates | config | low, gated on 3 |
| 5 | `T_SHALLOW` + swimming, landed alone with prediction tests | **sim** | **high** |
| 6 | Islands: per-landmass roads, causeways, boat-only policy, mooring invariants | worldgen | medium |
| 7 | Cliff lines + nature content (forest, tracks, rural stamps) | worldgen | low |
| 8 | 480×480 if the region's content earns it | config | low |

Steps 1–2 need nothing from anyone and change how every seed looks; step 5
is the only line in this table that can desync a client, and it ships the
way D1's water did — alone.

---

## 9. The better architecture: layers, fields, and transitions

Third wave of this research. §8 proved the region vision *feasible* by
adding passes to the existing pipeline; this section says that's not good
enough, and designs the architecture the region actually deserves. §4's
"keep the skeleton" survives at the *algorithm* level — subdivision,
tiles, determinism — but not at the *structure* level.

### 9.1 What is actually wrong with the current architecture

Stated as architecture, not as bugs — every one of these is a cost paid
repeatedly, with receipts:

1. **Tiles are the only shared truth.** Roads exist only as painted
   `T_ROAD` cells, so every consumer reverse-engineers meaning from
   pixels: traffic probes tiles ahead of the bumper (`roadgrid.ts:7`),
   doorways are found by scanning building perimeters for sidewalk
   (`amenities.ts:56`), parking rediscovers kerbs and carriageway width
   tile-by-tile (`amenities.ts:277`). Knowledge the generator *had* —
   which road is an arterial, which side a lot fronts — is thrown away at
   rasterisation and expensively re-guessed downstream.
2. **One serial rng thread couples everything.** A draw added in any pass
   reshapes every city (`ROADMAP.md:581` accepts this as a standing
   risk). The architecture makes extension *globally destructive*, which
   is why half the amenity passes contort themselves to consume no rng at
   all.
3. **Ordering is load-bearing and implicit.** `registerClinics` carries a
   comment explaining a combat test that broke because a pass ran one
   slot early (`amenities.ts:671`). Discipline currently substitutes for
   structure; discipline doesn't scale to a §8-sized pipeline.
4. **Districts are painted, not placed — and borders are cliffs.** A tile
   is `residential` or `industrial` with nothing in between; block size,
   lamp spacing and building style all switch at a hard Voronoi edge.
   Nothing in the map fades, which is exactly why the renders read as
   patchwork.

### 9.2 The design: five immutable layers, tiles last

Generation becomes a stack of **typed, immutable layer artifacts**. Each
layer reads the ones below it and may never mutate them; tiles stop being
the medium of communication between passes and become the *final output*.
The external contract — `generateCity(seed, params): CityMap` — does not
change, so sim, client, prediction and tests are untouched.

- **L0 · Fields.** Continuous scalar functions over the map: `height`,
  `coast` (distance to sea), `density` (urban intensity), `wildness`.
  Deterministic value-noise + shaping curves, seeded per-field (§9.3),
  order-free, sampled anywhere. Everything downstream that should *fade*
  reads a field instead of asking "which district am I in".
- **L1 · Classification.** Land-use per coarse cell, *derived by scoring
  L0* (downtown wants flat+central+dense, harbour wants coast+flat,
  nature wants steep or wild) rather than by seed points. Districts
  become emergent connected regions with computed borders — and the
  transition system (§9.4) is defined here, on ranked land-uses, before a
  single tile exists.
- **L2 · Networks.** Roads as a **graph**: typed nodes (junction, bridge
  head, dead end, gate) and typed edges (highway, avenue, street, track)
  carrying width, one-way flag and land-use context. Built by today's
  algorithms — arterial lattice + subdivision translate directly to graph
  construction — but validated *as a graph*: one connected component per
  landmass, island access policy, no highway meeting an alley without a
  step-down junction. Rasterised to tiles afterwards. The graph ships in
  `CityMap` as a new field, and traffic, police roadblocks
  (`ROADMAP.md:425`) and future mission routing consume it instead of
  probing paint.
- **L3 · Parcels.** Block faces of the road graph subdivided into **lots
  with frontage** — each lot knows which edge it faces and where its
  access point is. Buildings, stamps and shops are placed *on lots*, so a
  doorway is a property assigned at placement, not a perimeter scan that
  can fail after the fact; `findDoorway` and its water-doorway bug class
  (`buildings.ts:33`) disappear structurally.
- **L4 · Content.** Landmarks, stamps, amenities — today's passes, but
  querying L0–L3 (distance fields, lot lists, graph positions) instead of
  scanning tiles. The four placement patterns of §6 survive unchanged;
  they just gain honest inputs.
- **L5 · Rasterisation.** One pass renders L1–L4 into the `Uint8Array` —
  including all tile-level transition dressing (§9.4). The only code that
  writes tiles.

Each layer is independently renderable by `mapgen --layer=fields|use|graph`
— the debugging story §5 asked for, structurally free.

### 9.3 Hierarchical seeding — extension stops being destructive

Replace the single threaded rng with **derived streams**:
`rngFor(seed, layerName, passName)` via a hash (the codebase already
trusts `hash2`-style mixing, `turf.ts:100`), and position-keyed hashes for
per-cell decisions. Consequences, in order of importance:

1. Adding a draw to one pass no longer moves any other pass's output —
   the `ROADMAP.md:581` standing risk is retired, permanently.
2. Pass order stops being load-bearing for randomness (it stays
   load-bearing for data dependencies, which the layer contracts now
   state explicitly instead of comments pleading for it).
3. Worldgen becomes locally editable: tuning the shop pass changes shops,
   nothing else. Review of a seed sweep becomes meaningful diffing.

This is a pure refactor of rng plumbing, one seed-breaking change that
buys never being seed-broken by *additions* again. It should land first.

### 9.4 Transitions as a first-class system

The current map has exactly one good transition — river bank — and it's
handmade. The fix is a rule system, not more handmade edges:

- **Transition ladders.** Ranked sequences that adjacency must respect:
  `deep → shallow → sand → promenade/dune → streets` for water;
  `downtown → commercial → residential → suburb → rural → nature` for
  land-use; `highway → avenue → street → track` for roads. L1 enforces
  them: where classification would jump more than one rank, it inserts
  the mediating band (an *ecotone*) automatically — city meeting forest
  grows a suburb/allotment fringe; downtown meeting water gets a quay,
  nature meeting the same river gets reeds. One mechanism, every edge in
  the game.
- **Fields make everything fade together.** Block size, building
  coverage, lamp spacing, ped/traffic density and prop mix all read L0
  `density` — one number — so the city core loosens gradually into
  suburbs with *every* channel agreeing, instead of five channels
  switching independently at a painted border. District identity then
  comes from the *fill strategy*, while intensity comes from the field.
- **Corner-sampled rasterisation.** L5 samples classification at tile
  *corners* (dual grid), so shorelines, kerbs and tree-lines can render
  marching-squares-style blends instead of staircases. Data change only;
  the renderer exploits it when ready.
- **Enforced, not hoped for.** A seed-sweep test walks every cell
  adjacency and asserts no ladder is violated — transitions get the same
  invariant treatment as connectivity. "No beach touches downtown, no
  highway meets a track" becomes a red test, not a review comment.

### 9.5 Migration, strangler-fig style

No rewrite branch. `CityMap` keeps its shape throughout; each step ships
green and seed-breaks at most once:

| # | Step | What changes | What it retires |
|---|---|---|---|
| 1 | Hierarchical seeding (§9.3) | rng plumbing in every pass | global seed-breakage on extension |
| 2 | L0 fields + field-scored classification | `districts.ts` Voronoi → scoring; density modulates `fillBlock` + amenity spacing | patchwork districts, hard borders |
| 3 | Transition ladders + ecotone bands + adjacency test | L1 | handmade edges; §8's beach/shallow arrive here for free |
| 4 | Road graph before rasterisation | `roads.ts` emits graph, then paints; graph into `CityMap` | tile-probing traffic/roadblocks (opt-in migration) |
| 5 | Parcels with frontage | `buildings.ts` places on lots | `findDoorway`, doorway bug class |
| 6 | Content layer on queries; §8 region features | amenities read layers | perimeter/kerb re-scanning |

Steps 1–3 are worldgen-only and deliver the visible "better": coherent
districts that fade, real edges, beaches that grade into water. Step 4 is
the biggest single win for *game* code (traffic, roadblocks, routing).
After step 6, §8's islands, hills and nature are content on a clean
substrate instead of passes 18 through 26 of a pile.

---

## 10. The unbounded world (implemented)

Fourth wave, and the payoff of §9's discipline: **the world no longer has
edges**. Implemented, tested and gated — this section records the design
as built.

**The principle: no pass may depend on the map's extent.** Every layer is
a pure function of (seed, GLOBAL tile coordinate): fields sample an
infinite plane; arterials are a jittered lattice whose line k is
`hash(seed, axis, k)` (`roads.ts: arterialCoord`); waterways are noise-
contour bands; and everything between arterials generates per **cell** —
the region between adjacent lattice lines — from rng derived from
`hash(seed, cell index)`. Density is no longer one radial core but an
infinite lattice of hashed city cores (`fields.ts: cityCore`) with open
country between them: cities forever, in every direction.

**A session materialises a window.** `params.windowX/windowY` plus the
existing width/height select a viewport; `CityMap` keeps window-local
coordinates, so the sim, prediction, wire protocol and client never
learned the world grew. Wire positions are varint (§8.1), so a window at
tile one million costs three bytes a coordinate, same as one at the
origin. `mapgen --wx/--wy/--size` opens a viewport anywhere.

**The invariant that makes it real** (`windows.test.ts`): two overlapping
windows of the same seed agree tile-for-tile in their overlap interior.
The rim is the documented exception: carving passes (shops, landmarks)
skip footprints not fully inside their own window, so views may differ
within one cell span of a window edge — confined there by construction.

**Quotas became coverage.** Per-window counts ("4 hospitals") are
meaningless on an infinite plane, so hospitals and police stations sit on
a deterministic lattice (every second cell each way, offset apart) and
shop kinds on their own lattices with pitch derived from the old quota —
"you are never more than N cells from a gun shop" is now a guarantee
(§6.2's doctrine), not a spawn-table hope. Turf, player spawns and the
list-only amenity scans stay window-scoped deliberately: they are session
furniture, not world features.

**What "nearly" still means.** The *design* is unbounded; a *session*
still materialises one finite window (walls at its edge), because the
server's population systems (peds, traffic, pickups) iterate global lists
and interest management assumes one arena. The remaining work for
walk-forever play is server-side streaming: chunk-backed `CityMap`
queries, population that follows players (§8.1's spawner rework), and
respawn/turf semantics per region. Worldgen is no longer the blocker.

---

## 11. Plan: real countryside, then walk-forever streaming — DELIVERED

Status: all seven phases shipped (see PROGRESS.md top entry). B2/B3
landed as the sliding-window REBASE rather than per-cell residency — the
window follows the players under ROAM=1 — with the B1 store standing
ready as the substrate for true per-cell streaming later. The §11.4
decisions were resolved by the implementation: turf stays window-scoped,
respawn clamps to the current window's hospitals, and the world bound is
the rebase cadence itself.

The two tracks left open by §10, planned to implementation depth. Track A
(countryside) goes first: it is pure worldgen on proven machinery, its
results are visible in every render, and it defines what streaming will
actually stream past. Track B (streaming) is phased so the risky step —
game code reading a world that no longer fits in one array — lands alone
and provably equal to the window it replaces.

### 11.1 Track A — the countryside made real

Today the space between cities is park blocks wearing the full urban
street grid: sidewalk rings, three-tile secondaries, lamp-ready kerbs.
Three phases, each shippable alone.

**A1 — De-grid (M).** Rules, all density-gated so the city→country
transition stays continuous:

- *Roads:* cells whose centre density is rural (below `residential × 0.5`,
  the §L1 open-country branch) subdivide to lane-scale instead of
  block-scale: target extent ~48 tiles, carve width 2 (`roads.ts` — the
  cell's district lookup already has the density; add a per-district
  road width to `blockSize`'s table or a parallel `laneWidth` param).
  Arterials persist as highways — that is what they are out there.
- *No kerbs:* `laySidewalk` skips countryside blocks entirely
  (`buildings.ts` — one district check). Ped spawns, props, payphones and
  parking all filter on sidewalk today, so rural quiet **emerges** from
  this one change: no pavement, no crowd, no street furniture, no
  kerbside cars. Verify, don't re-implement.
- *Ground:* countryside `fillBlock` case paints meadow (`T_FIELD` — tile
  0, unused since day one) with `wildness`-driven forest patches: a new
  `T_TREES` tile, solid to everything like a building but rendered as
  canopy. Forest respects a 1-tile clearance from any road (walk the
  block, skip tiles adjacent to carved lanes) so lanes stay drivable.
  Window-independence is free: fills already derive per-block streams
  from global coords.
- *Invariants:* no sidewalk tile in a rural-district cell across seeds;
  every lane connects to the arterial ring (existing subdivision
  guarantees it — pin it anyway); `T_TREES` never adjacent to `T_ROAD`.

**A2 — Shores by density (S).** The waterfront ladder splits on urban
intensity at the bank pass (`generate.ts`): density ≥ `commercial` keeps
the stone quay (`T_BANK`); below it the edge becomes `T_SAND`, widened to
2–3 tiles by re-sampling the water field at radius 2 (still pure, still
window-independent). Beach props (umbrella, towel — ordinal scan over
sand) ride along. **Swimming stays out of this phase**: `T_SHALLOW` and
the swim state touch the prediction hot loop and land alone later, per
the standing rule (`ROADMAP.md:577`'s water precedent).

**A3 — Destinations (M).** Countryside needs reasons to drive through
it. Stamp kinds gated to rural cells, placed by the landmark machinery
(they ARE landmarks — named, on the radar): farm (house cluster + yard +
barn slab at a lane junction), campground (clearing + tents-as-props),
lighthouse (coast cells only: water within a cell radius), quarry (grit
pocket: lot + crane — the crusher economy reaches the countryside).
Rates via the existing `cellQuotaFrac` exchange. One new mechanism only:
a stamp = tile template + prop list + approach contract, the §3.6
mechanism, built here because these four are its first honest users —
the city landmark upgrade (§4.5) then comes free.

### 11.2 Track B — streaming: the window learns to walk

**B0 — the measured facts this plan stands on.** Direct `map.tiles[i]`
indexing outside worldgen: **nine sites** (four in the client tile
renderer's bake, one each in roadgrid/peds/frenzy/minimap/mapgen) —
everything else already goes through `tileAt`/`isSolidTile`/
`drivableTile`. Generation cost is ~0.5 ms per arterial cell (125 ms /
~25 cells at 240²). The tile renderer is already chunk-cached with a
bounded budget (`CHUNK_BUILDS_PER_FRAME`, `CHUNK_CACHE_LIMIT`). Wire
positions are varints. Hospitals, police and shops are already coverage
lattices — they stream by construction. This is why B is tractable.

**B1 — chunk-backed world store, proven equal (L, the risky one).**
- `world/store.ts`: a `WorldStore` holding generated **cells** (tiles
  rasterised per cell + the cell's buildings/shops/landmarks lists) in a
  keyed cache, LRU-evicted outside a residency radius. `tileAtGlobal`,
  `featuresNear(x, y, r)`, `nearestHospital(x, y)` queries on top.
- Migrate the nine direct index sites plus the renderer's window-sized
  precomputes (`runH`/`runV`/`buildingOf`/`shopOf` become per-chunk,
  computed at bake time — they are bake acceleration, not sim state).
- `CityMap` keeps its shape as **the compatibility view**: a session
  still materialises a window through the store. THE gate for this
  phase: a new test proving store-served tiles and feature lists are
  bit-identical to `generateCity`'s window output for the same region —
  the windows.test.ts invariant, now three-way.
- Nothing moves yet. B1 changes plumbing, not behaviour: every existing
  test and gate must pass untouched.

**B2 — the client walks (M).** Renderer and minimap consume the store
(radar bakes a region around the player, rebaked on region change);
prediction requires resident cells for a ring around the local player,
generated synchronously on entry (0.5 ms/cell is affordable mid-frame;
pre-generate one cell ahead along velocity to keep even that off the
hot path). Client memory bounded by the LRU.
**B3 — the server population follows (L).** Ped/traffic/pickup/prop
budgets become per-active-region (the ring around each player's
interest radius), spawned from store queries instead of session lists,
despawned with their region; `ROADMAP.md:141`'s outside-the-radius
top-up pattern, generalised. Session semantics that must be re-decided,
named in §11.4. The window params stay as the *starting* region; the
walls come off when a player's ring crosses the old edge.
**B4 — the roaming gate (S).** A bot script that drives one direction
for minutes across multiple cells/cities: 0 desyncs (both sides stream
identically or hashes scream), bandwidth under the 50 KB/s gate
throughout, chunk-gen p95 under budget, memory flat under LRU. Plus a
teleport test: two players 100k tiles apart in one session.

### 11.3 Sequence and risk

| # | Phase | Size | Risk | Gate |
|---|---|---|---|---|
| 1 | A1 de-grid | M | low | seed sweeps + window overlap; renders |
| 2 | A2 shores | S | low | ladder invariants per density band |
| 3 | A3 destinations + stamp mechanism | M | low | reachability per stamp; quotas |
| 4 | B1 world store | L | **medium** | store ≡ window, bit-for-bit; all gates green untouched |
| 5 | B2 client streaming | M | medium | frame budget; prediction corrections unchanged |
| 6 | B3 population streaming | L | **high** | roaming bots, 0 desyncs; bandwidth |
| 7 | B4 gates + sizes | S | low | the roaming harness itself |

Risks, ranked: **(1)** B3 turf/respawn semantics are design decisions
wearing an engineering hat — settle §11.4 before writing code, not
during. **(2)** Synchronous cell generation on the prediction path (B2)
— bounded by measurement, but a pathological cell (huge landmark carve)
needs a budget test. **(3)** LRU eviction vs. determinism — eviction
must never change what regenerating the cell produces (it can't: cells
are pure functions — pin it with a test anyway). **(4)** A1's lane-scale
subdivision changes traffic's world; run the full bot suite, not just
worldgen tests.

### 11.4 Decisions needed before B3 (design, not code)

1. **Turf in a many-city world.** Options: gangs claim whole city cores
   (`cityCore` hash picks the gang set per city — territory becomes a
   fact about a city, which fits §RESEARCH's district-gang model), or
   turf stays a per-session ring at the starting city and the wider
   world is neutral. Recommendation: per-core, it's one hash.
2. **Where the dead wake up.** Nearest-hospital already streams
   (coverage lattice). Decide whether respawn can move you to a city
   you have never visited, or clamps to your starting core's region.
3. **A soft world bound.** Floats are exact far past anything reachable,
   but a session that drifts 10^6 tiles strains nothing except sense.
   Recommendation: clamp movement at ±100k tiles from origin and call
   it the map, honestly, in one constant.

Done in this order, the world stops being a window with walls at
step 6 — and every step before that ships something visible or proves
something the next step needs.

---

## 12. The city, drawn — DELIVERED

Everything above this line describes a **generator**. The generator is gone.
This section says what replaced it, why, and how to change the city now.

### 12.1 What was actually wrong

The layer stack of §9 was well built and the unbounded world of §10 was a real
achievement, and neither of them made a good city. Open
`evidence/city-old-generator.png` — seed 42, the shipped configuration:

- **The water did not know what it was for.** Waterways were a noise contour
  band. At one seed it was a river with a bridge over it; at the next it was a
  lagoon that swallowed a district, cut the road network into four pieces and
  left islands of street with no crossing to them. Nothing in the pipeline
  could tell the difference, because "is this crossing worth a bridge" was a
  span measurement and not a decision anybody made.
- **The districts had no shape.** Land use was thresholds on a radial density
  field plus noise, so a borough was wherever the noise happened to cross 0.52
  — ragged, unnamed, and the same shape in every direction. There was no
  downtown you could point at, because downtown was a contour.
- **The grid went on until it stopped.** Recursive subdivision inside a
  jittered arterial lattice gives blocks of the right size and a city of
  uniform texture: no high street, no waterfront, no reason for any junction
  to be more interesting than any other.
- **Nothing could be navigated by.** Landmarks were rolled per lattice cell,
  so which ones a session got, and where, was luck. A city with two towers and
  no stadium is not a landmark system, it is a dice roll with names on it.
- **The edges were a lie.** With `ROAM` on, the window walked and the session
  dragged the whole ambient world with it — a rebase command, a despawn of
  everything not bolted down, and a metered reseed. It worked. It also meant
  every pass in worldgen had to be a pure function of global coordinates,
  every quota had to be phrased as a density, and no part of the map could
  ever be looked at as a whole and judged.

That last point is the one that decides everything else. **A procedural map
cannot be reviewed.** You can review a generator, and you can review a sample,
but you cannot review the thing the player gets, because it does not exist
until they get it. Every quality problem above was therefore fixed by tuning a
constant and hoping, and every fix moved every other seed.

### 12.2 What the genre actually did

The obvious research, done properly, because the answer is not subtle.

- **GTA (1997)** shipped three hand-built cities — Liberty City, San Andreas,
  Vice City — as fixed 256×256 tile maps. **GTA 2 (1999)** shipped *Anywhere
  City* as three connected districts: Downtown, Residential and Industrial,
  each with its own architecture, its own gangs and its own missions, all on
  one traversable map. The `.gmp` format is a compressed column table over a
  256×256 grid: a **baked asset**, authored in an editor, not generated.
- **GTA III (2001)** cut Liberty City into three islands — Portland, Staunton,
  Shoreside Vale — each joined to the next by a bridge, and used those bridges
  as the progression gate. The islands were a technical necessity (streaming)
  that turned into the best structural idea in the series: a bridge is a
  landmark, a chokepoint, a chase venue and a mental map all at once.
- **Vice City (2002)** is two big islands and a handful of small ones, and its
  reputation rests on density of *identity* rather than size — Ocean Beach
  reads nothing like Little Havana reads nothing like the Downtown skyline.

Three lessons, and we took all three:

1. **One city, authored.** Not a generator with good defaults.
2. **Boroughs with names, joined by bridges.** Water as structure, not as
   noise: it is what makes a map legible from the air and memorable on the
   ground.
3. **The sea is the edge.** An island city needs no invisible walls and no
   infinite plane. Where the map stops, there is water, and that is an answer
   a player accepts without being told.

### 12.3 The design

**Anywhere City** — the name is GTA 2's, and the debt is acknowledged; the
city is our own. **768×768 tiles, 12288×12288 px**: four times the area of the
first draft and about ten times the old generated window. Roughly a minute
corner to corner at a fast car's top speed.

An archipelago, not a rectangle. One long island on a NNE–SSW axis, split
across its middle by a tidal strait open to the sea at both ends; a second
island across a narrow sound to the west; a spit hooking round a lagoon in the
south-east; barrier islands off the south shore and a rock stack off the west.

| Borough | Character | Holds |
| --- | --- | --- |
| **Kelvin** (north bank, east) | The old quarter round the harbour — 11×9 pitch, alleys, the tightest streets in the city — and the financial spine behind it | Vantage Tower, The Spire, Halloran Building, 1st Precinct, Mercy General |
| **Ravenhill** (north bank, west) | Nineteenth-century commercial grid, the park, terraces climbing from the water | Ravenhill Park, St. Brannoch, Ironside Stadium |
| **Sunridge** (south bank) | Seafront, then suburbs loosening as they go inland: 16×13 at the front, 23×18 at the edge | The Bowl, Seaview Infirmary, Kelvin Road Station, Sunridge Park |
| **Marsh End** (south-east) | Flats and coast road, the airfield, the country destinations | Marsh End Airfield, Hollis Farm, Pinewatch Camp, Old Point Light |
| **Port Vasco** (west island) | Docks and foundry across the sound, with the housing that serves them | Kessler Power, Greyhill Quarry, Harbour Precinct, Riverside Infirmary |

Crossings, and there are eight of them, because on an archipelago the question
"which bridge" is the interesting one: three over the strait (Kelvin Bridge,
Old Bridge, Marsh Causeway), two over the sound to Port Vasco, and the ring
road's own two crossings.

### 12.4 The pipeline

```
shared/data/city-plan.json     the drawing            (authored, reviewed, diffed)
        │  parseCityPlan               plan.ts
        ▼
    buildLayout                 ground                 layout.ts
        │   coast → boroughs → avenues → streets → blocks → shores → quays → prune
        ▼
    bakeCity                    the finished city      bake.ts
        │   landmarks → aprons → block fill → driveways → shopfronts
        ▼
shared/src/world/city.data.ts   frozen, committed      (RLE + base64, ~118 kB)
        │  decodeBakedCity + the amenity passes        generate.ts
        ▼
    CityMap                     what a session plays
```

The plan is four things, all of them editable by a person:

1. **The geography**: islands and bays as OUTLINES, rivers and spits as
   courses that are meandered before they are cut, lagoons, islets, and the
   swell direction. Nothing in it is drawn at tile resolution — the outline is
   the intent and the warp supplies the detail (§12.7).
2. **The boroughs**, as polygons carrying a district type, a street pitch, a
   built density and an alley threshold. Polygons rather than rectangles so a
   borough can follow a shoreline; different pitches so they read differently;
   a density so a downtown wall and a loose suburb come out of one filler.
3. **The roads**, as named polylines with a width, optionally smoothed into
   curves and optionally dual-carriageway. A road crossing water becomes a
   bridge where the far bank is within `maxBridgeSpan` — measured afterwards,
   over four directions, because a curved road has a segment somewhere that
   points along the water instead of over it and will happily lay a
   hundred-tile causeway out to sea if you let it.
4. **The landmarks**, each at a chosen rectangle, with a per-kind recipe for
   the ground it stands on and the apron round it. `pnpm citybake --fit` names
   the nearest block that would hold one the plan has put somewhere it will
   not go, which is how two dozen buildings get placed on a 768-tile island
   without doing it by eye twenty-three times.

Three things the bake does that the generator could not:

- **It validates.** One road network, every borough reachable, every landmark
  with a road within six tiles, every shopfront with a pavement outside it and
  a walkable room behind it, no carriageway ending in open water. A plan that
  fails is not committed. This is affordable precisely because it runs once.
- **It repairs what it can.** A landmark with no road to it gets a two-tile
  driveway cut to the nearest street by breadth-first search. Carriageway that
  is not part of the main network — the scraps the quay pass leaves behind —
  goes back to being ground rather than stranding an ambient car on it forever.
- **It refuses what it cannot.** A landmark drawn over the sea or across a
  street throws, naming the landmark and the tile. Both were authoring slips
  we made, and both would have baked silently into a pier nobody meant and a
  severed road network.

### 12.5 What a seed still does

A session seed no longer touches the ground. It moves the furniture: which
kerbs are parked up and with what, where the crates and the hidden packages
are, which gang holds which cell of turf, where the stunt ramps are cut into
the industrial lots, and which of the sixteen spawn points a player gets. That
is worth keeping — two sessions in the same city should not be the same
evening — and it costs nothing, because none of it is geometry.

### 12.6 What went

| Gone | Why |
| --- | --- |
| `world/fields.ts` (the L0 field stack) | Reduced to its hash and value-noise primitives. Nothing decides where a city is any more. |
| `world/districts.ts` | Land use is drawn, not scored. |
| `world/roads.ts` | The arterial lattice and the recursive subdivision under it. |
| `world/store.ts` (§11.2 B1) | A cell-keyed store over an unbounded world, for a world that is now 384 tiles across and fits in memory forty times over. |
| `rebase` (SimCommand + server message) | The window does not walk, so nothing has to be told that it did. |
| `ROAM`, `?roam=` | Same. |
| `windowX/Y`, `widthTiles/heightTiles`, `arterialSpacing`, `blockSize`, `fields`, `water`, `countryside` in `worldgen.json` | None of them can move a street now. What is left in that file is what a session varies. |

The §11.4 questions — turf across many cities, respawn across regions, a soft
world bound — are answered by not having many cities. Turf is a partition of
one map. You wake up at the nearest hospital, and every hospital is a place
you have been. The world bound is the coastline.

### 12.7 The review, and the second draft

The first drawn city was reviewed by three people wearing different hats — a
level designer, an urban geographer and an engine engineer. Between them they
said one thing three ways: **it was better than the generator and it was still
a drawing.** What follows is what each of them found and what was done, because
the findings are the design rationale.

**The geographer: "convex blobs with chamfered corners."** The coast picture
had power at exactly two scales — the eight-tile grid it was drawn on, and a
two-tile hashed erosion — and a real coast has power at every scale, which is
the whole content of the how-long-is-a-coastline result. Nothing on it was
re-entrant: no bay, no headland, no spit, no island. Both water bodies were
constant-width straight channels. The fix, and it is exactly what they
prescribed: the shape is authored as an OUTLINE, rasterised to a signed
distance field, and the SAMPLE POINT is displaced by a four-octave vector warp
— wavelengths 256/128/64/32 tiles, amplitudes 40/20/10/5. The ratio
amplitude/wavelength ≈ 0.15 is the whole trick; below 0.08 the island stays a
blob and above 0.3 it frays into confetti. Warping the sample point rather
than the threshold is what keeps the authored silhouette while making its edge
sinuous all the way down.

Their second point earned its keep more than another octave would have: make
it **directional**. The swell comes from one place, so the shore facing it is
planed straight and the shore in its lee keeps its inlets. `geography.swell`
is one vector and the warp is damped by the shore normal's dot product with
it; the same number decides where sand collects, because sand is a low-energy
deposit and an exposed headland gets rock.

**The level designer: "a road network with confetti on it, not a city."** They
measured it: 31% of dry land was carriageway and only 9% was building, and
downtown — the densest district on the map — was 13% built against 28% bare
dirt. A city block had been a sidewalk ring with detached three-tile sheds
scattered inside it. Blocks are built as FRONTAGE now: shoulder-to-shoulder
units four to six deep facing the street, with a yard behind reached through a
gap, and how often the ring breaks is per-borough (`density`). Building share
of dry land went 9% → 15.5%, and downtown reads as a wall from a car.

They also counted **fifty dead-end road tiles in thirty-two thousand**, no
alleys at all, and one road width for the entire map. Alleys are a borough
setting now (`street.alleyOver`) and every dense borough has them. Road
hierarchy is three levels: a dual-carriageway ring, four-lane arterials,
three-lane streets, two-lane alleys.

**The engine engineer: numbers, mostly about the join.** `planRoute` allocated
three typed arrays per call — five megabytes at this size — and cleared two of
them before looking at a single tile, at five to fifteen calls a second. It
reuses one working set with a generation stamp now, and has an expansion cap,
because a route to somewhere the roads do not reach used to exhaust the entire
network mid-tick. Ambulance dispatch planned a route for every candidate that
beat the best distance so far; it sorts first and plans once. And every ambient
budget in the game was a flat count — 48 parked cars, 200 pedestrians, 400
props, 100 packages — which on four times the ground is not a bigger city but
an emptier one. They are rates per nominal 384² city now, scaled by area.

**What was deferred, and honestly.** Grade separation — road over road, tunnels
and flyovers — is the single biggest missing chase primitive and it needs a new
tile type through collision, the volume grid and both renderers. One-way
systems need the traffic model to carry direction. Neither is in this pass. The
client-side items on the engineer's list (instance matrices built as
`Float32Array` rather than `THREE.Matrix4[]`, the volume grid's span
intermediate, chunked scenery, an off-thread join) are real and unaddressed:
the join sequence is the first thing that will hurt on a slow machine.

### 12.8 Why the roads are the width they are

`sim/signals.ts` calls tarmac that is over-wide across every direction a
junction — which is right, because a plaza IS a junction — and the threshold is
four tiles. Two consequences fell out of drawing roads as polylines:

1. **No single carriageway may exceed four tiles.** An eight-lane road makes
   every tile of itself a junction; the first attempt gave the ring road one
   junction with 333 signal heads on it. A motorway is therefore built the way
   a motorway is actually built: two carriageways with a reservation between
   them (`PlanRoad.median`), which the traffic model reads as two roads and the
   eye reads as a motorway. `parseCityPlan` refuses anything wider.
2. **The junction test had to stop being axis-aligned.** A four-tile road at
   forty-five degrees measures nearly six tiles across both axes, so the old
   test called every diagonal road a junction. It measures the narrowest span
   over four directions — two axes and two diagonals — and asks whether the
   tile is narrow in ANY of them.

Two smaller rules came with them. A connected patch of junction over twenty
tiles is a plaza, not a signalled junction: many ways in, no phase that governs
them, left unlabelled. And exactly one signal head is kept per junction per
cardinal, rather than trusting a local kerb test that only ever gave one per
arm on a grid.

### 12.9 Gannet Rock: the island you can only fly to

Out in the western approaches, a plateau with a strip on top and cliff the
whole way round. There is no bridge to it and nowhere to bring a boat
alongside; the only way on is to land, and the only way off is to take off
again.

It exists because the map had three ways of getting somewhere — road, water,
air — and only ever asked about the first. A place that refuses two of them
makes the third mean something, and it makes the aeroplane a vehicle you seek
out rather than one you find at the airfield and crash for fun.

Three plan primitives carry it, and each is general rather than a special
case:

- **`geography.cliffIslands`** — a point on a landmass, not an outline round
  it. The shore is warped after it is drawn, so an outline traced round the
  intended coast is tens of tiles adrift by the time the bake finishes; "the
  island under this point" survives the warp exactly. Every shore tile on a
  marked landmass becomes rock rather than quay or beach, and rock is solid.
- **`landmarks[].byAir`** — the bake will not cut it a driveway and the
  checker will not ask for a road to it. What the checker asks instead is
  that there is a runway on the same piece of ground (an airfield you can
  land at and not leave is a trap, not a destination) and that not one tile
  of its shore can be stepped onto from a boat.
- **A final seal, stated once.** Every pass between the shore and the finished
  map can open a cliff by accident — a runway apron painted a tile too far, a
  lane cleared through the scrub, a landmark's ground overwriting the rock it
  stands on. Three of them did. Rather than patch each, `bake.ts` re-asserts
  the invariant last: on a cliff-bound landmass, nothing walkable touches
  water. One walkable tile at the waterline is the difference between an
  island you fly to and an island you moor at.

The checker learned two things along the way that are worth more than the
island is. Ground with a runway on it is not "cut off from the road network",
it is an airfield; and ground with a shore you can step onto is reached by
boat, which is a way of getting somewhere. What is left after those two —
445 tiles, down from five thousand — is genuinely enclosed courtyards inside
blocks, which is a thing the city is supposed to have.

### 12.10 Changing the city

```bash
$EDITOR shared/data/city-plan.json
pnpm citybake          # draws it, checks it, writes shared/src/world/city.data.ts
pnpm mapgen            # look at it
pnpm test              # shared/test/city.test.ts holds the asset to the plan
```

Commit the plan and the baked data together. The test that compares them is
the only thing standing between "the map in the repository" and "the map the
plan describes", and they are different files.

---

## 13. The street fabric — the plan for making it beautiful

Third wave of this research. §12 replaced the generator with a drawn city and
fixed the geography: the archipelago is real, the coast is sinuous, the
bridges are chokepoints, the density reads. What it did not fix is the layer
the eye actually spends its time on. **Every street in Anywhere City is
parallel to the screen.** The brief for this wave lifts the one restriction
§3 was written under: curves are allowed, and the city does not have to be a
grid. This section is the review that says precisely what is wrong, the
research rerun without that restriction, and the sequenced plan.

### 13.1 The review

`pnpm mapgen` (seed 7 — but the ground is the same every seed now), whole map
and the three crops in `evidence/city-fabric-review.png`:

**What is good, and stays.** The silhouette: warped, directional coastline,
bays and spits and barrier islands, no two edges alike. The hierarchy: the
dual-carriageway ring reads as a motorway, the bridges are scarce and
legible, the borough palettes separate. The frontage fill: downtown is a
wall, not sheds on a lawn (§12.7). None of this is revisited.

**Finding 1 — one grid, citywide.** Every borough's streets are carved as
axis-aligned lattice cuts (`cuts`/`line`, `layout.ts:466`): sixteen boroughs,
sixteen pitches, **one orientation**. Crop A shows both banks of the strait
carrying the identical screen-aligned plaid; Kelvin and Sunridge differ only
in colour and spacing. The plan schema's own manifesto — "the thing that
makes a map look like a place is that nothing in it is parallel to the
screen" (`plan.ts:17`) — was applied to the coast and the avenues and never
to a single street. A real city's boroughs each grew around their own
waterfront, their own high street, their own hill, and their grids meet at
seams. Ours is one grid interrupted by water.

**Finding 2 — the streets ignore the avenues.** The curved plan roads are
carved *through* the lattices, not *woven into* them. Crop B (Old Quarter):
Kelvin Street and Harbour Approach slice diagonally across the pitch-11 grid
and leave triangular slivers, four-tile scrap blocks, and junctions at
twenty degrees, and not one street turns to meet the avenue square-on or
runs parallel to it. `doubledUp` (`layout.ts:484`) suppresses a lattice cut
that lies *along* an avenue, which stops the worst doubling; nothing makes
the fabric *acknowledge* the avenue. The ring road spends most of its length
running through leftover field (crop C) — a motorway with no city on it.

**Finding 3 — the waterfront is dead ground.** Between the last lattice street
and the shore there is a ragged band of bare `T_FIELD` — every crop shows it
as a dark fringe the whole way round every island. The lattice stops where a
block stops being mostly dry (`layout.ts:557`), the shore pass paints quay
and beach (`layout.ts:668`), and nobody joins the two. A city that owns a
harbour builds a street along it first; ours builds to within six tiles of
the sea and turns its back. This is the single largest visible defect,
because the coast is the thing §12 made good and the fabric refuses to meet
it.

**Finding 4 — parks and the rural south are empty felt.** Ravenhill Park and
Sunridge Park are flat green rectangles with an avenue through them; the
rural boroughs are the same at a larger pitch (crop C, lower half). The bake
has woodland noise (`bake.ts:296`) and the plan has meanders for rivers, and
neither is applied to a park's interior: no path network, no pond, no
tree-lined walk, no bandstand block.

**Finding 5 — rectangles all the way down.** Blocks are rects
(`LayoutBlock`, `layout.ts:37`), buildings are rects (`Building`,
`types.ts:144`), so wherever an avenue curves, its frontage stairsteps in
big increments and the wedges left over are dirt. The frontage is right; its
granularity is wrong where the street is not straight.

One sentence for all five: **§12 gave the city a shape; the fabric inside
that shape is still the old generator's habit.** The same verdict
`REVIEW.md:139` passed on the pre-river map — "a texture" — now applies one
level down.

### 13.2 The constraint that expired

§3 rejected every organic-network technique in the literature — L-systems,
tensor fields, growth models — mostly on **runtime determinism**: server and
clients regenerated the map independently, so anything order-sensitive was a
desync. §12 quietly ended that. The bake runs offline, once, from `pnpm
citybake`, and what ships is bytes (`bake.ts:30`). An algorithm used at bake
time can be as iterative, as float-happy, as convergence-dependent as it
likes; if the picture is good, the picture is what ships. The vetoes of §3
are hereby re-examined, not carried forward out of habit.

What still binds, because it is about the *product* and not the process:

1. **The tile substrate.** 16 px tiles feed collision, prediction, traffic
   and both renderers. Any curve ends as tiles — which the swept-disc carver
   (`carveCourse`, `layout.ts:422`) and the four-direction junction test
   (§12.8) already handle. The ring road proves curvature is compatible with
   the lane model today.
2. **Axis-aligned `Building` records.** The 3D renderer extrudes them
   (`extrude.ts:77`), the volume grid and doorways derive from them. Rotated
   footprints are a renderer-and-collision project, out of scope. Curved
   frontage must therefore be built from *finer* axis-aligned rects, not
   rotated ones.
3. **Legibility at 300 px/s** (§5). Curves serve the player when they follow
   something — a shore, a hill, a spine road. Curvature for its own sake is
   noise. Every fabric below is anchored to a feature you can see.
4. **The review loop.** Plan edited by hand, `citybake`, `mapgen`, checker,
   test (§12.10). Nothing below adds a runtime pass; everything below is
   judged as a picture and validated by the checker.

### 13.3 The research, rerun

- **Tensor-field street networks** ([Chen et al. 2008](https://www.sci.utah.edu/~chengu/street_sig08/street_sig08.pdf),
  and [ProbableTrain's MapGenerator](https://github.com/ProbableTrain/MapGenerator)
  as the working open-source implementation): a field of perpendicular
  eigenvector pairs over the plane; major roads trace streamlines of one
  eigenvector, minor of the other; the field is composed from radial and
  grid basis elements plus boundary alignment. This is the correct *theory*
  of what a city fabric is, and full streamline tracing (seeding, spacing,
  merging) is still more machinery than a 768-tile archipelago needs. The
  reduction that keeps the value: **in this city the eigenvector field is
  known in closed form wherever it matters** — the coast tangent along the
  shore (we have the water distance field, `layout.ts:70`; its gradient is
  the field), the spine tangent along an avenue (we have the polylines and
  `offsetCourse`, `layout.ts:445`), constant vectors elsewhere. Streets are
  then *iso-contours and gradient lines* of known fields, no tracing, no
  seeding. **Verdict: adopt the reduction — guide fields, not streamlines.**
- **Watabou's Medieval Fantasy City Generator**
  ([devlog](https://watabou.itch.io/medieval-fantasy-city-generator)):
  polygonal wards from a Voronoi partition, streets from straight skeletons
  of ward polygons. The lesson worth taking is not the algorithm but the
  posture: blocks are **polygons that inherit their shape from the ward
  outline**, and the fabric near a ward edge runs parallel to that edge.
  That is Finding 2's cure stated in one line. **Verdict: steal the
  posture — blocks derive from carved streets, never the reverse.**
- **Organic quad grids** (Townscaper-style: subdivide random polygons to
  quads, relax to comfort — [andersource's
  writeup](https://andersource.dev/2020/11/06/organic-grid.html)):
  beautiful, uniformly irregular, and wrong here — the irregularity is
  *everywhere at once*, which reads as wobble at driving speed, and the
  quads defeat the rectilinear local texture the frontage fill and the lane
  model are good at. **Verdict: reject, named so it stays rejected.**
- **Loops and lollipops**: the postwar suburb pattern — curved collector,
  crescent loops off it, cul-de-sac stubs off those — is the single most
  recognisable non-grid fabric in the real world, it is *made of curves*,
  and its dead ends are a feature (chase decisions: §4.3 wanted dead-ends
  and never got them). **Verdict: adopt for the outer suburbs.**
- **GTA 2's Anywhere City** ([design
  reference](https://gta.fandom.com/wiki/Anywhere_City)): the namesake's
  districts differ in *fabric*, not only in palette — Downtown's tight
  right-angles, Residential's loops and greens, Industrial's vast aprons.
  Our boroughs currently differ in pitch alone. The genre precedent for
  per-borough fabric is the genre's own map. **Verdict: this is the bar.**

### 13.4 The design: fabrics

One new word in the plan schema does the work. Each borough's `street` block
gains a `fabric`, and the street pass becomes a dispatch:

| fabric | what it carves | anchored to | used by |
|---|---|---|---|
| `grid` | today's lattice, plus `angle` degrees of rotation | the borough's own axis | Old Quarter (aligned to its harbour), Port Vasco (to its island's long axis), the Spine (to the financial avenues) |
| `contour` | streets along iso-distances of the water field at the borough pitch, connectors along the gradient | the shore | Beachfront, The Terraces, Sunridge Shore, the Docks |
| `spine` | offset courses of a named plan road at pitch intervals, square connectors | an avenue | Ravenhill (off The Parade), New Suburbs' collector |
| `crescent` | loops and lollipops: curved collectors, crescent loops, cul-de-sac bulbs | the collector | New Suburbs, Vasco Heights |
| `rural` | today's behaviour, but lanes as meandered courses (`meanderPolyline`, `plan.ts:416`) instead of lattice cuts | the landmarks they join | Marsh End, Sunridge Shore's back country, Gannet Rock |

All five carve through the same `carveCourse` swept-disc machinery that
already exists — a rotated lattice line, a contour, an offset course and a
crescent are all just polylines. The junction test is already
angle-tolerant (§12.8). `doubledUp` must learn to sample along an arbitrary
course rather than an axis; that is the one shared prerequisite.

**Blocks become regions.** The lattice-arithmetic block rects
(`layout.ts:541`) cannot survive any of this — under a rotated or curved
fabric the ground between streets is not a rect. Blocks become **connected
components of buildable ground** between carved streets, each carrying its
borough's district, density and a member mask; `BlockRect` stays as the
record (the component's bounding box) so every downstream consumer keeps
working, and `fillBlock`/`laySidewalk` (`buildings.ts`) iterate the mask
instead of the box. `laySidewalk` already follows roads wherever they run
(`buildings.ts:96`); the frontage fill already marches inward from the
street. This refactor is fabric-neutral: done first, it must reproduce
today's city almost tile-for-tile, and the mapgen diff is the proof.

**The waterfront becomes a street.** Wherever a non-rural borough meets the
water, the contour at distance ~3 is carved as an **esplanade** — a named
plan road auto-derived per borough, quay on its seaward side. This is
Finding 3's fix and the highest-value single item in the plan: it turns the
dead fringe into a harbourfront in Kelvin, a promenade in Beachfront, a
working quay in the Docks, and it gives the contour fabric its innermost
line. Piers follow as short gradient stubs (`PlanStroke`s of `T_BANK`) where
the plan asks for them.

**Squares and circuses.** A new plan primitive: `squares` — a point, a size,
a shape (rect or circle) — stamped as `T_SIDEWALK` with frontage turned
inward, plus a circus where the plan puts one on the ring. The signal pass
already refuses to signalise a big junction patch and calls it a plaza
(§12.8); this makes plazas *on purpose*: a market square in the Old
Quarter, a crescent green in the suburbs, a parade ground by the stadium.

**Parks get interiors.** Gates where streets touch the park; a path network
as meandered polylines between gates (2-tile `T_PARK` paths); a pond as a
small authored outline warped by the existing coast machinery at one octave;
tree clumps from the woodland noise already in the bake; one landmark block
(bandstand, boating lake) in each big park. Everything reuses machinery the
geography already paid for.

**Frontage granularity follows curvature.** Where a block edge is not
straight, the frontage unit width caps at 2–3 tiles so the stairstep is
fine enough to read as row houses following the bend — `Building` records
stay axis-aligned rects (§13.2.2), there are just more and smaller of them
on curved edges. The renderer and volume grid are untouched.

### 13.5 The checker learns the fabric

Per §5, every feature ships with its invariant, and two existing checks must
*relax* precisely rather than generally:

- **Slivers.** No block region under 12 tiles or narrower than 3 unless it
  is a square. This is the regression test for Finding 2 — today's map
  would fail it, the woven map must not.
- **The waterfront.** Every shore tile of a non-rural borough within 5
  tiles of carriageway. Today's map fails it wholesale; the esplanade makes
  it pass. This is Finding 3 stated as an invariant.
- **Dead ends by intent.** The stub prune (`layout.ts:713`) and the
  connectivity check stay, but a `crescent` borough declares a cul-de-sac
  budget and the checker asserts the count is *within* it — dead ends as a
  feature, not a defect, and only where the fabric says so.
- **Junction angles.** No junction arm meeting another under ~30 degrees
  outside a plaza — the measurable form of "the fabric acknowledges the
  avenue".
- **The picture.** `mapgen` grows `--crop=x,y,w[,h]` (a close-up at up to
  8 px per tile), `--stats` (per borough: land, road and building share,
  block count and median size, street orientation split, shore tiles and
  their p50/p95 distance to the nearest carriageway) and `--sheet`, which
  retakes the evidence contact sheet (`evidence/city-fabric-review.png`)
  in one command per wave, to be diffed by eye — the review tool this
  section was written with. **Delivered**, and the baseline it measured
  makes the findings numbers: every urban borough is 94–100% axis-aligned
  street (Finding 1 — the fabrics must move the diag% column), and the
  shore-to-street p95 is 25 tiles in Beachfront, 73 in Sunridge Park and
  109 in Marsh End (Finding 3 — the esplanade must bring the urban rows
  under 5). Two smaller things the table caught that the eye had not: some
  boroughs own shore on roadless islets (reported as `inf`, correct for
  Gannet Rock, worth an author's look elsewhere), and ~1900 shore tiles
  fall outside every borough polygon — the warp pushes beaches past the
  drawn outlines, so the esplanade pass must attribute shore by nearest
  borough, not by polygon membership alone.

### 13.6 The sequence

Smallest first, each landing as plan + rebake + render + test, per §12.10;
nothing touches the sim and nothing adds a runtime pass:

1. **Review tooling** — `mapgen --crop`, per-borough stats, the contact
   sheet. No map change. **DELIVERED** (§13.5, last bullet).
2. **Region blocks** — the fabric-neutral refactor. Must reproduce today's
   city; the mapgen diff is the acceptance test. **DELIVERED.** A block is
   now the connected ground between carved streets: a rect no road crosses
   comes out exactly as before (full box, every tile a member — same fill
   seed, same picture), and a rect an avenue crosses becomes one masked
   piece per side, each filling toward its own frontage instead of one fill
   scattering fragments across four lanes of road. The mask reaches the
   fill through one chokepoint (`Ctx.within`, consulted by `blocked()` in
   `buildings.ts`), so every placement test — painting, footprints,
   sidewalk — respects it without knowing it exists. 1054 blocks became
   1221 (167 avenue-made pieces); 2.0% of tiles changed, all of it along
   avenues, borough seams and through the parks; the checker's counts came
   out level or better (436 unreachable tiles against 445 before, the same
   16 drowned road tiles). Two things the diff taught: park ponds and
   bandstands now prove a margin of ground around them rather than
   trusting the box (a motorway median through a park has a park-sized
   box, and the first bake put a pond on it), and the diagonal avenues
   carry more kerb than before — the old rect fill often stood a building
   where a piece now lays pavement — which raised the crosswise-parking
   mark from a tenth to an eighth of spots and moved four scene-staged
   police/noise tests onto sturdier staging (posted posses and
   ring-density-scored lanes instead of kerb-geometry luck).
3. **`grid` + `angle`** — rotate Old Quarter to its harbour, Port Vasco to
   its island axis, Sunridge to its seafront. First visible seams between
   boroughs; cheapest fabric, validates the whole path. **DELIVERED**, with
   the whole Port Vasco island at 12°, the Old Quarter at 20° and North
   Point at 26°; Sunridge's tilt is too shallow to read as intent and waits
   for the contour fabric instead. What it took, beyond the carve itself
   (rotated lattice lines through the step-2 swept-course machinery, blocks
   as whole-borough components): a frontage-by-depth filler (`fillRegion`,
   `buildings.ts`) because a ring walked round a parallelogram's bounding
   box builds into the street on two sides; suppression of lattice lines
   against PRE-EXISTING roads only, from a snapshot, because the two
   rotated families cross each other every pitch and a crossing sampled at
   the wrong phase reads as a conflict — half of one family died of it at
   random in the first bake; alleys only through pieces eight tiles thick,
   or the strips a suppressed line leaves become corduroy; and a baked
   per-tile **bearing plane** (`CityMap.bearing`) so the passes that stand
   cars at kerbs or walk "along the street" get the exact angle the
   lattice was carved with — parked cars, ambient traffic and police
   cruisers now park and turn out along the rotated streets, oriented by
   the same right-hand-traffic rule the axis grids use, with the
   crosswise mark kept for junction diamonds and street ends (budget now a
   sixth, measured 14%). Five landmarks moved to ground the rotated
   lattices left them (`citybake --fit` named the spots). The review tools
   grew an `angle` column; the axis/diag run-probe under-reads shallow
   rotations, so the bearing plane is the truth and the probe is texture.
   Six scene-staged tests were re-staged on found-not-assumed ground —
   the recurring lesson of every fabric wave so far, §13.5 held.
4. **The esplanade + `contour`** — the waterfront fix. The biggest visual
   win in the plan; after it, every island wears its streets to the shore.
   **DELIVERED.** Wherever a non-rural borough meets the water, a street
   now runs at a quay's distance from it — carved from the water distance
   field, yielding only to authored coast roads that already stand within
   quay's reach themselves (an avenue six tiles inland is near enough to
   double and still leaves the shore unserved). Beachfront, The Terraces
   and The Docks became `contour` boroughs: their long streets are
   iso-distance bands of the shore field climbing inland at the borough
   pitch — the innermost IS the esplanade — and their cross streets are
   straight connectors perpendicular to the shore's mean tangent, all
   through the step-3 machinery; their blocks are crescents between bands,
   filled by the frontage-by-depth filler; their bearing plane carries the
   LOCAL shore tangent, tile by tile, so cars park along the curve. The
   invariant is §13.5's, now a test: every urban shore tile within five of
   carriageway, enclosed islets excused — measured shore-to-street p95
   went 25 (Beachfront), 73 (Sunridge Park) and 12 (Docks) to **4 in
   every urban borough**, with rural Marsh End rightly untouched. What
   the wave taught: the raw chamfer field carves honest three-wide bands
   but its gradient wobbles (bearings come from a blurred copy — carve
   raw, steer smooth); two bands meeting along an inland ridge read as one
   six-wide boulevard, which the parking trust test now accepts at the
   kerb (the disease was wrong headings, never width); and a stranded
   street the size of a street gets CONNECTED to the network by a track
   over bare ground, beach or quay rather than pruned — a promenade round
   a park shore touches no lattice, and pruning it re-opens the fringe it
   exists to close.
5. **`spine`** — Ravenhill woven off The Parade; the ring road gains
   frontage where it crosses the boroughs that face it. **DELIVERED.**
   Spine turned out to be contour with an avenue for a coastline: the long
   streets are iso-distance bands of the named road's course — measured
   analytically against the polyline, so the bands are exact and every
   tile's bearing is the avenue's real local tangent — bending where it
   bends and settling toward its mean far away, with straight connectors
   square to that mean. The innermost pair of bands is the avenue's own
   frontage street, four tiles off its kerb: The Parade stopped slicing
   through somebody else's lattice and got a borough shaped around it.
6. **`crescent`** — New Suburbs and Vasco Heights become loops and
   lollipops; the dead-end budget lands with it. **DELIVERED** for New
   Suburbs; Vasco Heights stays on the island's 12° grid — the §13.4
   table named it, but one settlement reading as one fabric beat two
   fabrics on one small island, and a dockside borough of crescents was
   the wrong century. The fabric: both lattice families WANDER (a sine of
   three tiles' amplitude, phase hashed per line), the narrower-pitch
   family keeps every line whole as the collectors, and the wider one
   loses roughly two stretches in five to the hash — loops and lollipops,
   dead ends as chase decisions. Each wavy tile writes its analytic
   tangent into the bearing plane, so cars park along the bend; the
   step-4 connect-don't-prune pass underwrites whatever the drops strand.
   The §13.5 dead-end budget is a test now: a crescent borough must hold
   between 5 and 80 stub tips — measured 15 — and the suite pins it.
7. **Squares and the circus** — market square, crescent greens, one circus
   on the ring.
8. **Park interiors** — paths, ponds, clumps, one landmark block per big
   park.
9. **Rural lanes + frontage granularity** — the polish tail.

Steps 3–4 change how the city reads from the air; 5–6 change how it reads
from a car; 7–9 are texture. After step 4 the map should pass the test this
document exists to state: **stand at any point of Anywhere City, look at the
minimap, and know which borough you are in from the shape of its streets
alone** — before reading a single colour.
