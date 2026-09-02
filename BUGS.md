# BUGS — a play-test of the 3D renderer, and the repairs

A bug hunt against `main` at `2a9a990`, driving the real client with the
offline host (`?local=1`), the flyover (`/city3d.html?fly=1`) and a headless
`Session` in Node — followed by the fixes. Every finding below is **fixed**,
with a regression test named beside it and a picture in `evidence/`.

When the hunt started, all 757 tests passed. Nothing here was a regression a
test caught: these were places the 3D renderer and the simulation had never
been checked against each other, and the gaps were wide enough to see from the
pavement. There are now 776 tests, and the ones that matter are listed per
finding.

---

## §1 The root cause behind every geometry complaint

`shared/src/world/volume.ts` builds a **volume grid** — a stack of solid spans
per tile, with a `ground` height for each column. `shared/src/world/collide3.ts`
resolves movement against it. Both are careful, well-documented, and used by
nothing in the simulation:

```
$ grep -rn "buildVolumeGrid\|move3\|supportForBox" shared/src server/src client/src --include=*.ts
shared/src/index.ts:38:export * from './world/collide3.js';
client/src/three/cityGeometry.ts: … buildVolumeGrid, spansAt …
```

`step()` still collides on the flat tile grid in `shared/src/world/collide.ts`,
where a tile is solid or it is not and nothing has a height. Ground vehicles
are pinned to `z = 0` (`vehicle.ts:633`); pedestrians and players never leave
it. Only aircraft carry altitude.

So the 3D city was modelled from a height field the game does not believe in.

**The repair** is a single named function, `drawnSpans` in
`client/src/three/cityGeometry.ts`, which reconciles the two: the surfaces the
simulation walks on at zero are drawn at zero, and everything that is solid or
unreachable — buildings, canopy, the kerb, the water — keeps the volume the
grid gives it. It is deliberately one function, and deleting it is the change
to make when the sim does adopt `collide3`.

---

## §2 Terrain

### 2.1 Bridges were drawn 46 px above the road they join — FIXED

`evidence/bug-bridge-deck.png` → `evidence/fixed-bridge-deck.png`

`volume.ts` gives a bridge tile a deck span at `[40, 46)` and reports
`ground = 46`. The road either side reports `ground = 0`. The simulation
ignored both and drove across at `z = 0`.

```
bridge start tile [ 62, 178 ]
58:ROAD(g=0) … 61:ROAD(g=0) 62:BRIDGE(g=46) … 78:BRIDGE(g=46) 79:ROAD(g=0) …
bridge tiles=163 adjacency: ramp=0 road=30
```

Three things fell out of that, and a fourth was next door:

- **There was no approach.** Not one of the 163 bridge tiles in seed 7 has a
  `T_RAMP` neighbour, so the deck rose out of the carriageway as a sheer 46 px
  face with the road markings running straight into it.
- **Traffic drove underneath its own bridge.** The before-picture places cars
  at `z = 0` — the height the sim actually gives them — along the row that
  crosses the deck. The first two are on the road; every one after that is
  swallowed. A player crossing the river disappeared for the length of the
  span.
- **The river under a bridge was paved.** The bucket key was chosen per *tile*
  and then every *span* of that tile was pushed into it. A bridge column has
  two spans, so the water beneath the deck was emitted as a road-coloured solid
  — with an outline hull — at `[-16, -8)`. The instance dump confirmed it: the
  deck bucket held `334 = 2 × 167` boxes.
- **Markings stopped at the riverbank.** They were applied only when the bucket
  key was `road`, and a bridge was keyed `deck`.

**Fixed.** `drawnSpans` returns a single deck span at road level and drops the
drowned one. A bridge is part of the carriageway for the marking rules
(`isCarriageway`), so the centre line and the crossings run across it, exactly
as the 2D `paintBridge` starts by calling `paintRoad`. What now says "bridge"
is a parapet: `buildBridgeRails` puts a rail on every deck edge that faces open
water — the question a parapet actually answers, and the one that leaves no
stray posts where the shoreline crosses the span at an angle.

Tests: `client/test/cityTerrain.test.ts` — *lays the bridge deck at the height
cars are actually driven at*, *draws no bridge surface above the road that
feeds it*, *carries the road surface across a bridge*.

**Since, with heights on (3D.md, the bridges wave):** the sim drives the
deck at its profile's height (`bridgeDeckHeights`), so `drawnSpans` steps
aside where `map.ground` exists and the deck is drawn as the slab in the air
it is, the river under it in the river's colour, the parapets on the deck,
and every body on the ground under it. The flat game keeps the flat drawing
above. Test: *draws a real bridge: a deck slab in the air over the river, and
rails on it*.

### 2.1b The bridge mouths were walled — FIXED

Found by the first test that drove a car across a bridge: it stopped dead at
the landfall, on the flat map too. The coast curve (§43) is the smoothed
outline of the water and a deck is carved over water, so the curve turns
from the bank along the deck's side and, smoothed, rounds that corner
straight across the road at the mouth.

```
mouth columns a car could drive straight at: 67
  blocked before the fix: 64   (cut through the road tile before the deck,
                                or the pavement corner beside it)
  blocked after:          13   (outermost lanes clipping a square water
                                tile flush with the deck edge — any quay)
```

**Fixed.** `buildShoreCut` declines on any land tile within one of a deck
(`bridgeMouth` in `shoreCut.ts`). The water keeps its own cut, so nothing
opens onto the sea. Tests: `shared/test/shoreCut.test.ts` — *leaves the
carriageway a deck continues uncut*, *lets a car drive straight onto the
deck*.

### 2.2 Woodland was an elevated plateau of plain grass — FIXED

`evidence/bug-woodland-plateau.png` → `evidence/fixed-woodland.png`

This was the "some grass patches are elevated" report, and it was two bugs
stacked.

`volume.ts` gives `T_TREES` a span to `TREE_Z = 36` — a canopy you cannot drive
through, which is the intent, and which `isSolidTile` agrees with. But
`cityGeometry.ts` painted tile 11 with the same colour as open field and
parkland, and `scenery.ts` planted the tree and bush models at **`z = 0`**,
i.e. 36 px *inside* the slab they were meant to be standing on.

