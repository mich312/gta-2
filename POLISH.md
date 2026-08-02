# POLISH — the lag, and the map that doesn't look clean

Two complaints from play: the game hitches, and the city looks smudged. An
audit of both renderers, the interpolation path and the snapshot pipeline
found that neither complaint is one bug. The lag is allocation pressure — the
frame path builds and abandons thousands of objects per second, and the
stutter is the collector taking them back. The smudge is three separate
resolution/filtering mistakes stacked on top of each other, plus roads that
genuinely are missing their paint.

This document is the repair plan. Findings first, then five phases in the
order they should land, each with its files, its acceptance test and its
risk. Nothing below is fixed yet.

---

## Part 1 — What was found

### The lag (in order of blame)

**L1 — Snapshot deltas clone the whole world, 30 times a second, on the
render thread.** `applyTable` (`shared/src/net/snapshot.ts:244`) copies
*every* entity into a fresh Map via `cloneOne`, patches the few the delta
actually names, then `[...byId.values()].sort()`s a set that was already
sorted. Seven tables per snapshot. Each vehicle or player clone is 3–5
nested allocations (`pos`, `vel`, `zones`, `weapons`, `respect`). And the
history keeps far more than anything reads: `KEEP_TICKS = 120`
(`shared/src/net/sync.ts:6`) against a server that only deltas within 90,
and `BUFFER_TICKS = TICK_RATE * 2` (`client/src/net/interpolation.ts:15`) —
a two-second buffer for a three-tick interpolation delay. Order 180 full
world copies stay resident, survive the young-generation scavenges, get
promoted, and become major-GC pauses on the thread that draws.

**L2 — `Interpolator.sample()` rebuilds five Maps and every visible entity
per call.** `client/src/net/interpolation.ts:148` — each
`new Map(arr.map(...))` allocates a tuple array per entity *and* the Map,
then one `{entity, x, y, heading}` record per entity, and the whole thing
runs ~90×/s: once per rendered frame (`main.ts:1006`), once per snapshot
(`main.ts:396`), once for the overlay (`main.ts:1161`).
`vehiclesAsDrawn()` (`interpolation.ts:137`) additionally spread-copies
every vehicle, `zones` array included.

**L3 — The `__debug` block runs in production, every frame.**
`client/src/main.ts:1183` computes `boardable()` — one record per vehicle
plus a full distance sort — **twice** for the same data, then four more
whole-table `.filter()` scans, a 600-particle count and two light-list
filters. Nothing gates it; the comment says it's for tests.

**L4 — Traffic scans everything against everything.**
`shared/src/sim/traffic.ts:352`: the vehicle loop has a horizon AABB
reject; the ped, player and cop loops do not, so every AI car runs the full
projection maths in `consider()` against all 200 peds, every tick.
`vehicleAt` (`:186`) is a second unindexed all-vehicles walk from lane
selection, and `:1014` is a literal peds × vehicles nest. Tens of
thousands of inner iterations per 33 ms tick; under `?local=1` they share
a machine with the renderer.

**L5 — The 3D post chain is paying for full-resolution bloom over 4× MSAA.**
`client/src/three/post.ts:110`: an `UnrealBloomPass` sized at full
resolution (a five-level mip chain of separable blurs — ~11 extra passes)
over a `HalfFloatType, samples: 4` target. GRAPHICS.md documents the 2D
path refusing exactly this cost.

**L6 — a family of smaller per-frame churn**, each real, none dominant:
460 decals drawn with `translate`/`rotate`/`setTransform` and no viewport
cull, removed by `splice` (`client/src/render/effects.ts:654`, `:286`);
the radar iterating all 4096 turf cells for a 74 px panel with the reject
*after* the arithmetic (`client/src/render/minimap.ts:207`); signal heads,
packages and landmark lists linear-walked per frame by three different
layers (`renderer.ts:893`, `:1099`; `three/worldObjects.ts:245`;
`three/lights3d.ts:284`); `setNight` allocating four `THREE.Color`s and
reassigning `scene.background` per frame (`three/cityView.ts:383`);
per-light array allocation in the shadow cutter
(`render/shadows.ts:182`); string keys built per body per frame
(`three/entities.ts:399`, `renderer.ts:585`); a fresh skid record per
vehicle per frame (`render/sceneEffects.ts:97`); light lists re-sorted per
frame with a comparator that recomputes `weight()` per comparison
(`lights3d.ts:475`); and the client re-hashing the full snapshot
synchronously every 15 ticks (`shared/src/net/sync.ts:52`) — a repeatable
2 Hz spike.

