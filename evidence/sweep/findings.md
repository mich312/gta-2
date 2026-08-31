# Stratified visual sweep of the shipped map

Measured on **`7bbee6f`** (`claude/loop-driven-agent-approach-tgnfpj`), seed 1,
working tree clean. Every crop in this directory was produced by
`node server/dist/tools/mapgen.js`; every number by
`node evidence/sweep/measure.mjs`, which recomputes its own staging from the
bake rather than hard-coding counts.

The six `citybake --check` warn lines (The Ring ×2, Marsh Causeway, Coast Road
×3) are escalations, not defects, and are not re-filed here. Nor are R1-A01's
capped ring carriageways at the eastern strait, which I re-saw at
`evidence/sweep/49b-ring-east-north.png` and left alone.

---

## Bridge decks: the rasterised deck sticks a whole tile out past the carriageway it carries, in a regular sawtooth
severity: significant
lens: sweep
where: `evidence/sweep/53-southsound-deck.png` (South Sound Bridge, tiles 163,468–189,494)

evidence:
`node server/dist/tools/mapgen.js --crop=163,468,26 --scale=29 --out=evidence/sweep/53-southsound-deck.png`
The painted carriageway — kerb line, centre dash, both edges straight — runs
down the middle of a band of deck tiles that is one tile wider than it on
BOTH sides, and the overhang is a crenellation: a square tooth every 3–4
tiles, the whole length of the crossing. `measure.mjs` prints the first deck
tile per row: x = 160, 164, 167, 171, 175, 179, 182, 186, 190, 193, 197 for
y = 473…483 — a tread of 3–4 tiles per step. 22 tiles in that box carry a
bevel, and a half-tile chamfer on a 4-tile tread changes nothing.

repro: the command above, plus `node evidence/sweep/measure.mjs` (section 2).
Wider context: `--crop=130,455,60 --scale=13` (`52-southsound.png`); the same
sawtooth is on the Coast Road's bay crossing, `--crop=600,590,110 --scale=7`
(`24-spit.png`).

why it matters: this is the most conspicuous edge left in the city and it is
on the four things a player crosses most. In the client `paintBridge`
(`client/src/render/tiles.ts:1751-1771`) surfaces those overhang tiles as road
and draws the parapet on any tile edge with open water across it — so what the
player sees is a **parapet that zigzags a full tile away from the kerb line
it is supposed to sit on**. (mapgen fills the overhang in the kerb colour,
which exaggerates the contrast but not the geometry.)