The result was a 36 px mesa of featureless grass with every tree buried in it.
At the game's own camera pitch (0°) it was indistinguishable from open field —
the player saw lawn and drove into a wall. It was not a rounding error either:
2350 woodland tiles in seed 7, and the `hash2 > 0.92` roll yields 311 tree
meshes across the whole map, all of them invisible.

**Fixed.** Woodland gets `palette.trees` — its own canopy colour, the one the
2D layer has always painted it with — and `SceneryLayer` plants on top of the
column instead of inside it. The height is left alone: the wood is solid to
anything on the ground, so a solid mass is the honest drawing.

Tests: `client/test/cityTerrain.test.ts` — *leaves solid volumes alone*,
*gives woodland, beach and runway the palette colours the 2D layer uses*.

### 2.3 Fourteen terrain types rendered as three colours — FIXED

`palette.json` carries a distinct colour for every surface. The 3D renderer
used three of them. Instance counts from the live scene graph made it exact:

| 3D bucket | colour | instances | what was actually in there |
|---|---|---|---|
| `grass` | `#284027` | 20877 | field (16808) + park (1719) + **woodland** (2350) |
| `other` | `#45463f` (`lot`) | 2847 | lot (1811) + **beach** (888) + **quay** (90) + shop floor (38) + ramp (20) |
| `road` | `#33383f` | 15710 | road (15082) + **runway** (294) + bridge spans (334) |

The 2D renderer has a painter per type (`tiles.ts:441–470`). Unused in 3D:
`field #2b3630`, `park #2f4c33`, `trees #22391f`, `sand #b0a074`,
`bank #77705f`, `runway #3a3d42`. The beach was the worst of it — pale sand
drawn as dark industrial olive.

**Fixed.** `SURFACES` in `cityGeometry.ts` is now one entry per tile type,
against the palette entries the 2D layer already paints with, with the grain
and edge each surface wants.

### 2.4 The runway was striped like a street — FIXED

`evidence/bug-runway-markings.png`

`isRoad()` counted `T_RUNWAY`, so the carriageway-centre-line rule painted a
dashed **road** marking down the one surface an aeroplane can take off from.

**Fixed.** `isCarriageway` is now road and bridge only. A runway gets
`palette.runway`, `palette.runwayLine`, and the same every-other-tile cadence
`paintRunway` uses in 2D.

Test: `client/test/cityTerrain.test.ts` — *does not stripe the runway like a
street*.

### 2.5 Shop interiors read as a pit punched through the block — FIXED

`evidence/bug-shop-shaft.png`

A shop's `T_FLOOR` tiles sit at `z = 0` inside a building whose tiles run solid
to the roof. In 3D that is a light-well from the roof down to the pavement.

Half of this turns out to be the design and not a defect: `T_FLOOR` is
documented "walkable, open to the sky", and the 2D tile layer paints the
shop's floor, counter and shelves precisely so you can look down into the room
from the street. Roofing it over would hide the shop you are standing in.

What *was* a defect is that the floor was drawn in the industrial-lot grey, so
there was no telling a gun shop from a garage from above — in 2D the shop's
accent colour is how you identify it. **Fixed:** the room gets the chequered
`shopFloor`/`shopFloorAlt` the 2D painter lays down, and the threshold tile
gets the shop's accent (`shopGun`, `shopClothing`, `shopSpray`, and the proving
ground's own green). The opening stays, and now reads as a shopfront.

### 2.6 The map ended in sky — FIXED

No skirt, no fog, no horizon: at the window's edge the ground stopped and the
background colour began.

**Fixed.** `buildEdgeSkirt` lays four slabs of field around the outside, at the
height the field is at — one draw between them. A ring rather than one plane
under everything, because a plane would have to sit above the water surface at
−8 to avoid z-fighting the grass at 0, and would then have paved over every
river in the city.

Test: `client/test/cityTerrain.test.ts` — *puts ground beyond the window so the
world does not end in sky*.

---

## §3 Bodies (`client/src/three/entities.ts`)

`evidence/bug-3d-bodies.png` → `evidence/fixed-3d-bodies.png`

### 3.1 The tank had no turret — FIXED

`sprites.json` carries `tank_turret` (a 44 px barrel, a ring and a hatch), and
`vehicles.json` gives the tank `turretOffset: -4.5`. The 2D renderer draws it
as a second sprite pivoted on the ring, traversing to the driver's aim
(`renderer.ts:1609–1621`), and holds it there on a wreck. `entities.ts` had no
turret code at all — `grep -n turret client/src/three/` returned nothing.

**Fixed.** `EntityLayer.mounted` places a `${kind}_turret` pool at
`turretOffset` along the hull, rotated to the driver's aim rather than to the
hull — a turret being the one part of a vehicle that does not turn with the
body. Your own comes off your own smoothed aim, not off the wire, so the barrel
answers the mouse on the frame you move it; a remote driver's comes off their
interpolated aim; an empty tank rests its gun along the hull.

Test: `client/test/entities3d.test.ts` — *gives the tank a turret, pointed
where its driver is pointing*.

### 3.2 Motorcycles and bicycles rode with nobody on them — FIXED

Same mechanism, same omission. `vehicles.json` gives `moto`, `copbike` and
`bicycle` a `riderOffset`, and the 2D renderer composites a rider at the
saddle — falling back to `ped_v0_f0` for an AI driver, with a comment saying
exactly why:

> *"A ped-ridden bike in traffic has no player driver, so it falls back to a
> pedestrian: an empty motorcycle travelling at 60 px/s is a worse bug than a
> generic rider."* — `renderer.ts:166`

`entities.ts` never read `riderOffset`. `traffic.json` spawns `moto` at weight
5 and `bicycle` at weight 4, so the 3D city had driverless bikes cruising it at
speed — the exact bug that comment was written to prevent.

**Fixed.** The same `mounted` path seats a rider at `riderOffset`, turning
*with* the body because somebody on a motorcycle faces where the motorcycle
goes, and falling back to a pedestrian for an AI driver.

Test: `client/test/entities3d.test.ts` — *puts somebody on a motorcycle, and
nobody on an empty one*.

### 3.3 Nobody animated — FIXED

This was the "no movement of people" report, and the people were innocent. The
simulation moves them correctly — stepping a headless `Session` for 900 ticks
and diffing every pedestrian's position against where it started:

```
PEDS  tracked=168 moved=168 still=0 mean=211.3px max=558.4px over 30s
```