### The smudge (in order of loudness)

**M1 — The whole 3D world is rendered at half resolution and smoothly
stretched.** `main.ts:847` sizes the world canvas to
`viewport.deviceW/H` — half the CSS box in each axis (960×540 for a
1920×1080 window) — `cityView.ts:199` pins `setPixelRatio(1)`,
`devicePixelRatio` is consulted nowhere, and `#world` carries
`image-rendering: auto` (`client/index.html:23`) so the compositor
bilinearly doubles it (quadruples, on HiDPI). The pixel-perfect HUD sits
razor-sharp on top of the blur, which makes the contrast worse than either
alone.

**M2 — The painted ground is bilinear-filtered and mipmapped in 3D.**
`three/ground.ts:224`: the chunk canvas — pixel art with 1-px paving
joints and lane lines — goes into a `CanvasTexture` on default filtering,
while the surface mask two lines below correctly asks for
`NearestFilter`/no mipmaps. Three artifacts from the one line: lane lines
smeared across two pixels that crawl as the camera moves; a faint seam
grid at the 8-tile chunk pitch (each chunk clamps its own edge texels and
owns its own mip pyramid); and a dark fringe plus mip-dependent erosion at
every shoreline, because `alphaTest: 0.5` cuts a *filtered* alpha channel
whose transparent texels are black.

**M3 — The radar boils.** `render/minimap.ts:170`: 56.25 source texels
blitted into 74 HUD px — 2.63× nearest-neighbour — from a float source
origin that moves continuously, so which tiles get the extra pixel changes
every frame. Markers draw at fractional coordinates (`:196`); the turf
wash double-blends its antialiased cell edges into a faint grid (`:207`).

**M4 — Diagonal arterials have no road paint, and 3D disagrees with 2D
about where paint goes.** At ~45° neither axis run of a carved band
reaches `RUN_ROAD = 8`, so `paintLaneMarks` never fires
(`render/tiles.ts:890`): the ring road is a bare stair-stepped grey band
with jagged kerbs beside fully-marked grid streets. Meanwhile the 3D
shader path still carries the *pre-fix* centre rule
(`three/cityGeometry.ts:482`) that `laneCentreInTile` + `roadMarks.test.ts`
corrected in 2D — half a lane of disagreement on every 4-tile arterial,
with a different dash cadence (`facade.ts:325`) — and since painted chunks
replace the shader fallback a few frames after spawn
(`ground.ts BUILDS_PER_FRAME = 2`), you can watch the lines jump sideways.

**M5 — small paint bugs**: on even-width roads the centre dash lands 1
device px into the neighbouring tile and is painted over, so arterial
lines render half-thick (`tiles.ts:926`); runway speckle draws at
fractional coordinates — `(n * 9 % 9)` is a no-op on `n ∈ [0,1)` — so
every grain is an antialiased smear (`tiles.ts:1176`); the facade window
pattern is salted by `floor(vWorld.xy / 64)` rather than the instance, so
one wall changes its windows mid-face at every 64-px world line
(`facade.ts:190`); sun-shadow snapping rounds in world XY when the shadow
camera's texel grid is rotated ~34° and stretched 1.25× — edges still fizz
(`cityView.ts:429`); painted flat trees sit unrotated under their
randomly-yawed 3D twins (`scenery.ts:176` vs `tiles.ts:1144`).

### Checked and found healthy

So they don't get fixed twice: the `TileLayer` chunk cache and its build
budget, the 3D ground build budget, the particle pool, both catch-up
clamps (server loop and `MAX_CATCHUP_TICKS`), and the transferable
`postMessage` in the local-host path are all correctly done.

---

## Part 2 — The plan

Five phases, five pull requests, in this order. Each phase is
independently shippable and independently revertible. Phases 1 and 2 are
the complaint-killers; 3 is the design work; 4 is the long tail; 5 is the
proof.

### Phase 0 — a baseline to beat (half a day, part of PR 1)

Before touching anything, capture what "before" means:

