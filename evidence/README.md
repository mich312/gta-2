# Evidence

## Retaking these, and what a diff means

Every plate below that carries a retake command was re-run and compared
pixel-for-pixel against the committed file with
`node evidence/round1/D-pngdiff.mjs <committed> <fresh>` (`SIZE DIFFER` when
the frames are not the same shape, a differing-pixel percentage otherwise).
Confirm the instrument before you believe a number: run one command twice and
diff its own two outputs. Measured this round, on a quiet box:

| how a plate is made | two runs of the same command differ by |
|---|---|
| `mapgen` / `plangen` (offline, CPU) | **0 px** — bit-deterministic |
| a contact sheet through `ci/shot.mjs` | **0 px** |
| a `city3d.html` flyover through `ci/shot.mjs` | ~0.01% (241 px of 2.2M) |
| the live client through `F-R1-B01-shot.mjs` | **>15%** — see the round-3 note |

So on a mapgen crop any non-zero count is real drift; on a flyover the floor
is a hundredth of a percent and anything above about a tenth is real; and on
a live-client plate a whole-frame percentage measures nothing at all and you
must read pixels instead.

`ci/shot.mjs` shoots a fixed 2200x1000 viewport and waits for `networkidle`,
which the live game client never reaches — use `evidence/round3/F-R1-B01-shot.mjs`
for the client. `WAIT_GROUND` is not optional on a `city3d.html` flyover: without
it you photograph flat instanced slabs instead of the painted city.

## Gameplay

Captured by driving the real game in a browser against the offline host — one
process, fixed seed, ordinary keys and mouse. `node ci/playLocal.mjs` retakes
all three.

**Retaken in round 8, on this box, in 35 seconds.** Rounds 1 and 5 recorded
these three as un-retakeable here across three attempts — a hang past 420 s
twice, a run that took eight minutes to write a `play-dusk.png` of a player
standing on the pavement holding `fists`, and a run that died with
`page.screenshot: Timeout 30000ms exceeded`. Round 5's reading was that this
was a software renderer losing to wall-clock budgets, and box-specific. Half of
that was right and it was the wrong half:

- `main.ts` reads `render !== '2d'`, so **the 3D renderer is the default and a
  URL that says nothing gets it**. `playLocal.mjs` said nothing, so every
  attempt anyone has made at these plates was photographing three.js through
  SwiftShader — while passing `extrude=1`, a flag only the 2D tile layer reads.
- Measured here, same session, same seed, same 1440x810 viewport
  (`evidence/round8/D-probe-renderer.mjs`): **0.37 fps through 3D and 57-60 fps
  through 2D**, with a screenshot costing 43 s against 0.2 s. An empty page and
  a full-viewport canvas fill both hold 60 fps on this box
  (`evidence/round8/C-probe-scale.mjs`), and the 3D frame rate does not change
  when the viewport is cut to a sixteenth of the pixels — so it is not the
  box's raster, it is the geometry going through a software GL.
- So the wait was never `networkidle` (it arrives in 828 ms) and never
  playwright's screenshot default alone. It was `getInCar`: at 0.37 fps a
  240 ms key hold can fall entirely between two input samples, and every CDP
  keystroke waits on a main thread that is busy for three seconds at a time.

`ci/playLocal.mjs` now asks for `render=2d`, waits on the sim's own clock
(`__debug.tick`) rather than on the network going quiet, bounds its walk-up by
wall clock rather than by an iteration count, and — the round-5 trap —
**declares what must be true of `__debug` at the moment each shutter opens and
throws rather than photographing a scene it failed to stage.** These plates are
of the 2D renderer, which is the one they have always been of; the 3D client
has its own plate, `render-3d-client.png`.

The frame is a live session, so what is in it moves between runs: the captions
below name what the harness stages and gates, not the traffic that happened to
be passing.

| file | what it shows |
|---|---|
| `play-dusk.png` | The lighting and the extrusion doing their jobs at once: the player's headlight cone thrown down the street, lamp pools on the pavement, traffic ahead under the night grade, and buildings leaning away from the camera. Gated on the player being in a car and driving. |
| `play-drift.png` | Cornering hard enough to lay rubber down — the skid marks trailing back up the street behind the car are where the tyres actually slipped, with the speedo still in three figures. Gated on the decal pool having grown across the corner and the car still moving through it, so this is the slide and not the wreck afterwards. |
| `play-foot.png` | On foot with the pistol every player spawns with, firing: the muzzle flash lighting the pavement, the round's tracer out to its impact, the player's name tag, the respect bar and the export list. Gated on `foot` + `pistol` + muzzle particles in the air. |

There is no street name in this HUD, whatever an older caption here said:
`hud.place` is the landmark you are standing inside and `hud.district` the
borough under it, and the two lines top right are the kill feed — the gang
names in them (`Kessler Row`, `The Quay`) are gangs, not streets.

**No chase shot, deliberately.** Scripted sprays into a crowd do not reliably
produce a wanted level — the same unreliability recorded for `ci/play.mjs`
below. What produces those states is covered by `/hud-sheet.html` for the
readout and `pnpm chase` for the chase itself, which measures escape rate per
star level over several seeds instead of hoping for one.

## The city with a third axis

| file | what it shows |
|---|---|
| `render-3d-parity.png` | The 3D client at dusk with the parity work in: blood and rubber on the road, pickups and hidden packages as solids, traffic signals standing on posts showing the phase the traffic is obeying, real street lamps and headlights, bodies that lie down, and the name tag drawn by the same HUD pass the 2D renderer uses. Retake with `?local=1&seed=7&night=0.62`. |
| `render-3d-client.png` | **The real game client** at `?render=3d` — not the sibling page. Wallet, street name, minimap, respect bar, health, weapon and export list are the actual HUD drawing on a transparent canvas over a three.js world, and the player is drawn from the predictor rather than the wire. This is what "3D" means once it is the game rather than a viewer. |
| `city-anywhere.png` | **Anywhere City**, the whole of it: 768×768 tiles of archipelago — one long island split by a tidal strait, a second island across the sound to the west, a spit round a lagoon south-east, barrier islands off the south shore. Five boroughs plus Gannet Rock — the cliff-bound plateau in the south-west that can only be reached by air — eight crossings, a dual-carriageway ring road curving through the grids and leaving triangular blocks behind it. The coast is an authored outline detailed by a domain-warped distance field; the streets and boroughs are drawn in `shared/data/city-plan.json`. Retake with `pnpm mapgen`. |
| `city-old-generator.png` | What it replaced, at seed 42: noise-contoured water cutting the grid into pieces, streets running into the sea, boroughs with no shape and nothing to navigate by. The same generator gave a different one of these every seed and no city in particular. |
| `city-anywhere-street.png` | Ground level in the Old Quarter: a signalled crossing with the street wall shoulder to shoulder on both sides — the frontage fill, which replaced a kerb ring with sheds scattered inside it. **Not retakeable as written**: `ci/playLocal.mjs` writes `play-dusk`, `play-drift` and `play-foot` and nothing else, so the line under this plate names a script that has never produced it. It was framed by hand out of a `?local=1` session; nothing records where. |
| `city-fabric-review.png` | The three standing crops of the street-fabric review (WORLDGEN.md §13.1), retaken after every fabric wave. **This is the city as it stands, not the state §13.1 complained about** — that is the point of a standing crop. A: the two banks of the strait, now carrying two different fabrics, where §13.1 found the identical screen-aligned lattice on both — sixteen boroughs, one orientation. B: the Old Quarter, its weave meeting the neighbouring grid at an avenue, where §13.1 found avenues slicing through and leaving sliver blocks with a dead `T_FIELD` fringe out to the shore. C: the ring road curving through a planted park down to a met waterfront, where §13.1 found leftover field, park as empty felt and the waterfront unmet. Retake with `pnpm mapgen --sheet` after each fabric wave and diff by eye. |
| `city-seam-review.png` | The same four §14.1 crops after the seams wave (§14.5): Ravenhill's weave and the Spine's columns now both T into a seam street with frontage facing it from both sides; the Spine meets the Old Quarter's 20° fabric AT an avenue instead of a torn band; Beachfront and New Suburbs share a street, not a painted line; and the suburb frays into Marsh End through hedgerowed lanes, orchard rows and smallholdings instead of stopping dead. Crossable share of each urban seam went from 5-24% to 71-100% (the permeability test in city.test.ts holds the floor). **Not retakeable**: this is four 90-tile `--crop` renders composited by hand, and neither the crop coordinates nor the compositing step were ever recorded — §14.1 names the seams but no tile addresses, and `mapgen` has no four-up mode. The plate stands as the §14.5 record; the invariant it illustrates is held by the permeability test, not by this picture. |
| `city-shore-review.png` | The south-east beaches: the lagoon mouth and the outer sand spit, with the causeway crossing the frame. **Retaken after VECTOR §25, and it no longer shows what §15 took it for.** §15's argument was the bevel pass cutting 45° wedges out of a staircase of whole tiles; §25 moved the coastline off the raster and onto a curve upstream of it, so the waterline in this crop is now a continuous contour with no staircase left to cut. The §15 bevels are still under it — they are what collision resolves against — but the drawn edge is the curve. Retake with `pnpm mapgen --crop=600,570,140` after any shoreline change. |
| `city-kerb-review.png` | The kerbs after §15.4 step 1: a rotated borough whose whole fabric runs diagonal, its sidewalk stair corners yielded to the carriageway so the kerb line follows the street instead of stepping across it. The gate is the painter's own pair of tests — the cardinal run first (an L of road mass at a square crossroads corner has a diagonal principal axis, so covariance alone lies exactly there), then `diagonalRoadDir` with the cut's hypotenuse required to run WITH the band. Every corner of every square-grid borough stays the square it was drawn as. Retake with `pnpm mapgen --crop=545,20,90`. |
| `city-cliff-review.png` | Gannet Rock from above — the cliff-bound plateau you can only reach by air, with Gannet Rock Strip and the Eyrie clearing in the wood. §15.4 step 2 took this crop for the cliff rim's staircase corners being yielded by the water to the canopy, so a hull slides a 45° face instead of snagging square rock; as with `city-shore-review.png`, §25 put the drawn waterline on a curve and there is no staircase left in the picture. What the crop still shows is the invariant that mattered: the rim is one closed line with no green skirt at its foot and no hole under the canopy. Retake with `pnpm mapgen --crop=55,555,120`. |
| `city-3d-shore.png` | The shoreline in the renderer players actually see: the outer sand spit from the city3d flyover, its waterline one continuous curve from the tip to the bottom of the frame, the shore wedges giving the sand a real edge face into the water. §15.4 took this camera for the bevel's long 45° reaches; since §25 cut the coast against the curve rather than the raster there are no reaches and no staircase — what fine fringing remains is the cutout mask's eight-texels-a-tile resolution, two world px a step. Retake: `pnpm --filter client dev`, then `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=700,608&h=260&pitch=45&night=0" evidence/city-3d-shore.png`. |
| `city-3d-cliff.png` | The wooded shore (§15.4 step 2) in 3D: the forest island's rim, canopy-height wedges chamfering the cliff's staircase corners into the water — no green skirt at the cliff foot, no hole under the canopy, the two failure modes that deferred this pair. Retake as above with `at=148,586`. |
| `city-3d-kerb.png` | The diagonal kerbs (§15.4 step 1) in 3D, painted ground resident: a rotated borough's streets with the pavement corners yielded to the carriageway along the diagonals, its blocks standing turned to the bearing their own tiles carry, and the lagoon beach behind them. The beach used to break at 45° here, where the bevel cut the staircase; since §25 it is the curve, drawn as one line. Retake as above with `at=590,38&h=240`. |
| `city-3d-ring.png` | The road drawn in one line (WORLDGEN.md §16): the ring road curving through open country as a stroked course — kerb casing, carriageway, edge lines and the centre dash all following the authored polyline instead of its rasterisation, the junction with the crossing avenue opened by paint order alone. The band's stair-stepped tiles are still there under the ribbon as shoulders, and still what collision and traffic drive. Retake: `pnpm --filter client dev`, then `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=330,630&h=300&pitch=45&night=0" evidence/city-3d-ring.png`. |
| `city-3d-contour.png` | The second courses wave (WORLDGEN.md §16): a shore borough whose long streets are traced iso-lines of the water's distance field, bending with their shore under one continuous centre dash. Retake with the §16 flyover command at `at=620,585`. |
| `city-roadnet.png` | The road network as a graph (WORLDGEN.md §40): every street between two junctions stroked in cyan along the tiles the flood ran through, every junction a yellow dot. 940 nodes and 1,764 streets stand in for the 102,987 drivable tiles routing used to search, and the picture is the coverage claim — there is no carriageway in the crop the graph does not run down. Since §41.3 each street is coloured by what it is made of — bright for an avenue or the ring, dim for an ordinary street, grey where no centreline covers it (12% of them). Retake: `pnpm mapgen --net --crop=300,180,120 --out=evidence/city-roadnet.png`. |
| `city-3d-crescent.png` | A crescent borough after the same wave: the collector sweeping its whole sine as one stroke, the crescents wandering with unbroken dashes — each a recorded analytic centreline, trimmed to the stretches the drop hash actually carved. Retake at `at=520,520`. |
| `city-3d-night.png` | Night. Windows light up across the facades — a per-window hash against the night amount, so a lit window stays lit rather than flickering as the camera moves. |
| `city-3d-facades.png` | The original GTA camera: perspective, straight down, so buildings splay away from the screen centre and show the face turned toward it. Facades are shader-computed — window columns with mullions, a slab line between storeys, a shopfront on the ground floor — so one material covers every building height. |
| `city-3d-models.png` | Close up. The car is not a model anybody built — it is the `car` entry in `shared/data/sprites.json`, extruded. Tapered body polygon, raised cabin, tinted glass, red tail lights, headlights, dark tyres: every one of those is a shape in the 2D sprite with a `z` on it, and the sprite generator was already relighting flat art from those same heights. Same file, not flattened. |
| `city-3d-live.png` | The game **playable** in 3D. Everything in it comes from data the 2D renderer already uses: the bodies are `sprites.json` entries extruded, the trees and bushes sit at the same `hash2` positions the tile layer plants them, the props are the sim's own and swap to their `_broken` art when destroyed, and the road markings run down the carriageway centres measured the same way. `/city3d.html`. |
| `city-3d.png` | The generated city as actual geometry — 523 buildings at real heights, cast shadows, the river — built from the **volume grid** the 3D collision resolves against, not from the tile grid. A building's box is the span that stops you. Retake with `/city3d.html?seed=7&pitch=45`. |
| `bug-3d-frame-cost.png` / `3d-frame-cost.png` | The flyover's own frame-cost readout, before and after the post chain's counters were fixed. `WebGLRenderer.render` zeroes `renderer.info` at its own top and `EffectComposer` drives every pass through it, so what the HUD read was the last pass alone — the grade's single fullscreen triangle, `draws 1  instances 619445  tris 0k`. The same camera now reads `draws 238  tris 7031k`: scene, shadow map and post, counted once per frame. On a box with no GPU this readout is the only frame-cost instrument there is, so a broken one is worse than none. Retake: `pnpm --filter client dev`, open `/city3d.html?fly=1&at=634,116&h=190&pitch=45&night=0`, wait for the ground to paint, then in the console `requestAnimationFrame = () => 0` and screenshot the HUD. |

