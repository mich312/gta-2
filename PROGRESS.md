# PROGRESS

## The drawn city, reviewed and redrawn: an island four times the size

The first drawn city (below) replaced the generator and was still, visibly, a
drawing. Three reviewers — a level designer, an urban geographer and an engine
engineer — were pointed at it, and between them said the same thing three
ways. `WORLDGEN.md` §12.7 records what each found; this is what it cost.

**The map.** 384×384 → **768×768 tiles** (12288 px, four times the area, about
a minute corner to corner at top speed). Not a rectangle of land any more: one
long island split by a tidal strait, a second island across a sound, a spit
round a lagoon, barrier islands, a rock stack. Five boroughs, eight crossings.

**Coastline.** The killer observation was that a coast drawn on an eight-tile
grid has power at exactly two scales and a real one has power at every scale.
The plan holds OUTLINES now; the rasteriser builds a signed distance field and
displaces the *sample point* by a four-octave vector warp (wavelengths
256/128/64/32, amplitudes 40/20/10/5 — amplitude/wavelength ≈ 0.15 is the whole
trick). Plus one asymmetry worth more than another octave: the swell comes from
one direction, so the shore facing it is planed straight and the lee keeps its
inlets, and the same number decides where sand collects.

**Density.** Measured on the first draft: 31% of dry land was carriageway and
9% was building; downtown itself was 13% built against 28% bare dirt. A block
was a kerb ring with detached three-tile sheds scattered inside. Blocks are
built as street FRONTAGE now — shoulder-to-shoulder units four to six deep with
a yard behind, and a per-borough density deciding how often the ring breaks.
Building share of dry land 9% → 15.5%. Alleys exist, per borough.

**Two real bugs, both found by drawing curved roads.** `signals.isJunctionTile`
calls tarmac that is over-wide across both axes a junction; a four-tile road at
45° measures nearly six across both, so every diagonal road was a junction and
the ring carried 333 signal heads. The span test measures four directions now —
two axes and two diagonals — and asks whether the tile is narrow in *any* of
them. Second: a bridge was judged by the water span along whatever heading the
road had when it left the bank, and a curved road crossing a harbour has a
segment somewhere pointing along the water — it laid a hundred-tile causeway
out to sea. Bridges are checked after the fact, over four directions.

Two rules came with them: a connected junction over twenty tiles is a plaza,
not a signalled junction (many ways in, no phase that governs them), and
exactly one head is kept per junction per cardinal rather than trusting a local
kerb test that only ever gave one per arm on a grid.

**Scaling.** `planRoute` allocated 5 MB per call and cleared two of the three
arrays before looking at a tile, five to fifteen times a second; it reuses one
working set with a generation stamp and has an expansion cap, because a route
to somewhere unreachable used to exhaust the whole network mid-tick. Ambulance
dispatch planned a route per improving candidate; it sorts by distance and
plans once. Every ambient budget was a flat count — 48 cars, 200 pedestrians,
400 props, 100 packages — which on four times the ground is an emptier city,
not a bigger one; they are rates per nominal 384² city now, scaled by area.

**Gannet Rock.** A plateau in the western approaches with an airstrip on top
and cliff the whole way round: no bridge, and nowhere to bring a boat
alongside. Three general primitives carry it — `cliffIslands` (a point on a
landmass, not an outline, because the shore is warped after it is drawn),
`landmarks[].byAir` (no driveway cut, no road demanded, but a runway required
on the same ground and a shore nobody can step onto), and a final seal in the
bake that re-asserts "nothing walkable touches water here" after every pass
that could have opened it — three of which did. The checker also learned that
ground with a runway is an airfield rather than an orphan, and ground with a
walkable shore is reached by boat; what is left flagged after those two is
445 tiles of genuinely enclosed courtyard, down from five thousand.

**Deferred, and said out loud:** grade separation (road over road) is the
biggest missing chase primitive and needs a new tile type through collision,
the volume grid and both renderers. One-way systems need direction in the
traffic model. The engine reviewer's client-side list — instance matrices as
`Float32Array` rather than `THREE.Matrix4[]`, the volume grid's span
intermediate, chunked scenery, an off-thread join — is real and unaddressed;
the join sequence is the first thing that will hurt on a slow machine.

**Test fallout: 49 of 789.** Most were fixtures pinned to a map that no longer
exists — hard-coded coordinates that are now open sea, scans that assumed an
axis-aligned grid, counts that assumed a flat ambient budget. Two were real
regressions in my own new code and are worth naming: the reused A* scratch is
never cleared, so reconstructing a path by walking `cameFrom` until -1 walked
into a previous search; and boroughs are polygons that abut, so their lattices
produce overlapping blocks, and one block's park pond was being carved through
the terrace the block next door had already built — leaving a Building record
whose tiles were open water.

789 tests green; six bots, twenty-five seconds, zero desyncs.


## The map generator is replaced by one drawn city

`WORLDGEN.md` §12 is the design; this is what it cost and what it fixed.

**The finding.** The generator was not broken in the sense of having a bug. It
was broken in the sense that **nothing about it could be reviewed**: the map a
player got did not exist until they got it, so every quality problem — noise
water cutting the road network into islands, boroughs with no shape, a grid of
uniform texture from edge to edge, landmarks that were a dice roll with names
on them — was addressed by tuning a constant and hoping, and every fix moved
every other seed. Look at `evidence/city-old-generator.png` and
`evidence/city-anywhere.png` together; the second is not a better generator, it
is a different kind of thing.

**What shipped.** One city, Anywhere City, 384×384 tiles: three boroughs on an
island group joined by four bridges, with the sea all the way round as the map's
edge. The source is `shared/data/city-plan.json` — the coast as a 48×48 picture,
the boroughs as rectangles with a street pitch each, the avenues as named lines,
every landmark at a chosen rectangle. `pnpm citybake` expands it, checks it, and
freezes it into `shared/src/world/city.data.ts` (118 kB, RLE + base64). The game
decodes that and dresses it; server, client and replay load the same bytes
instead of running the same algorithm twice.

**The three passes that only a baked map can afford.** Validation runs once,
offline, so it gets to be exhaustive rather than fast: one road network, every
landmark with a road within six tiles, every shopfront with a pavement outside
and a walkable room behind, no carriageway ending in open water. It also
*repairs* — a landmark with no road gets a driveway cut by breadth-first search;
carriageway that is not part of the main network goes back to being ground
rather than stranding an ambient car forever — and it *refuses*: a landmark
drawn over the sea or across a street throws, naming the landmark and the tile.
Both of those refusals fired during authoring, and both would otherwise have
baked silently into a pier nobody meant and a severed road network.

**One real bug found on the way in.** `signals.isJunctionTile` calls tarmac
that is over-wide across *both* axes a junction. The first plan drew avenues
five tiles wide; `MAX_LANE_TILES` is four, so every tile of every avenue was a
junction and one of them carried 333 signal heads. Two fixes: avenues are four
tiles wide, and the layout now refuses to carve a street within three tiles of
one already there — a lattice cut landing beside an avenue does not read as two
streets, it reads as one very wide one, and the traffic model agreed.

**What went.** `world/fields.ts` down to its hash primitives; `world/districts.ts`,
`world/roads.ts` and `world/store.ts` deleted outright; the `rebase` SimCommand
and server message; `ROAM` and `?roam=`; and every layout parameter in
`worldgen.json` — `windowX/Y`, `widthTiles/heightTiles`, `arterialSpacing`,
`blockSize`, `fields`, `water`, `countryside`. What is left in that file is what
a session is entitled to vary on top of a fixed map. A seed no longer touches
the ground: it moves the furniture — parked cars, crates, hidden packages, turf,
ramps, which of sixteen spawn points you get.

**Test fallout, and what it taught.** 24 of 778 tests failed on the new map and
all but four were fixtures rather than regressions: tests that scanned the map
from the top-left corner for "a straight street" or "open ground", which on a
drawn map is the sea and then the quietest dock road in the city. `helpers.ts`
now searches outward from the first player spawn and says why, and player spawns
themselves are restricted to built-up districts with street around them — a
player starting on a dock with no traffic, no crowd and nothing to steal was
technically a spawn and a bad first thirty seconds. Two new helpers came out of
it (`busyKerb`, `spotFacingWall`) and one test file was rewritten around what it
was actually claiming rather than around where the old map happened to put
things. `shared/test/city.test.ts` is new and holds the asset to the plan: it
bakes the plan and compares tile-for-tile, so a plan edited without re-baking
fails the suite rather than shipping a map that does not match its description.

775 tests green; six bots, twenty-five seconds, zero desyncs.


## Feature parity between the 2D and 3D renderers

Four waves, and the finding that shaped all of them: **almost every gap was
shared state advanced inside one renderer, not a missing draw call.** Effects
spawning, effects ticking and the day/night clock all lived inside the 2D
`render()`. So in 3D they did not exist to be drawn — which is why the gaps
read as "the 3D view is wrong" rather than as "the 3D view is incomplete", and
why the fix was almost always to move something out rather than to write
something new.

**Wave 1 — particles and decals.** No skid marks, exhaust, engine smoke, flame
or blood pools in 3D. `effects.update()` and the spawns for skid, exhaust,
smoke, fire and bleeding were side effects of the 2D renderer drawing a car or
a corpse. The derivation moved to `render/sceneEffects.ts`, called once a frame
from `main.ts` before either renderer runs; the 2D drawing functions lost the
side effects and 134 lines with them. `three/effects3d.ts` presents the pools
as instanced quads, and the presentation maths (`decalAlpha`, `decalSpread`,
`particleAlpha`, `particleSize`) is exported and used by the Canvas path too,
so blood cannot fade at one rate in 2D and another in 3D. Flat quads are not a
compromise here: the camera hangs straight down, so a quad already faces it
square on, and what it buys over compositing the 2D canvas is depth — a blood
pool behind a tower is behind the tower. Shape rides along per instance, so a
scorch is a soft radial burn rather than the hard black square an untextured
quad gives, which is the exact artifact the 2D cached gradient exists to avoid.

**Wave 2 — pickups, packages, traffic signals, projectiles.** Four object kinds
with no 3D representation at all. The signals mattered most: the traffic obeys
them and only the 2D player could see what it was obeying. Phase comes from
`signalColour`, the same function the drivers consult. Colours come from the 2D
renderer's tables, now exported rather than duplicated. Where 3D can do better
than a flat square it does — a crate is an octahedron with the same overhead
silhouette, a signal head stands on a post, a rocket points along its flight.

**Wave 3 — the city gets lit.** Real lights and a shadow map, per 3D.md's
instruction to delete the 761-line Canvas pass rather than port it: lamps, shop
signs, lit interiors, headlights, brake lights, cop strobes, signal glow,
package glints, muzzle flashes, fireballs. Found on the way in, and worse than
the missing lights: **the day/night cycle never ran in 3D at all**, because
`lights.setNight()` was only called from the 2D `render()` and the 3D path read
a night amount nothing had ever set — the city sat at a fixed dusk for the
whole session. Night also had to *be* night; the old fade left ambient brighter
than any lamp, and a lamp cannot read against that.

**Wave 4 — bodies, tiers, damage, tags.** A dead pedestrian in 3D stood up in
the middle of the road. Somebody on the ground is a different drawing from
somebody standing, and the sheet has carried `pedDowned`, `pedDeadA/B`,
`copDead` and `playerDeadA/B` all along. The entity layer keys its pools by
sprite name now, which also gives the four police tiers their own figures
rather than one figure under four tints. Escort markers are back, so the NPC
you must protect is identifiable. Damage arrives as paint that has been through
a wall: a merged sprite mesh cannot lose a panel without being rebuilt, so wear
darkens the body instead, bottoming out at 0.55 rather than at black because a
wreck still has to read as the colour of car it is. Name tags moved to a shared
HUD-space pass in `main.ts` — the ground plane projects identically in both
views, so this is one function with no renderer branch.

**Three things learned that are worth not relearning.**

`material.vertexColors = true` compiles `vColor *= color` whether or not the
geometry has a `color` attribute, and an unbound attribute reads as (0, 0, 0).
Every instanced object came out black, and a city full of traffic signals had
heads you could not read the phase off. Geometries are painted white at
construction so `instanceColor` has something to multiply.

The light budget is the design, and the ranking is the feature. three.js
compiles a fixed light count into every shader, so one light per lamp is not
available. The first cut ranked by category and put signals and package glints
above street lamps: both are 7 px pools nobody can see, both already draw as
bright geometry, and every junction has several heads — so they took all
sixteen slots and the city had no street lighting whatsoever.

Intensity does not convert at a light's radius. three.js is physical, so
irradiance falls as 1/d², while the 2D pass speaks in "alpha of a gradient of
radius R". What a lamp lights is the road thirty pixels beneath it; converted
at its 34 px reach instead, every lamp in the city was on and none of them lit
anything.

**Deliberately not ported.** Walk-cycle frames: the 2D `_f{n}` poses are a
top-down art trick, and a mesh with real volume reads without them. Broken
panels as geometry: conveyed as darkened paint, see above. Gang tints on
pedestrians: the audit found the 2D `tint` argument is only the fallback colour
for a missing sprite, so it is not a behaviour 3D was missing.

**Verification.** 24 new cases across `client/test/effects3d.test.ts`,
`worldObjects.test.ts`, `lights3d.test.ts` and `entities3d.test.ts` — three.js
needs no WebGL to build a scene graph, so all of it runs in node against the
real layers, reading instance buffers and light intensities back. In a real
browser: a 40 px explosion scorch inside the mirrored world group darkens the
road 192/384 at its centre and leaves the corners of its bounding box at 384
untouched (round, soft-edged, depth-correct); signal and pickup pixels near the
2D table colours went from 0 to 313 and 246 when the black-instance bug was
fixed; at `?night=0.9` mean luma is 30.2 against 2D's 44.4 with warm-pool
pixels at 4.1% against 0.58%, and the cycle moves 90.9 / 59.0 / 25.5 across
night 0 / 0.5 / 0.9; the local name tag lands in the identical pixel box in
both renderers (x 594-683, y 325-338). Full suite 757 green. Evidence:
`evidence/render-3d-parity.png`.

**Not measured, and it is the open risk.** Frame cost. This box has no GPU and
SwiftShader pins the client at 1 fps whatever the window size, so the light
count and the instance pools are bounded by design rather than by measurement.
`?lights=cheap` spends a quarter of the light budget and `?lights=off` none of
it, and `?render=2d` remains the measured path — 60 fps, p50 4.5 ms. The first
person to open this on a machine with a GPU learns something nobody here knows.

## The 3D world was built once, and the world moves

Reported as "the new generated terrain does not fit with the minimap, there
are walls where none were before, and the map suddenly changes when a new part
is generated". Three descriptions of one fault, and the third names its cause.

With ROAM on, the session does not stream a world — it **regenerates** one.
When any live player comes within 24 tiles of the window's edge, `maybeRebase`
recentres the window on the players, generates a whole new city at the new
origin, shifts everyone into it by whole tiles and reseeds the ambient world.
The client is told, and regenerates the identical map from the seed.

Except that only some of the client heard about it. `welcome` and `rebase`
each carried their own list of who to tell — the tile layer and the radar —
and the 3D world was on neither, because it was built lazily on the first
frame that had a map and there was no code anywhere that could build it twice.
So from the first rebase onward, the 3D renderer drew **the region the player
had left** while the sim, the collision and the radar were all in the new one.
That is the whole report: terrain that does not match the minimap; buildings
from the old window standing where the new one has open road, which is a wall
where none was before — and its counterpart, an invisible wall where the new
window has a building the old one did not; and the disagreement arriving all
at once, at the tick a new region is generated.

