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
   on the ring. **DELIVERED**, as three new LANDMARK kinds rather than a
   new primitive: `square` (paved), `green` (grass) and `circus` are
   landmarks whose recipes stamp open ground with no solid parts — except
   the circus, which stands a 3×3 monument in the ring's median for the
   traffic to swing around. They are named, on the minimap, protected by
   the same claim-and-demolish machinery as every landmark, and — the one
   rule change — their footprints WELCOME carriageway: the bake's
   built-over-the-road error and `--fit`'s clear-rect test both exempt
   them, because streets flowing through is what makes a square a square,
   while a plaza's solid parts are still checked tile-by-tile (a monument
   one tile off the median severs the ring, and the bake says so). Four
   shipped: Market Square in the Old Quarter, Chapel Green in the
   crescents, Parade Ground on The Parade, King's Circus on the ring's
   north straight.
8. **Park interiors** — paths, ponds, clumps, one landmark block per big
   park. **DELIVERED** (`fillPark`, `buildings.ts`): gates thinned from
   the park's own kerb and ordered round its middle, a ring of walks gate
   to gate plus one long desire line — `meanderPolyline`, the same
   machinery as the rivers — ponds with noise-warped shores RINGED IN SAND
   (a pond has a beach, and the quay invariant demands land never meet
   water flush), woodland clumps off the paths from the countryside's own
   wildness field, and a bandstand deep in the green. The waterfront
   invariant learned to flood the SEA from the map corner first: pond
   edges are a borough's own interior water, not the waterfront boats
   arrive at.
9. **Rural lanes + frontage granularity** — the polish tail. **DELIVERED.**
   Rural lattice cuts keep their pitch and endpoints but are meandered
   before they are carved — the same midpoint displacement that makes a
   river a river makes a lane a lane — and the step-2 masks absorb the
   shapes. The shaped fills' units run a tile smaller, so row-houses
   stairstep finer along every curve. A side effect worth recording: the
   wandering lanes and the park paths cut the map's unreachable-courtyard
   count from 436 tiles to 3 — the sealed pockets §12.9 counted as a
   feature are all but gone, opened by lanes that no longer run straight
   past them. If enclosed courtyards are wanted back, they are now a thing
   to author, not an accident to keep.

Steps 3–4 change how the city reads from the air; 5–6 change how it reads
from a car; 7–9 are texture. After step 4 the map should pass the test this
document exists to state: **stand at any point of Anywhere City, look at the
minimap, and know which borough you are in from the shape of its streets
alone** — before reading a single colour.

---

## 14. The seams — a plan for the places where biomes meet

Fourth wave. §13 gave every borough its own street fabric and the map now
answers "where am I?" from shape alone — which means the city's remaining
visual debt has moved to the one place §13 deliberately did not spend:
the SEAMS. Between any two fabrics, between any two districts, between
town and country, there is now a line, and almost everything about that
line is an accident of two systems stopping rather than a place somebody
made. This section is the review of those lines, the doctrine for what a
good one is, and the sequenced plan. §9.4 wrote the transition doctrine
for the dead generator — ladders, ecotones, one density field, invariants
— and most of its ideas survive their author; they are adapted here to
the authored city rather than reinvented.

### 14.1 The review

Rendered at the seams (crops from `pnpm mapgen --crop`), and measured
along the ownership boundaries (owner-change tiles between non-rural
pairs; a "crossing" is carriageway on both sides of the line):

| seam | length | crossing tiles | share |
|---|---|---|---|
| Marsh End \| New Suburbs | 289 | 14 | 5% |
| Beachfront \| New Suburbs | 251 | 15 | 6% |
| Old Suburbs \| The Terraces | 236 | 28 | 12% |
| North Point \| Old Quarter | 195 | 46 | 24% |
| Ravenhill \| The Spine | 194 | 19 | 10% |
| Old Quarter \| The Spine | 171 | 33 | 19% |
| The Docks \| The Foundry | 170 | 12 | 7% |

**Finding 1 — the seams are torn, not made.** Where the Spine's rigid
columns meet the Old Quarter's 20° weave, both lattices simply stop: a
band of leftover ground, sliver blocks with confetti units on both sides,
buildings at odd clearances. The same at Ravenhill/Spine, where the
Spine's westmost blocks are half-width slivers pressed against
Ravenhill's torn edge. Nothing SAYS "two quarters meet here" — no street
runs the seam, no frontage faces it. Real cities change grid at an
avenue; ours changes grid at an absence.

**Finding 2 — neighbouring boroughs are walled off.** The table is the
finding: two ADJACENT urban boroughs connect along 5-12% of their shared
edge. Beachfront to New Suburbs — the seafront to its own suburb — is
crossable at 15 tiles of 251: for stretches of sixty-plus tiles there is
no way over the line short of a detour. §5 calls chokepoints the good
kind of constraint when they are DELIBERATE (a bridge, a gate); a wall of
block-backs between two living districts is the accidental kind, and it
makes every cross-borough chase route through the same one or two gaps
nobody chose.

**Finding 3 — every district channel flips on one line.** Palette,
building stock, density, prop mix, ped dress and turf all switch exactly
at the polygon edge — §9.4's "five channels switching independently at a
painted border", still true four waves later. The fabric seam is
identity and should stay sharp; the CHANNELS around it should not all
agree on the same tile.

**Finding 4 — town stops, country starts.** New Suburbs' last crescent
backs directly onto Marsh End's empty meadow: no fringe, no
smallholdings, no field pattern, nothing between "suburb" and "nothing".
The §9.4 ladder (`downtown → commercial → residential → suburb → rural →
nature`) is violated at nearly every urban/rural edge, and it is the most
jarring transition on the map because it is the largest.

**Finding 5 — some ground belongs to nobody.** The coastline warp pushes
land past the authored polygons (~1,900 shore tiles outside every
borough, §13.5), and slivers of interior ground fall between abutting
polygons. Unowned ground gets no fabric, no esplanade, no invariants —
transitions to it are transitions to an accident. §13.5 already named
the fix; it becomes load-bearing here.

What is already GOOD and must not be flattened: the water transitions
(quay/beach/esplanade — §13.6 step 4), the park interiors, and the
seams' very existence. §13's whole point is that fabrics differ; the goal
of this wave is that they meet like neighbours, not like torn paper.

### 14.2 What a good seam is

One sentence of doctrine: **a seam should be a PLACE — a street, a
fringe, a front — never an absence.** Three rules under it:

1. **Sharp identity, soft intensity.** The fabric (street bearing, block
   shape) may change on one tile — that is the borough's identity and
   §13 earned it. The intensity channels (density, palette mix, props,
   crowd) fade across a band, per §9.4's field doctrine.
2. **Ladders, enforced.** §9.4's adjacency ladders come back as bake
   invariants: land use may step one rank at a seam, and where the plan
   draws a two-rank jump, the bake inserts the mediating band — an
   urban/rural edge grows a fringe, a downtown/park edge grows a front
   street. Water's ladder is already law; land's becomes law.
3. **Crossings are made, not found.** A seam's permeability is a stated
   number per pair (a working share of its length for siblings, a few
   deliberate gates for strangers), asserted in tests like every other
   invariant — not whatever the lattices happened to leave.

### 14.3 The design

Six items, each with its mechanism named. All of them are bake-time; none
touches the sim.

**D1 — Own everything first.** Every dry tile outside all polygons is
assigned to the nearest borough (BFS over land from owned tiles — the
same chamfer machinery as everything else). Kills Finding 5, extends the
esplanade and every §13.5 invariant to the warp fringe, and gives every
seam an owner on both sides. Pure prerequisite; no visual change of its
own beyond the fringes joining their boroughs.

**D2 — Seam streets.** Where two urban boroughs abut, the boundary
itself becomes a street: trace the owner-change line into polylines
(marching along the boundary tiles), simplify, and carve as a 3-wide
course through the existing swept machinery — suppressed, like every
§13 street, where an authored avenue already runs the seam. Both
lattices then END on something: every lattice line that reaches the
boundary makes a T-junction instead of a stub, frontage on both sides
faces a real street, and the grid change happens AT an avenue the way it
does in a real city. The sliver blocks of Finding 1 mostly dissolve into
the seam street's frontage; those that survive fall under the §13.5
sliver rule.

**D3 — Stitching.** After seam streets, a healing pass for the
crossings the seam street cannot give (urban/park edges, borough pairs
whose seam is water or cliff): any street end within four tiles of a
street across the boundary gets the connector carved — the driveway/
rescue-track machinery generalised from "landmark to network" to
"stub to stub". The permeability invariant (14.4) is what decides how
hard this pass must work; it stops when the number is met, preferring
the shortest connectors.

**D4 — The blend band.** Within ~6 tiles of a district boundary whose
ladder distance is one, the bake dithers the CHANNELS: building records
near the line draw their district from either side by position hash
(mixed frontage — a commercial parade bleeding into residential
streets), block density interpolates toward the neighbour's, and the
prop/ped passes — which filter on district — inherit the dither for
free because they read the district plane. The bearing plane is
deliberately NOT dithered: fabric stays sharp (14.2.1). Where ladder
distance is two or more, no dither — D5's ecotone mediates instead.

**D5 — The rural fringe, and hedgerows.** The urban/rural ladder jump
gets its ecotone: a band one rural pitch deep on the country side of
every urban/rural seam becomes FRINGE — smallholdings (house-and-yard
stamps at low density), orchard rows, and lanes that continue out of
the suburb's collectors into the rural net (D3 stitches them). And the
one cheap trick with outsized reach: **hedgerows** — the rural
lattice's block edges carry intermittent tree-lines with gaps, so the
countryside reads as FIELDS rather than as empty green, everywhere,
not only at the seam. The masks of §13.6 step 2 already know every
rural block's perimeter; the hedgerow pass walks it. (T_TREES is
solid: gaps are gates, per the chokepoint doctrine — a hedge you must
find the gap in is countryside gameplay, not decoration.)

**D6 — Fronts for the strangers.** The two-rank seams that are not
rural: parks and the ring road. Urban blocks facing a big park get a
PARK FRONT — the park-side boundary carved as a street (the esplanade
mechanism pointed at parks instead of the sea), so houses face the
green across a road, the classic park-edge form. The ring becomes
limited-access: lattice lines that would T into its carriageways are
held one block short unless they are within a few tiles of an authored
junction — the motorway stops being a road with four hundred driveways
and its junctions become the chokepoints the §5 doctrine wants.
Gameplay-sensitive (chase routes change), so it ships behind the chase
bench (`pnpm chase`) with before/after escape rates, and is the one
item here that is allowed to be dropped if the bench says it hurts.

### 14.4 The invariants

Per the house rule, each item ships with its test:

- **Permeability.** For every adjacent non-rural pair: crossing tiles ≥
  12% of seam length (siblings), and ≥ 2 distinct crossings per 100
  tiles of seam. For urban/rural pairs: ≥ 1 crossing per 120 tiles —
  gates, not walls. The 14.1 table becomes the regression fixture.
- **The ladder.** No tile adjacency jumps more than one land-use rank
  without a mediating band (fringe, front, quay). Sweep the owner
  plane; assert zero violations. This is §9.4's red test, twelve
  months late.
- **No orphan ground.** After D1: zero dry tiles with owner -1. The
  stats table's "(1891 shore tiles outside every borough polygon)" line
  reads zero and the mapgen footnote is deleted.
- **Slivers at seams.** The §13.5 sliver rule, re-asserted specifically
  over the seam bands after D2 — the place slivers concentrate today.
- **Nothing regresses.** Waterfront p95 ≤ 5, dead-end budget, drowned
  roads ≤ baseline, one road component, 806 tests — the standing bar.

### 14.5 The sequence

Smallest first, each landing as code + rebake + crops + tests, per
§12.10; D1 is a prerequisite for everything and D6's ring item is
deliberately last and droppable:

1. **D1 own everything** + the no-orphan invariant. Mostly invisible;
   the esplanade quietly extends to the warp fringe.
2. **D2 seam streets** + the sliver re-assertion. The big visible one:
   every fabric change becomes an avenue.
3. **D3 stitching** + the permeability invariant. The chase map opens
   up; measure crossings before/after into the commit message.
4. **D5 rural fringe + hedgerows** + the ladder invariant. The
   countryside becomes fields; the suburb edge becomes a fringe.
5. **D4 blend band.** Channels fade; fabric stays sharp. Judged on the
   contact sheet — this is the one most likely to need taste passes.
6. **D6 park fronts, then ring access** — the latter behind the chase
   bench, with the standing permission to drop it.

What this section deliberately does not do: soften the fabric seams
themselves (identity is the product of §13, not a bug in it), blur the
water ladder (it is the best transition on the map), or reach for a
global blur field over districts — §9.4's "fields make everything fade"
is adopted for INTENSITY only, band-local, because a city where
everything fades into everything is the uniform plaid again with extra
steps.

### 14.6 DELIVERED — all six items, one wave

Shipped in one pass over `layout.ts`, `bake.ts` and `buildings.ts`;
what each item became when it met the map, and what it measured:

- **D1 own everything — DELIVERED.** Two BFS waves after the borough
  polygon pass: over land first, so the warp fringe joins the borough
  its ground hangs off; then a second wave allowed to wade, carrying
  owner across water but assigning only on dry ground, so the two
  landmasses no polygon touches (1,159 tiles off the east coast, 338
  off the west) join whoever faces them across the strait. Zero orphan
  dry tiles, asserted in `city.test.ts`. The esplanade follows
  ownership: a contour borough now skips it only INSIDE its authored
  polygon, so Beachfront's adopted headland got a shore street instead
  of staying the streetless fringe all over again (its shore p95 had
  hit 42; back to 4). The mapgen stray-shore footnote reads zero and
  went; islet shore no road can reach is counted aside instead of
  drowning the tables in `inf`.