Quote draw calls from these, not frame rate: this box has no GPU, so its frame
rate is SwiftShader's and says nothing about a real machine, while draw count
is a property of how the scene is built and is the same everywhere. Bare
geometry is **9 draws / 762k triangles** for the whole 240×240 city; dressed —
facades, planting, props, markings, roof parapets and clutter, kerbs,
crossings and the live population — it is **179 draws / 3.2M triangles**.
Both of those are scene plus shadow map only — the readout they came off could
not see the post chain (`bug-3d-frame-cost.png`). It can now, so a fresh number
off the HUD carries the bloom, output and grade passes on top and is a dozen or
so draws higher than a like-for-like one. See 3D.md W3a.

## Buildings that lean

| file | what it shows |
|---|---|
| `extrude-baked.png` | The shipped extrusion. Every building sweeps the same way — down-right, towards the sun-away direction — wherever it stands, because the sweep is painted into the cached chunk and a cache cannot know where the camera is. |
| `extrude-parallax.png` | The same city, same seed, same spot, with `?extrude=1`. Buildings above the player lean up, buildings below lean down, buildings left lean left: the roof is displaced away from the screen centre in proportion to height, so the city opens out around the camera instead of all shearing one way. This is `GRAPHICS.md`'s "what's next" #1 and SHIP.md U2. |

The roofs are the same art in both: they are baked per building and blitted
displaced, rather than repainted per frame, so the speckle, parapets and
rooftop clutter survive the move. Costs are in SHIP.md U2 — the short version
is that it fits, and `pnpm bench` re-measures it.

## No server

| file | what it shows |
|---|---|
| `offline-host.png` | The game running with **nothing listening on 8080**. The whole session — sim, economy, missions, police, 200 pedestrians — is in a Web Worker in the same tab, reached through the same protocol and the same binary codec (SHIP.md T1). Read the overlay: `rtt 0ms`, because there is no wire; `net ↓8.8 ↑0.4 KB/s`, because the codec runs anyway and the bandwidth budget is still measured; `desyncs 0` and `ghost drift 0.00px`, because prediction and reconciliation are unchanged; `fps 60 / frame 16.7ms`, because the sim is on its own thread. `tick @ 33.0/s` is the estimator's boot-catch-up window — measured over 20 s it is 30.01 Hz. Retake with `?local=1`. |

Determinism across the two hosts is a gate, not an impression: `pnpm parity`
runs the same seed in Node and in a browser and compares every sampled tick
hash. Four seeds × 1800 ticks × 60 samples agree exactly.

## The street: bodies, dropped guns, and the ambulance

Captured from a browser against a real server, with the casualties staged in
the session so the shot could be taken at all — ordinary play produces them
readily enough and never on cue.

| file | what it shows |
|---|---|
| `street-ambulance.png` | An ambulance that turned itself out to a casualty, pulled up on the road beside the scene with its brake lights on. On the pavement to the left: an officer's body, a pedestrian's, the casualty it came for, and two dropped guns. (Taken before the body and blood rework below, so the figures in it are the old flattened sprites.) |
| `street-blood-1-spray.png` | A second after the shooting, at 4×. The droplets are down: each mark on the pavement is where one of them actually landed, so the arc on the ground is the arc the blood took. The figures are laid out along the ground — head, torso, legs — rather than standing sprites squashed towards the camera. |
| `street-blood-2-pooled.png` | The same corner five seconds later. The pools have spread out from under each body and stopped; the spatter is still where it fell. One of those on the left is a casualty rather than a corpse — smaller, brighter pool, and it breathes. |
| `police-tiers.png` | The four forces on their feet, under the bodies. Patrol blue, SWAT charcoal with a helmet and visor, federal navy in a long coat, army olive with webbing and a rifle. Each is built off the patrol anatomy so they still read as the same species — before this a tier was the patrol figure under a different tint, which reads as an officer standing in a different light rather than as a different force. |
| `bodies.png` | Every state somebody can be found on the floor in, at seven angles, drawn through the real `drawBody`. Row 1 is a standing figure for scale — a head, two shoulders and the tops of two feet. The rest are drawings of their own rather than that one stretched: dead face-down (no face, the back of the head), dead on the back (face up), and — the one that earns its keep — **downed**, curled on one side with an arm across the chest, because a casualty on the bleed-out clock has an ambulance coming and a corpse does not. The sheet has grown since: below those come a downed officer, then the four forces on their feet — patrol, SWAT, federal, army — and the player, so the same page answers "does a body still read as the thing it was standing up" for every figure the game draws. |

## The chase

| file | what it shows |
|---|---|
| `wanted-hud.png` | The wanted readout at every state it can be in, drawn through the real `Hud`. Bright amber while they can see you; dimmed with a `hidden 3…2…1` countdown the moment nobody does; green and `losing them` once the heat is actually draining. This corner of the screen is the whole player-facing half of Wave P — an escape nobody can perceive is not a mechanic — and before it the stars had one appearance and told you nothing about whether you were getting away. Retake via `/hud-sheet.html`. |

Staging a three-star chase through scripted key presses turns out to be
unreliable for reasons that have nothing to do with the feature (see
`ci/play.mjs`), so this sheet chooses the states rather than provoking them —
exactly as the damage sheet below does. What produces those states is
covered by `shared/test/police.test.ts` and by `pnpm chase`, which measures
escape rate and survival time per star level over several seeds.

## Vehicles

