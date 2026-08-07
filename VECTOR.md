# VECTOR — one map, not three

A plan for review, in the manner of `PLAN.md`. When a phase lands it writes its
own section into `WORLDGEN.md` and this file records what was decided and why.

**STATUS: approved, full integration.**

| phase | state |
|---|---|
| 0 — the instrument | **DONE** (WORLDGEN.md §24) |
| 1 — the coast as curves | **DONE** (§25) |
| 2 — courses authoritative | **PART** (§26): junctions from the curves. The rest is blocked on course coverage — see §26.1. |
| 3 — plots and buildings as OBBs | **NOT DONE** — see §8 Q5 |
| 4 — collision follows the geometry | **NOT DONE**, blocked on 3 |

---

## 1. The problem, stated once

The city exists in three representations and they disagree.

1. **The authored plan** — `shared/data/city-plan.json`. Islands as outlines,
   roads as polylines. Curves.
2. **The tile raster** — `city.data.ts`. What ships and what the sim reads.
3. **A recovered curve layer** — `courses`, `bevel`, `shores`, `bearing`,
   building `angle`. Curves reconstructed so the renderers have something
   smooth to draw.

Layer 3 exists because layer 2 destroyed layer 1. And the arrow of derivation
**points different ways per feature**:

| feature | today | consequence |
|---|---|---|
| roads | authored curve, *trimmed to* the raster | the raster judges the curve |
| coast | raster traced *back into* a curve | the curve can never beat the raster |
| bevels | raster traced back into edges | same |
| building facing | plan angle → per-tile `bearing` plane → back to an angle | a scalar field round-tripped through a grid |

That inconsistency is not academic. In one session I fixed the same class of
bug from **both ends**: for roads I clipped the drawing back to the tiles (385
tiles of tarmac painted on the sea); for coasts I changed the tiles to agree
with the drawing (1,025 one-tile holes in the quay). Same defect, opposite
patches, because the arrows point opposite ways.

### 1.1 Measured evidence

- **The coast cannot be smoothed.** `paintCoast` rasterises the authored
  outline, then domain-warps, morphologically opens and closes, despeckles and
  stamps islets **on the mask**. The outline is gone. `deriveShores` traces a
  curve back out and Chaikin-smooths it — but Chaikin only rounds corners it is
  given, so it straightens a 1:1 staircase and leaves a 2:1 one intact.
  Smoothed-to-raw length ratio **0.841** where a real smooth 45° coast gives
  **0.71**; **55% of the drawn waterline is within 7.5° of an axis**. The
  information is absent, not degraded.
- **Two marking systems on one road.** `paintLaneMarks` (per tile) says
  "junction ⇒ bare asphalt" at `tiles.ts:1591`; `paintCourses` (per ribbon)
  strokes the dash straight through. **5,780 of 15,260 junction tiles** carry a
  dash they were supposed not to.
- **Collision reads a different building than the renderer draws.** The
  footprint is an axis-aligned rect; the mass is rotated and scaled to fit
  inside it. Before this week that left corners **3.66 tiles** outside the
  drawn mass — invisible wall.
- **The review tool cannot see layer 3 at all.** `mapRender.ts` draws no
  courses, no markings, no kerbs, no rotated masses. That is the honest reason
  §16, §20 and §21 defects survived three waves of review.

### 1.2 The root cause under the facing saga, specifically

`BlockRect` is `{x, y, w, h}` — axis-aligned. In a 26° borough the **streets**
are carved in the borough's rotated frame (`toU`/`toV` in `layout.ts`), but the
**plots** are cut on the world axes. Every mechanism downstream — the bearing
plane, `angle`, `massFit`, `MIN_FACING_FIT`, `MASS_SLACK`, `facingAngle`, and
two shipped thresholds — is compensation for that one frame mismatch.

---

## 2. The rule

> **Vertices own boundaries. Grids own fields.**
>
> A *boundary* is where something ends — you can see it and you can hit it.
> A *field* is what is true at a point — you query it constantly and never
> collide with it.

Corollary, and the reason this is not a fudge: **quantise only what nobody can
see and nothing can hit.** Pavement becoming grass half a tile early is
texture, not silhouette, and is not collidable. A coastline half a tile off is
both.

Applied to `layout.ts`, this yields a second rule that keeps the refactor
bounded:

> **A raster pass may decide a field. It may not move a boundary.**

Passes that today move boundaries — the coast construction, despeckle on land,
the causeway revert, the quay/sand band, the plot cut — become geometry
operations. Passes that decide fields — which borough owns a tile, where a park
goes, where scenery stands — stay exactly as they are.

---

## 3. Target architecture