- **D2 seam streets — DELIVERED.** Boundary tiles between non-rural
  owner pairs, traced from the west/north side only, dilated
  Chebyshev-1 into a three-wide course before the lattices carve —
  both fabrics then T into it. Suppression probes along the boundary
  NORMAL (the esplanade's own trick), so an avenue running the seam
  suppresses the band while an avenue crossing it merely becomes the
  junction. The seam street writes its own bearing — an axial mean of
  the traced line — because a car parked at a seam kerb walks the
  bearing plane, and the borough's lattice angle is an angle this
  street does not run at. Crossable share of every urban pair: was
  5-24%, now 71-100%.
- **D3 stitching — DELIVERED.** For seams at least one side of which
  is country: existing gates counted by clustering (carriageway facing
  carriageway within 4 tiles is one gate), one gate owed per 120 tiles
  of seam, candidates found by BFS from the seam over each side's OWN
  ground to its nearest street (so a gate serves the two boroughs it
  stands between), shortest connectors carved first, 40 tiles apart
  minimum. In practice the D2 streets and the rural lanes already met
  most floors; the invariant in `city.test.ts` is what keeps them met.
  One stated exemption: a borough with no carriageway at all (Gannet
  Rock, deliberately trackless) has nothing for a gate to join.
- **D5 fringe + hedgerows — DELIVERED.** A town-distance field (BFS
  over land from urban-owned ground) defines the fringe: country
  within its own district's pitch of town. There, smallholdings —
  house-and-yard stamps, world-grid anchor cells, six jittered darts
  per cell, yard must be clearable ground within reach of a lane — and
  orchard rows (hash-chosen cells, trees on a planted every-third-
  column grid, which is what makes them rows). Everywhere rural,
  hedgerows: an intermittent tree-line one verge back from every lane,
  world-grid hashed so runs cross block corners, never against a
  building, never rounding a junction corner (a hedge bending round
  one pens the verge in). A closing bake pass absorbs any pocket of
  grass the trees seal (≤20 tiles, pure meadow, landlocked) into the
  wood — the orphan-ground count is now zero, better than the
  pre-wave baseline of 3.
- **D4 blend band — DELIVERED, subtle.** One rung of the ladder
  (downtown↔commercial, commercial↔residential, industrial↔both),
  buildings hashed at 35% within 5 tiles of a one-rank neighbour adopt
  its district, and the district plane is repainted under their
  footprints — so the prop and ped passes inherit the dither for free,
  which was the whole §9.4 point. 50 buildings adopted across the
  city; the bearing plane untouched. Judged on the contact sheet:
  subtle is what was asked for and subtle is what it is.
- **D6 fronts and the ring — DELIVERED, ring kept.** Park fronts came
  free from D2: the park districts are non-rural, so their urban edges
  are seam streets (Spine|Ravenhill Park went from a torn edge to 71%
  crossable street with frontage facing the green). The ring: its dual
  carriageways and the authored avenues are recorded as masks while
  carving; every other road tile within two of the ring is shaved off
  outside a 9-tile dilation of the authored crossings, then any shaved
  tile still surrounded by carriageway on three sides is re-laid, so
  the shave leaves corridors, not potholes. Stranded lanes fall to the
  standing orphan machinery. Chase bench before/after: 3★ escapes 2/5
  → 3-4/5, 4★ 0/5 → 0/5, 5★ 0/5 → 0-1/5, survival times level — the
  junctions became chokepoints without tipping the calculus, so the
  ring ships.

The §14.4 invariants all landed as tests in `city.test.ts`: zero
orphan dry tiles; per-pair permeability floors (12% crossable and a
gate per 50 tiles for urban siblings, a gate per 120 for the
countryside, trackless boroughs exempt); the sliver rule — now
enforced at the source, `componentsOf` refuses any region under twelve
tiles or narrower than three, which took the city from 1,239 blocks to
1,132 and the seam bands from 25 slivers to none; and the ladder sweep
— zero adjacencies anywhere on the map where two built uses two ranks
apart touch without a street, quay, beach, hedge or verge between
them. §9.4's red test finally runs, and runs green.

The wave's own lessons, for the next one: a lattice's phase anchor is
`polyBounds` and must stay so (widening the carve box to the owned
extent rephased three boroughs and misfit nine landmarks — reverted for
the esplanade-outside-the-polygon rule instead); and half a dozen
passes that each decline one tile can strand that tile inside tarmac
between them, so the pothole rule is stated once at the end of the
layout — ground with carriageway on three sides is carriageway. The
crosswise parking budget stepped a sixth → a fifth: the ring fence
turned every held-back lattice line into a street end, and a stub tip
is exactly where the mark belongs. The ambient-motion floor eased 0.40
→ 0.35 for the same reason in the other direction — every seam street
is a run of new T-junctions, and a car waiting its turn at one is
traffic working. 808 tests pass; Seaview Infirmary moved two tiles for
the seam street that now runs past its door.

---

## 15. The diagonal — half-tile bevels, and the end of the square shoreline

### 15.1 The review

Every wave so far fixed structure: fabrics gave the boroughs their own
grids, seams gave the boundaries streets. But every EDGE on the map is
still a right angle, because the tile is one. The coast the water field
drew as a curve arrives on screen as a staircase of 16 px corners; a
beach reads as Lego; a headland is a crenellation. `REVIEW.md:155`
said it at the start — "all orthogonal, no diagonals" — and the fabric
waves answered it for streets while leaving it standing for ground.

The genre solved this before this project existed: GTA2's map format
had **diagonal block types**, precisely so shores and corners could run
at 45° on a square grid. That is the shape of the fix — not a finer
grid, not marching-squares meshes, but a per-tile annotation that one
half of the tile, cut corner to corner, belongs to the other side of
the boundary.

### 15.2 The design: the bevel plane

One byte per tile (`shared/src/world/bevel.ts`): `BEV_NONE`, or one of
four corner codes naming which half belongs to the corner neighbours'
material. Three properties carry the whole design:

- **Derived, not authored, and rng-free.** `deriveBevels` is a pure
  function of the finished tile plane, run at the end of `generateCity`
  after the last pass that carves a tile. The tile plane itself is
  untouched — every placement pass, every test and both hosts read the
  same bytes they always read — so the pass moves nobody, which is the
  placement doctrine's favourite kind of change (§1).
- **Two phases, because staircases and headlands are different.** On a
  rasterised 45° line all the inner corners live on one side; phase 1
  cuts that side (water yields to land, sand to grass) and the whole
  staircase becomes one continuous diagonal. A convex 90° headland has
  no water-side stair to cut, so phase 2 chamfers the land — but only
  where phase 1 did not already smooth that corner, because cutting
  both sides of one step recedes the coast twice and strands a
  half-tile spit (found by the first test that drew a staircase).
- **Soft ground only; built and sheer edges stay square.** Pairs:
  water↔sand, water↔field, water↔park, sand↔grass. A quay is coursed
  masonry, a bridge is a deck, a building is a building — squareness is
  what makes them read as *built*. The wooded sheer coast stays square
  too, for now: the 3D canopy is a box, and opening its corners to
  walkers would let them vanish under it.

Guards: the corner's two orthogonals AND the diagonal behind them must
all be the yielding-to material, and neither opposite orthogonal may be
(a tile with the sea on three sides is a tip, and cutting a tip makes a
point where the map meant a finger). One bevel per tile, first corner
in NE→SE→SW→NW order.

Consumers, one plane, four readers:

- **Collision** (`collide.ts`). `solidPartAt` answers NONE, FULL, or
  the solid half; the movement solver clamps to the hypotenuse as a
  linear bound — exact ops, prediction-safe — so a walker slides along
  a 45° waterline instead of snagging on its stairs, and a boat noses
  a diagonal bank. `isSolidTile` deliberately stays whole-tile and
  conservative: everything that PLACES or STEERS by tiles keeps the
  coarse answer, and only the solver that knows where a box is inside
  a tile gets the fine one. Movers gain space on one side of the line
  exactly where they lose it on the other; the mooring pass needs no
  guard at all, because a bevel needs two orthogonal land neighbours,
  only the CORNER of a mooring's 3×3 ring can have them, and a corner
  wedge starts 22.6 px from the mooring centre — beyond the hull's
  15.6 px reach (`amenities.ts:placeBoatSpawns`).
- **The 2D painter** (`tiles.ts:paintBevel`). The cut half is painted
  by the ordinary painters clipped to its triangle — the wedge gets
  the same speckle as the beach beside it — with `paintWater`'s pale
  lip drawn along the hypotenuse so the waterline is one continuous
  line whether square or diagonal.
- **The 3D ground.** The water cutout mask went from one texel per
  tile to eight per edge, so the alpha test follows the hypotenuse;
  a bevelled land tile's slab is sunk to sea depth and the dry half
  comes back as a **shore wedge** — the one non-box shape in the
  instanced city, a triangular slab whose vertical face down the
  hypotenuse IS the new waterline (`cityGeometry.ts:buildShoreWedges`).
- **mapgen.** Crops render the cut halves, and the summary line counts
  them, so a shoreline change shows its work.

### 15.3 The invariants

All in `shared/test/bevel.test.ts`: a 45° staircase becomes exactly one
cut per step, all on the water side, the land side suppressed; a true
headland chamfers from the land side; a pond goes octagonal and a
one-tile pond stays square; quays are never touched; the pass is a pure
function (two runs agree byte for byte); the movement solver enters the
open half and stops at the hypotenuse, slides a tile east for a tile
south along the coast, point and box queries agree on both sides of the
line, and both flip correctly for the water medium.

### 15.4 DELIVERED, and what stays square on purpose

254 bevelled tiles on the city (seed-independent — the ground is baked;
the plane is derived from it identically on every host), derived in
~9 ms on the 768×768 map. The first cut took 110 ms: a Set hash per
candidate corner across half a million tiles. The lesson is §14's
performance lesson again — a whole-map scan pays for its inner loop —
so the pair tables are flat byte lookups and the neighbours are index
offsets. 820 tests pass. Evidence: `evidence/city-shore-review.png`,
the lagoon mouth and outer spit breaking at 45°.

The rest of the orthogonality, ranked as next steps:

1. **Kerbs along the diagonal avenues** — road↔sidewalk as a cosmetic
   pair (both open, so collision never notices). The carved diagonal
   bands already get their paint from `marks.ts`; their kerb line is
   the last thing about them that stair-steps.

   **DELIVERED** as phase 3 of the derivation: the sidewalk yields its
   stair corners to the carriageway — never the reverse, because the
   traffic still drives its tile-grid lanes and a pavement wedge under
   a moving car reads worse than a square tooth of tarmac. 774 kerb
   cuts (1,028 bevels total), painted as bare asphalt with the kerb
   line following the hypotenuse. The gate earned its two stages the
   hard way: the covariance gate alone (`diagonalRoadDir`) passes at
   exactly the wrong place, because the road mass visible from a
   square crossroads corner is an L and an L's principal axis IS the
   diagonal — so the painter's cardinal run test is asked first, then
   the covariance, then the cut's hypotenuse must run WITH the band.
   The gate computes through `atan2`, admissible here and only here
   because the pair is cosmetic: road and sidewalk are open in the
   same media, so no host disagreement can ever move a body — only a
   kerb pixel. Evidence: `evidence/city-kerb-review.png`, against the
   square-grid boroughs which stay square to the tile.
2. **The wooded shore** — water↔trees for boats (the cliff face going
   diagonal is pure gain at sea level), once the canopy stops being a
   box in 3D or is allowed to overhang the cut.

   **DELIVERED** by taking the second branch: the canopy overhangs.
   The pair is one-directional — the WATER yields — and the direction
   is the whole trick: cutting the trees toward the water would open
   ground under a canopy box that draws square in 3D, but the water
   yielding just puts canopy over the cut, which is what trees do over
   water anyway. Land movers never notice (both materials are walls,
   so the bevel collapses to FULL and not one collision answer moves);
   the boats get a 45° cliff face to slide along, pinned in
   bevel.test.ts by a hull that noses deeper into the sea the further
   it sits from the wedge. In 3D the shore wedge for a trees cut rises
   to canopy height instead of street level — a corner of the cliff,
   not a green skirt at its foot. 122 wooded-shore cuts (1,150 bevels
   in all); the cliff's convex headlands stay square, which is the
   trees-side cut this pair deliberately refuses. Evidence:
   `evidence/city-cliff-review.png`.
3. **Chamfered building corners** — the bevel plane extends to
   building↔sidewalk unchanged, but the three renderers do not: a
   chamfered mass needs its roof canvas, its 2D extrusion and its 3D
   facade box to all cut the same corner. That is the road to genuinely
   diagonal PLACEMENT — a building footprint rasterised at 45° along a
   diagonal avenue is just a run of bevelled corner tiles once the
   drawing can keep up.

---

## 16. The road drawn in one line — street courses

### 16.1 The review

§15's bevels made the diagonal possible, but a curve is not a diagonal:
the ring road and the curved avenues still rasterise to stair-stepped
bands, their centre lines quantised to 45° dashes hopping tile to tile,
their kerbs a staircase the bevels could only chamfer. The absurdity is
that the curve EXISTS — `carveCourse` (`layout.ts`) sweeps a disc along
a smoothed polyline, which is why the bands turn at all — and the bake
threw the polyline away, shipping only its rasterisation. The renderer
has been reconstructing curves from their own wreckage (`diagonalRoadDir`
covariance, run measurements) when the source geometry was one field
away from being kept.

### 16.2 The design

Keep the courses. `StreetCourse` (`layout.ts`): the centreline polyline
in tile units, the carve width, and the kind (`ring` carriageways
already offset from the median; `avenue` otherwise). Recorded at the
three `carveCourse` call sites — exactly what the disc swept, offsets
and smoothing included — TRIMMED against the finished tiles at the end
of the bake (`bake.ts:trimCourses`: every half-tile sample of every
segment must land on carriageway, stubs under three tiles dropped, and
the polyline is quantised to the shipped hundredth-of-a-tile BEFORE
sampling, because trimming the true line and shipping a rounded one let
a point round across a tile boundary), and shipped in the baked city.
Tiles, collision, traffic: untouched — the band remains the drivable
truth, and the ground bake is byte-identical to the previous one.

The painter (`tiles.ts:paintCourses`) strokes them per chunk in
map-renderer order, all courses per pass: every kerb casing, then every
carriageway fill — so where two courses meet, the later fill opens the
junction through the earlier casing — then edge lines, then the centre
dash, one continuous curve through the whole course. Per-tile road
marks are suppressed on covered tiles (`courseCover`, swept exactly as
the carve swept): the ribbon and the staircase disagreeing about where
the road runs is worse than either alone. The 3D ground takes the same
chunks as textures, so the curve arrives in both renderers from one
painting.

### 16.3 DELIVERED

23 courses, 1,933 points, ~30 kB of bake. All 826 tests pass;
`courses.test.ts` holds the invariants (the ring ships both
carriageways, every centreline sample sits on carriageway, the wire
form round-trips at the shipped quantisation). Evidence:
`evidence/city-3d-ring.png` — the ring road curving through open
country as one stroked line, dashes flowing unbroken through the bend,
beside a straight avenue keeping its per-tile furniture.

**Second wave, DELIVERED — every street family a course.** The wavy
crescent lines are analytic, so their centrelines were free: recorded
whole, drops and all, and the trim pass cuts each recorded line into
the crescents the drop hash actually built. The straight rotated
lattice lines record their two endpoints and let the trim clip them to
the borough. The contour and spine bands have no polyline — they are
per-tile predicates over a distance field — so the curve is RECOVERED:
the band's centre iso-tiles are chained by a greedy nearest-unvisited
walk, relaxed twice with a moving average to shed the chamfer field's
octagonal facets, and trimmed like everything else. 289 courses,
9,658 points; the per-tile probes that keep a band off a neighbouring
road never need re-stating, because the trim clips to what was carved.
Evidence: `evidence/city-3d-contour.png`, `city-3d-crescent.png`. Zebra crossings across a course
vanish with the suppressed per-tile marks; crossings that follow the
curve want course-space placement. And the ribbon's flat asphalt could
carry grain once the painter can clip to a stroked path.

**The trim's floor, corrected (BUGS.md §9.3).** This wave shipped 409
courses under a flat three-tile floor, and 120 of them were streaks
rather than roads: a junction is carriageway in every direction, so a
few tiles of a carved-away line crossing a crossroads passes every
sample the trim takes, and paints an isolated ribbon at whatever angle
its parent ran. The floor is now three times the course's own width —
nine tiles for a street, twelve for an avenue or the ring — which is
more than the widest crossing in the city measures corner to corner.
289 courses survive with 97.8% of the painted centreline length; the
tile and district planes hash identical to the previous bake, so this
moved paint and nothing else. `courses.test.ts` holds both ends of it:
no stub under the floor, and the long courses still there.

---

## 17. The plan, generated — a city rolled, then held to the drawn one's checks

### 17.1 The question

"Generate the landmass in the sea with polylines, fit roads to it, then fill
the space between the roads with buildings or nature depending on the biome —
are there approaches like these?"

Yes, and this is one. It is the mainstream city-generation pipeline, stage for
stage, and most of it already runs here:

| Stage | The prior art | Where it lives in this repo |
| --- | --- | --- |
| Landmass first, as vector geometry, biome from the land | Patel's *Polygonal Map Generation for Games* (2010) and `mapgen4`; mewo2's *Generating fantasy maps* | §12.3's outlines, §12.7's warp |
| Roads fitted to the land | Parish & Müller, *Procedural Modeling of Cities* (2001); Chen et al.'s tensor fields (2008); Galin et al.'s anisotropic road paths (2010) | §13.4's fabrics, `carveCourse` |
| Blocks between the roads, filled by land use | Parish & Müller's allotments; weighted straight skeletons; Watabou's ward generator | §13.6's block regions, `fillBlock` |

The failure mode every one of those papers has to work around is the same one
§13.1 Finding 3 found here by eye: treating the coast as a MASK applied after
the roads, so the grid is clipped by the water and every shore is a fringe of
slivers. The fix in the literature and the fix here are the same — make the
shore GENERATE structure rather than subtract it — and it is already built:
the esplanade, the contour fabric, the quays.

So stages 2 and 3 of the question were done. Stage 1 was not, because §12.6
deleted the generator on purpose and replaced it with a drawing.

### 17.2 The design: generate the PLAN, not the tiles

`shared/src/world/plangen.ts`. Its entire output is a `CityPlan` — the schema
`shared/data/city-plan.json` holds by hand — and every pass downstream of it
is the authored pipeline, unchanged.

That is the whole idea. The old generator made TILES, which meant the
expensive question ("is this city playable?") could only be asked at runtime,
where it was too expensive to ask, so it was never asked. A generator that
makes a plan inherits the offline bake, the exhaustive checker and the
`--fit` tooling for nothing, and a generated city that fails the checks is
rejected before anybody commits it — the same rule a drawn one lives under.
The plan is also small enough to be a tractable thing to generate: a few
hundred numbers, not half a million tiles.

The pipeline, and the one step that makes the rest work:

1. **An archetype**, rolled once — `estuary`, `strait` or `archipelago`. §4's
   last item: the cheapest macro variety there is, because it decides the one
   thing a player reads off the minimap in a second.
2. **The land**, as radial loops whose radius wanders with the angle. The
   noise is sampled on a CIRCLE in noise space, so θ and θ+2π are the same
   sample and the loop closes without a seam. Bays are bitten out of the rim;
   a river widens to its mouth or a tideway cuts clean across.
3. **The coast is then PAINTED AND MEASURED** (`layout.ts:paintWater`).
   Everything after this point is placed against the shore that will actually
   exist, not the polygon that was drawn. Without it a borough seeded on the
   outline lands forty tiles out to sea and a road routed round the drawn bay
   runs straight through the real one — the warp is ~22 tiles deep, and that
   is not a detail you can place things through.
4. **Boroughs**, dart-thrown with a minimum separation, then sorted by
   distance from the chosen downtown and handed their type in bands: §3.2's
   concentric-zone gradient, stated as a sort. Industry takes the water far
   from the middle; the rim is countryside. Each cell is the multiplicatively
   weighted Voronoi region of its site, extracted by binary search along 72
   rays — deliberately NOT clipped to the land, so a borough owns its own
   waterfront and the esplanade pass runs a street along it.
5. **Arterials by anisotropic shortest path** over that land — cheap on
   ground, dear over water. That single ratio makes the interesting decision
   by itself: a road goes the long way round a bay when the detour is cheaper
   than the crossing, and bridges the strait when it is not. Nothing in the
   generator says "bridge here". A spanning tree plus the short extra links
   that make it a network you can make a decision in, and then the plan's
   `maxBridgeSpan` has the last word — a course that would wade further than
   a bridge can span is thrown away, measured on the SMOOTHED polyline
   because smoothing is what the layout will carve.
6. **Fabric by land use** (§13.4) — the "depending on the biome" half of the
   question, and one lookup rather than a system, because the fabrics already
   exist. Downtown gets a tight rotated grid; a seafront borough follows its
   shore; a suburb wanders and dead-ends; the country gets lanes.
7. **Landmarks placed against a real layout.** The plan is laid out once,
   unfinished, purely to ask what `pnpm citybake --fit` exists to answer by
   hand: which blocks came out, and how big are they. Then turn it, then
   shrink it, rather than fail to place it — a runway laid north–south is the
   same runway, and a city with no airfield is refused by the checker.

Two repairs are worth naming because they are what "generated" costs:

- **Every tile has a borough.** One countryside polygon covers the whole map
  and is drawn FIRST, so every cell overwrites it. What it catches is the
  fringe the warp raised outside every cell, which would otherwise get no
  fabric, no invariants and no esplanade — §14.3's D1 problem from the other
  end.
- **A borough the arterials cannot reach becomes countryside.** Not deleted:
  the ground is still there and you can still get to it by boat. What it
  stops being is a lattice of streets nobody can drive to, which is the
  precise thing the checker's one-street-network rule refuses.

### 17.3 DELIVERED

`pnpm plangen [--seed=N] [--size=640] [--png=...] [--json=...]`, and
`pnpm plangen --sweep=N`, which is the deliverable that matters: N cities
nobody has looked at, each held to `checkCity` — the same function
`pnpm citybake` runs, extracted to `server/src/tools/cityCheck.ts` and now
shared by both tools rather than copied.

Measured: **44/44 seeds at 640 tiles pass the checker with no errors**
(seeds 100–119 and 500–523, two sweeps, neither looked at first), and 16/16 at
the 384-tile floor. 8–16 boroughs and 150–700 blocks a city, ~10 s each. Most
carry one or two warnings, which is the band the drawn city sits in — it ships
one. Evidence: `evidence/plangen-seed500.png`, a nine-borough estuary city with
the contour fabric plainly following its north shore and a spine borough east
of the bay.

Two bugs fell out of pointing a generator at the pipeline, and both were
real:

- `bake.ts:fringeAt` indexed the plane without a bounds check. The drawn city
  never puts a block against the map edge; a generated one does, and an index
  off the end reads as `undefined`, which is not less than zero, so the
  district lookup exploded on a borough that does not exist.
- Landmark siting asked "is there a road within seventy tiles" with a box
  scan, which is not the question. A farm on a headland with a trunk road
  plainly visible across the water passes that test, gets no driveway because
  there is no ground to cut one through, and fails the checker for having no
  road to it. Reachability is the property, so a single breadth-first sweep
  over cuttable ground now measures it.

**What this is not.** It does not touch `shared/data/city-plan.json` and it
does not write `city.data.ts`. The one city is still the drawn one (§12), for
all the reasons §12.1 gives, and a session seed still moves only the
furniture. What changed is that "roll a city" is now a plan you can open, read
and edit — the way a generated city would ever become the shipped one is the
way any city does: somebody looks at the plan, edits it, and runs the bake.

### 17.4 The beaches — what "smooth" turned out to depend on

The question the first wave got asked was simple: are the beaches smooth? The
answer was no, and the interesting part is why not, because the bevel pass
(§15) was working perfectly the whole time.

`deriveBevels` is a pure function of the finished tile plane, so it runs on a
generated city exactly as on the drawn one, and where sand meets water it does
cut a clean 45°. But it only cuts SOFT ground: a quay is coursed masonry and
stays square on purpose (§15.2). So "is the coast smooth" is really "how much
of the coast is beach", and the shore pass lays sand only where the district is
`park` AND the shore is in the swell's lee (`layout.ts`; everything else is
quay). Measured on the first draft against the drawn city:

| | quay shore | beach shore | waterline bevelled |
| --- | --- | --- | --- |
| Anywhere City (drawn) | 4,409 tiles | 615 | 4.2% |
| plangen seed 500, first draft | 2,207 tiles | 198 | 3.7% |

The drawn city earns its beaches by hand — Sunridge Shore is a park borough
somebody put on the south coast because that is where sand belongs. The
generator had no such step, and worse, §17.2 had actively worked against one:
the borough cells are deliberately NOT clipped to the land so that an urban
borough owns its own waterfront and the esplanade pass runs a street along it.
Owning the waterfront buys esplanades and costs beaches, and nothing in the
first draft made that trade on purpose.

**Shore parishes.** Every stretch of coast that faces away from the swell and
belongs to a borough with no business quaying it — downtown and industry are
exempt, because a city's middle grew round a harbour and docks need deep water
at a wall — becomes a parish of its own: park, rural, drawn last so it wins the
seaward lip of whatever it fronts.

The geometry is a ribbon, not a traced region. Candidate shore tiles are
chained by the greedy nearest-unvisited walk §16 used to recover a contour
band's centreline (a stretch of coast IS a curve; what a raster of it lacks is
the order), smoothed, and then offset by the shore normal to both sides — six
tiles seaward, thirteen to twenty inland. No marching squares, no hole
handling, and the result is a simple polygon by construction.

One choice is load-bearing: a parish has **no streets at all**. A ribbon of
rural lanes fifteen tiles wide along a coast would be carved inside the parish,
touch no arterial, and be a second street network — precisely what the checker
refuses. The borough behind keeps its streets and its frontage; what is in
front of them is the beach.

`plangen` now prints the waterfront on every run and every sweep line, because
it is the number that moved and the number that would quietly go back:

```
waterline: quay 1559, beach 805, bridge 56, road 1 — 391/2414 tiles bevelled (16.2%)
```

Measured after: **44/44 seeds at 640 tiles still pass the checker** (100–119 and
500–523) and 14/14 at the 384 floor, with 4–16% of the waterline bevelled,
median ~9%, against the drawn city's 4.2%. Seed 500 went from 198 beach shore
tiles to 365 and from 3.7% to 6.0%; seed 1 reaches 805 and 16.2%. Evidence:
`evidence/plangen-shore.png`, a long unbroken beach breaking at 45° under a
crescent suburb, and `evidence/plangen-seed500.png` for the whole coast.

Not fixed: the parish's own interior is bare. The rural ecotone (§14.3 D5)
takes its depth from the district's street pitch, and a parish's pitch is zero
by the argument above, so the smallholding band never fires and the strip
behind the dunes is plain meadow. Separating "how deep is the fringe" from "how
far apart are the lanes" is a `bake.ts` change, and this was not the wave for
it.

**What is left out, deliberately.** Islets: a rock in the water is a lovely
thing and a stranded street network waiting to happen, because the borough
whose polygon covers it gives it a fabric and the esplanade runs a quay round
it. Putting them back means owning each one with countryside, which is a plan
edit rather than a generator one. Also left out: the dual-carriageway ring
(the router would have to close a loop, not just span a tree), `byAir`
islands, squares sited on junctions the traffic model has already labelled,
and any use of the archetype after the geography — a `strait` city and an
`estuary` city currently differ in their water and not yet in their street
hierarchy.

---

## 18. Every shore a polyline — the coast drawn in one line

### 18.1 The review

§16 gave the roads their curves back and named the reason: the curve EXISTS,
the bake threw it away, and the renderer spent its life reconstructing curves
from their own wreckage. The coast is the same complaint with the opposite
cause. Nobody drew the coastline — it fell out of a warped distance field
(§12.7) sampled at tile centres — so there is no polyline to keep. The line is
real, it is smooth, and the only record of it anywhere is a staircase of 16 px
right angles.

§15's bevels bought back the biggest half-tile of that staircase and could
never buy back more: a bevel is one 45° cut, and a coast turns through every
other angle too. Ask the flyover and it shows: `evidence/city-shore-review.png`
is a beach made of squares with some of its corners chamfered.

### 18.2 The design

`shared/src/world/shoreline.ts`, three steps and no authored input:

1. **Trace.** Every edge between a wet cell and a dry one, directed so the
   water is on the RIGHT, chained end to end into closed loops — one per
   island, per lake, per rock. Exact: it is the tile plane's own boundary.
   The winding is the whole interface: it says which side is sea without
   anybody having to test a point.
2. **Round.** Chaikin corner-cutting, twice. A rasterised line's corners are
   all the same size, so cutting all of them is exactly the right move.
3. **Thin.** Douglas–Peucker at a third of a tile. Six thousand corners
   become three thousand points on the shipped city; 33 ms for the whole map.

**Derived, not baked**, and that is the difference from §16. A course had to
be baked because the carve's polyline was the only copy of it; a shore has no
source but the tiles, so recovering it costs no wire bytes, no bake format and
no `city.data.ts` churn — and works identically for a city nobody drew. Like
the bevel plane it is a pure function of the finished tiles, computed beside
it in `generateCity`, so both hosts get the same coast from the same bytes
without sending any of it.

**Cosmetic, like the courses.** Collision still reads `isSolidTile` and the
bevel plane, traffic drives its lanes, boats moor against `T_BANK`. What moved
is what the coast LOOKS like. The smoothing is bounded so the two cannot part
company: `shoreline.test.ts` pins every smoothed point within one tile of the
raw boundary it came from — about the same licence a half-tile bevel already
takes.

**Cut per tile, and this is the part that took two tries.** A renderer wants
the coast tile by tile, and the obvious way to give it that is the nearest
segment to each tile. It is wrong by a whole tile edge: two neighbouring tiles
pick two different segments, clip themselves against two different lines, and
those lines cross the shared edge at two different points — a chain of chords
that do not meet, which is a staircase again at a jauntier angle. `shoreChains`
splits the polyline AT the tile boundaries instead, so the entry and exit
points are shared and what each tile draws joins what its neighbour draws.

`shoreHalf` then cuts a tile square into its dry and wet halves. Also two
tries: clipping the square by each run's half-plane in turn shaves a sliver
off BOTH halves at every bend, and the slice that belongs to neither shows as
a notch. It traces instead — along the chain, then round the square's own
border back to where the coast entered — which partitions the square exactly
however the chain wanders. Which half is which is settled at the tile's
CENTRE: a probe stepped off the coast itself lands outside the square on the
commonest tile there is, one whose coast runs along its own border.

### 18.3 The three painters

One geometry, three consumers, and they had better agree — a coast in one
place on the ground plane and another in the mesh standing on it is worse than
a coast that steps.

- **The 2D chunk painter** (`tiles.ts:paintShoreTile`). The generalisation of
  `paintBevel`: land on one side of the cut in whatever the land is made of
  here, sea on the other, and the pale lip stroked along the chain. A tile the
  coast crosses skips its bevel and its own tile-edge lip, exactly as a tile
  under a road course skips its per-tile marks (§16).
- **The 3D ground's cutout mask.** Already eight texels an edge, always built
  to follow a line finer than the tile; until now the finest line it had was a
  45° cut. It now asks the chain.
- **The 3D geometry** (`cityGeometry.ts:buildShorePrisms`). The one that
  actually shows: the silhouette in 3D is instanced BOXES, so a curved cutout
  under a square slab changes nothing. A tile the coast crosses now loses its
  box entirely and gets a prism whose top face is the dry half and whose
  vertical face down the chain IS the waterline. `buildShoreWedges` stays for
  the bevels the coast does not reach. Walls go down every edge of the half,
  the tile borders included — skipping those is the obvious saving and it
  leaves holes you can see the sky through, because two neighbouring dry
  halves share only the point where the coast crosses their border.

### 18.4 DELIVERED

3,011 points over 17 loops on the shipped city, 7,079 tiles cut, derived in
33 ms — the first cut took 98, and the fix was §15.4's lesson a third time: no
`Math.hypot` in the inner loop of a pass over every corner of every coast.
~6,700 shore prisms replace the same number of boxes, so the instanced city is
no bigger.

Evidence: `evidence/city-shore-curve.png` (the same flyover as §15's
`city-shore-review.png`, retaken), `evidence/city-shore-curve-2d.png` (the
same crop with and without the curve, side by side) and
`evidence/plangen-shore.png` (a generated city's beach, which gets this for
free because nothing about it is authored). `shoreline.test.ts` holds the
invariants: one closed loop per island, water on the right, a lake wound the
other way, the coast running UNDER a bridge, no coastline along the edge of
the world, purity, the one-tile smoothing bound, chains that start and end on
a tile border, neighbouring tiles agreeing on the crossing point, and the two
halves of every tile adding up to the tile.

What is still square, and why:

- **The waterline still steps where the tiles do.** The line is smooth to the
  eye at any zoom the game uses, but a coast that runs nearly east–west across
  a tile boundary genuinely jogs a tile, and the smoothing is deliberately
  bounded at one tile so the drawn coast cannot get far from the collision the
  player feels. Loosening it is a knob, not a design change.
- **The minimap** paints its own tiles and has not been taught the loops.
- **Quay coping and bank edges** on tiles the coast does not cross keep their
  square lip, which is right: a quay is coursed masonry (§15.2).

---

## 19. The waver in a straight street — recovered courses, simplified

### 19.1 The review

Asked why roads are sometimes curvy, the answer turned out to be two answers,
and only one of them was on purpose.

Measured over every course in the shipped city — mean turn per point, and how
often that turn reverses direction:

| course group | mean turn/point | turn reversals |
| --- | --- | --- |
| The Terraces (contour) | 5.6° | 62% |
| **Ravenhill (spine)** | **5.0°** | **78%** |
| The Docks (contour) | 4.6° | 65% |
| Beachfront (contour) | 3.8° | 58% |
| New Suburbs (crescent) | 2.8° | 5% |
| avenues + ring | 0.5° | 53% |
| every grid borough | 0.1° | — |

A real curve turns the same way for a run: the crescent fabric, which wanders
sinusoidally because §13.4 says a postwar suburb wanders, reverses on 5% of
its points. Contour and spine reverse on 58–78%. That is not curvature, it is
zig-zag — and `paintCourses` strokes every recorded point through a spline, so
it showed as a visible waver in the ribbon.

The cause is in §16.2's second wave. Those two fabrics have no authored
polyline — they are per-tile predicates over a distance field — so their
centreline is RECOVERED: the band's centre iso-tiles are chained by a greedy
nearest-unvisited walk, relaxed twice with a moving average, and decimated by
two. The chain is made of TILE CENTRES. A moving average lowers quantisation
noise and can never remove it, because the signal being filtered is the same
size as the sample spacing; decimating by two then keeps every second sample
of it.

### 19.2 What is in the drawing and what is in the ground

The two fabrics are not the same case, which the first diagnosis got wrong:

- **`spine`** builds its field with `segmentDistance` to the avenue's own
  polyline — exact Euclidean. Its iso-bands are exact offset curves, so the
  tarmac is smooth and every bit of the waver was in the record.
- **`contour`** bands the shore distance field, which `layout.ts` deliberately
  keeps as a raw 3×3 chamfer: blur it and its slope flattens near ridges and
  bays, so a band of three distance units smears to four or five tiles and
  stops being a street. A chamfer metric is octagonal, so those iso-lines
  really are faceted. Some of that waver is in the ground.

### 19.3 The design

`simplifyPolyline` in `plan.ts` — Douglas–Peucker, iterative, beside
`smoothPolyline` and `meanderPolyline` where the polyline utilities live — and
`traceBands` relaxes four times instead of two and then simplifies at a third
of a tile instead of decimating. A third of a tile is under the half-width of
the narrowest band traced, so a simplified course cannot leave the tarmac it
records and the trim pass has nothing to drop.

Simplification is what a moving average cannot do: a straight run comes back
as two points and has nothing left to waver through, while a real bend keeps
every point it needs.

`plangen.ts` drops its own private copy of the same algorithm.

### 19.4 DELIVERED

The measure is the sagitta at each interior point over the local point
spacing: a smooth curve sampled at h has sagitta h²/8R, small when the points
are close relative to the radius; jitter of amplitude a has sagitta about a,
which is not.

| fabric | wander before | after |
| --- | --- | --- |
| **spine** | 0.052 | **0.004** |
| contour | 0.058 | 0.047 |
| crescent | 0.036 | 0.036 |
| avenue/ring | 0.018 | 0.018 |
| grid | 0.002 | 0.002 |

Which is exactly the split §19.2 predicts. The spine fabric drops to the grid
fabric's own floor — all of its waver was in the record, and it is gone. The
contour fabric improves by a fifth and stops there, because the rest of it is
in the tarmac.

**The ground is byte-identical.** The tile, district and bearing planes hash
the same as the previous bake, and the city still has 1,132 blocks, 3,801
buildings and 66 shops. What changed is `courses`: 9,658 points became 8,062,
street courses fell from 29.0 points each to 22.8, and `city.data.ts` lost
23 kB. Two more courses survive the trim than before, because a course that
wavers off its own carriageway is a course the trim drops.

`courses.test.ts` holds it: mean wander under 0.03 and the 95th percentile
under 0.15, measured at 0.019 and 0.098. Neither floor is zero and neither
should be — chasing the last of it would mean the drawn road leaving the road.

### 19.5 Not done: the Euclidean field, and rotated houses

**The contour fabric's faceted ground stays.** An exact Euclidean distance
transform in place of the chamfer would fix it at the source and keep constant
band width, which is the property blurring was rejected for losing. It is not
worth it yet: the residual after simplification is 0.047 sagitta over ~2.8
tiles of spacing, about a tenth of a tile, and buying it means re-cutting every
street in The Terraces, Beachfront and the Docks and moving every block,
building and shop behind them.

**Houses on a rotated or curved street still do not face it**, and §13.2.2's
verdict stands for a reason that is worth restating with evidence: buildings
have no atomic existence in the 3D city. `cityGeometry.ts` walks TILES and
emits one box per tile column, with heights from the volume grid — a
`Building` record is a 2D bookkeeping rect, not a mesh. "Rotate the drawn
mass" therefore means rebuilding the instanced city around per-building
geometry, which is the renderer project §13.2.2 declined, not a smaller one.

What §13.4's mitigation does instead is working, and can be measured: the
frontage granularity cap gives curved and rotated boroughs small footprints
where straight ones get terraces — 2.3×2.8 tiles in The Terraces and 2.7×2.9
in New Suburbs against 3.9×8.4 in Old Suburbs. Small axis-aligned boxes still
stairstep along a 26° street; they are just a finer staircase.

---

## 20. Which way a building faces

### 20.1 The review

`evidence/city-facing-before.png`: North Point, whose streets run at 26°, with
every building on them square to the world. It reads as a model somebody
dropped on the wrong grid — the roads were drawn at an angle over a city that
was built on the axes, which is exactly what had happened.

§13.2.2 saw this coming and declined it: *"Axis-aligned `Building` records.
The 3D renderer extrudes them, the volume grid and doorways derive from them.
Rotated footprints are a renderer-and-collision project, out of scope."* Its
mitigation — finer rects on curved frontage — is real and measurable (2.3×2.8
tiles in The Terraces against 3.9×8.4 in Old Suburbs) and it makes a finer
staircase, not a building that faces its street.

### 20.2 The design

The doctrine that carried the courses, the bevels and the shores carries this
one too: **the tiles are the truth, and only the drawing changes.**

`Building` gains an `angle`. The FOOTPRINT is the same axis-aligned rect it
always was — collision, the volume grid, doorways, shopfronts and every
placement pass read `x, y, w, h` and cannot tell anything happened. What
rotates is the mass the renderers stand on that footprint. So this is not the
project §13.2.2 declined; it is the half of it that costs nothing downstream.

- **The angle comes from the bearing plane**, which every fabric has been
  writing per tile since §13.4 — the borough's own street angle, the shore's
  tangent in a contour borough, the spine's course in a spine one. Derived
  once in `bakeCity` rather than at the eight places a building is created,
  and taken only where the whole footprint agrees on it: a building straddling
  a seam between two fabrics faces neither, and squaring it is the honest
  answer there. 43% of the city's buildings face something.
- **The mass fits back inside its own plot.** Rotating a rectangle grows its
  bounding box, so `buildingMass` scales it to fit the footprint plus half a
  tile — enough to lean into its own pavement, where a doorstep is, and not
  into the carriageway. One helper, three renderers: they must agree on this
  box to the pixel or a building is in three places depending on who drew it.
- **A shop keeps its square columns.** A shop is a room punched out of a
  footprint and open to the sky; one mass over the whole rect would put a lid
  on it. The same rule `roofCanvasFor` has always applied per tile.

### 20.3 The three renderers, and the two things that broke

- **The 3D instanced city.** Buildings had no atomic existence there: the walk
  emits one box per TILE column with heights from the volume grid. Now a faced
  building's tiles are skipped and it is emitted once, rotated. `Boxes` gains
  a seventh float — a yaw — and `writeTo` composes a scale-rotate-translate
  instead of a scale-translate, skipping the trigonometry for the zero case,
  which is every instance in the city bar these.
- **The 2D chunk painter** draws the mass as the hexagon `paintWall` draws, at
  the angle, and then blits the SAME baked roof canvas turned — reusing
  `roofCanvasFor` rather than re-authoring speckle, parapets and clutter
  against a polygon is what keeps a rotated roof and a square one obviously
  the same city.
- **The parallax extrusion** leans the turned mass: `rotatedExtrusionOf`
  exposes whichever of the four edges the roof moved away from, with the
  normal off the edge rather than off the axis, so the caller's sun test is
  unchanged.

Two things broke, and both were the same mistake in different places —
something that belonged to the mass stayed behind with the tiles:

1. **The parapets floated.** `buildRoofDetail` rings a roof with four lips per
   tile, and a square ring hanging over a turned roof reads as a picture frame
   in the air. The lips are now built round the mass and turned with it.
2. **The plot showed through.** Both chunk builders left the ground under a
   building unpainted — a flat fill in the 3D texture, nothing at all in the
   2D one — on the entirely sound grounds that a roof covered its own
   footprint exactly. A turned mass does not, and the corners it vacates
   showed the fill as dark squares lying the old way round. The plot is now
   painted for every building tile with the nearest ground beside it: costs a
   fill nobody sees in the square case, and saves a branch that could disagree
   with the mass painter about which buildings are turned.

### 20.4 DELIVERED

Evidence: `evidence/city-facing-before.png` and `evidence/city-facing-3d.png`,
the same flyover over North Point. 1,624 of 3,801 buildings face a street.
Instances fell from 649,834 to 619,866 — a rotated mass is one box where a
footprint was four to twenty-five.

