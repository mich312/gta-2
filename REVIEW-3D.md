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

## What the play-test could not cover

Five reviewers were saturating the machine while the sixth was driving. Two of
its browsers were killed by GPU process failures and the host stepped at about
1 tick/s. **A high-speed crash, a skid, and a kill were not exercised.** They
are not known-good; they are unknown. Anyone re-running this should give the
play-test the box to itself.