| file | what it shows |
|---|---|
| `street-traffic.png` | One junction of a live game, captured from a browser against a real server. The point is the traffic: a purple coupe, a tan saloon, a red sports car, an orange hatch, two green estates, a taxi and an ambulance, all in one frame. Before R2 every civilian car in that shot would have been the same shape in a different colour. |
| `vehicles.png` | Every kind in `vehicles.json`, at game scale, through the real `drawVehicle`. The point is the silhouettes side by side: colour variation existed long before shape variation did, so ten colours of one car looked like variety and a street full of them did not. Six civilian bodies now differ in outline as well as paint, and the two-wheelers carry a visible rider — composited at the saddle, the same mechanism the tank's turret uses. The sheet found its own bug on first run: `moto` and `bicycle` drew as a solid red fallback rectangle, because they were given a colour axis in the art and left out of the renderer's painted-kinds set. |

| `airstrip.png` | Marsh End Airfield: the strip in open ground south of The Bowl, with its apron, its hangar bay and the driveway off Airfield Road. Anywhere City has two of these — this one and Gannet Rock Strip on the island — and both are **authored landmarks in `shared/data/city-plan.json`**, not rolled, because "there is an airfield, and it is over there" is a fact a player should be able to rely on. (The plate that stood here until this round was the pre-Anywhere-City generator at 480x480, showing a grid city with no airstrip in the frame; its stated command, `pnpm mapgen --seed=1`, draws the whole 1536x1536 map — the same picture as `city-anywhere.png`.) Retake: `node server/dist/tools/mapgen.js --crop=494,592,48 --scale=16 --out=evidence/airstrip.png`. |
| `flight-control.png` | The take-off control at every state it can be in, drawn through the real `Hud` with `canTakeOff` asked of the real sim. Altitude used to be the throttle — hold forward and a helicopter climbed, let go and it sank — which is two controls in one and neither of them working: you could not fly level at speed, you could not descend without cutting the engine, and there was no moment at which the pilot decided to leave the ground. It is one key now, and the row that earns the sheet is the amber one: a plane parked in a side street will not take off however hard you press, so the prompt says what the aeroplane is waiting for rather than lying about what the key does. Retake via `/flight-sheet.html`. |
| `flight-over-the-city.png` | A helicopter at cruise height doing 210 px/s over a park block, in a live game against a real server, with the prompt reading `[SHIFT] land`. What is NOT in the shot is the point of it: no tyre marks on the grass under it, no scattered pedestrians on the pavements either side, nothing crushed and nothing exploded. All four of those used to happen, because a flying aircraft still had a body on the ground plane — it mowed down the crowd it passed over, laid rubber on the street below, smashed the bollards, set off the barrels, and was then destroyed by the barrels it had set off. See `shared/test/overhead.test.ts`. |
| `fall.png` | Stepping out of a helicopter at cruise height, tick by tick, through the real `drawPlayer`. The heights across the sheet come out of the real sim — a real chopper flown up with the ordinary keys and stepped out of — so the arc is the game's, not a mock-up's. It exists because the fall was invisible: `stepStunts` gave the player a real quarter-second of gravity while the renderer pinned every on-foot sprite to the ground, so what you saw was a man standing still and then bleeding for no reason. Note the shadow staying put as the sprite rises off it, and the landing at `hp33` — a bail-out is expensive, not fatal. Retake via `/fall-sheet.html`. |

`ci/play.mjs` drives the real game in a real browser: it starts a session,
takes the kit the proving ground issues, and photographs what happens. Every
action goes through the ordinary input path, keys and mouse — `window.__debug`
is read, never written, so it is used to know when a thing has happened
rather than to make it happen.

```bash
PROVING_GROUND=1 PORT=8099 node server/dist/index.js
pnpm --filter client dev -- --port 5199
node ci/play.mjs "http://localhost:5199/?server=ws://127.0.0.1:8099" shots
```

Retake the vehicle sheet with
`node ci/shot.mjs http://localhost:5173/vehicle-sheet.html evidence/vehicles.png '#sheet'`.

## Damage

What the damage model looks like, for the change described in `DAMAGE.md`.

| file | what it shows |
|---|---|
| `damage-ladder.png` | One car at every rung of the breakage ladder, drawn through the real `drawVehicle` and the real light pass. |
| `damage-ladder-lamps.png` | The top row at full scale — showroom, one knock, bumper off, LEFT lamp out. The headlight cone narrows and shifts to the surviving lamp. |
| `hud-1-fresh.png` / `hud-2-damaged.png` | The HUD damage panel at 8×, before and after a prang. The damaged one is `broken = 0x4301`: front bumper, LEFT headlight only, both front tyres. |
| `live-*-hud.png` | The same panel, captured from a browser driving the actual game. |

## Bugs, and the repairs

Findings from the 3D play-test, written up in `BUGS.md`. The `bug-*` shots are
the record of what was wrong; the `fixed-*` shots are the same thing after.
They are here to be argued with, not admired.

| file | what it shows |
|---|---|
| `bug-ground-mirrored.png` | **BUGS.md §9.** The waterfront at tile (460, 362) with the painted ground mirrored north-for-south inside every 8×8-tile chunk — three.js's `flipY` upload turned over inside a world group that was already flipped. Carriageway painted across open grass with nothing joining it to anything, a near-black rectangle of building-footprint fill sitting in the open two tiles off its block, and a coastline whose sand and quay paint lands out on the water while the water's own cutout opens over dry land. Every symptom in the report is in this one frame. |
| `fixed-ground-mirrored.png` | **BUGS.md §9, fixed.** The same waterfront, one `texture.flipY = false` later. The roads join up and run where the tiles say they run, the black rectangle is gone, and the sand paint sits on the sand slabs. |
| `bug-ground-black-squares.png` | **BUGS.md §9.** Downtown from straight overhead, same fault: the black bands are the `wallShade` fill the painter puts under a building — meant never to be seen — drawn a couple of tiles clear of the building standing on it, while the buildings stand on ground painted as somebody else's block. 36% of the city's building tiles were painted road or pavement. |
| `fixed-ground-black-squares.png` | **BUGS.md §9, fixed.** The same block. Every building sits on its own footprint, the kerbs and lane lines line up with the carriageway under them, and the shop interior is inside its shop. |
| `bug-course-stub.png` | **BUGS.md §9.3.** A plain four-way crossroads at tile (530, 206) with a four-tile street course stroked across it at 20° — kerb casing, edge lines and centre dash on a diagonal road that does not exist. It survived the bake's three-tile floor because a junction is road in every direction, so every centreline sample landed on carriageway. |
| `fixed-course-stub.png` | **BUGS.md §9.3, fixed.** The same crossing with the trim's floor stated as three times the course's own width. The ribbon is gone and the junction reads as the square four-way it is drawn as; the two streets keep their own centre dashes. |
| `fixed-bridge-deck.png` | **BUGS.md §2.1, fixed.** The same cars, at the same `z = 0` the simulation gives them, on the same span. The deck is now drawn at road level with the carriageway markings running across it and a parapet on the edges that face open water — so every car is on the bridge instead of under it, and the beach beside it is sand rather than industrial yard. |
| `fixed-woodland.png` | **BUGS.md §2.2, fixed.** The same wood. `palette.trees` instead of the field green, and the planting is on top of the canopy column instead of buried 36 px inside it. It reads as a wood you drive around, which is what `isSolidTile` says it is. |
| `fixed-3d-bodies.png` | **BUGS.md §3, fixed.** Built by the real `EntityLayer` from the real snapshot shape. The tank has its barrel, traversed to its driver's aim rather than lying along the hull. The three two-wheelers on the road carry riders; the three below them are empty and show nobody. The four pedestrians wear four of the six shirts and stand on four different walk frames. |
| `bug-bridge-deck.png` | **BUGS.md §2.1.** Cars placed at `z = 0` — the height the simulation actually gives a ground vehicle — along the row that crosses a bridge. The two on the road are visible; every one on the span has been swallowed by a deck the renderer builds 46 px up, out of a volume grid the sim does not use. The sheer face where the road meets the deck is the missing approach: no bridge tile in the city has a ramp beside it. |
| `bug-woodland-plateau.png` | **BUGS.md §2.2.** Woodland. `T_TREES` stands 36 px proud as a collision volume but is painted the same green as open field, and `SceneryLayer` plants its trees at `z = 0` — inside the slab. What is left is a featureless raised mesa that reads as lawn from the game's own camera and stops a car dead. |
| `bug-3d-bodies.png` | **BUGS.md §3.1–3.2.** The vehicle meshes, built by the same `spriteGeometry()` calls the game makes. The tank (top left) has no barrel: `tank_turret` exists in the sheet and the 2D renderer traverses it to the driver's aim, and the 3D path has no turret code at all. The moto, copbike and bicycle along the top have no rider, for the same reason — `riderOffset` is never read. |
| `bug-shop-shaft.png` | **BUGS.md §2.5.** A shop interior. `T_FLOOR` sits at street level inside a building whose tiles run solid to the roof, so the shop is a light-well punched clean through the block, window-covered facades and all. Half of this turned out to be the design — the floor is documented "open to the sky" so you can look down into the room — and what was actually wrong was the floor being drawn in the industrial-lot grey, with no way to tell a gun shop from a garage. |
| `bug-runway-markings.png` | **BUGS.md §2.4.** The airstrip. `isRoad()` counts `T_RUNWAY` as road, so the carriageway-centre-line rule paints a dashed road marking down the one surface an aeroplane can take off from. |

Retake the terrain ones from the flyover, which has no player in the way, by
driving the camera yourself:

```bash
pnpm --filter client dev
# open /city3d.html?fly=1&seed=7&pitch=40&h=170 and, in the console:
#   requestAnimationFrame = () => 0        // stop the orbit
#   __city.lookAt(1024, 2856); __city.render()
```

## Retaking these

```bash
pnpm --filter client dev
node ci/shot.mjs http://localhost:5173/body-sheet.html evidence/bodies.png '#sheet'
node ci/shot.mjs http://localhost:5173/fall-sheet.html evidence/fall.png '#sheet'
node ci/shot.mjs http://localhost:5173/flight-sheet.html evidence/flight-control.png '#sheet'
```

Both contact sheets are pages rather than scripts, and both draw through the
real renderer rather than through a copy of it — the sprite generator's own
preview knows what it drew, and these know what the game asks for. The two
have disagreed.

The ladder sheet regenerates on demand — run the dev server and open
`/damage-sheet.html`. It is the quickest way to check the drawing after
touching any of the damage rendering, and it is why the sheet exists rather
than these files: the PNGs are a snapshot, the page is the tool.

