# A graphics review of the 3D renderer, in six pairs of eyes

Six specialists went over the 3D path at `3375231` against the running game —
the real client with the offline host, the sibling viewer, the flyover, and the
contact sheets — each with one lens and no knowledge of what the others were
finding. Cel shading, geometry and topology, lighting and the day-night cycle,
frame budget, GPU resource lifetime, and a straight play-test.

They were briefed to try to *disprove* each finding before reporting it, and to
say plainly what they checked and found healthy. That second half turned out to
matter: it is why this document can say the per-frame path is sound rather than
merely not mentioning it.

All 776 tests passed when the review started. None of what follows was a
regression a test caught.

---

## What the reviews agreed on

Four findings were reached independently by two reviewers approaching from
different directions. Those four were the ones worth trusting most, and three
of them turned out to be the largest.

| Finding | Found by |
|---|---|
| City materials carry no gradient map, so nothing in the city is cel shaded | lighting, art direction |
| The outline hull uses per-face normals and comes apart | geometry, art direction |
| The hemisphere light's axis is screen-up in a Z-up world | lighting, art direction |
| Vehicle lights ignore the hour and burn at noon | lighting, play-test |

## The shape of the problem

The per-frame path is in good order and was confirmed so twice, independently.
Everything that churns — peds, cars, props, pickups, signals, projectiles,
particles, decals — is pooled rather than allocated per spawn. Every cache is
bounded. A five-minute run found no NaN in any instance matrix, bounding sphere
or world matrix. There is no z-fighting anywhere, because every marking is
computed in the fragment shader from world position and there are no coplanar
decals to fight. Winding survives the y-mirror correctly. Under a metre of
measurement, the JS cost of a frame is under 1 ms.

The faults are in two other places entirely:

**The rebuild path**, which had never been measured. It leaked GPU memory on
every rebase, recompiled shaders it was about to reuse, and blocked the main
thread for ~220 ms doing it.

**Art direction that was written down but never wired up.** `toon.ts` documents
the banding the whole look rests on, and the city's own materials never asked
for it. The comment above `roofColor` describes matching the 2D renderer, and
the code under it does something else.

And underneath both: **every instrument was broken simultaneously**, which is
how 5.8M triangles a frame survived a previous bug hunt. The fps readout
rounded 0.33 to `0`. `renderMs` timed command submission, not rendering.
`pnpm bench` compared 3D against 3D. The test covering rebuild disposal
asserted only the two things that already worked.

---

## Fixed

### Geometry

- **You could see through the world under every bridge.** `drawnSpans` returned
  a deck as a 6 px slab, stopping at −6, while the water beside it topped out
  at −8 and every other ground column ran to a −16 floor. The 2 px slot between
  them ran the length of every span. Proved by setting the scene background to
  magenta and watching the stripe change colour with it. The deck now runs to
  `EARTH` like any other ground column. `evidence/bug-bridge-hole.png`.
- **Everyone on a pavement was buried to the hips.** The function's own
  docstring says the surfaces the simulation walks on at zero are drawn at
  zero. The pavement is such a surface — `peds.ts` paths pedestrians along it,
  `isSolidTile` does not block it, bodies and props are placed at `z = 0` — and
  it was drawn at `KERB_Z`. Legs gone, and the outline hull of the sunk half
  haloed black across the slabs. `evidence/bug-pavement-kerb.png` →
  `evidence/fixed-pavement-kerb.png`.
- **Tile seams.** Boxes met exactly, the rasteriser broke the tie toward the
  darker side wall, and every roof, road and stretch of water was scored with
  dark lines on a 16 px grid.

Both terrain fixes have regression tests in `client/test/cityTerrain.test.ts`.

### The look

- **The cel shading was not switched on.** `facadeMaterial`, `roadMaterial` and
  `groundMaterial` each built a `MeshToonMaterial` with no `gradientMap`, so
  every building, road and ground tile fell back to three.js's single hard step
  between 0.7 and 1.0 — a surface facing directly away from a light keeping 70%
  of its irradiance — while props and vehicles went through `toonMaterial()`
  and got the real three-band ramp. The two halves of the world were quantised
  on different curves.
- **Fill outweighed key**, 3.02 against 2.18. The sun is the only banded term,
  so what banding survived measured as a 5% step across the terminator. Rig
  rebalanced to 2.95 / 1.18 / 0.62, keeping the lit level where it was
  calibrated.