Three changes. The geometry moved out to `three/cityGeometry.ts` as
`buildCity(map)` — a function of a map returning a group, because something
that happens more than once needs a seam it can be torn off at, and because a
method on the class that owns the `WebGLRenderer` cannot be tested in node.
`CityView.setMap` disposes the old city and builds the new one, and the
constructor goes through it too, so the path a rebase takes is the path every
session already exercises on its first frame. `SceneryLayer` keeps its baked
planting in a group of its own and empties it first, or a rebase would leave
the old region's wood standing in the new one's streets on top of its own.

And the actual defect — two paths to a new map with two lists — is gone:
`adoptMap` in `main.ts` is the one place a new city is handed out, called by
both `welcome` and `rebase`. A layer is added to it once or not at all.
`live.ts` (the sibling 3D page) boots its host with ROAM on and ignored
`rebase` entirely; it handles it now. Disposal is real disposal, geometries
and materials both: `remove` only unhooks, and a session crossing a few
regions would have left a whole city resident on the GPU for each one behind
it. `__debug.region` reports which window is in force, because a test looking
at the screen otherwise cannot say which city it is looking at — which is
precisely the question when the terrain and the radar disagree.

**Verification.** `client/test/cityRebuild.test.ts`: two windows onto one seed
give different geometry (the premise), the same window gives the same geometry
twice, a rebuild leaves exactly one city in the group and none of the old
positions in it, dispose really fires on the geometries and materials, and a
second `setMap` replants rather than piling planting on planting — with both
windows chosen to be planted ones, so "nothing there afterwards" cannot pass
for "replaced". Measured in a browser against ground truth rather than against
a second rendering: regenerate the client's own city from the seed and
`__debug.region`, then ask whether each patch of screen is parkland where the
tile grid says it is. 3D at spawn 99.3% of 267 probes, 2D 98.1%; driven to a
real rebase, the 2D client reads 97.8% before and 100.0% after, in a region
98 tiles east and 42 north of where it started. The 3D drive to a rebase was
not run to completion here: software WebGL caps this box at 1 fps whatever the
window size, which is a property of the box and not of the change.

## The 3D city was mirrored north-for-south

Reported as "the map and what is rendered is offset — the minimap shows
something else than the world does", and the radar was the innocent party.

The game's world is **y-down**: `y` grows southwards, and that is what the
sim, the 2D renderer, the HUD and the radar all mean by it. three.js draws a
y-up scene, and with the camera overhead and `up` at +Y, a world position
handed straight to it puts +y at the TOP of the frame. Every world coordinate
in the 3D path — the city geometry, the entities, the scenery, the sun — went
in straight. So the entire world rendered mirrored about the player: at
tile (212, 80) on seed 7 the radar and the 2D renderer both put a park
north-east and a block of flats south-east, and the 3D renderer drew the
block north-east and the park south-east. Driving south moved you up the
screen. Nothing looked broken in a screenshot — a grid city mirrors into a
plausible grid city — which is how it shipped as the default renderer.

The fix is one flip, in one place: `CityView.world` is a group scaled
`(1, -1, 1)` and everything world-space now hangs off it, so a call site
still says `(x, y)` and means what the rest of the game means. Rotations come
out right for free — a heading measured clockwise in a y-down frame is
counter-clockwise in the mirrored one, which is exactly what a reflection does
to it — and three.js handles the rest, flipping the winding it culls by on a
negative-determinant world matrix and reflecting normals through the normal
matrix, so the toon banding, the inverted-hull outlines and the shadow map all
carried over untouched. The sun went in the group too, which is what makes it
agree with `SUN_X`/`SUN_Y`: a building's shadow now falls down-and-right in
both renderers instead of opposite ways in each. The two direction-agnostic
lights stayed in scene space so the lighting did not change.

**The arrows were not inverted.** Reported alongside it, and it is the same
fault wearing a different hat. `stepPlayer` has always read `up` as -y, and
`driveVehicle` has always turned the heading the way a y-down world says it
should; measured in a browser, holding Up moved the player 110 px north in
both renderers. What differed was the picture: mirrored, walking north
scrolled the city UP the frame and holding right swung the bonnet left, which
from the driving seat is indistinguishable from the controls being inverted.
Nothing in the input path changed. With the flip in, holding Up in 3D moves
the player 110 px north and scrolls the scene down 221 device px against an
expected 219 (r=0.96), and Down is its mirror image.

Two things fell out of the same corner. `viewHeight` was fixed at
construction, so after a window resize the 3D camera framed the old amount of
world while the HUD, the radar and mouse aim had all moved to the new one —
every marker off the thing it marked, worse towards the frame's edge;
`setViewHeight` is now called from the same branch that resizes the canvas.
And the sun's rig offset existed twice, with two different vectors; it is
`SUN_OFFSET` once.

**Verification.** `client/test/cityOrientation.test.ts` runs the real
three.js projection over the two exported values that decide the orientation
(`WORLD_TO_SCENE`, `cameraPose`) — no GPU needed, since `CityView` owns a
`WebGLRenderer` and cannot be built in node. It pins increasing world y to
screen-down, world x to screen-right, the framed height to `viewport.h`, the
shadow direction to `SUN_X`/`SUN_Y`, and a north-east tile to the north-east
of the frame. The second half of the file steps the real sim over a real
intent and projects the result through the real camera, so the keys are
asserted where the complaint was made — on screen: Up walks you up the frame,
right turns the bonnet down it. Neither half of that is wrong on its own,
which is why neither can be tested on its own. Six of the twelve cases fail
if the flip is removed. Measured
end to end as well: classifying parkland across the frame in a browser, the
2D and 3D renderers drawing the same position agreed on 74.9% of the frame
before and 95.0% after, the remainder being one-cell edges where perspective
splay narrows a park at the frame's rim. Full suite: 723 tests green.
Evidence: `evidence/render-3d-client.png`, retaken.

## Aircraft, per-kind speeds, and a street that stops repainting itself

Three reported faults, and each turned out to be several.

**Aircraft had a body on the ground plane.** `z` was on the wire and in
the renderer, and nothing that touches the street had ever asked about
it. So a helicopter at cruise height ran down the crowd it flew over,
laid tyre marks on the road below, trailed exhaust along it, parted the
pavements as it passed, smashed the bollards, triggered mines, blocked
the traffic under it, set off the barrels — and was then blown out of
the sky by the barrels it had set off, which is the whole of "why does
it suddenly explode". One predicate (`onTheGround`) now guards every
system that models a vehicle as a shape in the road, and blast falloff
is spherical rather than an infinitely tall column: a barrel is a graze
at 48 px up instead of a direct hit. `shared/test/overhead.test.ts`
holds each face of it, with the grounded case asserted alongside so
none of them can be quietly disabled.

**Altitude was the throttle.** Hold forward and a helicopter climbed;
let go and it sank. Two controls in one, and neither worked: no flying
level at speed, no descending without cutting the engine, and no moment
at which the pilot decided to leave the ground. It is a latched key now
(Shift), edge-triggered inside `stepVehicleDriving` so the client
predicts it, with the HUD naming the key and — the row that matters —
saying what a plane parked in a side street is waiting for rather than
offering a take-off it will refuse. Evidence:
`evidence/flight-control.png`, `evidence/flight-over-the-city.png`.

**Ambient traffic drove at one speed.** `traffic.json` quotes a single
cruise, corner and panic speed and every driver took them literally, so
the bus, the digger, the refuse lorry and the sports car all did exactly
62 px/s nose to tail while `vehicles.json` said their top speeds ran
from 97 to 252. Each kind scales those three by its own `maxSpeed` over
a new `speedReference`, clamped either side — a floor because a digger
at 0.49 of cruise is a roadblock, a ceiling because the lane keeping was
tuned at `panicSpeed` and a sports car above it corners into the kerb.

**Moving the window repainted the traffic.** Everything about a parked
car was decided by its position in a row-major scan of the window: which
kerbs were occupied (`i % stride`), what was parked at them
(`PARKED_CYCLE[i % n]`), which belonged to a gang (`i % 7`) and what
colour it was (off the entity id, handed out in spawn order). None of
that survives a rebase, so crossing a region boundary rebuilt every
street in sight — different cars, different colours, in front of the
player, for no reason visible in the world. All four are hashed off the
kerb's GLOBAL tile now, and the paint rides the wire as `VehicleState.paint`.
Parked-car POSITIONS were window-scoped too — a running countdown over a
window-ordered walk — and are now one hashed offset per fixed segment of
road, which keeps the minimum separation the countdown gave.

**...and it lurched while it did it.** A rebase regenerated the map
(~103 ms) and rebuilt the ambient world in a single batch of ~900 spawn
commands, applied inside one `step` and encoded into one snapshot delta.
Worldgen is down to ~77 ms — the city-core lattice is memoised per cell
and the water field is sampled once rather than twice over — and the
reseed is metered at 60 commands a tick, so the region fills in over
about a second instead of on one frame.

**Verification.** 682 tests green (26 new); a 45 s four-bot `jitter` gate —
which now mashes the take-off key at random while driving — and a 100 s
two-bot roaming gate both at 0 desyncs and 0 full resyncs, with the roaming
replay re-simulating hash-identical. The live run through a real
browser against a real server found the one bug the unit tests could
not: `climb` was absent from `VEHICLE_FIELDS`, so it shipped in full
snapshots and never in a delta — the altitude on the wire said "flying"
while the flight control said "landing" all the way up. The snapshot
test now enumerates a vehicle's whole state rather than a remembered
list, and fails if `climb` is removed again.

**Deliberately scoped.** Gang turf is still window-scoped by
construction (`assignTurf` places its home points relative to the window
centre), so a gang's car may legitimately change livery across a rebase
— one car in seven, and making territory a property of the unbounded
world is its own piece of work. Vehicle HOMES fall back to an index into
the window's spawn list when a kind has no landmark to live at, so a
dozen speciality vehicles still move with the viewport. Neither `z` nor
`climb` is in the desync hash, following the altitude subsystem's
existing convention.

<<<<<<< HEAD
## Worldgen §11 delivered: countryside, store, and the walls come off

The full §11 plan (WORLDGEN.md), shipped in four commits. 468 tests
green throughout; brawl gate 0 desyncs; the new roaming gate walks two
bots east for 90 s across multiple window rebases with 0 desyncs,
2.63 px corrections and ~18 KB/s; every replay — including one that
crosses rebases — re-simulates hash-identical.

**A1/A2 — the countryside is real.** Rural regions subdivide to
lane scale with no kerbs (crowd/props/parking quiet emerges from the
existing sidewalk filters), meadow finally uses T_FIELD, T_TREES forest
grows on the wildness field one tile clear of every lane, and shores
split on urban intensity: stone quay in town, T_SAND beach in the
country. **A3** — farms, campgrounds, lighthouses and quarries
(with crushers) stamp into rural cells as named landmarks: the §3.6
stamp mechanism, built. **B1** — WorldStore serves cell-keyed
tiles/landmarks from padded windows, proven bit-identical to session
windows; its gate caught cellQuotaFrac depending on window size (quotas
now phrase against a constant nominal 240² city). **B2–B4** — ROAM=1
slides the session window after the players: one rebase SimCommand
shifts players and drops the region's ambient world, reseed commands
repopulate, replays swap windows at the same boundary.

**Deliberately scoped.** Rebase is opt-in (ROAM=1); the browser client
handles it with a map regen and one visible snap — untested in a real
browser, flagged. Hidden-package finds are window-indexed and reset
across a rebase. Deep-country cells have no hospitals (landmarks prefer
urban districts), so a countryside death respawns in town. Full resyncs
spike at each rebase (~40-90 per roam run) — correct but optimizable.

**Least confident about.** Rebase under packet loss mid-swap (bots run
clean sockets); the browser-side rebase snap; and mission/economy state
that references old-window coordinates beyond the abandon-on-cross rule.

=======
## A room to test in

580 tests green (up from 564; 16 new). 8-bot joyride lockstep, 0 desyncs,
replay re-simulates hash-identical. Off unless asked for.

`PROVING_GROUND=1` puts one room in the city and starts you on its doorstep.
Walk in and the shop keys hand over a tank, a car, six cars laid out in a row
to drive down, a bus, a truck, every weapon, full health and $10,000 — free.
The four vehicle rows are the four cases the crush rule has: something it
flattens, a row of them, and the two sizes that stop it.

**It changes nothing about the city.** `placeProvingGround` runs dead last in
worldgen, after every pass that reads the tile grid, and draws no random
number — so the same seed gives the same streets, buildings, parked cars,
props and pickups with the room and without it. That property is the whole
reason the room is trustworthy: a bug you find with it open is still there
when you close it. Three seeds pin it, pass by pass, plus a tile-by-tile diff
that allows changes only inside the room's own footprint. This file already
had the scar tissue explaining why worldgen passes must not quietly feed each
other (see `registerClinics`), and going last is the only placement that
cannot.

**It is a worldgen parameter, not a server flag.** The client builds the map
itself from what the welcome message carries, so a server-side-only toggle
would have the two hosts disagreeing about where the walls are. Verified over
a live socket: the client's own `generateCity` produces the room.

**The one thing it does change is where you start**, and deliberately.
`pickSpawn` chooses uniformly from `playerSpawns` and the ordinary list is
spread across the city, so "near spawn point zero" would have put you next to
the room one time in however many spawns exist. The room exists to save time;
a treasure hunt for it is the opposite.

**Nothing of the economy is reused.** No price, no ledger line for the goods,
no standings, no district. Threading "except when it's free" through the shop
would have put a hole in the one system in the game that is about scarcity, so
the depot answers first and on its own; the client borrows the shop panel and
nothing else. What it hands out arrives as ordinary `SimCommand`s that already
existed — `spawnVehicle`, `grantWeapon`, `healPlayer` — so nothing here can
produce a state the ordinary game could not, and a proving-ground session
still records and replays like any other.

**The economy caught me.** Adding free cash tripped `no new earning path can
bypass the chokepoint unnoticed` — a tripwire that enumerates every ledger
write and fails on a new one until somebody decides. Exactly the right
question to be asked. The cash is ledgered (money must never appear without a
line saying where from, debug money included) and listed exempt from the score
multiplier, because it is not earnings: the multiplier prices what you did,
and nobody did anything.

**Verification.** Sixteen new tests, and a live socket run of both paths: with
the flag, the client builds the room, spawns on its doorstep and collects a
tank, six cars, a bus and the cash; without it, a client asking for a tank on
a normal server is told "no such item" and no tank appears.

**Least confident about.** The room is a carved shop interior, so it is as big
as the building that happened to be nearest — usable, but not a hangar. Free
cars in a session anyone can join is a real hazard and the only thing standing
in front of it is the env var being off by default and a loud line at startup.

## The tank drives over cars

564 tests green (up from 542; 22 new). 8-bot brawl and joyride lockstep, 0
desyncs, replay re-simulates hash-identical.

A tank flattens anything lighter than a truck and keeps going; the car it
drove over explodes on the spot; the tank and whoever is inside it are
untouched by the blast. Anything its own size or bigger — truck, fire engine,
bus, garbage lorry, digger — stops it dead, exactly as another car would.

**A threshold, not a list.** `crushesBelowMass: 2.0` on the tank, and nothing
else in the game has the key at all. 2.0 sits in the gap between the heaviest
thing a tank flattens (an ambulance, 1.5) and the lightest thing that stops it
(a truck, 2.2), so it stays a fact about weight and any vehicle added later
sorts itself without anyone editing a list of kinds.

**The half that has to be predicted.** Whether the tank STOPS is a pure
function of the two kinds' tuning, so the client decides it identically — get
that wrong and the tank halts on one host and drives on for the other, and
every crushed car costs a car-length correction: precisely the disagreement
the lag-compensation work exists to remove, reintroduced by a feature. What
stays server-side is the car's fate. The same rule that keeps a tank from
being blocked by a live car also keeps it from being blocked by the wreck it
just made, which would otherwise leave it sitting on top of its own kill.

