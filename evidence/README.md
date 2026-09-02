# Evidence

## Gameplay

Captured by driving the real game in a browser against the offline host — one
process, fixed seed, ordinary keys and mouse. `node ci/playLocal.mjs` retakes
all three.

| file | what it shows |
|---|---|
| `play-dusk.png` | The lighting and the extrusion doing their jobs at once: a headlight cone thrown down the street, lamp pools on the pavement, a taxi crossing under signals that are red one way and green the other, and buildings leaning away from the camera. |
| `play-drift.png` | Cornering hard enough to lay rubber down — the skid marks behind the car are where the tyres actually slipped — with a `tyre gone` notice from the damage sim rather than a caption. |
| `play-foot.png` | On foot with the pistol every player spawns with, muzzle flash, street name, respect bar and export list. |

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
| `city-anywhere-street.png` | Ground level in the Old Quarter: a signalled crossing with the street wall shoulder to shoulder on both sides — the frontage fill, which replaced a kerb ring with sheds scattered inside it. `node ci/playLocal.mjs`. |
| `city-fabric-review.png` | The three findings of the street-fabric review (WORLDGEN.md §13.1), as crops of the mapgen render. A: both banks of the strait carrying the identical screen-aligned lattice — sixteen boroughs, one orientation. B: the Old Quarter, avenues slicing diagonally through the grid and leaving sliver blocks, with the dead `T_FIELD` fringe between the last street and the shore. C: the ring road curving through leftover field, the park as empty felt, the waterfront unmet. Retake with `pnpm mapgen --sheet` after each fabric wave and diff by eye. |
| `city-seam-review.png` | The same four §14.1 crops after the seams wave (§14.5): Ravenhill's weave and the Spine's columns now both T into a seam street with frontage facing it from both sides; the Spine meets the Old Quarter's 20° fabric AT an avenue instead of a torn band; Beachfront and New Suburbs share a street, not a painted line; and the suburb frays into Marsh End through hedgerowed lanes, orchard rows and smallholdings instead of stopping dead. Crossable share of each urban seam went from 5-24% to 71-100% (the permeability test in city.test.ts holds the floor). Retake with `pnpm mapgen --crop` at the §14.1 coordinates after each seam wave. |
| `city-shore-review.png` | The south-east beaches after the diagonal wave (WORLDGEN.md §15): the lagoon mouth and the outer sand spit, their waterlines breaking at 45° where the bevel pass cut the staircase corners — the water yielding a wedge at every inner step, the headlands chamfered from the land side. The quays and the wooded sheer coasts in the same crop stay deliberately square: masonry and rock are built edges, and squareness is what makes them read as built. Retake with `pnpm mapgen --crop=600,570,140` after any shoreline change. |
| `city-kerb-review.png` | The kerbs after §15.4 step 1: a rotated borough whose whole fabric runs diagonal, its sidewalk stair corners yielded to the carriageway so the kerb line follows the street instead of stepping across it. The gate is the painter's own pair of tests — the cardinal run first (an L of road mass at a square crossroads corner has a diagonal principal axis, so covariance alone lies exactly there), then `diagonalRoadDir` with the cut's hypotenuse required to run WITH the band. Every corner of every square-grid borough stays the square it was drawn as. Retake with `pnpm mapgen --crop=545,20,90`. |
| `city-cliff-review.png` | The wooded shore after §15.4 step 2: the forest island's cliff rim, its inner staircase corners yielded by the water to the canopy so a hull slides a 45° face instead of snagging square rock. Walkers never notice — trees and water are both walls on land, so every one of these bevels collapses to a full tile for them. The cliff's convex headlands stay square on purpose: cutting them would need the trees-side cut, which opens ground under a canopy that draws as a box. Retake with `pnpm mapgen --crop=55,555,120`. |
| `city-3d-shore.png` | The diagonal shoreline in the renderer players actually see: the outer sand spit from the city3d flyover, its waterline running in long 45° reaches where the bevel pass cut the staircase, the shore wedges giving the sand a real edge face into the water. What fine stepping remains is the cutout mask's eight-texels-a-tile resolution, two world px a step. Retake: `pnpm --filter client dev`, then `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=700,608&h=260&pitch=45&night=0" evidence/city-3d-shore.png`. |
| `city-3d-cliff.png` | The wooded shore (§15.4 step 2) in 3D: the forest island's rim, canopy-height wedges chamfering the cliff's staircase corners into the water — no green skirt at the cliff foot, no hole under the canopy, the two failure modes that deferred this pair. Retake as above with `at=148,586`. |
| `city-3d-kerb.png` | The diagonal kerbs (§15.4 step 1) in 3D, painted ground resident: a rotated borough's streets with the pavement corners yielded to the carriageway along the diagonals, and the lagoon beach behind them breaking at 45°. Retake as above with `at=590,38&h=240`. |
| `city-3d-ring.png` | The road drawn in one line (WORLDGEN.md §16): the ring road curving through open country as a stroked course — kerb casing, carriageway, edge lines and the centre dash all following the authored polyline instead of its rasterisation, the junction with the crossing avenue opened by paint order alone. The band's stair-stepped tiles are still there under the ribbon as shoulders, and still what collision and traffic drive. Retake: `pnpm --filter client dev`, then `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=330,630&h=300&pitch=45&night=0" evidence/city-3d-ring.png`. |
| `city-3d-contour.png` | The second courses wave (WORLDGEN.md §16): a shore borough whose long streets are traced iso-lines of the water's distance field, bending with their shore under one continuous centre dash. Retake with the §16 flyover command at `at=620,585`. |
| `city-roadnet.png` | The road network as a graph (WORLDGEN.md §40): every street between two junctions stroked in cyan along the tiles the flood ran through, every junction a yellow dot. 940 nodes and 1,764 streets stand in for the 102,987 drivable tiles routing used to search, and the picture is the coverage claim — there is no carriageway in the crop the graph does not run down. Since §41.3 each street is coloured by what it is made of — bright for an avenue or the ring, dim for an ordinary street, grey where no centreline covers it (12% of them). Retake: `pnpm mapgen --net --crop=300,180,120 --out=evidence/city-roadnet.png`. |
| `city-3d-crescent.png` | A crescent borough after the same wave: the collector sweeping its whole sine as one stroke, the crescents wandering with unbroken dashes — each a recorded analytic centreline, trimmed to the stretches the drop hash actually carved. Retake at `at=520,520`. |
| `city-3d-night.png` | Night. Windows light up across the facades — a per-window hash against the night amount, so a lit window stays lit rather than flickering as the camera moves. |
| `city-3d-facades.png` | The original GTA camera: perspective, straight down, so buildings splay away from the screen centre and show the face turned toward it. Facades are shader-computed — window columns with mullions, a slab line between storeys, a shopfront on the ground floor — so one material covers every building height. |
| `city-3d-models.png` | Close up. The car is not a model anybody built — it is the `car` entry in `shared/data/sprites.json`, extruded. Tapered body polygon, raised cabin, tinted glass, red tail lights, headlights, dark tyres: every one of those is a shape in the 2D sprite with a `z` on it, and the sprite generator was already relighting flat art from those same heights. Same file, not flattened. |
| `city-3d-live.png` | The game **playable** in 3D. Everything in it comes from data the 2D renderer already uses: the bodies are `sprites.json` entries extruded, the trees and bushes sit at the same `hash2` positions the tile layer plants them, the props are the sim's own and swap to their `_broken` art when destroyed, and the road markings run down the carriageway centres measured the same way. `/city3d.html`. |
| `city-3d.png` | The generated city as actual geometry — 523 buildings at real heights, cast shadows, the river — built from the **volume grid** the 3D collision resolves against, not from the tile grid. A building's box is the span that stops you. Retake with `/city3d.html?seed=7&pitch=45`. |