- Frame-time percentiles from the existing stats probe
  (`client/src/debug/stats.ts`) over 60 s of continuous driving, 3D and
  2D, `?local=1&seed=7`.
- An allocation profile of the same run (DevTools sampling heap profiler)
  to confirm L1/L2 dominate and to have a number the fix must move.
- Evidence screenshots per repo convention (`evidence/`): an arterial with
  markings 2D vs 3D, the ring road, the shoreline, the radar while
  driving, a facade at night.

### Phase 1 — the afternoon of quick wins (PR 1)

Small, independent, high-return; every one verifiable by eye or by
existing test.

1. **Gate `__debug`** (`main.ts:1183`) behind the overlay being open (or a
   `?debug=1` param, so the screen-reading tests keep working), and
   compute `boardable` once, not twice. *(L3)*
2. **Ground texture filtering** (`ground.ts:224`): `magFilter = Nearest`,
   `generateMipmaps = false`, `minFilter = Linear`; paint water texels as
   opaque water colour with zero alpha (or pad chunks one texel) so the
   alpha cut stops fringing black. *(M2)*
3. **World-canvas resolution** (`main.ts:847`, `cityView.resize`): size the
   backing store to the CSS box × `devicePixelRatio`, capped at 2× the
   current figure; keep `?res=half` as an escape hatch for weak GPUs, and
   set `#world { image-rendering: pixelated }` as the fallback so even the
   half-res buffer upscales on whole pixels. Measure before/after —
   full-res quadruples fragment work, which is exactly what phase-1 item 6
   is buying back. *(M1)*
4. **Radar snapping** (`minimap.ts`): choose an integer texel-to-pixel
   ratio (`BAKE_SCALE = 2`, `SPAN = 592` keeps the same coverage feel),
   round the source origin to whole texels, round marker rects, and move
   the turf-cell bounds reject ahead of the arithmetic. *(M3, part of L6)*
5. **Paint bugs**: clamp the even-width centre dash inside its own tile
   (`tiles.ts:926`); floor the runway speckle coordinates
   (`tiles.ts:1176`). *(M5)*
6. **Bloom at half resolution, MSAA off under the composer**
   (`post.ts:110`). *(L5)*
7. **`setNight` scratch colours** and an early return when the hour hasn't
   changed (`cityView.ts:383`). *(part of L6)*

Acceptance: `pnpm test` green (776); new unit test for the dash clamp
beside `roadMarks.test.ts`; evidence re-shots showing crisp kerbs, a still
radar, an intact shoreline; frame-time percentiles no worse than baseline
with full-res on.

### Phase 2 — the garbage collector's holiday (PR 2)

The substantive lag fix. One PR, three commits, in this order so each is
bisectable:

1. **Copy-on-write `applyTable`** (`snapshot.ts:244`): clone only entities
   named in `updated`/`added`; carry unchanged entities by reference;
   merge in id order without the spread-and-sort. This makes snapshots
   *structurally shared*, which is only safe if nothing mutates entities
   it got from a snapshot — audit consumers first (predictor, renderers,
   bots harness), and add a dev-mode deep-`Object.freeze` behind a flag to
   catch violations in tests rather than in production.
2. **Right-size the buffers**: `KEEP_TICKS` 120 → 90 (the server's actual
   delta window), `BUFFER_TICKS` 60 → 8 (interp delay is 3 ticks; 8 leaves
   headroom for a late snapshot burst).
3. **A persistent interpolator** (`interpolation.ts`): id→entity Maps
   maintained incrementally on `push()`, `sample()` writing into pooled
   output arrays/records, `vehiclesAsDrawn` returning pooled objects
   (documented as valid-until-next-sample). While in there: stop
   re-hashing the full snapshot on the main thread (`sync.ts:52`) — hash
   in the host worker under `?local=1`, and on real connections verify
   only when the overlay is open.

Acceptance: `codec`, `prediction`, `lagcomp` suites green; a new test
asserting an entity untouched by a delta is reference-equal across
`applyDelta` (the structural-sharing contract); allocation profile shows
the snapshot/interpolation path off the top of the chart; p99 frame time
measurably down from baseline.

### Phase 3 — roads that agree with themselves (PR 3)

The design-heavy one. Goal: one source of truth for where road paint goes,
honoured by both renderers, including on diagonals.

