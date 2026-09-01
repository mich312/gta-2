# Iteration 7 — the watch diff learns to say *what* changed

The instrument, not the map. `ci/mapwatch.mjs` counted changed pixels per crop
and could not tell a road appearing from a park re-rolling. Iteration 6 is the
case that forced the change: the fix moved **294 carriageway tiles inside one
192x64 box**, the bake moved **969 tiles**, and the watch reported
`sunridge 13671 px (2.318%)` and `kelvin 1913 px` — neither of which was about
the fix. Both boroughs are land-use churn from the block count going 1182 ->
1184, and land use downstream is index-coupled to block count.

The pixel diff is kept exactly as it was (it is the loop's only continuous
record back to iteration 1, and it catches render-only change the tile classes
cannot see). A tile reading now sits beside it, from the baked tile planes.

## The files

| file | what it is |
| --- | --- |
| `iter6-replay.txt` | iteration 6 re-read with the new code, in full |
| `pixels-before.txt` / `pixels-after.txt` | the pixel table from the pre-change script and from the new one — byte-identical |
| `selftest.txt` | `--selftest`, five cases, one of them going red on purpose |
| `control-identity.txt` | a bake against itself: every column zero |
| `control-negative.txt` | 200 land-use tiles planted, no road: **CARRIAGEWAY: unchanged** |
| `control-red.txt` | the same plant plus ONE road tile: **CARRIAGEWAY: 1 tile** |
| `control-positive.txt` | 200 road tiles planted: `+200 -0`, named crop `strait` |

`control-negative` is the reading that matters. An instrument that always finds
something is as useless as one that finds nothing, so the negative case has to
be able to fail — `control-red.txt` is that same assertion failing, on a bake
that differs from the negative one by a single tile.

## Retake

```bash
pnpm build

# the control. Exits 1 if any case is wrong; case 4 prints a FAIL on purpose
# and the run is still green — that FAIL is the control going red to order.
node ci/mapwatch.mjs --selftest

# the iteration-6 replay. Both bakes are snapshotted in evidence/watch/iter*/
# tiles.json, so no flags are needed:
node ci/mapwatch.mjs 6 --diff 5

# ...and the same thing from the raw commits, which must agree with it:
git show b5c7805:shared/src/world/city.data.ts > /tmp/iter5.city.data.ts
git show ce3189b:shared/src/world/city.data.ts > /tmp/iter6.city.data.ts
node ci/mapwatch.mjs 6 --diff 5 --tiles-prev /tmp/iter5.city.data.ts \
                                --tiles      /tmp/iter6.city.data.ts

# the three control tables. `--selftest` prints the directory it left its
# synthetic bakes in; substitute it for $D.
node ci/mapwatch.mjs --tiles-only --tiles-prev shared/src/world/city.data.ts \
                     --tiles $D/land.city.data.ts          # control-negative
node ci/mapwatch.mjs --tiles-only --tiles-prev shared/src/world/city.data.ts \
                     --tiles $D/contaminated.city.data.ts  # control-red
node ci/mapwatch.mjs --tiles-only --tiles-prev shared/src/world/city.data.ts \
                     --tiles $D/road.city.data.ts          # control-positive
```

The whole diff, both readings and all sixteen crops, runs in **2.6 s**.

## What the replay says

```
CARRIAGEWAY: 294 tiles (+294 -0), all within x 425-544 y 309-312.
  named crops carrying it: strait, headlanda
LAND USE:    675 tiles, incl. kelvin 34, sunridge 216 with NO road transition.

reading the pixel column above:
  road moved here     strait 28766 (4.877%) → +219 -0, headlanda 1007 (0.065%) → +1 -0
  land use only       kelvin 1913 (0.324%), sunridge 13671 (2.318%)
  pixels only         ravenhill 2 (0.000%)  (no tile class in the crop changed)
```

294 is the number the iteration-6 reviewer arrived at by hand, tile by tile.
Sunridge's 216 tiles print as `carriageway NONE` above
`BUILDING->PARK 57 | FIELD->BUILDING 40 | FIELD->PARK 35 | SIDEWALK->FIELD 32`,
which is his listing exactly.

Ravenhill is the reason the pixel diff stays: 2 px moved and **not one tile
class in the crop did**. The tile reading is blind to that and says so in its
own words rather than reporting a quiet crop.
