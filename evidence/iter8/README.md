# iteration 8 — the bridge deck gets the curve it was cut from

Iteration 7 escalated this rather than attempting it, and was right to: giving
the deck a curve outline in all three painters is architectural. This is that
change. It is a **renderer** change and a **detector-report** change; not one
byte of the baked map moves.

`pnpm build` first: every script here reads `shared/dist`, the same decoder
`mapaudit` uses.

---

## the finding, confirmed before anything was built on it

The brief handed me iteration 7's diagnosis. I re-derived it and then found
the part of it that turns a plausible fix into an exact one.

`deck-census-before.txt` reproduces iteration 7's population exactly —
**1564 deck tiles, 872 deck/water faces, 835 covered by neither chain, 872
rail boxes of which 418 stand at a step.**

`deck-curve-probe.mjs` -> `deck-curve-probe.txt` is the measurement iteration 7
did not take, and it is the one the fix rests on. `carveCourse` (layout.ts)
lays a carriageway as a **swept disc**: a tile is laid when
`segmentDistance(tx + 0.5, ty + 0.5, seg) <= width / 2`. The same polyline and
the same width are then recorded in the bake as a `StreetCourse`. So the deck's
true outline is not something a fix has to invent — it is the level set of the
deck's own course, and the tile mask is that curve point-sampled at tile
centres:

```
deck tiles                       1564
  covered by the swept disc      1564  (100.00%)
deck/water faces                 872
  water tile OUTSIDE the disc    869  (99.66%)

CONTROL open water away from any deck   4000 samples
  covered by the swept disc             0  (0.00%)
  -> the test discriminates: it says no to open water and yes to deck.
```

That is the same relationship the coast rings have to the water tiles (§25),
and it is why this fix is a *reading back* rather than a smoothing. The three
exceptions are water tiles the disc covers where `bridgeable` declined to lay a
deck — a span past `maxBridgeSpan`.

## what changed

`shared/src/world/deckCut.ts` (new) turns that level set into per-tile chains
in **`shoreChains`'s own format** — `Map<tile, Float32Array>`, tile-local,
water on the RIGHT of travel. That is deliberate: it is the one convention
`shoreHalf` and `chainSide` are written against, so no second polygon-splitting
path exists to disagree with the first. Restricted by `deckEdgeTiles` to the
two squares either side of a deck/water face and nowhere else; the level set
runs round every carriageway in the city and following it inland would redraw
every kerb on the map.

Then the three painters that refused a deck by name:

