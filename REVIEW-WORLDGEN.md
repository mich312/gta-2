# REVIEW-WORLDGEN.md — the map generation, audited, and the city seen from straight above

A two-part review, in the house style of `REVIEW.md` and `REVIEW-3D.md`: first
the pipeline as code and architecture, then a top-down flyover of the 3D city
hunting visual bugs. Every claim cites the file it comes from; every
screenshot has a retake command. The flyover shots were taken at
`city3d.html?fly=1&at=<tx>,<ty>&h=300..360&pitch=8&night=0`, waiting for
`__ground.resident >= 40` before shooting — under a software renderer the
painted ground takes a minute per view to catch up, and shooting earlier
photographs the flat instanced slabs instead of the city (a mistake this
review made once and documents so the next one doesn't).

---

## Part one: the pipeline

### 1.1 What is good — and most of it is very good

- **The central decision is right.** One city, drawn in
  `shared/data/city-plan.json`, baked offline by `pnpm citybake`, shipped as
  bytes (`city.data.ts`), decoded identically everywhere
  (`generate.ts:30-55`). Ground cannot desync, and — the deeper point §12.1
  makes — the shipped map can actually be *reviewed*, which a generator's
  output never could.
- **The plan parser validates across subsystems.** `plan.ts` rejects a road
  wider than `MAX_CARRIAGEWAY` *because signals would read it as one
  junction* (`plan.ts:351`), a spine borough without its spine road
  (`plan.ts:408`), a landmark off the map. Authoring errors fail at authoring
  time with messages that name the fix.
- **The bake repairs what it can, refuses what it can't.** Driveways BFS-cut
  to the nearest street (`bake.ts:199`), stranded carriageway reverted to
  ground, cliffs re-sealed last as a stated invariant (`bake.ts:565`); a
  landmark over water or a road throws with the tile named (`bake.ts:279`).
  `citybake --fit` prints the paste-back edit for a misplaced landmark.
- **The vector work is a real correctness win, and it is measured.** The
  coast is a curve of which the tiles are the rasterisation; axial waterline
  fell 55.1% → 19.7% (§25), movers-resting-in-solid 0.24% → 0%
  (§43), and both are pinned by permanent tests
  (`coastCache.test.ts`, `shoreCut.test.ts`).
- **The tests test the artifact, not the algorithm.** One street network,
  every landmark reachable, bridges cross channels and nothing else, the
  air-only island stays air-only, the land-use ladder is never jumped
  (`shared/test/city.test.ts`). This is the right altitude for worldgen
  tests, and `courses.test.ts:22` ("a straight street records as a straight
  line, not jitter") tests a *visual* property numerically — rare and
  valuable.
- **The docs are the best in the repo.** §23's audit records what was found
  and NOT fixed, §41 records seven failed attempts at a change with
  measurements. That honesty is worth more than any single fix.

### 1.2 What is bad, ranked

1. **`citybake` writes a failing city to disk.** In `citybake.ts`, the
   default path runs `encodeBakedCity` + `writeFileSync` *before* the
   `errors > 0` exit-code test; only `--check` returns early. A plan that
   fails the checker still overwrites `city.data.ts`, which contradicts the
   file's own header ("a city that fails them does not get committed"). The
   fix is one move of the write below the error test.
2. **The exhaustive checker never runs against the shipped city.** `checkCity`
   guards `citybake` and `plangen` — but no test parses
   `city-plan.json`, decodes `CITY_DATA` and asserts zero errors. Combined
   with (1), a regression can bake, commit and ship unseen. (Run today it
   passes: one warning, 8 road tiles into water.) And no CI workflow runs
   `pnpm test` at all — deploy.yml only deploys.
3. **The freshness gate has ~360 tiles of unexplained slack.**
   `city.test.ts:88` tolerates `tiles.length / 1000` (589) differing tiles to
   absorb session-carved ramps; measured ramp count is ~230. Excluding
   `T_RAMP` tiles and asserting zero would make plan/asset drift impossible
   instead of merely unlikely.
4. **`buildLayout` is a ~2,060-line function** (`layout.ts:538-2597`) whose
   correctness is pass *ordering*, documented in prose comments rather than
   expressed in anything testable. `bakeCity` (~455 lines) and
   `amenities.ts` (1,328 lines) have the same shape. The docs already name
   the generalisation (§26.1: passes that edit the course and the carve
   together "want doing once, deliberately").
5. **The district enum is duplicated positionally.** `bake.ts:338` and
   `bake.ts:598` both hardcode `['downtown','residential','industrial',
   'commercial','park']`, shadowing `DISTRICT_TYPES` (`types.ts:71`).
   Reorder the source of truth and every building silently mislabels — no
   type error, no test failure.
6. **`decodeBakedCity` trusts a ~1 MB generated asset with blind casts**
   (`bake.ts:962-987`) while the hand-edited plan gets exhaustive
   validation. The asymmetry is backwards: the decoded file is the one that
   becomes the game world. Its three "pre-X bake" fallback branches are dead
   — one producer, one consumer, both in-repo.
7. **The old generator's skeleton is still load-bearing scaffolding.**
   `fields.ts` and `params.ts` open by explaining their reason to exist is
   gone; `BAKE_SEED`/`WILD_SEED` (`bake.ts:45`) exist to keep noise callable
   over a city with no seed; the session seed reaches ground only through
   `placeRamps`. `plangen.ts` (1,596 lines) is a second, parallel worldgen
   kept as the checker's honest test — a real but undecided maintenance
   liability, and it sits in the client's module graph via the barrel.
8. **Session dressing costs 1.3–2.1 s per `generateCity` call** — full-map
   scans in the amenity passes plus bevels, shore cut, junction labelling,
   road net and lanes (`generate.ts:103-154`), and the module-scope decode
   (`generate.ts:57`) adds ~210 ms to every importer including every test
   file. The architecture's selling point is that the expensive half is
   offline; the "cheap" half deserves a budget.
9. **Known-open geometry debts, all documented, none closed:** lattice
   merging that suppression cannot finish (§28.3 — and 34.3% of dry land is
   road, against 13.6% building, per `citybake --check`), 68 course
   junctions under 30°, courses covering only 76% of carriageway (§26),
   110 ring-crossed blocks with no buildings (`BUGS.md` §7.6) — that last
   one blocked by two police tests staged on incidental bake geometry, which
   is its own finding about how tests should stage.

---

## Part two: the city from straight above

Twelve holds across the map at pitch 8°. What renders *well* from overhead:
the vector coastline (the lagoon spit is a genuinely smooth curve with no
staircase — `evidence/topdown-ring-path.png`'s sibling shots), the stroked
road ribbons with their kerb casing and seniority-ranked centre dashes, the
frontage-filled street walls, and the painted ground's parity with the 2D
renderer (they are the same painter, which is the point). The bugs below are
what a player circling the city actually sees.

### 2.1 The runway is a dash carpet, not a centreline — new, with the cause

`evidence/topdown-runway-grid.png` (Gannet Rock strip),
`evidence/topdown-airfield.png` (Marsh End).

Both airstrips are covered edge to edge in a *grid* of dashes — five parallel
dashed rows on a seven-tile strip. The comment in both painters says
"centreline"; the predicate says otherwise: a tile qualifies when the tiles
north AND south of it are also runway (`tiles.ts:2119-2126`,
`cityGeometry.ts:542-543`) — true of **every interior row**, not the middle
one. The two renderers agree because they share the rule, which is how it
passed `cityTerrain.test.ts:180` (that test only pins
`isCarriageway(T_RUNWAY) === false`). The fix is to mark the row equidistant
from the strip's edges; the test to add is "one marked row per column".
Also visible at Marsh End: the airfield hut stands ON the runway slab, and
streets cross the strip mid-length — worth a look in the plan.

### 2.2 Course ribbons paint markings on ground that is not road — new

`evidence/topdown-lot-dashes.png` (Kessler Power).

Dashed centre lines march in columns across the industrial *lot*, with faint
carriageway banding under them — no road exists on those tiles. The course
clip (`tiles.ts:474-485`) excludes only `T_WATER` and `T_BUILDING`, so
wherever a course survives but its carriageway went back to being ground
(the bake's stranded-carriageway repair, the quay pass), the full ribbon —
casing, fill, edge lines, dash — goes down on lot, sand or grass. The same
root cause puts the stray white edge-line fragments on the beach at the
strait bridgeheads (`evidence/topdown-bridge-wedges.png`, top). The honest
fix is upstream — trim the course when its carve is reverted (§26's known
76% coverage gap, seen from the other side) — with the clip as a stopgap.

### 2.3 Bridge parapet steps hold grass over open water

`evidence/topdown-bridge-wedges.png`, `evidence/topdown-sound-bridge.png`.

The diagonal decks carry the §31 bevels, but several stair-step notches
along both strait bridges and the sound bridge render as **green grass
wedges sitting on the parapet line over open sea**, and between the smooth
ribbon edge and the stepped deck there are triangular slivers where water
shows through the carriageway line. A zebra fragment also floats on the
east strait bridge's approach where no street crosses. The wedge texture is
land ground on a bridge tile's bevel — the §15.4 cliff-pair failure mode
("no green skirt at the cliff foot") reappearing on decks.

### 2.4 Landmarks are slab roofs at any altitude

`evidence/topdown-stadium-slab.png` (Ironside Stadium + Kessler Power).

From above, the city's two biggest named buildings are featureless grey
slabs with hashed rooftop cubes — a stadium indistinguishable from a
warehouse. The Bowl reads better (its ring-of-building recipe shows), but
its infield is the polka-dot lot texture wall-to-wall. §3.6's "stamps with
interior structure" is the standing answer; from the flyover it is the
single highest-visual-return item open.

### 2.5 The countryside's paths and woods break the vector spell

`evidence/topdown-ring-path.png`.

The ring road sweeps through the countryside as a smooth stroked curve —
and directly beside it a footpath crosses the same grass as a raw
stair-stepped band of sidewalk tiles, three tiles wide, jagging at every
step. Paths have no courses, so they never got §16's treatment. In the same
frame, woodland renders as the documented flat dark plinth (`BUGS.md`
§2.x / §15.4's canopy-as-a-box): from above it reads as a stain on the
grass with scenery trees scattered around — not in — it.

### 2.6 Smaller top-down observations

- **Empty paved sliver blocks** along the avenues (Old Quarter,
  `evidence/topdown-oldquarter-tarmac.png`; Market Square) — the known 110
  buildingless blocks (`BUGS.md` §7.6), and from above they are conspicuous:
  kerb-ringed triangles of bare pavement in a district of packed frontage.
- **The Old Quarter's merged tarmac** (`topdown-oldquarter-tarmac.png`):
  where the 20° fabric meets the avenues, whole junction fields fuse into
  one asphalt lake with orphaned dash fragments floating in it — §28.3's
  measured ceiling, photographed.
- **Rotated buildings' forecourt quads** bleed past their block's kerb ring
  with soft anti-aliased edges (`topdown-oldquarter-tarmac.png`, both tower
  pairs) — the one soft-edged thing in a crisp-edged city.
- **Sand/quay/cliff material boundaries are hard tile edges** (§38's open
  note), visible wherever beach meets masonry.
- **Faint chunk-seam banding** in grass and asphalt: 128-px column/row
  tones, subtle at pitch 8 but there.
- Retakes: `WAIT_GROUND=40 node ci/shot.mjs "http://localhost:5173/city3d.html?fly=1&at=90,644&h=360&pitch=8&night=0" evidence/topdown-runway-grid.png` — substitute `at=` per §2.x: airfield `512,602`, strait `272,345`, sound `182,227`, Kessler `133,358`, Old Quarter `560,180`, ring `330,630`, stadium `126,320`.

### 2.7 What was checked and found healthy

Shadows are consistent (the "opposite shadows" a first pass thought it saw
was perspective lean); the coastline shows no staircase at any hold; bridge
decks carry no phantom crossings (§7.1's fix holds); zebra crossings sit at
course crossings (§35 holds, the bridge-approach fragment in §2.3 aside);
the two-tone grass transitions read as intended texture; no doubled
lighthouses, no floating props, no mirrored ground, no black squares —
the fourth-pass bug families (`BUGS.md` §9) stayed fixed.