Quote draw calls from these, not frame rate: this box has no GPU, so its frame
rate is SwiftShader's and says nothing about a real machine, while draw count
is a property of how the scene is built and is the same everywhere. Bare
geometry is **9 draws / 762k triangles** for the whole 240×240 city; dressed —
facades, planting, props, markings, roof parapets and clutter, kerbs,
crossings and the live population — it is **179 draws / 3.2M triangles**.
See 3D.md W3a.

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
| `bodies.png` | Every state somebody can be found on the floor in, at seven angles, drawn through the real `drawBody`. Row 1 is a standing figure for scale — a head, two shoulders and the tops of two feet. The rest are drawings of their own rather than that one stretched: dead face-down (no face, the back of the head), dead on the back (face up), and — the one that earns its keep — **downed**, curled on one side with an arm across the chest, because a casualty on the bleed-out clock has an ambulance coming and a corpse does not. |

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

| `airstrip.png` | A generated city with two airstrips in the countryside to the north — the dark strips in open ground. They are placed on a lattice rather than rolled, because "there is an airfield, and it is over there" is a fact a player should be able to rely on. Retake with `pnpm mapgen --seed=1`. |
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
| `plangen-seed500.png` | A city nobody authored (§17): `generateCityPlan` rolls the land as polylines in an open sea, cuts boroughs out of a weighted Voronoi, routes the arterials with A* over an anisotropic cost, and hands the result to the same `bakeCity` and the same `checkCity` the drawn plan goes through. Retake: `pnpm plangen --seed 500 --png evidence/plangen-seed500.png`. |
| `plangen-shore.png` | The shore parishes (§17.4). The leeward coast is a park borough with no streets in it, which is what lets the shore pass lay sand instead of a quay — before it, a generated city had a wall of harbour wherever a street reached the water. Retake: `pnpm plangen --seed 3 --png evidence/plangen-shore.png --crop`. |
| `city-shore-curve.png` | The coastline as one line (§18): `deriveShores` traces the water boundary, smooths it and thins it to polylines, and all three painters cut against the same curve — the 2D tile art, the 3D cutout mask and the wedges that give the sand a real edge. Retake: `WAIT_GROUND=24 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=700,608&h=260&pitch=45&night=0" evidence/city-shore-curve.png`. |
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
| `vector-p1-coast.png` | The waterline after the coast became a curve upstream of the raster (§25). The field was always continuous; `Math.round` in its sampler and a threshold to a mask were what stepped it. Contoured by interpolation instead, the share of waterline running within 7.5° of an axis falls from 55.1% to 19.7%, and the same coastline moves 0.3% of the map. Retake: `node server/dist/tools/mapgen.js --crop=470,390,80 --out=evidence/vector-p1-coast.png`. |
| `vector-p2-junctions.png` | Centre dashes stopping at crossings (§26). The per-tile painter had left junctions bare since the beginning and the ribbon painter drew straight through them — 5,780 junction tiles of contradiction. Junctions are now computed from where the CURVES cross and punched out of the dash, in the game and in this tool, which is the only way the tool can check the game. Retake: `node server/dist/tools/mapgen.js --crop=596,76,70 --out=evidence/vector-p2-junctions.png`. |