| painter | what it did | what it does |
| --- | --- | --- |
| `client/src/render/tiles.ts` (2D canvas, and the 3D city's painted ground) | `paintBridge` filled the square and railed its tile sides | `paintDeckTile` cuts on the chord, and the ground cutout follows it |
| `client/src/three/cityGeometry.ts` (3D) | a box per deck tile; `buildBridgeRails` one axis-aligned box per water-facing tile side | crossed tiles sink and come back as `buildDeckPrisms`; the parapet is one box per chord, turned to its bearing |
| `server/src/tools/mapRender.ts` (top-down) | the road ribbon was already smooth; the TILE fill stuck out past it in a sawtooth | the deck/water squares are decided per pixel by the same field |

`buildDeckPrisms` routes through **`roadMaterial`**, the same shader the box
used, so cutting a deck tile costs no asphalt grain and no lane marking. That
is not an assumption: `deck-cut-census.mjs` finds **0 of the 388 crossed deck
tiles carrying a marking**, because markings are on the centre lane and the
curve only reaches the outermost half tile.

### what the change ENABLED, and had to be stood down

§31 gave the deck/water pair a **one-directional 45-degree bevel**: the water
yields, so a water tile beside a deck carries a chamfer that reads as deck.
That was the best a half-tile chamfer could do before the deck had a curve of
its own. With one, a wedge left in place lays a triangle over a chord at a
different angle — which is precisely the sawtooth `buildBandPatches` records
learning not to draw over a curve it disagrees with.

`buildShoreWedges` (3D) and `paintBevel` (2D) now stand down on a tile the
deck chord owns, the same way both already stand down for the coast chord.
`bevel-overlap.mjs` -> `.txt` sizes it:

```
bevelled tiles on the map              1213
  of the deck/water pair (S31)         131
  water tiles that would have got BOTH 131
So the stand-down is load-bearing, not a precaution.
```

**All 131** deck-pair bevels sit on a tile that now carries a chord, so there
are no orphans on the other side either — no 45-degree chamfer left sticking
into the river past the true deck edge. This was found by reading the code
after the first `-AFTER` plate was already taken; that plate showed the
overlap as a slightly ragged fascia, and the current one does not.

(That probe's own first draft read `city.bevel` off the decoded bake, where
the field does not exist, and printed a clean **0** in every column. It has a
control now — the bevel count itself — which is the only reason it is not the
eighth blind instrument in this exercise.)

`server/src/tools/mapAudit.ts` asks the deck chain in `onCurve`. **`mag` and
the finding count are untouched** — `mag` is `span - count`, tiles of flat
tread, and the curve layer has never been gated into it. SCORE and TOTAL
therefore still mean what they meant in iterations 5, 6 and 7.

---

## the pictures

Retake, at the same cameras:

```bash
pnpm build
node server/dist/tools/mapgen.js --crop=146,446,64 --scale=16 --out=evidence/iter8/deck-178-478-topdown-AFTER.png
node server/dist/tools/mapgen.js --crop=241,328,65 --scale=16 --out=evidence/iter8/deck-274-361-topdown-AFTER.png
node server/dist/tools/mapgen.js --crop=167,194,65 --scale=16 --out=evidence/iter8/deck-200-226-topdown-AFTER.png
node server/dist/tools/mapgen.js --crop=253,284,42 --scale=16 --out=evidence/iter8/deck-274-305-topdown-AFTER.png
```

The `-BEFORE` plates beside them are the same four crops off the reverted
tree. Reverting was done by copying the changed files aside and
`git checkout --`ing them, never `git stash` — `refs/stash` is shared between
every worktree in this project and two fixers have already popped each other's
work off it.

Eye level, with the dev server up (`pnpm --filter client dev`) — and with
`ci/shot.mjs`, which this iteration repaired, rather than iteration 7's
private stand-in:

```bash
WAIT_GROUND=20 node ci/shot.mjs \
  "http://localhost:5173/city3d.html?fly=1&at=178,478&h=110&pitch=74&night=0" \
  evidence/iter8/A-bridge-178-478-eye-AFTER.png

WAIT_GROUND=14 node ci/shot.mjs \
  "http://localhost:5173/city3d.html?fly=1&at=178,478&h=55&pitch=82&night=0" \
  evidence/iter8/A-bridge-178-478-close-AFTER.png
```

| file | |
| --- | --- |
| `A-bridge-178-478-eye-BEFORE.png` | the pre-fix tree at that camera, retaken with the repaired tool so both sides come off one instrument. The same frame as `evidence/iter7/A-bridge-178-478-eye.png`. Parapet jogging a whole tile every few tiles, deck edge in hard right angles. |
| `A-bridge-178-478-eye-AFTER.png` | the same camera. The parapet runs straight and unbroken down both sides and the span reads as one ribbon. |
| `A-bridge-178-478-close-AFTER.png` | low and close, to check the fascia. The dark shapes on the water are the deck's own shadow, which used to fall on the deck's own box side — a consequence of the deck no longer being a solid tile-wide wall, not a hole. **Shot under target residency**, and the tool said so: a camera at h=55 sees fewer chunks than one at h=110 and never reaches 14. The frame is still evidence — the lane markings and building facades in it are painted ground, not the instanced fallback — but the plate to read for the 2D painter's own output is the `-eye-` one at `resident=20`. |
| `deck-178-478-topdown-BEFORE/AFTER.png` | the grey sawtooth either side of the ribbon, and then not. The road ribbon was ALREADY smooth in this painter — what was serrated is the tile fill sticking out past its casing, which is why the defect survived a tool that draws roads as curves. |
| `deck-274-361-topdown-BEFORE/AFTER.png` | The Ring's twin carriageways, and the reason this is a curve and not a straightening: the deck is genuinely curved there, and its edge now follows the curve rather than approximating it. |
| `deck-200-226-topdown-BEFORE/AFTER.png`, `deck-274-305-topdown-BEFORE/AFTER.png` | the other two flagged decks, same treatment. |

---

## the numbers, both sides

### the population — 872 faces, not the 4 findings

`deck-cut-census.mjs` -> `deck-cut-census-after.txt`, against
`deck-census-before.txt`:

| | before | after |
| --- | --- | --- |
| deck/water faces | 872 | 872 |
| covered by a curve | 37 (coast, incidental) | **872** |
| covered by NEITHER | **835** | **0** |

And the parapet, which is what the 418 counted. `parapet-census.mjs` ->
`parapet-census.txt`. The old metric — "a rail box at the end of a tread" —
is defined over axis-aligned per-face boxes and there are none left, so "0 of
872" would be quoting a metric with no subject. The quantity that replaces it
is the TURN at each joint, because a 90-degree turn IS the jog:

| | before | after |
| --- | --- | --- |
| parapet boxes | 872 axis-aligned tile sides | 874 chords, 763.2 tiles of parapet |
| joints turning 90 degrees | **418** | — |
| joints turning more than 30 degrees | **418** | **2** |
| joint turn, median / p90 | 0 or 90 | **0.00 deg / 0.14 deg** |

The two survivors are at 450,413 and 454,413 and they are **not** steps:
`dump-452-413.txt` shows a bridge landing where a north-south deck meets an
east-west one, with two width-4 avenue courses crossing at that point. A
parapet turning eighty degrees at the corner of two decks is a parapet doing
its job. Checked rather than assumed, because "two left over" is exactly the
shape of a residue somebody waves through.

293 of the 874 boxes do stand within 5 degrees of an axis — and should: two of
the four decks are The Ring's carriageways running very nearly north-south, so
their edges are genuinely axial there. Which is why the regression test asks
the question of the deck at 178,478, where the tiles themselves say the span
runs 15 degrees off, rather than asking it city-wide.

The census also checks two things the fix has to pass rather than claim:

* **continuity** — 1680 of 1754 chord endpoints on a tile border are the
  neighbour chord's endpoint too, and the worst mismatch where a neighbour
  exists is `0.00e+0` tiles. Bit-exact, because both tiles bisect the same
  field across the same border. The other 74 are the runs' own ends.
* **control** — `buildDeckCut` with no courses returns 0 chains, so "covered"
  is the curve and not the counting.

### `pnpm mapaudit`

Full output in `mapaudit-before.txt` / `mapaudit-after.txt`. The summary block
is **byte-identical**: `TOTAL 49`, `SCORE 2911.8`, every per-signature row the
same, `built-staircase 24 540 135.0`.

That is the intended result and not a null one. `built-staircase` measures the
TILE staircase, which a renderer cannot move, and reports separately on whether
it is DRAWN — which is what changed, on all four flagged decks:

| deck | before | after |
| --- | --- | --- |
| 274,361 m=37 | `42 of its 44 step faces ... have no coast curve over them and are drawn square` | `All 44 ... dissolved by a curve layer (coast, bank or deck), so NONE of this staircase is drawn` |
| 200,226 m=36 | `44 of its 45 ... drawn square` | `All 45 ... NONE of this staircase is drawn` |
| 178,478 m=32 | `43 of its 44 ... drawn square` | `All 44 ... NONE of this staircase is drawn` |
| 274,305 m=18 | `20 of its 22 ... drawn square` | `All 22 ... NONE of this staircase is drawn` |

Had `onCurve` been left alone, the detector would have gone on printing
"drawn square" of 872 faces that are now cut on a chord in all three painters.

### `citybake --check` and reachability

`citybake-check-before.txt` / `-after.txt`: **six warnings both sides** (The
Ring x2, Marsh Causeway, Coast Road x3), and **1184 blocks / 4005 buildings**
both sides.

**No bake churn at all.** `git diff --stat shared/src/world/city.data.ts` is
empty — this iteration changes no map bytes, so iteration 6's block-count wash
cannot happen here.

`reachability-before.txt` / `-after.txt`, the same
`evidence/iter5/measure-reachability.mjs` both sides:

```
carriageway 100833 tiles in 1 component(s): 100833
27 landmarks; mean landmark-to-landmark travel distance 491.6 over 702 ordered pairs, 0 unreachable
```

Identical, as it must be: no tile changed type.

---

## the regression test, and its three red states

`client/test/bridgeParapet.test.ts`. It is written against the **built city**
and imports nothing from the fix for its two defect assertions, so it runs on
the tree either side. A check that only compiles against the repair is not the
check that would have caught the defect.

`regression-test-BEFORE.txt` (pre-fix tree, `node ci/test.mjs client/test/bridgeParapet.test.ts`):

```
× is not the tile grid: a span that runs off the axis has a parapet that does too
  → expected 1 to be less than 0.1
× runs straight, rather than stepping half a tile every few tiles
  → expected 0.48789374369552074 to be less than 0.25
✓ still refuses an abutment, and still covers every deck/water face
Tests  2 failed | 1 passed (3)
```

**1.00** is every parapet box on the span standing along an axis, on a deck
that runs 15 degrees off one. **0.4879 tiles** is half a tile of staircase,
which is exactly the tread a half-tile bevel cannot reach and exactly what
`built-staircase` counts.

`regression-test-AFTER.txt`:

```
✓ is not the tile grid: a span that runs off the axis has a parapet that does too
✓ runs straight, rather than stepping half a tile every few tiles
✓ still refuses an abutment, and still covers every deck/water face
[ci/test] green: 1 files, 0 failures
```

The third assertion is the invariant guard, so it passes on both trees and
needs its own control. It has one: with the parapet's river probe left at the
old third of a tile — the gapped first draft of this fix, which
`rail-probe.mjs` attributes to 104 of 877 chords whose probe lands back on the
deck's own square — it reads

```
× still refuses an abutment, and still covers every deck/water face
  → expected 210 to be less than 60
```

210 loose parapet ends: 104 refused chords, two ends each, plus two. So all
three assertions have a demonstrated red state.

A fourth test covers **2D/3D parity**, below.

---

## 2D and 3D

The 3D city's ground surface **is** the 2D painter's canvas
(`TileLayer.paintGroundChunk` -> `paintGround` -> `paintDeckTile`), and the 2D
game view is the same `paintGround` on the same tile from one chain. So the
deck edge in both renderers is drawn by one function from one curve, and the
only place they can disagree is the SIDE — the 3D prism asks
`shoreHalf(seg, false)` for the deck half, while the ground cutout walks the
chain's runs and takes a cross-product sign per sub-texel. Two implementations
of "which side is the river"; a flip in either puts tarmac on the water in
exactly one renderer.

`2D and 3D agree about which side of the deck edge is river` runs both rules
over all 877 chains at the painter's own 8x8 sub-texel grid — the
cross-product rule **transcribed** from the painter rather than called, so it
fails if the painter's convention is changed out from under the chain:

```
✓ gives the same answer at every sub-texel of every cut tile
```

with staging assertions first — over 25,000 samples taken, and **both answers
really occur in them** (at least 5,000 wet and 5,000 dry). That second one is
the point: a rule that says DRY at every sample agrees perfectly with a rule
that says DRY at every sample, and four of the seven instruments this exercise
has caught lying were exactly that shape. (My own first draft of this staging
gate asked instead that 80% of chords cut their square in two; the real figure
is 75.5%, so the gate was a guess I would have had to move to make it pass —
which is how a threshold becomes decoration. Replaced with one that cannot be
tuned.)

Its own red state, since a parity check that cannot fail is not one: flipping
the transcribed cross-product sign gives

```
× gives the same answer at every sub-texel of every cut tile
  → expected 56128 to be +0
```

56,128 disagreements out of 56,128 samples.

The pictures back it from the other direction. `A-bridge-178-478-eye-AFTER.png`
was taken at `ground resident=20`, so the painted ground — the 2D painter's
own output — is the deck surface in that frame, and the 3D prism fascia and
parapet stand exactly along its edge. Disagreement would show as painted deck
hanging past the fascia, or fascia past the paint.

---

## `ci/shot.mjs`

It could not take a picture on this box. Two causes, both fixed:

* a hard-coded 2200x1000 viewport, whose frustum wants more painted ground
  than the 2-chunks-a-frame budget delivers on a software renderer;
* playwright's default 30-second `screenshot` timeout, which that frame misses
  — so the run ended having written no file and said nothing about it.

Now: `VIEW=<w>x<h>`, default 1400x700 (2200x1000 still available); a 120-second
screenshot timeout; residency polled from node rather than through an in-page
`waitForFunction` that is itself starved when a frame costs seconds; the
residency reached is **printed**; and a non-zero exit when no file appears,
because silently producing nothing is how a broken instrument survives.

The printed residency earned its place within the hour: the first
`...-eye-AFTER.png` came back at `ground resident=0` with a page error, from a
module the dev server had cached across the before/after swap. Without the
line it was a plausible-looking picture of nothing.

**The control.** `shot-BROKEN-control.mjs` is `git show HEAD:ci/shot.mjs` — the
tool exactly as it was — run at the same URL against the same dev server.
`shot-broken-control.txt`:

```
page.screenshot: Timeout 30000ms exceeded.
Call log:
  - taking page screenshot
  - waiting for fonts to load...
```

Exit 1, and no file at `evidence/iter8/oldshot-should-not-exist.png`, which is
why that path is empty in this directory. So the diagnosis inherited from
iteration 7 is confirmed on this box rather than taken on report, and the
repaired tool took every picture in this directory.

`.claude/review/LENS-B.md` is updated: the invocation is unchanged, the new
knob and the residency line are documented, and iteration 7's private stand-in
is retired.

---

## the files

| file | what it settles |
| --- | --- |
| `deck-curve-probe.mjs` -> `.txt` | the tile mask IS the swept disc's point sample, with a control that says no to open water |
| `deck-census-before.txt` | iteration 7's population, reproduced |
| `deck-cut-census.mjs` -> `deck-cut-census-after.txt` | coverage, continuity, markings, and a no-courses control |
| `rail-probe.mjs` -> `rail-probe.txt` | why 0.75 tiles and not a third: the acceptance curve across probe distances |
| `parapet-census.mjs` -> `parapet-census.txt` | what the 418 became, city-wide |
| `bevel-overlap.mjs` -> `bevel-overlap.txt` | the 131 tiles where the old 45-degree chamfer had to stand down |
| `build-cost.mjs` -> `build-cost.txt` | 33.9 ms to build the deck cut against 30.0 ms for `shoreChains`, which the same two call sites already run |
| `dump-452-413.mjs` -> `.txt` | the two joints that still turn sharply, and why they are a corner |
| `shot-BROKEN-control.mjs` -> `shot-broken-control.txt` | the pre-fix screenshot tool failing on this box |
| `mapaudit-*.txt`, `citybake-check-*.txt`, `reachability-*.txt` | the gates, both sides |
| `regression-test-*.txt` | the test's red and green |
| `suite-after.txt` | the whole suite on the fixed tree |

---

## item by item, and what is NOT covered

`FIXER.md` asks for this explicitly, because a partial fix reported as a fix is
how a defect gets a tick beside it and survives.

### the four flagged decks — all four covered

| finding | m | faces | before | after |
| --- | --- | --- | --- | --- |
| bridge deck edge at **274,361** | 37 | 44 | 42 drawn square | 44 dissolved; deck is The Ring's curved carriageway and its edge now follows the curve (`deck-274-361-topdown-*.png`) |
| bridge deck edge at **200,226** | 36 | 45 | 44 drawn square | 45 dissolved |
| bridge deck edge at **178,478** | 32 | 44 | 43 drawn square | 44 dissolved; this is the one photographed at eye level, before and after |
| bridge deck edge at **274,305** | 18 | 22 | 20 drawn square | 22 dissolved |

### the population — covered

872 of 872 deck/water faces city-wide, not just the 149 bare positions inside
the four gated findings. 418 ninety-degree parapet joints become 2, and both
of those are a genuine corner where two decks meet.

### NOT covered, and deliberately

**Collision still uses the tile mask.** `volume.ts` gives a whole `T_BRIDGE`
tile a deck span, so the drivable deck is the square and the drawn deck is the
curve. They disagree by up to about half a tile at the edge, in both
directions, since the mask is a point sample. This is the same class of gap
§43 closed for the coast, and closing it here means deriving a half-plane per
deck tile and teaching `collide.ts` to read it — a simulation change with a
desync surface, not a renderer one. Filed in `WORLDGEN.md` §45.5 where the next
reader hits it. Mitigating fact, not an excuse: the parapet is not collidable
either and never was, so nothing that can now be driven off the visible edge
could not already be driven off the tile edge.

**The other 20 `built-staircase` findings are untouched.** Iteration 7
established that 19 of them are a tile staircase no renderer draws (groups B
and C) and one is out of scope (the yard at 82,462). Nothing here changes their
`mag`, their reason text or their count.

**The detector's group-C mislabel is still there.** `built-staircase` prints
*"faces dry ground, which no coast curve describes"* for the inland quays
without consulting the bank chain. Iteration 7 declined to fix it to protect
SCORE's comparability, correctly. It is still declined here for the same
reason, and the sentence is still wrong for the three findings it applies to
(640,382 / 67,274 / 176,332). Adding the deck to `onCurve` does not touch it —
those findings report `faces === 0`, a different branch.

**Block and building count: unmoved.** 1184 / 4005 both sides, and
`shared/src/world/city.data.ts` is untouched. Iteration 6's index-coupled
land-use wash cannot occur, because nothing re-baked.

### what the change enabled

One thing, found by reading rather than by a failure, and fixed: the 45-degree
deck bevel §31 added would have overlapped the new chord on 131 water tiles.
See "what the change ENABLED" above. Both painters now stand down there, and
the second `-AFTER` plate is cleaner than the first because of it.