- **The outline hull shattered.** `computeVertexNormals()` on a non-indexed
  merge gives per-face normals — right for the shading, wrong for a hull that
  displaces along them, which came apart at every edge and turned every tree
  into a fan of black spikes. Sprite meshes now carry a second, welded
  `outlineNormal` attribute used by the hull alone, so the shading keeps its
  hard faces.
- **Road markings were re-invented** brighter and wider than the palette — a
  2.4 px lane line where the 2D renderer paints 1 px, and a hardcoded near-white
  crossing. Both now read from `palette.json`.
- **The city was repainted by switching renderers.** `roofColor` claimed to use
  `hash2` inlined and used a GLSL-style `fract(sin(...))` instead, and keyed the
  district off the building record rather than the per-tile grid. 16.7% of
  building tiles agreed with the 2D view, against 20% for chance.

### Lighting

- **A headlight that missed a spot slot fell through** to the point-light path
  carrying the cone's intensity — becoming a sun-bright sphere on the car's
  bonnet, throwing light backwards down the street. And since headlights
  outrank lamps, those fakes evicted the street lighting. Now dropped instead.
- **Vehicle lights ignored the hour entirely** — `void lit;` — so every occupied
  car dragged a bright pool down the road at midday and the four spot slots
  were spent before dusk.
- **Lamps reached 2.6× their authored radius** and washed together into flat
  ambient instead of making pools.
- **Shadows had no bias**, giving dashed diagonal acne across roofs and walls at
  noon, over a frustum covering 11× the visible world, with the camera
  following unquantised float coordinates so the texel grid slid every frame.
  Bias added, extent cut to 460, target snapped to whole texels.
- **Particles and decals skipped tone mapping and the sRGB transform.** A
  `ShaderMaterial` gets the *pars* chunks injected and not the applications, so
  the linear colour was written straight into an sRGB buffer: `fireGlow`
  `#ff8a30` arriving on screen as a dark blood red, and the only thing in the
  frame not rolled off by ACES.
- **The hemisphere light pointed along scene +Y** in a Z-up world, so roofs and
  roads took the 50/50 sky/ground blend instead of the sky they face.

### Resources and robustness

- **Every world rebase orphaned ~3.9 MB.** An `InstancedMesh` owns its
  per-instance transform buffer — the geometry does not — and three.js frees it
  and the bound VAO only from `InstancedMesh.dispose()`, which was never
  called. Measured at ~5 rebases a minute while driving. The test covering this
  now fails without the fix.
- **A lost WebGL context was invisible.** three.js sets a flag and no-ops
  `render()` rather than throwing, so `main.ts`'s otherwise-good
  `try/catch → fallBackTo2d()` never fired: the game reported 60 fps over a
  blank white screen for as long as anyone cared to watch. Now handled, with a
  5 s watchdog to 2D.
- **`fallBackTo2d` abandoned the renderer without disposing it** — on precisely
  the machine that had just failed at 3D.
- **Rebase disposed before building**, dropping four shader programs to
  `usedTimes: 0` so they were deleted and recompiled immediately.
- **HiDPI reallocated the framebuffer every frame.** `setPixelRatio(2)` made
  `canvas.width` twice what the caller asked for, so the resize guard could
  never be satisfied.
- **Pool tails were zero-scaled rather than uncounted**, so a pool of 200
  holding 3 peds vertex-shaded and shadow-mapped 197 invisible ones, twice over
  because of the outline twin.
- **`copFacing` grew without bound**; the `WalkCycle` beside it had the sweep it
  needed.
- **The outline shader ran `normalize` on a zero vector** for every parked
  instance, writing NaN into `gl_Position`.

### The HUD, and the instruments

- **The kill feed was drawn underneath the radar.** Five rows at y 10–50, a
  radar panel covering y 4–78, drawn after. Right-aligned text loses its end
  first, so what survived was the opening of each sentence and never the point
  of it — every kill notice, gang warning and mission line arriving truncated.
  Visible in the repo's own shipped `evidence/play-dusk.png`, which reads
  "The Quay and Kessle" and "radi". Not a 3D bug: it predates the 3D work and
  affected both renderers.
- **Corpses stood up**, extruded at the same height multiplier as a body on its
  feet, coming out 77–85% of standing height.
- **Lamp posts were shorter than pedestrians**, and benches and fences you can
  walk straight through were drawn chest-high, so the player ended up standing
  inside them.
- The three broken instruments above.

### Culling