## The six-lens graphics review

Captured during the review in `REVIEW-3D.md`. See there for what each finding
was and which of them are still open.

| file | what it shows |
|---|---|
| `bug-pavement-kerb.png` | The player and a pedestrian sunk into the pavement to the hips — no legs, and a black ring on the slabs where the outline hull of the buried half pokes through. `volume.ts` gives the kerb a height for a collision nothing reads yet, and `drawnSpans` drew it literally while every body is placed at zero. |
| `fixed-pavement-kerb.png` | The same street after. Bodies stand on the paving, the halo is gone, and the bushes have continuous outlines rather than the fan of black spikes the per-face hull normals gave them. |
| `bug-bridge-hole.png` | The gap under a bridge parapet, with the scene background set to magenta to prove it is a hole rather than a shading artifact — the stripe changes colour with the background. The deck was drawn as a 6 px slab stopping at -6 while the water beside it topped out at -8. |
| `city-3d-lit-night.png` | Night with the light rig repaired: a gradient map on the city's own materials, key above fill, shadow bias, and lamps that make pools instead of a wash. |

## The diagonal-road hunt

Findings from the second play-test, written up in `BUGS.md` §7. The curved
arterials rasterise to stair-stepped diagonal bands, and everything that
still assumed axis-aligned streets broke on them at once.

| file | what it shows |
|---|---|
| `bug-ring-markings.png` | **BUGS.md §7.1.** The ring road from above: phantom zebra crossings stamped at every stair step of the diagonal band, and fragments of centre line strewn along whichever axis happened to measure longer. The renderer's junction and marking rules were axis-only. |
| `fixed-ring-markings.png` | The same stretch after. The band is bare tarmac, as the 2D painter always drew it; crossings survive only where a street genuinely resumes on the far side of a junction. |
| `bug-ring-traffic.png` | **BUGS.md §7.3.** Trajectories of every AI car near the ring over 70 sim-seconds, drawn on the map: dense scribbles on the band where the cardinal lane model had no answer, and spiral orbits where a recovery target sat inside the car's turning circle. |
| `fixed-ring-traffic.png` | The same measurement after the fan-of-probes fallback and the tight-turn slowdown: cars sweep the band's curve, the orbits are gone. Grid streets are untouched — straight lines then, straight lines now. |

## The building lean (REVIEW-3D.md part four)

Reported from play as "the map generation is completely broken". It was not
worldgen — it was the drawn height of a building against the height of the
camera. All three are the same seed, the same corner (7736, 2968) and the same
tick, with the camera straight down so the ground plane maps linearly to the
screen and the two renderers can be compared pixel for pixel.

| file | what it shows |
|---|---|
| `bug-building-lean.png` | `Z_PER_STOREY` 24 drawn literally. A 9-storey block whose footprint is tiles 473–478 is drawn over 467.8–477.5 — magnified 1.58× by being 216 world px nearer the lens than the ground, and pushed 4.4 tiles further from the screen centre. It covers the four-lane carriageway and the pavement; the cars on that street are behind it. The near-black ground beside every block is the same 216 px throwing eleven tiles of shadow. |
| `fixed-building-lean.png` | The same frame at `Z_SCALE` 0.25. Blocks sit on their plots, the carriageway and its centre line are visible, the pavement has its paving joints back, and the lots are olive rather than black. |
| `building-lean-tilegrid.png` | The three-way, zoomed, with the world tile grid drawn over all of it in red: 2D on top, the bug in the middle, the fix at the bottom. The grid is what makes it arguable rather than a matter of taste — the fixed frame and the 2D frame put the same tiles in the same places. |

## The handover, and the pool sweep (BUGS.md §10)

Both complaints in §10 are about *transitions*, which a still cannot show —
a beam teleporting between two cars and a body being built for the first
time both live in the gap between two frames. The numbers are in §10 and the
invariants are in `client/test/lights3d.test.ts` and `entities3d.test.ts`.
These two are the corroborating stills: that the city still looks like
itself after the light slots learned to crossfade and the paint jobs started
sharing one body.

| file | what it shows |
|---|---|
| `lights-handover-night.png` | Seed 7 at `night=0.9`, ninety seconds in. Sixteen point slots and four spots against 55 asked for, the lamp pools on the road, the traffic lit and the shop signs on. Nothing about the scene changed with the crossfade — what changed is that no slot in it arrives or leaves in one frame. |
| `pool-sweep-day.png` | Seed 7 at midday with the proving ground on, a hundred seconds in — long enough for the pool sweep to have run several times. The distinct car colourways are the check that matters: variants now share one set of position and normal buffers between them, and a bug there would show as a street of identically painted cars. |

## Map generation, the coast as polylines, and buildings that face their streets

WORLDGEN.md §17–§22. Retake the flyovers with `pnpm --filter client dev`
running; the plangen sheets need no server.

| file | what it shows |
|---|---|
| `plangen-seed500.png` | A city nobody authored (§17): `generateCityPlan` rolls the land as polylines in an open sea, cuts boroughs out of a weighted Voronoi, routes the arterials with A* over an anisotropic cost, and hands the result to the same `bakeCity` and the same `checkCity` the drawn plan goes through. Retake: `pnpm plangen --seed=500 --png=evidence/plangen-seed500.png` — `plangen` parses `--key=value` only, so the space-separated form this line carried until now was silently ignored and it drew seed `NaN` into `plangen-seedNaN.png`. |
| `plangen-shore.png` | The shore parishes (§17.4). The leeward coast is a park borough with no streets in it, which is what lets the shore pass lay sand instead of a quay — before it, a generated city had a wall of harbour wherever a street reached the water. Retake: `pnpm plangen --seed=3 --crop=90,216,90 --png=evidence/plangen-shore.png`. The line here until now used the space-separated form and a bare `--crop`, which threw before it drew anything; the crop is `plangen`'s own documented example, and it is the one that reproduces the plate's 900x900 frame on this coast. |
| `city-shore-curve.png` | The coastline as one line (§18): `deriveShores` traces the water boundary, smooths it and thins it to polylines, and all three painters cut against the same curve — the 2D tile art, the 3D cutout mask and the wedges that give the sand a real edge. **This entry's command is `city-3d-shore.png`'s, and today it makes the same photograph** — the two are one camera and one picture, kept apart only because §15.4 and §18 each cited it. The plate that stood here until this round was a *different* camera: its own HUD reads `pitch 38°` and it shows a wooded shore with a road and a walled compound, at coordinates nothing recorded. A pitch-38 flyover cannot be photographed on this box at all — a frame at that pitch takes longer than playwright's 30 s screenshot timeout — so that camera is gone. Retake: `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=700,608&h=260&pitch=45&night=0" evidence/city-shore-curve.png`. |
| `city-shore-curve-2d.png` | The same coast in the 2D renderer, where the beach used to be a staircase of whole tiles. The tiles are unchanged; only the drawing is. |
| `city-facing-before.png` | North Point before §20: every house square to the world in boroughs whose streets run at 12° to it, which is the tell that the buildings were laid on the tile grid and the streets were not. |
| `city-facing-3d.png` | The same flyover now (§20, §22). Masses turned to the bearing their own tiles carry, standing on aprons turned with them and surfaced in the plot's own material, with the footprints — and therefore collision — untouched underneath. Buildings whose turn would shrink the mass under `MIN_FACING_FIT` stay square rather than draw a sliver. Retake: `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=634,116&h=190&pitch=45" evidence/city-facing-3d.png`. |

## VECTOR phase 0 — the review tool learns the curve layer

| file | what it shows |
|---|---|
| `vector-p0-tiles.png` | The same 80-tile crop of the 26° commercial borough drawn from the RASTER ALONE (`--tiles`): staircase roads, no kerbs, no lane markings, square buildings. This is everything `pnpm mapgen` could see before VECTOR phase 0 — and therefore everything three waves of §16/§20/§21 review were judged against. Retake: `node server/dist/tools/mapgen.js --crop=552,32,80 --tiles --out=evidence/vector-p0-tiles.png`. |
| `vector-p0-curves.png` | The same crop with the curve layer: road courses stroked as curves with kerb casing, edge lines and a centre dash flowing along the bend, and buildings drawn as the turned masses the game draws. **The difference between these two pictures is the curve layer**, and shrinking that difference to nothing is what VECTOR.md's remaining phases do. Retake: drop the `--tiles` flag. |

## VECTOR phases 1–2

| file | what it shows |
|---|---|
| `vector-p1-coast.png` | The waterline after the coast became a curve upstream of the raster (§25). The field was always continuous; `Math.round` in its sampler and a threshold to a mask were what stepped it. Contoured by interpolation instead, the share of waterline running within 7.5° of an axis falls from 55.1% to 19.7%, and the same coastline moves 0.3% of the map. The waterline in this crop is the strip across the top-left corner; the rest of the frame is the borough behind it, which was a diagonal fabric when the plate was first taken and is a square grid now — the fabric waves moved under the crop, and the crop coordinates are held fixed on purpose. Retake: `node server/dist/tools/mapgen.js --crop=470,390,80 --out=evidence/vector-p1-coast.png`. |
| `vector-p2-junctions.png` | Centre dashes stopping at crossings (§26). The per-tile painter had left junctions bare since the beginning and the ribbon painter drew straight through them — 5,780 junction tiles of contradiction. Junctions are now computed from where the CURVES cross and punched out of the dash, in the game and in this tool, which is the only way the tool can check the game. Retake: `node server/dist/tools/mapgen.js --crop=596,76,70 --out=evidence/vector-p2-junctions.png`. |

| `bridge-bevel.png` | The SE causeway after §31 taught the bevel plane about `T_BRIDGE`. A 45° crossing was a flight of stairs because its deck is rasterised and nothing softened it — every other diagonal edge in the city had been bevelled since §15. The water yields to the deck, so the carriageway overhangs its own cut and never gains a hole. Retake: `node server/dist/tools/mapgen.js --crop=620,600,70 --out=evidence/bridge-bevel.png`. |

| `world-edge-ocean.png` | The east map border after §32. The sea used to stop dead on the straight line x = 768 with the scene background behind it; it now runs to the horizon over a backdrop plane, so the plan's margin of open sea reads as ocean rather than as the end of the world. The green wedge top right is Fort Gannet, a real island. Retake: `WAIT_GROUND=10 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=750,427&h=280&pitch=55&night=0" evidence/world-edge-ocean.png`. |