```
shared/data/city-plan.json                    authored, vector, unchanged format
        │
        ▼   buildGeometry(plan)               NEW  shared/src/world/geometry.ts
┌──────────────────────────────────────────────────────────┐
│ CityGeometry            THE MAP. The only authored truth. │
│   land      Polygon[]   outer ring + holes (lakes, bays)  │
│   roads     Course[]    centreline vertices + width + kind│
│   plots     Obb[]       cut in the borough's own frame    │
│   buildings Obb[]                                         │
│   regions   Region[]    borough / park / lot outlines     │
└──────────────────────────────────────────────────────────┘
        │
        ▼   rasterise(geometry)               NEW  shared/src/world/rasterise.ts
┌──────────────────────────────────────────────────────────┐
│ DerivedGrids            caches. Never authored, never     │
│   material  Uint8Array  edited. Tile resolution.          │
│   volume    VolumeGrid                                    │
└──────────────────────────────────────────────────────────┘
        │
        ▼   bakeCity(...)                     furniture: shops, landmarks, scenery
BakedCity = CityGeometry + DerivedGrids + furniture
```

### 3.1 Why this cannot become a fourth layer

Because **`rasterise` is the only writer.** Today `layout.ts` writes `tiles` in
dozens of passes; afterwards nothing outside `rasterise.ts` may write the
material plane, and the type system says so (`readonly Uint8Array` outside the
module). A cache with exactly one producer cannot hold a second opinion — the
guarantee is *structural*, not a test somebody has to remember to run.

That is the whole answer to "isn't this another layer on top?". A layer is
something with its own authority. This has none: it is a pure function of the
geometry, recomputed, never edited.

An equality assertion (`rasterise(geometry) === shipped grids`) is still
written, but only as a **migration crutch** — it exists during a phase to prove
the new producer reproduces the old one, and is deleted with the old producer
at the end of that phase. It is not part of the final design.

### 3.2 Smooth roads: flatten once

The painter today strokes `quadraticCurveTo` through segment midpoints — **a
spline, not the vertex list**. So the drawn road is already smoother than the
data. Naive "everything is vertices" would let the rasteriser fill the raw
polyline while the painter kept evaluating a spline, rebuilding the exact same
two-representations fight at half-tile scale where it is harder to see.

**Decision: flatten once, at bake time, to ¼ world pixel; ship those vertices;
nobody evaluates a spline at runtime.** At that tolerance a segment falls every
1.0–2.7 tiles depending on curvature, the chord is never more than a quarter
pixel off the true curve, and the polyline *is* the curve at any zoom the game
uses. Smoothness comes from density, not from re-deriving at draw time.

Sub-rule: a consumer that wants a coarser sampling (minimap, broadphase) takes
a **subset** of the shipped vertices. It never re-flattens. A subset is
provably inside the original; an independent flattening is a second opinion.

### 3.3 Size

| | today | after |
|---|---|---|
| coast | 15 loops, 2,985 pts, recovered at every client start | polygons, shipped |
| roads | 290 courses, 8,041 pts | same, authoritative |
| whole vector document @ ¼ px | — | **~21,000 pts ≈ 165 KB f32** |
| `city.data.ts` | **787 kB** | material + volume planes, RLE as now |

The vector document is roughly a fifth the size of the raster it stops
duplicating.

---

## 4. Phases

Each phase **inverts one derivation arrow and deletes the old direction in the
same commit.** No phase may end with both paths present. That is the discipline
that prevents the migration from being the confusing layer.

### Phase 0 — the instrument *(no behaviour change)* — **DONE**

