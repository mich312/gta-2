# Visual loop, iteration 6 — the metric that could not see a fix get smaller

The loop's headline metric has now failed to register a real fix twice, for
two different reasons. Iteration 3's zero was **blindness** — two real fixes
had no signature at all, which iteration 4 closed by writing them. Iteration
5's zero was a **threshold that stays tripped**: `lanes-serving-nothing` gates
on road >= 10% of a region's land, the fix took region B from 1343 road tiles
(41.5%) to 1140 (35.2%), and 35.2% is still over 10%, so the region still
fired, so TOTAL still read 55. A 203-tile improvement scored exactly what a
no-op scores.

This round changes no game code and no map. It gives every finding a
**magnitude** in tiles, so the instrument is continuous about a thing that is
continuous.

## What the number is

`m=<n>` is a new column on every finding line, between `severity` and
`reason`: **how big this defect is, in tiles of map** — not whether it is
there. Each signature's `mag:` line in `mapAudit.ts` says what its tiles
count; `magOf`'s doc comment states the four properties any new signature's
magnitude has to keep (it moves while the finding still fires, it is monotone,
it is a property of the map rather than of the run, and it is in tiles so the
per-signature numbers can be added up).

The summary block gains two columns and the run gains one line:

- **TOTAL** — the count. Meaning unchanged, so it compares straight back
  through the loop's history. Still 55.
- **tiles** — the unweighted sum of magnitudes for that signature. This is
  where a small signature's progress shows.
- **SCORE** — the sum of magnitudes with the three `noisy` signatures
  discounted to a quarter. SCORE is an area, so whichever signature covers the
  most ground dominates it; that is why `tiles` is printed per signature too.

`built-staircase` (24) and `street-serves-nothing` (5) are two thirds of the
count between them and are marked `noisy` — a reviewer is told to treat every
one of their hits as a question. They are **discounted, not dropped**: they
still print, still count towards TOTAL, still carry a magnitude, and a tile of
them is worth `NOISY_WEIGHT = 0.25` of a tile of a signature whose hits were
all defects when they were cropped and looked at. Dropping a signature from
the score is how a signature stops being looked at.

## The two-sided control, and iteration 5's retroactive score

Both sides scored with the SAME (new) detector, each against its own bake and
plan, from a throwaway worktree at `7769a2c` with `mapAudit.ts` copied in.

| | `7769a2c` (pre-iter-5) | `ffb2e89` (post-iter-5) | delta |
|---|---|---|---|
| TOTAL (count) | 55 | 55 | **0** |
| `lanes-serving-nothing` region B, 267,312-365,375 | **m=1343** | **m=1140** | **-203** |
| `lanes-serving-nothing` region A, 393,312-549,365 | m=1197 | m=1197 | 0 |
| `lanes-serving-nothing` tiles | 2540 | 2337 | -203 |
| all signatures, tiles | 3707 | 3504 | -203 |
| **SCORE** | **3129.5** | **2926.5** | **-203.0** |

The count is flat across a change the loop knows to be real. The magnitude
moves by exactly 203 tiles, which is the fix as iteration 5 measured it
(1343 -> 1140), and independently as the 16-crop diff measured it (`shoulderb`
13,116 px at 8 px/tile ~ 205 tiles). **Iteration 5 scored 203.** That is the
historical data point the loop did not have.

Nothing else moved, which is the other half of the reading: no signature's
magnitude drifted, so the 203 is the fix and not the instrument.

## The control that decides whether the score is real

A plant proves a detector can see a defect APPEAR. It cannot prove the
instrument can see a defect get SMALLER — and that is precisely what failed.
So `--selftest` gained a **half-fix control**: take the biggest real
`lanes-serving-nothing` finding on the shipped map, lift out half its
carriageway (more than iteration 5 managed, still nowhere near the 10% gate),
and require that the finding is STILL THERE and its magnitude has FALLEN.

    # half-fix control: shrink a real finding without curing it
    # lanes-serving-nothing  SHRANK   2 -> 2  m 2337 -> 1739 after lifting
    #   598 of 1197 carriageway tiles out of 393,312-549,365
    # a partial fix scores: the count held and the magnitude fell

Fired-and-smaller is exactly the state the old instrument could not tell from
fired-and-identical. If this control ever reads BLIND, the score has stopped
measuring progress, and `--selftest` now exits 1 so it cannot be missed.

**Its first draft read BLIND, and that is in `control-negative.txt`.** It
selected the region to half-fix by two of the signature's three gates (land
and road share, not the built-tiles gate), and picked `627,380-706,536` — a
region over both those gates and under neither finding. Lifting 806 of its
1612 carriageway tiles moved nothing: `m 2337 -> 2337`. A control that selects
by different rules than the detector is not a control. The gates are now
`firesLanes()`, called by both.

| file | what it shows |
|---|---|
| `audit-before.txt` | `ffb2e89`, iteration 5's detector. The standing baseline: 55 across 20 signatures. Retake: `git show ffb2e89:server/src/tools/mapAudit.ts`, build, `node server/dist/tools/mapAudit.js --all`. |
| `audit-after.txt` | `ffb2e89`, this iteration's detector. Same 55, now with magnitudes, tiles 3504, SCORE 2926.5. Retake: `node server/dist/tools/mapAudit.js --all`. |
| `summary-side-by-side.txt` | Both summary blocks whole, then the count column of each against the other, signature by signature. Every count identical, TOTAL 55 either side. |
| `findings-identical.txt` | Requirement 1 proved on BOTH bakes: strip the new `m=` column and the 55 finding lines are byte-identical in the same order. Also the `x,y,w` field fed straight back into `mapgen --crop=` and rendering. |
| `audit-7769a2c.txt` | The pre-iteration-5 bake under this iteration's detector — the other side of the control, and iteration 5's retroactive score. Retake: `git worktree add --detach /tmp/wt 7769a2c`, symlink `node_modules` in, copy this `mapAudit.ts` over its own, `pnpm build`, `node server/dist/tools/mapAudit.js --all`, `git worktree remove --force /tmp/wt`. |
| `audit-7769a2c-oldcode.txt` | The same bake under iteration 5's detector, so the identity diff has both bakes and not just the shipped one. |
| `selftest.txt` | Eighteen planted controls on the shipped bake: eighteen FIRED, and eighteen moved their magnitude. Then the half-fix control: SHRANK, `m 2337 -> 1739`. Retake: `node server/dist/tools/mapAudit.js --selftest`. |
| `selftest-7769a2c.txt` | The same eighteen against the pre-iteration-5 bake, all FIRED, all moved. Its half-fix control picks region B there (1343 road, the biggest firing) and reads `m 2540 -> 1869`. |
| `control-negative.txt` | The half-fix control FAILING, from its own first draft — `BLIND`, `m 2337 -> 2337`, exit 1. The proof that the control can go red, without which its green means nothing. Retake: in `halfFixControl`, replace the `firesLanes(...)` filter with `f.land >= GATES.fringeLand && f.road / f.land >= GATES.fringeRoad`, build, `--selftest`. |

Fold this file into `evidence/README.md` — this round did not write there, on
the shared-checkout rule.