1. **Unify the centre rule**: make `cityGeometry.ts` consume
   `laneCentreInTile` (export it from `tiles.ts` or lift both into
   `shared/`), pass the sub-tile offset into `facade.ts`'s road material
   as a uniform, and match the 2D dash cadence (2 dashes per 16-px tile).
   Kills the half-lane disagreement and the post-spawn sideways jump.
2. **Direction-aware markings for carved bands**: classify each road tile
   by a fitted principal direction (gradient/PCA over an N-tile road-mask
   neighbourhood at bake time, in `shared/` so both renderers and — later
   — the traffic lane model read the same answer), and stamp centre and
   edge lines along that direction instead of requiring an axis run ≥ 8.
   Junction suppression keeps its current rule where both axis runs
   qualify.
3. **Tests**: diagonal-band cases beside `roadMarks.test.ts` (a 45° band
   gets a centre line; the stair-step doesn't stagger it), and a 3D/2D
   agreement test that evaluates the shader rule and the painter rule on
   the same tiles.

This phase deliberately does *not* touch the cardinal traffic lane model
(BUGS.md §7.6) — but the direction field it bakes is exactly what
eight-direction `laneOptions` will want, so it's a down payment.

### Phase 4 — the long tail (PR 4)

Ordered by return; any prefix of this list is shippable.

1. **Traffic horizon + spatial reuse** (`traffic.ts`): the same AABB
   reject the vehicle loop has, applied to peds/players/cops, and
   `vehicleAt`/the `:1014` nest backed by a coarse grid. The reject must
   be semantically neutral — `consider()` already ignores far obstacles,
   so skipping them earlier cannot change a decision — and determinism is
   the thing to prove: same-seed replay before and after, plus the
   existing sim suites. *(L4)*
2. **Decal cull and swap-remove** (`effects.ts:654`, `:286`). *(L6)*
3. **Chunk-bucket the per-frame world lists** — signal heads, packages,
   landmarks, turf cells — once at `setMap`, iterated by camera overlap,
   shared by 2D, 3D and lights layers. *(L6)*
4. **Facade salt from the instance** (`facade.ts:190`): pass the footprint
   origin as an instanced attribute; windows stop changing mid-wall. *(M5)*
5. **Shadow snap in the light's texel basis** (`cityView.ts:429`). *(M5)*
6. **Churn scraps**: numeric composite sprite keys, pooled skid records
   and light lists, hoisted shadow-cutter arrays, precomputed sort
   weights. *(L6)*
7. **Rotate the painted tree to match its 3D twin** (`scenery.ts:176`,
   `tiles.ts:1144`). *(M5)*

### Phase 5 — proof (folds into each PR, plus a closing pass)

- Re-run the phase-0 measurements; the numbers go in this document the way
  GRAPHICS.md quotes its own.
- Before/after pairs into `evidence/` (`polish-*.png`), referenced here.
- A BUGS.md-style closing note per finding: FIXED, IMPROVED, or moved to
  the backlog with a reason.

---

## What this plan does not do

- **The cardinal traffic lane model** stays cardinal (BUGS.md §7.6); phase
  3 bakes the direction field it needs, nothing more.
- **`?extrude=1`'s baked-shadow mismatch** stays behind its flag (SHIP.md
  §U2a owns it).
- **The 3D light budget** (BUGS.md §6) still wants a decision made on a
  machine with a GPU; phase 1's bloom change is orthogonal to it.
- **No wire-format changes.** Everything in phase 2 is client-side
  representation; the codec and the replay format are untouched.

## Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Structural sharing breaks a consumer that mutates snapshot entities | 2 | audit first; dev-mode freeze; the reference-equality test makes the contract explicit |
| Full-resolution rendering is too slow on integrated GPUs | 1 | cap at 2×, keep `?res=half`, land bloom half-res in the same PR |
| Buffer shrink surfaces a hidden consumer of deep history | 2 | grep for `KEEP_TICKS`/`BUFFER_TICKS` readers first; lagcomp tests cover the rewind window |
| Direction field disagrees with `carveCourse` rasterisation in corner cases | 3 | test on seed 7's ring road specifically; fall back to bare asphalt (today's look) where confidence is low |
| Traffic reject changes sim outcomes | 4 | reject must mirror `consider()`'s own far-obstacle behaviour; same-seed replay diff proves it |