Landed as `WORLDGEN.md` §24. `mapRender.ts` draws course ribbons in the
client's paint order, arc-length dashes, kerb casing and turned masses; `pnpm
mapgen --tiles` draws the raster alone, so **the difference between the two
pictures is the curve layer** and every later phase can be measured by how much
it shrinks that difference. Evidence: `evidence/vector-p0-{tiles,curves}.png`.

*Original scope, for the record:*

`server/src/tools/mapRender.ts` learns the curve layer: course ribbons, lane
markings, kerbs, rotated masses, the coast polyline.

- **Deletes:** nothing.
- **Adds:** ~250 lines to `mapRender.ts`.
- **Gate:** `pnpm mapgen --sheet` visibly reproduces a defect that exists only
  in the curve layer (the doubled centre lines are the obvious candidate).
- **Why first:** every later phase is judged by eye, and the tool is currently
  blind to everything those phases touch. This session shipped a bad threshold
  because it was chosen off a percentile table instead of a picture.
- **Size:** half a day.

### Phase 1 — the coast becomes polygons

Rewrite `paintCoast` to work on vertices: warp outline **vertices**, meander
rivers, boolean-union spits and islets, subtract bays and lagoons, simplify,
then rasterise once. The quay/sand band becomes an offset band on the polygon.

- **Deletes:** `shoreline.ts` (514 lines), `bevel.ts` (339 lines),
  `deriveShores`/`shoreChains`/`shoreHalf`/`deriveBevels` and their 26 call
  sites, both 4-vs-8-neighbour shore passes, `drownSandbars` (becomes "drop
  polygons with no interior"), the tile-by-tile causeway revert.
- **Structurally impossible afterwards:** a bridge that lands once (a bridge is
  a segment between two landfalls), a sandbar with no interior, a coastline
  that steps.
- **Gate:** smoothed-to-raw length ratio ≤ 0.75 (from 0.841); zero land
  polygons without interior; every bridge lands twice **by construction, not by
  a prune**.
- **Risk:** exact boolean polygon ops on integer coordinates are the one
  genuinely hard piece of new code in this plan. Budget for getting it wrong
  twice.
- **Size:** the big one. Several days.

### Phase 2 — courses become authoritative

Carve the raster **from** the course polyline; never trim the polyline to the
raster. Compute junctions in vector (courses know where they cross). Retire a
course that duplicates another at plan time — the §21.3 fix, finally
expressible.

- **Deletes:** `trimCourses`, `courseCover`, `paintLaneMarks` and the entire
  per-tile marking system (~200 lines in `tiles.ts`), the junction-tile
  heuristics, the ribbon clip I added this week.
- **Gate:** no tile carries two centre lines (from ~15,000); no dash inside a
  junction polygon (from 5,780); §21.1's over-wide-carriageway count falls.
- **Size:** two to three days.

### Phase 3 — plots and buildings become oriented rects — **NOT DONE**

Scoped honestly after phase 1: `buildings.ts` emits buildings at **seven
sites**, every one of them stamping world tiles through an axis-aligned
`{x, y, w, h}`, with no local-frame abstraction to rotate. Cutting plots in the
borough frame means rewriting all seven plus their tile stamping, and then
`Building` becoming an OBB reaches the volume grid, `collide3`, doorways,
amenity placement and three renderers. That is days, not hours, and a
half-done version is precisely the confusing layer this plan exists to avoid.

*Scope, unchanged:*

Cut blocks and plots in the borough's own frame. `Building` is an OBB natively;
the drawn mass **is** the plot, with no fit factor because none is needed.

- **Deletes:** the `bearing` plane, `massFit`, `MIN_FACING_FIT`, `MASS_SLACK`,
  `facingAngle`, the shrink inside `buildingMass`, and the `slack` parameter
  threaded through three renderers — 29 source references and 21 test
  references.
- **Gate:** drawn OBB equals plot OBB *exactly* (the fit factor does not exist
  to be measured); no OBB overlaps another; no OBB touches carriageway.
- **Note:** this is the phase that ends the facing problem rather than tuning a
  fourth threshold for it.
- **Size:** two days.

### Phase 4 — collision follows the geometry — **NOT DONE, blocked on 3**

Not merely unbuilt but currently *wrong to build*: without phase 3 a
building's drawn mass is a shrunken rotated rect while its tiles are the full
axis-aligned one, so pointing collision at the OBB would make it agree with
the drawing and disagree with the tiles — trading one representation conflict
for another. Phase 3 first, or not at all.

**Buildings only. The fine coast mask is cut — see Q1 RESOLVED.**

- buildings: OBB broadphase inside `collide3.ts`, so collision reads the box
  you can see. The invisible-wall class ends here rather than shrinking.
- water: nothing. It is a field query, not a boundary.

This is the only phase that changes *how the game plays* rather than what the
bake contains, and it is much smaller than first scoped.

---

## 5. The deletion ledger

| removed | lines / refs |
|---|---|
| `shoreline.ts` | 514 |
| `bevel.ts` | 339 |
| per-tile marking system in `tiles.ts` | ~200 |
| the facing apparatus (`massFit`, two constants, `facingAngle`, the shrink) | 29 src + 21 test refs |
| `bearing` plane | 5 refs + a `Uint8Array` per bake |
| `trimCourses`, `courseCover` | 7 refs |
| **added:** `geometry.ts` + `rasterise.ts` | ~700 |

**Concept count: −6.** Gone: `ShoreLoop`, the bevel plane, the bearing plane,
the mass fit factor, the course cover mask, the trimmed course, the per-tile
marking system. Added: `CityGeometry` — which is the single thing the other
seven were each approximating a piece of.

---

## 6. What does NOT change

Named explicitly, because a refactor that quietly moves everything is how a
plan like this goes wrong.

- **The sim's hot loop.** "What am I standing on" stays one indexed read into a
  tile-resolution `Uint8Array`. `roadgrid.ts`, `peds.ts`, `vehicle.ts` are
  untouched.
- **The volume grid.** Still per-tile columns of `[bottom, top)` spans; the
  city averages 1.00 spans per tile and needs no refinement. Refining *it*
  would cost 274 MB at 4× and 4.4 GB at pixel resolution — the trap this plan
  avoids by refining a 1-bit mask instead, if at all.
- **Determinism.** No floating-point polygon tests in the hot loop. Polygon
  rasterisation uses integer edge functions on coordinates already quantised to
  1/100 tile, which is *more* deterministic than what runs today.
- **The ship model.** One city, baked offline, committed, looked at and
  accepted. `pnpm citybake` still produces `city.data.ts`.
- **The plan file format.** `city-plan.json` is already vector; it gains
  nothing and loses nothing.
- **`hostParity.mjs`.** It compares Node against the browser on the *same
  build*, so it is self-relative — there is no stored hash to re-baseline. Nor
  is there a committed replay corpus. Changing the bake is therefore much
  cheaper than it first appears: the cost is `checkCity`'s invariants and play
  feel, not a baseline rebuild.

---

## 7. Documentation standard for each phase

The repo's convention is that the design record is the doc, and it is written
in the same commit as the code. Each phase lands with:

1. a `WORLDGEN.md` section: the review, the design, DELIVERED with measured
   before/after numbers, and an explicit **NOT DELIVERED** list;
2. an `evidence/` PNG with the exact command to retake it, added to
   `evidence/README.md` — this session found six committed PNGs with no README
   entry, which is how evidence goes stale;
3. the deletions from §5 actually performed, in that commit, not deferred;
4. tests that state the *new* invariant, not the old one weakened. Phase 3's
   test is "drawn equals plot", which cannot be satisfied by a shrinking mass —
   the failure mode of the test I wrote this week.

---

## 8. Open questions for review

- **Q1 — Is Phase 4 wanted? RESOLVED — yes, but buildings only; the fine coast
  mask is cut.** The deciding fact is a gameplay one: **the player will be able
  to swim.** Water that you enter rather than bounce off is not a boundary at
  all — "am I in water" becomes a state change, and a state that begins half a
  tile early is imperceptible. That is a *field* question, and §2's rule sends
  it to the grid at tile resolution.

  So the 1-bit wet mask is not deferred, it is unnecessary: **4.7–18.9 MB
  removed from the plan**, along with the whole question of rasterising the
  coast at sub-tile resolution. Phase 4 keeps only the building OBBs, where the
  boundary genuinely is one you hit.

  Note for whoever builds swimming (a separate feature, not this plan): the
  thing that *does* stay a boundary at the waterline is the vertical one — a
  quay is a wall you cannot climb out onto and a beach is a ramp you can. That
  is the volume grid's business, per tile, and needs nothing from here.
- **Q2 — Cliff outlines in Phase 1 or later?** `sheerLand` is a flood fill over
  the water mask, so cliff edges are raster today for the same reason coasts
  were. Doing them with the coast is cheaper than doing them twice; doing them
  later keeps Phase 1 smaller.
- **Q3 — Does `plangen` follow immediately?** The generator emits a plan, so it
  benefits for free — but it also exercises the boolean ops on 44 unseen seeds,
  which is either excellent test coverage or a source of Phase 1 rework,
  depending on when it is turned on.
- **Q5 — Phase 3's cost is now known.** Seven emission sites in an 870-line
  file, all world-axis, plus the volume grid, `collide3`, doorways and three
  renderers once `Building` becomes an OBB. Worth doing — it deletes the whole
  facing apparatus and ends a problem that has now had three thresholds thrown
  at it — but it wants its own run at it, not a tail-end of this one.
- **Q4 — Ship the vector document, or rebuild it at load? RESOLVED — shipped.**
  The coast rings are in `city.data.ts` (782 → 840 kB) and `generateCity` no
  longer rebuilds them. ~165 KB shipped
  versus a rasterise pass at every client start. Shipping is the obvious
  answer; noted only because `deriveShores` currently rebuilds at load and
  nobody decided that on purpose.

---

## 9. What could go wrong

- **Exact boolean polygon ops are the whole risk.** Union, difference and
  offset on integer coordinates, robust to coincident edges and touching
  vertices. This is a known-hard piece of computational geometry and everything
  else here is bookkeeping by comparison. Mitigation: build it first, in
  isolation, with property tests (area conservation, no self-intersection, idempotent
  union) before any city depends on it.
- **Phase 1 is big enough to stall.** Mitigation: the equality crutch from §3.1
  lets the new coast be proven against the old one before the old one is
  deleted, so the phase can land in reviewable pieces without ever shipping
  both paths.
- **"While we're here" scope creep.** The audit's remaining findings — the
  green void past the world edge, duplicate lighthouses, trees on a lattice,
  zebra carpets — are *not* representation bugs and must not be folded in. They
  belong in `WORLDGEN.md` §23.3 until picked up separately.