**the signature** — this is the part worth building a detector for.
§15/§31's bevel removes a staircase only when the **tread is one tile**. Tread
length is set by the edge's angle: a 45° line steps every tile and bevels
perfectly; a 15° line steps every 4 tiles and a half-tile chamfer is invisible
against it. So the rule is not "is this edge bevelled" but *"what is the tread
length along this built boundary, and is the bevel able to reach it"* — and it
predicts the same defect anywhere else a built material meets water or field
at a shallow angle (quays, the runway aprons, the ring's shave line), not just
on bridges. §31 measured its own success on the 45° case and reported
DELIVERED; the shallow decks are where it did not land.

prior art: WORLDGEN.md §31 (bevelled `[T_WATER, T_BRIDGE]`, "a 45° causeway
crossing a smooth waterline as a flight of stairs"), §15.2 ("phase 1 cuts that
side and the whole staircase becomes one continuous diagonal" — stated for a
rasterised 45° line). Neither records the shallow-angle case. The overhang
itself is acknowledged in one sentence with the wrong magnitude:
`client/src/render/tiles.ts:1961`, "the rasterised band overhangs the stroke
by up to half a tile" — here it is a full tile.

---

## Two districts are effectively outside the vector road layer: The Spine has 4 courses for 9,739 carriageway tiles
severity: significant
lens: sweep
where: `evidence/sweep/30-spine.png` against `evidence/sweep/31-oldquarter.png`

evidence:
`node server/dist/tools/mapgen.js --crop=452,200,48 --scale=16 --out=evidence/sweep/30-spine.png`
`node server/dist/tools/mapgen.js --crop=600,200,48 --scale=16 --out=evidence/sweep/31-oldquarter.png`
Two downtown districts of the same borough, 150 tiles apart. Old Quarter has
kerb casings, edge lines, centre dashes and rounded cul-de-sac caps on every
street. The Spine has one painted street in the whole crop (Vantage Row) and
bare tarmac everywhere else. `measure.mjs` gives the reason as a per-district
census:

```
district           road  covered  courses
The Spine          9739   27.0%        4
Old Suburbs        6233   32.8%       10
--- for comparison ---
Old Quarter       11424   95.5%       55
Ravenhill         19229   89.7%       56
The Terraces      10912   88.0%       52
New Suburbs        8126   94.1%       29
```

repro: the two commands above and `node evidence/sweep/measure.mjs` (section 1).
Old Suburbs the same way: `--crop=250,545,48 --scale=16` (`32-oldsuburbs.png`)
— the Ring sweeps through fully painted and every local street beside it is
bare.

why it matters: whatever the intent, these two districts are the only ones in
the city whose streets are not described by the layer that makes a street look
like a street. Every wave from §16 to §42 — kerb casing, junction punch-out,
lane markings, the follower, the diagonal kerb bevel — is keyed on `courses`,
so all of it silently skips a quarter of Kelvin's downtown and a third of
Sunridge's oldest suburb.

**the signature.** §26.1 states the coverage as one city-wide number, 76.1%,
and explains the deficit as "junction box and merged sheet, which SHOULD be
bare". A city-wide average is exactly the wrong statistic here: it averages
27% and 95.5% into a number that looks like a uniform 24% of junction boxes.
The detector to build is not "what fraction of carriageway is covered" but
**"is coverage uniform across districts, and which district is the outlier"** —
the same argument applies to any other per-tile quantity the docs report as a
single percentage.

prior art: WORLDGEN.md §26.1 (the 76.1% figure and its explanation);
§19.4 records `trimCourses` dropping "a course that wavers off its own
carriageway". Neither records that the loss is concentrated in two districts.

**caution for anyone building a tool on mapgen**: mapgen implements only the
ribbon marking system. The client has a second one — `paintRoad` falls through
to `paintLaneMarks` for any tile not under a course
(`client/src/render/tiles.ts:1962`) — which mapgen does not mirror. So bare
tarmac in a mapgen crop is evidence of a missing *course*, never of a missing
*marking*. This is the largest false-positive trap on the map: 21.5% of all
carriageway, ~21,600 tiles.

---

## Gannet Rock's woodland is cut by a ruler-straight bare corridor from the north coast to the airstrip
severity: significant
lens: sweep
where: `evidence/sweep/22b-gannet-corridor.png` (tiles 86,598–146,658)

evidence:
`node server/dist/tools/mapgen.js --crop=86,598,60 --scale=13 --out=evidence/sweep/22b-gannet-corridor.png`
A dead-straight avenue of bare ground, 5–6 tiles wide, runs ~46 tiles through
the island's wood from the north shore to the east end of the airstrip. The
tree line on both sides is razor straight for its whole length; nothing is in
it. `measure.mjs` section 3 prints the cross-section at x=100..118:

```
  y=606 TTTTTTTTFFFFTTTTTTT
  y=618 TTTTTTFFFFFFTTTTTTT
  y=630 TTTTTTTFFFFFTTTTTTT
  y=642 RRRRRRFFFFFFTTTTTTT     <- the runway ends where the corridor begins
```

repro: the command above; whole island at `--crop=60,600,120 --scale=6`
(`22-gannet.png`).

why it matters: the island's entire premise (WORLDGEN.md §12.9) is that it is
wild and roadless — "cliff the whole way round… the strip on top is the only
way in and the only way out", and §14.6 calls it "deliberately trackless".
What ships is a wood with a road-shaped clearing through it and no road in the
clearing. Nothing else on the island is straight; this reads as a bug the
moment you fly over it, and it is 46 tiles long on an island 100 tiles across.

**the signature.** Gannet Rock's district carries a 60×60 street lattice at
width 2 (`city-plan.json`) and 0 carriageway tiles ship. Both places that
delete carriageway — the ring shave at `layout.ts:2249` and the orphan prune
at `layout.ts:2687` — write `T_FIELD`, i.e. **the removal restores the ground
but not the woodland the carve cleared to make room**. So the general rule is:
wherever a pass deletes road, look for the clearance it was carved in still
standing. It is a class no road-shaped detector can see, because after the
prune there is no road there to inspect — the evidence is in the *negative
space* of a natural material.
(Mechanism stated as inference: I matched the corridor to the district's
lattice pitch and to the `T_FIELD` writes, I did not instrument the bake.)

prior art: WORLDGEN.md §12.9 names "a lane cleared through the scrub" as one
of three passes that opened the cliff by accident, and fixes the cliff seal —
not the clearing. The corridor is recorded nowhere.

---

## nit — the headland every driver crosses leaving Kelvin Bridge is a fifth tarmac and has not one building on it
severity: nit
lens: sweep
where: `evidence/sweep/16-headland-close.png`, `evidence/sweep/15-spine-headland.png`

evidence:
`node server/dist/tools/mapgen.js --crop=452,330,50 --scale=15 --out=evidence/sweep/16-headland-close.png`
`node server/dist/tools/mapgen.js --crop=436,326,96 --scale=8 --out=evidence/sweep/15-spine-headland.png`
Broad wandering ribbons of tarmac lie across the empty headland between The
Spine's southern edge and the strait. `measure.mjs` section 4: over tiles
440–560 × 313–364, land 4,768 tiles, carriageway 958 (**20.1%**), building
tiles **0**. For scale, Ravenhill's dense core measures 40.7% road and Old
Suburbs 32.4% — this uninhabited headland is half as paved as a borough and
serves nothing at all. It also has no courses, so nothing on it curves: the
ribbons are raw staircase raster (`--tiles` gives the same picture,
`15b-spine-headland-tiles.png`).

repro: the two commands above, `node evidence/sweep/measure.mjs`.

why it matters: it is not an out-of-the-way corner. It is the ground on the
north side of Kelvin Bridge, so it is what a player sees first every time they
drive between the two halves of the city — a road network with no destination.

**the signature**: the fringe/smallholding pass (§14.6 D5) places buildings
only "within its own district's pitch of town", and this headland lies outside
every district polygon, so it gets lanes and never gets anything to serve.
The check is *road density against building count per contiguous
outside-every-polygon region* — high road, zero buildings is the tell.
6,118 carriageway tiles city-wide lie outside every district polygon.

prior art: WORLDGEN.md §13.4/§14.6 describe the rural fabric and the fringe.
No section records that the land outside every polygon gets lanes and no
fringe.

---

## nit — a 12-tile street with a rounded cap at each end, and one house, on an islet reached by driving off the side of Kelvin Bridge
severity: nit
lens: sweep
where: `evidence/sweep/16-headland-close.png` (the capsule at tiles 468–471, 357–374)

evidence:
`node server/dist/tools/mapgen.js --crop=452,330,50 --scale=15 --out=evidence/sweep/16-headland-close.png`
A fully-painted street — kerb outline, centre dash, a rounded cul-de-sac cap
at **both** ends — stands alone in the strait. `measure.mjs` section 5:
`kind=street width=3, (469.06,360.95) -> (468.86,372.61)`, 11.7 tiles, and one
3×2 building at 463,365. The islet it stands on is about 20×11 tiles of
sidewalk, lot and road at 453–473 × 364–374; its only connection to the map is
that its west edge abuts Kelvin Bridge's deck at x=453, so the way onto it is
to leave the bridge sideways at mid-span.

repro: the command above, `node evidence/sweep/measure.mjs` (section 5).

why it matters: a street with a turning head at each end, one house and no
junction is the clearest "road that goes nowhere" on the map, and it is
directly under the city's signature crossing where a player will see it every
time. It also means the bridge has an unmarked exit at mid-span.

**the signature**: a course whose *both* endpoints are dead ends and whose
length is under ~20 tiles is a street with no through route. Connectivity
checks miss it — the map's carriageway is a single 4-connected component
(100,685 tiles, verified) — because it is connected; it just has nowhere to
go. The graph question to ask is degree, not reachability.

prior art: none found. WORLDGEN.md §30.1/§30.2 deal with landmarks that landed
on the wrong ground; nothing records blocks or streets stamped onto strait
islets.

---

# Suspicions — measured to the point of interest and no further

These are **not** findings. Each costs the next round one cheap check.

1. **The Spine's and Old Suburbs' streets in-game.** With almost no courses,
   their paint must come from the per-tile system, which draws on the tile
   staircase rather than on a curve — the exact thing §15.4's kerb bevel and
   §16's ribbon exist to replace. If so they are the only two districts in the
   city whose kerbs stair-step, which would be player-visible. I could not
   check it: mapgen does not implement the per-tile painter and this box has
   no GPU for the client.
2. **Course ends inside a carriageway.** 23 of 692 course endpoints have
   uncovered carriageway continuing 3 and 5 tiles beyond them (probe in my
   working notes, not in `measure.mjs`). Concentrated at Ravenhill's south
   shore (x≈293/308/322, paint stops at y≈327, tiles run to y≈340) and around
   Marsh End. I did not check whether `trimCourses` is meant to do this.
3. **Countryside outside every polygon.** 6,118 carriageway tiles, 53.1%
   course-covered against 84–96% in most districts. I did not establish
   whether open-countryside lanes are supposed to carry courses at all.
4. **Gannet's east–west bare bands** at y≈637–639 and y≈647–649 flank the
   runway. I assumed runway clearance and did not verify; if they are lattice
   scars too, the corridor finding is one of three, not one.
5. **The shore stroke against thin spits.** At Ravenhill's south shore
   (285–330 × 336–350) the drawn coastline loops so tightly around a ragged
   isthmus that road tiles read as though they are seaward of their own
   waterline. I checked eight tiles against the shore rings and the winding
   agreed with the tile plane every time, so I dropped it — but I only checked
   eight, and only in one place.

---

# Coverage

**Looked at closely** (48–120 tile crops, `--scale` 6–29, plus `--tiles` and
`--net` where blockiness or purpose was in question):

- **Kelvin** — The Spine (452,200 and 424,300), Old Quarter (600,200),
  North Point (600,60), Ravenhill Park and Vantage Tower (470,60 / 480,82),
  the south headland (436,326 / 452,330), the eastern strait shore
  (616,286 / 616,376).
- **Ravenhill** — the core and the Ring's passage through it (300,160), the
  south shore and its street ends (280,300 / 286,316), the north coast (440,10).
- **Sunridge** — The Terraces (200,420 and 196,420), Beachfront (500,420),
  Old Suburbs (250,545), New Suburbs (in the quadrant pass), Sunridge Park
  and its ponds (300,640), Kelvin Bridge's south landfall (440,376).
- **Marsh End** — the airfield surrounds (480,600), the Ring × Coast Road
  crossing, the spit and the Coast Road's bay bridge (600,590 / 600,596),
  the Marsh Causeway site (545,280).
- **Port Vasco** — Vasco Heights (60,180), The Docks (30,240), The Foundry
  (60,440), both Sound Bridges (120,210 / 130,455 / 163,468).
- **Gannet Rock** — the whole island (60,600) and the corridor (86,598).
- **Whole-map orientation** — `00-whole.png` at scale 2 and four 384-tile
  quadrants at scale 3.

**Not looked at closely, and I make no claim about it:**

- The 3D client and the minimap. No GPU on this box; everything above is the
  2D top-down raster + curve layer as mapgen draws it, which is blind to the
  per-tile marking system (see the caution above).
- The interiors of blocks — courtyards, alleys, shop floors, garage doors.
- Anything that only exists at runtime: traffic, peds, lane following, parking
  spots, spawn points, collision. I read tiles and paint, not behaviour.
- New Suburbs' crescent fabric and The Docks' contour fabric at close range —
  I saw both only in quadrant crops at scale 3.
- Ravenhill's and North Point's northern coastlines beyond one crop each.
- Zebra crossings (§35) anywhere: mapgen does not draw them, so I could not
  tell a missing crossing from a tool that never draws one.
