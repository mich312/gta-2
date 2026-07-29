# Evidence

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
