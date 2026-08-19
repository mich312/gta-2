# REVIEW-MAPDESIGN.md — the city from straight above, read as a map, not as a render

`REVIEW-WORLDGEN.md` part two already flew this city at pitch 8° and hunted
*rendering* bugs: dash carpets, parapet wedges, slab roofs. This is the other
review you get from the same viewpoint and the one nobody has written yet —
the **map designer's** pass. Not "does it draw correctly" but "is this a good
place to drive a stolen car around": where the crossings are, what the
detours cost, which ground is doing no work, and whether the systems layered
on the map (territory, spawns, amenities) know what the map looks like.

Everything below is measured off `generateCity(1)` — the shipped bake plus
the session's amenity passes — and every claim names the file it comes from.

> **A warning about the pictures, added after the fact.** Every render in this
> review was taken with `pnpm mapgen`, and until `WORLDGEN.md` §49 that tool
> drew lane markings **only for authored courses** — so most of the street
> lattice appeared as bare tarmac with no centre line and no kerb paint. The
> city was never like that; the game's painter marks every road tile. Judgements
> here that rest on *measurement* stand. Judgements that rest on how a render
> *looked* — anything about hierarchy, or a district reading as undifferentiated
> — were made from a picture that under-drew its own subject. The renders have
> been retaken.

**The pictures.**

| File | What it is | Retake |
| --- | --- | --- |
| `evidence/mapdesign-city.png` | The whole city, 2 px per tile | `pnpm mapgen --out=evidence/mapdesign-city.png` |
| `evidence/mapdesign-strait.png` | The strait end to end, 3 px per tile | `pnpm mapgen --crop=240,250,470,220 --scale=3 --out=evidence/mapdesign-strait.png` |
| `evidence/mapdesign-skyline.png` | Downtown at the camera pitch the game is played at | `SHOT_TIMEOUT=240000 WAIT_GROUND=25 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=470,180&h=900&pitch=42&night=0" evidence/mapdesign-skyline.png` |
| `evidence/mapdesign-creek.png` | The creek and its three new crossings | `pnpm mapgen --crop=330,425,110,90 --scale=9 --out=evidence/mapdesign-creek.png` |
| `evidence/mapdesign-downtown.png` | The Spine at 26×21, with Exchange Square | `pnpm mapgen --crop=420,120,145,200 --scale=5 --out=evidence/mapdesign-downtown.png` |
| `evidence/mapdesign-deck.png` | A deck with its parapet, shadow and piers | `pnpm mapgen --crop=545,265,55,125 --scale=8 --out=evidence/mapdesign-deck.png` |
| `evidence/mapdesign-quay.png` | Kelvin Quay and Bridgefoot on the headland | `pnpm mapgen --crop=410,290,150,100 --scale=6 --out=evidence/mapdesign-quay.png` |
| `evidence/mapdesign-junction.png` | A signalised crossroads at 44 px per tile — crossings, stop lines, turn arrows, kerb radii (§3) | `pnpm mapgen --crop=462,182,17,17 --scale=44 --out=evidence/mapdesign-junction.png` |
| `evidence/mapdesign-junction-3d.png` | The same crossroads from the flyover, with its lights (§3.2) | `pnpm --filter client dev`, then `WAIT_GROUND=25 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=470,190&h=380&pitch=42&tick=30" evidence/mapdesign-junction-3d.png` |
| `evidence/mapdesign-turf.png` | The seven manors, washed over the ground they hold | `pnpm mapgen --turf --out=evidence/mapdesign-turf.png` |
| `evidence/mapdesign-headland.png` | The 3D city at pitch **0°** over downtown and the headland | `pnpm --filter client dev`, then `SHOT_TIMEOUT=480000 WAIT_MS=900000 WAIT_GROUND=60 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=470,300&h=2400&pitch=0&night=0" evidence/mapdesign-headland.png` — this one paints a whole screen at a fifth of a frame a second, so both waits have to be raised or the shot comes back black |

---

## 1. What the map does well, and it is a lot

- **The boroughs read apart at a glance.** From 768 tiles up you can name
  Ravenhill, The Spine, the Old Quarter, the Terraces and the New Suburbs
  purely by fabric — pitch, angle and roof colour do the work that a legend
  would otherwise have to. Very few hand-made GTA-era maps manage five
  distinguishable fabrics; §13.4's per-borough pitch and angle is why.
