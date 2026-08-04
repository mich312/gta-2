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
one bug, and it is one line long.

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

### 9.3 Orphan course ribbons — OPEN

Not in the report, found while looking. §16's course painter strokes each
recorded centreline as a ribbon; `bake.ts:trimCourses` keeps only the runs
whose every half-tile sample lands on carriageway, and drops what is left
under three tiles. Three tiles is too short: at tile (530, 206) a four-tile,
two-point street course survives as an isolated ribbon lying at 20° across an
ordinary square crossroads, kerb casing, edge lines, centre dash and all —
carriageway painted where no carriageway runs, and where such a stub crosses
a block it paints road under a house. 65 of the 409 courses are under four
tiles and 83 under six.

The tiles under them are right, so this is paint only, and dropping a stub
costs nothing: the per-tile road painting comes straight back where the
course's `courseCover` suppression lifts. The fix wants a rule with meaning
rather than a bigger number — a ribbon that disagrees with the direction the
road mass under it actually runs is the thing to drop, which is the test
`bevel.ts` phase 3 already makes for the diagonal kerbs. Left open rather
than guessed at, because the floor moves what the city looks like.

---

## Reproducing

```bash
pnpm install && pnpm build
pnpm test                                   # 829 tests
pnpm --filter client dev

# terrain, no player in the way — drive the camera with __city.lookAt(x, y)
/city3d.html?fly=1&seed=7&pitch=42&h=380

# the game itself, 3D and 2D over the same seed and clock
/?local=1&seed=7&night=0
/?local=1&seed=7&night=0&render=2d
```

The numbers quoted above came from throwaway probes run against `server/dist`
and `shared/dist` — a headless `Session` stepped and diffed for §3.3,
`generateCity` + `buildVolumeGrid` walked for §2.1–2.3, and the live scene
graph traversed in the browser for the instance counts and the modal pixel
colours. Each is a dozen lines; every figure they printed is quoted inline
here, so none of them is load-bearing. What *is* load-bearing is in
`client/test/`.