| `bridge-bevel.png` | The SE causeway after §31 taught the bevel plane about `T_BRIDGE`. A 45° crossing was a flight of stairs because its deck is rasterised and nothing softened it — every other diagonal edge in the city had been bevelled since §15. The water yields to the deck, so the carriageway overhangs its own cut and never gains a hole. Retake: `node server/dist/tools/mapgen.js --crop=620,600,70 --out=evidence/bridge-bevel.png`. |

| `world-edge-ocean.png` | The east map border after §32. The sea used to stop dead on the straight line x = 768 with the scene background behind it; it now runs to the horizon over a backdrop plane, so the plan's margin of open sea reads as ocean rather than as the end of the world. The green wedge top right is Fort Gannet, a real island. Retake: `WAIT_GROUND=10 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=750,427&h=280&pitch=55&night=0" evidence/world-edge-ocean.png`. |

| `woodland-jitter.png` | Ravenhill Park after §34. Trees stood dead on the tile lattice at identical scale, so a wood was a square grid of clones — rotation varied them, but a trunk is round, so turning it changes nothing you can see. Jittered off the centre and scaled per tree, both off `hash2`, so it stays a pure function of the tile. Retake: `WAIT_GROUND=12 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=500,95&h=150&pitch=45&night=0" evidence/woodland-jitter.png`. |

