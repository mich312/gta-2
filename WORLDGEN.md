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
**Verdict: keep as the skeleton.** *(Superseded twice: §13.4 replaced the
lattice with fabrics, §17 replaces the tile substrate under them.)*

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
   the lane model today. *(§17 withdraws this one: three waves of working
   around the tile plane are the evidence that it stopped binding here too.)*
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

## 17. The grid, thrown away — the city as vector geometry

Fifth wave, and the one this document has been circling since §9.1 named
tiles "the only shared truth". The brief: **throw the grid-based map away
and design what replaces it.**

### 17.1 Which grid is meant

Two different things have been called "the grid" here, and only one of them
is still standing.

The first was the **street lattice** — one screen-aligned plaid over sixteen
boroughs (§13.1, Finding 1). That grid is already dead: §13.4 replaced it
with five fabrics, §13.6 delivered them, and the shipped city carries
rotated grids, shore contours, avenue spines, crescents and meandered rural
lanes. Nothing below revisits it.

The second is the **substrate**: a 768×768 `Uint8Array` of 16 px cells,
one material byte per cell, `tileAt` (`types.ts:336`) as the question every
system asks the world. That is what this section throws away, and it is the
older and larger of the two — it predates the plan, the bake, the fabrics,
the bevels and the courses, and every one of those five waves has spent part
of its budget working around it.

§13.2 listed "the tile substrate" first among the constraints that still
bind. This section is the argument that it stopped binding and nobody
noticed.

### 17.2 The review: what the tile plane costs, measured

Numbers from the shipped bake (`city.data.ts`, decoded and walked; the RLE
codec is `bake.ts:752`):

| Measure | Value |
|---|---|
| Tiles | 589,824 |
| RLE runs in the tile plane | 85,506 |
| Baked source: tiles / district / bearing | 228 kB / 11 kB / 120 kB base64 |
| `city.data.ts` on disk | **880 kB** |
| `city-plan.json` — the thing a human drew | **27.5 kB** |
| Connected same-material regions (4-connected) | 16,876 |
| …of them under four tiles | 7,240 |
| …of them exactly one tile | 2,640 |
| Material boundary segments (16 px each) | 164,232 |
| Land-collision boundary segments | 64,376 |
| …the same boundary, collinear runs merged | **23,330** |
| Water-collision boundary, merged | 4,904 |
| `Building` records — already axis-aligned rects | 3,801 (15,204 edges) |
| Courses — already polylines (§16) | 289 (9,658 points) |

Five readings, in ascending order of how much they should hurt:

**1. The map inflates 32×, and the small version is the readable one.** A
27.5 kB drawing becomes 880 kB of committed source. The drawing is the
artifact a person edits, reviews and argues about (§12.10); the 880 kB is
its shadow.

**2. Two thirds of the regions are rasterisation confetti.** 7,240 of
16,876 same-material regions are under four tiles and 2,640 are a single
tile. Those are not places. They are what happens when a curve crosses a
lattice — the four-tile scrap blocks §13.1 Finding 2 complained about, now
counted.

**3. The collision surface is small.** The entire land-collision boundary of
Anywhere City, collinear-merged, is **23,330 line segments** — and 15,204 of
those are the four sides of building records the bake *already has* as
vectors and then paints over. Water contributes 4,904. This is Doom-map
scale (a large Doom II level runs to a few thousand linedefs), against the
589,824-cell array we carry to express it.

**4. The bearing plane is the confession.** 120 kB — a seventh of the whole
bake — exists to store, per tile, which way the street runs
(`types.ts:240`), because the tile plane destroyed the direction the course
was carved along and downstream passes could not guess it. The courses were
one field away the whole time; §16 kept them, and the bearing plane is still
there.

**5. Every wave since §13 has been vector recovery.** Stated as a list,
because the pattern only shows up as one:

- **§15, bevels.** A byte per tile naming which half of it belongs to the
  neighbour (`bevel.ts`), so a rasterised 45° shore can be walked along
  rather than climbed. A diagonal, reconstituted from squares, one half-tile
  at a time — and only at 45°, because that is all a half-tile can say.