**Destroyed through the ordinary path, detonated early.** `damageVehicle` for
exactly the car's remaining health, so ignition, the arson charge and the
`vehicleBurning` event happen the way they do for any other kill — then set
off immediately rather than on the seven-second burn fuse, because a fuse
would put the fireball somewhere behind you long after the thing that caused
it. It cannot recurse: a blast only ever *ignites* what is around it, so the
depth is one. Crushing is charged as arson rather than as a traffic accident,
which is the opposite of the call made for an ordinary shunt and for the same
reason — there, nothing at the call site can tell a deliberate ram from a bad
line through a junction; here there is nothing to tell apart.

**The shield covers the crew.** `blast` gained a shielded vehicle, and it
spares anyone riding in it as well as the bodywork. The first version shielded
only the hull, and the tests caught what that meant: the tank survived the
line of cars and the driver did not, so the tank coasted to a halt with a dead
man at the controls two cars in. "The tank is not damaged" has to mean the
tank, not its paint.

**What still scratches it, honestly.** Every blast the tank CAUSES is
shielded. A parked car close enough to catch fire from one of those blasts
goes up later on its own fuse, and by then it is an ordinary exploding car
that happens to be near a tank: eight cars in a row cost ten points of 1600.
Left that way deliberately — the alternative is making a tank blast-proof
against everything, which is a much larger claim than "crushing is free".

**Verification.** Nineteen new tests: each light kind flattened and each heavy
kind stopping it, with the blocked cases asserting the tank actually REACHED
what stopped it; the car reaching `wreck` without ever being observed
`burning`, which is what distinguishes exploding on the spot from smouldering
on a fuse; a line of eight; a car proving it cannot do any of this; and the
client-mode prediction pinned directly by running the shared step with
`sim === null`, which is exactly what the predictor passes.

**And it costs you something.** Driving over a car with no momentum lost read
as weightless, which was the one thing flagged as unresolved above and turned
out to be right. `crushSpeedLoss: 0.96` — speed kept per TICK while grinding
over something, not the flat one-off a prop takes (`props.crashSpeedLoss`,
0.92). A bollard is a discrete thing you smash through; a car under a tank is
62 px of obstacle you are on top of for most of a second, and charging by the
tick needs no memory of which cars have already been paid for, which is what
lets both hosts agree without a byte of new state on the wire.

Swept, not guessed: 0.98 dips to 98% of top speed and cannot be felt, 0.95
halves it, 0.92 slows the tank so much it fails to reach the sixth car in the
line at all. 0.96 gives a 25% dip for a single car with full recovery on the
far side, and a continuous plough through a row of them settling near 60% —
slower going, which is what it should be, rather than a crawl.

It cannot pin the tank, and that is arithmetic rather than luck: drag takes
`speed * 0.04` per tick while the throttle puts back a flat `accel * DT`, so
the two meet at 63 px/s and the tank always grinds through. A tank that could
be stalled by parked cars would be a tank you could trap.

The drag runs on BOTH hosts, and that is the whole reason `crushUnderneath`
became `driveOverCrushables`: the slowdown is part of how the tank moves, so
the client predicts it, while the wreckage stays with whoever holds `sim`.
Splitting it the other way — drag on the server alone — would have the client
running ahead by the entire slowdown and being corrected for it once per car,
which is the same mistake as not predicting the pass-through, just quieter.

**Least confident about.** The 2.0 crush threshold is still a first guess at
where "bigger than a tank" should fall, and 0.96 is a judgement about feel
made against a speed trace rather than in a browser — both are one number in
`vehicles.json`.

## Colliders on one clock and one shape: cars, people, and a server that goes back and looks

542 tests green (up from 507; 35 new across three files). 8-bot brawl and
joyride harness runs lockstep with 0 desyncs at ~11 KB/s per client against
the 50 KB/s gate, corrections 2.65–3.03 px, replay re-simulates
hash-identical. Wire contract bumped to protocol 8.

Three separate faults, all reported as "the colliders still don't work
reliably", and they are three because a collider has three ways of being
wrong: the wrong shape, missing entirely, or right on one host and right on
the other about a different moment.

**A car hit you with a shape that was not a car.** `stepVehicleImpacts` — the
run-over test, and therefore every car-versus-person contact in the game —
used an axis-aligned square of `halfExtent`: 9 px, against a body 12 long and
5.5 wide, and it never turned with the car. So it was three pixels too short
and three and a half too wide at the same time. A bonnet buried a quarter of
itself in you before anything registered; a car in the next lane ran you over
from a clear three pixels off your shoulder; and on the diagonal it was wrong
by the whole difference between a square and a car. This is the same square
that was taken out of the car-to-car contact one release ago, still in place
on the path where a person is the one being hit — and it explains both
complaints people had, "it hit me and it was not touching me" and "it drove
through me". Everything now asks `bodies.ts` how big a car is: the contact,
the run-over, the props a car smashes, the traffic AI's obstacle model, the
shadow it casts, and the debug overlay, which draws the oriented box itself
rather than a picture of one.

**Nothing on foot collided with a car at all.** Not the player, not the
crowd, not the police: `stepPlayerMovement`, `stepPeds` and the officer walk
all collided against the tile grid and nothing else. You walked through a
parked car as though it were fog, and so did the queue of pedestrians at a
red light, straight through the bonnets. The most conspicuous solid object in
the game was the one thing you could not bump into. `pushOutOfVehicles`
resolves it as a push-out rather than a blocked move, for the same reason the
car-to-car contact allows any move that separates: a hard block traps anyone
who ends up inside a body — a car parking on them, a run-over knockback, a
spawn — with no legal position and every escape undone. Push-out always
reduces the overlap, so it always terminates. Velocity loses only the
component driving into the body, so walking along a flank slides; a push that
would put somebody inside a wall is refused, because pinned against a car is
better than extruded through a building.

**And the two hosts were judging the same contact at different moments.**
This is the one the last release left standing and named as the remaining
trade: the client draws remote cars `INTERP_DELAY_TICKS` (~100 ms) in the past
and collides against exactly those positions, because a collider that
disagrees with the sprite is one you cannot aim. The server has no such delay.
Add half a round trip and the same bumper sits three or four ticks — most of a
car length at road speed — apart on the two clocks. Tailgating, the client
stops against a car the server still has down the road, gets pushed forward,
and re-predicts the same contact next tick, for as long as you follow
anybody. Head-on it fires the other way and yanks you backwards into a crash
you had not had yet.

Neither host is wrong; they are looking at different moments. So the client
now says which moment: `InputIntent.viewTick`, its render clock in fractional
ticks, quantised to the same 1/256 grid the wire carries. The server keeps
`MAX_REWIND_TICKS` of vehicle poses in `state.vehicleTrail` — server-only sim
state, like `trafficDrivers` and `vehicleHitTick`, off the snapshot diff and
off the desync hash — and reconstructs that moment with the same lerp the
client's interpolator uses, over the same two ticks, so in the ordinary case
the two views are the same numbers. Detection rewinds; the RESPONSE — the
shove, the damage, the wreck — still lands on the live car, which is what
keeps this lag compensation rather than time travel. `viewTick` arrives over
the wire, so it is clamped rather than trusted, and 0 means "no opinion" and
gets the present: bots, tests and a browser's first second are unaffected.

Measured on a tailgate at city speed with one tick of wire latency, running a
real `Predictor` against a real `step()`: worst correction **8.125 px without,
0 px with**.

The price is the standard one and worth naming: the car that gets shunted
was, on its own screen, slightly past the point of impact, so it reads as a
late nudge. The alternative is what the game did before — the driver who
aimed the shunt misses, and gets corrected for it.

**Verification.** New: the box is 12 by 5.5 and not a 9 px square, and the
same spot is a hit head-on and a miss broadside; walking into a parked car
stops at its flank; a car that parks on top of you pushes you out instead of
trapping you; a push into a wall is refused; walking along a flank keeps the
along-component; the crowd walks round cars; the push-out separates exactly
and is null when there is nothing to resolve; the rewind honours fractions of
a tick, clamps a client asking too far back, ignores cars that did not exist
then, applies the response to the live car, and keeps a bounded trail; the
server's rewound world reproduces the client's `vehiclesAsDrawn` to nine
decimal places; and the tailgate scenario above, which fails on the old code
with an 8 px correction.

**One defect found by verifying, not by testing.** The broad-phase reject
that keeps the trig off ten thousand pairs a tick was written as
`halfLength + radius` — and a box reaches `sqrt(hl² + hw²)` from its centre,
not `hl`. So two cars meeting corner to corner (centres 25.28 px apart,
genuinely overlapping) and anybody standing against a car's corner (18.6 px
from its centre, genuinely touching) were thrown away before the real test
ever saw them: a new missed-collision bug, inside the change that exists to
fix missed collisions, in the one piece of it written as an optimisation
rather than as behaviour. Both sites now use `halfLength + halfWidth`, which
is exactly the reach `boxesOverlap`'s own broad phase uses — so hoisting the
test in front of the trig provably cannot change an answer. Two regression
tests pin it, and both fail on the code as first committed. The first draft
of the car-to-car one passed against the bug because it staged the cars at
the origin, where the map edge is solid and a WALL hit was what stopped
them; it is now staged mid-field, and that trap is written down in the test.

**A second defect, found by asking about tanks.** Making people solid against
cars has a consequence the change did not follow through: you now stand
against the BODYWORK, and `tryEnterVehicle` measured the door from the
vehicle's CENTRE. A bus is 42 px long, so its bumper is 21 px out and the
push-out leaves you at 27.1 — outside the 26 px the door reached, with
nothing you could do about it. The bus and the garbage truck became
unboardable from directly in front or behind. The tank, the vehicle the
question was about, survives at 25.1 with nine tenths of a pixel to spare,
which is luck rather than design. Nothing caught it: no unit test walks up to
a bus, and the bot harness scripts never board one either.

The door is now measured from the bodywork (`distanceToBox`), which is what
"how close am I to that car" should always have meant — a fixed
centre-distance gets stranger the longer the vehicle is. `enterRadius` is
renamed `enterReach` rather than retuned, so nobody reads the smaller number
as a shorter reach: 20 px past the panels is 25.5 from the centre of a car's
flank, where 26 from the centre used to be, and 41 from the centre of a bus's
nose, where 26 never reached the paint at all. Carjacking uses the same door
and the same measure. Every land vehicle is now boardable from all eight
approaches, pinned per kind by a test that is red on both of the previous two
commits.

**On probes that agree with you.** The first version of that boarding probe
reported every vehicle unboardable from every angle — including on the code
from before any of this work. It walked for a fixed ninety ticks and pressed
E once at the end, so the player slid past the car and pressed from 160 px
away. Two earlier drafts of the corner-contact tests had the same shape of
flaw: staged at the origin, where a car's near side is outside the map and
therefore solid, so a WALL hit was what stopped the car and the test passed
against the bug it was written for. Three times in one change, a test agreed
with the code for the wrong reason. Every regression test here is now checked
red against the commit it was written to catch.

**Least confident about.** The 1/8 px separation skin is set to one step of
the `q8` grid because exactly flush does not survive the round trip through
the deterministic trig table and the position quantiser — sound, but it is the
kind of constant that wants a second pair of eyes. Bullets and blasts still
treat a car as a circle (`vehicleHitRadius`), which is now the last place the
game disagrees with itself about how big a car is; it is left alone on purpose
— that radius is tuned into weapon ranges, blast falloff and mine clearance,
so changing it is a weapons change with a tuning pass attached, not a collider
fix. And lag compensation has only been measured in the harness and in tests,
never against a real link with real jitter.
>>>>>>> origin/main

## Worldgen: quays line the waterways, and a drowned road end is tested

325 tests green (three new); brawl 45 s PASS, 0 desyncs. Seed-breaking
for waterfront tiles.

**T_BANK.** Every open tile beside waterway water becomes an
embankment/quay: walkable stone waterfront, solid to boat hulls (it is
what a hull moors against), never built on. Stamped after the bridge
fixup and before block fill, so every fill pass treats the quay like
water and keeps buildings, sidewalks and yards off it — the first
transition band of WORLDGEN.md §9.4's water ladder, made real. Bank
adjacency is tested on the water FIELD, not the window arrays, so the
strip is window-independent (the overlap invariant covers it
automatically). Moorings count the quay as boardable land; landmarks
refuse footprints touching it; park ponds stay bare (decoration, not
waterway). Rendered as flat stone with a lighter coping course along the
water's edge, on the radar as a light outline around the blue.

**Pinned:** waterway water may only touch water, bridge, bank, or the
stub of a drowned road — nothing else, asserted per-tile (`water.test`);
the quay is open to feet and solid to hulls, every bank tile; and the
previous entry's flagged gap — a car sent up a drowned road end backs
out and leaves rather than wedging at the bank (`traffic.test`, staged
on found geometry).

**Least confident about.** The quay is one tile wide by construction; a
window whose rim slices along a waterfront can show a quay strip against
the window wall with nothing behind it — harmless, rim-only, but
unswept.

## Worldgen: bridges are crossings, not causeways

322 tests green (two new); brawl 45 s PASS, 0 desyncs. Seed-breaking for
bridge/water tiles only (`water.maxBridgeSpan` added to params).