- **Frustum culling was defeated.** One `InstancedMesh` per material spanned
  the whole 240×240 map, so three.js tested a single bounding sphere covering
  the entire city, intersected every frustum there is, and submitted the map
  whole from every camera. Nothing that counts draw calls would show it.
  Instances are now bucketed by `(chunk, material)` at 32 tiles a side, the way
  `TileLayer` already chunks, with materials still shared across chunks so the
  program count and the batching are unchanged.

  At the game's own camera, measured in Node against the real frustum:
  **9.6% of instances submitted, against 74.5% unchunked** — 7.8× less
  geometry. The cost is more meshes to test: draw calls rise from 212 to ~320
  at the viewer's 42° pitch, which sees far more of the map than the game's
  own straight-down camera does. `client/test/cityCulling.test.ts` fails on
  both counts if the chunking is removed.

**Triangles per frame: 5,083k → 992k.** 779 tests pass.

---

## Not fixed, and why

These are real and evidenced; they are left because each is a larger change
than a review pass should make unannounced, or because the call is not the
renderer's to make.

- **A rebase is ~220 ms of synchronous main-thread work** — four full passes
  over a 57,600-tile grid with no budget. The 2D path solved exactly this with
  `CHUNK_BUILDS_PER_FRAME`.
- **The car you see is not the car the sim collides with.** Tile collision uses
  an axis-aligned square of `halfExtent` (9 for a car) while the drawn sprite's
  half-length is 12.5 — so a car nose-on to a wall has 3.5 px of bonnet inside
  it and side-on floats 2 px clear. This is a sim/renderer contract to choose,
  not a rendering tweak, and `models.ts` should stop claiming the two agree
  until it is chosen.
- **Facade patterns alias into noise on foreshortened walls** — wants a
  derivative-based fade.
- **Outline weight is not in a shared unit**: ~1 device px on a building and
  ~2.8 on a car, so buildings have no rim while cars are heavily drawn.
- **Stunt ramps are invisible in 3D** — the 2D painter gives them chevrons; 3D
  draws bare lot colour, so `frenzy.ts` launches a car off unmarked tarmac.
- **Night is a brightness ramp, not a colour grade.** 2D shifts blue/red by 48%
  across the day and adds a tint and a vignette; 3D shifts 11% and has neither.
- **`city3d.html` never constructs `Lights3dLayer`** — so
  `evidence/city-3d-night.png`, which `evidence/README.md` cites as the
  demonstration of 3D night lighting, is a picture of a page with no dynamic
  lights in it.
- **`?lights=cheap` saves no GPU work**: three counts every *visible* light
  regardless of intensity, so the shader still loops all 20.
- **`setShadowQuality` has no caller**, and there is no LOD or adaptive
  resolution of any kind.
- **The window hash has no per-building salt**, so lit windows are a global
  grid and every building has the same 55% lit fraction at midnight.
- **46 draw calls exist only to vary a colour** — one bucket plus
  `instanceColor` would collapse them, as `entities.ts` already does.

## What the play-test could not cover, and why

Two solo re-runs, with the machine to themselves, could still not stage a
high-speed crash or a skid mark in 3D. That turned out not to be a limitation
of the harness. It is what the game does on a machine without a GPU, and
chasing it found three real bugs.

**A kill and a body: now covered.** A pedestrian killed by an explosion lies
flat, lit and outlined, on the road surface rather than sunk into it — so the
`DEAD_Z` change is verified in play.