- **§16, courses.** The polylines the disc was swept along, kept this time
  instead of thrown away — and where they had not been kept, *recovered*
  from their own rasterisation by "a greedy nearest-unvisited walk, relaxed
  twice with a moving average to shed the chamfer field's octagonal facets".
  That sentence is a raster-to-vector pipeline, written because the vector
  had been deleted eight passes earlier.
- **`marks.ts:67`, `diagonalRoadDir`.** Covariance of the road mass in a
  neighbourhood, to decide whether a band of tiles "genuinely runs at 45°".
- **`amenities.ts:353`.** "Walk the true line three tiles" — the rotated
  street's answer to `axisCarriageway`, because the tiles cannot say which
  way a kerb faces.
- **`signals.ts:110`.** A junction test that measures narrowness in four
  directions, because a four-tile carriageway at 45° measures nearly six
  across an axis (§12.8).
- **`bake.ts:trimCourses`.** Quantise the polyline, sample every half tile,
  drop anything under three times its own width — an entire pass devoted to
  reconciling a curve with its own painting (and BUGS.md §9.3 was the bug in
  it).

One sentence for all six: **the bake rasterises vectors, and every consumer
downstream reconstructs vectors from the raster.** The tile plane is a lossy
intermediate format sitting in the middle of a pipeline whose two ends both
want geometry.

### 17.3 The consumers, honestly

Nothing above is an argument until the things that read tiles are named and
asked what they actually need. Thirty-four source files touch `map.tiles`,
`tileAt` or `TILE_SIZE`, and another thirty tests do. Every one of them, by
what it is really asking:

| Consumer | Reads tiles for | What it actually needs |
|---|---|---|
| `collide.ts` — the live 2D solver, inside prediction | is this cell solid; which face blocks a box | the nearest blocking **face**, at any angle |
| `volume.ts` / `collide3.ts` — built, **not adopted** (`cityGeometry.ts:131`) | per-tile span stacks | floor/ceiling per **region** |
| `roadgrid.ts` — A* over 589,824 cells, 5 MB scratch, 60,000-expansion guard | drivable cells | a road **graph**; there are 289 courses |
| `traffic.ts` — cardinal probes, then a fan of bearings when the cardinals fail (`traffic.ts:560`) | is there road that way | the **lane** the car is in and the next one |
| `signals.ts` | narrowness in four directions | junction **nodes** of the graph |
| `amenities.ts` — 45 tile references | kerbs, doorways, perimeters | edges with a **side** and a frontage |
| `buildings.ts` | block masks, frontage march | polygons |
| `render/tiles.ts` — 46 references | the painting, per 8×8 chunk | filled polygons + tile-space *art* |
| `three/cityGeometry.ts` | instanced boxes per span | extruded polygons |
| `minimap.ts`, `shadows.ts`, `extrude.ts` | silhouette, footprints | polygons |
| `turf.ts` | coarse ownership cells | **a grid, genuinely** — it is a game rule |
| `weapons.ts`, `peds.ts`, `police.ts` | line of sight, "can I stand here" | a segment query and a point query |

Exactly one of these wants a grid on its own merits, and it is the one that
is not geometry: turf ownership at a coarse pitch is a rule about who holds
what, not a description of the ground. Every other row is asking a vector
question and being handed a bitmap.

### 17.4 The approaches, surveyed

Same treatment as §3 and §13.3: what the field offers for "a map that is not
a grid", judged against this codebase.

**17.4.1 Finer or adaptive tiles** — 8 px cells, a quadtree, sub-tile
occupancy masks. Quadruples the plane to fix nothing: a curve is still a
staircase, one step smaller, and every re-derivation in §17.2 stays written.
The bevel plane already *is* the sub-tile mask, and it can only say 45°.
**Verdict: reject. This is the option that looks like progress and is not.**