The unbounded-world bridge rule was "arterial over water ⇒ bridge", which
had two failure modes the renders made obvious: an arterial running
LENGTHWISE over a river became a causeway that roofed the waterway for
dozens of tiles, and wide water got crossed as casually as a ditch. The
rule is now span-limited and axis-aware: `arterialMask` records which
axis carved each tile (`ARTERIAL_VERTICAL`/`ARTERIAL_HORIZONTAL`), and a
tile bridges only when the water span measured ALONG that road's
direction of travel is ≤ `maxBridgeSpan` (20 — chosen by measurement:
at 16, seed 7's oblique crossings left its whole window bridgeless).
Spans are measured on the water FIELD, not the window arrays, so the
decision stays identical from every viewport. Where the span is too
long, the road now stops at the bank and the boat is the way across —
wide water is finally a real barrier.

Boats under bridges needed no collision change — `isSolidTile` has
carried "bridge: road on top, navigable water underneath" since D1 and
there is no boat AI probing tiles — but it was only tested for one tile
on one seed. Now pinned for every bridge tile across three seeds, along
with the anti-causeway invariant: every interior bridge tile belongs to
a crossing ≤ maxBridgeSpan along some axis, five seeds.

**Least confident about.** Interrupted arterials (a road that dips into
a lengthwise river stretch now dead-ends at the bank, resumes beyond)
rely on traffic's existing stuck-recovery to turn cars around at the
water's edge; the bot gates pass but no test pins a car's behaviour at a
drowned road end specifically.

## Worldgen: the unbounded world (WORLDGEN.md §10)

The map is now a WINDOW onto an infinite design. 320 tests green (up from
316) including the new window-independence invariant; 8-bot brawl 60 s:
0 desyncs, tick spread 0, ~15 KB/s per client; joyride PASS; replay
re-simulates hash-identical. A 240² window generates in ~125 ms wherever
it sits — `mapgen --seed=7 --wx=1000128 --wy=-777600` renders a full city
a million tiles from the origin at the same cost as the origin.

**The rule that makes it work: no pass may depend on the map's extent.**
Arterials are an infinite jittered lattice (`arterialCoord(seed, axis, k)`
— line 40 000 is as cheap as line 4); the ground between them divides into
CELLS, and each cell's subdivision, blocks, buildings, landmark and shops
derive their rng from `hash(seed, cell index)` in global coordinates.
Density traded its single core for an infinite lattice of hashed city
cores with open country between (`fields.ts: cityCore`); the sine-meander
river became noise-contour waterway bands (rivers, lakes, loops — arterial
crossings still bridge, secondaries still revert). Ramps went
position-hashed because they mutate tiles and an every-Nth counter would
have made tiles a function of the window.

**Proven, not claimed** (`windows.test.ts`): overlapping windows of one
seed agree tile-for-tile in the overlap interior; a window at a million
tiles is a real city with hospitals; negative coordinates work; distant
windows differ. The rim is the documented edge effect: carving passes
skip footprints not fully inside their own window, so views may differ
within one cell span of a window edge — never deeper.

**Quotas became coverage lattices.** "4 hospitals per city" is
meaningless on a plane, so hospitals and police stations claim every
second cell each way (offset apart — the §6.2 coverage doctrine, now
structural), and each shop kind gets a lattice whose pitch derives from
the old quota. A respray that cannot open its two-tile garage door now
walls itself back up and tries the next building rather than shipping a
garage for pedestrians (previously the quota retry loop hid this).

**CityMap consumers never learned.** Window-local coordinates throughout;
sim, prediction, codec, client and bots untouched. `worldgen.json` gains
`windowX/windowY`, `arterialSpacing` (replacing arterial counts),
`fields.citySpacing`, and `water.scale/width` (replacing `waterWidth`).

**The gate that argued back.** Brawl runs tripped the harness's 96 px
prediction-correction limit (113–229 px) with zero desyncs and clean
replays. Diagnosis across five runs: spikes only on bots being rammed by
cruisers in 30-kill four-star brawls (a low-kill run: every bot ≤ 3.1 px;
the previous world already showed 45 px). A ram is a server-granted shove
the predictor deliberately does not guess at (`prediction.ts` contract),
and the new world's long countryside arterials let cruisers reach full
speed before impact. Limit recalibrated to 256 px for brawl with the
reasoning in `harness.ts`; desyncs remain the hard gate.

**Replay note:** every seed's city changes shape again, and the params
file shape changed — old replays and stale bundles fail loudly, by
design. Declared, as ever.

**Deliberately deferred.** Playable streaming (the window still has
walls): chunk-backed CityMap queries, population that follows players,
per-region respawn/turf. Countryside is stubbed as park blocks with the
full secondary grid — it reads as "green city", not open country, until
§8's nature work (dirt tracks, suppressed subdivision, forests) lands on
this substrate.

**Least confident about.** The rim edge-effect margin (one cell span) is
argued from construction and held by two seeds' overlap tests, not
exhaustively swept; and the brawl correction ceiling is now generous
enough that a genuine prediction regression under 256 px would slip it —
the systemic signal (corrections on EVERY bot) is what to watch in
harness output, and a dead-reckoning pass over snapshot vehicles is the
principled fix if rams ever need predicting.

## Worldgen: hierarchical seeding and the field-scored city (WORLDGEN.md §9.5 steps 1–2)

The first two steps of the layered-architecture migration. 316 tests green
(up from 310), 8-bot brawl 60 s: 0 desyncs, tick spread 0, ~13 KB/s per
client against the 50 KB/s gate, replay re-simulates hash-identical.
Generation is 99–154 ms at 240² (was ~56 ms; the classifier samples three
noise fields per tile).

**Hierarchical seeding.** `deriveSeed(seed, label)` (FNV-1a + avalanche,
integer ops only) gives every worldgen pass its own rng stream —
`worldgen.river`, `worldgen.roads`, `worldgen.blocks`, `worldgen.landmarks`,
`worldgen.shops`, `worldgen.vehicles`, `worldgen.playerSpawns` — replacing
the single thread that made any added draw reshape every city. The standing
`ROADMAP.md` risk "RNG-order churn invalidates old replays: any phase adding
a draw" is retired for cross-pass effects: a pass can now grow draws freely
and only its own output moves. Pass order stays load-bearing for data
dependencies only.

**Fields and classification.** `world/fields.ts` is L0 of the layer stack:
integer-hash value noise (same mixing family as turf's `hash2`, no
transcendentals, bit-identical on every host) shaped into `density` (radial
falloff from a seed-jittered core + noise), `wildness` and `grit`
(noise + map-edge affinity). `districts.ts` now *scores* these instead of
painting nearest-Voronoi-seed patches: density thresholds give downtown →
commercial → residential as concentric rings around a core that is visibly
the centre, the rim splits industrial/residential on grit, and wildness cuts
park pockets anywhere outside the core. Rendered across seeds 7/42/1234/
90210: every city now has a legible downtown, a commercial ring, industry at
the edges, and no colour confetti. Borders are noise-ragged, never straight.

**The knife-edge the new maps exposed.** Police on foot stopped closing at a
flat 24 px, but `bustRadius` is 22: an officer who had finished approaching
stood half a pixel outside hands-on range and shot a stationary suspect
forever. Old maps passed the arrest test because the last 4 px stride
happened to land inside the window; the first new map parked all six cops at
22.5 px and the test went red. The standoff is now `bustRadius - 2` — the
sim change this wave makes besides worldgen, and it makes "stand still and
you get nicked, not shot" true by construction instead of by luck.

**Test staging hardened.** `straightEastLane(map, run, width)` in
`test/helpers.ts` finds a junction-free straight corridor with unbroken
kerbs (the old `eastboundLane` wanted an exactly-two-tile road — a rare
generator accident — and only checked for cross-streets at the start tile,
so ambient drivers could turn off mid-test). The cruiser U-turn test stages
on a 4-wide arterial stretch because a 3-wide street boxed in by buildings
is a three-point-turn problem; the walk-into-the-river test now picks a
water tile with a walkable bank instead of assuming the first one in
row-major order has one; the hard-coded `{x:1000, y:1000}` police staging is
gone. New `fields.test.ts` pins: noise determinism/bounds, density
core-to-rim gradient, all five district types present on every seed,
downtown mean distance-to-core below industrial's, ≥75 % neighbour agreement
(the anti-confetti bar turf already uses), and stream independence.

**Replay note** (per the risk table): every seed's city changes shape —
district layout, therefore roads, buildings, spawns, everything. Replays
recorded before this wave no longer re-simulate. Expected, deliberate,
stated. `worldgen.json` loses `districtSeeds`, gains `fields`
(thresholds + noise scale); the params parser hard-fails on the old file
shape, so a stale client bundle cannot silently generate a different city.

**Deliberately deferred.** Steps 3–6 of the migration (transition
ladders/ecotones, the road graph, parcels with frontage, content-layer
queries); density modulation of `fillBlock` coverage and amenity spacing
(the field exists, consumers still read district type); `mapgen --layer`
debug rendering; any map-size change.

**Least confident about.** The classification thresholds (`fields` in
`worldgen.json`) are tuned by eye against four seeds; a pathological seed
could still produce a lopsided city — the invariant tests bound presence and
contiguity, not beauty. And the cop-standoff change alters every chase's
approach geometry by 4 px; the police suite is green but that mechanic has
more tests than any other because it keeps deserving them.
## The turret: a part that does not turn with the body

Asked whether a tank's turret traverses independently, the answer was no —
`SpriteSheet.draw` picks ONE baked rotation frame per sprite, so anything
drawn as a single sprite can only ever point one way, and `fireCarGuns` shot
down `v.heading` on purpose. Both halves of that are now conditional on one
number.

**A second sprite is the whole mechanism.** `tank` is the hull, tracks and
ring; `tank_turret` is the barrel and the hatch, pivoted at `[13, 13]` — the
ring, not the sprite's middle. The renderer draws them at two different
angles about two different centres, and the ring centre is carried round with
the hull (`wx + cos(heading) * turretOffset`) so the gun stays bolted to the
tank however it is parked.

**It costs no state and no bytes.** A turret points where its driver is
aiming, and a driver's `aimAngle` is already on the wire for every player,
already interpolated, already hashed. So `turretAngle(state, v)` is a
derivation, not a field: no snapshot entry, no codec change, nothing to
desync, and the six touch points an entity field would have cost are all
untouched. The renderer's `aimOf` is the same rule read off the smoothed view
instead of the authoritative state, which is what makes the barrel move at
frame rate rather than in 30 Hz steps.

**One number decides both halves, so they cannot disagree.**
`turretOffset` in `vehicles.json` is null for everything without a turret; it
is what the gun asks and what the renderer asks. A test walks it in both
directions — every kind with an offset has a `_turret` sprite, and every
`_turret` sprite belongs to a kind with an offset — because the two halves
live in different files and either one alone is a tank with an invisible gun.

**The digger's boom does not slew, and that is a decision rather than an
omission.** A real excavator's does, but nothing here would drive it: the
digger carries no weapon, and the only aim signal in the game is a weapon's.
Giving it a traverse means either inventing an input or borrowing the gun's,
and borrowing the gun's is exactly the disagreement `turretOffset` exists to
prevent. The tank gets one because its gun is a weapon and the aim already
exists.

## Waves J–O: the whole of GAPS.md, sixteen items

Every gap `AUDIT.md` found, closed. 402 tests green (up from 294), 8 bots
lockstep with 0 desyncs at ~14.6 KB/s per client against the 50 KB/s gate,
`persistCheck` passes. The audit's second pass reads 163 built / 10 partial /
1 not built, from 126 / 17 / 32.

The plan is in `GAPS.md` and is kept as written; this is what the build
learned that the plan did not know.

**Anything that can be a formula over `tick` should be.** Traffic signals
(J1) and the day/night clock (L1) hold no state at all: the phase and the
hour are pure functions of a tick that is already shared, already hashed and
already in every snapshot. Zero wire bytes, nothing to desync, and two
players stopped at the same junction see the same red because they compute
the same number rather than being told it. This is now the first thing to
reach for when a new system needs a value everybody agrees on.

**Presenting a new constraint to an existing model beats adding a rule.** A
red light is handed to the car-following model as a stationary obstacle at
the stop line, not as a second braking rule — which is why it did not repeat
the gap-acceptance experiment recorded in `traffic.ts`. The same shape
recurs: barrels (K2) reuse the projectile table as a deferred detonation, and
a tank (M1) is a chassis carrying the `guns` fitting the garage already
sells. If a tank had needed its own code path, G2 was not built generally
enough; it did not.

**Units are load-bearing, and measurement is the only way to find out.**
`Ahead.gap` is bumper-to-bumper everywhere in the traffic model, and J1 first
returned a centre-relative stop line. Cars parked with their noses in the
box, blocked the cross axis, and deadlocked the junction: dwell on junction
tiles went 4% → 20% of samples. Nothing about the code looked wrong.

**A metric written before a feature can stop measuring what it meant.** The
traffic census caught wedged cars by the proxy "most cars are moving", and
signals broke it — they add two lawful reasons to be stationary, and the
second (queuing behind somebody at a red) is invisible from outside the car.
It measures wedging directly now, from the sim's own patience counter. The
temptation was to lower the threshold; the honest fix was to measure the
thing the test was written for.

**Three tests caught design errors rather than bugs.** N1's escape mission
would have let you drive to the marker clean and wait — it needed a `primed`
flag, so getting hot is part of the job. M2's first version gated *all* heat
on a witness, which quietly made the police system optional; four existing
tests refused it, and noise became additive instead. And the ledger-chokepoint
guard in `economy.test.ts` caught L2's package reward bypassing the
multiplier — deliberate, but it forced the reason onto the record.

**Attribution turned out to be the recurring theme.** K1 found that a car's
blast was credited to whoever was at the wheel, so torching a bus at a stop
charged the driver with the bodies. K3 carries the arsonist down a chain, so
a fire cannot launder itself. J4's most important test is that a gang member
shot by another gang member credits *nobody* — otherwise standing in the
right postcode is an earning strategy. O1's cash drops route through the same
capped chokepoint as everything else, and the test that matters is that ten
minutes of shooting pedestrians loses to one mission.

**Three shared-world calls that the originals never had to make.** Hidden
packages are per-account, not per-world (L2), or every one is found in the
first hour. Districts gate services rather than geography (L3), because
locking a district locks it for whoever is standing next to somebody already
inside it. And mission chains are per (player, gang) and four links long,
because a twenty-mission chain is a commitment a persistent world cannot let
you pause.

**Ordering traps, twice more.** Parking is placed before turf exists, so
marking gang cars there marked every car as nobody's; it happens inside
`assignTurf` now. And the prop list is decimated to a ceiling, which does not
know that barrels are gameplay and lamp posts are decoration — the first
attempt left two barrels in one city and none in another.

## What a body looks like, and what the blood does

Two questions about the same picture. 332 tests green; this is all renderer,
no sim behaviour changed except one event gaining a position.

**A body was the wrong shape.** It was the standing sprite squashed along the
SCREEN's vertical axis, which is wrong in a way that is obvious once said out
loud: which way the screen happens to be pointing has nothing to do with which
way somebody fell. A body that went down facing east was squeezed across its
own waist and just looked like a smaller person standing up. From above, a
standing person is a compact blob — head, shoulders, the tops of the feet —
and somebody on the ground is that same person seen along their whole length.
So the stretch is applied in the BODY's frame now: half again as long
head-to-toe, a little narrower across, lying down the axis they fell along.
The sprite still uses its own baked rotation; the context is rotated, scaled
and unrotated around it so nothing is rotated twice.
`evidence/street-blood-1-spray.png` is the difference.

**The blood didn't do anything.** Ten droplets sprayed out and evaporated in
mid-air while three stains appeared instantly on the ground beneath them,
unrelated to any of the droplets and at full size from the first frame. Three
changes, each cheap:

- Particles can now `settle` — a droplet lays a small mark where it comes to
  rest, so the arc of stains on the ground IS the arc the blood took. The
  ones thrown hardest travel furthest and leave the finest marks.
- Decals can now `spreadSec` — a stain eases out to full size instead of
  being stamped. Blood spreads; a mark that is already finished when it
  appears reads as texture that was always there.
- The pool under a body grows with the body's AGE, which every kind of body
  already carries: a pedestrian's `timer` counts down, an officer's
  `idleTicks` counts up, a player's `respawnAtTick` counts down. Deriving it
  means a corpse that comes into view a minute after it was made arrives with
  a finished pool rather than starting to bleed on sight. It is three hashed,
  overlapping blobs down the body's axis rather than one ellipse — a single
  ellipse is the shape of a thing that was printed, not one that leaked.

**And the commonest killing in the game threw no blood at all.** `shot` says
where a round stopped, never whether it stopped in a person or a wall, so
shooting a pedestrian produced sparks off stone and nothing else — only
player kills and run-overs ever bled. `pedDown` and `copDown` now carry the
position they went down at. Protocol 7.

**Least confident about.** The pools are on the generous side at play zoom —
three bodies together make a sizeable red mass — and `MAX_DECALS` went from
220 to 460 to stop a firefight evicting every tyre mark in the district,
which is headroom bought rather than a problem solved.

## The ambulance turns out

The city had an ambulance JOB and no ambulance SERVICE. One pedestrian "kill"
in `downOneIn` leaves somebody down but alive on a 45-second bleed-out clock,
and the only thing that could ever do anything about it was a player who
happened to be driving an ambulance and happened to be looking — so in every
session where nobody was playing that job, every casualty ever produced died
on the pavement. `jobs.ts` even said so in a comment: *"NOT built: ambulances
that turn out on their own. That needs an AI driver with a destination, which
the traffic layer does not have a notion of yet."* The traffic layer has had
`assignGoto` since the car-AI work; this is the thing it was for. 332 tests
green (up from 324), 6-bot brawl lockstep with 0 desyncs, replay
hash-identical.

**What it does.** A casualty who has been down for `responseDelaySec` and whom
no player-driven ambulance is closing on gets a van sent to them: the nearest
kerbside spot to the scene that is far enough from every player that nobody
watches it appear, driving on `assignGoto`, parking on `holdAt`, treating for
`treatSec` and putting them back on their feet at full health. Miss the window
and they become a body like any other — the failure has no event of its own
because it is just the bleed-out clock running out. The whole of the
bookkeeping is `GameState.ambulanceCalls`, which never goes on the wire, for
the same reason `trafficDrivers` does not: what a client sees is a van pulling
up and somebody getting up.

**It must lose the race to a player.** The job is the better content and keeps
first refusal: the service waits six seconds before noticing anybody and
stands off any casualty a player-driven ambulance is within `playerClaimDist`
of. What it takes away is not the fare — it is the certainty that an unclaimed
casualty dies.

**Two new primitives in the traffic layer, and one de-duplication.** `holdAt`
parks an AI driver where it stands (a new `tend` mission) — without it,
arriving reverts the driver to cruise and it simply drives off again, which is
no use to anything that needed the car to BE somewhere. `aiSpawnPlacement` /
`putAiVehicle` are the ambient spawner's own lane-placement and rolling-start
logic, lifted out so dispatch gets it too, plus a `prefer` bearing so a van is
put down facing the call: one facing away has to complete a U-turn first, and
a U-turn is taken at `turnSpeed`. A driver on a `goto` now presses on at
`panicSpeed` rather than ambling at `cruiseSpeed`, because an ambulance
answering somebody bleeding out at 62 px/s arrives after the funeral.

**Three things measured in a live session, not guessed.** Over ten seeds with
a casualty put down near the player: routing straight at the casualty found no
route at all in three of them — `planRoute` only snaps a destination onto the
road grid within three tiles, and a ped who has wandered into a plaza is
further than that — so dispatch silently did nothing, *after* turning a van
out, leaking an ambulance per attempt. Dispatch now picks the nearest drivable
tile within `crewReach` and routes there, and checks the route before anything
is created. Sending the van from the nearest hospital read beautifully and
played terribly: the hospital is routinely most of a kilometre from the
accident and the van spent the whole clock in traffic, so it is the nearest
unit that goes. And a van can wedge — nosed into a gap it cannot take,
reversing, trying again — which is bounded for a car with nowhere to be and
unbounded for one under orders; a call that stops making progress is abandoned
and remembered for five seconds, so the next attempt comes from a different
street. Nine casualties in ten are now reached, at a mean of twenty seconds
into a forty-five second clock.

**And then it was looked at.** Everything on this branch that draws — the
bodies, the dropped guns, the van — had been shipped unverified, twice
flagged as such. A scratch scenario server (`index.ts`'s own boot, holding the
Session) staged casualties around whichever browser turned up, and the
screenshots are in `evidence/`. Two things came out of it. The van reads
exactly as intended: it drives in, parks on the road beside the scene, and the
patient gets up. And a casualty was drawn identically to a corpse — which was
harmless when nothing could be done for either, and wrong the moment an
ambulance was on its way to one of them. `drawBody` now takes an `alive` flag:
a body is flat, drained and still; a casualty keeps its colour over a smaller,
fresher pool and breathes on a slow sine. `evidence/street-down.png` is the
two of them side by side.

**Least confident about.** `crewReach` (180 px) is the number that decides how
much of "the ambulance came" is the van and how much is imagined paramedics:
it exists because a third of casualties are further than that from any road,
and it means the van can be parked most of a screen away when somebody stands
up. The one-in-ten failure rate is a judgement about how much tension a
casualty should carry, not a measurement of anything.

## Five reported bugs: colliders, boats, stars, bodies, and people who shoot back

Five things reported from play, fixed together because three of them are the
same complaint — the world does not keep what happens to it. 324 tests green
(up from 310), 8-bot brawl lockstep with 0 desyncs at ~13 KB/s per client
against the 50 KB/s gate, replay re-simulates hash-identical.

**Colliders were on a different clock from the sprites.** Remote entities are
drawn `INTERP_DELAY_TICKS` (~100 ms) in the past so they interpolate smoothly,
but the predictor collided the local car against `sync.latest` — the newest
snapshot, three ticks ahead of the sprite it belonged to. Every moving car's
collider therefore sat over half a car length down the road from the car you
could see: you crashed into empty tarmac and drove through the one in front.
`Interpolator.vehiclesAsDrawn()` now hands the predictor the same positions
the renderer is about to use. Parked cars — most of what anyone hits — are
identical on both timelines, which is why this survived so long.

**The server's input buffer only ever grew.** A client makes one intent a tick
and the server eats at most one a tick, so the rates match but the phases do
not: a tick that finds the queue empty consumes nothing (the last keys are
held) while the intent it was waiting for arrives and queues behind the next.
There was no path back down, so the buffer settled at the worst jitter the
link had EVER shown and stayed there — a fifth of a second of standing
latency, and at the `MAX_INPUT_LAG_TICKS` cap it silently dropped intents the
client had already predicted. `measureBacklog` watches the buffer's low-water
mark over a one-second window: depth that never got used is latency nobody
asked for, and it drains one intent per tick. A buffer that did run dry is
doing its job and is left alone.

**Getting out of a boat was impossible.** Not hard — impossible. A mooring is
a tile of open water in every direction by construction, a boat's hull holds
its centre 11 px off any bank, and the three spots a car steps into are all
inside `halfExtent + PLAYER_RADIUS + 11`. Every one of them was river, so
pressing E aboard did nothing, ever. Water craft now search tile CENTRES out
to four tiles, nearest first: a player box is 12 px across and a tile is 16,
so the centre of any non-solid tile is a spot you provably fit in — which a
ring of bearings does not give you, because it can thread between two
candidate tiles and report the whole bank as blocked.

**The wanted level survived your own death.** It was always per-player state
(`heat` on `PlayerState`, `wantedLevel` derived from it), but nothing cleared
it when that player died, so you woke up at the hospital still four-starred
with the same force re-acquiring on the spawn tick. `clearWanted` is now one
function used by the arrest, the respray and dying, and it releases the
officers already pointed at you as well as the stars.

**Bodies stay.** A pedestrian shot dead used to be erased on the frame it
happened; so did an officer. Both now lie where they fell for `corpseSec`.
Peds carry a `dead` mode; an officer needs no new field at all, because
`health <= 0` already rides the wire and is already hashed. A body is
scenery: shots pass through it, cars do not re-run it over thirty times a
second, traffic does not queue behind it, and it witnesses no crimes — that
last one mattered, since a corpse was reporting car thefts from the pavement.

**Some of the crowd shoot back, and their gun stays behind.** One pedestrian
in `armedOneIn` is carrying — a pure function of the id, like gang membership,
so it costs nothing on the wire. Shoot one and they do not flee: they hold a
grudge against whoever pulled the trigger for `grudgeTicks`, close, and fire.
The gang-hostility path and this one are now one shooter with two ways of
acquiring a target. Anybody armed who dies drops their weapon as a new
`weapon` pickup that can be picked up once and rots off the street; so do
police, which is what makes shooting back at them worth doing.

**Verification.** New tests: the boat exit across twelve moorings (ashore,
dry, within wading distance); wanted level per-player and wiped by death
through to respawn; armed peds returning fire while everyone else runs;
grudges lapsing; the dropped gun being collectable once and expiring; bodies
stopping no bullets; the interpolated collision world matching the drawn
world to the pixel; and the input buffer draining after a jitter storm — that
last one fails on the old code with the buffer pinned at 5 ticks for ever.

**Least confident about.** The rendering of bodies and dropped guns is drawn
rather than sprited (the same character sprite squashed towards the ground
over a pool, and a gunmetal bar) and has not been eyeballed in a real
browser — the sim behaviour is pinned by tests, the look is not. Colliding on
the render timeline is the right call for "you hit what you see", but it
trades against the server's own timeline: a fast head-on closing pair will
still correct, just in the other direction from before. `armedOneIn: 7` with
`gangPistol` is a first guess at how dangerous a street should feel.

## Car AI: drivers that react, and cars that can be sent somewhere

The top two recommendations of `CAR-AI.md` §7, plus the desync its
verification flushed out. 294 tests green (up from 288), brawl and joyride
harness runs lockstep with 0 desyncs at ~11–15 KB/s per client against the
50 KB/s gate, replay re-simulates hash-identical.

**Panic.** Gunfire and explosions now scare every ambient driver within
`panicRadius`: they floor it down the open cardinal pointing most nearly away
from the bang and stop taking the turn lottery until `panicTicks` runs down.
The stimulus pass runs after every system that can make a noise (traffic
itself steps before weapons, so a driver reacts one tick after the shot —
reflex delay by construction, not accident). Panic draws no random numbers
and lives in `trafficDrivers`, off the wire; a test pins both properties.

**The carjack victim exists.** `tryCarjack` now puts the ejected driver on
the pavement at whichever door opens, fleeing the carjacker — ROADMAP C2
specified it and it had never been built; the genre's headline verb played as
theft from an empty chair.

**Errand driving.** `TrafficDriver` gains a mission — `cruise` (the ambient
random walk) or `goto` (follow a planned route, then melt back into
traffic). `planRoute` (`roadgrid.ts`) is A* over drivable tiles with the open
list keyed on (f, tile index) packed into one integer, so ties resolve
identically on every host; routes come out as corner waypoints with bounded
spacing, because pure corners made every long straight read as "off the
plan" and re-planned the route into a livelock — caught by tracing the first
integration test, and the bounded spacing is the fix. The follower only sets
`driver.dir`; lane-keeping, IDM, junction traversal and stuck recovery are
untouched. Errand cars are exempt from the despawn ring, and panic outranks
the route (flee first, re-plan from wherever flight ended). `assignGoto` is
the API; nothing ambient calls it. This is the primitive the F–I entry below
lists under "deliberately not built" as the blocker for AI ambulances — that
notion now exists, and the consumers (ambulance, gang cars, mission targets)
remain unbuilt.

**The desync the harness caught.** First brawl run after panic landed: up to
26 hash desyncs per bot. Diagnosis: roadblock cruisers (C3, months old)
spawn at `c ± cos(across)·14` un-quantised and then never move, so nothing
ever rounds them onto the q8 grid the binary codec ships positions on — the
client's decoded copy disagrees with the server's by a fraction of a pixel,
permanently, and every hashed snapshot containing the car counts a desync.
Panic didn't cause it; panic escalated brawls to four stars reliably enough
to *expose* it (the pre-change baseline passes by luck — its runs never
threw a roadblock). Fixed at the spawn, same fix applied to the ejected
driver's door position, both pinned by grid tests. The lesson, stated for
the next spawn path someone writes: **anything that stands still is a wire
bug waiting to happen** — moving entities re-quantise every tick, parked
ones keep their birth coordinates forever.

**Replay note** (per the risk table): panic changes driver behaviour and the
rng draw pattern (panicked drivers skip `chooseDir` draws), so replays
recorded before this wave no longer re-simulate to their recorded hashes.
Expected, deliberate, stated.

**Least confident about.** Panic tuning is untested by play: 118 px/s for
seven seconds is plausible, not playtested. And `goto` has one integration
test driving 1.5 km of city; real consumers will find the cases it doesn't —
the repath threshold (8 tiles) in particular is a first guess.


## Waves F–I: the whole of FEATURES.md, twelve items

Score, arrest, escalation, the arsenal, vehicle classes, crushers, fittings,
turf, respect, missions, jobs and the radio. Twelve commits, each with its own
verification gate. 277 tests green across shared, server and client (up from
180), every bot run lockstep with 0 desyncs, ~10.5 KB/s per client against
the 50 KB/s gate — inside the ~2 KB/s the plan budgeted for the lot.

**The line that decided the architecture.** Every feature was sorted by one
question: does `step()` read it? Respect does — gang AI consults it every
tick — so it is sim state, in the hash and on the wire. Cash, the multiplier,
mission state, crusher payouts and fares do not, so they live server-side and
reach the sim only through recorded `SimCommand`s. Getting that split right
first is why none of this needed unpicking later.

**What was actually hard, in order.**

*Swept projectiles.* A rocket covers 14 px in a tick and a person is 8 px
wide, so testing only where it lands flew it clean through the target. The
fix reuses the two primitives the hitscan path already had. This was a real
bug found by a test, not a precaution.

*Worldgen passes feeding each other.* Registering hospital clinics before
`placeShops` made them count toward the keep-shops-apart rule, which moved
which buildings became shops, which moved their carved floor tiles, which
moved player spawns — and a test that punches somebody to death stopped
connecting. Twice now (police stations did the same to the chain-reaction
test) the lesson has been the same: a worldgen pass must not quietly change
the inputs of a later one, and `test/helpers.ts` exists because of it.

*Tuning drift.* Two separate times — cop speeds, then vehicle classes — the
first draft scaled from numbers that `main` had already deliberately changed,
producing a bus faster than a car. Both were caught by tests asserting
relative order rather than absolute values, which is the only kind of tuning
assertion worth writing.

**The mechanic this was all for.** Respect is zero-sum: helping one gang
costs you with their rivals, and there is no move that pleases everybody.
Its failure mode — a city that becomes unplayable through ordinary play — is
designed against rather than patched: standing decays toward neutral, it is
bounded at both ends, and hostility is *local*. A gang that hates you is
dangerous on their own streets and merely unfriendly everywhere else. The
test for that last one is the most important test in the wave.

**Deliberately not built**, and said plainly in the source where it matters:
AI ambulances that turn out to unclaimed casualties (needs an AI driver with
a destination, which the traffic layer has no notion of), and the fire truck
(extinguishing is the one job verb with no analogue here). Lives, level
targets and pay-to-save stay out for the reason `FEATURES.md` §6 gives: this
is a persistent shared city, not a level-based single-player run.

**Least confident about.** Balance, everywhere. Every number here — mission
payouts, respect thresholds, fitting prices, crusher rates — was chosen to be
plausible and internally consistent, not playtested. The ratios are more
likely to be right than the magnitudes.


## Slower, tougher cars, and a driver model out of the traffic literature

**Everything was too fast.** A car did 330 px/s across a 480 px viewport: 1.45
seconds from one edge to the other, so a driver saw about 0.7 s of road ahead
and was permanently steering into the half of the screen they could not see.
The whole speed domain is scaled by 0.6 — every accel, brake, friction and top
speed in the tuning, and the twenty-odd speed thresholds in code that have to
move with them (run-over, ramp launch, boarding, prop smashing, skid marks,
camera lead, pursuit U-turns). Scaling accel alongside top speed keeps
time-to-top-speed unchanged, so the cars feel the same, just not teleport-fast.
Two test fixtures had literal speeds baked in and now read them from the
tuning, so the next rebalance cannot quietly turn "it really drove" into an
assertion top speed cannot meet.

**Cars exploded almost immediately.** 100 health against 0.16 damage per px/s
of impact meant two hard shunts lit a car up and four seconds later it was
gone. Panel damage is a third of what it was, the shell is twice as tough and
the fuse is seven seconds: a car now takes a real beating, and you can run from
one that is alight.

**Damage you can see and feel.** A car one shunt from bursting into flames used
to drive exactly like a showroom one and look like it too. `vehicleWear` — a
pure function of health, so it costs nothing on the wire and cannot disagree
between hosts — now drives both. A battered car loses up to 45% of its power
and pulls to one side (which way is taken from its id, so it is the same pull
every tick rather than reading as ice), and the renderer crumples its panels
with dents keyed off the same id, clipped to the sprite with `source-atop` and
scorching the paint past half-wrecked.

**The blast radius was rectangular.** The damage falloff has always been a
circle; the scorch mark on the ground was a 111 px axis-aligned *square*,
because every decal in the game was a `fillRect`. Decals now have a shape:
tyre marks stay rectangles (they are one), blood and bullet holes are ellipses,
and the explosion scorch is a cached radial gradient drawn at the true blast
diameter — so the mark left behind is the area that actually hurt.

### The car AI, done the way the literature says

Three things separate real traffic simulation from what was here. Researched
first, then implemented and measured one at a time over twelve seeds.

**1. Car-following: the Intelligent Driver Model.** The driver was a bang-bang
controller — full throttle until something entered its braking distance, then
full brake — so it could not *follow* anything: it charged, stamped, rolled,
charged again. IDM asks for a continuous acceleration from the gap and the
closing rate:

    accel  = A * [ 1 - (v/v0)^4 - (wanted/gap)^2 ]
    wanted = s0 + max(0, v*T + v*dv / (2*sqrt(A*B)))

and that needed a real forward scan (nearest obstacle, its distance, and its
speed resolved onto our heading) in place of yes/no probes at fixed points.
Oncoming traffic falls out for free: its speed projects negative, so it is
braked for twice as hard as something slow going the same way.

**2. Junction traversal.** The lane model has a hole in it: measured across the
direction of travel, a junction is the width of the *crossing* road, so
`laneOptions` correctly refuses to answer and the driver had nothing to aim at
— it held its heading and cut every corner. It now walks forward to where its
lane picks up on the far side and drives at that, which is what a path-node
driver does when it reaches the end of a lane.

Together, over twelve seeds:

| | before | after |
|---|---|---|
| on the correct side | 94.5% | **98.4%** |
| worst seed | 92.9% | **96.8%** |
| head-on encounters | 6.3% | **1.0%** |
| traffic under way | 86.5% | **90.6%** |
| stopped | 9.6% | **4.1%** |
| reversing | 3.7% | **1.9%** |
| mean speed change per tick | 4.19 | **0.92** |
| self-inflicted collision damage | 0.022 | **0.0072** |

**3. Right-of-way — built, measured, and taken out again.** Gap acceptance at
junctions was implemented as the one rule that cannot deadlock: yield only to
traffic already *in* the box, never to traffic approaching it, and never once
committed yourself. It is worse on four metrics out of five (lane discipline
98.4% → 97.9%, traffic under way 90.6% → 88.4%, head-on 1.00% → 1.36%, off-road
0.74% → 1.2%). With IDM already braking for anything that enters the car's
path, the extra rule mostly stops cars that had no conflict — and a car stopped
at a junction mouth is one everybody else then has to negotiate. The finding is
recorded in the code so it is not re-derived.

It also found a real bug on the way in: `scanAhead` returned a shared
module-level `CLEAR` constant for the open-road case, and the yield rule folded
its gap into the result by assignment — so the first driver ever to yield wrote
a finite gap into the singleton and every "clear road" reading afterwards
reported a phantom obstacle. The city seized up, 13% of traffic under way
against 90%. It returns a fresh object now.

A sweep confirmed the rest rather than changing it: the IDM headway and comfort
brake are at the balanced point (a longer headway corners better but drops
traffic under way to 87%), and the pure-pursuit look-ahead and steer gain are
still best where they were — a shorter look-ahead won on six seeds and the win
did not survive twelve.

## Running where you point, and traffic that moves every tick

**Movement follows the mouse.** On foot the keys are now read in the frame the
player is aiming in: `up` runs towards the pointer, `down` backs away from it,
`left`/`right` sidestep across it. Screen-relative keys meant the two halves of
the control scheme disagreed — you pointed at a doorway, held a key that knew
nothing about the pointer, and the avatar left at whatever angle the two
happened to make. The body sprite is drawn at the aim angle for the same
reason: the facing IS the frame the controls are expressed in, so anything else
would leave the avatar pointing one way while `up` sent it another. Verified in
the browser: mouse north/east/south/north-west, hold `W`, travel direction
matches the pointer to 0°.

**Traffic stuttered because it only moved ten times a second.** Ambient drivers
thought *and drove* on a staggered 3-tick cadence: `stepTraffic` ran three
`driveVehicle` calls on one tick and skipped the next two. The average speed
came out right and the city still looked broken — a car under way did not move
at all on 66.7% of ticks and then jumped nine pixels, and those jumps land
exactly on the tick boundaries the client interpolates between, so no amount of
smoothing on the client could hide it. Routing still runs at 10 Hz (it decides
which way a car is going, not where it is); the wheel, the pedals and the
physics now run every tick. Stalled ticks 66.7% -> 0%, and the spread of
per-tick displacement drops from 1.47 to 0.20 of its mean. `blockedTimeoutTicks`
and `reverseTicks` are rescaled x3 because they now count real ticks, which is
what their names always claimed. On-foot officers had the same defect at
122 px/s and are fixed the same way; the 200-strong crowd keeps its 10 Hz,
which is where the delta-traffic argument for the cadence actually bites.

Lane discipline is unchanged at 90.4% over twelve seeds — the remaining 10% is
junctions and overtaking parked cars. Two attempts to improve it were measured
and thrown away: a longer or gentler pure-pursuit look-ahead is worse at every
setting tried, and so is forbidding a driver to cross the centreline for
anything that is still moving (lane discipline 90.8% -> 89.5%, head-on
encounters 4.2% -> 4.8%, traffic under way 81% -> 79% — cars that cannot flow
round each other queue, queues wedge, and the recovery manoeuvre costs more
position than the overtake did). Both findings are recorded in the code so the
next person does not re-derive them.

**Punching drew a bullet tracer.** The melee fix went into the effects layer but
not into the HUD, which drew a tracer for every `shot` event — and the sim
reports a punch as a `shot`. So a swing put a yellow bullet line and a puff of
smoke on the end of the player's fist, which is exactly what it looks like when
you shoot. The HUD no longer decides for itself: `Hud.tracer()` is called by the
event handler, which is the only place that knows which weapon threw the event.
Counted in the browser by instrumenting `stroke()`: 48 tracer strokes over four
seconds of punching before, 0 after.

## Wider side streets

A two-tile secondary road is 32 px and a car's collision box is 18, so two
cars could not pass each other on any side street in the city: every parked
car plugged its road, every meeting was a standoff, and about half of all
ambient traffic was stationary in a busy neighbourhood however the parking was
arranged. `secondaryWidth` is 3. Over six seeds with a crowd and 48 parked
cars, traffic under way goes 57.5% -> 66.8%, and the worst neighbourhood 44%
-> 54% — the point being not the average but that a bad draw is no longer a
car park. Block sizes grow to match, so the asphalt comes out of the road grid
rather than the buildings.

Two knock-on fixes: a cruiser now gets out and walks when the fugitive is
close but behind a wall (wider roads gave pursuit cars room to circle a block
for ever, never near enough to dismount and never blocked enough to give up),
and `openWater` joins `roadLane`/`clearSpot` in the test helpers, because the
boat test assumed the first mooring on the map pointed down the river.

## Deployment: reaching the right server, and not serving stale sprites

Found by running the container path locally — built client, served by the game
server, WebSocket on the same port. The static server sent no cache headers at
all, so a browser could hold the old `sprites.png` against the new
`sprites.meta.json` and draw every sprite from the wrong coordinates — the game
comes up corrupt for one person after a deploy that was otherwise fine. Fixed
names are `no-cache`; only the content-hashed bundles are immutable.

(`serverUrl()` picking `:8080` on a plain-http page is deliberate, not a bug:
that is the port the container publishes and the port local dev runs on. A
build served from anywhere else uses `?server=`.)

## Drive-bys, kerbside parking, impacts you can see, and rubber on the road

**Drive-by shooting.** `stepWeapons` gated firing on `mode !== 'foot'`, which
was the right call when there was nothing to shoot at from a moving car and is
not any more. A driver can now fire anything but their fists, the muzzle sits
outside the car's own body (otherwise every drive-by put its first round into
the door it came through, since the ray starts at the car's centre), the
shooter's own car is excluded from the ray, and firing one-handed across a
moving car costs accuracy in proportion to speed.

**Traffic brakes for people.** Drivers now stop for pedestrians, players and
officers on foot — but only inside the distance they can actually stop in,
which is a much shorter probe than the one they use for cars. Standing in the
road holds traffic up; stepping off the kerb in front of a moving car still
gets you run over. A driver waiting for somebody to cross gets three times the
patience of one nosed into a wall, because people move on their own and a car
reversing away from a pedestrian looks deranged. Pedestrians now also scatter
from a car that is right on top of them at any speed, not just from one doing
140+, so a stopped car moves them along instead of waiting forever.

**Run-over feedback.** A non-fatal car strike emitted nothing at all: the
victim's HUD flashed red and that was the entire outward sign. There is now a
`runOver` event carrying the point, the car's line and its speed, and the
client throws blood along it and plays a thud (synthesised from
`audio.json` like everything else).

**Parked cars.** Three separate problems, one of them embarrassing:
- The session took the first N of a row-major list, so every parked car in the
  city was in the map's top-left corner — jamming those few streets solid and
  leaving the rest of the city bare. They are sampled across the whole list
  now.
- They sat in the middle of the carriageway. `map.parkingSpots` is a new list,
  separate from the kerbside spawn points that cops, roadblocks and ambient
  traffic are drawn from (those must not move), with cars flush against the
  kerb where the road is wide enough to pass and half up on the pavement where
  it is not — a car is 18 px and a lane is 16.
- Traffic modelled one lane per direction, so a car parked on a four-tile
  arterial pushed everything on that side into the oncoming half, where it met
  the traffic coming the other way and both stopped. Wide roads now have two
  lanes each way and a driver takes the first that is free, with the oncoming
  half as a last resort.

**Brake marks.** `Effects.skid` was written complete and never called until
cornering brought it to life; braking is the other half, and the one you see
most, because every car in the city brakes. Marks go down under hard
deceleration (300 px/s²: the pedal, not lifting off) — four wheels locked,
against two under a slide — and a crash is excluded, because a rebound off a
wall is not a brake mark.

## Police pursuit driving

The cruisers were the last vehicles in the game driving badly. The pursuit
controller held full throttle whenever it was under `copCarSpeed` and steered
bang-bang with a 0.06 rad deadband, straight at the target whatever stood
between them. Three consequences: a cruiser that arrived facing the wrong way
drove a circle the width of a block instead of turning round; one nosed into a
wall sat there bouncing off it; and one with a building between it and the
fugitive drove into that building. All three ended at the bail-out, which took
the officer's car away. Measured over a four-star chase: **all six** motorised
officers abandoned their cars within ~20 ticks of getting them — the motorised
response was an on-foot posse that spawned litter.

Now: proportional steering on the shared `driveVehicle`, corner speeds by
heading error, a tight U-turn at walking pace when pointing the wrong way (the
turn radius is speed/turnRate, so 40 px/s comes round inside a two-tile street
where 300 px/s cannot), a bounded reverse to back out of whatever it is wedged
in, and — when the straight line runs through a building — a greedy road-grid
detour instead of a wall. The bail-out survives as the last resort it was meant
to be, and now distinguishes wedged (counts fast) from driving-but-not-gaining
(counts slowly), so an honest detour round a block no longer costs an officer
their car. Same four-star chase: cruisers stay in the chase, and the officers
who do end up on foot are mostly the ones who deliberately pulled up inside
`dismountDist`.

`CARDINALS`/`dirIsOpen`/`nearestCardinal` moved to `sim/roadgrid.ts`, shared by
traffic and pursuit — both AIs navigate by probing the tile grid, and only the
lane discipline differs.

## Play-test fixes — facing, traffic, impacts, fists, shop interiors

Five things reported from actually playing it.

**The avatar did not face the way it ran.** The sim only knows `aimAngle` —
the mouse — and the sprite was drawn at it, so running north with the pointer
east read as a crab walk. On foot the body now turns to the direction of
travel, eased at a fixed rate per second; aim wins while standing still and
while shooting, and the aim tick still shows the firing line. Presentation
only: the sim still shoots along `aimAngle`.

**Ambient traffic was broken three separate ways.** (1) Lane keeping aimed at
the centre of the *tile* a car stood on rather than at a side of the
carriageway, so on any road wider than one tile — all of them — oncoming cars
shared a lane; its deadband (`laneHalfWidth`, 14 px) was also nearly a tile
wide, so it never engaged at all. Drivers now measure the road across their
direction of travel and pure-pursue the centre of its right-hand half with a
proportional wheel. (2) A junction turn assigned `heading += ±90°` outright,
teleporting the car sideways; turns are steered now, slowing to `turnSpeed`
for the corner — a key that had sat in the tuning file with nothing reading
it. (3) "Blocked" held the brake down, and past a standstill the brake is
reverse, so anything stuck behind a parked car reversed away down the street;
blocked now brakes and holds, and reverse is a bounded recovery shunt. Falling
out of the measurement work: the obstacle probe treated kerbs and grass as
walls (only buildings, water and cars are solid), overtaking so a parked car
is not a permanent roadblock, bridges counting as road, and a car that has
wandered off the carriageway steering back onto it. Over 5 seeds: 84% of cars
under way (was 23%), 91% on the correct side (was a coin toss), 2.3% off the
road (was 45%). Driver intent lives in `state.trafficDrivers` — no client
simulates traffic, so it stays off the wire and out of the desync hash.

**Cars could not hit anybody.** The run-over threshold was 130 px/s and
ambient traffic cruises at 104, so every NPC car in the city drove through
players, pedestrians and officers untouched; the only vehicle that could run
anyone over was one a player was flooring. 40 px/s now, damage scaling with
speed, and a hit throws you along the car's line instead of only denting your
health.

**Fists fired bullets.** A melee swing is reported as a `shot` event and the
client drew every `shot` the same way: muzzle flash, spark cone, ricochet and
a bullet hole in the tarmac. The avatar also held a pistol whatever was
selected. Two new sprite families (`playerFist`, `playerPunch`) and a melee
effect keyed off `weapons.*.melee`, so any future melee weapon behaves the
same way.

**Shops had no inside.** Buying happened through a closed wall — the shop was
an awning on the pavement and a menu that opened when you stood near it. The
generator now hollows the building out: a one-tile wall ring, a room of
walkable `T_FLOOR` behind it, and a doorway punched through the shopfront
(two tiles wide for a respray, because a car is wider than one tile). The roof
simply is not drawn over floor tiles, so the room reads as a cutaway from
above with no second render pass and no per-building height. Counter along the
back wall, shelves down the sides, a marked-out bay for a garage; the server
serves you anywhere inside the room, not only in the doorway.

## Waves A2–E1 — the roadmap, delivered

Everything in `ROADMAP.md` after the A1 fixes. Each wave was committed and
gated separately; this is the combined log.

**A2 — the world stops being consume-only.** Peds were removed permanently
and props stayed broken for the session, so a long game monotonically
stripped the city. Props now carry `respawnAtTick` and a `stepProps` stage
repairs them once nobody is within `respawnMinDistFromPlayer`. Ped top-ups
live in the session rather than `step()`, because the decision needs to know
where clients are looking, which is server knowledge.

**A3 — fists, armour, pickups.** The only way to raise health in the whole
game was to die, which made fleeing pointless and turned the 3 s respawn into
the cheapest medkit on the map. Fists are a melee weapon with `infiniteAmmo`
that survives death, so an unarmed player always has a verb. Pickups are a new
entity table with fixed worldgen positions, so only `active`/`respawnAtTick`
ever move on the wire. Armour soaks damage before health.

**A4 — minimap, camera lead, HUD.** The client already regenerates the
identical `CityMap`, so a radar costs nothing on the wire: the city bakes once
into an offscreen canvas and each frame blits a clamped window of it. The
camera leads towards travel — at 330 px/s a car crossed the viewport in
1.45 s, so the driver was permanently steering into the blind half of the
screen.

**A5 — procedural audio.** Synthesised at runtime from `shared/data/audio.json`;
no binary assets, matching how the sprite sheet is already generated from a
JSON shape description. Headless-safe by construction.

**B — binary wire codec.** The enabler. Measured 42.6 → **9.2 KB/s** inbound
(4.6×) and 5.4 → 0.34 KB/s outbound (16×). Only `snapshot`/`full`/`input` are
binary; everything else stays JSON behind a tag byte.

**C1 — vehicle damage and explosions.** `VehicleState` had no health field, so
nothing in a game about driving could destroy a car, and car-vs-car reverted
position and zeroed speed. Now: bullets, collisions and blasts damage cars;
they burn on a fuse and detonate with radius damage; car-vs-car is momentum
transfer.

**C2 — ambient traffic and carjacking.** `traffic.json` had existed from the
start as a complete spec with zero references anywhere. AI drivers are marked
by a negative `driverId`, which makes occupied cars correctly un-enterable and
turns the jack into an explicit action — the verb the genre is named after,
previously impossible to express because no vehicle had an occupant.

**C3 — police vehicles, roadblocks, Pay'n'Spray.** The review's top finding:
cops at 122 px/s against a player car at 330, with no vehicles, so any car was
a guaranteed escape. Escalation now changes kind — foot posse, then cruisers
at three stars, then roadblocks at four — and a respray garage clears heat, so
losing the cops is a play rather than a stopwatch.

**D1 — water, bridges, boats.** Collision became medium-aware, which was the
roadmap's flagged risk since it runs inside prediction; it went in alone with
tests before any content. The river is carved before the roads, and only
arterials bridge it, so it stays a chokepoint.

**D2 — landmarks, hospitals, park interiors.** Named oversized structures to
navigate by, and the dead now wake at the *nearest hospital* instead of a
uniformly-random kerbside point three districts away.

**E1 — frenzies, stunts, score.** Kill frenzies reuse the pickup table with a
clock; stunt ramps add the vertical dimension (`z`/`vz`), with airborne
vehicles ignoring tile collision entirely. Payouts and a session leaderboard
run through the economy.

**Verification.** 157 tests green (from 73). `pnpm bots --count=8
--script=brawl --duration=60`: **PASS**, ticks 1811..1811, 0 desyncs, 0 stale,
0 full resyncs, corrections ≤4.4 px, peak **~11 KB/s** per client against the
50 KB/s gate. Replay re-simulates to identical hashes. `persistCheck` passes.
Client typechecks and `vite build` succeeds (88 KB, 31 KB gzipped). Verified
in a real browser throughout via Playwright: 14 AI cars all under way, police
cruisers with light bars, pickups, river, parks and minimap all rendering at
60 fps with no page errors.

**RNG-order note.** Several waves shifted the worldgen and sim rng streams
(cop spawn gating, the spray shop quota, river carving, landmark placement).
**Replays recorded before this work will not re-simulate.** Expected per
`ROADMAP.md` §5 and recorded here so a future desync hunt does not chase it.

**Deliberately deferred.** Missions and a story campaign, gangs/territory/
respect, building interiors, weapon drops on the ground, mobile controls — all
still out of scope per `ROADMAP.md` §6. Also speed-based camera zoom: the tile
layer bakes chunks at a fixed device-pixels-per-tile, so a variable zoom needs
either constant re-baking or a non-integer blit, and camera lead addresses most
of the same complaint.

**Least confident about.** (1) Balance across the board. Wanted-level
lethality, frenzy targets, stunt payouts, traffic density and explosion radius
are all first-pass numbers chosen by reading the model, not by playing. (2)
The police dismount rules (`dismountDist`, the accumulate-and-decay stuck
counter) went through three wrong versions before settling; they are correct
under test but the thresholds are guesses. (3) The bail-out interacts with
vehicle damage in a way I like but did not design: a wedged cruiser rams the
wall until it detonates, killing the officer. It is good emergent behaviour
and it is also not a decision anyone made.

## Wave A1 — correctness fixes from the review

First slice of `ROADMAP.md`, which addresses `REVIEW.md`. Five defects, no
new systems.

**What changed.**

1. **Cops can be run over.** `stepVehicleImpacts` iterated players and peds
   but never cops, so an officer was immune to a car at any speed. Added the
   missing loop in a fixed order (players → cops → peds; never reorder — the
   damage feeds heat, heat feeds cop spawning, and spawning draws rng).
   Run-over damage routes through `damageCop`, so it still raises heat on the
   driver and still emits `copDown`. `CopState` gains `carHitCooldown`,
   mirroring the player field of the same name — without it a car parked on
   an officer lands 30 hits a second. New field is in `COP_FIELDS` and in the
   hash, per the six-touch-point rule.
2. **The fifth star does something.** `desired = min(copsPerStar × wanted,
   maxCopsPerPlayer)` clamped 4 and 5 stars to the same 8 cops, so the top
   tier was a HUD glyph and nothing else. `maxCopsPerPlayer` is now 10
   (= `copsPerStar × 5`), which is the minimum change that makes the tiers
   distinct. This is an interim: the real fix is escalation by *kind* rather
   than count, which arrives with police vehicles (roadmap C3).
3. **Lifting an empty parked car is no longer a crime.** `tryEnterVehicle`
   added heat unconditionally — "witnessed or not" — so seven trips to your
   own parked car earned a star. Heat now applies only when a cop has line of
   sight. Taking an *occupied* car stays a crime, but no vehicle has an
   occupant until NPC drivers land (roadmap C2), where the jack becomes an
   explicit action; that branch is deliberately not written yet rather than
   written unreachable.
4. **Dead tunables.** `police.marineSpeed` had zero references anywhere and
   is deleted. `police.spawnCooldownTicks` was parsed, defaulted and never
   read; it is now wired as the real inter-arrival gate, taken straight off
   the tick counter (`state.tick % spawnCooldownTicks`) so it needs no state
   of its own, and checked before any rng draw so the stream stays fixed.
   Also folded the duplicated line-of-sight scan in `stepPolice` into a
   shared `anyCopSees`.
5. **Skid marks reach the screen.** `Effects.skid()` was fully implemented
   and called from nowhere. `drawVehicle` now lays rubber under both rear
   wheels when a vehicle is above 170 px/s and yawing faster than 1.9 rad/s,
   emitted on a 45 ms wall-clock cadence so a 240 Hz display does not lay
   four times the rubber of a 60 Hz one.

**Verification.** 77 tests green (up from 73). New coverage: empty-car theft
unseen costs no heat; the same theft under a cop's nose does; a speeding car
damages an officer, respects the immunity window, and eventually kills them
with a `copDown` event; a second cop cannot reach the street sooner than
`spawnCooldownTicks`; the five-star posse outnumbers the four-star one.
`pnpm bots --count=8 --script=brawl --duration=60`: **PASS**, ticks
1809..1809, 0 desyncs, 0 stale, 0 full resyncs, corrections ≤4.42 px, peak
**38.0 KB/s** per client against the 50 KB/s gate. Recorded replay
re-simulated twice to the identical final hash (`8e632cf`). Client
typechecks.

**RNG-order note.** Gating cop spawns on `spawnCooldownTicks` changes when
`maybeSpawnCop` draws, so the rng stream diverges from pre-A1 builds:
**replays recorded before this change will not re-simulate.** Expected and
accepted per `ROADMAP.md` §5; recorded here so a future desync hunt does not
chase it as a ghost.

**Deliberately deferred.** Everything else in `ROADMAP.md`. Specifically not
touched here: the binary codec (Wave B) that the traffic and police-vehicle
work is blocked on, ped/prop respawn (A2), fists and pickups (A3), minimap
and camera (A4), audio (A5). `traffic.json`, the `boat` tuning, the `copcar`
sprite, `worldgen.waterWidth` and the `water`/`sand` palette entries are all
still unreferenced — left in place deliberately, because C2/C3/D1 implement
them; they are pending, not rotting.

**Least confident about.** (1) The cop run-over damage multiplier reuses the
player's 0.12 rather than the pedestrian's 0.2, so an officer survives one
clip at top speed and dies to two. That is a guess, not a tuned number, and
it interacts with the 5-star lethality below. (2) Raising `maxCopsPerPlayer`
to 10 makes a five-star chase *more* lethal — 10 cops at 17.5 DPS is 175 DPS,
so a full-health player dies in ~0.57 s, worse than the 0.71 s the review
already flagged. That is the honest interim consequence of making the tier
distinct, and it should not ship to players before A3's armour and pickups
land. (3) The skid thresholds were picked by reading the steering model
(peak authority is 2.8 rad/s), not by watching a car corner — they want a
human eye before they are trusted.

## Fix — `Unknown builtin module: node:sqlite`

**What changed.** The SQLite backend assumed `node:sqlite` is a guaranteed
builtin. It is not: it is absent before Node 22.5, flagged behind
`--experimental-sqlite` on 22.5–22.12, and compiled out of some distro
builds — all of which throw `Unknown builtin module: node:sqlite`. Because
the import sat at module scope in `sqliteStore.ts`, that throw happened at
load time and killed server startup outright, before any fallback could
run, and even when `PERSIST_PATH` pointed at a `.json` file that never
wanted SQLite. The module is now required lazily (`createRequire`, so the
store stays synchronous) on first `SqliteStore` construction, and
`createStore` degrades to the JSON `FileStore` at the sibling `.json` path
with a warning naming the Node requirement rather than refusing to boot.
The warning is loud because the save file changes: an existing `.db` is not
read by the file store.

Also fixed: `.gitignore` had an unanchored `data/`, which matched
`shared/data/` as well as the runtime persistence dir and silently kept the
gameplay tunables out of the repo. It is now anchored to `/data/` and
`server/data/`.

**Verification.** `createStore.test.ts` covers backend selection on
whichever Node runs the suite; `persistFallback.test.ts` mocks the module
away to exercise the no-SQLite path everywhere (fallback store registers an
account, appends, rejects a duplicate ref, and reloads from disk). The real
failure was reproduced end-to-end against the built `dist/` with
`node:sqlite` blocked at `Module._load`: the store falls back, persists,
and reloads. `tsc -b server` clean.

## Phase 8 — destructible props

**What changed.** Lamp posts, bins, and fences as sim entities with exactly
one transition: intact → broken. No rigid bodies, no debris simulation —
per the brief, networked rigid-body destruction is a trap and we did not
walk into it. Worldgen places ~400 pieces of street furniture
deterministically (lamps on kerbs, bins against walls, fences along park
edges, orientation-aware); the session spawns them as recorded commands.
Bullets hit props (nearest-hit alongside walls/players/cops/peds; a lamp
post will eat your shot) and chip hp; cars at speed smash them outright and
shed a sliver of momentum per prop (a discrete nudge, not a collision
response). Broken props are inert: no ray hits, no re-break, swapped
sprite. Props never block movement — street furniture is small, and keeping
it out of the collision world means prediction, cop pursuit, and ped wander
all stay untouched. `propDown` events flow for future audio/particles.
Because props are static-until-broken, their delta cost is near zero: one
patch row when broken, plus AOI enter/leave rows.

**Verification.** 67 tests green: all three kinds placed, shotgun-vs-bin
transition (breaks, emits propDown, stays broken, never re-hit), speeding
car smashing a lamp with measurable momentum loss, and mass-destruction
determinism (10 props, 120 ticks of spray, identical hashes). Full-sandbox
8-bot brawl — players + 200 peds + ~400 props + police swarm — lockstep,
0 desyncs, ~42 KB/s per client (still under the phase-7 gate). Joyride and
replay checks clean. A tuning round-trip asymmetry (props.json flat shape
vs parsed {kinds} shape in welcome/replay headers) was caught by the replay
test and fixed with a dual-shape parser.

**Deliberately deferred (post-phase-8 backlog per brief).** Missions,
races, leaderboards, audio, mobile controls. Also: prop respawning (broken
stays broken for the session), vehicle destructibility, debris particles.

**Least confident about.** Prop density/placement aesthetics — numbers
chosen by eye on mapgen output, not by walking the streets. Fences not
blocking movement is the most gameplay-visible consequence of the
no-collision choice (you can stroll through a park fence; you just can't
pretend it survived a car). If props must block later, they'll need to
join the prediction context — a deliberate seam, not an accident.

## Phase 7 — pedestrian crowds + interest management

**What changed.** 200 pedestrians per session: sim entities that wander
sidewalks (weighted direction picks that prefer staying on pavement), flee
gunfire, deaths, and speeding cars, and die to bullets and bumpers — killing
one is a crime. NPCs (peds AND cops) move on a staggered 3-tick cadence
(10 Hz with 3× steps — interpolation renders it smooth, sim cost and delta
traffic drop to a third). Interest management: per-client filtered
snapshots — players always included, driven cars ride along, parked cars/
cops/peds only within a 600 px radius — with the delta base being the
filtered snapshot that client acked (per-slot ring), so AOI enter/leave
falls out as ordinary add/remove rows and the client needed zero changes.
Positional events (shots) are radius-filtered too; kill-feed events stay
global. Getting under budget took real bandwidth work: quantizing sim
floats to exact-binary grids (pos/vel 1/8 px, angles 1/256 — 17-digit JSON
floats were the single biggest cost), integer tracer endpoints, dropping
`lastInputSeq` from diffs (remote clients never read it; own reconciliation
rides the message ackSeq), and an exact-binary heat-decay rate.

**Verification.** 63 tests green: ped wander determinism with zero
building-clips over 200 peds × 300 ticks, gunfire scatter, ped-kill heat,
AOI filter correctness (everything excluded is provably far), a moving
client staying hash-consistent through 600 ticks of AOI churn (500+ hashed
deltas, 0 desyncs), and stale-ack full-snapshot fallback. THE GATE: 8-bot
brawl with 200 peds + police swarm — 40-44 KB/s per client, under the
50 KB/s budget, 0 desyncs, lockstep (harness now fails any run over
50 KB/s, permanently). Quantization surfaced a genuine -0 bug (JSON writes
-0 as "0", hashes disagreed by a sign bit) — fixed at quantizer and hash.

**Deliberately deferred.** The binary codec — JSON now fits the budget with
headroom, so per the plan ("switch when profiling proves it") it stays JSON;
the Codec seam is ready when richer traffic (phase 8 props, more players)
needs it. Ped variety (one sprite), sidewalk crossing behavior at lights,
per-district ped density.

**Least confident about.** The 10 Hz NPC cadence under packet loss —
interpolation smooths steady streams; a hiccup drops NPC keyframes harder
than player ones. Brawl clusters bots (worst case for AOI); a pathological
all-eight-players-in-one-plaza scenario still fits budget by measurement,
but barely half of it is headroom. -0 taught me JSON round-tripping has
sharp edges; if another eigenvalue like NaN ever enters the sim it will
desync — sanitizeIntent guards the only external float inputs, but a sim
bug producing NaN would poison hashes silently.

## Phase 6 — police and wanted levels

**What changed.** Heat-based wanted system, entirely in the sim: violence
against players adds heat proportional to damage plus a kill bonus, car
theft adds a little, killing a cop adds a lot; `wantedLevel` = heat/100
clamped to 1–5. Heat decays only while NO cop has line of sight — hide to
cool off; heat survives death by design (dying is not a laundering
mechanic). Cops are sim entities that spawn deterministically from the
kerbside spawn list in a ring around the fugitive (one per tick, ramping to
2 per star, capped per player and globally), pursue with greedy steering —
axis-separated wall-slide plus an rng sidestep when wedged, which the road
grid makes look smarter than it is — and fire only with LOS inside range.
Players can shoot back: cops have health and drop, at a price. All numbers
in `police.json`. Cop shots/`copDown` are events; clients render cops
(sprite, interpolated), tracers, and wanted stars.

**Verification.** 56 tests green: crimes raise heat (violence, theft),
decay-while-hidden to zero, level-3 chase (posse spawns within 10 s,
converges inside firing range, draws blood — the "tense at level 3" gate as
a machine-checkable proxy: pressure arrives fast, from multiple directions,
and standing still is lethal), cop-killing raises heat, and the entire
chase hashing identically across runs. 8-bot brawl with live police: PASS,
lockstep, 0 desyncs; kill counts now include deaths-by-cop. Replay with the
full police sim re-simulates hash-identical.

**Deliberately deferred.** Cop cars and roadblocks (on-foot posse only —
level 4/5 currently just means *more* cops; vehicle police would be the
next escalation). Pathfinding beyond greedy wall-slide (cops can be juked
around building corners — arguably a feature; BFS on road tiles is the
planned upgrade if chases feel dumb). Wanted-level UI beyond stars.

**Least confident about.** "Genuinely tense" is a human judgment — the
machine proxy (fast convergence + real damage) is necessary but not
sufficient; tune copsPerStar/moveSpeed/copPistol damage after a real chase.
Greedy pursuit can wedge cops on concave building clusters (the sidestep
frees most cases; some pace circles remain). Cop entity + shot-event
bandwidth tripled brawl traffic — phase 7's interest management is now
load-bearing for two reasons.

## Phase 5 — economy, shops, accounts, persistence

**What changed.** The economy lives entirely server-side behind one seam:
`Economy` validates everything (the server is the cashier) and its only
write-path into the sim is the SimCommands it returns (`grantWeapon`,
`setCosmetic`), which the session queues and records like inputs. Cash is an
append-only ledger — no balance column anywhere; balance is a fold over
transactions, every entry carries a reason and a unique idempotency ref
(duplicate refs are rejected, so retried writes can't double-apply, and
"where did this cash come from" is one query). Persistence sits behind a
`PersistenceStore` interface: the JSON `FileStore` (atomic tmp+rename
writes) is the verified implementation in this environment; the reviewed
MySQL schema is in `server/mysql/schema.sql` — see the open questions at the
end of this file. Purchases: `buy` is a request message; the server checks
alive/on-foot, doorway proximity to the right shop kind, price from its own
catalog, and balance. Awards: kills pay with per-victim diminishing returns
inside a time window, driving pays only *novel* road cells at speed, both
under per-minute caps — all numbers in `economy.json`. No player-to-player
transfers exist, killing the entire duping/muling class. Accounts are
optional (guests always play, session-scoped wallets): username+password
with scrypt from node:crypto; cosmetics persist per account and re-equip on
login via a command. Client: wallet + shop panel (stand in a doorway,
Y/U/I/O to buy), L/K prompt-based login/register.

**Verification.** 50 tests green: ledger idempotency + overdraw rejection,
scrypt account verify (case-insensitive uniqueness, wrong-password fail),
kill-award decay/window-reset/rate caps, novel-cell driving pay,
doorway/shop-kind/balance purchase validation, and the phase gate —
cash, transactions, cosmetics, and idempotency surviving a store reload.
Full-stack `persistCheck` over the real wire: register → kill server →
fresh process on the same store → login → wallet identical and starting
cash seeded exactly once. Kill awards ran live during the brawl runs.

**Update (post-review):** persistence target changed from MySQL to SQLite
per review. `SqliteStore` over Node's built-in `node:sqlite` (zero new
dependencies) is now the default backend (`data/persist.db`); same
append-only discipline (INSERT-only transactions, UNIQUE ref as idempotency
key, balance = SUM(delta)). The JSON FileStore remains available via a
`.json` path and both backends run the same restart-survival test suite.