| `woodland-jitter.png` | Ravenhill Park after §34. Trees stood dead on the tile lattice at identical scale, so a wood was a square grid of clones — rotation varied them, but a trunk is round, so turning it changes nothing you can see. Jittered off the centre and scaled per tree, both off `hash2`, so it stays a pure function of the tile. Retake: `WAIT_GROUND=12 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=500,95&h=150&pitch=45&night=0" evidence/woodland-jitter.png`. |

| `zebra-gated.png` | The Beachfront after §35. Crossings used to stack four to seven deep in open tarmac with no kerb at either end, because `junctionAt` reads the tile plane and a merged sheet of carriageway is "junction" across its whole area. Gated on the course crossings §26 computes from the curves instead. Retake: `WAIT_GROUND=14 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=465,410&h=200&pitch=45&night=0" evidence/zebra-gated.png`. |

## §42–43 — lanes on the graph, and collision on the coastline

| file | what it shows |
|---|---|
| `city-lanes.png` | The lane model (§42). Grey is each street's own LINE — the graph's tile-centre path pulled onto the course running down that street and smoothed; green and orange are the kerb lane a car keeps to going each way along it, placed as a fraction of the tarmac MEASURED either side of the line rather than of a nominal width, which is why they narrow with the street instead of running through the kerb. Every junction is a gap, on purpose: a junction has no sides to keep to and the junction machinery owns it. Retake: `node server/dist/tools/mapgen.js --lanes --crop=300,180,72 --out=evidence/city-lanes.png`. |
| `city-shore-collide.png` | What COLLISION thinks, stippled at eight samples a tile, over the fourteen tiles where the curve and the tile plane disagree most in the whole city — eleven tiles' worth of ground changes hands there (§43). The red is everywhere the movement solver calls solid, and it fills the drawn water exactly, because both now come off the same curve. Retake: `node server/dist/tools/mapgen.js --solid --crop=322,534,14 --scale=44 --out=evidence/city-shore-collide.png`. |
| `city-shore-collide-tiles.png` | The same fourteen tiles as the RASTER saw them — `--tiles` drops the curve from the drawing as well as from collision, so this is the whole pre-§25 world in one picture: staircase water, staircase wall. **The difference between the two pictures is a car's worth of sea.** The half of it that mattered is that the renderers took the curve in §25 and collision did not, so for four waves the waterline looked like the first picture and stopped a car like the second. Retake: add `--tiles`. |

## Review round 2 — R1-A01 and R1-A03

The `before` shots come from `city.data.ts` as committed at `1469611`; the
`after` shots from the rebake in the same commit as the fixes. Both retake
commands are the same line — what changed is the asset under it, so re-running
a `before` command today reproduces the `after` picture. That is the point.

| file | what it shows |
|---|---|
| `round2/A01-kelvin-bridge-before.png` | R1-A01. The signature span, missing. Kelvin Bridge's course was drawn to y=400 with the warped south bank at y=415, so the deck reached land on one side only and the no-piers pass reverted the whole span to sea. What is left is a four-lane carriageway with a painted centre line stopping in a rounded cap on a bare bank, and a second stub on the far side with nothing between them. Retake: `node server/dist/tools/mapgen.js --crop=436,336,44 --scale=16 --out=evidence/round2/A01-kelvin-bridge-before.png`. |
| `round2/A01-kelvin-bridge-after.png` | The same crop with the course extended eighteen tiles to y=418, three tiles onto the far bank. The deck now has two landfalls, survives the no-piers pass, and the crossing runs unbroken through the frame. Same command, `-after` for the name. |
| `round2/A01-gate-before.txt` | The gate's own reproduction: `checkCity`'s new bridging-road rule run against the shipped city BEFORE any plan edit, naming Kelvin Bridge and Marsh Causeway — and finding the Ring's east crossing and three stretches of the Coast Road nobody had filed. Retake: `npx vitest run server/test/shippedCity.test.ts` on a checkout with the plan reverted. |
| `round2/A03-docks-before.png` | R1-A03. The Docks: five long north-south strips of block, no cross street anywhere in the borough, biggest block 27x158 in a borough pitched at 28x24. The contour fabric's cross streets were carved parallel to the bands they exist to cross, because the frame's shore sample found nothing and fell back to the authored `angle: 0`. Retake: `node server/dist/tools/mapgen.js --crop=28,248,166,176 --scale=6 --out=evidence/round2/A03-docks-before.png`. |
| `round2/A03-docks-after.png` | The same crop with the sample taken relative to the borough's own innermost band: 51 blocks against 14, median 330 against 1691, biggest 30x22 against a 28x24 cell. Same command, `-after` for the name. |
| `round3/A08-marsh-end-before.png` | R1-A08. Marsh End Airfield from straight overhead, before the hut moved. The 3x3 hangar is stamped in the runway's own north-west corner, and `runwayCentreRow` — which walks each COLUMN to that column's runway edges — puts the three shortened columns' dash a row south of the rest, so the strip is marked with a kink at x=507 and the line restarts below itself. The 2-wide break crossing the strip near the middle is the bake's access driveway to the hangar, which is a taxiway with a job and stays. Retake: `pnpm --filter client dev`, then `WAIT_GROUND=8 node ci/shot.mjs "http://localhost:5174/city3d.html?fly=1&at=517,602&h=430&pitch=0&night=0" evidence/round3/A08-marsh-end-before.png` on a checkout with the plan and recipe reverted. Note the framing: both A08 plates are 1400x900 and `ci/shot.mjs` shoots its viewport at 2200x1000, so a retake reframes rather than reproduces. The CONTENT of the `-after` plates is current — their HUD reads `4014 buildings`, this tree's count — and a fresh shot at 2200x1000 puts the same hangar, apron and centreline in a wider frame. |
| `round3/A08-marsh-end-after.png` | The same view with the hangar on a three-column bay of hardstanding at the west end — the rect grew by exactly those three columns, so the strip keeps the 30-tile run it was drawn with — and the runway an unbroken rectangle beneath one centreline that runs the whole length. Same command, `-after` for the name. |
| `round3/A08-gannet-before.png` | The same fault at Gannet Rock Strip, the island you can only reach by air: hangar in the slab, centreline jogging at x=79. Retake as above with `at=89,643`. |
| `round3/A08-gannet-after.png` | Gannet Rock with its hut on the apron and its line running true. Same command, `-after` for the name. |

## Review round 3 — R1-B01, the lamp that burned at noon

The `before` shots are `ae643ba`; the `after` shots the commit that made the
bloom threshold a ratio to the key light. Every plate is the shipped camera at
1280x720, taken with `evidence/round3/F-R1-B01-shot.mjs` — `ci/shot.mjs` waits
for `networkidle`, which the live client never reaches. Start the dev server
first (`pnpm --filter client dev`) and read a plate back with
`node evidence/round3/V-R1-B01-read.mjs <png> 40,450` or profile a scanline with
`node evidence/round3/V-R1-B01-profile.mjs 450 24 72 <png>...`.

**These six are the one set here that a whole-frame diff cannot judge, and the
one set that is not retaken.** They photograph the live game, not a flyover:
traffic, pedestrians and a lamp flicker that rides on wall-clock all move
between runs. Two runs of the same command on the same build, measured this
round, differ over **15% of the frame** (141,099 of 921,600 px at noon;
136,315 at night) — so a percentage against the committed plate says nothing
about whether the plate is current, and replacing an `after` plate would
break its pairing with a `before` plate taken at `ae643ba`.

Read them with the luma instrument instead — and re-find the lamp before you
trust the address. `(40,450)` was the shaded roof in the city as baked at
round 3; after the round-4 rebake that pixel is lit ground, and the
`lights=off` control reads luma 52 there rather than the 4 the rows below
quote. The addresses in this section are frozen to the round-3 bake, not to
the current one.

| file | what it shows |
|---|---|
| `round3/F-R1-B01-3d-noon-before.png` | R1-B01. A street lamp reading as switched on at midday: the fixture blown out and a warm halo thrown across tarmac the sun does not reach. At (40,450) the shaded roof reads luma 129 where `?lights=off` reads 4 — thirty-fold, from a lamp whose *direct* light there measures +0. The halo is bloom: `lights3d`'s `lit` floor keeps a lamp 15% on by day, its bulb sits ~3 world px from the resulting 74 cd point source, and `UnrealBloomPass` emits the whole texel it admits rather than the excess. Retake: `node evidence/round3/F-R1-B01-shot.mjs "http://localhost:5173/?local=1&seed=7&night=0" evidence/round3/F-R1-B01-3d-noon-before.png`. |
| `round3/F-R1-B01-3d-noon-after.png` | The same frame with the bloom threshold scaled by the key light. (40,450) reads 3 against the control's 4: the halo is gone and the fixture reads as a switched-off lamp. Same command, `-after` for the name. |
| `round3/F-R1-B01-3d-noon-lightsoff.png` | The control the two above are measured against — midday with `?lights=off`, so no street lighting exists at all. The `after` plate matches it across the lamp to within a luma. Retake: same command with `&lights=off`. |
| `round3/F-R1-B01-crop-noon-before.png` / `-after.png` | The lamp itself, 140x100 px of the frame at 5x. Before: a blown bulb and a halo up the wall. After: the grey head and cream bulb of the art, unlit. |
| `round3/F-R1-B01-3d-night-before.png` / `-after.png` | The gate on the fix. At midnight the key light sums to 1.00, so the threshold is still exactly its old 1.05 and the night is untouched: (40,450) reads 148 either side, and a whole-frame diff finds fewer differing pixels between the two than between two runs of the *same* build (the lamp flicker rides on wall-clock). Retake: same command with `&night=1`. |

## Review round 3 — R1-C02, the officer who witnessed from the pavement

Text, not pictures: the finding is a boolean the sim computes, so the plate is
the verdict itself. `node evidence/round3/F-R1-C02-corpse-witness.mjs` prints
all five rows in about a second and needs no server.