- **The coastline is the best thing in the city.** The vector shore
  (`VECTOR.md`) gives headlands, a lagoon, a hooked spit and a real
  sound — a silhouette you could put on a loading screen and be recognised by.
- **Gannet Rock is a genuinely good idea.** A cliff-ringed plateau with a
  strip on top, `byAir: true`, no road anywhere (`--stats`: `road 0%`) and a
  campground as the prize. One island in the map that exists to reward owning
  an aircraft is exactly the kind of thing that makes a map memorable.
- **The sound crossings are placed like a designer placed them** — North
  Sound Bridge at y≈228 and South Sound Bridge at y≈476, 250 tiles apart, so
  Port Vasco has a north door and a south door and losing one is a
  detour rather than a siege.
- **Nothing is orphaned.** `pnpm citybake --check` reports no unreachable
  ground and one street network; block, building and shop counts are healthy
  (1,156 / 4,066 / 71).

Everything below assumes that, and is about what the map does *next*.

---

## 2. The findings, ranked by how much they change the game

> **§2.1, §2.2 and half of §2.3 are now fixed** — the plan's six offshore road
> endpoints are on land, Coast Road's middle 164 tiles are no longer authored
> out at sea, `maxBridgeSpan` is 96, the city is re-baked, and two new checks
> in `cityCheck.ts` make the failure impossible to repeat. `WORLDGEN.md` §44
> records what it cost and what it bought. The findings below are left as they
> were written, because what they say about *why nothing noticed* is the more
> useful half.

### 2.1 The strait has two crossings and both of them are in the far west

This is the big one. The plan authors **three** crossings of the strait —
`Kelvin Bridge` (`city-plan.json:1300`), `Old Bridge`, `Marsh Causeway`
(`:1333`) — and WORLDGEN.md §12.3 states the design intent outright:
"Crossings, and there are eight of them, because on an archipelago the
question 'which bridge' is the interesting one."

The built city has **four** crossings, and of the strait's three, two do not
exist:

| Authored | In the built city | Why |
| --- | --- | --- |
| Old Bridge (x≈338) | **built**, 242-tile deck | — |
| The Ring, west leg (x≈276) | **built**, as two parallel spans (§2.9) | widest span 35 t |
| North Sound / South Sound Bridge | **built**, 177 / 182 t | widest span 45 t |
| **Kelvin Bridge** (x=452) | **gone** | its south endpoint `452,400` is **10 tiles out to sea** |
| **Marsh Causeway** (x≈569) | **gone** | its north endpoint `566,292` is **8 tiles out to sea**, and its widest span is 76 t |
| **The Ring, east leg** (x≈652) | **gone** | widest span 75 t, over `maxBridgeSpan` 72 |

Two different causes, and the first one is the interesting one. `layout.ts:2283`
reverts bridge tiles whose crossing is wider than `maxBridgeSpan` (72,
`city-plan.json:6`), and the whole-deck pass just below it — added by §23.1
after Kelvin Bridge left the bank and stopped fourteen tiles short of the far
shore — deletes any deck that **lands in fewer than two places**. Both rules
are right, and the second one is doing exactly its job here: **the plan draws
Kelvin Bridge and Marsh Causeway ending in open water**, so their decks can
only ever land on one bank. Six of the plan's 32 road endpoints are in the sea
(`Kelvin Bridge` end 10 t out, `Marsh Causeway` start 8 t, `Coast Road` end
11 t, `Vasco Avenue` start 3 t, `Dockside` end 2 t, `Airfield Road` end 1 t) —
and nothing in `plan.ts` checks for it, so a drawing error that deletes a named
crossing passes validation silently.

Verified, by re-running `buildLayout` over an edited plan:

| Change | Decks that come back |
| --- | --- |
| Kelvin Bridge end → `452,414`, Marsh Causeway start → `566,272` (cap unchanged) | **Kelvin Bridge** (214-tile deck at `451,387`) |
| `maxBridgeSpan` 72 → 84, plan unchanged | **The Ring's east leg** (`648,343` + `640,345`) |
| Both, with the cap at 96 | **all three** — Marsh Causeway lands too (373-tile deck at `568,325`) |