**Deliberately deferred.** Weapon unlocks
as account inventory — per the death-costs-guns design, weapons are
repurchased, only cosmetics + cash persist. A real login UI (window.prompt
is a placeholder). Shop stock limits.

**Least confident about.** Award tuning (does $100/kill vs $250/pistol feel
right?) is untested by humans. Guest wallets route to a pure-memory ledger
(the persist file only ever holds account rows), but a guest's cash
silently evaporating on session end may need messaging in the UI.
prompt()-based login blocks the render loop while open.

## Phase 4 — weapons, damage, death, respawn, kill feed

**What changed.** Hitscan weapons (pistol/smg/shotgun in `weapons.json`):
tile-DDA wall ray + analytic ray-circle target tests, nearest hit wins,
spread rolled from the sim PRNG (server-side weapons pass only — prediction
never touches the rng). Health/damage/death in the sim: dying drops you out
of any car, freezes the corpse, clears weapons, stamps `respawnAtTick`.
Respawning is a server-issued `respawnPlayer` command 3 s after the death
event — which is exactly where the `WEAPONS_LOST_ON_DEATH` flag (default
true) lives: it only decides the loadout the command carries (fresh pistol
vs. weapons at death), so the sim stays flag-free and both settings replay
deterministically. `step()` now emits deterministic SimEvents (shot/kill/
death) via an out-param; the server relays them; the client shows a kill
feed, tracers, health/ammo HUD, and a wasted-screen countdown. Run-over
damage for fast cars with a short immunity window. Weapon switching added as
a `slot` field on the input intent (keys 1-8) — still an intent, but it is
a deliberate extension of the brief's fixed field list, flagged here.
Brawl bot script: chase nearest living player, strafe, shoot.