The `ped`, `cop` and `player` sprite definitions carry `"frames": 4` and an
`anim` block — per-shape offsets that swing the legs and arms:

```json
"frames": 4,
"anim": { "0": [[2,0],[0,0],[-2,0],[0,0]], "1": [[-2,0],[0,0],[2,0],[0,0]], … }
```

`spriteMesh.ts` read `def.shapes` and nothing else. It ignored `frames` and
`anim` entirely, so it could only ever build frame 0. Every pedestrian, officer
and player in 3D therefore *slid* — moving, but locked in a single standing
pose, which from the game's camera reads as a city of statues on rails.

**Fixed.** `spriteGeometry` takes a `frame` and applies the `anim` offsets —
mirrored copies taking the offset with y negated, exactly as `buildSprite` does
when it rasterises the sheet, so the 3D body and the 2D body are the same pose.
`EntityLayer` indexes the frame off distance walked using the same `STRIDE` and
`WALK_FRAMES` the 2D `walkFrame()` uses, so a pedestrian is mid-stride at the
same moment in both views.

Tests: `client/test/spriteFrames.test.ts` (whole file), and
`client/test/entities3d.test.ts` — *walks the legs: a pedestrian on the move
changes frame*.

### 3.4 Every pedestrian wore the same shirt — FIXED

`ped` has six shirt variants. `entities.ts` built one pool at variant 0 and put
all 400 pedestrians in it, while 2D draws `ped_v${id % PED_VARIANTS}_f${frame}`.

**Fixed.** Pools are keyed `sprite#variant#frame` — all three change the
geometry — and the variant comes off the id, as it does in 2D.

Test: `client/test/entities3d.test.ts` — *dresses the crowd in more than one
shirt*.

### 3.5 Vehicle colour ignored the simulation — FIXED

`variantFor` picked a paint job by hashing the entity id, while the snapshot
carries `paint` and `gangId` and 2D uses both. Two consequences:

- **Gang cars lost their livery.** 2D returns `gangcar_v${gangId-1}` so you can
  read whose street you are on from a parked car; 3D gave it a random one of
  the four.
- **The street repainted itself on a rebase.** `VehicleState.paint` exists
  *specifically* because a window move re-spawns every parked car with a fresh
  id, and the comment at `state.ts:316` records that the whole street used to
  change colour in front of the player. Keying off the id in 3D reintroduced
  that bug exactly.

**Fixed.** `vehicleSpriteName` in the 2D renderer has been split into
`vehicleSpriteVariant` — the rule — and a thin string wrapper. Both renderers
now call the rule, so a car is one colour in both views, and the 3D layer takes
`paint` and `gangId` off the wire like everything else.

Tests: `client/test/entities3d.test.ts` — *paints a car the colour the
simulation says, not the colour of its id*, *gives a gang car its gang colours*.

### 3.6 The driver was drawn standing on the roof of their own car — FIXED

Found while checking the above, and not in the original write-up. The 2D
renderer guards this at its call site (`scene.local.mode !== 'driving'`); the
3D one drew the predicted local player wherever they were, and while driving
that is the middle of the car they are steering. Remote players were fine —
the interpolator filters them (`interpolation.ts:175`).

**Fixed.** `EntityLayer` skips a local player who is driving, the same test the
2D renderer makes. A two-wheeler puts them back on top deliberately, through
§3.2.

Test: `client/test/entities3d.test.ts` — *keeps the driver inside the car
rather than standing on its roof*.

---

## §4 Day/night parity — FIXED

The two renderers did not agree on what time of day looks like. Both colour the
world out of `palette.json`, and the 2D one paints those values almost neat —
its day grade is (252, 246, 232), a multiply by 0.98 — so at noon a road is
very nearly `palette.road`. The 3D one lights them, and was lighting them to
about 1.17× in sRGB. Switching renderers changed the hour.

Measured on the modal road pixel of a matched frame, against `palette.road`
`#33383f`:

| | before | after |
|---|---|---|
| 3D at midday | `#3e4348` | `#34393d` |
| 2D at midday | `#323539` | `#323539` |

**Fixed.** `DAYLIGHT` in `cityView.ts` is calibrated so a flat, sun-facing
surface lands back on its palette colour. The night end is left exactly where
it was tuned — night has to actually be dark or a street lamp cannot read
against it, and that is the whole point of having lamps.

The two frames still differ in *mean* luma (3D 85.5, 2D 62.6 at midday). That
is composition, not exposure: the 2D pass draws a vignette over the frame and
speckles its greens darker. The surface a player is looking at is the thing
that had to agree, and it now does.

Separately, and left alone: the 3D light budget is `MAX_POINTS = 16` /
`MAX_SPOTS = 4` (`lights3d.ts:57`) against 80–102 lights requested per frame in
an ordinary city block. That budget is deliberate and documented as the design;
it is a decision to revisit with a real GPU in front of you, not a bug.

---

## §5 Checked and found healthy

Worth recording, so the next pass does not re-tread it:

- **Simulation tick rate** — 29.9 Hz in 3D, 30.0 Hz in 2D. No drift.
- **Pedestrian movement** — 168/168 peds move, 211 px mean over 30 s (§3.3).
- **Ambient traffic** — 14 AI-driven cars in view, 5–11 under way at a time.
- **Ped modes** — walk / flee / downed / dead all reached; corpses lie down and
  clear on the corpse clock.
- **The action key** — `E` looked broken in 3D for a while and was not. This
  box has no GPU, so the 3D path runs at about 2 fps under SwiftShader, input
  is sampled once per rendered frame, and a harness that presses a key and
  re-reads 300 ms later is reading a stale frame and pressing again — enter,
  exit, enter, exit. `ci/playLocal.mjs` already records the shape of this
  ("hold E, do not press it"); at 2 fps the hold has to be longer and the
  settle much longer.
- **Buildings** — heights, roof parapets, rooftop clutter, facades and cast
  shadows all correct and matching the 2D roof colours.
- **Kerbs** — the 3 px pavement lip is right, and is inside every mover's
  step-up allowance. It is the one height the renderer keeps that the sim does
  not model, deliberately: it is what makes a street read as a street, the 2D
  layer draws one too, and at 3 px nothing is hidden behind it.

---

## §6 What is left