| file | what it shows |
|---|---|
| `round3/F-R1-C02-corpse-witness.mjs` | R1-C02's repro. An officer 80 px away on a clear line, and 60 rounds of the silenced pistol fired the OTHER way — outside the 34 px the gun carries, so the only thing that can notice is `noticedBy`'s sight branch. Rerun it with `node evidence/round3/F-R1-C02-corpse-witness.mjs`. It replaces `round1/C-repro-corpse-witness.mjs`, which posts its officer at a hard-coded +80 px in x: open ground at round 1, inside a wall after the round-2/3 worldgen work, so that script now prints `false` on every row including its own control and shows nothing either way. |
| `round3/F-R1-C02-before.txt` | The bug at `3bd853e`. All four officer rows read `true` / heat 18.0: a corpse and an invisible fugitive are witnesses on exactly the same terms as a live officer watching a visible one — `noticedBy` looped the cop table with `if (!cop) continue` as its only filter and called `hasLineOfSight` directly, so it had neither the down check `anyCopSees` carries nor the invisibility gate inside `copSees`. Every noticed shot resets `unseenTicks` (`state.ts` `addHeat`), and `peds.json` `corpseSec: 40` keeps the body in `state.cops`, so a cleared street reported you for forty seconds and the invisibility power-up could not stop it. |
| `round3/F-R1-C02-after.txt` | The same run with the sight branch going through `copSees` and bodies skipped. Only the live-and-visible control still notices — heat 18.0, `unseenTicks` 0 — and the corpse and the invisible player now read `false` / heat 0.0, level with the no-officer control. The control row is the proof the fix did not go too far; `shared/test/noise.test.ts` holds all three cases. |
## Review round 4 — R1-A02, the creek nobody crossed

The `before` plates are `3bd853e`; the `after` plates the rebake in the same
commit as the fix. Both retake commands are the same line — what changed is
the asset under it — so re-running a `before` command today reproduces the
`after` picture.

| file | what it shows |
|---|---|
| `round4/A02-esplanade-before.png` | R1-A02. Hollis Creek at The Esplanade, before. The creek is eight tiles of water, and the seafront arterial drawn straight across it stops dead on both banks in a rounded turning head — the plan carried `bridges: false` on the road, so the bake was never allowed to lay a deck. Nothing was broken enough to fail: the two banks are connected, just 458 road tiles apart the long way round the creek's head. Retake: `node server/dist/tools/mapgen.js --crop=372,408,44 --scale=16 --out=evidence/round4/A02-esplanade-before.png`. |
| `round4/A02-esplanade-after.png` | The same crop with the road's `bridges` flag flipped to true: 31 tiles of deck at x394-401, y423-427, the Esplanade running through the frame unbroken, and the bank-to-bank drive down from 458 tiles to 20. Same command, `-after` for the name. |
| `round4/A02-longacre-before.png` | The creek's other arterial, Longacre Road, four tiles from bank to bank and stopped in the same pair of turning heads. 124 road tiles between them. Retake: `node server/dist/tools/mapgen.js --crop=310,505,60 --scale=12 --out=evidence/round4/A02-longacre-before.png`. |
| `round4/A02-longacre-after.png` | The same crop crossed: 10 tiles of deck at x332-334, y530-533, and 6 tiles between the banks. Same command, `-after` for the name. |

## Review round 5 — R5-A01, the resprays carved through eight landmarks

The `before` plates are `ec98bf9`; the `after` plates the rebake in the same
commit as the fix. Both retake commands are identical lines — what changed is
the asset under them — so re-running a `before` command today reproduces the
`after` picture. The crop is Kelvin Road Station; the same before/after holds
at The Spire, the Halloran Building, St. Brannoch, Riverside and Seaview
Infirmaries, Sunridge Station and Marsh Post.

| file | what it shows |
|---|---|
| `round5/A-repro-shops-in-landmarks.mjs` | R5-A01's repro, read straight off the shipped `city.data.ts`. Prints every shop whose host building overlaps a landmark's rect, then draws Kelvin Road Station, The Spire and Marsh Post as tiles. At `ec98bf9` it printed `8 of 66 shops are carved into a landmark` — all eight resprays — and the three drawings showed a `T_FLOOR` room inside a one-tile wall ring. After the fix it prints `0 of 66` and all three landmarks draw as solid `B`. Rerun: `node evidence/round5/A-repro-shops-in-landmarks.mjs`. |
| `round5/A-check-shop-quota.mjs` | The claim the fix rests on: bakes the plan fresh and prints the quota, its per-kind split, and the landmark-hosted count. `66 shops {"gun":20,"clothing":20,"spray":26}` both before and after, `landmark-hosted: 8` before and `0` after — excluding the landmark masses costs no shops, it only moves eight of them onto ordinary houses. Rerun: `node evidence/round5/A-check-shop-quota.mjs`. |
| `round5/A-before-kelvin-carved.png` | Kelvin Road Station at `ec98bf9`, 16 tiles at 36x. The police station is not a mass: it is a one-tile wall ring around a floor room, with a two-tile garage gap punched through the north wall and the shop-door marker on the pavement outside it. That door sells a respray, `economy.ts` makes a respray a drive-through with `DOORWAY_RADIUS_PX * 2` of reach, and a respray clears the wanted level — so the buy landed from the road tile outside the station's own front door, heat 450 to 0 and wanted 4 to 0 without leaving the car. Retake: `node server/dist/tools/mapgen.js --tiles --crop=466,437,16 --scale=36` and rename the `mapgen-crop-466-437.png` it drops in the repo root. |
| `round5/A-after-kelvin-solid.png` | The same crop after the bake stops offering its landmark masses to `placeShopsFixed`: one solid seven-by-seven police station, no ring, no room, no garage door, no shop marker. Same command, `-after` for the name. A whole-plane diff of the two bakes finds 280 differing tiles and nothing else — 217 floor back to building (the eight rooms filled in), 52 building to floor (the eight replacement shops, now on ordinary houses), 11 floor to park (see below); the building, landmark, block and district planes are byte-identical. |

Those 11 `floor -> park` tiles are a **pre-existing** defect this fix merely
unmasked, filed for the next round rather than fixed here: a park's ground
paint overruns three columns of Marsh Post's stamped footprint, and until now
the illegal shop carve was painting `T_FLOOR` back over two of them. Marsh
Post therefore draws as a four-tile-wide building inside a seven-tile
landmark rect. Nothing in `checkCity` looks at whether a landmark's own mass
survived the ground passes.

## Round 7 — the landmark that lost its walls, and the boats in the ponds

The two nits round 6 confirmed, fixed. Both are about a worldgen pass that
asked a local question and got a locally correct answer.

**R5-A04** is the defect the round-5 note above filed and did not fix. The
bake stamps a landmark's mass from `RECIPES[kind].parts` and then goes on
painting: `ground()` guards only on `paintable()`, which explicitly permits
`T_BUILDING`, so Chapel Green's four-tile reclaim apron — painted twelve
landmarks after Marsh Post was stamped — repainted three columns by six rows
of the police station to `T_PARK`. The `Building` record went on claiming all
forty-nine tiles. Nothing downstream reads that record for solidity
(`collide.ts`, `volume.ts`, `cityGeometry.ts`, `extrude.ts` all follow the
tile plane), which is precisely why nothing went red.

The fix is a mask, not a re-stamp: `solid()` records every tile a landmark
stamp made a wall, and `ground()` refuses to paint one. It sits one line from
the `landmarkBuilt` guard that already stops the same pass DEMOLISHING
another landmark's records — the two halves now agree.

**R5-A03**: `placeBoatSpawns` asked for a 3x3 of open water and a bank within
three tiles and never asked whether the water went anywhere, so five of the
city's 460 moorings were motorboats in two ornamental park ponds. One
border-seeded flood over the water-or-bridge medium now labels the sea once
per bake (~6 ms; a flood per candidate would be 13,391 of them), and a
candidate outside it is not a mooring. Water-or-bridge is exactly what
`collide.ts` lets a boat occupy, so BUGS.md §9.2's older guarantee — no
mooring shut in by a bridge — is kept by the same test.

The seagoing test sits with the pass's other guards rather than at the point
the mooring is pushed, and that costs nothing: the scan produces 557
candidates and `spread` caps them at 460, so ANY change to the candidate list
reshuffles which moorings ship. There was no minimality to buy by filtering
late. The count is 460 before and after; only the five in the ponds are gone.