**17.4.2 Analytic composition — the plan, evaluated** ([SDF collision as
practised in games](https://www.cocos.com/en/post/building-collision-detection-using-signed-distance-field)).
The map is a stack of strokes — roads as capsules along courses, water as
polygons, buildings as boxes — and a query evaluates the composition in
paint order. This is *exactly what the bake already does*, minus the
freezing step, and it is the right model for **authoring**. As a runtime
query model it fails on cost: the composition is thousands of strokes and
answering "what is here" needs the ones near the point, which is an index —
so it converges on 17.4.4 with an extra evaluation per query. **Verdict:
adopt as the authoring model (it already is); reject as the query model.**

**17.4.3 Planar arrangement / DCEL** — the full computational-geometry
object: faces, half-edges, twins, point location by trapezoidal map. The
right *vocabulary* and more machinery than a city with 23,330 collision
edges justifies; robust construction of an arrangement is where geometry
libraries go to die, and `boolean-op-on-polygons` bugs are not a class of
defect this repo wants inside prediction. **Verdict: steal the vocabulary
(face, edge, side), reject the machinery.**

**17.4.4 Polygon soup with a uniform index — the Doom architecture.** Doom's
map is [vertices, linedefs, sidedefs and
sectors](https://doomwiki.org/wiki/Map_format): the world is a 2D vector
drawing, walls are line segments, floors and ceilings belong to sectors, and
collision is accelerated by the [blockmap](https://doomwiki.org/wiki/Blockmap)
— a 128×128-unit grid whose only content is "which linedefs cross this
block", so a moving thing tests the handful of segments in its own block
instead of the whole level. Thirty years old, shipped on a 386, and it is
the shape this problem has: **the truth is vectors, the grid is an index and
holds nothing.** Rebuild the index and the world is unchanged; that is the
property the tile plane does not have and cannot be given. **Verdict: adopt.
This is the design.**

**17.4.5 Navmesh / convex free-space decomposition**
([Recast](https://deepwiki.com/recast4j/recast4j/2-navigation-mesh-generation)
is the state of the art, in Unity, Unreal and Godot). A 100×100 m arena is
40,000 cells at 0.5 m or 50–200 navmesh polygons; A* over 200 nodes against
40,000 is not an optimisation, it is a different order of problem. Our
`planRoute` searches 589,824 cells with a `MAX_EXPANSIONS = 60_000` guard
that exists purely because a route to somewhere unreachable floods the city
(`roadgrid.ts:236`). **Verdict: adopt for on-foot AI; the guard is a
symptom, not a design.**

**17.4.6 Network graph — nodes, segments, lanes.** [Cities: Skylines models
roads as nodes joined by segments, each segment knowing its type, its lanes
and its neighbours](https://doc.tmpe.me/nodes-segments-lanes.html); lane
changes happen at nodes. We are two thirds of the way there by accident:
§16 ships 289 courses with centreline, width and kind, and `laneCentreInTile`
(`marks.ts:41`) already knows where a lane sits across a carriageway. What
is missing is the junction nodes, and `signals.ts` computes those from the
tiles every bake. **Verdict: adopt; it is mostly assembly of parts already
in the box.**

**17.4.7 An off-the-shelf 2D physics engine** — Box2D, planck.js, Rapier2D.
Rejected for the reason `volume.ts:40` already rejected the 3D ones, and
which nothing about being 2D changes: none guarantees bit-identical results
across platforms, and [floating-point determinism across compilers and
architectures is not something a library can promise](https://gafferongames.com/post/floating_point_determinism/).
Replays, the bot harness, the host-parity gate and rewind reconciliation all
depend on it. **Verdict: reject, permanently.**

### 17.5 The design: the vector city

Five artifacts. The first four are the map; the fifth holds no truth.

**V0 · Vertices, in fixed point.** One unit = 1/16 px = 1/256 tile, stored
as `Int32Array`. Map coordinates top out near 2^18, so the cross product of
two edge vectors stays under 2^38 and every orientation test is an exact
integer computation in a double — no [adaptive-precision
predicates](https://www.cs.cmu.edu/~quake/robust.html) needed, because the
inputs are integers and the products fit. This is the single decision that
makes the whole thing safe inside prediction: **the map's geometry stops
being a source of order-dependence at all.** Movers stay in floats, as they
are today; what changes is that the thing they are compared against is
exact.

**V1 · Surfaces.** A material region: one outer ring, zero or more holes,
a material, and a floor and ceiling height. Doom's sector, with our
`T_*` codes as the material. The surfaces partition the plane — no overlaps
in plan, no gaps — which is a decidable property over integer coordinates
and therefore a test.

**V2 · Edges.** A segment between two vertices, with the surface on each
side. Solidity stops being a property of a *cell* and becomes a property of
a *boundary*: an edge is solid to land movers when the materials either side
disagree about being walkable, solid to hulls when they disagree about being
water, and a kerb when they disagree about height by less than the step-up.
One-sided edges are the map's outer wall. Everything `plainSolid`
(`collide.ts:28`) decides per cell is decided per edge, once, at bake time.

**V3 · The network.** §16's courses promoted from decoration to truth:
junction nodes, carriageway segments carrying width, kind, bearing and
median, lanes as signed offsets. `signals.ts` labels nodes instead of
scanning tiles for narrowness; `planRoute` searches ~3,000 segments instead
of 589,824 cells; `traffic.ts` asks which lane it is in instead of probing a
fan of bearings and taking the longest run.

**V4 · The index.** A uniform block grid — 8 tiles, 128 px, Doom's number by
coincidence and by the same reasoning — where each block holds the edges
crossing it and the surface covering it when exactly one does (the
overwhelming case: a block wholly inside a building, a block of open sea).
This is the only grid that survives, and it is derived: **rebuilding it from
V1–V3 must reproduce it byte for byte, or it has become a second truth and
the design has failed.**

How each query is answered:

- **`isSolidAtWorld`** → index block → its covering surface if it has one,
  else point-in-ring against the two or three candidates. Common case is one
  array read, which is what it is today.
- **`moveWithCollision`** → clip the swept box against the solid edges in
  the touched blocks. The pleasing part: `faceX` (`collide.ts:122`)
  *already* evaluates a line at the box's nearest corner — that is what
  `x0 + yLo` is — for each of the four bevel codes. Generalising a slope-1
  half-plane to an arbitrary one is the same shape of code with the slope
  read from the edge instead of switched on a byte. The axis-separated,
  sub-stepped, clamp-flush structure that makes it exact-op survives intact.
  **The bevel plane (§15) then deletes itself**, and the shoreline stops
  being 45°-or-square and becomes whatever angle it was drawn at.
- **Height.** Floor and ceiling per surface, not spans per tile. `T_BRIDGE`
  — the one material that means two levels at once, road on the deck and
  river beneath, and the only such case the tile plane can express
  (`volume.ts:18`) — becomes two surfaces overlapping in plan at different
  z, which is what it always was. And then **grade separation, which §12.7 called "the single
  biggest missing chase primitive" and deferred as a new tile type through
  collision and both renderers, is an authoring decision**: draw a road over
  a road. That is the largest single item in this section and it is a
  consequence, not a feature to be built.
- **Rendering.** §16's course painter already strokes vectors and the ground
  chunks already cache the result; the ground becomes filled polygons under
  the same chunk textures, and `render/tiles.ts`'s forty-six tile branches
  become fills with tile-space art (grain, joints, manholes, resurfacing
  patches) as a *texture over* a polygon rather than a decision *per* cell.
  §16's own closing note — "the ribbon's flat asphalt could carry grain once
  the painter can clip to a stroked path" — is this, arriving.
- **Placement.** A doorway is an edge, assigned when the building is placed.
  `findDoorway` (`amenities.ts:119`) and its water-doorway bug class
  (`buildings.ts:33`) go the way §9.2's L3 promised and never got.

### 17.6 What it costs, and what breaks

Stated before the sequence, because a section that only lists wins is not
research:

1. **The tile plane is read in about fifty files.** No step below touches
   more than a few. The migration is long, and its middle is a period where
   both representations exist and must agree — which is a cost and also the
   safety net (§17.8).
2. **Replays re-record once.** Any change to the collision surface changes
   trajectories; the diagonal shore becoming truly diagonal is a *better*
   map and a broken replay corpus. One declared break, at step 2, in
   `PROGRESS.md`, per the discipline `ROADMAP.md:581` already sets for
   seed-breaking changes.
3. **Some art is genuinely tile-shaped.** Kerb shading, paving joints, the
   per-district pavement tint. These stay; they become a texture in tile
   space applied over a polygon, which is how they are already being drawn
   into 8×8-tile chunk canvases.
4. **Fine geometry is a new failure mode.** Slivers, degenerate rings and
   near-collinear vertices are to a polygon map what the 2,640 one-tile
   regions are to this one — except a sliver in a collision mesh is a place
   a car falls through. Integer coordinates make the checks decidable;
   §17.8 makes them tests.
5. **Point-in-polygon is not free at the boundary.** Blocks straddling a
   coast hold several surfaces. The mitigation is the same one Doom used:
   the common case is a block with one surface and no edges, and the index
   is built to make that case an array read.
6. **`T_FLOOR`, `T_RAMP` and the district plane each need a landing.** Shop
   interiors become surfaces with their own floor (they already are, in
   everything but storage); ramps become surfaces with a sloped floor, which
   is *more* than `RAMP_Z`'s stepped 12 px can say; the district plane
   becomes a property of the surface, which is where it belonged — 11 kB of
   the bake is spent painting it per cell.

### 17.7 The sequence

Strangler-fig, per §9.5 and §12.10. Each step ships green, each has the
picture as its acceptance test, and steps 1–3 leave the shipped map
byte-identical.

| # | Step | What lands | What retires |
|---|---|---|---|
| 1 | **The soup, derived** | The bake emits V1/V2/V4 *from the finished tile plane* — marching squares to trace each material's boundary, collinear merge, then simplification — and ships them beside it. No consumer changes. | nothing yet *(superseded: §17.11 replaces this step, and says why)* |
| 2 | **Collision moves** | `moveWithCollision` clips against edges; `isSolidAtWorld` reads surfaces | the 45°-only shoreline *(DELIVERED for water: §17.12 — and the bevel plane survives it, see there)* |
| 3 | **The network replaces the probes** | `planRoute` and `traffic.ts` on V3; `signals.ts` labels nodes | `MAX_EXPANSIONS`, the 5 MB A* scratch, the bearing plane (120 kB) |
| 4 | **The bake emits vectors first** | The plan's polygons carried through to V1/V2 instead of recovered from the raster; tiles become an *output* | `trimCourses`' recovery pass; the 880 kB |
| 5 | **The renderer fills polygons** | Ground chunks painted from surfaces; art as tile-space texture | 46 per-tile branches; the staircase kerb |
| 6 | **Surfaces get z** | Floor/ceiling per surface; `collide3` adopted against V1 rather than a span grid | `T_BRIDGE` as a material; **the flyover ban** |
| 7 | **The last readers** | Amenity scans become surface and edge queries | `city.data.ts`'s tile string |

Step 1 is the whole safety net and is pure addition: it can land, be
measured and be reverted without a single system noticing. It is also where
the raster-to-vector literature does its work — [marching squares to trace,
Douglas–Peucker or Visvalingam to
simplify](https://dyn4j.org/2021/06/2021-06-10-simple-polygon-simplification/),
which is the standard pipeline for turning a bitmap into a collision mesh —
and where the simplification tolerance gets chosen by looking at the picture
rather than argued about.

Step 4 is where the direction of the pipeline finally reverses. Today:
plan → tiles → (recover vectors). After it: plan → vectors → tiles, and the
tile plane is a derived cache that any consumer may keep using until step 7
takes it away.

### 17.8 The invariants

Per §5, every step ships with its check, and the migration's central one is
the first:

- **Agreement.** Through steps 1–6, the vector city and the tile plane must
  answer *identically* — solidity at every tile centre and every tile
  corner, material at every centre, drivability at every centre. 589,824×3
  assertions, cheap, and the thing that makes a fifty-file migration
  survivable. Where they disagree deliberately (the diagonal shore, step 2),
  the disagreement is enumerated and asserted to be exactly the bevelled
  tiles.
- **Partition.** Every ring closed, simple and consistently wound; no two
  surfaces overlapping in plan; no uncovered ground. Decidable over
  integers, so it is a test and not a hope.
- **No hair.** No edge under a quarter tile, no ring under one square tile,
  no interior angle under ~5°. The vector form of the sliver check §13.5
  already runs on blocks — and the count to beat is on the table in §17.2:
  2,640 one-tile regions.
- **The index is a cache.** Rebuild V4 from V1–V3 and get the same bytes.
  If this ever fails, the index has acquired truth and the design has
  regressed to the thing it replaced.
- **Connectivity, stated directly.** Today the reachability check floods
  tiles. On V3 it is "one connected component per landmass", which is a
  sentence about the graph rather than a search over half a million cells.
- **No overlap without separation.** Once step 6 lands: two surfaces
  overlapping in plan must be separated in z by more than a mover's height —
  the invariant that keeps a flyover a flyover and not a hole.

### 17.9 What stays a grid, on purpose

Naming these so the next wave does not re-litigate them:

- **The index** (V4). 128 px blocks, no truth, rebuildable.
- **Turf cells** (`turf.ts`). Ownership at a coarse pitch is a game rule.
- **Chunk textures.** 8×8-tile canvases are a rendering cache and a good
  one.
- **Tile-space art.** Grain, joints, manholes, kerb shading — a texture, not
  a data structure.
- **Interest management.** Radius over entities; never touched tiles anyway.

### 17.10 The verdict

The tile grid was the right call when the map was generated on every client
at connect time and had to be provably identical (§2.1). §12 ended that: the
bake runs offline, once, and what ships is bytes somebody looked at. §13
noticed the vetoes had expired for *street layout* and lifted them. This
section says the same thing has been true of the *substrate* for three waves
and the evidence is in the codebase — a bearing plane, a bevel plane, a
course-recovery pass and a covariance test, all of them reconstituting
geometry the bake had in its hands and painted over.

**The city is a drawing. Ship the drawing.** 27.5 kB of it, indexed, instead
of 880 kB of its shadow — and the flyover, the true diagonal and a road
graph arrive with it rather than as three more projects.

Sources: [Doom map
format](https://doomwiki.org/wiki/Map_format) and
[blockmap](https://doomwiki.org/wiki/Blockmap) ·
[Recast navmesh
generation](https://deepwiki.com/recast4j/recast4j/2-navigation-mesh-generation) ·
[Cities: Skylines nodes, segments and
lanes](https://doc.tmpe.me/nodes-segments-lanes.html) ·
[GTA2's GMP block format, diagonals
included](https://gtamp.com/gta2/gta2-gmp-map-file-format/) ·
[polygon simplification](https://dyn4j.org/2021/06/2021-06-10-simple-polygon-simplification/) ·
[SDF collision in
practice](https://www.cocos.com/en/post/building-collision-detection-using-signed-distance-field) ·
[Shewchuk on robust
predicates](https://www.cs.cmu.edu/~quake/robust.html) ·
[floating-point determinism](https://gafferongames.com/post/floating_point_determinism/).

### 17.11 The sequence, corrected — and the first wave, DELIVERED

§17.7 was written before anything had been tried, and its first step was
wrong in a way worth recording rather than quietly fixing.

**What was wrong with step 1.** "The bake emits V1/V2/V4 *from the finished
tile plane* — marching squares, collinear merge, simplification" is the safe
migration step: it cannot disagree with anything, and it delivers a picture
identical to the one already shipping. That is precisely the problem. Tracing
a raster gives back the staircase in vector clothing — 23,330 axis-aligned
segments that are *exactly* as square as the bytes they came from — so the
step banks the whole cost of a new representation and buys none of its value,
and it enshrines the raster as the source at the very moment the point is to
demote it. A migration whose first step is invisible is a migration that gets
abandoned at step two.

**The correction, in one sentence.** Do not trace the raster; trace **the
thing the raster was thresholded from**, one material at a time, and make the
raster the *proof* rather than the source. Every material in this city comes
from something continuous — the coastline is an implicit field
(`layout.ts: paintCoast`), the roads are polylines (§16), the buildings are
rectangles. The vector is upstream in all three cases. The raster's job in the
migration is not to supply the geometry; it is to **check** it, by being
reproduced exactly.

That turns §17.7's seven horizontal steps into vertical slices — one material
carried from field to collision to renderer, then the next — and it moves the
"tiles are derived, not master" reversal from step 4 to step 1, where it
belongs.

**Why water first.** It is half the map (49.5% of tiles), it owns the
boundary the eye is most offended by, §15 spent an entire wave chamfering that
boundary 45° at a time, and its consumers are few and crisp. It is also the
only material whose upstream form is a *field* rather than a polyline, so it
is the hardest of the three — which is the right one to prove the architecture
on.

---

**DELIVERED — the shore as a curve.** `shared/src/world/shore.ts`, traced in
the bake, shipped in `city.data.ts`, consumed by nothing yet.

Marching squares over the tile-centre lattice fixes the topology; each
crossing is then placed along its edge by bisecting the same warped distance
field the mask was thresholded from (`Coast.field`, exposed for the purpose),
so the line lands where the water is rather than halfway between two cells.
The result:

| | |
|---|---|
| Rings | **26** — 14 land outlines, 12 holes |
| Points | **4,088**, mean edge 1.73 tiles, longest 54 |
| Against | 64,376 land/water tile faces; **4,904** once collinear runs are merged |
| Cost in the bake | 11.3 kB base64, and 0.4 s of the 7 s bake |
| Disagreement with the shipped tile plane | **0 of 589,824** |

Two properties do the work, and both are tests (`shore.test.ts`):

- **It cannot contradict the tiles.** A crossing is clamped to the middle 70%
  of its edge, so the contour never passes through a tile centre; and
  simplification is verified rather than trusted — the rings are filled back
  at every tile centre and must reproduce the mask, with the tolerance
  stepping down a ladder until they do. Zero disagreement is not a measurement
  of this bake, it is a property of the pass.
- **It agrees about area.** Segments are directed with the land on their
  right, so a ring's winding says whether it bounds land or a hole, and the
  signed areas of all 26 rings sum to **297,744 square tiles against 297,768
  land tiles — 0.9999**. The vector city and the raster city are measurably
  the same city.

The tile, district and bearing planes hash **identical** to the previous bake.
This wave added a curve and moved nothing.

**Evidence: `evidence/city-shore-vector.png`** (`pnpm mapgen --shore
--scale=20 --crop=600,300,48`, two new review flags). Top left, the tiles
descend in visible steps while the ring runs as one straight diagonal through
the middle of them. On the quay at the right the ring hugs the tile edges
instead — correctly, because that is built ground the coastline field has no
opinion about, and the crossing falls back to the middle of the gap. Curve
where nature drew it, square where somebody built it, from one pass with no
special case for either.

**What the wave found, which is worth more than the curve.** Tracing the
*finished* tile plane rather than the geography's water mask exposed 2,153
cells where the two disagree, and every one of them is a thing the tile plane
cannot say:

- **1,524 bridge decks.** The rings cut round every deck, leaving a
  bridge-shaped hole in the sea — because to a tile, "road" and "river"
  are alternatives. That hole is precisely where the missing z-axis is
  hiding, and §17.5's sectors are what close it.
- **238 park ponds** (`buildings.ts:596`), carved after the coastline and
  unknown to it. They are not the sea; they are water you cannot drive into,
  which is the only question collision asks.
- **391 reclaimed tiles** where the shore-finishing pass built quay and beach
  out over shallow water, moving the effective waterline inside the
  geography's by up to a tile.

The first of those three is a design hole with a known fix. The other two are
simply the difference between *the coastline* and *the water surface*, and
naming it is why the artifact is traced where it is.

**Next, in order.** (2) Collision reads the rings: generalise `faceX`'s bevel
half-plane to an arbitrary edge, index the rings by 128 px block, retire the
water half of the bevel plane. (3) The same treatment for the road courses,
which are already polylines and need only widths and junctions to become V3.
(4) Buildings, which are already rectangles. At that point three of the four
materials are vectors and the tile plane is a cache.

### 17.12 The shore stops being squares — collision, DELIVERED

Wave 2 of §17.11's corrected sequence: the rings stop being decoration and
become what a mover is stopped by.

**What landed.** `buildShoreIndex` (`shore.ts`) turns the rings into a
per-tile edge index, built at generation time from bytes both hosts already
have — like `junctions`, never sent. Each segment is stored as the half-plane
the water occupies, `nx*x + ny*y >= c` in world px; the ring points are
sixteenths of a tile and a tile is 16 px, so every coordinate is a whole
number of pixels and `nx`, `ny` and `c` are exact integers. `collide.ts`
consults it wherever a tile carries edges, and falls back to the tile byte
everywhere else — which is what lets a bare test fixture with no rings behave
exactly as it did.

| | |
|---|---|
| Edges indexed | **3,829** of 4,088 ring segments |
| Tiles carrying edges | 7,898 — of them 3,663 carry more than one, max 4 |
| Sample points in the shore band that changed side | **16.5%** |
| Tile centres answering differently from the tile plane | **0** of 589,824, in both media |
| `moveWithCollision` | 194 ns inland, 3.8 µs on a shore tile |
| Tests | 869 pass; host-parity gate green, Node and browser tick for tick |

The agreement number is the one that matters. The rings reproduce the mask at
tile centres by construction, so the solver reading them answers exactly what
the byte answered *there*, in both media — and everything that ever placed
something on the strength of a byte is therefore undisturbed. No ped spawn, no
player spawn, no parking spot, no mooring and no vehicle home moved into solid:
0 of 8,573, 16, 1,514, 460 and 1,514 respectively. The 16.5% is where the two
differ, and it is all sub-tile: the waterline is now wherever the coastline
field put it rather than on the nearest tile edge.

**The bridge holes are handled, and named.** The rings are traced from the
tile plane, where a deck is not water, so the sea carries a deck-shaped hole
around every bridge (§17.11). 259 of the 4,088 segments bound one, and they
are dropped from the index outright — kept, they would have walled a car in on
the parapet and a boat out of the arch. The water surface is therefore
continuous under every deck, which is the truth the tile plane cannot hold and
the one place this wave gets to act as though §17.5's sectors already existed.

---

**What it cost, which is the part worth reading.** Three bugs, none of them in
the geometry and all of them in the assumption that a boundary is square. They
are recorded because the next material to be vectorised will hit all three.

1. **A tile is no longer uniform, so the solver must sweep.** `moveOnce` tested
   only the tile the leading edge *lands* in — correct when a tile is all solid
   or all open, wrong the moment a tile has a wall part-way into it, because a
   mover standing in such a tile walks into the half of it that is sea. It now
   tests every tile the leading edge crosses. That guard needs its own guard: a
   tile you are standing in also holds the face you came past to get there, and
   without ignoring faces already passed, walking *away* from a shore clamps you
   back through it. Worse, the ignore has to be applied per EDGE before the
   edges are combined — a tile where the shore turns holds one edge whose water
   is ahead and one whose water is behind, and letting the second into the union
   hides the first. That one cost the longest.

2. **A hull's solid is an intersection, not a union.** Within a tile the water
   is the union of its edges' half-planes, which any single edge can answer
   for; the land is the intersection of their complements, which none of them
   can. Nearly half this city's shore tiles carry more than one edge, so
   approximating it put invisible walls in open water wherever a coast turned a
   corner — a boat stopped in clear water. It is computed now, Sutherland–
   Hodgman, at most four half-planes against a rectangle.

3. **Axis-separated collision cannot hold a sloped face.** x is clamped against
   the rows the box is in, then y moves it to different rows, and against a
   slope the wall is somewhere else there. Measured: one move in sixty near a
   shore finished inside the water, by 0.9 px at the median and **14 px** at the
   worst — a car's length, and a thing you would see. This is not a bug the
   tile grid ever had, because a tile's faces are square to the axes and moving
   along one never changes where the other is; it arrives WITH the vector
   boundary and has to be answered rather than designed away. `resolveShore`
   answers it: after each sub-step, push the box out along the deepest violated
   edge's normal, a few times over because a corner can violate two at once.
   0.02% remain, and the one that does is 3.4 px.

The general lesson, stated for the waves that follow: **a vector boundary is
not a drop-in for a square one, and the difference is not in the geometry but
in the solver.** Everything above was a solver assumption that the tile grid
had made safe for free.

**What is honestly still owed.**

- **The index is per tile, so its offset table is one `Int32` per tile: 2.4 MB.**
  That is in line with what `volume.ts` already allocates and it is not what
  §17.5 designed — a 128 px blockmap holds the same edges in a sixty-fourth of
  the table. Worth doing when a second material joins.
- **A move on a shore tile costs 3.8 µs against 194 ns inland**, nineteen times,
  because `resolveShore` re-scans the touched tiles after every sub-step. Shore
  tiles are 1.3% of the map so nothing measurable happens today, but the cheap
  reject (skip the resolve when the step touched no indexed tile) is owed before
  a second material multiplies the number of indexed tiles.
- **The bevel plane is still generated and still used.** Collision prefers the
  rings and reaches for a bevel only where there are none, which on this city
  means never for water. Retiring the plane is a rendering change, not a
  collision one, and belongs to the wave that gives the renderer the rings.

**Next.** Wave 3 is the road network: the courses are already polylines and
need only junctions and widths to become V3, and `planRoute`'s A* over 589,824
cells with its 60,000-expansion guard becomes a search over some three thousand
segments. It is the largest single win left for game code, and unlike this wave
it touches no solver.