- **Adopt `collide3` in the simulation.** §1 is reconciled, not resolved: the
  renderer now draws the flat world the sim runs, which is correct but is not
  the world `volume.ts` was written for. Bridges you sail under, ramps you
  climb and roofs you stand on all need the sim to take the volume grid — and
  bridges would then need ramp approaches generated in `generate.ts`, since
  today not one bridge tile in the city has one beside it.
- **The 3D light budget** (§4). Twenty lights against a hundred asked for is a
  decision made on a box with no GPU.
- **Damage in 3D.** A merged sprite mesh cannot lose a panel without being
  rebuilt, so a battered car darkens rather than showing the dents the 2D
  renderer draws. Recorded as a known trade in `entities.ts`, not disturbed
  here.

---

## §7 The diagonal-road hunt (second pass)

A second hunt, after the drawn island city landed. Its curved arterials
rasterise to stair-stepped DIAGONAL bands of road tile, and five separate
subsystems turned out to still assume every street is axis-aligned. One
family of bugs, five symptoms.

### 7.1 The ring road was striped with phantom crossings — FIXED

`evidence/bug-ring-markings.png` → `evidence/fixed-ring-markings.png`

The 3D renderer's junction test was axis-only (`runs > 6` both ways), so
every stair step of the band read as a junction and got zebra stripes, and
the centre-line rule marked whichever axis measured longer — fragments of
dashed line strewn all over the curve. Three repairs in
`client/src/three/cityGeometry.ts`, mirrored in the 2D painter where it had
the same weakness at the band's mouths:

- Junctions and markings use the 2D painter's own `RUN_ROAD` threshold
  (imported, not approximated): long BOTH ways is a junction, short both
  ways is a stair step, and both stay bare.
- A centre line only goes on a cross-run no wider than `MAX_CARRIAGEWAY` —
  nothing the plan can draw is wider, so wider means the band.
- A zebra only goes where the street RESUMES on the far side of the
  junction. Where a street merges into the band the tarmac widens into a
  pocket that passes the junction test, but there is no crossing street and
  now no crossing painted into it.

### 7.2 Parked cars sat crosswise in the carriageway — FIXED

`placeVehicleSpawns` inferred the street direction from which side the kerb
was on — true on a grid, false on a stair step, where a tile has kerb west
AND north and the guess parked 50-odd cars at right angles to the traffic in
the middle of the ring road (34 on diagonal-only tarmac, 20 on plazas, 21
pointed straight at a wall, measured on seed 1). `axisCarriageway` in
`amenities.ts` now checks the inference: the street must actually run three
tiles each way in the claimed direction and stay carriageway-narrow across.
Spots that fail are MARKED (`VehicleSpawn.crosswise`) rather than removed —
the police stage their waves from this list and the parked fleet is the N
best-ranked spots, so removing entries thinned the police response and moved
every parked car in the city. The session skips marked spots after the
ranking slice (`session.parkedSpots`), so the only visible change is that
the crosswise cars are gone. Test: `world.test.ts` "parks cars along
straight streets".

### 7.3 Ambient traffic scribbled and orbited on the band — IMPROVED

`evidence/bug-ring-traffic.png` → `evidence/fixed-ring-traffic.png`
(trajectories of every AI car near the ring over 70 sim-seconds)

The lane model is cardinal: on the band `laneOptions` correctly refuses to
answer, `junctionExit` finds no exit, and a driver held its cardinal heading
until it ran off the band's edge — then wedged, recovered, and repeated.
The plots showed it: dense scribbles on the band, spiral orbits where a
recovery target ended up inside the car's turning circle. Two repairs in
`traffic.ts`:

- Where the lane model and the junction walk both fail — which is exactly
  the diagonal band — the driver now follows the tarmac itself: a fan of
  probes around its own heading, out to a right angle each side, taking the
  bearing that stays on drivable ground longest. Deterministic (fixed probe
  order, first-wins ties, the sim's own pinned trig).
- A pursuit target that demands more than a radian of heading change halves
  the corner-speed ask. Turn radius grows with speed, so a target closer
  than the radius at `turnSpeed` could never be reached — the car orbited it
  at full lock for ever. Slower is tighter; the turn now completes.

Cars now sweep the band's curve. Some still turn round on it rather than
following it end to end — the lane model itself is the remaining assumption,
and generalising it to eight directions is the real item (see §7.6).

### 7.4 An exploded car did not look exploded — FIXED

The 3D renderer never read `VehicleState.condition`: a wreck kept its paint
at worst 45% darker (`wearShade` bottoms out at 0.55), which reads as a car
parked out of the sun. The 2D renderer draws the same wreck under a 72%
black wash. `vehicleShade` in `entities.ts` now chars a wreck to 0.24 —
matching the 2D wash, still recognisably the colour of car it was — for
remote vehicles and the predicted local one alike. Test:
`client/test/wreckShade.test.ts`.

### 7.5 "The tank can't shoot" — NOT REPRODUCED, verified end to end

Driven through the full server pipeline headless (`GameHost.receive` with
the binary codec, real map, real input sanitising): buy the tank at the
proving ground, enter it, send `fitting` — the shot event is emitted, ammo
decrements, `rayWallDistance` hits what it should. The client binds F to
`fitting`, encodes it (bit 64), and draws the tracer + muzzle flash through
the same event path the pistol uses (verified live in the browser). The
cannon fires on the driver's AIM, with F — the mouse button fires the
sidearm out of the window instead, which is easy to read as "the tank can't
shoot" if F goes undiscovered. If there is a real fault here it needs a
repro with more detail than the report carried.

### 7.6 What is left

- **Buildings are missing along the ring.** 110 blocks crossed by the
  curved arterials have NO buildings: the frontage fill writes a whole unit
  off at every brush with carved road, so blocks that are half road come out
  all lot. A one-line repair (slide one tile past blocked ground instead of
  skipping unit-plus-gap) fills ~30 of them and adds ~100 buildings — but it
  changes the bake, and two police tests are locked to the current bake's
  geometry tightly enough that an honest rebake means reworking how they
  stage (`a cruiser facing the wrong way…`, `an officer keeps the
  uniform…`). Both need the same treatment `sparseInput` and the pickups
  run-over test got in this pass: stage on found, guaranteed-suitable
  ground instead of on what the current bake happens to put near a helper's
  first answer.
- **The traffic lane model is still cardinal** (§7.3). The fan fallback
  makes the band drivable, not disciplined: no lanes, no right-hand rule on
  the diagonal. Eight-direction `laneOptions`/`RIGHT_STEP` is the real fix.
- **Police wave staging can still start from a lonely kerb** — the anchor
  is a hash, and a hash can land on the one kerb of a quiet stretch with
  nothing else in `waveSpreadPx`. `maybeSpawnCop` now walks on past kerbs
  that cannot field the whole wave (falling back to the old answer only if
  none can), which closes the silent no-show; whether the wave SIZE should
  also adapt to what the street can hold is untouched.

---

## §8 "Lights are flickering, buildings are in the wrong place" (third pass)

Reported against the 3D renderer, with "in 2D it was working — when migrating
to 3D it broke at some point". Two separate faults with two separate
histories; one is fixed, one is open.

### 8.1 The buildings — broken at `1404dda`, FIXED at `a9b0d41` (#22)

The full story is §1 plus the #22 commit message; the short version: the sim
was never wrong — every building record, spawn and 6,714 sampled traffic
positions sit on legal ground — but from `1404dda` ("the world gets volume")
the city was DRAWN at its collision heights under a perspective camera that
sits at 589 world px. A 288 px tower is magnified 1.96× by the projection and
displaced by nearly its own height, so downtown masses were drawn across
whole carriageways and the cars "driving through houses" were driving down
perfectly clear streets behind a mis-drawn wall. REVIEW-3D.md carried the
divergence three times as "a constants decision rather than a bug". #22 fixed
it with `Z_SCALE = 0.25` in `render/config.ts`.

Verified still fixed on current main: the worked example from the #22 message
— the 9-storey block at {x:473, y:184} whose mass used to cover the four-lane
street — sits centred on its own lot with the carriageway fully readable,
`evidence/review-building-473.png`. Anyone still seeing buildings across
streets is running a build older than #22.

### 8.2 The lights — born flickering at `9919471`, REPAIRED (budget size still open)

`9919471` ("the city gets lit") gave the 3D city dynamic lights as a fixed
pool — 16 points and 4 spots — handed out each frame to the best-ranked of
everything that wants light. Measured live at night from the spawn: the scene
asks for **120** lights (`__debug.lights3d = {points:16, spots:4,
wanted:120}`). Six times oversubscribed, the pool's cutoff boundary is where
the flicker lives, and three things conspire at it, all present since that
first commit:

- `spend()` re-ranks from scratch every frame with **no hysteresis**: any
  weight wobble near the cutoff swaps a lit lamp for a parked one, which in
  3D is a hard on/off.
- The ranking weight is `alpha · r² / dist²`, and a lamp's alpha carries its
  `flicker()` character (`buzz`, `failing`, `neon`). In 2D that character is
  a smooth brightness modulation on a glow that is ALWAYS drawn — the 2D
  light pass has no budget — so the same tables that read as atmosphere in
  2D read as churn in 3D: a humming lamp's weight oscillates across the
  cutoff and the lamp snaps in and out of existence.
- Signal heads flood the queue: every junction arm in view wants a 7 px glow,
  which is dozens of the 120, keeping the cutoff crowded.

Measured, standing still at night with `peds=0`, five frames 400 ms apart:
the 3D frame shows **34,487** pixels of large (>90/765) frame-to-frame change
against **2,611** in 2D — thirteen times the churn, sustained across every
pair. §6 already carries the budget SIZE as an open decision for a machine
with a GPU.

**The repair, which needed no budget decision.** Three changes in
`lights3d.ts`:

1. **Character out of the ranking.** A want's `alpha` is now its stable
   base; `flicker()` and the package pulse ride a separate `flick` factor
   applied to the granted light's INTENSITY only. A humming lamp dims in
   place, as the 2D tables always meant, instead of crossing the cutoff and
   despawning. (The package glow's radius pulse is stabilised too — it
   squared into the weight.)
2. **Slot hysteresis.** Every want carries a stable identity key, and an
   incumbent's weight is multiplied by 1.6 while it holds a slot, so the
   pool stops being re-argued from a blank slate sixty times a second. A
   genuinely brighter or nearer newcomer still wins; a few percent of noise
   no longer does.
3. **Fade-in on handover.** Legitimate swaps remain — a car's lights
   arriving SHOULD displace the dimmest lamp — so a newly granted light
   starts at 15% and ramps to full over ~150 ms, keyed by the light's
   identity rather than its slot index. Flashes and beams are exempt: a
   muzzle flash that eases in is not a flash.

Verified: slot turnover — now exported as `__debug.lights3d.turnover` — sits
at 2–4 per frame standing still in traffic, all of it moving-vehicle
handovers that now fade instead of popping; static lamps hold their slots.
A `?lights=off` control puts ~12k of the residual pixel change down to the
traffic itself. The signal heads stayed in the pool after all: with stable
weights and hysteresis they no longer churn it, and evicting them would
have cost the one glow that marks a red light at night.

---

## §9 "Houses on roads, black squares, the shore is buggy — and ships sail through land" (fourth pass)

Five complaints, reported together against the 3D renderer. Four of them are
one bug, and it is one line long; a fifth turned up while looking.

### 9.1 The painted ground was mirrored inside every chunk — FIXED

`GroundLayer` lays the 2D painter's work over the instanced city as one
textured quad per 8×8-tile chunk. `TileLayer.groundChunk` paints top-down —
tile row `ty0` into canvas row 0 — and a `CanvasTexture` uploads with
`flipY = true`, because WebGL's texture origin is the bottom-left and a
canvas's is the top-left. In a y-UP scene those two turns cancel and the
painting lands the right way up.

This scene is not y-up. `CityView` scales the world group by −1 in y so the
game's y-DOWN coordinates land where the radar says they are (that flip has
its own test, `cityOrientation.test.ts`). The mirror is applied to the quad's
GEOMETRY; the texture never heard about it. So every chunk showed its
painting **upside down within its own 128 px square** — the north row painted
at the south edge — while the boxes underneath, the buildings, the water and
the collision were all correct.

Measured over the shipped city at seed 7, that is:

- **62.8%** of the 40,110 building tiles were painted with some other tile's
  surface, and **36.2%** — 14,532 of them — were painted **carriageway or
  pavement**. Better than a third of every building in the city stood on a
  painted road, lane lines running under the walls. *"Houses on roads."*
- The `wallShade` fill the painter puts under a building — a colour meant
  never to be seen, because a building covers its own footprint — was drawn
  out in the open two or three tiles off its block. Near-black, hard-edged,
  building-shaped. *"Black squares."*
