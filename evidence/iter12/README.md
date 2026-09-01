# Iteration 12 — `landuse-staircase`: the woodland edge, as a curve

The largest single defect on the map. `landuse-staircase` read **31 woods,
2,703 tiles, SCORE 2,703, DRAWN 2,427 — 46% of the map's total score**, and a
person found it by rendering the city and looking:
`evidence/final-review/islet-zoom.png` at 20 px per tile is a smoothly curved
coastline with a perfect one-tile woodland staircase inside it.

Full write-up: **WORLDGEN.md §46**.

## The shape of the fix

Iteration 8 fixed the bridge decks because *the curve was already in the
asset*. The first question here was whether woodland had an equivalent. **It
does.** `bake.ts` plants open-country woodland from a field and from nothing
else — `wildAt(tx, ty) == fbm(WILD_SEED, tx/22, ty/22) >= 0.52`, one sample per
tile — so a wood's outline is that field's level set and the `T_TREES` mask is
that level set point-sampled at tile centres. `shared/src/world/woodCut.ts`
reads the contour back, in `shoreChains`' own format, with open country on the
RIGHT of travel. Nothing is smoothed, fitted or invented.

`wildAt` moved out of `bake.ts` into `woodCut.ts` and `bake.ts` imports it, so
the planting rule and the drawn outline are one function.

## Retake

```
node evidence/iter12/wild-contour-probe.mjs     # the field is the outline, with 3 controls
node evidence/iter12/landuse-census.mjs         # the audit's own row, reproduced then repriced
node evidence/iter12/painter-parity.mjs         # 2D / 3D / mapgen, with a flipped-side control
node evidence/iter12/collision-gap.mjs          # the §45.5 gap, sized and signed
node evidence/iter12/uncovered-why.mjs          # every remaining uncovered face, attributed
node evidence/iter12/bake-identical.mjs         # moving wildAt moves no ground
node ci/test.mjs client/test/woodEdge.test.ts   # the regression

pnpm build
node server/dist/tools/mapgen.js --crop=317,720,26 --scale=20 --out=evidence/iter12/AFTER-islet-317-720.png
node server/dist/tools/mapgen.js --crop=67,610,52          --out=evidence/iter12/AFTER-wood-67-610.png
node server/dist/tools/mapgen.js --crop=600,578,30         --out=evidence/iter12/AFTER-causeway-600-578.png
node server/dist/tools/mapgen.js --crop=437,593,37         --out=evidence/iter12/AFTER-wood-437-593.png

# 3D. `ci/shot.mjs` dies during NAVIGATION here — its `networkidle` wait uses
# playwright's default 30 s and baking 768x768 in the page outlives it — so
# this round's shots use `evidence/iter12/shot.mjs`, the same tool with a
# longer goto budget. Serve the client with `client` as vite's ROOT:
node client/node_modules/vite/bin/vite.js client --port 5199 --strictPort &
WAIT_GROUND=30 VIEW=900x900 node evidence/iter12/shot.mjs \
  "http://localhost:5199/city3d.html?fly=1&seed=1&at=100,640&h=420&pitch=18&night=0" \
  evidence/iter12/AFTER-3d-wood.png
```

## Numbers

| | before | after |
|---|---|---|
| `pnpm mapaudit` TOTAL / SCORE / DRAWN | 81 / 5528.8 / 5119.5 | **identical** — see below |
| `landuse-staircase`, repriced with the chain | 31 / 2703.0 / 2427.0 | **14 / 1437.0 / 954.0** |
| the same census's TILE PLANE (ungated `mag`) | 31 / 2703 | **31 / 2703 — held** |
| islet 317,720, drawn wood edge on whole tile edges | **97.2%** of 433 px | **14.1%** of 440 px |
| the same crop's waterline control | 0.0% of 927 px | 0.0% of 927 px |
| `citybake --check` | 1 warning (Coast Road, 169 tiles) | 1 warning, same one |
| blocks / buildings | 1185 / 4005 | 1185 / 4005 |
| reachability | 102,059 / 1 comp / 473.9 over 702 / 0 unreachable | identical |
| `node ci/test.mjs` | green | **green, 94 files, 1000 tests, 0 failures** |
| 3D instances over the same camera | 612,578 | 614,430 — **+1,852**, the cut tile count exactly |