**Verification.** 44 tests green: hitscan damage/cooldown/ammo/kill/loot-
clear/respawn lifecycle, walls actually block shots, bit-identical combat
determinism (same fight twice), run-over damage. 8-bot brawl 60 s: 21 kills,
every bot died and respawned, 0 desyncs, corrections back to ≤4.33 px once
respawn teleports were correctly excluded from the correction metric (they
are legitimate teleports, not prediction error — that fix is in the
predictor, found by the harness tripping on 2000 px "corrections").
**10-minute unattended 8-bot brawl: PASS — 18010 ticks, 135 kills, every
bot died 14–20 times and respawned, tick spread ≤1, 0 desyncs, corrections
≤10.3 px, no crash.**

**Deliberately deferred.** Drive-by shooting (fire is on-foot only).
Vehicle damage/destruction. Weapon pickups/drops on the ground (decided
against in plan — dupe/grief surface). Damage directionality/knockback.

**Least confident about.** Balance numbers (damage/cooldown/spread) are
untested by humans. The kill feed names use snapshot lookup at event time —
a player who disconnects the same tick renders as #id. Shot events are
broadcast unfiltered; at 8 players this is noise, but phase 7's interest
management must filter events too, not just entity deltas.

## Phase 3 — vehicles

**What changed.** Vehicles are sim entities: signed forward speed along a
heading, steering authority that grows with speed (reversing inverts it),
hard friction when coasting, wall crashes damp and slightly rebound speed —
arcade, not rigid-body, all tunables in `vehicles.json`. 48 parked cars
spawn per session from the map's kerbside spawn list (as recorded commands,
so replays reproduce them). Enter/exit is an edge-triggered `action` intent
resolved in the sim: nearest free near-stationary car within radius; a
contested door on the same tick resolves by player id; exit tries left/right/
rear spots and refuses if boxed in. Car-vs-car contact is a simple stop-on-
overlap (server-side only). Snapshots/deltas/hashes generalized over both
entity tables. The predictor now predicts the driven car (same shared
physics), while enter/exit and car-vs-car remain deliberately unpredicted —
server-granted, corrections smoothed. Client interpolates and renders
vehicles; joyride bots seek, steal, and drive cars.