**A crash: still not covered, cause known.** Fixing the frame clamp restored
walking (16.5 → 172.7 px/s, against 2D's 161.8) but not driving, which peaks at
**20.1 px/s** where 2D reaches 255. Walking is a velocity *target*, so a missing
input costs nothing; a car integrates, so it loses everything. At ~1.4 fps the
client emits about 7 intents a second — `MAX_CATCHUP_TICKS` caps it at five per
frame — while the host consumes one per tick at a real-time 30 Hz and repeats
the last only while `heldTicks < MAX_HELD_TICKS` (6). So roughly ten ticks in
every twenty-one have no throttle and `driveVehicle` applies friction instead
of acceleration. The arithmetic predicts 155·11/30 − 110·10/30 = 20.1 px/s,
which is exactly what was measured.

**This is a live bug for low-end players, and it is left deliberately.** No
vehicle threshold — `WALL_HIT_MIN_SPEED` 54, `CAR_HIT_MIN_SPEED` 36,
`RUNOVER_MIN_SPEED` 24, `SKID_MIN_SPEED` 170 — is reachable on hardware that
slow, so such a player can never crash a car, skid, or run anyone over. The fix
is to scale `MAX_HELD_TICKS` from the observed gap between input batches, or to
emit one intent per *elapsed* tick rather than per simulated one. Both change
how a server treats a client that has gone quiet, which has fairness and
anti-cheat implications in multiplayer that a graphics review should not settle
on its own.

**A skid mark: the guard that blocked it is fixed**, so this should now be
stageable — but it has not been observed, because driving is still capped by
the above. Treat it as untested rather than working.

Also disproved: the "invisible obstruction" a previous run reported at
y ≈ 2455–2471 is a building. Driving due south from the seed-7 spawn leaves the
carriageway at a T-junction and runs into a block that is drawn, extruded and
plainly visible in both renderers. There is no phantom collider.

## Still open from the play-tests

- **Pickups occlude the body that dropped them.** In 3D a pickup floats above
  the ground plane and a corpse lies on it, so from directly overhead the drop
  hides almost all of the body it came from.
- **A wrecked car keeps its lit tail lamps and blue glazing.** The paint goes
  near-black through `wearShade` and reads as a wreck; the glass and lights do
  not get the message.
- **The EXPORT list is drawn over the damage panel's top-right corner**, in both
  renderers.
- **Night still has fewer pools than 2D** — about 40 there against the 16-light
  budget here. The pools that exist now reach the road; the budget is the
  remaining difference and is the architectural item listed above.

---

# Part two: the models

Four artists — vehicle, character, environment, and an art director adjudicating
— went over the models after the renderer work. The brief was a per-sprite height
table. What came back was mostly a reason not to want one.

## The disease

`z` in `sprites.json` is a **relighting hint for flat art**. The 2D sprite
generator reads it as a height field to compute shading normals, and that is all
it was ever for. So every sprite sits in roughly the same 0–16 range whatever it
depicts, and extruded under one global multiplier a bus came out exactly as tall
as the person waiting for it. The corpses-standing-upright and
lamps-shorter-than-people fixes earlier in this branch were both symptoms of this,
treated one at a time.

## What was fixed

Heights are now per sprite (`Z_BY_SPRITE` in `entities.ts`, `PROP_Z_BY_KIND` and
the split `TREE_ZSCALE`/`BUSH_ZSCALE` in `scenery.ts`). The pedestrian stays the
ruler at 9.75 px: the character artist measured it at 1.75 m against the car and
concluded the ped was right and the *car* was wrong, which is independently where
the vehicle artist arrived from the opposite direction.

The **lamp came down**, 30 px → 14. At 30 it was the tallest object in the game,
swept the same screen area as a pedestrian with more contrast, and read as a plank
lying in the road. `LAMP_Z` in `lights3d.ts` moved with it — the light height was
silently equal to the old mesh height and nothing said so.

`DEAD_Z` 0.3 → 0.45 (0.3 gave a corpse a 1.05 px torso, nearer a decal than a
body). Prop outlines 0.9 → 0.55, because the hull fattens in world units and was
swallowing 1.0 px fence rails into a dark lattice.

## The two limits that keep the table short

Both measured at the shipped camera, not argued:

- **Occlusion ceiling, 20 world px.** Straight down, an object of height `h`
  hides a strip of ground behind it `r·(h − h_t)/(H − h)` deep, pointing radially
  outward. Past 20 px that strip exceeds a pedestrian's width at the frame corner.
  Never-exceed is 24 (one storey).
- **Resolution floor, ~8 world px.** Two heights closer than that are the same
  height at this camera. Three bands — clutter, people and cars, big vehicles —
  is the entire usable palette.

## What heights cannot fix

**Every shape extrudes from the ground.** A shape that is both lower than another
and inside its footprint contributes nothing at all. Three artists, three separate
families, arrived here independently:

| family | what does not exist |
|---|---|
| vehicles | every tyre, inside every body shell — no wheels, ride height or arches |
| characters | trousers (measured 0.00 px of visible top area — **nobody has legs**), the cop's chest badge, the Fed's coat |
| planting | the tree's trunk — the canopy is a disc starting at ground |

This needs a per-shape floor (`zBase`) plus an authoring pass over 57 sprites, and
it is the single largest remaining improvement to the models. `z` itself must not
be touched: the 2D generator reads it, so changing it changes the 2D art.

## Still open

- **`zBase` and the authoring pass** — as above. Everything else here is cosmetic
  by comparison.
- **Aircraft are opaque drums.** `rotorBlur` carries `alpha` and `noOutline`;
  `spriteMesh` honours neither, so every helicopter renders as a cylinder that
  swallows its own fuselage. Their heights are deliberately left alone until this
  is read — raising them makes the drum worse.
- **`plane` has no fin** — its tail surfaces are authored below its wings.
- **`playerFist` / `playerPunch` are never placed in 3D.** The 2D path picks them
  at `renderer.ts:1414`; `entities.ts` always pools `'player'`, so an unarmed
  player still holds a pistol and a punch never animates.
- **SWAT is not bulkier than a Fed** in footprint or volume, so no multiplier can
  make the police tiers read by size. That needs art.
- **The walk cycle skates** — a 7:1 slide-to-swing ratio, nothing lifts, and armed
  bodies pump the gun barrel because it carries the arm's offsets.
- **Props are still passable.** The environment artist's recommendation is to make
  `fence` and `lamp` solid rather than to keep shrinking them: the lie is "this
  object does not exist", not "the rails are at chest height". `props.json`
  already carries a `radius` for every kind.
- **Buildings lean 5.3× more in 3D than 2D** — `PARALLAX_PX_PER_STOREY` 3.0
  against `Z_PER_STOREY` 24 at the frame edge. The largest 2D/3D divergence in the
  game, and a constants problem rather than an art one.

## The finding worth acting on before any of the above

At `pitch: 0` — what the shipped client uses — **height is very nearly
invisible**. It does not read at screen centre, where the player lives: the camera
lead is clamped to `LEAD_MAX = 54`, so the player's own model leans 1.2 world px,
under a sixth of a body width. It does not read at night at all, because cast
shadow is the only channel that works straight down and there is no sun at night.
At the frame edge it converts into outward smear, which is a liability for thin
objects and worth about +20% swept screen area for wide ones. The size hierarchy
the whole exercise was meant to deliver — a bus reading as bigger than a person —
is **already delivered 8:1 by plan footprint**, in art nobody needed to touch.

The same models at 42° are legible immediately and completely. `3D.md` says as
much in its own design rationale — *"a pitch angle gives height somewhere to go"* —
and the shipped client is hardcoded to 0.

**The highest-leverage change available to the look of this game is not any
artist's number. It is 8–15° of camera pitch.**

---

# Part three: working the open list

Everything below was on the "not fixed" lists above and now is, except where
noted.

## Models

- **A per-shape floor.** Shapes carry an optional `zBase`, so a vehicle's shell
  sits on its wheels instead of swallowing them. `z` is untouched — proved by
  `pnpm sprites` regenerating the sheet byte-identical.
- **Aircraft were opaque drums.** A shape authored with a low `alpha` — every
  `rotorBlur` — is now drawn as a thin plate at its own height rather than a
  solid cylinder, so the airframe is visible.
- **`playerFist` / `playerPunch`** are placed in 3D, via one `playerPose`
  function both renderers call.
- **Stunt ramps** get their chevrons.
- **Per-building window salt**, so blocks no longer share one lit-window grid.

## Look

- **Night is graded**, not dimmed: the sun cools toward moonlight and the
  hemisphere with it.
- **Facade aliasing** fades out as the pattern approaches a pixel.
- **Buildings have an outline** — 0.5 world px was about one device pixel
  against a car's 2.8.

## Cost

- **`?lights=cheap` now saves GPU work.** Unspent slots are hidden, not merely
  dimmed; three.js counts visible lights whatever their intensity.
- **`setFacadeNight`** no longer walks the scene graph every frame.

## Gameplay

- **The input hold adapts to the client.** A fixed six ticks was chosen for
  network jitter and is wrong for a slow machine, where the gap is the client's
  frame time: at 1.4 fps a client emits an intent every ~21 ticks, so ten ticks
  in twenty-one had no throttle and a car topped out at 20 px/s against 255 in
  2D. Every threshold in the game sits above that. The hold now tracks the
  client's own measured cadence, bounded at a second.
  `ci/hostParity.mjs` passes.
- **The camera tilts 10°**, which is what makes any of the height work visible.
  `?pitch=` overrides, so the old view is `?pitch=0`.

## Still open, and why

- **Pedestrians still have no legs.** The trousers sit inside the torso
  ellipse, and lifting the torso onto them leaves it floating — the leg rect is
  far smaller, so most of the torso has nothing beneath it, and it renders as
  disconnected slabs with the outline hull tracing each gap. I tried it, looked
  at it, and reverted it. Fixing this means re-authoring the leg *shape* so it
  supports the torso, which changes the 2D silhouette too.
- **`plane` has no fin.** Its tail surfaces are authored at z 6–7, below the z 9
  wings, so they are inside the fuselage's own column. `zBase` cannot lift a
  shape above its own top; the fix is a taller tail, which is a `z` change and
  therefore a 2D change.
- **Props are still passable.** Making `fence` and `lamp` solid is the
  environment artist's recommendation and `props.json` already carries a
  `radius` for each — but it changes which positions are legal in a
  deterministic sim shared by every client, and fences run along the pavements
  pedestrians path down. That is a design decision with a real chance of
  trapping peds, not a rendering fix.
- **The ~220 ms rebase hitch.** Still four full passes over a 57,600-tile grid
  with no budget. Chunking the *build* the way the draw is now chunked is the
  fix.
- **46 draw calls exist only to vary a colour** — one bucket plus
  `instanceColor` would collapse them.
- **SWAT is not bulkier than a Fed**, and the **walk cycle skates** at a 7:1
  slide-to-swing ratio. Both need art, not numbers.
- **Buildings lean 5.3× more in 3D than 2D** (`PARALLAX_PX_PER_STOREY` 3.0
  against `Z_PER_STOREY` 24). The largest remaining 2D/3D divergence, and a
  constants decision rather than a bug.
- **A wrecked car keeps lit tail lamps and blue glazing.** The paint darkens
  through a per-instance tint that multiplies every vertex colour equally, so
  there is no way to single out the lights without a wreck sprite.

# Part four: the lean, closed

The open list above carried this three times, each time filed as "a constants
decision rather than a bug":

> **Buildings lean 5.3× more in 3D than 2D** (`PARALLAX_PX_PER_STOREY` 3.0
> against `Z_PER_STOREY` 24). The largest remaining 2D/3D divergence.

Filed too gently. It is not only a lean, and it was reported from play as
"the map generation is completely broken — cars dive through houses, roads are
generated between houses."

## What it actually was

Worldgen was not involved. Measured on the shipped city: every `T_BUILDING`
tile is covered by exactly one `Building` record and no record touches a road
tile; all 1,208 vehicle spawns, 1,208 parking spots, 7,208 ped spawns and 1,600
props stand on legal ground; 2,000 ticks of `step()` with ambient traffic gave
6,714 vehicle samples and **zero** inside a solid tile. Road/pavement/building
shares of land are within 0.2% of the pre-drawn-city generator.

It was the drawing. A roof at height `h` is a plane `h` nearer the lens than
the ground it stands on, so it is **magnified by `H / (H − h)`** as well as
displaced by `h / (H − h)` of its distance from the screen centre. With the
camera at `viewHeight / 2 / tan(FOV_Y / 2)` = 589 world px and a 12-storey
block at `12 × Z_PER_STOREY` = 288 px, that is 1.96× and 0.96×.

Worked through for one real building — `{x: 473, y: 184, w: 6, h: 2}`,
downtown, 9 storeys, 216 px:

| | predicted | measured off the frame |
| --- | --- | --- |
| roof magnification | 1.58× → 6 tiles draws as 9.5 | 9.7 tiles |
| radial displacement | 0.58 × 120 px = 4.4 tiles | 4.4 tiles |

Its footprint is tiles 473–478. Its mass was drawn over 467.8–477.5 — across
the whole four-lane carriageway at 468–471 **and** the pavement at 472. The
street was not visible at all, and the cars driving down it were behind a
building. The near-black ground beside every block was the same number again:
216 px of building throws 180 px of shadow, eleven tiles of it.

## What changed

`Z_SCALE` moves from a `= 1` local in `cityGeometry.ts` to `render/config.ts`
at **0.25**, beside the `PARALLAX_PX_PER_STOREY` it is calibrated against, and
is applied to spans that rise above street level and to nothing below it — the
river bed, the earth slab and the ramp trench keep their depths. Two things
have to follow it or they detach: `facade.ts`'s `uStorey`, which spaces floor
slabs off world z, and `scenery.ts`'s tree base, which stands on the canopy
volume `cityGeometry` draws.

A 12-storey block now stands 72 px, magnifies 1.14×, overhangs its own kerb by
0.42 of a tile — inside the one-tile pavement — and leans up to ~50 px at the
frame corner against the 2D renderer's 36. Verified at pitch 0 with the world
tile grid overlaid: the 3D frame and the 2D frame put the same tiles in the
same places.

The collision numbers in `volume.ts` are untouched. They were never wrong;
they were never drawable.