- **7,418 water tiles** kept the opaque ground plane over them, because the
  cutout mask carries the same flip: open water painted as land, at
  `z = +0.06`, over a river surface at `z = −8`. And the same 7,418 land
  tiles had the hole punched through them instead. *"The shore is buggy"* —
  and it is also both boat complaints, because a hull sails the water the
  SIM knows about: through the land it appeared to have been given, and into
  the land that had been painted as sea. *"Ships can drive through land and
  there may be a collision on the sea."*

The repair is `texture.flipY = false` on all three of a chunk's maps — the
painting, the wetness mask and the water cutout — with the reasoning written
where the next person will look for it. `groundOrientation.test.ts` holds it:
the real `PlaneGeometry` UVs, the real world-group scale, and an assertion
that the chunk's north edge samples canvas row 0. Its second case asserts the
mirror is still there without the flag, so the test is known to be measuring
something. Evidence: `evidence/bug-ground-mirrored.png` against
`fixed-ground-mirrored.png`, and `bug-ground-black-squares.png` against
`fixed-ground-black-squares.png`.

Nothing outside the renderer moved. The tiles, the volume grid, the bake and
the collision were right the whole time, which is why nothing in 829 tests
noticed — a mirrored city is a plausible city, the same trap `cityOrientation`
was written for.

### 9.2 The boats were never the problem — NOT REPRODUCED in the sim

Checked separately from the paint, because "ships drive through land" would be
a serious collision fault if it were one. It is not:

- 3,200 runs — 400 moorings × 8 headings, full throttle, 200 ticks each —
  put **zero** boat centres on a non-water tile. `plainSolid` makes every
  tile that is not `T_WATER` or `T_BRIDGE` solid in the water medium, and the
  bevel path makes a chamfered headland solid on the half that is land.
- Every one of the 271,903 water tiles with two tiles of water clearance in
  all directions — anything that could be called open sea — is clear to a
  boat's 11 px hull box. There is no invisible wall out there.
- All 1,524 bridge tiles are open to a boat, so nothing can be shut in.

What the player hit was the mirrored paint in §9.1, in both directions.

### 9.3 Orphan course ribbons — FIXED

Not in the report, found while looking. §16's course painter strokes each
recorded centreline as a ribbon; `bake.ts:trimCourses` keeps only the runs
whose every half-tile sample lands on carriageway, and dropped what was left
under three tiles. Three tiles was too short: at tile (530, 206) a four-tile,
two-point street course survived as an isolated ribbon lying at 20° across an
ordinary square crossroads, kerb casing, edge lines, centre dash and all —
carriageway painted where no carriageway runs, and where such a stub crosses
a block it paints road under a house. 65 of the 409 courses were under four
tiles, 83 under six.

**Where the first guess was wrong.** The note left here said the rule wanted
was a direction test — drop a ribbon that disagrees with the road mass under
it, as `bevel.ts` phase 3 does for the diagonal kerbs. Measured against the
actual stub, no local test tells it from a road. The road runs three tiles
either way perpendicular to it, its band is fully covered, and both ends
carry on into more road — because it is inside a crossroads, where every one
of those is true of any direction you pick. What is wrong with it is that it
is four tiles long: short enough to hide inside the junction it crosses.

So the floor is stated against the thing it has to outgrow, in the ribbon's
own terms: **three times the course's own carriageway width** — nine tiles
for a street, twelve for an avenue or the ring. The widest crossing in the
city is two arterials meeting, about six tiles across the kerbs and eight
corner to corner, so the floor clears it with room; and a stroke shorter than
a few times its width reads as a blob rather than a line whatever it is lying
on.

Re-baked (`pnpm citybake`): **409 courses → 289**, all 120 of them under ten
tiles. The tile and district planes hash identical to the previous bake and
every ground statistic is unchanged — nobody's city moved, and the buildings,
shops and landmarks are the same records. Of the ribbon that anybody can see,
**97.8%** survives (27,700 → 27,086 tiles of painted centreline); the 25–100
and 100+ tile courses are untouched, so the ring, the avenues and the
borough-length streets §16 was written for are all still drawn as one line.
Dropping a stub costs nothing else: the tiles are untouched, and `courseCover`
lifts with the course, so the per-tile lane markings come straight back
underneath.

`courses.test.ts` gained the floor as an invariant, and a second case holding
the long courses so a future floor cannot quietly eat them. Evidence:
`evidence/bug-course-stub.png` against `fixed-course-stub.png`.

---

## §10 "It still lags sometimes when driving, and the car lights still flash"

Both complaints reported again after POLISH.md's five phases and §8.2's light
repair. Both were real, both were still in the code, and the reason the
earlier work did not reach them is the same in each case: the repair was
aimed at the *steady state* and what a player meets while driving is the
**transitions** — a body seen for the first time, a light changing hands.

### 10.1 The car lights — the fade only ever had a first half — FIXED

§8.2 gave the pool a fade-in and a hysteresis and measured slot turnover
down to 2–4 a frame, "all of it moving-vehicle handovers that now fade
instead of popping". The turnover figure was right; the sentence was not.
Three things were wrong with it, and together they are the whole complaint.

**The fade-in never applied to headlights.** The exemption was written as
`w.rank < RANK.flash` — meant for muzzle flashes, which must not ease in —
and `RANK.headlight` is 6 against `RANK.flash`'s 5. So the test excluded
headlights along with the flashes, and the police strobe with them. Of every
light in the city, the four that change hands most often were the four that
arrived at full brightness in a single frame.

**There was never a fade-out.** A light that lost its slot went dark between
two frames whatever the light replacing it did, so every handover was still
a discontinuity — the fade-in only changed which end of it you saw. This is
half the fix and it needed the slots to become the unit of the crossfade:
the pools are a fixed size (three.js compiles the number of *visible* lights
into every shader, which is why `?lights=cheap` toggles `visible` rather than
intensity), so a handover cannot borrow a spare light to fade out on. The
outgoing light now fades out on its own slot and the incoming one waits about
a seventh of a second for it.

