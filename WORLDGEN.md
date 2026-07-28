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