96 is not a novel number: it is `plangen`'s own default (`plangen.ts:310`). At
108 an extra deck appears across the lagoon mouth at `560,669`, which may or
may not be wanted. None of this has been baked or committed — changing the
shipped city is a separate decision from reviewing it.

Measured on the road net (`map.roadNet`, `sim/roadnet.ts`):

- Exactly **6 of 1,498 edges** carry a bridge tile. Three of them join the
  north and south landmasses, and their anchor points are at x = 276, 276 and
  338. The map is 768 tiles wide.
- **From x≈340 to the east edge — 56% of the map's width — there is no way
  across the strait.** `evidence/mapdesign-strait.png` is that fact in one
  picture: everything right of the Old Bridge is open water bank to bank.
- The cost, over landmark pairs: detour factor **p50 ×1.60, p90 ×2.49**, and
  the tail is brutal — Market Square → Seaview Infirmary is 203 tiles apart
  and **1,034 tiles to drive (×5.1)**; the worst spawn-to-shop pair measured
  ×8.6. The route out of the Old Quarter runs the entire width of downtown,
  over the Old Bridge, and back east along the whole south bank.

Why it matters more than the ratio suggests: the east end of the strait is
where the map's two densest, most characterful districts face each other
across the water (Old Quarter ↔ Beachfront). That confrontation is the best
thing on the map and the player can never make the short trip. Police chases,
too: a two-crossing city where both crossings are 60 tiles apart is not "an
archipelago where the question is which bridge" — it is one bridge with a
spare.

**What I would do**, cheapest first:

1. **Put the six endpoints on land** in `city-plan.json`, and add the check
   that would have caught them: `plan.ts` already refuses a landmark off the
   map and a road wider than `MAX_CARRIAGEWAY`; "a road may not begin or end
   in the sea" is the same kind of rule and one loop long.
2. **Raise `maxBridgeSpan` to 96** and re-bake, which brings back the ring and
   the causeway. If long decks are unwanted, move the causeway's abutment onto
   the Old Quarter's harbour point instead and leave the cap alone.
3. **Make the checker able to see this at all.** `cityCheck.ts` validates that
   one street network exists — true, via the west — and so it cannot notice
   that a named crossing has vanished. The check with teeth is: **every
   authored road must reach both of its endpoints in the built city**, failing
   the bake when a crossing is silently deleted. That is what turns this from
   "found by flying over it a year later" into "the bake refused".

### 2.2 The Ring is not a ring

`The Ring` (`city-plan.json:1110`) is a 1,607-tile closed loop around the
whole archipelago — the single strongest line on the map, and from above the
first thing the eye follows. In the built city it is a **C**: it crosses the
strait on the west leg and is cut on the east (`x=652`, tiles read
`ROAD×50 … WATER×75 … ROAD×90`).

So the map's signature orbital road cannot be orbited. Every ring trip either
U-turns or dives through the city centre. For a GTA map this is a real loss:
the ring is the "get across town fast, at speed, with no junctions" road —
the thing a chase escalates onto — and half of it is a cul-de-sac at each
end. Same fix as §2.1.

### 2.3 Eleven roads end at the water, and three of them are amputated bridges

26 junctions on the road net are dead ends; **11 of them are within six tiles
of open water**. Three are the stumps of §2.1: `565,275` (Marsh Causeway's
north end, which starts in the sea), `455,361` / `470,367` (Kelvin Bridge's
approach, which runs 74 tiles south out of downtown, crosses an empty
headland, and stops on a beach), `632,308` and `665,471` (the ring's east
legs).

None of them is a safety bug — the quay pass puts a bank between tarmac and
sea, and `citybake --check` reports zero "road tiles run straight into water".
They are a *legibility* bug. A player learns a city by learning that roads go
somewhere; five roads that confidently leave a district and end on a beach
teach the opposite, and the Kelvin approach in particular is a 74-tile
commitment before the payoff turns out not to exist
(`evidence/mapdesign-headland.png`, the straight line down the middle).

Whatever happens to `maxBridgeSpan`, the stub prune should follow a deleted
deck all the way back to the last junction that still has a reason to exist.

> **§2.4 is now fixed.** The headland carries Bridgefoot and Kelvin Quay — a
> commercial strip and the north bank's only working waterfront — with Quay Road
> along the water. Bare ground there fell from 4,401 tiles to 2,076, and the
> 3,577-tile patch is gone. `WORLDGEN.md` §47.