**A headlight carries no brightness information at all.** Every headlight in
the city converts to the same intensity — same alpha, same radius — so a slot
changing hands does not move a single number the shader sees. What moves is
the *position*: the pool on the road stops being in front of one car and
starts being in front of another. Measured over 212 frames of six cars
circling the focus at crossing radii, **a lit beam teleported 143 world px in
one frame**; after the repair the furthest a lit beam moves in a frame is
1.0 px, which is the car's own motion. That measurement is now
`never teleports a lit beam from one car to another` in `lights3d.test.ts`.

Alongside it, a fourth thing that was flashing on its own account: the brake
lights. `braking` was a bare `Math.abs(speed) < 7`, and traffic spends its
life either side of that — a car queueing at a junction crosses it several
times a second. Each crossing swung the tail light's ranking weight by nearly
three (0.55·6² against 0.32·4²), enough to walk it across the point-pool
cutoff and back. It is a latch with a 6/9 deadband now.

Five tests in `lights3d.test.ts` cover it, and all five fail against the
version before this change: headlights fade in, headlights fade out, flashes
do neither, no lit beam teleports, and a brake light hunting across its own
threshold does not change at all.

### 10.2 The driving lag — a body's tenth paint job cost as much as its first — FIXED

`EntityLayer` keeps one instanced pool per `(sprite, colourway, walk frame)`,
built the first time it is asked for. A colourway is baked into the vertex
colours, so ten paint jobs of a car were ten *separate builds* — ten
extrusion-and-merge passes, ten `computeVertexNormals`, ten position-keyed
outline welds — even though the positions, the normals and the weld are
identical across all ten. **Meeting a car colour you had not seen before cost
a full body build, in the frame you met it.** Driving is how you meet new
cars.