`facing.test.ts` holds the part that matters: every mass inside its own plot
to within a quarter tile, a square building exactly square, a turned one a
true rectangle about the footprint centre, every angle equal to the bearing
its own tiles carry, and every footprint still integral with its centre tile
still its own ground. `extrude.test.ts` gains the rotated lean: only faces the
roof moved away from, each built from its own edge, each normal square to it.

What did NOT change is the point: the tile plane, the district plane and the
bearing plane hash the same as the previous bake, and `city.data.ts` grew only
by the angles themselves.

**Still square, deliberately.** The footprint, and therefore everything that
reads it — you still collide with an axis-aligned box, and at 240 px altitude
doing 300 px/s that is the right trade, because the alternative is oriented
bounding boxes inside the prediction hot loop. A doorway is still on a tile
edge. And a building on a seam between two fabrics still faces the world
rather than picking one of its two streets.

---

## 21. Streets on top of one another — the merge, the markings, and the forecourt

### 21.1 The review

Asked why streets look layered on top of each other, the answer was two
things, one in the ground and one in the paint.

**The ground.** Counting carriageway that is over-wide — more than nine
continuous tiles of tarmac in ALL FOUR directions, which is
`signals.isJunctionTile`'s own test (`MAX_LANE_TILES = 4`) and is what makes a
plaza rather than a crossroads — the city has **490 such tiles, and 441 of
them lie within eight tiles of an authored avenue**. It is not lattice on
lattice: it is a borough's street running alongside an avenue and merging with
it into one sheet. Biggest patches: 13×8 tiles beside The Parade, and 10×14 in
The Terraces.

There IS a guard, and it is the right idea aimed at the wrong granularity.
`doubledUp` and `doubledUpCourse` refuse a street that spends MOST of its run
beside somebody else's road — and their own comments say why the threshold is
generous: *"a lattice line can brush one for a third of its length while being
the only street the rest of the borough has."* True, and the consequence is
that the brushing third gets carved.

The Old Quarter is where it shows, because it is the tightest fabric in the
city and its lines are closest together. Pitch 11×9 with 3-wide streets is
**55% road by construction** — 1 − (8/11)(6/9) = 51.5% predicted, 55% measured,
against 26% in New Suburbs — so an avenue landing between two lattice lines
merges with both.

**The paint.** `paintCourses` strokes casing for every course and then fill for
every course, so casings get covered — that ordering is deliberate and is what
opens a junction (§16). But the edge lines were stroked PER COURSE (pale ring
at width−2, then the interior repainted at width−4), and the centre dash for
every course at the end. Where two courses overlap, each left its own markings
lying across the other's surface: two dashed centre lines and a stray pale edge
line on one sheet of tarmac. That is what makes a merge read as *layering*
rather than as width.

### 21.2 DELIVERED: the markings, and the forecourt

**Markings, widest last.** The pale rings still go down in one pass. The
interior repaint and the centre dash now go down in width order, thinnest
first: each tier's repaint covers every thinner course's markings it crosses
before its own dash goes on. An avenue's line carries on through; the street's
stops where the avenue takes over. The casing and fill stay in one pass each,
because grouping THOSE by width would draw an avenue's kerb across every
street that meets it.

**The forecourt turns with the house.** §20 turned the mass and left it
standing on square paving, which reads as a house somebody rotated after the
fact — which is what it was. `paintMassApron` lays the apron the building
would actually have: the mass grown by a tile, at the mass's own angle, with
the paving slabs painted in the apron's own frame so they run with the
building. Clipped to the building's own tiles and the ring of soft ground
beside them, so a doorstep may take a tile of grass and may not take a lane.
Both chunk builders draw it, so the 2D city and the 3D ground texture agree.
Evidence: `evidence/city-facing-3d.png`.

### 21.3 NOT DELIVERED: the merge itself, and why

The ground fix was built and taken out again. It is written down here because
it very nearly works and the next attempt should start from what it cost.

The fix is to move the doubling test from the LINE to the TILE, and to make it
direction-aware: a field of the nearest authored road per tile and the
direction it runs, and a lattice tile is not carved when an avenue is within
half a width plus three AND within 25° of parallel. Direction is the whole of
it — a street CROSSING an avenue is near it for a few tiles and must still be
carved, because that crossing is the junction the street exists to make; only
near-and-parallel is a duplicate.

Measured, it does what it says. Over-wide patches fell from **119 to 73**, the
worst from **71 tiles to 46**, and the 13×8 sheet beside The Parade became
three ordinary junctions.

It also broke three tests, and one of them matters: an errand driver stopped
completing its route. Trimming the middle of a line leaves the ends behind, and
the city gained **24 dead-end stubs** (195 → 219). A stub is still connected,
so `checkCity`'s one-street-network rule passes it and the bake's
scrap-clearing pass — which only takes carriageway off the main network —
leaves it alone. A cosmetic gain of 0.3% of carriageway is not worth a car
that cannot finish its journey.

What the next attempt needs is a way to retire the whole of a line that
conflicts rather than the conflicting stretch of it, or a pass that clears the
stubs the trim leaves — the shape of `trimCourses`, applied to tiles rather
than to courses.

And one thing the measurement found that is NOT this bug: **The Terraces is
51% carriageway**, with a 46-tile sheet down its middle that the avenue guard
does not touch. Its contour bands are iso-lines of the shore distance field,
and where that field's wavefronts meet — the medial axis between two stretches
of water — the bands stop being a pitch apart. A local gradient test was tried
and rejected: it changed one block and two buildings, so the smearing is not a
flat gradient but two unrelated band families interleaving. Banding each
borough against ONE shore rather than against the nearest water is the fix, and
it is a design change rather than a guard.

---

## 22. The sliver — when a house should refuse to turn

### 22.1 The review

§20 turned 1,624 buildings and held them to one invariant: the mass stays
inside the plot the footprint claims. It does. What the test never asked is
whether anything is left of it.

The mass keeps its aspect ratio and scales to fit its own rotated bounding
box, so the cost of a turn depends on the footprint's shape. A square at a
shallow angle pays a few percent. An elongated one turned across its long axis
pays everything: measured over the turned buildings, the drawn area was p50
0.84 of the footprint but **410 buildings under 70%**, **70 under 50%**, and
the worst a 2×4 shed at 112° drawn at 0.35 scale — **12% of its own plot**.

Which is not a cosmetic complaint, because collision reads the FOOTPRINT. A
mass shrunk to a third of its rect leaves the rest of the rect standing there
invisible: footprint corners sat outside the drawn mass by a mean of 0.56 tiles
and up to **3.66 tiles — 58 px of wall you cannot see**. The §20 test passed
throughout. "Inside its own plot" is satisfied perfectly by a mass that shrinks
to nothing, and a one-sided invariant is how that got shipped.

### 22.2 The design: a floor, and refusal

`massFit(w, h, deg, slack)` is lifted out of `buildingMass` and made public,
because the decision belongs BEFORE the drawing. `bakeCity` asks it while
deriving the facing and simply does not record an angle when the fit falls
below `MIN_FACING_FIT = 0.85` — linear, so the drawn area is never under 72%.

Refusing rather than fudging, for the same reason §20 derived the angle from
the bearing plane in the first place: an angle on a building means "this is
the street it fronts", and the two alternatives both break that. Scaling only
the overflowing axis keeps the area by lying about the building's proportions —
a 7×2 shed becomes a 4×3 one. Easing the angle back until it fits keeps the
shape by lying about the bearing, and `facing.test.ts` asserts the angle equals
the bearing its own tiles carry, which is a rule worth more than the turn.

The honest answer for a footprint that cannot afford its street is that the
footprint was cut to the wrong grid, and until the plot cutter is the thing
that changes, such a building is square to the world.

The test gains the missing half: the drawn area of every turned mass is at
least `MIN_FACING_FIT²` of its footprint — and, so the floor cannot pass by
being vacuous, at least one mass must actually be scaled down.

### 22.3 DELIVERED

| | before | after |
|---|---|---|
| buildings that face a street | 1,624 (43%) | 1,188 (31%) |
| drawn area, p50 | 0.84 | 0.89 |
| drawn area, worst | **0.12** | **0.73** |
| footprint corner outside the mass, mean | 0.56 tiles | 0.42 tiles |
| footprint corner outside the mass, worst | **3.66 tiles** | **1.35 tiles** |
| 3D instances over North Point | 619,866 | 628,532 |

436 buildings gave up their turn — and cost 8,666 instances back, because a
building that stays square is one box per tile column again. That is the price
of the rule and it is worth it; the §20 saving was partly a saving on drawing
less of the city than the city has. The city's angles are mostly ±12–26° off the
axes, where the floor costs nothing; what it takes out is exactly the elongated
sheds turned across themselves.

Two smaller things from the same review, both in `TileRenderer`:

- **The forecourt is the plot's own material.** `paintApronGround` always laid
  pavement, so a farmhouse in a field stood on a turned slab of city paving.
  The nearest-ground pick that `paintPlot` already did is now `plotGround`, and
  both call it — a plot and the apron on it cannot disagree about what the
  ground is. Never with plants, either: a tree baked into a doorstep is a tree
  the house is standing on.
- **The apron is ground, so it is painted like ground.** It sat inside
  `if (!this.extruded)` with the walls and roofs, which meant `?extrude=1`
  turned the masses per frame over square paving — the §20 bug again, one layer
  down. It now runs in the chunk's ground pass, before the shadows, so a
  neighbour's shadow crosses a doorstep like it crosses any other pavement.

**Not done, and known.** `massesNear` still scans every building in the city
per chunk; it wants the block index the shops pass uses. `shoreCover` in
`shoreline.ts` is dead since the chains landed. And the evidence PNGs are 5 MB
of the repository.

### 22.4 The audit, and the rule rebuilt

§22 shipped and was then audited — three passes over the finished city, one
for roads, one for buildings, one for terrain, each told to be harsh and to
back every claim with a picture or a number. The buildings pass came back with
a verdict on §22 itself: **it made the city look worse, and here are the A/B
frames.** It was right, and this is the correction.

**What the floor actually cost.** Of the 436 buildings it refused, **68% had a
fit of 0.75 or better** and only **20** were the genuine slivers the rule was
written for. Worse, the refusals concentrated exactly where a diagonal is most
visible — **178 at bearing 26°, 141 at 20°** — so the boroughs whose streets
most obviously run askew were the ones handed back their square boxes, which
is §20.1's original complaint restored. And because it refused per building
rather than per borough, 90 blocks ended up holding both a turned house and a
squared one on the same frontage: half-and-half reads as a fault where either
pure answer reads as a choice.

The mistake was picking the threshold off a percentile table without looking
at which buildings fell either side of it. The measurement was right and the
inference from it was not.

**The fix is upstream of the floor, in both directions the audit pointed.**

- **`MASS_SLACK` is a whole tile, not a half.** The lean allowance was what
  forced the shrink. A plot is bounded by its own pavement and a doorstep, a
  porch and a bay window all live in that ring, so a mass may use it. What it
  may still not touch is the carriageway, and half a tile per side does not
  reach — which is no longer an argument but a test, `never leans into the
  carriageway`, sampling every drawn mass against the ground it covers.
- **The bearing is folded into (−45°, 45°] before it is recorded.** A
  rectangle turned θ and turned θ−90 puts its walls on the same two lines;
  only which of its own axes runs along the street differs. Taking the bearing
  raw turned elongated buildings across themselves for nothing — a 2×4 shed on
  a 112° street costs a fit of 0.56 raw and 0.75 folded to 22°. A bearing of
  exactly 90° folds to 0, which is the truth: a rectangle square to a
  north-south street *is* square to the world, and three buildings were being
  "turned" 90° into a transposed mass with a band of bare plot above and below.

`MIN_FACING_FIT` stays at 0.85 and now bites 91 times instead of 436.

| | §20 | §22 first cut | now |
|---|---|---|---|
| buildings facing a street | 1,624 (43%) | 1,188 (31%) | **1,533 (40%)** |
| drawn area, median | 0.84 | 0.89 | **1.00** |
| drawn area, worst | **0.12** | 0.73 | **0.74** |
| footprint corner outside the mass, worst | **3.66 tiles** | 1.35 | **1.48** |
| masses touching carriageway | 0 | 0 | **0** |

The median mass is now drawn at its **full footprint size** — with a tile of
lean, most turned buildings do not have to shrink at all, which was never true
before. Evidence: `evidence/city-facing-3d.png`, the same North Point flyover.

Two more from the same pass, both renderer bugs the audit found by comparing
the three renderers at one location:

- **`?extrude=1` lidded thirty-two shops.** The parallax renderer turned a
  mass on `angle !== 0` alone, where the 2D painter and the 3D city both also
  require a solid footprint — so a shop the other two drew open became a
  rotated dark void with its counter and shelves stranded outside it. The same
  rule now lives in all three. While there: a non-solid footprint's base is
  filled tile by tile over its walls instead of as one rect, so a **square**
  shop stops being lidded too.
- **Seven houses had a stunt ramp for a forecourt.** `plotGround` rejected
  only wall, water and bridge, so a plot next to a ramp resolved its material
  to `T_RAMP` and laid a rotated ring of yellow hazard chevrons round the
  house. Ramps are placed at runtime, which is why no bake showed it. It now
  rejects carriageway, ramp, runway and shop floor as well — none of them is
  something a plot is ever surfaced with.

---

## 23. The audit: what three harsh passes found in the ground

The same audit, on everything that is not a house. What follows is what was
fixed; §23.3 is what was found and left, which is the more useful half.

### 23.1 Blockers — the tiles, not the drawing

**A bridge that stopped in open water.** The no-causeways pass (§14) reverts
bridge tiles whose crossing is too wide, working tile by tile — so a crossing
too wide in the middle and narrow at its ends keeps its ends. Kelvin Bridge,
the city's named crossing of the strait, left the north bank, ran 47 tiles out
and stopped **14 tiles short of the far shore**; being attached at one end it
was on the road network, so a player could drive off it into the sea. The
Ring's east crossing was the same thing, a 24-tile pier tapering to one tile.

A bridge exists to join two pieces of land, so each deck is now taken **whole**
and asked how many separate places it lands — eight-connected, so one landfall
straddling a diagonal step counts once. Fewer than two and it goes back to
water. Four decks went; road running straight into water fell from 15 tiles to
9, because the stub prune then tidied what fed them.

**Two ~187-tile sandbars floating in the sound.** `despeckle` asks how BIG a
landmass is, and a bar four tiles wide and fifty long passes that comfortably
while being a strip of quay and beach standing in open water with nothing
behind it. `drownSandbars` asks a different question — **depth, not area**: a
landmass must contain at least one tile a full two tiles from water on every
side. The margin is not fine, it is absolute; the smallest real islet in the
city has 189 such tiles and every bar had **zero**. Seven components went,
including five specks nobody had noticed.

### 23.2 The paint

**A thousand one-tile holes in the quay.** Both shore passes tested four
neighbours, so every diagonal step of a coast left a tile whose only water is
on the corner as bare grass: a green-and-tan checkerboard along every diagonal
shore, behind a waterline that §18 had just smoothed. Eight-connected now, in
both passes — **1,025 holes down to 4** (the 74 that remain are park lawns
running to the water, which is a lawn and not a hole).

**Three centre lines braiding down one carriageway.** §21.2's width tiers
could not touch the commonest case: two streets of the SAME width land in one
tier, so both repaints go down and then both dashes, and neither ever covers
the other — ~15,000 tiles of it. Equal widths cannot be ranked by width, so
they are ranked by **how long the road is**, which is the seniority a driver
reads off the ground anyway: the through road's line carries on, the side
road's stops where it joins.

**Tarmac painted on the sea.** A course is a curve and the ground under it is
not, so a stroked ribbon overhangs the tiles the carve actually took — **385
tiles** of water and building wall were being painted as carriageway and kerb,
worst beside the bridges. The course pass is now clipped to ground a road may
be drawn on. Water and walls only: the casing is *meant* to reach past the
carriageway onto the kerb band.

**Bridge parapets were rungs.** `paintBridge` decided the rail axis by asking
whether a bridge tile lay east or west — true of every tile of a four-wide
north-south deck, so every tile drew rails top and bottom and the deck came
out as a ladder across the road. A parapet now stands on any edge with open
water across it, and abutments get none. It had been invisible because the
course ribbon covered 1,506 of 1,524 deck tiles; fixing the clip surfaced it.

### 23.3 Found and NOT fixed

Written down because an audit whose findings are half-fixed and half-forgotten
is worth less than one nobody ran.

- ~~**Over half the drawn coastline is still a tile staircase.**~~ **FIXED by
  VECTOR phase 1 (§25):** 55.1% → 19.7% axial. The diagnosis here was right
  that no smoother could do it — the answer was to stop recovering the curve
  from the raster at all.
- ~~**Diagonal bridge decks are raw staircases.**~~ **FIXED (§31).**
- ~~**Past the world edge the 3D view is a flat green void.**~~ **FIXED
  (§32)**, with one caveat recorded there: the flyover clamps its camera into
  the map, so the vantage this was originally probed from cannot show what it
  was read as showing.
- **`?extrude=1` and the 3D ground pass order the apron and the courses
  differently**, and the 2D chunk builder now differs from both.
- **Lattice-on-lattice merging is worse than §21.1 diagnosed.** At a ≥7×7
  solid-tarmac threshold only 58% of merged tiles are near an authored avenue;
  **1,289 tiles are street-on-street** with no avenue involved, which
  contradicts §21.1's "it is not lattice on lattice". PARTLY addressed by §28
  (over-wide 294 → 276); §28.3 measures why suppression cannot finish it.
- ~~**Zebra crossings laid as carpet.**~~ **FIXED (§35)** — gated on the
  course crossings rather than on the tile plane.
- ~~**Two lighthouses on the same four tiles**, and `Marsh Post` standing on an
  empty field.~~ **FIXED (§30)** — and Marsh Post was a bake bug, not the
  authoring slip it looked like.
- **68 course junctions meet under 30°**, 21 of them under 15° — against
  §13.5's stated invariant. (Was 71/29; §28's suppression took three.)
- ~~**Trees stand dead on the tile lattice at identical scale.**~~ **FIXED
  (§34).** Woodland is still drawn as a 1-tile-high green plinth — that is the
  canopy-as-a-box of §15.4 and wants its own change.
- ~~**`pnpm mapgen` cannot see any of this.**~~ **FIXED by VECTOR phase 0
  (§24).** It draws courses, markings, kerbs, masses and the coast curve, and
  `--tiles` renders the raster alone so the difference between the two
  pictures is the curve layer.

---

## 24. VECTOR phase 0 — teaching the review tool to see

`VECTOR.md` is the plan to collapse this city's three representations into
one. Its phase 0 builds no city and changes no pixel of the game: it fixes the
instrument, because every later phase is judged by eye and the tool the docs
point at was blind to everything those phases touch.

### 24.1 What the tool could not see