| `zebra-gated.png` | The Beachfront after §35. Crossings used to stack four to seven deep in open tarmac with no kerb at either end, because `junctionAt` reads the tile plane and a merged sheet of carriageway is "junction" across its whole area. Gated on the course crossings §26 computes from the curves instead. Retake: `WAIT_GROUND=14 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=465,410&h=200&pitch=45&night=0" evidence/zebra-gated.png`. |

## No stubs, no gaps, no nubs (PROGRESS.md, the stub rebake)

Before-and-after pairs from `pnpm mapgen`, the review tool the flyover
used. Retake the `fixed-*` shots with the commands given; the `bug-*`
shots are the same crops from the bake before the wave.

| file | what it shows |
|---|---|
| `bug-seam-caps.png` / `fixed-seam-caps.png` | The Ravenhill–Spine seam at 12 px a tile. Before: every street that T'd into the seam street ended inside its tarmac with a kerb cap, because the seam street had no course of its own to paint over them — a row of nubs down the middle of the road. After: the seam carries its own ribbon, the stems meet it as junctions, and no kerb is ever drawn on carriageway. Retake: `node server/dist/tools/mapgen.js --crop=405,140,40 --scale=12 --out=evidence/fixed-seam-caps.png`. |
| `bug-band-gaps.png` / `fixed-band-gaps.png` | The Terraces against the Beachfront. Before: contour streets stopping a tile or two short of the streets they were about to cross, a sliver of pavement in the gap — the band probe mistaking the crossing road for a parallel one. After: they cross. Retake: `--crop=535,470,40 --scale=12`. |
| `bug-ring-fence.png` / `fixed-ring-fence.png` | The Old Quarter's east side, where the ring road's twin carriageways cut the 20° grid. Before: every street on both sides stops two tiles short of the ring at a strip of bare ground — the limited-access shave of §14.3 D6, honest to the traffic model and a lie to the player, who could drive across the verge. After: the ring's outer verges carry a tree screen, planted last so the few streets that can only reach the network across the ring keep their access; a cut street ends at an embankment, and the ring is joined at its junctions only. The decision NOT to raise the ring on a flyover is in PROGRESS.md. Retake: `--crop=628,205,70 --scale=8`. |
| `bug-shore-piers.png` / `fixed-shore-piers.png` | Ravenhill's south shore. Before: eight streets marching six tiles into an empty field and stopping short of the esplanade, because the fabric was framed by the drawn polygon's box and not by the land the borough owns. After: the fabric runs to the shore street, with blocks on it. Retake: `--crop=220,170,200`. |

## §42–43 — lanes on the graph, and collision on the coastline

| file | what it shows |
|---|---|
| `city-lanes.png` | The lane model (§42). Grey is each street's own LINE — the graph's tile-centre path pulled onto the course running down that street and smoothed; green and orange are the kerb lane a car keeps to going each way along it, placed as a fraction of the tarmac MEASURED either side of the line rather than of a nominal width, which is why they narrow with the street instead of running through the kerb. Every junction is a gap, on purpose: a junction has no sides to keep to and the junction machinery owns it. Retake: `node server/dist/tools/mapgen.js --lanes --crop=300,180,72 --out=evidence/city-lanes.png`. |
| `city-shore-collide.png` | What COLLISION thinks, stippled at eight samples a tile, over the fourteen tiles where the curve and the tile plane disagree most in the whole city — eleven tiles' worth of ground changes hands there (§43). The red is everywhere the movement solver calls solid, and it fills the drawn water exactly, because both now come off the same curve. Retake: `node server/dist/tools/mapgen.js --solid --crop=322,534,14 --scale=44 --out=evidence/city-shore-collide.png`. |
| `city-shore-collide-tiles.png` | The same fourteen tiles as the RASTER saw them — `--tiles` drops the curve from the drawing as well as from collision, so this is the whole pre-§25 world in one picture: staircase water, staircase wall. **The difference between the two pictures is a car's worth of sea.** The half of it that mattered is that the renderers took the curve in §25 and collision did not, so for four waves the waterline looked like the first picture and stopped a car like the second. Retake: add `--tiles`. |