| file | what it shows |
|---|---|
| `round7/census-live.mjs` | The round-6 census re-pointed at a LIVE bake instead of the shipped bytes, so the fix can be measured before the city is rebaked. Prints two censuses: RECORD (a `Building` record the tile plane no longer backs — round 6's question) and RECIPE (every tile `RECIPES[kind].parts` stamped still `T_BUILDING` — the question `checkCity` now asks). At `a6f115a` both print `affected=1 of 29`, Marsh Post, the same 18 tiles; after the fix both print `0 of 29`. Rerun: `node evidence/round7/census-live.mjs`. |
| `round7/A04-before-marsh-post.png` | Marsh Post at `a6f115a`, 20 tiles at 26x. The police station is drawn as an L: three of its seven columns are park, inside its own sidewalk ring, with the doorway marker on the pavement below. Retake: `node server/dist/tools/mapgen.js --crop=530,543,20 --scale=26 --out=evidence/round7/A04-before-marsh-post.png` — against the pre-fix `city.data.ts`. |
| `round7/A04-after-marsh-post.png` | The same crop after the rebake: one solid seven-by-seven station filling its ring. Same command, `-after` for the name. |
| `round7/A03-moorings.mjs` | Renders a crop with every mooring in it marked, because `mapgen` draws ground and a boat spawn is not ground. White dot = its water reaches the open sea; magenta dot over a red cross = it does not. Usage: `node evidence/round7/A03-moorings.mjs <x> <y> <size> <out.png>`. |
| `round7/A03-before-ravenhill-pond.png` | Ravenhill Park's pond at `a6f115a`: 86 tiles of water inside a closed ring of sand inside grass, with two motorboats moored in it. Retake: `node evidence/round7/A03-moorings.mjs 494 49 22 evidence/round7/A03-before-ravenhill-pond.png` — against the pre-fix `amenities.ts`. |
| `round7/A03-before-sunridge-pond.png` | Sunridge Park's pond, 107 tiles, three motorboats. Retake: `node evidence/round7/A03-moorings.mjs 290 637 24 evidence/round7/A03-before-sunridge-pond.png`. |
| `round7/A03-after-ravenhill-pond.png` / `A03-after-sunridge-pond.png` | The same two ponds, same commands, `-after` for the name: the ponds are unchanged — WORLDGEN.md §29 gave them their rings and beaches on purpose — and there is no boat in either. |
| `round7/A03-after-harbour-control.png` | The positive control, and the reason the plate above is not just "the pass stopped working": the north shore off the Coast Road, three moorings still drawn and all three white. City total is 460 moorings before and after. Retake: `node evidence/round7/A03-moorings.mjs 505 0 40 evidence/round7/A03-after-harbour-control.png`. |
| `round7/probe-flood.mjs` | What the seagoing flood costs at map scale: 293,883 sea tiles of 589,824, ~6 ms per flood after warm-up, against a ~16 s bake and a ~500 ms `generateCity`. Rerun: `node evidence/round7/probe-flood.mjs`. |
## Review round 6 — R5-C01 and R5-C03, both in `shared/src/sim/traffic.ts`

| file | what it shows |
|---|---|
| `round5/C-repro-ped-boards-cruiser.mjs` | R5-C01's repro, unchanged, run against the fix. **Before**, both rows board on tick 3, and the cruiser's row reads `driver.trip=0 movedPx=0.0` against the control's `1496 / 55.7` — the car took an ambient driver that `stepTraffic` then refused to steer, and 30000 ticks never released it; the budget rows read `frozen=2 circulating=12` and `frozen=3 circulating=11` against a target of 14. **After**, the control still fires (`boardedAt=3 driver.trip=1496`, which is what makes the negative row mean anything) and the cruiser reads `boardedAt=null driverId=null pedsLeft=20`, with `frozen=0 circulating=14` at every staging. Its part 3, natural play with no staging at all, went from three of six seeds boarding a police vehicle within ten minutes — seed 101 climbing into a roadblock TANK at 55 s and sitting in the same pixel for the rest of the run, five tanks on the map against `vehicleCaps.tank` of 3 — to `no natural boarding of a police vehicle in 18000 ticks` on all six. Rerun: `node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 9000` and `node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 500 natural`. |
| `round6/F-R5-C03-fleet-real-scale.mjs` | R5-C03's before/after at the scale a session actually runs at, and the script's own header says what the filing's repro gets wrong: it lays 193 vehicles where `session.ts` lays **655** (166 ranked kerbside cars + the vehicle homes + 460 moorings) and 200 peds where it lays **799**, it wedges its player at t=240s so sixteen of its twenty minutes are parked, and it blames the wrong line. **Before**: 655 → 727 in ten minutes (+11.0%), and the split is `cull 30 events / alight 49 events over 38 cars` — the cull the filing names is the minority path by five to one, so a fix aimed only at `stepTrafficPopulation` removes about a sixth of the growth and verifies clean while the leak keeps running. `minted 78, removed 6`. **After**: 655 → 700 (+6.9%), `cull 0` (a culled car now leaves the table outright rather than becoming permanent street furniture), `minted 90, removed 45`. Both trees plateau while the player stays in one district — the litter fills the spawn ring until `aiSpawnPlacement`'s 30 px occupancy test rejects everything — so the last line is the one that settles it: park the player across the city and **before** the table stays at 727, all 72 surplus cars traffic-minted and permanent, while **after** it returns to exactly the designed 655 with 0 traffic-minted cars left anywhere. Sim cost at t=600s went 32.5 → 28.6 s per 1000 ticks against a 33 ms tick budget. Rerun: `node evidence/round6/F-R5-C03-fleet-real-scale.mjs 18000 3`. |

Both fixes turn on provenance rather than on appearance. A parked police
vehicle and a parked civilian car are the same object to `stepBoarding` unless
something remembers who put it there, and so are a kerbside car the session
laid down and a car ambient traffic abandoned. `copFleet` was already the
register for the first; `ambientFleet` (state.ts) is its twin for the second,
and `putAiVehicle` is its only writer.

## Visual loop, iteration 2 — the four map-audit findings

`before` plates are the shipped asset at `fcf0809`; `after` plates the one
rebake at the end of the round. Both retake commands are the same line — what
changed is `city.data.ts` under it — so re-running a `before` command today
reproduces the `after` picture. `mapaudit-{before,after}.txt` and
`citybake-check-{before,after}.txt` are the round's two scores.

| file | what it shows |
|---|---|
| `iter2/gannet-corridor-before.png` | `bare-corridor` at 84,595. Gannet Rock, which the plan calls wild and trackless, with a seven-tile dead-straight clearing running thirty-two tiles through its wood and no carriageway in it. The orphan prune took the island's whole lattice out and wrote `T_FIELD`, which restores the ground and not the canopy the carve cleared. Retake: `node server/dist/tools/mapgen.js --crop=84,595,52 --scale=12 --out=evidence/iter2/gannet-corridor-before.png`. |
| `iter2/gannet-corridor-after.png` | The same crop with the country grown back over what the removal orphaned: the canopy closes, and one tile of the clearing is left open as a ride, because the corridor was also the only way from the meadow north of the airstrip to the strip and planting it shut walled 4,210 tiles off from everything. One tile wide, so it is a path through a wood and not the shape of a road. Same command, `-after` for the name. |
| `iter2/oldsuburbs-mouth-before.png` | `road-stops-short` at 401,594, the one hit of the seventeen that is genuinely impassable: the Old Suburbs seam street stops at 413,606 with three tiles of grass and an orchard tree across its mouth, four tiles short of the street it runs at. Retake: `node server/dist/tools/mapgen.js --crop=401,594,24 --scale=20 --out=evidence/iter2/oldsuburbs-mouth-before.png`. |
| `iter2/oldsuburbs-mouth-after.png` | The junction cut. Same command, `-after` for the name. |
| `iter2/hollis-lower-before.png` | `crossing-missing` on the lower Hollis Creek: four tiles of water between two pieces of road network, 144 tiles of driving to get round. Round 4 gave the creek its two arterial crossings a hundred tiles apart; this stretch had none. Retake: `node server/dist/tools/mapgen.js --crop=360,470,60 --scale=10 --out=evidence/iter2/hollis-lower-before.png`. |
| `iter2/hollis-lower-after.png` | Hollis Bridge, six tiles of deck at x388-393 y490-493, carrying the street that already ran to both banks. One crossing answers all three of the signature's hits. Same command, `-after` for the name. |
| `iter2/kerb-vantage-before.png` | `kerb-missing` at 483,81. Vantage Tower with the bake's own access track cut down its east flank, eight tiles of carriageway against the wall and no pavement between. Retake: `node server/dist/tools/mapgen.js --crop=483,81,28 --scale=18 --out=evidence/iter2/kerb-vantage-before.png`. |
| `iter2/kerb-vantage-after.png` | The track one tile further out, with the kerb where it belongs and the tower's mass untouched. Same command, `-after` for the name. |
| `iter2/kerb-seaview-before.png` / `-after.png` | `kerb-missing` at 570,415, Seaview Infirmary: the author's rect abuts a lattice street, so the hospital's east wall stood on it. After: the plot is held one tile off the road and the freed row is paved. Retake: `node server/dist/tools/mapgen.js --crop=570,415,27 --scale=18 --out=evidence/iter2/kerb-seaview-before.png`. |
| `iter2/kerb-sunridge-before.png` / `-after.png` | The same at 295,454, Sunridge Station. Retake: `node server/dist/tools/mapgen.js --crop=295,454,26 --scale=18 --out=evidence/iter2/kerb-sunridge-before.png`. |

## Visual loop, iteration 3 — the country outside the block grid

`before` plates are the shipped asset at `295e29c`; `after` plates the one
rebake at the end of the round. Both retake commands are the same line — what
changed is `city.data.ts` under it — so re-running a `before` command today
reproduces the `after` picture. `mapaudit-{before,after}.txt` and
`citybake-check-{before,after}.txt` are the round's two scores: 47 candidates
either side, every signature unmoved, and the same six known-broken crossings.

| file | what it shows |
|---|---|
| `iter3/gannet-north-before.png` | The whole of Gannet Rock. The district polygon begins at y=598 and the island runs up to y=566, so the northern third carries no block — and the block fill is the only thing that plants country, so it shipped as 3,019 tiles of unbroken meadow with the canopy starting on a dead straight line at y=600 where the block grid does. The ruler down the middle is the ride the last round's carve-back cut. Retake: `node server/dist/tools/mapgen.js --crop=56,558,124 --scale=8 --out=evidence/iter3/gannet-north-before.png`. |
| `iter3/gannet-north-after.png` | The same question asked of the ground no block covers: the wildness field the blocks were filled from, asked again. The wood carries on over the y=600 seam, the north gets the stand the field always said was there, and the ruler is gone — 5.1% of the plate's pixels move. Same command, `-after` for the name. |
| `iter3/gannet-ride-before.png` | The ride, close up: a dead straight one-tile slot forty-eight tiles long through the canopy. The carve-back could only take back tiles it had just planted, and what it had planted over a removed street is a corridor with a block wall of trees down each side — so the only route it could find was the vanished street, end to end. Retake: `node server/dist/tools/mapgen.js --crop=88,598,52 --scale=14 --out=evidence/iter3/gannet-ride-before.png`. |
| `iter3/gannet-ride-after.png` | No ride here at all. A ride may now cross any woodland standing in open country (never a tree at the waterline, which is the cliff), so the search finds the narrowest neck between two pieces instead of the length of a street that is not there: the island's four severances are answered by nothing, 5, 5 and 6 tiles of canopy. Same command, `-after` for the name. |
| `iter3/marsh-end-before.png` | Marsh End, the same defect without an island to make it obvious: 3,881 tiles of country outside its blocks with not one tree in them, against 41.5% wood in the country inside. Retake: `node server/dist/tools/mapgen.js --crop=430,600,90 --scale=11 --out=evidence/iter3/marsh-end-before.png`. |
| `iter3/marsh-end-after.png` | 32.3% wood outside the blocks, and the stands either side of a block seam now agree about where the wood is. Same command, `-after` for the name. |
| `iter3/ring-mouth-before.png` / `-after.png` | `road-stops-short` at 264,385: three lattice streets held one block short of the ring (§14.3 D6, working as specified) ending in grass rather than at anything. **These two plates are identical — 0 differing pixels — because the fix was withdrawn.** See below. Retake: `node server/dist/tools/mapgen.js --crop=252,378,24 --scale=22 --out=evidence/iter3/ring-mouth-before.png`. |
| `iter3/ring-mouth-withdrawn-kerb.png` | What the withdrawn fix looked like: `laySidewalk`'s own rule — every tile of bare ground touching a road becomes kerb — asked of the mouth the block grid does not cover. 81 mouths, 403 tiles, and nine of the thirteen audit hits drop from `med` to `low` ("a kerb a car can mount"). It is not in the shipped asset: pavement is where the crowd, the props and the kerbside cars live, so 403 tiles of it along the ring adds 11-15 kerbside parking spots on a motorway verge, which moved `police.test.ts` "a wave arrives together, then the street goes quiet" and `secrets.test.ts` "the same player is paid exactly once" off their staging. §14.3 D6 says changes to ring access ship behind `pnpm chase`; this is an escalation, not a fix. |

## Visual loop, iteration 4 — the two boroughs the vector work skipped

`before` plates are the shipped asset at `e3306c8`; `after` plates the one
rebake at the end of the round. Both retake commands are the same line — what
changed is `city.data.ts` under it — so re-running a `before` command today
reproduces the `after` picture. `mapaudit-{before,after}.txt` and
`citybake-check-{before,after}.txt` are the round's two scores: 55 candidates
before and 54 after, `course-coverage-outlier` 2 to 0, and the same six
known-broken crossings.

The finding was `course-coverage-outlier`: The Spine at 20.4% of its
carriageway under a course and Old Suburbs at 28.7%, against an 82.8% median
borough. The cause is in `layout.ts`' `weaveFabrics`: every fabric branch
records its lattice's centrelines as it carves — `carveLine` for a rotated or
contour lattice, `carveWavy` for a crescent, `traceBands` for a band — except
the plain axis-aligned grid, which carved and recorded nothing. Instrumented,
The Spine carved 18 lattice lines and pushed 0 courses; Old Suburbs carved 14
and pushed 0. Those two are the only non-rural boroughs the plan leaves at
`angle: 0` with no `fabric`, which is why only those two show up.

**The tile plane does not move.** All 589,824 tiles, the district plane, the
bearing plane, and the block, building and shop lists are byte-identical to
the `e3306c8` bake; the only difference in `city.data.ts` is 347 courses
becoming 380. The recorded course is clipped to the extent `line` actually
carved rather than run out to the borough's bounding box — the bounding-box
form was measured first and moved 75 tiles of tarmac out in Sunridge Shore,
because a centreline filed over another borough's country is a road as far as
`doubledAgainstCourses` is concerned.

| file | what it shows |
|---|---|
| `iter4/spine-before.png` | The Spine at 430,150. The vertical avenue on the right and the diagonal one across the bottom carry kerb casing and a centre dash, because they are authored roads with courses. Every street of the downtown lattice around them is bare dark tarmac: no kerb line, no dash, no junction punch-out, no bevel — the pre-§16 treatment, on a quarter of Kelvin's downtown. Retake: `node server/dist/tools/mapgen.js --crop=430,150,48 --scale=16 --out=evidence/iter4/spine-before.png`. |
| `iter4/spine-after.png` | The same tiles — not one has changed — with the lattice's 18 centrelines recorded. Every street now has its kerb casing and centre dash, and the blocks read as blocks with roads around them instead of as gaps in a sheet. Same command, `-after` for the name. |
| `iter4/oldsuburbs-before.png` | Old Suburbs at 250,520. The two curved avenues and the diagonal have their casing; the two horizontal cross streets left and right of centre are flat slabs with a dash painted on the tile grid. Retake: `node server/dist/tools/mapgen.js --crop=250,520,48 --scale=16 --out=evidence/iter4/oldsuburbs-before.png`. |
| `iter4/oldsuburbs-after.png` | The same crop with the cross streets given their lines: rounded kerb ends where the street stops, casing down both sides. Same command, `-after` for the name. |
| `iter4/coverage-{before,after}.txt` | Per-borough course coverage for all fourteen rated boroughs, by the renderer's own `courseCover` rule. The Spine 20.4% to 91.6%, Old Suburbs 28.7% to 78.6%, no borough down, city-wide 75.5% to 85.4%. |
| `iter4/cause-probe.txt` | The instrumented `weaveFabrics` run behind the claim above: lattice lines carved and courses pushed, per axis-grid borough. |
| `iter4/plane-diff.txt` | The bounding-box variant's 75 moved tiles, kept as the reason the shipped form clips to the carve. The shipped bake's own diff against `e3306c8` is 0 tiles. |
| `iter4/mapaudit-{before,after}-detail.txt` | The two signatures that moved, listed in full. `road-stops-short` is unchanged at 13 — the same thirteen, the ring shave working as specified. `street-serves-nothing` goes 4 to 5: the new hit is an Old Suburbs cross street at 244,552 (254,568 to 266,568), and it is a **consequence of the fix, not a new defect in the map** — that street's tarmac was always there and always terminal at both ends, but the signature is course-based, so with no centreline under it the detector could not see the street to judge it. Giving the borough its curves also gave the audit something to look at. Low, and in a family the audit itself marks `noisy`. |
| `iter4/plane-diff-shipped.txt` | The shipped bake against `e3306c8`: 0 of 589,824 tiles differ, district and bearing planes unmoved, blocks, buildings and shops byte-identical, courses 347 to 380. This is what "the fix adds centrelines and nothing else" means, measured. |
## Visual loop, iteration 4 — the two signatures the audit was blind to

Iteration 3 fixed two real visual defects and the audit score did not move at
all, because neither defect had a signature. This round writes the two
signatures instead of touching the map: **no game code changes, no rebake**,
so `pnpm test` and `citybake --check` are unchanged by construction.

The pre-fix asset is the known-positive for both, and is not in the tree —
take it out of git first, and export it for the measurement scripts:

```bash
git show e3306c8~2:shared/src/world/city.data.ts > /tmp/prefix.city.data.ts
export OLD_CITY_DATA=/tmp/prefix.city.data.ts
```

| file | what it shows |
|---|---|
| `iter4-detect/audit-before.txt` / `audit-after.txt` | The whole audit on the shipped bake, with the sixteen old signatures and then the eighteen. 55 -> 56: the sixteen old findings are byte-identical, `country-outside-blocks` adds one and `carve-is-a-ruler` adds none. Retake: `node server/dist/tools/mapAudit.js --all`. |
| `iter4-detect/audit-prefix-asset.txt` | The same audit against the asset before iteration 3. **61, against the shipped 56** — the sixteen old signatures still say 55 either side, which is the blindness this round closes, and the two new ones say 6 there against 1 here. Retake: `node server/dist/tools/mapAudit.js --data=$OLD_CITY_DATA --all`. |
| `iter4-detect/selftest.txt` | Eighteen planted controls, eighteen FIRED. The two new ones plant "a wooded rural block beside country outside the blocks that is stripped bare" (1 -> 2) and "a one-tile slot cut dead straight down a standing wood" (0 -> 1). Retake: `node server/dist/tools/mapAudit.js --selftest`. |
| `iter4-detect/selftest-prefix-asset.txt` | The same eighteen controls run against the pre-fix asset, all eighteen FIRED. Worth having: the first draft of the `country-outside-blocks` plant only STRIPPED wood, which reads SILENT there — on that bake every orphan region with a comparator is already a finding, so deepening one cannot raise the count. The shipped plant manufactures the disagreement from both sides instead. Retake: `node server/dist/tools/mapAudit.js --data=$OLD_CITY_DATA --selftest`. |
| `iter4-detect/citybake-check.txt` | The same six known-broken crossings as iteration 3, and no seventh. Retake: `node server/dist/tools/citybake.js --check`. |
| `iter4-detect/crop-gannet-ride-prefix.txt` / `-shipped.txt` | `carve-is-a-ruler`'s known positive as the detector reads it: a perfect one-tile column of meadow at x=111 running 46 tiles down the canopy, and the same crop on the shipped bake with the canopy closed. `bare-corridor` sees neither — it wants a span two tiles wide and tolerates the flanks wandering two tiles a line, which is exactly the tolerance that stops it being a test of straightness. Retake: `node server/dist/tools/mapAudit.js --data=$OLD_CITY_DATA --dump=100,600,26`. |
| `iter4-detect/crop-gannet-north-prefix.txt` / `-shipped.txt` | `country-outside-blocks`' known positive: Gannet Rock, whose district polygon begins at y=598 while the island runs to y=566. Before, the country outside the blocks is 17.3% wood against 49.4% in the rural blocks beside it; after, 35.0% against 52.2%. Retake: `node server/dist/tools/mapAudit.js --data=$OLD_CITY_DATA --dump=60,566,110`. |
| `iter4-detect/crop-marsh-islet-shipped.txt` | The signature's one remaining hit on the shipped bake, and a measured false positive: a 507-tile marsh islet, all meadow, next to a rural block that is 50.8% wood. The wildness field says meadow on **all 507 tiles** (`measure-wildness-field.mjs`), so the fill declined on purpose and there is nothing to fix. |
| `iter4-detect/crop-headland-shipped.txt` | `lanes-serving-nothing`'s big region, as tiles: six street mouths along y=311 running twenty to forty tiles north into unbroken meadow, and the Kelvin Bridge approach cutting across them. Retake: `node server/dist/tools/mapAudit.js --dump=430,300,110`. |
| `iter4-detect/part2-lanes-serving-nothing.md` | The investigation, with both options measured. Removing the headland's 956 lattice tiles costs nothing in travel distance; removing its 241-tile bridge approach with them costs 7.1%. Building it out costs ~13 buildings rural or ~120 buildings and 2,169 tiles of pavement urban. The second region is 52.5% arterial — a half false positive, not a false positive. |
| `iter4-detect/test-baseline-unchanged-tree.txt` / `test-this-tree-full-run.txt` / `test-session-isolated.txt` | `pnpm test` on the tree with `mapAudit.ts` reverted (**green: 92 files, 990 tests**), the same run with this round's change (**one failure**), and `server/test/session.test.ts` alone on this tree (**9/9**). The failure is `the crowd replenishes > tops pedestrians back up to target after a massacre`, which times out at 60s: it takes **55.0s inside the green baseline run** and **55.8s alone on this tree with nothing else on the box**. Four seconds of headroom on a twelve-minute suite, and this round's diff cannot reach it — `mapAudit.ts` has no importers anywhere in the repo. Filed here rather than fixed: it is a marginal timeout of its own, not this round's finding. |
| `iter4-detect/part2-measurements.txt` | Its raw output. Retake: `node evidence/iter4-detect/measure-lanes-reachability.mjs`, then `measure-lanes-costing.mjs`, then `measure-lanes-attribution.mjs`. |
| `iter4-detect/measure-wildness-field.mjs` | Asks `bake.ts`'s own `wildAt` whether the fill should have planted where the signature says it is bald — the check that separates a defect from the field's own answer. |