**Verification.** 39 tests green: enter/drive/exit lifecycle, edge-trigger
(holding action doesn't re-trigger), contested same-tick entry with range
gating, wall crash on a synthetic arena (speed >200 px/s, damped on impact,
never penetrates, never passes the wall), and bit-exact driving prediction
(zero correction over 150 ticks of throttle+steering). 8-bot joyride 60 s:
lockstep 1809..1809, 0 desyncs, 4 bots stole and drove cars, corrections
18–22 px only from deliberately-unpredicted transitions (limit 96). Replay
still hash-identical twice.

**Deliberately deferred.** Run-over damage and drive-by fire (phase 4).
Vehicle health/destruction (phase 8 decides if cars burn). Car-vs-car
momentum transfer — stop-on-overlap is deliberately crude; revisit only if
play feels bad. Bots don't pathfind around buildings to reach cars (half of
them nose into walls; harmless for verification purposes).

**Least confident about.** Whether driving "feels weighty" — the numbers
(330 px/s top speed ≈ 20 tiles/s, speed-scaled steering) are reasoned, not
felt; they're one JSON edit away from retuning once a human drives.
Correction magnitude during contested entries under real latency (60 ms
round trip) — bots on localhost show ~20 px; worth watching the ghost when
first played over a real link.

## Phase 2 — procedural city, collision, camera, pixel-art pipeline