`server/src/tools/mapRender.ts` was a per-tile colour fill. It drew the raster
of the roads and nothing else: no course curves, no lane markings, no kerb
casing, and no rotated building masses — so a city where §20 never happened
and a city where it did produced **the same picture**. §16's stroked courses,
§21's marking order and §20's turned masses were all invisible to
`pnpm mapgen`, `--sheet` and `evidence/city-fabric-review.png`, which is the
loop §13.6 says every wave is judged by.

That is the honest explanation for how the audit's paint findings survived
three waves of review, and for why §22 shipped a bad threshold: it was chosen
off a percentile table because there was no picture to choose it from.

### 24.2 What it draws now

- **Course ribbons in the client's own paint order.** Casing for every course,
  then fill for every course — which is what opens a junction — then edge
  lines, and last the interior repaint and centre dash course by course,
  widest last and within a width longest last (§21.2, §23.2). Mirroring the
  ORDER matters more than mirroring the pixels: a tool that drew each course
  complete before starting the next would show junctions sealed shut and
  markings stacked, defects the game does not have, and would hide the ones it
  does.
- **Dashes measured in arc length** along the polyline, so the cadence follows
  a curve instead of being chopped per segment — what `setLineDash` does.
- **Turned buildings as the mass the game draws**, with the plot beneath
  painted as plot rather than wall, which is the client's `paintPlot` rule.
  Without it the square footprint and the turned mass are both drawn in the
  building's colour and their union is a blob that reads as neither shape.

Implementation note: distance-to-nearest-segment rather than filled quads,
which is the idiom the shore pass in the same file already uses, and which
gives round joins and caps for nothing — the equivalent of the client's
`lineJoin = 'round'`.

### 24.3 `--tiles`, and why it is the point

`pnpm mapgen --tiles` draws the raster ALONE: no coast curve, no courses, no
masses.

**The difference between that picture and the default one is the curve layer** —
the second map of this city that nobody owns, which `VECTOR.md` exists to
delete. It makes the plan's central question visual: where do the two
representations disagree, and by how much. Every later phase should shrink the
difference, and when the last one lands the two pictures should differ only in
the sub-pixel places where a rasteriser must round.

Evidence: `evidence/vector-p0-tiles.png` and `evidence/vector-p0-curves.png`,
the same 80-tile crop of the 26° commercial borough. The first is everything
the review loop could see for the whole of §16, §20 and §21.

### 24.4 DELIVERED

~250 lines in `mapRender.ts`, one flag in `mapgen.ts`, no behaviour change to
the game and nothing deleted — the only phase in `VECTOR.md` of which that is
true. `RenderableMap` gained `courses` and `buildings`, both optional, both
already present on `CityMap`, so `mapgen` and `plangen` pick them up without
changes.

---

## 25. VECTOR phase 1 — the coast, upstream of the raster

The change §18 could not make. §18 recovered the waterline from the finished
tiles and smoothed it; this makes the waterline the definition and the tiles
its rasterisation. Same doctrine as always — the tiles are still what the sim
reads — but the ARROW now points the other way, and that is what a smooth
coast turned out to depend on.

### 25.1 It was already a field. Two lines destroyed it.

The coast was never a polygon problem. `paintCoast` builds a signed distance
field, warps the SAMPLE POINT through four octaves of noise, damps the warp
where the shore faces the swell, and asks whether the result is positive.
Everything up to that question is continuous. Two things quantised it:

1. `sample()` read the field with `Math.round` — **nearest neighbour** — so
   the field was on the tile lattice before anything else happened. It is
   bilinear now.
2. The result was thresholded into a mask, and everything downstream worked on
   the mask.

So the fix is not a polygon library. It is: keep the field continuous, and
take its **zero contour by interpolation** instead of thresholding it.
`geometry.ts` does that with marching squares whose crossing points are placed
by linear interpolation along each cell edge — one detail, and the difference
between a curve and a staircase.

### 25.2 Booleans without a boolean library

§9 of `VECTOR.md` called exact polygon union "the whole risk". It never had to
be built: **a union of implicit fields is `Math.max`.** The islands, the bays
and rivers cut out of them, the islets and the spits added after the warp, and
the forced margin of open sea round the map are all signed depths now, and
`landAt` combines them arithmetically. The one conversion from implicit to
explicit geometry happens once, at the contour.

`strokeHit` gained a signed sibling, `strokeDepth`, for exactly this: a
boolean test can only be rasterised, a signed depth can be contoured.

### 25.3 What went, and what it was doing

Three raster passes existed to undo damage the raster had done, and all three
are gone:

- **morphological open/close** ("a coast is allowed to be ragged, not
  confetti") — the blur already on the distance field does this, on the field,
  where it belongs;
- **two `despeckle` passes** — `coastRings` drops rings under 120 tiles² by
  area, on the shape rather than on its rasterisation;
- **`drownSandbars`** (added six hours earlier, §23.1) — replaced by
  `ringHasInterior`, which asks the shape's hydraulic radius (area ÷
  perimeter ≈ half the width) instead of flood-filling the mask. A bar four
  tiles wide and fifty long has the area of a respectable islet and no
  interior at all; width is the property that tells them apart, and a ring
  knows its width without being rasterised first.

And `shoreline.ts` is deleted — 514 lines. `deriveShores` was the round trip
itself. `shoreChains` and `shoreHalf` moved to `geometry.ts`: they never
looked at a tile to decide where the coast is, they only INDEX a curve per
tile, which a painter still needs.

### 25.4 DELIVERED

| | before | after |
|---|---|---|
| waterline within 7.5° of an axis | **55.1%** | **19.7%** |
| coast rings | 15–17, incl. bars and specks | **9** |
| where the coast is defined | traced from tiles, at every client start | **shipped in the bake** |
| land area | — | −0.3% |
| tiles that changed side | — | 0.30% of the map |

The coastline is the same coastline — a third of a percent of the map changed
side — and it is no longer a staircase. `city.data.ts` grew 782 → 840 kB for
the 4,289 shipped vertices, and `generateCity` stopped rebuilding them at
every load.

888 tests pass. `geometry.test.ts` states the two properties everything
downstream leans on: the rings are wound with the water on the right, and
**rasterising the rings reproduces the field they came from** — which is the
claim that makes the tile plane a cache rather than a second opinion.

### 25.5 What this cost, honestly

- **The city moved.** Two landmarks needed re-siting in `city-plan.json`
  (Kessler Power, The Eyrie) because the ground under them changed. The plan
  is the authored document and the coast is now different; that is an edit,
  not a workaround.
- **Two tests were staged on incidental geography** and broke. Both are now
  map-independent, which they should always have been: the fists test aims
  where `clearAim` says there is room instead of assuming east is clear, and
  the prediction test picks a lane by asking the PHYSICS whether a car can
  drive away from it rather than asking the tile plane for a clear ray. The
  second had been hiding a weak assertion — its sibling accepted `travelled >
  0`, which one pixel satisfies, so a completely undrivable lane passed it.
- **The bake is slower**: 7.0 s → 10.7 s, because the field is evaluated at
  half-tile spacing rather than per tile. It runs offline, once.
- **`bevel.ts` is NOT deleted**, contrary to the plan. Its coast cases are now
  redundant, but it also bevels the beach-against-grass line and the kerb of a
  diagonal avenue, and collision reads it. Narrowing it belongs with the road
  work, not here.

---

## 26. VECTOR phase 2 (part) — junctions from the curves

Two marking systems have disagreed about junctions since §16. The per-tile
painter leaves one bare — `if (horizontal && vertical) return; // junction:
bare asphalt` — and the ribbon painter stroked its centre dash straight
through, so **5,780 of 15,260 junction tiles** carried a dash the game's own
rule says they should not (§23.3).

A junction is where two centrelines meet. That is a fact about the LINES, so
`courseJunctions` asks the lines: every course segment is bucketed by an
8-tile cell, near pairs are intersected, and each crossing becomes a disc of
half the wider carriageway. Both painters punch the dash out of those discs —
the client with an even-odd clip of a rect minus counter-wound circles, the
review tool with a per-pixel test. **The tool applies the same rule as the
game, because a tool that did not could not be used to check that the game
does.**

Evidence: `evidence/vector-p2-junctions.png`.

### 26.1 NOT DELIVERED, and the measurement that says why

The rest of phase 2 — retiring `trimCourses`, deleting the per-tile marking
system outright, and deduplicating doubled courses in vector — is **not** in
this commit, and the reason is a number rather than a judgement.

Courses cover **76.1% of carriageway tiles** (78,127 of 102,719). Deleting the
per-tile marking system today would leave a quarter of the city's roads
unmarked. Much of that quarter is junction box and merged sheet, which SHOULD
be bare — but "much" is not "all", and the honest way to find out is to raise
coverage first and delete second, not the other way round.

`trimCourses` is the same shape of problem from the other end: it exists
because passes downstream of the carve REMOVE carriageway (the orphan prune,
the doubling suppression), leaving a course drawn over ground that is no
longer road. Inverting it properly means those passes editing the course and
the carve together, in the vector domain — which is the same work as the
vector dedup, and wants doing once, deliberately.

---

## 27. Reviewing the VECTOR work

The plan's own §7 says each phase lands with a review. This is that, for
phases 0–2, done by measuring the claims rather than restating them.

### 27.1 The central claim holds — with two exceptions worth naming

`VECTOR.md` §3.1 promises the tile plane becomes a pure function of the curve.
Rasterising the nine shipped coast rings and comparing against the shipped
tiles: **1,775 of 589,824 tiles disagree (0.301%)**, and they fall into two
groups.

**1,282 are bridge decks** — the ring says wet, the tile says `T_BRIDGE`. That
is correct and expected: a deck is laid over water after the coast exists, and
a bridge is not land. Not a disagreement about where the coast is.

**493 are not.** The tiles hold water the rings call land, in 13 clusters up to
127 tiles across. 486 of them are **enclosed** — and there are **zero lake
rings among the nine shipped**.

### 27.2 The finding: park ponds are a second water boundary with no curve

`buildings.ts:596` carves ponds into park blocks, in tiles, long after
`paintCoast` has produced the rings. So the city has water the coast curve
does not describe: the painters shade the sea against a curve and a park pond
against the tile edge, which means **a pond has a staircase shore in a city
whose coastline no longer does**.

This is precisely the defect class this plan exists to remove, reintroduced at
a smaller scale — and it was invisible until the equality check was run,
because nothing else asks the rings and the tiles to agree. It is the strongest
argument in this whole exercise for making that check permanent rather than a
migration crutch (§3.1 says the crutch gets deleted; on this evidence it
should be promoted to a test instead).

The fix is not to move pond-carving into `paintCoast` — a pond belongs to the
park that contains it, and parks are placed much later. It is for the pond to
be authored as a ring and rasterised, the same way the coast now is, with
`geometry.ts` doing both.

The remaining **7 tiles** are the pier prune (§23.1) drowning abutment tiles
that were land before a deck was laid on them. Small, and the same shape of
bug: a raster pass moving a boundary the curve owns.

### 27.3 The other leftover: bevels still describe the coast too