### 2.4 The best waterfront in the city is an empty field

`evidence/mapdesign-headland.png`. Directly south of The Spine — downtown,
the densest fabric on the map — is a **3,577-tile bare patch centred on
495,333**: a headland with a mile of south-facing water frontage, looking
across at the south bank, and it is grass. One road crosses it (the Kelvin
stub). No block, no building, no shop, no prop.

The cause is authoring, not code: The Spine's polygon stops at y=312
(`city-plan.json`, bbox `424,120..558,312`), and the §14.3 fringe fill hands
the leftover land the *label* `downtown` while no street pass ever touches it.
**9.1% of the city's dry land lies outside every authored district polygon**,
and 58% of that land is bare field.

Some of that fringe is deliberate and good (Marsh End's flats, the
countryside the ring runs through). This piece is not: it is the single most
valuable parcel on the map — waterfront, adjacent to downtown, opposite the
other bank — and it is the *only* piece of the north bank a player has no
reason to visit. Docks, a container terminal, a stadium, a heliport, a marina,
anything. It is also, not coincidentally, exactly where Kelvin Bridge would
land.

Two other bare patches worth a look: 2,936 tiles at `497,43` (north of
Ravenhill Park, at the map edge — probably fine) and 2,496 tiles at `456,637`
(Marsh End, deliberate countryside).

> **§2.5 is now fixed.** Manors are authored one per gang in `worldgen.json`
> and grown outward over dry land, water belongs to nobody, and the land spread
> between the biggest and smallest manor is 1.87× rather than 9.5×.
> `WORLDGEN.md` §45 has the numbers; `pnpm mapgen --turf` draws it.

### 2.5 Gang territory is drawn without ever looking at the map