**What changed.** `shared/src/world/` generates the whole city as a pure
function of (seed, params): district Voronoi seeds → jittered arterial grid →
recursive block subdivision with district-sized targets → per-district block
fill (downtown packs solid, residential rows with yards, industrial slabs on
open lots, parks stay green) → shops with sidewalk doorway zones (quota'd:
gun shops prefer industrial/commercial, clothing prefers commercial/downtown)
→ parked-car spawn points → spread-apart player spawns. 240×240 tiles at
16 px (3840² px world), generated in ~30 ms. Movement now collides with
building tiles via axis-separated AABB sweeps, sub-stepped ≤ half a tile so
fast movers can't tunnel (a real bug the test caught before vehicles made it
matter). The map threads through `step()` and the predictor; the server ships
its parsed tuning + worldgen params in the welcome message so a server-side
JSON tune can never desync client generation, and replay headers embed both,
making replays self-contained. `pnpm mapgen --seed=N` renders a city PNG
(hand-rolled encoder over node:zlib); `pnpm sprites` emits the placeholder
sprite sheet from palette + shape descriptors; the client draws the tile
world, sprites rotated at draw time, integer-scaled camera clamped to the
city.

**Verification.** 35 tests green: worldgen purity (bit-identical tiles for
same seed), density/district/quota/spawn invariants across seeds, doorways
walkable, collision escape-proofing (600 ticks of input mashing never ends
inside a wall), flush clamping. Rendered seeds 7/8/9 to PNG and eyeballed:
three clearly different cities (different downtown placement, park spread,
block texture). 8-bot 60 s run over the real city: lockstep 1810..1810,
0 desyncs, corrections still exactly one held tick (4.33 px) — collision is
bit-exact in prediction. Fresh replay re-simulates to identical hashes.

**Deliberately deferred.** Explicit road graph (nodes/edges) — police/ped AI
will pathfind on the road tile grid directly (BFS), which is the boring
version; a graph can be derived later if profiling demands it. Crosswalks,
lane markings beyond a sparse dot texture, building interiors (per brief:
none, shops are doorway zones). District-specific palettes beyond building
colors.

**Least confident about.** District *feel* at street level — the aerial PNGs
read distinct, but on-foot distinctiveness (building height cues, prop
density) is thin until props (phase 8) and peds (phase 7) arrive. Residential
blocks lean sparse; worldgen.json numbers are all tunable without a rebuild
if the density feels wrong in play.

## Phase 1 — prediction, reconciliation, interpolation

**What changed.** The server now consumes exactly one input intent per tick,
in seq order (with a 6-tick bounded hold for gaps and a fast-forward drain
for bursts) — the contract reconciliation needs. Extracted
`stepPlayerMovement()` so one function moves a player on the server, in the
client predictor, and in bots. Added `Predictor` to shared/: applies local
inputs instantly (zero input lag), and on every snapshot rewinds to the
authoritative player and replays unacked inputs; it tracks correction
magnitude, which the overlay shows as ghost drift. The browser client renders
the local player from the predictor and remote players through a new
~100 ms (3-tick) interpolation buffer with a servo'd render clock — no
snapping, no extrapolation. Bots now run the identical Predictor and the
harness fails if any correction exceeds 32 px.

**Verification.** 29 tests green, including an in-process client/server
prediction test proving zero correction when each input is applied exactly
once, and convergence (corrections return to zero, no accumulated drift)
after a deliberately dropped input. 8-bot 60 s run: lockstep ticks
1807..1807, 0 desyncs, max correction 4.33 px — exactly one tick of walk
speed, the expected transient when setInterval jitter makes the server hold
an input for one tick; it does not accumulate.

**Deliberately deferred.** Smoothing of reconciliation corrections (currently
applied instantly — at 4 px it's invisible; revisit when vehicles raise
speeds). Input redundancy (sending last N intents per message) — TCP
WebSockets don't drop, only delay, so holds are rare and bounded.

**Least confident about.** The "two tabs feel" criterion is verified by
proxy (bots + math) since this environment has no browser windows;
interpolation smoothness under real frame-rate jank is untested. The render
clock servo (5% pull toward target delay) is a guess that may need tuning on
a real 60 ms connection.

## Phase 0 — workspace, sim skeleton, transport, bots, overlay, replay

**What changed.** Built the entire phase-0 skeleton from an empty repo: pnpm
workspace (`shared`/`server`/`client`), the deterministic sim core in
`shared/` (fixed 30 Hz `step()`, seeded mulberry32 PRNG stored in GameState,
sorted-id entity tables, deterministic polynomial sin/cos/atan2 so no engine
transcendentals ever touch the sim), the full wire protocol behind the
`Codec` interface (JSON now), delta snapshots against per-client acked ticks
with a 3 s ring and full-resync fallback, periodic FNV state hashes in
snapshots as the desync tripwire, the authoritative server (drift-corrected
tick loop, join/resume with per-session tokens, input sanitation at the trust
boundary), record/replay (every session records; the replay runner re-sims
and hash-verifies), the bot harness, and a minimal browser client (fixed
480×270 integer-scaled canvas, keyboard/mouse intents, `~` overlay with tick
rate, RTT, entities, KB/s, hitboxes, and the predicted-vs-authoritative ghost
slot). Sim tunables live in `shared/data/player.json`, loaded by each host
and injected via `initTuning()`. The `WEAPONS_LOST_ON_DEATH` env flag is
parsed in server config, ready for phase 4/5.

**Verification.** `pnpm test`: 27 tests green across shared+server, including
step determinism (same seed+inputs ⇒ identical hash), delta round-trip
equality, trust-boundary rejection tests, and a pinned PRNG known-answer
sequence. `pnpm bots --count=8 --script=cruise --duration=60`: all 8 bots
finished at the identical tick (1808..1808), 8 entities each, 0 desyncs,
0 stale deltas, 0 full resyncs; a 20 s `jitter` chaos run also passed. The
recorded replay of the live 8-bot session re-simulated twice to the same
final hash (`8fbba894`). Client typechecks and `vite build` passes.

**Deliberately deferred.** Prediction/reconciliation and interpolation
(phase 1) — the client renders raw snapshots, so remote motion quantizes to
snapshot arrival for now and the overlay ghost is trivially zero. The server
applies the newest queued intent per tick (input hold); phase 1 changes
consumption to one-intent-per-tick by seq for reconciliation. Snapshot
deltas diff whole fields (a moving player resends pos+vel every tick) — fine
under JSON, revisit with the binary codec or interest management. Deviations
from the PLAN file list: added `shared/src/net/sync.ts` (snapshot reassembly
shared by client and bots), `shared/src/net/hash.ts`, `shared/src/tuning.ts`,
and `server/src/tuning.ts` (fs loader); per-phase entity tables
(vehicles/peds/props) will be added to GameState in their phases rather than
sitting empty now.

**Least confident about.** (1) Wall-clock input timing: bots and client send
intents on their own setInterval/rAF clocks and the server applies "latest
wins" — good enough for lockstep verification, but phase 1's
tick-aligned input scheduling is where real timing bugs will surface, and
the current smoothness is not evidence they don't exist. (2) The resume path
is tested at the session level but not end-to-end under a real mid-game
socket drop with a stale ack ring. (3) Bandwidth (~29 KB/s per client with 8
players under JSON) is fine now but the JSON+full-field-diff combination has
no headroom for phase 7's pedestrians — the interest-management milestone is
carrying real load.