`bevel.ts` was not deleted, for the stated reason that it also serves the
beach-against-grass line and diagonal kerbs. But **362 of its 1,208 bevel
tiles (30%) touch water** — a second, raster-derived description of the very
edge the rings now own. The painters already reconcile them by hand ("prefer
the chord and skip the bevel on the same tiles", `tiles.ts:986`), and a
reconciliation at paint time is the smell this plan is named after.

Narrowing `deriveBevels` to non-water edges looked like a small follow-up.
**It is not, and the reason given here was wrong** — corrected in §29.3: the
blocker is not ponds but COLLISION. `collide.ts` reads the bevel plane, so
removing the water bevels would leave the waterline drawn as a curve and
collided as square tiles, which is a bigger mismatch than the one it tidies.
They can go when water stops being a wall.

### 27.4 What landed, honestly

| phase | state | evidence |
|---|---|---|
| 0 — the instrument | done | `--tiles` A/B; the tool now sees courses, markings, kerbs, masses |
| 1 — coast as curves | done | axial waterline 55.1% → 19.7%; `shoreline.ts` deleted; 3 raster passes deleted |
| 2 — courses authoritative | **part** | junctions from the curves; the rest blocked on 76.1% course coverage (§26.1) |
| 3 — plots as OBBs | **not done** | 7 world-axis emission sites in an 870-line file, then the volume grid, `collide3`, doorways and 3 renderers |
| 4 — collision follows geometry | **not done** | blocked on 3, and wrong to build before it |

Net so far: **−932 lines against +231**, one module added (`geometry.ts`) and
one deleted (`shoreline.ts`), with `morph`, `despeckle` and `drownSandbars`
gone from `layout.ts`.

### 27.5 What I would question if I were reviewing this cold

- ~~**The equality check is not a test.**~~ **Fixed in this commit.**
  `coastCache.test.ts` runs it, and asserts not "no disagreement" but "no
  disagreement except the two written down": bridge decks, and the 486 pond
  tiles, both pinned so neither can grow. Nothing may disagree for a reason
  nobody has recorded.
- ~~**`contourRings` truncates silently.**~~ **Fixed in this commit.** An open
  contour now throws. Worth noting that the real city bakes clean under the
  strict version, which is the evidence that the strictness costs nothing.
- **The bake is 50% slower** (7.0 s → 10.7 s) because the coast field is
  evaluated at half-tile spacing. Offline, once, and worth it — but it is the
  kind of cost that compounds if later phases sample more fields.
- **`shoreHalf` and `shoreChains` now live in `geometry.ts`** with a
  `ShoreLike` interface invented for them. That is a seam: they were written
  against `ShoreLoop` and now take a structural type. Fine, but it is the sort
  of thing that quietly becomes two shapes again.

---

## 28. The doubled road — suppression measured, and its ceiling

You circled two roads that had merged into one over-wide sheet. It is §21.3's
open item, and VECTOR phase 2 is where it becomes expressible: the test can now
compare a course to the OTHER COURSES instead of to a snapshot of the tiles.

### 28.1 Why the old test could not see it

`doubledUpCourse` samples `pre` — the tile plane as it stood *before this
borough's lattice began*. Two consequences, and the picture is both of them:

1. **A lattice line cannot see its own family.** Neither line existed when the
   other was judged, so two of them are free to merge.
2. **A raster cannot tell alongside from across.** It infers direction from
   how often it hits, so a crossing sampled at the wrong phase reads as a
   conflict — which is why the threshold had to be a lenient "most of the
   line", which in turn lets a long merge through.

`doubledAgainstCourses` compares curve to curve. Direction is explicit (within
25° of parallel, so a crossing never counts however close it comes), every
accepted course is visible including the borough's own, and a failing line is
retired **whole** — §21.3's trim left 24 stubs because the ends of a trimmed
line stay behind and stay connected; a line that never existed leaves nothing.
Dead ends went 184 → 188 rather than 184 → 219.

### 28.2 Three configurations, measured

| | over-wide 7×7 | doubled samples | blocks | tests |
|---|---|---|---|---|
| before | 294 | 2,025 | 1,125 | pass |
| ratio only (>50% of the line) | 272 | 1,761 | 1,102 | pass |
| + 40-tile continuous run | **233** | **1,463** | 1,046 | **2 fail** |
| + 24-tile run | **149** | **962** | **926** | fail badly |
| **shipped: + run + seniority** | 276 | 1,784 | 1,096 | pass |

The 24-tile run halves the problem and guts the city — a rotated borough came
out with almost no streets, because retiring whole lines **cascades**:
suppressing one lets the next survive to be judged against a different
neighbour.

At 40 tiles two tests failed, and they are the two §21.3 already named. One is
a quality floor — long courses (≥100 tiles) fell to 88 against a floor of 90 —
and it caught something real: **the rule preferentially retires LONG roads**,
because a long line has more length in which to acquire a doubled stretch, and
long lines are exactly the ring, the avenues and the borough-length streets
everything navigates by. The other was an errand driver that stopped
completing its route, which is that same loss seen from the sim.

So the shipped rule adds **seniority**: a line yields to a road LONGER than
itself and never to a shorter one. The through road carries on, the side road
stops — the same principle the marking tiers use (§23.2).

### 28.3 DELIVERED, and the ceiling

Over-wide carriageway **294 → 276**, doubled course samples **2,025 → 1,784**,
across 132 → 123 course pairs, at a cost of 29 blocks. 890 tests pass.

That is a 12% dent, and the table above is the honest reason it is not more:
**suppression cannot fix this.** Every configuration that removes enough
doubling to be worth seeing also removes streets people drive on. The
remaining doubling is mostly in the contour and crescent fabrics, which have no
doubling test at all because their bands are traced from a distance field
rather than laid as lines — and where that field's wavefronts meet, the bands
stop being a pitch apart. That is §21.3's diagnosis and it wants §21.3's fix:
band each borough against ONE shore rather than against the nearest water, so
the duplicate is never generated. A test that deletes lines after the fact is
treating the symptom, and the measurements say how far that can go.

---

## 29. Ponds are water too

§27.2 found the city holding water that no curve described: **486 tiles** of
park pond, in 13 clusters, carved into tiles by `fillBlock` long after
`paintCoast` produced its rings. So the sea was shaded against a smooth line
and a pond against the tile edge — a staircase shore in a city whose coastline
no longer has one. The defect this whole plan exists to remove, at a smaller
scale, and invisible until the rings and the tiles were asked to agree.

### 29.1 It was already a field, again

Exactly as with the coast (§25.1), the shape was never the problem. A pond is
`hypot(x - px, y - py) < pr - 1 + warp` — a warped disc, continuous — and the
`<` was the only thing that quantised it. Contour it instead, keep the ring,
rasterise the ring, and the wet tiles become its rasterisation. `geometry.ts`
needed nothing new.

A pond could not be cut with the coast because it belongs to the park that
contains it and parks are placed thousands of lines later. So the rings are
collected in `buildings.ts` and drained into `layout.shores` by the bake,
where they join the coastline: **one answer to "where is the water", not two.**

### 29.2 And the pier prune stopped drowning land

The remaining seven tiles were not ponds. `tiles[i] = T_WATER` when a deck is
pruned put sea wherever the deck had reached — including a tile or two onto
its own abutment, which is land. It asks the rings now: a pass may remove a
deck, and may not move a shoreline.

### 29.3 DELIVERED

| | §27 | now |
|---|---|---|
| tiles disagreeing with the rings | 1,775 | **1,289** |
| — of which bridge decks (correct) | 1,282 | 1,282 |
| — park ponds with no ring | **486** | **0** |
| — pier prune drowning land | 7 | **0** |
| — unexplained | 0 | **0** |
| lake rings shipped | **0** | 13 |

What remains is 1,282 bridge decks, which are right, and **seven tiles whose
centre lies exactly on the waterline** — measured at distance 0.0000 from a
ring. The even-odd rule must answer in or out, and the vertices ship rounded to
1/100 of a tile, so the answer can fall either side. That is not a
disagreement about where the coast is; the coast is precisely there.
`coastCache.test.ts` now names all three cases and asserts **zero** unexplained.

**Correction to §27.3.** Narrowing `deriveBevels` to non-water edges is not
blocked on ponds, as that section claimed. `collide.ts` reads the bevel plane,
so the water bevels are load-bearing: remove them and the waterline is drawn as
a curve and collided as square tiles — a worse mismatch than the one being
tidied. They can go when water stops being a wall, which is what swimming does
(`VECTOR.md` Q1), and not before.

---

## 30. Two landmarks that were not there

Both from the audit's minor list (§23.3), and one of them turned out not to be
an authoring slip at all.

### 30.1 The duplicate lighthouse

`Gannet Light` and `Old Point Light` were both authored at `653,586 4x4` — one
building, two names, a doubled minimap marker and an ambiguous "you are at".
`Old Point Light` moves to `512,676`, a headland 167 tiles away on the south
coast.

Finding it took four attempts, and each failure was a rule this city already
had written down: a lighthouse needs **water nearby** (or it is not a
lighthouse), a **dry ring round its footprint** (nothing may be built against
open water — `water.test`'s quay invariant), and **a road within six tiles of
its door** (`city.test`'s access rule, which the driveway pass cannot always
satisfy on a headland). The site search now applies all three, which is why
the fourth attempt was the last.

### 30.2 `Marsh Post` was a bug in the bake, not in the plan

The audit reported it "standing on an empty field", and it was: every tile of
its 7×7 was field or park, and **no building overlapped it at all**. But its
sidewalk ring was there, which is drawn by the same pass that stamps it — so
the stamp had run and something afterwards had removed the result.

A landmark that claims a city block first clears the buildings already in that
block, so the block's ordinary houses do not survive inside a stadium. Country
landmarks are stamped EARLY, before anything is built (`§bake`: "because the
meadow…"). Where the two overlap, the second landmark's clear pass took the
first landmark's own building with it — leaving the ring it had already drawn
round nothing.

The clear pass now skips buildings that overlap another landmark's rect. Marsh
Post has its building back.

Worth stating: a placement fix would have moved the symptom to whatever site
was tried next. It looked like an authoring slip and it was a pass deleting
its own work.

### 30.3 DELIVERED

29 landmarks, none sharing a position, all with a way in. 890 tests pass, and
the two that caught the bad lighthouse sites (`water.test`'s quay invariant and
`city.test`'s access rule) are the reason the shipped one is right rather than
merely different.

---

## 31. The bridge deck, bevelled

§23.3 listed diagonal bridge decks as raw staircases, and after §25 smoothed
the coast they became the most obvious edge in the city: a 45° causeway
crossing a smooth waterline as a flight of stairs.

The cause was an omission rather than a decision. §15 bevels the edges nature
drew and one built edge — a diagonal avenue's kerb — on the stated grounds
that squareness is what makes a thing read as *built*. A bridge was left with
the quays and the buildings. But a deck is not square by intent: it is a
straight line at 45°, and it steps for exactly the reason the ring road's kerb
steps — its rasterisation.

`[T_WATER, T_BRIDGE]`, one-directional, and the direction is the same trick
the wooded shore uses: the **water** yields, so the deck overhangs its own cut.
Cutting the deck instead would open a hole in a carriageway.

Bevelled tiles 1,208 → 1,363. Collision reads the bevel plane, so a boat now
gets a 45° face to slide along under a diagonal crossing instead of a
staircase to snag on — the same gain §15.4 records for the wooded shore.

Evidence: `evidence/bridge-bevel.png`.

---

## 32. The sea runs to the horizon

§23.3: past the world edge the 3D view was a flat void and the sea ended on a
razor-straight line. Two causes, one of them embarrassing.

**The background was green.** `cityView`'s constructor set
`scene.background` to `palette.field`, from before there was a sky at all.
`setNight` overwrites it on the first frame, so it only showed on paths that
render before that — but "only sometimes" is how it survived.

**And nothing was behind the map.** The city is 768 tiles of ground and then
the end of the scene. The plan keeps a margin of open sea round the whole map
so the edge can never be reached; this is the other half of that promise. One
unlit plane, twenty times the map, two world px below sea level, under the
water slabs and the shore prisms so it can never z-fight them.

`side: DoubleSide` on it, and the reason is worth writing down: `world` is
scaled `(1, -1, 1)` to put the city the right way up, which flips the winding
of every face in it. A single-sided plane in that group faces AWAY from the
camera and is culled — leaving exactly the void it was added to fill.

Evidence: `evidence/world-edge-ocean.png`.

**One thing this does not prove.** The flyover clamps its camera into the map,
so `?at=900,400` renders ordinary field from inside rather than the view from
outside — which is worth knowing, because the audit's original probe used that
vantage and it cannot show what it was read as showing. What is verified is
the border seen from within: the sea reaches the frame edge, and nothing green
lies beyond it.

---

## 33. The esplanade gets a line, and the doubling gets a second measurement

### 33.1 A road with no curve

The waterfront street §13.1 added was carved carriageway and nothing else — no
course. Two consequences, and the second is the interesting one:

- the renderers drew it per tile, so it was part of the quarter of the city's
  roads the ribbon painter cannot reach (§26.1);
- and `doubledAgainstCourses` could not see it, so a lattice line laid
  alongside it merged into one sheet with nothing to detect the doubling.

It is a road. It gets a line: `chainTiles` — one nearest-neighbour chainer at
module scope, where the band tracers had each grown their own — turns the
band's centre into polylines.

**One line, not two.** `shoreDist` is integral, so the middle of a three-wide
band is sometimes 4 and sometimes 5; taking both chains two lines down one
road, which the doubling test then reports, rightly, as a road doubled with
itself — 1,784 samples to 2,675. Take 4 where there is a 4, and 5 only to
bridge a gap.

### 33.2 What the measurement said about §21.3

Setting out to fix the contour bands, the numbers said something else. Over-wide
carriageway by fabric:

| fabric | over-wide tiles |
|---|---|
| grid | **187** |
| contour | 89 |
| spine | 9 |
| crescent | 0 |

And The Terraces — §21.3's poster child, recorded at **51% carriageway** with a
46-tile sheet down its middle — is now **38% road with 18 over-wide tiles**.
§25's coast and §28's suppression between them did most of that without
touching the band spacing.

So **§21.3's diagnosis is no longer the dominant one.** The largest clusters
are elongated strips in GRID boroughs — 22×3 at `526,403`, 19×1 at
`453,290` — which is the doubling signature, not band smearing. And none of it
is at an authored plaza: 0% of over-wide tiles lie within six tiles of a
`square`, `green` or `circus`, so the metric is not merely counting the open
ground §13.6 asks for.

### 33.3 The ceiling, confirmed from a second direction

§28 found that suppressing more doubling costs streets people drive on. This
found the same wall from the other side. Softening seniority — a line yields to
any road at least HALF its length rather than one longer than itself — gives
over-wide 276 → 233 and doubled samples 1,830 → 1,509, and fails the same two
tests §28 named: long courses drop to 88 against a floor of 90, and an errand
driver stops completing its route.

Twice now, from unrelated directions, the same boundary. That is no longer a
tuning accident; it is where "duplicate" stops and "the only street this block
has" begins. Anything past it has to come from **not generating the duplicate**
— banding a borough against one stretch of shore, phasing a lattice against its
neighbour — rather than from deleting lines afterwards.

### 33.4 DELIVERED

The esplanade is a course: drawn as a ribbon like every other road, and
visible to the doubling test. Course coverage 76.1% → 76.5% (the 81.3% the
two-line version showed was double-counting one road). Over-wide, doubling and
block count unchanged, because seniority correctly protects a long lattice
line from yielding to a short chained esplanade — which is the right call and
also the reason this did not move the numbers.

890 tests pass.

---

## 34. A wood that is not a grid

§23.3: trees stood dead on the tile lattice at identical scale, so a dense
wood showed a visible square grid and diagonal alignments through it — the tile
grid admitting it exists, in the one thing in the city that has no business
doing so.

The code had tried. Each tree is rotated by its own hash, with the comment "so
a wood is not a grid of clones". But **a trunk is round**: turning it changes
nothing anybody can see, and the position and the size were untouched. The
bushes on the very next branch had had positional jitter since they were
written; the trees simply never got it.

Both now jitter off the tile centre and take a per-tree scale, from `hash2`
with fresh salts — so it stays what scenery has always been, a pure function
of the tile with no rng and no state, planted identically on every host.

Evidence: `evidence/woodland-jitter.png`.

---

## 35. Zebra crossings, at crossings

§23.3: four to seven zebras stacked back to back in open tarmac, with no kerb
at either end.

The per-tile painter puts a crossing on the last tile before a junction, and
`junctionAt` reads the TILE PLANE — so a merged sheet of carriageway is
"junction" across its whole area, and every tile of it painted its own
crossing. Two filters had already been added to stop this (`width >=
ARTERIAL_WIDTH`, and `streetResumesBeyond`), and neither could, because both
ask the same raster the same way: on a sheet, the width is arterial and the
street does resume.

A junction is where two centrelines meet. §26 already computes that from the
curves, so the crossing is gated on it: inside a course-crossing disc plus two
tiles, or no crossing. A merged sheet with no courses crossing it gets none,
which is the answer the filters were reaching for.

Evidence: `evidence/zebra-gated.png`.

This is the third defect in this file whose cause was "the raster was asked a
question only the curves can answer" — after the doubled centre lines (§26)
and the doubled roads (§28). It is worth naming as a pattern: **anything that
depends on how two roads RELATE is a question about the lines, and the tile
plane cannot answer it,** because rasterising two roads that touch produces
one region with no record that it was ever two.

---

## 36. VECTOR phase 3 — buildings cut at an angle, not turned afterwards

§20 cut a square footprint and turned a drawing on top of it. Everything since
has been paying for that: the mass had to shrink to fit its own plot, and
because collision read the footprint and the renderers drew the mass, the two
disagreed by up to 3.66 tiles (§22). Three thresholds were thrown at it —
§20's, §22's, §22.4's — and each moved the number without touching the cause.

The cause is in §1.2 of `VECTOR.md`: **the streets are carved in the borough's
rotated frame and the plots are cut on the world axes.** A building cut square
and turned afterwards can only ever approximate the plot it should have had.

### 36.1 It was one function, not seven

`VECTOR.md` §8 Q5 sized this at seven emission sites plus the volume grid,
`collide3`, doorways and three renderers. It was wrong, and pleasantly so.

`fillRegion` fills every angled and shaped block — **85% of the city's
buildings** — and it grows its units from a depth-from-kerb BFS, which is
frame-agnostic already: the depth field runs with the frontage whatever angle
the frontage is at. So the SIZE the growth picks is right. Only the stamp was
square.

`stampOriented` takes that size, turns it about the unit's centre to the
block's own angle (folded to (−45°, 45°], §22.4), and writes the tiles whose
centres fall inside — the same centre-in-shape rule `rasteriseRings` uses for
the coast, so a footprint and a coastline round the same way.

And `Building` did not need to become an OBB. It gained `mw`/`mh` — the
rectangle's own dimensions — while `x, y, w, h` remains the integer bounding
box that collision, the volume grid, doorways and every placement pass read.
None of them changed. `buildingMass` simply stops applying a fit factor when
there is a rectangle to draw:

```ts
if (b.mw !== undefined && b.mh !== undefined) return { cx, cy, w: b.mw, h: b.mh, rad };
```

### 36.2 Refusing, not shrinking

`stampOriented` returns false and lets the caller stamp square when the turned
footprint would land on ground the square one was not allowed: a blocked tile,
a tile outside the depth band, or **within one tile of an existing building**.

That last one is the §22.4 lesson arriving from a new direction. The caller's
`nearBuilt` guards the axis-aligned rect the size came from, and a rotated rect
reaches past it — so two units could end up shoulder to shoulder, closing the
alley between them. The peds test found it immediately: 200 pedestrians
wandering a city whose alleys had silently sealed, and one of them inside a
wall. The gap is now checked against the footprint that is actually stamped.

### 36.3 DELIVERED

| | before | after |
|---|---|---|
| buildings cut at an angle | 0 | **2,301** |
| mean footprint corner outside the drawn mass | 0.593 | **0.301** |
| fit factor applied to a cut building | — | **none** |
| interior samples landing off their own wall | — | 1 of 2,301 |

The one is pinned rather than asserted away: a tile is stamped when its centre
is inside the rectangle, so where the recorded rectangle is a hair larger than
the tiles it claimed — a small rect at a steep angle, rounding inward at two
corners — an interior sample can step outside. Asserting zero would mean
shrinking the record to its own rasterisation, which is the fit factor this
section exists to delete.

894 tests pass. `facing.test.ts` gains a describe block for cut buildings whose
central claim is the one that matters: **the ground under the drawn rectangle
is that building's own wall.**

### 36.4 The gate that had to move with it

All three renderers gate the single-mass drawing on "the footprint is solid
wall", because a shop is a room punched out of one and a lid over the whole
rect would close it. A cut building records its BOUNDING BOX, whose corners are
yard by construction — so every one of them failed the gate, and all three fell
back to per-tile boxes: a stepped outline drawn round a rectangle, which looked
worse than the square buildings it replaced.

The question is the same either way — *has a room been punched out of it* — so
the test is now `T_FLOOR`, plus the old wall requirement only for buildings
that were not cut. One rule, `massDrawable`, in the painter that had it first;
the other two mirror it. Instances over North Point 608,267 → 605,101.

### 36.5 Two bugs it flushed out

Both were pre-existing, and both only became visible once a building's tiles
had to agree with its drawing exactly:

- **§30's landmark guard was too broad.** It protected any building
  overlapping any landmark's rect from the block-clearing pass, including an
  ordinary house that merely stood in one — whose record then survived while
  the apron painted `T_LOT` over its tiles. Identified by identity now: a
  `WeakSet` of the buildings a landmark actually stamped.
- **A landmark's sidewalk ring painted over walls.** `paintable` allows
  `T_BUILDING`, which is right for the apron inside the block (the clear pass
  has already taken those) and wrong for a ring that reaches one tile PAST the
  landmark, where a neighbouring block's building stands.

### 36.6 What is still not done

`fillBlock` — the square-block filler, the other 15% — keeps the old model, and
does not need anything else: its blocks have no angle, so there is nothing to
cut at. Phase 4 (collision reading the geometry) remains blocked on nothing
now except being wanted: with the tiles finally *being* the rasterisation of
the drawn rectangle, collision already follows the drawing to within half a
tile, which was the whole of what phase 4 was for.

---

## 37. VECTOR phase 4 — collision reads the rectangle

The last phase, and phase 3 is what made it safe. Before §36 a building's drawn
mass was a shrunken rotated rect while its tiles were the full axis-aligned
one; pointing collision at the mass would have made it agree with the drawing
and disagree with the tiles — one conflict traded for another. Now the tiles
ARE the rectangle's rasterisation, so this sharpens an agreement instead of
inventing a disagreement.

### 37.1 What half a tile feels like

A rasterisation is right to within half a tile, and that half tile is exactly
what you feel driving along a 22° wall: the tiles step, so the car catches on
the corners of its own building. Measured over 64,516 probes, the rectangle
blocks where the tile column did not in **1,425 of 5,116** blocking positions —
**28% of the wall surface** the rasteriser had rounded away.

### 37.2 Layered, never substituted

`VolumeGrid` gains an `ObbIndex`: seven flat floats per rectangle — centre,
half-extents, cos, sin, top — bucketed by a 64 px grid, built with the grid
itself. The mover tests it **after** the tile columns have said yes, never
instead of them, so a wall is at worst what the tiles said and at best the line
the renderer draws.

Two details are load-bearing:

- **Bisection, not a minimum-translation vector.** Eight halvings of a
  sub-step land the mover flush to well under a pixel using nothing but add,
  multiply and compare. An MTV wants a square root, and this runs inside
  `step()`.
- **A body already inside a wall is let through.** Nothing should be, but a
  spawn that lands in one must not become a trap — the same rule the tile path
  has always followed.

Query cost: **0.2 µs**, 64,516 of them in 14 ms. The index builds in 129 ms
beside the volume grid, offline of the tick.

### 37.3 DELIVERED

| | |
|---|---|
| oriented walls in the index | 2,301 |
| wall surface recovered from the rasteriser | 28% |
| query | 0.2 µs |
| **host parity** | **green — Node and a browser, tick for tick, 600 ticks** |

That last row is the one that matters. `volume.ts`'s own header records why
Rapier, Jolt and Ammo were all rejected — none guarantees bit-identical
results across platforms, and this repo's replays, bot harness and
prediction reconciliation all depend on it. Oriented-box collision was added
under that constraint and `ci/hostParity.mjs` passes unchanged: plain
arithmetic, fixed iteration counts, no square roots, no trigonometry at query
time.

894 tests pass.

### 37.4 The plan is finished

`VECTOR.md`'s five phases are done. What the city has now is one definition of
each boundary — the coast and its ponds as rings, the roads as courses, the
buildings as rectangles — with the tile planes as their rasterisation, and the
sim still reading a tile plane in one indexed lookup. Vertices own boundaries;
grids own fields.

What is left is in §23.3 and §26.1, and none of it is a representation
conflict: course coverage at 76.5% (so the per-tile marking system cannot yet
be deleted), 68 junctions meeting under 30°, woodland drawn as a box, and the
apron/course ordering differing between the three renderers.

---

## 38. The shore band, measured from the waterline

§25 made the coast a curve. Two world pixels inland, the very next line was
still a pure staircase — **2,609 unit edges, 100% axis-aligned**, against a
waterline in front of it running at 19.7%. §25 did not cause that, but it made
it far more visible: a curve beside a staircase draws the eye to the staircase.

### 38.1 The same mistake, one boundary in

The band was decided by `wetNear` — "is one of my neighbours wet" — which can
only ever answer in whole tiles. That is the §25.1 diagnosis again at a
smaller scale, and it had already been patched once: §23.2 widened the test
from four neighbours to eight because a diagonal coast left a thousand
one-tile holes of bare grass in the quay. A patch on a test that cannot
answer the question.

The rings ARE the definition of where the water is, so the band that hugs
them is measured against them: `ringDistance` gives the exact distance from a
point to the nearest ring segment — bucketed and searched outward cell-ring by
cell-ring, so a query is a handful of segment tests — and the band is a
threshold on THAT.

`QUAY_REACH`, `BEACH_REACH` and `CLIFF_REACH` replace the neighbour tests, and
they are fractions on purpose: the band's edge is a level set of a smooth
field now, and a whole number would put it back on the lattice it came from.
The §23.2 eight-neighbour patch retires with them.

### 38.2 DELIVERED

| | before | after |
|---|---|---|
| beach/quay transects one tile wide | 49% | **39%** |
| band width, median | 1 | **2** |
| quay holes on a diagonal coast | 78 | 89 (86 of them park lawns, by design) |
| the §23.2 neighbour patch | in place | **retired** |

894 tests pass.

### 38.3 What this does NOT fix, and what would

**The drawn sand/grass line is still tile edges.** The band is now measured
from the curve, which makes its width consistent and removes the neighbour-test
artefacts — but no painter shades against a band CURVE, so the line you see is
still the boundary between two tiles.

Finishing it needs the other half, and it is a bigger piece than it sounds:
contour the distance field at the band's reaches to get the line, ship it
beside `shores`, and teach the painters a SECOND cut per tile. A shore tile
would then be cut twice — water, then sand, then grass — where `paintShoreTile`
currently splits it once. Three painters, and a three-way split is not the
two-way one generalised.

Recorded rather than attempted, because a half-done second cut would look
worse than the staircase it replaces.

> Done in §39, and the fear above was misplaced in one specific way: the two
> lines are never in the same tile, because the band's inner edge is at least
> `QUAY_REACH` from the waterline. There is no three-way split. Each painter
> cuts a tile once and only chooses which line is cutting it. What the work
> actually turned up was a sawtooth from the 45° bevel and a pass-ordering
> bug in the server render — neither of them the hard part it was braced for.

**And the reaches were tuned against tests, not taste.** 1.8 tiles gave a
visibly better band — one-tile transects down to 27% — and took enough ground
that three flight tests and an errand route failed. 1.5 is where the band
improves without the city losing land it was using.

## 39. The band's inner edge, as a curve

§38 finished with a note saying what it had *not* done, and this is that half.

The band was measured from the waterline, so its width was even and the
neighbour-test artefacts were gone. But no painter had a band CURVE to shade
against, so the line you actually saw where the sand stopped was still the
boundary between two tiles: 2,609 unit edges, **100% axis-aligned**, a tile and
a half behind a waterline running at 19.7%. §25 had made that line *more*
visible, not less — a curve beside a staircase draws the eye to the staircase.

### 39.1 One field, two contours

The plan §38 recorded feared a three-way split: a shore tile cut twice, water
then sand then grass, in three painters. It is not that, because the two lines
are never in the same tile. `QUAY_REACH` is 1.5, so the band's inner edge is at
least a tile and a half from the waterline; a tile the coast crosses cannot
also hold the band's edge except at a very tight corner. Each painter cuts a
tile ONCE, and only picks which of the two lines is cutting it.

What the band's edge is, is the zero contour of

```
inland(x, y) = ±dist(x, y, shores) − reach(x, y)
```

— the same `sampleField` / `contourRings` the coast is built with, one level
further out. `reach` is a field (quay 1.5, beach 2.6, cliff 2.6, bilinear
between tile centres, so its own steps never reach the curve); `dist` is
§38's `ringDistance`. Stated inland-positive on purpose: a contour is a closed
ring or it is nothing, and the band-positive region contains the whole sea,
which runs off every edge of the map.

Then the three reach comparisons the shore pass used to make collapse into one
mask lookup, and the SECOND shore pass — which had its own copy of the sand
rule — reads the same mask instead of repeating it.

The rasterisation is unchanged tile for tile. That is not luck: bilinear
interpolation at a tile centre returns that tile's own sample, so
`inland(centre) < 0` is exactly the test `rd < reach` was. The bake is
byte-identical apart from the new rings. A curve was added and nothing moved.

### 39.2 What a painter needs, and what it must not be told

Both halves of a band tile are dry, so neither can be a fixed colour the way
the sea is. The obvious rule — sand and bank are shore, grass is not — is
wrong on the one case that matters: a wooded cliff foot and the wood behind it
are both `T_TREES`, and the line between them is the whole point.

So each half takes the material of the nearest tile centre that the LINE puts
on that half, which is `chainSide` — `shoreHalf`'s companion, and the same
nearest-segment test the server renderer already made. No material
classification anywhere.

Three painters, three shapes of the same idea:

- **2D chunk painter** — `paintBandTile`, `shoreHalf` clipped twice, exactly
  as `paintShoreTile` does it minus the water and the stroked lip. Sand
  meeting grass is not an edge you draw a line along.
- **3D city** — the tile keeps its box and the other half is laid over it as a
  flat patch, a hair above street level. Splitting the box would mean
  re-meshing every shore tile in the map for a line you see from above.
  10,029 triangles.
- **Server render** — the same pixel sweep as the waterline, run second and
  skipping whatever the waterline called sea.

### 39.3 Two defects the work turned up

**The bevel fights the chord.** §18 already knew that a tile the coast crosses
must not also get its 45° bevel, and the band's edge needed the same rule and
did not have it. The result was a sawtooth: a smooth chord, then every three
or four tiles a triangle of grass driven up through the beach. Worse than the
staircase both were replacing, and invisible in the tile numbers — it took a
6× zoom on one tile to see what it was.

**Order is behaviour.** The server's waterline pass reaches 1.1 tiles inland
and repaints each pixel as the TILE it sits in. A quay is 1.5 tiles wide and a
pond's beach 1.4, so running the band pass first meant the coast pass walked
straight back over its outer edge and put the steps back. Second, and gated on
what the coast pass called sea.

### 39.4 The pond gets its beach

The last four-neighbour band in the city was a park pond's sand ring — §29
gave the pond a waterline and left its beach a lattice, which is §38's defect
in miniature. A pond's shape is already a field, so its beach is that field
contoured `POND_BEACH` further out: six more rings, shipped in `banks` beside
the coast's ten.

### 39.5 Measured

| | before | after |
|---|---|---|
| drawn sand-against-grass line, axis-aligned | 100% | 16.8% |
| band-material tile edges the curve passes through | — | 98.4% |
| shipped band rings | — | 16 |
| tiles moved | — | 0 |

The 1.6% the curve does not describe is band material a LATER pass put down —
a street that ran into the sea and was turned to quay, a landmark's apron. The
band curve was not cut from those and does not claim them.

### 39.6 What is still a lattice here

The boundary between sand and quay, and between either and a wooded cliff
foot. Those are *material* changes WITHIN the band, decided per tile by
district and exposure — a field, correctly — and where two of them meet along
the shore the change is a tile edge. It is a short line and a small tonal step
next to sand-against-grass, which is why it is recorded rather than fixed.

### 39.7 Three follow-ups, from looking at it

**A ring is a cycle; its point list is not.** `shoreChains` keeps the longest
chain per tile, and wherever a ring's point list happens to start, the curve
through THAT tile arrives as the walk's last piece and leaves as its first —
so one of the two halves was thrown away and the survivor started *inside* the
square. `shoreHalf` then walked the border the wrong way round it: a thin
spike of the wrong material, exactly once per ring. Invisible on a coastline of
two thousand points round an island; not invisible on a pond's beach of
sixty-five points round a puddle. The two pieces are now spliced.

**A bevel in a band tile is always describing the band.** `YIELDS_P1` bevels
sand against grass and water against land and nothing else that can run
through a band tile, so where the curve cuts, the 45° triangle is a coarser
statement of the same boundary. It is now suppressed for the whole tile, not
only where the cut painted something — the tiles where both sides come out the
same material are precisely the ones a stray triangle showed up in.

**`ringDistance` needed a horizon.** The band field is sampled at half a tile,
which is 2.4 million queries across the map, and a point in the middle of a
landmass has no segment to find — so the ring search expanded until it met a
coast. Two changes: a `limit`, past which the answer is reported rather than
searched for (only its sign is information anybody uses out there), and a
precomputed "is there a segment in this cell or beside it" mask, which answers
the far case in one array read. 13.3 s → 0.46 s for the sampling pass, and the
bake is byte-identical, because the contour lives at 1.5–2.6 tiles where the
distance was exact all along.

---

## 40. The road stops being paint — the network as a graph

§9.1's first complaint was that roads exist only as painted cells, so every
consumer reverse-engineers meaning from pixels; §9.2's L2 asked for typed nodes
and typed edges. This is that, at the level routing needs it: **junctions are
nodes, the streets between them are edges**, and crossing the city is a search
over a thousand of them instead of over the hundred thousand tiles they are
drawn on.

### 40.1 The claim, measured before it was built

`planRoute` costs **1.8–2.2 ms** a call warm, and 3.5 ms cold, on random
city-wide pairs — plain A* over 102,987 drivable cells, with a
60,000-expansion guard that exists because a route to somewhere unreachable
floods the whole network. Traffic replanning,
ambulance dispatch and errand assignment between them call it several times a
second against a 33 ms budget. The number is why this was worth doing; it is
recorded here because the alternative was to assert it.

| | |
|---|---|
| Nodes / edges | **940 / 1,764**, from 102,987 drivable tiles |
| `planRoute` | **0.12 ms**, against 1.8–2.2 ms over tiles — **15–19×** (warm medians, §40.6) |
| Routes the tile search had given up on | **15 of 300** |
| Route length against tile-optimal | p50 **1.09**, p95 1.39, max 2.02 |
| Build | 30 ms once per session; 1.90 MB resident |
| Waypoints off carriageway | 0 |
| Tests | 907 pass; host parity green, and the 600-tick hash is **unchanged** |

### 40.2 Why this one is built from the tiles

§25 established that a boundary must come from its field, because a curve
traced out of a raster can never beat the staircase it started from. That rule
is about **geometry**. Topology is not damaged by rasterisation: a junction is
a junction whatever it is drawn on, and which junction connects to which is
exactly as true in the bytes as in the drawing.

That distinction is what lets routing move now rather than waiting for VECTOR
phase 2. §26.1 declined to retire the per-tile marking system on a number —
courses cover **76.1%** of carriageway tiles — and the same number blocks a
graph built from them. Measured from the other direction for this work: **20.2%
of drivable tiles sit more than three tiles from any centreline**, so a course
graph would leave a fifth of the city unroutable and the tile search would be
the fallback more often than not. The tiles cover all of it.

What the tiles cannot supply is where an edge *runs*. The paths here are chains
of tile centres, staircase and all. Marrying them to the courses is exactly the
work §26.1 wants done once and deliberately, when coverage is raised — and it
is a change to this module's paths, not to its topology.

### 40.3 One flood, not a thousand searches

Every junction tile seeds a breadth-first wave at distance zero and they spread
over the carriageway together. Each tile ends up owned by the junction nearest
it *along the road*, carrying the direction the wave arrived from — so every
tile in the city already knows its way to its own junction, and the first and
last leg of every route cost nothing at all. Where two owners meet, their
junctions have a street between them, and its length is what the two waves had
travelled. One pass builds every node, every edge and every path.

The care is in what the splicing leaves behind. A walk out to a junction ends
at whichever of its tiles the flood seeded from, and the street out of it
leaves from another, so the assembled path doubles back on itself around every
node — and around the start too, whenever the destination lies back down the
street the car is already on. Cutting everything between a tile and its own
second appearance leaves the simple path through the same corridor, and is also
what turns a U-turn at the start into no U-turn at all.

Deterministic by construction: the seed order is tile order, the four
neighbours are visited in a fixed order, and a queue is a queue. Like
`junctions`, it never goes on the wire — both hosts build the identical graph
from the identical tiles, which the parity gate confirms.

### 40.4 The invariants, and the middle one is load-bearing

`roadnet.test.ts`:

- **Coverage.** Every drivable tile is owned by a junction. Not a quota, a
  property: there is nowhere a car can be that routing cannot start from.
- **The graph agrees with the tiles about what connects to what.** Flood the
  drivable tiles for their true connected components, flood the graph for its
  own, and assert the two partitions are identical. The graph can therefore
  never claim a route the roads do not have, nor deny one they do — which is
  what makes it safe to stop falling back to the tile search on a failure, and
  that is where the twenty-millisecond spike went. It is also why the 15 pairs
  that route now are a fix rather than a fabrication: the tile search had hit
  its expansion cap.
- **The tree terminates and its steps are steps.** Every walk home is over
  carriageway, one tile at a time, ending at a junction.
- **Routes are drivable.** Every waypoint on carriageway, and none further from
  the last than the follower's repath distance — a splice inside a junction is
  a jump rather than a step, and an unhalved one reads to a driver as being
  hopelessly off plan.
- **It is a pure function of the map.** Rebuild it, get the same arrays.

### 40.5 What it cost, and what is owed

Routes are about **7% longer** than tile-optimal at the median and up to 2.2× at
the worst, because a route now goes *via junctions* rather than wherever the
tiles allow. That is the price of the abstraction and it buys the nineteenfold:
a car takes a plausible route rather than an optimal one, which is what drivers
do. Nothing in the game measures route length, and the 600-tick parity hash did
not move.

Owed:

- **Edges carry a length and nothing else.** No width, no kind, no one-way flag,
  no lanes — though the courses have width and kind sitting right there. That is
  the same marriage §40.2 defers.
- **`traffic.ts` still probes tiles.** `dirIsOpen` and the fan of bearings when
  the cardinals fail are questions the graph answers directly. Converting the
  *follower* is a separate wave: this one changed what a route is, not how a car
  drives one. *(§41.2 tried it, and "the graph answers that question directly"
  turned out to be wrong about which question the fan is asking.)*
- **1.90 MB is one `Int16` and one byte per tile**, which is the economy this
  structure was written to; the temptation is three `Int32` planes and seven
  megabytes, and it should stay resisted.

Evidence: `evidence/city-roadnet.png` — every street a stroked run, every
junction a dot, and no carriageway in the crop the graph does not run down.

### 40.6 The review, and the four things it found

Reviewed at high effort against the landed commit, because "the tests pass"
is not the same claim as "the code is right". Four findings, all real, all
confirmed by measurement before being fixed — and three of them share one
cause, which is the more useful thing to record than the three symptoms.

**The cause: a route contained a jump.** A walk out to a junction ends at
whichever of its tiles the flood seeded from, and the street out of it leaves
from another, so the assembled path stepped from one junction tile to a
non-adjacent one. Everything downstream assumed adjacency:

1. **A straight can leave the road.** Waypoints were all on carriageway, but a
   car drives the line BETWEEN them, and a junction is connected without being
   convex. **7 of 140,250** waypoint-to-waypoint straights crossed ground that
   is not road. The code carried a comment asserting this could not happen.
2. **The head of the route was unbounded.** The gap-halving repair compared
   each waypoint with the previous one and so never looked at the first, which
   is measured from the car rather than from a waypoint. A car starting on a
   junction tile got its first corner **112 px** away against a follower that
   calls itself lost at 128 — sixteen pixels from a driver that re-plans every
   tick, from an unchanged position, without ever setting a steering direction.
   The test asserted the bound; its 120 random spots missed the tiles that
   break it.
3. **The repair fired on ordinary straights.** Its threshold (80 px) sat below
   the emitter's own spacing (96 px), so every six-tile straight was split by
   an `O(n)` splice — about a fifth more corners than intended, on the legacy
   tile route as well.

The fix is to stop jumping: `joinWithin` walks the junction's own tiles
breadth-first and the seams are filled in rather than stepped over. With the
path continuous, the repair pass and its threshold are both deleted, the
emitter's ordinary corner-and-spacing rule bounds every gap, and emitting from
index 0 makes the first corner the tile the query snapped to. After: **0 of
109,840** straights leave the road, no first leg over the bound, and 22% fewer
waypoints for the same routes. `roadnet.test.ts` gained the invariant the
comment used to assert — the straights are sampled, not just the corners.

**The fourth is independent.** `consider()`'s equal-cost tie-break compared a
canonicalised side against a raw one, so "ties go to the lower tile" was true
only when the lower-numbered junction happened to be on the left. Deterministic
per host either way, so never a desync — but a stated invariant that did not
hold, which is worse than no invariant. Canonicalised before the comparison
now.

**And a number that was overstated.** §40.1 first published 0.18 ms against
3.57 ms. Both were measured cold, on first call. Warm medians over 400 pairs,
five runs each, are 0.12 ms against 1.8–2.2 ms — still fifteen to nineteen
times, and the honest figure for a system that runs for hours. The cold
numbers are what a session's first few routes cost and are recorded here
rather than in the headline.

---

## 41. The follower, the centrelines, and three things that did not work

§40 closed with three items owed: convert the follower off tile-probing, marry
the graph's paths to the courses, and give collision the coastline. This is
that work. **One of the three landed as intended, one landed smaller than
intended, and one did not land at all** — and since the reason in every case is
a measurement, the measurements are the section.

### 41.1 What the fan was actually doing

`laneControl` has three ways of deciding where to aim. Instrumented over five
seeds, 900 ticks each — 55,411 calls:

| path | share |
|---|---|
| the cardinal lane model answers | 45% |
| inside a junction, `junctionExit` finds the far lane | 36% |
| **neither: the bearing fan** | **18.5%** |

The fan probes nine bearings around the car's heading, six tiles each, and
takes whichever stays on tarmac longest. It exists for diagonal bands — the
ring road, a curved avenue — where a cardinal probe runs off the tarmac in a
few tiles. At 40 tile reads a call it is the most expensive thing in the
driving loop, and the lane model failing on **55%** of ticks was itself news.

### 41.2 The follower: what landed, and the four things that did not

**What landed is one line.** The fan's search now stops at the first bearing
clear for the whole six-tile probe. Nothing can beat six and ties already went
to the first candidate, so it decides *exactly* what it decided before —
verified exhaustively rather than argued: all 7⁹ = 40,353,607 possible
combinations of the nine clear-run lengths give an identical chosen bearing,
including the quarter of them where no bearing reaches six and the exit never
fires. Probes per call fall from **37.0 to 9.7**, and the off-carriageway rate
over five seeds is **identical to the byte** — 424 of 56,814 vehicle-ticks,
same distance driven, same cars alive.

**What did not land is the actual conversion,** and it is worth recording in
full because the idea is obviously right and is obviously wrong:

| attempt | off-carriageway |
|---|---|
| the fan, unchanged | **0.75%** |
| steer by the flood tree's local street axis | 2.24% |
| steer at a point along the nearest centreline | 1.82% |
| …offset into the right-hand lane | 1.84% |
| …with the aim point at the fan's own lookahead | 3.18% |
| …at the best aim distance of six tried | 1.45% |
| the fan, but seeded with the centreline's bearing | 1.40% |

Every one of them is worse, and the last is the instructive one: it keeps the
fan's criterion and merely offers the road's true direction as the first
candidate, and it *still* doubles the off-road rate. The conclusion is not that
the centreline is inaccurate — it is exact. It is that **the fan is not finding
the road's direction. It is keeping the car on the road**, and a bearing chosen
for how far it stays on tarmac carries information about where the car sits
across the band and how hard it can steer that no geometric ideal contains. The
optimiser is doing lane-keeping, badly named.

Converting the follower therefore needs a lane model on the graph — sides,
widths, and the car's lateral position within them — not a better source for
one vector. That is a wave, not an edit, and §40.5's "the graph answers that
question directly" was wrong about which question was being asked.

### 41.3 The centrelines, indexed — and the width an edge now carries

`courseIndex.ts` buckets the courses' segments by 8-tile cell (the shape
`courseJunctions` already uses) and answers, at any point, where the nearest
centreline is, which way it runs and how wide it is. A query is exact: it
matches a scan of all 7,682 segments at 8,000 sampled points, and the test says
so rather than trusting the buckets.

Its first customer is the graph. §40.5 recorded that an edge knew its length
and nothing else "though the courses have width and kind sitting right there";
an edge now carries the width, for **88.5%** of them — 339 avenue-or-better,
1,223 ordinary street, 202 unknown. The unknown are the carriageway no
centreline covers, and note that §26.1's 24% is a count of TILES: an uncovered
stretch is usually a short link, so it is 12% of the network by edge.

It is sampled as the median of three points along the edge rather than one at
the middle, because the nearest centreline to a point on a street is not always
that street's own — one sample takes a crossing course's width on 9.5% of
edges.

**Routing does not use it, and that is a decision.** Preferring the wider road
is what a driver does and it measures beautifully: the share of routed distance
on avenue-or-better goes from **35.7% to 56.0%** for **1.7%** more distance. It
also broke a cross-city errand — `traffic.test.ts`'s "drives the errand to the
far side of town" stopped arriving inside its two-minute budget. Width-aware
routes take more, shorter streets (31.7 against 27.2 per route), every extra
street is another junction, and a junction is where the follower stalls. The
same lesson as §41.2 from the other end: **the bottleneck is the driver, not
the plan, and improving the plan hands the driver more chances to fail.** The
width ships, the search ignores it, and a test pins that so it cannot drift
back in before the follower is fixed.

The review tool draws it: `pnpm mapgen --net` now colours each street by what
it is made of.

### 41.4 Collision on the coastline: attempted, measured, withdrawn

§25 made the coast a curve and the water tiles its rasterisation, and the
renderers took it — but collision still stops a car at the tile edge, so the
water you see and the water you hit are different shapes. Porting a solver
that does this (built elsewhere, against rings traced FROM a tile mask) was
attempted here and is not in this commit.

The reason is structural rather than incidental. That solver's rules are all
local to a tile, and they were exact because its rings were traced from the
tile plane and so agreed with it by construction. These rings are contours of a
field, and the tiles are their rasterisation — the two agree only to within the
rasteriser, and a tile can hold five segments belonging to stretches of shore
that do not enclose it. Measured, classifying a point from the edges in its own
tile puts this many tile centres on the wrong side of the water:

| rule | wrong at a centre |
|---|---|
| union of the tile's water half-planes | 209 land / 85 hull |
| the nearest edge alone | 134 / 9 |
| the tile's byte, flipped only by an edge that separates the point from the tile's middle | 126 / **0** |

The third is right in principle — it cannot be wrong AT a centre, and its
remaining 126 are bevelled water the rings never reach, a pre-existing figure
that is *better* than the 297 the bevel plane manages alone. But the movement
solver needs the point test, the box test and the depenetration push to share
one rule exactly, and reconciling them left **1.02%** of movers near a shore
resting inside the water, against **0%** for the tiles-and-bevels collision
shipping today. A visible regression in exchange for a sub-tile improvement is
not a trade, so it was withdrawn.

What it needs is not a port: it is the point, box and push rules derived
together from one definition, against a boundary that is authoritative and a
tile plane that is merely its shadow. That is the wave, and it should be
written rather than moved.

### 41.5 The review

Reviewed by an agent given the diff and the author's claims, told to verify
rather than believe. It confirmed the early exit exhaustively (the 7⁹
enumeration above is its work, not the author's), and found four defects that
were fixed before this landed: `Math.hypot` where `Math.sqrt` was required —
ECMA-262 pins the second to the exactly rounded result and leaves the first
approximated, and the value decides which cells a segment is filed under, so it
was a desync waiting for the right map; a "quarter of the network" claim that
was a tile figure repeated at edge level, twice, once in the legend of the
picture reviewers look at; a dead `streetAxisAt` whose doc claimed it had
replaced the fan that is still there; and a doc comment inserted between
`routeNodes` and its own documentation. It also noted the feature shipped with
no test naming it, which `courseIndex.test.ts` now fixes.

---

## 42. Lanes on the graph

§41 closed owing a lane model. It said so twice, from opposite directions —
the follower could not be converted without one (§41.2), and the routing could
not spend its widths without one (§41.3) — and both times the reason was the
same: **the graph knew the topology of the city and nothing about where a road
runs or which side of it you drive on.** This is that model, and it is one
third of what was hoped for, for reasons that are measurements.

### 42.1 What a street now knows

`lanes.ts` gives every edge of the graph three things it did not have.

**A line.** The edge's path is the chain of tile centres the flood walked, so
its geometry is a staircase. Each centre is pulled onto the course running
down that street where one covers it — not the NEAREST course, which on nearly
a tenth of edges is a crossing street (§41.3), but the nearest one *running the
way the path runs* — and what is left is smoothed by a three-point average.
The result runs down its own tarmac at 99.99% of sampled points.

**Sides, measured rather than assumed.** At every point on that line, how far
the tarmac reaches to the left and to the right, in two-pixel steps. Not one
width per street: a street narrows at a building line and widens at a lay-by,
and the line itself is the course where a course covers it and smoothed tile
centres where none does, so it is not reliably down the middle. A lane is then
a FRACTION of the room actually there — the same 0.5 / 0.75 / 0.25 split
`laneOptions` has always driven — which is what stops a "kerb lane" being
computed onto a pavement. Measured: **99.55%** of kerb-lane samples are on
tarmac, in both directions.

**A tile that names its street.** One `Int16` plane, so a car asks where it is
with one array read. An edge's path is one tile wide and a street is up to
four, so the names are spread outward by breadth-first search — **bounded** at
three tiles, and that bound is load-bearing. Unbounded it does not stop at the
end of a street: a dead-end spur or a long lane with no intersection on it has
no edge of its own, so the spread pours down it from the junction at its mouth
and names the whole thing after some hundred-pixel street back at the corner.
The worst tile in the city was named a street whose line is **147 tiles away**,
and a car standing there would have steered at it. Bounded, the worst is 4.5
tiles and coverage is 80.9% of carriageway; the rest is ground the graph does
not describe, and saying so is the right answer.

### 42.2 What drives on it, and what does not

The lane model drives the car in exactly one place: **the diagonal bands**, where
the cardinal lane model has already refused to answer and the bearing fan used
to take over. §41.1 measured that fan at **18.5% of every driving decision**, and
§41.2 named it as the thing a lane model on the graph should replace. Over five
seeds, 900 ticks each, against the same harness run on clean `HEAD`:

| | before | after |
|---|---|---|
| off the carriageway | 1.947% | **1.001%** |
| head-on encounters | 11.80% | **7.52%** |
| lane discipline | 87.0% | **88.9%** |
| crawling (under 12 px/s) | 34.6% | **30.2%** |
| distance driven | 45,982 | **50,903** |
| mean speed | 26.4 | **29.2** |

Every measure improves, several by a tenth. That is the whole of the case.

The "before" column is clean `HEAD`, so it carries §43's collision change as
well as this one. Measured separately, §43 alone moves off-the-carriageway
from 1.947% to 1.848% and nothing else materially; the rest is the lanes.

### 42.3 Driving the WHOLE city off it: measured, and not shipped

The obvious next step is to retire `laneOptions` and drive everything off the
lanes, and it was built, and it is not here. The same five seeds:

Against the same clean-`HEAD` baseline, driving everything off the lanes:

| | fan (before) | lanes everywhere |
|---|---|---|
| head-on encounters | 11.80% | **4.26%** |
| off the carriageway | 1.947% | 1.764% |
| lane discipline | 87.0% | 85.5% |
| distance driven | 45,982 | **41,558** |
| mean speed | 26.4 | **23.9** |
| crawling | 34.6% | **40.5%** |

Better lane behaviour, and a tenth off the flow — and the flow is not a bug,
it is the *consequence*: with the traffic properly in lane it drives in single
file, so `scanAhead` finds a car ahead 63% of the time against 60%, at a mean
gap of 30 px against 36, and the Intelligent Driver Model brakes for it. The
old scattering across the carriageway was worth throughput precisely because
it was not lane discipline.

It also stops the cross-city errand in `traffic.test.ts` arriving inside its
two-minute budget — the same test that §41.3 declined to break for
width-weighted routing. Eight rounds went into that one failure and each
uncovered a real defect worth recording:

| what was wrong | what it did |
|---|---|
| direction resolved from the driver's cardinal intent | a cardinal square to the street is a coin flip; steering error 0.48 rad against 0.31, discipline 85.9% |
| direction resolved from the heading alone | a car cannot turn ROUND; the errand drove away from its destination and re-planned for two minutes |
| the aim point clamped at the street's end | the pursuit point stops moving away as the car closes on a junction; traffic bunches at every mouth |
| the aim point extrapolated past the street's end | aims across the junction and out the far side; off the carriageway 2.69% |
| lane 1 duplicating lane 0 on an ordinary street | no oncoming fallback, so one parked car is a permanent roadblock |
| the graph's own junction traversal | junction time 5.9% of ticks to 9.2%, half of it crawling |
| the lane aim closer than the turn radius | the documented orbit: the car circles a point it can never reach at full lock |
| direction with no memory | a car broadside to its street flips end-to-end every tick on a two-degree wobble and vibrates until it decides it is wedged |

Six of those are fixed and in the shipped code, because the band driver needs
them too. Two — the cardinal-versus-heading question and the hysteresis — are
recorded here and nowhere else, because at the scope that ships the car is
never broadside to a band and never asked to turn round on one.

The lesson is §41's, one level down. §41 said the bottleneck was the driver
rather than the plan. It is more specific than that: **the bottleneck is the
junction**, and a lane model makes streets better and junctions no better at
all, so applying it to the streets a junction sits between hands the junction
more traffic to fail on. The next wave is the junction — lane-to-lane
connections through the box, with the turn a car is taking known before it
enters — and until that exists, driving more of the city off the lanes trades
flow for tidiness.

### 42.4 Owed

- The junction, as above. Everything §42.3 measured is waiting on it.
- **Width-aware routing** is still shipped-and-ignored (§41.3) for the same
  reason, and joins the same queue.
- Only lane 0 is driven. Lanes 1 and 2 exist, are tested, and have no
  consumer until the overtaking rule moves off the cardinal model.

---

## 43. Collision on the coastline

§25 made the coast a curve and the water tiles its rasterisation. Both
renderers took the curve — the 2D painter cuts a tile with `shoreHalf`, the 3D
one punches its ground mask against the same chain — and collision did not. So
for four waves **the water you could see and the water you could drive into
were different shapes**: a car stopped a tile short of a waterline drawn
diagonally across the square, or drove out onto sea already coloured blue.

§41.4 tried to fix that by porting a solver built elsewhere, measured it, and
withdrew it. The reason it recorded is the design of this one:

> What it needs is not a port: it is the point, box and push rules derived
> together from one definition, against a boundary that is authoritative and a
> tile plane that is merely its shadow.

### 43.1 One definition

`shoreCut.ts` supplies exactly one thing: **the solid half-plane of a tile.**
`shoreChains` (which the renderers already use) cuts the rings into per-tile
chains; the chord through a chain's ends becomes a unit normal and an offset,
and `collide.ts` reads all four of its questions off that — the point test, the
box test, the movement face and the depenetration clamp. There is no second
solver to reconcile with the first. A bevel is the same construction with the
normal rounded to a diagonal, which is why the general form drops into
`faceX`/`faceY` beside it rather than beside a special case.

**One line per tile, and when it declines.** A chain can bend. Of the 7,782
shore tiles, 5,833 have a single straight run, and the chord is within 0.1 tile
of every interior point on 99.8% of the rest. Where it is not — a chain that
doubles back inside one square, a cape thinner than a tile — the tile gets no
plane and the bevels answer exactly as they do today. A cut that cannot be
described by one line is not described by one line.

### 43.2 Three defects the tile solver already had

Making the faces non-diagonal exposed three things that were wrong before and
had never bitten hard enough to notice.

**`moveOnce` only ever tested the DESTINATION tile.** For a whole solid tile
that is sound — the face is the tile's own boundary, so landing in it is the
only way to meet it. A sloped face lives INSIDE its tile, so a mover standing
behind one can step clean over it into the next tile, be stopped flush against
THAT tile's face, and come to rest inside the water it just crossed. It now
tests every column the leading edge sweeps, which is one or two given the
half-tile sub-step. Measured on the shipped tiles-and-bevels collision alone,
with no curve involved: movers left resting inside solid fall from **0.241% to
0.026%**.

**A face already behind you was still blocking.** The fix above needs its
converse, or a mover that starts inside a solid — spawned in one, shunted
through by a car — is clamped back in every tick instead of walking out the way
it came. A face counts unless the mover is more than half a pixel past it: far
above the slack a flush clamp leaves, far below anything a mover is genuinely
embedded by. With both, the tile solver's residue goes to **zero**.

**The box was half-open on one axis and closed on the other.** The rows a box
touches are chosen from `pos + half - EPS` and the box is MOVED to `pos + half`;
for a square face those are the same question, but a sloped face is a function
of the other axis, so the x step slid the y face by a fraction of a pixel and a
box that was flush came out a hair inside. The tile range still uses the
half-open bound and the face is now evaluated against the closed one.

### 43.3 The quantiser, which is not a geometry problem

With all three fixed, a mover still ended up 0.03 px inside — and the cause is
`q8`. Positions go on the wire quantised to eighths of a pixel, and the snap
can round towards the line. A mover parked exactly flush against an arbitrary
slope is therefore written down a few hundredths of a pixel into the sea:
invisible, and still a mover in the sea. The face the solver clamps to is now
an eighth of a pixel OUTSIDE the water, which the quantiser cannot spend (its
worst case moves a point `sqrt(2)/16` across a unit normal). The bevels have
the same exposure, have never shown it, and are left alone.

### 43.4 What it measures

Movers driven at the shore from open ground, forty steps each, at everything
from a walk to a fast car, across all 6,888 cut tiles:

| | resting inside solid |
|---|---|
| the ported solver §41.4 withdrew | 1.02% |
| tiles and bevels, before this wave | 0.24% |
| **the curve, this wave** | **0%** at a person's size |
| …at a car's | 1 mover in 12,624, 0.9 px in |

That last row is one tile of coast, and it is here rather than rounded away.
It is a twentieth of a car's width on a shore a car has to be driven at
deliberately, against a solver that left 1.02% of movers in the sea and a tile
plane that left 0.24%; a different order of thing, and not nothing.

The plane agrees with the tiles about which side is water at **6,767 of 6,888**
tile centres, and about their neighbours' centres 15,417 times against 125 —
and the disagreements are the pre-existing figure §41.4 measured, bevelled
water the rings never reach. The placement passes are untouched: vehicle and
parking spots overlapping solid move by at most one across three seeds, in both
directions, because `isSolidTile` is deliberately NOT cut-aware. That is not an
oversight — the coast crosses every tile of the quay, and answering "solid"
there would close the whole waterfront to anybody on foot.

`pnpm mapgen --solid` stipples everywhere collision says solid, which is the
only way to see this at all: the ground has looked right since §25.

### 43.5 Owed

- The bevels could take the same margin and the same closed-extent treatment.
  They have not needed it, and moving every wall in the city by an eighth of a
  pixel is not a thing to do in passing.
- `boxInSolid` and the movement faces now agree exactly on a cut tile. They
  agree only to within `EPS` on a bevelled one, for the reason in §43.2 — the
  same fix applies and the same argument against churning it does too.

---

## 44. The crossings that were not there

`REVIEW-MAPDESIGN.md` read the top-down city as a map rather than as a render
and found that §12.3's "eight crossings, because on an archipelago the question
'which bridge' is the interesting one" had quietly become four. Of the three
over the strait, **only the Old Bridge existed**. What was left was two
crossings sixty tiles apart in the far west, no way over the water across 56%
of the map's width, and a drive from Market Square to Seaview Infirmary — 203
tiles apart, in sight of each other — of **1,034 tiles**.

### 44.1 Two causes, and the second is the interesting one

**The Ring's east leg** was the span rule doing its job: 75 tiles of water
against a `maxBridgeSpan` of 72. Raising the cap to **96** — `plangen`'s own
default since it was written — brings it back, and the ring is a ring again.

**Kelvin Bridge and Marsh Causeway were drawn ending in the sea.** Kelvin
Bridge's south endpoint sat 10 tiles off the far bank, the causeway's north
endpoint 8 tiles off the near one. A deck that reaches only one landfall is
§23.1's pier, and §23.1's whole-deck rule deletes it — correctly, and in
silence. Six of the plan's 32 road endpoints were in open water; `Coast Road`
was worse than an endpoint, with **164 tiles of its length** authored out at
sea along the south shore, so most of the road named for the coast was never
built.

None of it failed a check, because every check that could have seen it asks a
different question. "One street network" stays true when a crossing vanishes:
the banks are still joined, the long way round. Only a person flying over the
map can see that the short way is gone.

### 44.2 The check that would have caught it

Two, in `cityCheck.ts`, and the second is the general one:

- **A road begins and ends on land.** Water is the drawing error that deletes
  a bridge; a bridge tile means the road stops in mid-air, which is the pier
  by another route.
- **The road you drew is the road you got.** Walk each authored road — the
  smoothed curve `layout.ts:834` carves, not the polyline the plan holds — and
  fail when more than four tiles of it in a row have no carriageway under
  them. A named road is a promise; this is the check that the bake kept it.

The second one immediately found Coast Road, which had been fiction for its
middle 164 tiles and never once complained.

### 44.3 What it cost, and what it bought

| | before | after |
| --- | --- | --- |
| road-net edges carrying a deck | 6 | 12 |
| crossings of the strait | 2, both west of x=340 | 5, spread across the map |
| landmark-to-landmark detour, p50 / p90 / worst | ×1.60 / ×2.49 / ×5.10 | ×1.47 / ×1.88 / ×3.41 |
| Market Square → Seaview Infirmary | 1,034 tiles | **266** |

Two tests moved, both because the model in them had been leaning on the
missing bridges:

- `coastCache.test.ts` floods the sea from the map border to tell a pond from
  the ocean, and flooded over water tiles only. With both mouths of the strait
  decked, that declared the whole 39,000-tile basin a pond. The flood now runs
  **under decks**, which is what a deck is: a thing over water, not a piece of
  coast.
- `shoreCut.test.ts` measures how often the coast curve and the tile plane
  agree about which side is wet. Three new landfalls took the whole-map figure
  from 98.4% to 97.7% — 90 of the 154 disagreeing tiles are within three of a
  deck, where the bank is cut back for a ramp and the tiles are the abutment's
  rather than the coast's. Abutments are now counted apart and bounded (one in
  five may disagree, four in five may not) and the coastline proper is held to
  the 98% it always was — 98.98%, measured.

### 44.4 Owed

- Eleven junctions still dead-end within six tiles of open water. Three were
  the stumps of the deleted crossings and are gone; the rest are real streets
  that stop at the shore, which is §2.3 of the review and a separate job.
- The ring crosses the strait as **two parallel decks** at each end, because
  its west and east legs saw-tooth by 18 tiles (`city-plan.json`, The Ring).
  It reads from above as an accidental dual carriageway.
- `maxBridgeSpan` at 96 also allows a deck across the lagoon mouth at 560,669
  if the cap ever goes to 108. Nobody has asked for that crossing; if it is
  wanted it should be an authored road, not a side effect of a number.