Measured in the running game, standing still at the spawn on the CI box (no
GPU, so read these as a shape rather than as a player's milliseconds):

| | pool builds | p50 | p90 | max | total |
| --- | --- | --- | --- | --- | --- |
| Before | 45 | 3.4 ms | 20.3 ms | **133.6 ms** | 542.6 ms |
| After | 45 | 0.4 ms | 4.3 ms | 12.1 ms | 84 ms |

The repair is in `spriteMesh.ts`: the merge is cached as a *shell* keyed
without the variant, and a paint job is a colour array laid over it. Variants
share the shell's `position`, `normal` and `outlineNormal` **by reference**,
and that sharing reaches the GPU — three.js keys its buffer cache on the
`BufferAttribute` object, so ten colourways upload one set of positions
between them. What is left of a first sighting is the shell, one per
`(sprite, zScale, frame)` rather than one per colourway.

The second half is that the pools never went away. Every combination a
session had ever laid eyes on stayed in the scene drawing nothing, and a
zero-instance `InstancedMesh` is still walked, still sorted and still set up
— twice, because the outline twin pays it too, and again for the shadow map.
Standing still at the spawn the map went **25 pools to 52 in forty seconds
and the frame's draw count 258 to 289** with it; a drive across the city is a
tour of the rest of them. `EntityLayer` now retires a pool that has drawn
nothing for ten seconds. On idleness rather than on a cap, because the two
requirements of a cap fight each other: it has to sit above the busiest frame
or it evicts something in view, and a cap that sits just above the busiest
frame sweeps on every one of them. Retiring is safe to do often because
rebuilding is cheap now — the geometry is cached and shared, so a returning
pool is a colour array and an `InstancedMesh`.

While in there: every pool had its own copy of a material that never varies —
a body's colour is its vertex colours and its per-instance tint — so three.js
set the same toon uniforms once per pool per frame, twice over with the
shadow pass. One material now, and one outline material per thickness.

### 10.3 Found and not fixed: a tail light is brighter when you are not braking

Turned up while testing 10.1 and left alone, because it is a brightness
decision and this box has no GPU to judge it on. `MIN_REF` floors the
conversion distance at 8 world px, but a tail light's range is `radius · 2` —
8 px when running, 12 px braking. A source converting at or beyond its own
range hits `falloffWindow`'s 0.15 floor, which is the case the function's own
comment calls "a tuning mistake … it would turn into a flare rather than
showing up as one". The running lamp is inside that floor and the braking one
is not, so the numbers come out 682 against 273 per lamp — the brake light is
*dimmer* than the running light, which is backwards. The signal heads
(radius 7) and package glints (radius 8) are in the same bracket.

The fix is presumably a floor on `distance` relative to `ref` rather than a
floor on the window, but it moves every marker in the city and wants
somebody who can look at it.

---

## §11 The netcode, audited

Not a play-test complaint — an audit, asked for on its own. Most of what it
found was that the netcode is in good order, so start there: 8 bots for 60 s
and 16 for 45 s, both against a real server, gave **zero desyncs, zero stale
deltas, zero full resyncs**, 9–22 KB/s down per client against a 50 KB/s gate,
0.47 KB/s up, and a server that held 30 Hz with every client in lockstep at
twice the design player count. Copy-on-write deltas, interest management, the
dilated interpolation clock and the `viewTick` rewind all do what they say.

Three things were wrong. One of them ends a server.

### 11.1 One unauthenticated socket could kill a server permanently — FIXED

`register` reached `scryptSync` — 50.6 ms and 64 MB, measured on this box —
**synchronously on the event loop the 30 Hz tick runs on**, and nothing
anywhere rate-limited messages, capped connections or bounded payloads. It
also hashed *before* the duplicate-name check could reject it, so a fresh
random username always paid in full.

One socket, which never joined, against a real server:

| flood | sent in 5 s | tick rate: baseline → under → 15 s after it hung up |
| --- | --- | --- |
| `ping` (control) | 251,249 | 30.0 → 28.2 → 29.3 |
| `register` | 52,909 | 29.8 → **1.0** → **0.0** |

52,909 × 50.6 ms is **45 minutes of synchronous work bought with a five-second
flood**, and it is already queued — the tick rate is zero *after* the attacker
disconnects and does not recover. A separately flooded server sat at 82% CPU a
minute later and never answered another `join`. The `ping` control is what
says the cost was the hashing rather than the reading.

Four changes, and the same flood re-run against all four — eight sockets this
time, since one is now hung up on — with the meter in its own process (in the
first pass the meter and the flooder shared an event loop, which is fine for
measuring a server that has died and useless for measuring one that has not):

| flood | sent by 8 sockets in 5 s | still open at the end | tick rate |
| --- | --- | --- | --- |
| `ping` | 24,746 | 0 | 28.8 → 29.2 → 30.0 |
| `register` | 85,483 | 0 | 29.4 → 28.8 → 30.0 |

A player joining after all that gets 89 state messages in three seconds, which
is 29.7 Hz. The four:

1. **The hash is off the event loop.** `PasswordCrypto.hash` returns a promise
   and `nodePasswords` uses `scrypt` rather than `scryptSync`, so the
   derivation runs on libuv's pool. `GameHost.receive` starts it and returns;
   the answer is sent whenever it lands. Two follow-ons came with it: the
   duplicate-name check is repeated on the far side of the hash, because two
   registrations of one name can now be in flight and the loser was
   overwriting the winner's row, password included; and `verify` now hashes
   against a dummy salt for an unknown username, which closes a timing oracle
   that told anyone which names were taken.
2. **A token bucket per connection**, in `GameHost` rather than the transport,
   because it is a property of what a message means — which is also how the
   worker transport gets it for free. 90/s sustained, 150 burst, against a
   real client's 31/s. Over budget a message is dropped *before the decode*,
   which matters: the flood that reached a real server was undecodable, and an
   exception per frame at socket speed is its own denial of service. Past 600
   in arrears the socket is terminated — `terminate`, not `close`, because a
   close is a handshake and the peer that will not stop sending is the peer
   that will not answer one.
3. **A tighter bucket for the two verbs that cost a hash**: five in hand, one
   back every three seconds. It refuses with a message rather than a hang-up,
   because getting your own password wrong five times is a thing people do.
4. **Caps**: `maxPayload` 32 KiB on the socket (`ws` defaults to 100 MiB),
   `MAX_CONNECTIONS` 128, `MAX_PLAYERS` 32 — with reconnects exempt from the
   player cap, or a full server could never readmit its own players.

Ten tests in `server/test/floodResistance.test.ts`, including the one that
matters most: `receive` returns in under 10 ms for a `register`, which is the
whole difference between a 50 ms hash and a 33 ms tick.

Two smaller things fixed alongside, both about sockets nobody is on the other
end of. There was **no heartbeat**, so a peer that vanished without a FIN — a
lid closed, a wifi drop — kept its slot `connected` until TCP gave up minutes
later; and because `resumeByToken` only resumes a slot that is *not*
connected, that player's reconnect was refused and they came back as a second
player with their old body still standing in the road. `wsServer` now pings
every 15 s and terminates a socket that misses one. And `ClientConn.send` had
**no backpressure check** at all, so the per-tick state message queued behind
a non-reading peer without limit; there is now a soft limit that skips the
state message (safe: the next delta is built against what the client last
ACKED, so the gap closes itself) and a hard one that terminates.

**A correction on that last one.** The first pass reported a non-reading
client taking the server from 160 MB to 446 MB in fifteen seconds. That was a
measurement error: a client reading *normally* grows it the same amount over
the same window — it is the server's own warm-up. Measured properly, after
75 s of settling, one non-reading client costs about 45 KB/s, which is 2 MB
over two minutes and inside GC noise. The guard is worth keeping because the
queue had no ceiling and the socket was never reaped, not because of the
number originally quoted.

### 11.2 `escortOf` was hashed but never diffed — FIXED

The third time this list has been caught short the same way, after `airDist`
and `climb`/`liftHeld`, and the file's own comments warn about it twice.
`PED_FIELDS` omitted `escortOf`; `hash.ts` hashes it and a mission writes it.
Proven directly, before the fix:

```
server ped.escortOf : 42
delta rows for peds : {"added":[],"updated":[],"removed":[]}
client ped.escortOf : null
hashes agree        : false
```

So the desync tripwire fired continuously for as long as an escortee lived —
useless exactly during the mission you would most want it watching — and,
because **both renderers draw the escort marker off that field**
(`three/entities.ts`, `render/renderer.ts`), the escort mission shipped with
nothing over the head of the person you were sent to protect. The bot harness
never saw it: no script takes an escort mission.

The repair is one line. What is new is that the next one cannot hide:
`shared/test/diffCoverage.test.ts` does not compare a list against a list — it
perturbs every field of every table in turn and asserts that anything the hash
can see survives a round trip through `diffSnapshots`/`applyDelta`. Run
against the code before the repair it names `peds.escortOf` and nothing else,
which is also how we know there was exactly one.

### 11.3 The JSON-text fallback never worked — FIXED

`binaryCodec.decode` says "Tolerated so a JSON-speaking peer still works
during a rollout"; `wsServer` said "the codec tolerates both". Neither was
true. `ws` delivers a text frame as a Buffer just like a binary one and only
says which through a separate argument, so a JSON peer's leading `{` was read
as frame tag 0x7B, the codec threw on the first byte of every message, and
`receive` swallowed it. Measured, same server, same message: binary join 76
frames back, text join **0**. `rawToFrame` now takes `isBinary`; three tests
in `server/test/frameKinds.test.ts` hold both framings to the same parse.

### 11.4 Left alone

- **Resume tokens are never rotated.** One UUID per slot for the session's
  life, in `sessionStorage`; anyone who obtains it owns that player. A
  rotation on each resume is the fix and it is a protocol change.
- **Diffed but not hashed** — `unseenTicks`, `wantedSinceTick`, vehicle
  `z`/`climb`/`liftHeld`/`paint`, five cop search fields. This direction is
  harmless: it costs a few bytes and cannot desync anything. Listed so the
  next audit does not re-find it as a defect.

---

## Reproducing

```bash
pnpm install && pnpm build
pnpm test                                   # 856 tests
pnpm --filter client dev

# terrain, no player in the way — drive the camera with __city.lookAt(x, y)
/city3d.html?fly=1&seed=7&pitch=42&h=380

# the game itself, 3D and 2D over the same seed and clock
/?local=1&seed=7&night=0
/?local=1&seed=7&night=0&render=2d

# the netcode, end to end against a real server (§11)
pnpm bots --count=8  --script=cruise --duration=60
pnpm bots --count=16 --script=brawl  --duration=45
```

The numbers quoted above came from throwaway probes run against `server/dist`
and `shared/dist` — a headless `Session` stepped and diffed for §3.3,
`generateCity` + `buildVolumeGrid` walked for §2.1–2.3, and the live scene
graph traversed in the browser for the instance counts and the modal pixel
colours. Each is a dozen lines; every figure they printed is quoted inline
here, so none of them is load-bearing. What *is* load-bearing is in
`client/test/`.
