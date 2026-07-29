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
| `city-3d-facades.png` | The original GTA camera: perspective, straight down, so buildings splay away from the screen centre and show the face turned toward it. Facades are shader-computed — window columns with mullions, a slab line between storeys, a shopfront on the ground floor — so one material covers every building height. |
| `city-3d-models.png` | Close up: a car with cabin, windscreen and tyres, a person with head and shoulders, and a facade's window grid at legible size. Each model is boxes merged into one geometry with per-vertex colours, so a six-coloured car is still one instanced draw. |
| `city-3d-live.png` | The game **playable** in 3D — cel-shaded with black outlines, per-district building colours, cast shadows, and the player (red), pedestrians (orange), police and cars all placed from the live sim. Bodies are boxes on purpose: they are the colliders the simulation already resolves against, so anything that looks wrong here is wrong in the sim too. `/city3d.html`. |
| `city-3d.png` | The generated city as actual geometry — 523 buildings at real heights, cast shadows, the river — built from the **volume grid** the 3D collision resolves against, not from the tile grid. A building's box is the span that stops you. Retake with `/city3d.html?seed=7&pitch=45`. |

The numbers on it are draw calls, not frame rate: **9 draws, 57,767 instances,
762k triangles** for the whole 240×240 city. This box has no GPU, so its frame
rate is SwiftShader's and says nothing about a real machine; draw count is a
property of how the scene is built and is the same everywhere. See 3D.md W3a.

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

## Retaking these

```bash
pnpm --filter client dev
node ci/shot.mjs http://localhost:5173/body-sheet.html evidence/bodies.png '#sheet'
node ci/shot.mjs http://localhost:5173/fall-sheet.html evidence/fall.png '#sheet'
```

Both contact sheets are pages rather than scripts, and both draw through the
real renderer rather than through a copy of it — the sprite generator's own
preview knows what it drew, and these know what the game asks for. The two
have disagreed.

The ladder sheet regenerates on demand — run the dev server and open
`/damage-sheet.html`. It is the quickest way to check the drawing after
touching any of the damage rendering, and it is why the sheet exists rather
than these files: the PNGs are a snapshot, the page is the tool.