`turf.ts:22` partitions the city by Voronoi over **the whole 768×768 square**
— seven home points on a staggered ring, 64×64 cells of 12 tiles. It has
never heard of the coastline, the boroughs, the districts or the roads. The
comment defends contiguity ("territory has to be contiguous to read as
territory"), which is right, and then the partition is applied to a map that
is **49.7% water**.

Measured per gang (land tiles inside its cells, and which boroughs those cells
touch):

| Gang | Cells | Dry | Land tiles | Boroughs it straddles |
| --- | --- | --- | --- | --- |
| 7 | 801 | 67% | 77,517 | Ravenhill, Kelvin, Sunridge |
| 2 | 573 | 84% | 69,026 | Sunridge, Port Vasco, Gannet Rock, Marsh End |
| 6 | 448 | 73% | 46,810 | Ravenhill, Sunridge |
| 4 | 538 | 46% | 35,573 | Port Vasco, Ravenhill, Sunridge, Gannet Rock |
| 1 | 525 | 42% | 32,006 | Kelvin, Sunridge, Marsh End |
| 3 | 719 | 27% | 27,792 | Marsh End, Gannet Rock, Sunridge |
| **5** | 492 | **12%** | **8,202** | Ravenhill, Port Vasco |

Gang 7 has **9.5× the ground** of gang 5, whose manor is seven-eighths open
sea. Every gang straddles two to four boroughs, and every borough is split
between two to four gangs — so the one property a player can actually read off
the map (this is the Old Quarter; those are the docks) carries no information
about whose turf they are standing in, and vice versa.

This is the highest-leverage fix in the review, because the map has *already
done the work*: the plan has six boroughs and sixteen districts with names,
polygons and characters. Seed the Voronoi from **borough centroids over dry
land only**, or assign each gang a set of districts outright, and territory
becomes something you learn by looking out of the windscreen. It costs one
function and no rng draws (turf already consumes none, so replays are safe).

> **§2.6 is now fixed** for the spawn half: every island with a shop on it is
> seated a spawn before the rest are sampled, and Port Vasco takes 1–2 of 16 on
> every seed measured. `WORLDGEN.md` §46.1. The redundancy point — two bridges
> carrying an eighth of the city — stands.

### 2.6 Port Vasco is a whole island the player almost never starts on

Port Vasco holds **11% of the city's dry land** (32,281 tiles), 22 shops,
376 buildings, and five landmarks including Ironside Stadium, Kessler Power,
Greyhill Quarry and its own precinct and infirmary. It is the most distinct
place on the map — long north-south dock blocks, a 12° housing grid, nothing
else like it.

Across eight seeds it receives **0–2 of 16 player spawns** (mean ≈ 0.6, about
4%). The cause is in `amenities.ts:783-800`: spawns need a `downtown`,
`commercial` or `residential` district *and* a street density ≥16 in a 7×7
box. Port Vasco is two industrial districts plus one small residential one
(Vasco Heights, 4,976 tiles), so it barely offers candidates — and the min
distance sampler then spends its 16 picks where the candidates are.

The intent behind that filter is right ("one player in five started on a dock
road with no traffic… a bad first thirty seconds"). The result is that an
island's worth of authored content sits behind two bridges that nobody is put
next to. A per-borough spawn quota — at least one spawn on every landmass
that has a shop on it — costs very little and turns Port Vasco from scenery
into a place people start their session.

The same island is also the one with the least redundancy: cut both sound
bridges and 11% of the city goes with them. (No *single* edge disconnects
anything: the cut-edge analysis finds 49 cut edges and none isolates as many
as 20 junctions. Two-edge-connected, but only just.)

> **§2.7 is now fixed for downtown.** The Spine's pitch went 15×12 → 26×21:
> inside it, road share 41.2% → 31.5% and building 16.1% → **33.2%**, with
> merged tarmac falling citywide. Exchange Square is the plaza it never had.
> `WORLDGEN.md` §48.4. The other districts are untouched and the citywide
> figure is 32.4% road against 16.4% building.

### 2.7 The city is more asphalt than city

From `citybake --check`: of dry land, **road 32.9%, building 14.8%, bare
12.7%**. A third of every landmass is carriageway, and buildings occupy less
than half what the roads do. It is visible from above as the dominant
impression of the whole map — a grey mesh with coloured confetti in the holes
(`evidence/mapdesign-city.png`).

Underneath it is block size. Median block area is **110 tiles** (≈10×11), and
the road graph has **765 junctions in 1,498 edges** — a junction roughly every
twelve tiles. The knock-on effects are all gameplay:

- A chase has an escape option every twelve tiles, so pursuit never builds
  pressure; the police can't ever be committed to the wrong street.
- Nothing is *far* in a way you can feel, so the map's real distances (which
  are large, §2.1) come from detours rather than from geography.
- Buildings are small (`downtown` footprint p50 = 8 tiles) which is why
  downtown reads from above as bars around a green backland rather than as
  massing.

The plan already carries the dial: `pitchX/pitchY` per district. The Spine is
15×12; the Old Quarter is 11×9. Widening the downtown and commercial pitches
(say 22×18) and letting the fill push building coverage up would move road
share toward 25% without touching a line of layout code. §28.3 already
measured the lattice-merging ceiling from the other side; this is the same
number read as a design brief.

> **The skyline half of §2.8 is now fixed**: downtown is 6–18 storeys and the
> named towers are a 24-storey shaft over an 8-storey podium, inside the
> renderers' existing overhang budget. `WORLDGEN.md` §46.2. The orientation
> half — half the city's streets pointing the same way — stands.

### 2.8 One orientation, and one skyline

Bearing census over road tiles: **42.9% at 0°** and another 4.7% at 90° — so
nearly half the city's streets are screen-aligned, with 20° (Old Quarter),
26° (North Point), 12° (Vasco) and the two contour fabrics carrying the rest.
The docs know this is the failure mode they were fixing (§13); from above it
is still the dominant read, because the two biggest districts (Ravenhill,
The Spine) are both at 0° and adjacent.

Vertically it is flatter still. `heights.ts:24` gives `downtown [4,12]`,
`commercial [2,6]`, `industrial [1,3]`, `residential [1,3]`; measured, the
whole city is p50 = 3 storeys, p90 = 5, max 10. Downtown is *three storeys*
taller than the suburbs on average. From straight down that costs nothing;
from the pitch-42 camera the game is actually played at, it costs the city its
skyline and costs the player the single most useful navigation aid a GTA map
has — "drive toward the tall thing". The three towers (Vantage, The Spire,
Halloran) are the right idea and want to be two or three times the height of
anything near them, plus a genuine height gradient from the spine outward.

### 2.9 Smaller things a designer would flag

- **Four islets with nothing on them.** The unnamed islands (1,153 / 1,098 /
  958 / 735 tiles — big enough for a farmhouse each) carry zero packages, zero
  pickups, zero props. There are 460 boat spawns and 400 hidden packages in
  the city; not one package is on an islet. Free reward-for-exploration.
- **Two squares and one green for a city this size.** Nearest-square distance
  is p50 174 t / p95 400 t. A public square is a landmark, a chase arena and a
  frenzy stage all at once; the map has King's Circus, Market Square, Parade
  Ground and Chapel Green and could carry twice that.
- **Amenity spread is fine but thin at the edges**: nearest police p50 96 t /
  p95 180 t, nearest hospital p50 103 t / p95 193 t. The p95s are all in
  Marsh End and on the spit — a country police post east of the airfield
  would close the worst of it.
- **The ring crosses the strait as two parallel bridges** 7 tiles apart
  (spans at `272,360` and `279,363`), because the ring's west leg saw-tooths
  between x=268 and x=286 (`city-plan.json:1110`, points `[286,322] [268,392]
  [286,462]`). It reads from above as an accidental dual carriageway. Harmless,
  probably worth straightening into one deck.
- **`vehicleSpawns` and `parkingSpots` are 1,469 points each and 909 of those
  positions are identical.** Not a map-design finding as such, but from above
  it is why parked traffic and moving traffic bunch on the same kerbs.

---

## 3. If I could only change three things

1. **Restore the eastern crossings** (§2.1, §2.2, §2.3): six road endpoints
   out of the water, `maxBridgeSpan` 72 → 96, re-bake. Measured, that is the
   whole fix. Then add the "every authored road reaches both of its ends"
   check so it can never silently regress again.
2. **Give the gangs the boroughs** (§2.5). Territory that matches the city the
   player can see, instead of a Voronoi over the sea.
3. **Build the headland and widen the blocks** (§2.4, §2.7). One is authoring
   in the plan, the other is four numbers in it; between them they fix the
   "grey mesh, empty middles" impression the map gives from above.

---

## 4. How the numbers were taken

All from a scratch script over `generateCity(1, loadWorldgenParams())` — the
same call `pnpm mapgen` makes — plus `pnpm citybake --check` and
`pnpm mapgen --stats`:

- **Tile budget / land share**: histogram of `map.tiles`.
- **Islands**: 4-connected flood over non-water; run again excluding
  `T_BRIDGE` to separate the true islands from the bridged whole.
- **Crossings**: every `roadNet` edge whose `pathTiles` include a `T_BRIDGE`.
- **Cut edges**: iterative DFS low-link over the junction graph; subtree size
  measured per cut edge.
- **Detours**: Dijkstra over `edgeCost` (tiles) between landmark centres and
  between spawn/shop points, against straight-line distance.
- **Dead ends at the water**: degree-1 junctions with a `T_WATER` tile inside
  a 6-tile box.
- **Unauthored land**: dry tiles failing `pointInPoly` against every district
  polygon in `city-plan.json`.
- **Turf**: `map.turfCells` (64×64 of 12 tiles), dry fraction per cell and the
  borough of each cell centre.
- **Spawn distribution**: `map.playerSpawns` bucketed by island, seeds
  1, 2, 3, 7, 11, 42, 99, 500.
- **Water spans and endpoints**: the four-axis run `layout.ts:2250` measures,
  taken over each authored crossing's centreline; endpoint depth by ring
  search out from the endpoint tile.
- **The bridge experiment (§2.1)**: `buildLayout(parseCityPlan({...raw, roads,
  maxBridgeSpan}))` with the endpoints edited, counting 8-connected `T_BRIDGE`
  components of 20 tiles or more. Layout only — no bake, nothing committed.

---

## 3. The junctions, evaluated

Asked for separately, after the waves: what is at a junction in this city, and
what is missing. Measured over `generateCity(1)` — **779 junctions**.

> **All six findings below were then fixed** (WORLDGEN.md §50), so this
> section is the evaluation as it stood, kept for the record; the "now" column
> is what the same census says afterwards, and §3.3 is what was done. The two
> pictures have been retaken against the fixed city, so they no longer show
> what §3.1 describes — that is the point of them.

| | measured | now (§50) |
| --- | --- | --- |
| junctions | 779 | **725** — one crossroads is one junction, and downtown's avenue crossings are junctions at all |
| signal heads | **2,990** — every junction is signalised, including all 537 that are 4 tiles or smaller | **561**, at 144 arterial crossings |
| junction footprint | p50 **2 tiles**, p90 17, max 20 | p50 7, p90 20, max 49 |
| zebra crossings | **21 approach tiles in the entire city** | **435 arms** |
| stop lines | **9** — the same rule as the zebras, but the line covers only the approaching half, so fewer tiles take paint | **435** — still one rule, a better one |
| turn arrows | none | **538** |
| kerb radii | **0**; every corner is a right angle | **3,160** |
| bevels, total | 1,312 | 4,472 |
| props within 3 tiles of a junction | 252 of 1,600 (164 lamps) | the props did not move, but the junctions did, so the statistic does — 229 → 285 on a 3-tile Chebyshev rule |
| road-net node degree | 32 dead ends, 101 of degree 2, 190 three-way, 225 four-way — and 231 more of degree 5 or above, 30% of the graph | 725 nodes; detours p50 ×1.48→**×1.29**, p90 ×1.94→**×1.68** |

`evidence/mapdesign-junction.png` is a signalised crossroads at 44 px per
tile, and `evidence/mapdesign-junction-3d.png` is the same one from the
flyover — the first picture in this repo with a traffic light in it (§3.2).

### 3.1 What is missing, ranked — and what was done

1. **Crossings and stop lines are effectively absent.** About 761 of the 779
   junctions carry traffic lights and nothing for the traffic to stop at (the
   21 zebra tiles sit at roughly eighteen places). The junction
   this was measured at had signals on four arms and a zebra on **one**, which
   reads worse than none at all. The §35 filters exist for good reasons — each one
   was added against a real defect, from zebras stacked in merged tarmac to
   crossings painted into the ring road's stair steps — but together they have
   overshot: the city has 21.
2. **No kerb radius anywhere.** Every junction corner is square, so a turning
   car clips pavement. Not one of the plane's 1,312 bevels lies against a
   junction corner. (An earlier draft of this line said every bevel was
   shoreline, which is wrong and §50.4 contradicts it: 770 of the 1,312 are
   §15's diagonal-avenue kerbs. The true claim is the narrower one.)
3. **Signals on junctions that should not have them.** 361 of the 779
   junctions are a SINGLE tile and 53% are two or fewer — a residential corner
   — and all 537 of the four-tiles-or-fewer ones are signalised. The phase logic is running on corners.
4. **Nothing inside the junction box.** No keep-clear, no turn arrows, no
   give-way. "A junction is bare asphalt" is a rule written to stop the ribbon
   dashing straight through a crossing; it was never followed by a rule that
   says what a junction *does* carry.
5. **The 17-20 tile junctions** at p90 are §28.3's merged sheets, experienced
   as a place you drive through rather than measured as a statistic.

### 3.2 And a fourth instrument gap

`city3d.html?fly=1` — the camera every evidence shot in this repo is taken
with, including both outside reviews — builds `CityView`, `SceneryLayer` and
the painted ground, and **never constructs `WorldObjectsLayer`**. That is the
layer which draws traffic signals, pickups and hidden packages
(`client/src/main.ts:56` is its only caller). So no flyover picture ever taken
here has shown a signal head, and the junctions look barer in every one of them
than they are in play.

Items 1-5 are the city. "No signals visible" is the camera, and the flyover
should build that layer so the evidence stops understating the city a third
time (§49 was the second).

### 3.3 What was done about all six

Fixed in WORLDGEN.md §50, in the order they are ranked above.

1. **Crossings and stop lines** come off the curves now, not the tile plane —
   the arms of a course crossing, turned into quads both renderers fill. 21
   approach tiles became **435 arms with a stop line and a zebra each**, and
   they are drawn on ribbon-covered carriageway and on diagonal arterials,
   neither of which the tile path could ever reach.
2. **Kerb radii**: a fourth bevel phase cuts the sidewalk corner into the
   carriageway wherever the diagonal neighbour is junction tarmac — **3,160**
   corners, and a driveway mouth still square.
3. **Signal policy**: lights only where an arterial crossing lands, **144
   junctions and 561 heads** against 779 and 2,990. The rest are negotiated,
   which is what the plazas already were.
4. **Inside the box**: **538 turn arrows**, one per approach lane, hooked left
   or right by the arms the junction actually has.
5. **The merged sheets** are still merged sheets — that is a plan-shape
   finding, not a paint one — but they no longer collect furniture. Not
   because a plaza is left unsignalised, as this line first claimed (that
   filter rejects none of the 151 arterial crossings on the shipped city), but
   because an arm with no room for the paint, and a crossing with more than
   four arms, are both left bare: 95 arms and 24 arms respectively.
6. **The camera** builds `WorldObjectsLayer`, and `?tick=` freezes the phase so
   two stills of one junction can be compared. `ci/shot.mjs` grew
   `SHOT_TIMEOUT` and `WAIT_MS` while retaking the two 3D pictures: at
   `?h=2400` the flyover paints a screen at a fifth of a frame a second, which
   is slower than Playwright's default screenshot timeout, and a shot that
   times out writes a black PNG rather than failing.

And two things found on the way, both worse than any of the six.

A crossroads was routinely labelled as **two junctions**, with two independent
signal phases — 47 of the 82 lit crossings split in two, 7 in four. It could
show green to both axes at once.

And **69 of the city's 151 arterial crossings were not junctions at all**:
`isJunctionTile` wants tarmac that is over-wide along both diagonals too, and
a four-tile avenue crossing a three-tile street is 4×3, whose diagonal run is
three — no id, no light, no crossing, and no node in the routing graph. 32 of
the 69 stand on downtown ground. Fixing it moved landmark-to-landmark detours
from p90 ×1.94 to ×1.68. Both are §50.2.

---

## 5. Three reviews of the junction work, and what they cost

§3's fixes were reviewed by three independent passes — one over the diff, one
over the rendered city, one re-measuring every number the write-up quoted. They
are worth recording together, because the failures they found were of three
different kinds and only one kind was a bug in the sense of a wrong line.

**The code review found the claim was false.** §50's commit said merging split
junctions made "green to both axes at once" impossible. It measured 17
crossroads where it was still possible, 12 tiles carrying signal heads of two
different junctions, and — the one nobody had looked for — zebra stripes
painted on open water at (383,472). Also that the 3D layer, under a comment
claiming it drew the same crossings as everyone else, drew a complete crossing
at 46 of 151.

**The design review found the paint and the traffic disagreed.** The stop line
is drawn about a tile and a half outside the junction; the driver model stopped
6px short of the junction. So the median AI driver came to rest past its own
stop line and **261 of 441 approaches parked their queue on the crossing**. No
test could see it, because no test asked the two systems the same question.

**The number audit found the write-up was measured wrong.** Fourteen figures
disagreed, and most shared one cause: numbers taken partway through the change
and quoted as before- or after-values. The detour figures, the stop-line count,
the district attribution, the traffic-test holds. All corrected in `edb32b8`.

All of it is fixed in WORLDGEN.md §51, and the numbers below are that section's.

| | before §51 | after |
| --- | --- | --- |
| crossroads that could show green to both axes | 17 | **0** |
| approaches whose queue rests on the crossing | 261 of 441 | **0** — every one now stops a quarter tile behind its line |
| junction paint off the carriageway | 36 tile centres of 1,103 | **5 of 1,022**, all kerb band, none water, wall or deck |
| crossings drawn complete in 3D | 46 of 151 | **all of them** |
| junctions with no marking of any kind | 4 in 5 | give way on 524 crossings, 2,973 marks |
| turn-arrow hooks over the kerb | 135 of 207 | **6 of 338** |
| signal posts on the carriageway | 398 of 561 | **156 of 457** |
| `T_RAMP` tiles rendered magenta | 224 | **0** |

One reviewer claim did not survive checking: that the 3D evidence is a
different city from the 2D because one defaults to seed 7 and the other to seed
1. The city is baked — the two differ in 433 tiles of 589,824, none of them at
a junction, and in zero junction ids.

The lesson worth keeping is not any of the individual defects. It is that
**§50 was reviewed by its own author against its own definitions**, and every
one of these was a place where two systems each held a definition and nobody
had asked them the same question. The reviewers were not smarter; they were
outside.