## `pnpm mapaudit` does not move, and why

`landuse-staircase`'s `drawn` column asks `smoothLayer`, which asks
`curveLayer`, which knows the coast, bank and deck chains **and not this one**.
Teaching it is one line in `server/src/tools/mapAudit.ts`:

```ts
  const deck = buildDeckCut(tiles, W, H, city.courses);
+ const wood = buildWoodCut(tiles, W, H);          // + the import from 'shared'
  return (x: number, y: number): boolean => {
    const i = y * W + x;
-   return coast.has(i) || band.has(i) || deck.has(i);
+   return coast.has(i) || band.has(i) || deck.has(i) || wood.has(i);
  };
```

That change was **deliberately not made**: another agent held
`server/src/tools/mapAudit.ts` this iteration. So `mapaudit-BEFORE.txt` and
`mapaudit-AFTER.txt` are byte-identical, and the price of the chain is measured
instead by `landuse-census.mjs`, which **reproduces the shipped tool's own row
to the decimal as its control** (`31 2703 2703.0 2427.0`) before repricing it.
If that control line does not match, nothing after it is evidence and the
script exits non-zero.

**SCORE falls as well as DRAWN, and that is the detector's gate rather than
moved ground.** `landuseStaircase` drops a finding entirely when its uncovered
share falls below `LANDUSE_UNCOVERED` (a half), so 17 of the 31 woods stop being
reported at all. The census prints the ungated tile-plane total on the same
line and it holds at `31 / 2703` — the `TREES` mask still steps exactly as
much; it is simply no longer drawn that way. That is the repaint the finding's
own filing predicted.

## Instruments, and one that was already red

`mapAudit.js --selftest` **exits 1 on this tree and exited 1 on the tree
before it** — `shore-staircase SILENT 0 -> 0`, "1 SIGNATURE(S) DID NOT FIRE".
`mapaudit-selftest-BEFORE.txt` and `-AFTER.txt` are byte-identical, so this
iteration neither caused it nor fixed it. It is recorded here because iteration
9's rule is *re-run an instrument's own control after every change to its
subject* — and this one is red at `6304e7d`, the commit whose close publishes
the measurement.

Controls that were watched going red on purpose:

- `landuse-census.mjs` — its SHIPPED row must equal `pnpm mapaudit`'s to the
  decimal, or it exits 1.
- `painter-parity.mjs` — the 3D side flipped goes from 0 disagreements to
  118,528 of 118,528.
- `bake-identical.mjs` — the comparison is re-run against a payload with one
  character bent, and must say "no".
- `wild-contour-probe.mjs` — a wrong seed, a wrong scale and a wrong threshold
  all score ~50% against the real field's 69.8%.
- `client/test/woodEdge.test.ts` — asserts a non-empty census before asserting
  anything about it, and requires its waterline control to be BELOW 25% before
  comparing the wood to it. It fails on the pre-fix tree
  (`regression-test-BEFORE.txt`) and passes on this one
  (`regression-test-AFTER.txt`).

## What is left

`uncovered-why.txt`: **3,953 of 6,375** woodland/open faces are still on no
smoothing layer, and every one is attributed. 43% are hedgerows and orchard
rows — a planted LINE one tile wide whose outline IS the tile; 43% are places a
later pass moved the boundary (a cleared lane verge, a park's block edge); 0.8%
is the sheer shore cliff. None of them is an outline the wildness field drew,
and cutting them against this contour would be inventing a curve rather than
reading one back.
