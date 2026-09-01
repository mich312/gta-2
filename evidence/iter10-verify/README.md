# Iteration 10 — adversarial verification of the loop's own record

Measured on **`8e9c31f`** ("Iteration 9 close: SCORE restated, and the tenth
blind instrument was mine"), working tree clean, `pnpm install && pnpm build`
green (real exit 0, not read through a pipe).

The question was not "what else is broken in the city" but **which claims in
`REVIEW-QUEUE.md` would not survive being checked today**.

## Verdicts

| # | claim | published in | verdict |
| --- | --- | --- | --- |
| 1 | reachability 100,833 / 1 component / mean 491.6 over 702 pairs / 0 unreachable | iter 5–9 closes, `evidence/iter9/README.md:198` | **CONFIRMED** |
| 2 | `citybake --check` at exactly six warnings | iter 5–9 | **CONFIRMED** |
| 3 | `lanes-serving-nothing` unclosable: region B 767 authored = 23.7% vs a 10% gate | iter 6 close | **CONFIRMED** (re-derived independently) |
| 3b | "every other pass could stop laying there and it would still fire at **11.5%**" | iter 6 close | **REFUTED** — 11.5% is the other leg |
| 3c | iter 6 table, region A road = **1197** | iter 6 close | **REFUTED** — 1198 post-fix |
| 4 | bald regions >= 40 tiles: 21 -> 5 -> 1, wild-but-bare 1379 -> 18 -> 0 | iter 8 close | **CONFIRMED** |
| 5 | history table BEFORE column reproduces from `--data` | `iter9-instrument/history.txt` | **CONFIRMED** |
| 6 | history table bottom row still produced by the current tree | same | **CONFIRMED** |
| 7 | 19 of 24 `built-staircase` findings invisible / "74% of it is invisible" / 402 tiles | iter 7 close | **REFUTED** — 23 of 24, 525 tiles, 97% |
| 8 | "**12.3% of SCORE is measuring nothing**" | iter 8 close | **REFUTED** — 13.4% on its own tree |
| 9 | `road-stops-short`: 150 mouths, 125 outside a junction, 0 reaching the ring, 92.6% cleared | iter 9 close | **CONFIRMED** (byte-identical) |
| 10 | both selftests exit 0 | iter 9 close | **CONFIRMED** (checked with `; echo $?`, never through a pipe) |
| 11 | `ci/mapwatch.mjs` refuses a stale dist | iter 8 close | **CONFIRMED** (both legs) |
| 12 | iter 7's curve-cover census: 741 positions, 376 coast / 197 bank / 168 bare | iter 7 close | **CONFIRMED** as a number, but the script is now **stale** |
| 13 | `ci/shot.mjs` fixed, `LENS-B.md` updated | iter 8 close | **CONFIRMED** by reading |

Suite: `node ci/test.mjs` -> 93 files, 999 tests, 0 failures, exit 0
(`ci-test.txt`).

## Files

| file | what |
| --- | --- |
| `reachability-now.txt` | `evidence/iter5/measure-reachability.mjs` on this tree |
| `citybake-check.txt` | the six warnings |
| `mapaudit-now.txt`, `staircase-all.txt` | audit, and every `built-staircase` finding with its drawn verdict |
| `mapaudit-selftest.txt`, `mapwatch-selftest.txt` | both selftests, exits captured unpiped |
| `distguard-stale-refused.txt`, `distguard-fresh-passed.txt` | the dist-freshness guard, both legs |
| `authored-share.mjs` / `.txt` | independent re-derivation of iteration 6's 767 (see below) |
| `attribute-now.txt` | `evidence/iter6/probe-attribute.mjs` run as published — **reads blind** |
| `bare-regions-now.txt` | the 21 -> 5 -> 1 census on all three bakes |
| `rescore-before-only.sh`, `rescore-after-only.sh`, `history-*-now.txt` | the history table, both columns, without touching production source |
| `population-now.txt`, `population-control-prefix3.txt`, `leaks-now.txt` | the `road-stops-short` population and its control |
| `curve-cover-now.txt` | iteration 7's census, re-run |
| `oldaudit/mapAudit.ts` | `bb0aaae`'s instrument, staged for the BEFORE leg |

## Notes on method

**No production code was changed.** `evidence/iter9-instrument/rescore-history.sh`
reproduces its BEFORE column by `git show`-ing `bb0aaae`'s `mapAudit.ts` over
the working copy and putting it back. A verifier may not do that, so the old
instrument is staged at `oldaudit/mapAudit.ts` instead — deliberately at the
**same directory depth** as `server/src/tools`, so its relative import
`../../../shared/dist/world/fields.js` still resolves — with a temporary
`node_modules/shared` symlink, run through node 22's type stripping. The
symlink is removed; recreate it with
`ln -sfn ../../../../shared evidence/iter10-verify/oldaudit/node_modules/shared`.
`server/src/tools/mapAudit.ts` is byte-identical to HEAD
(`md5 14e32b3afd40fee930b58f61daa7f230`) before and after.

**Every control was made to fire, and two of mine did not on the first run.**

- `authored-share.mjs` C1 first sampled `The Ring`'s **centreline**. A median
  road is carved as two offset carriageways with a reservation down the
  middle, so nothing is carved there: the control read `MISS` and would have
  printed `*** BLIND ***` on a working probe. It now samples a point on the
  course `roadCourses()` actually hands the carve, and requires the bake to
  agree the tile is carriageway.
- The same script's first draft modelled every authored road as a single disc
  around `road.points`. That is right for `Kelvin Bridge` (region A: 213,
  matching iteration 6 to the tile) and **wrong for The Ring**, giving 350
  instead of 767. Using `roadCourses()` — layout's own definition, which
  splits a median road in two — gives 767.

## The two findings a future round should care about

### `evidence/iter6/probe-attribute.mjs` now reads blind, and prints the opposite of iteration 6's conclusion

Run today exactly as its header documents, it attributes **100% of every
region to a single bucket `(after layout)`** and prints, for each flagged
region:

```
    (after layout)        1140   drop it and 0 road is left = 0.0%  <10%, CLEARS
```

It needs a `globalThis.__LAYOUT_PROBE__` hook in `shared/src/world/layout.ts`
that **does not exist in the source** (`grep -rn __LAYOUT_PROBE__ shared/src`
is empty). With no hook, `laidBy` is all `null`, everything falls to the
default label, and the script reports that removing road **clears** every
region — which is precisely the proposition iteration 6 spent an iteration
retiring. It does not assert its hook fired. This is the same failure class
the loop has now caught ten times, sitting live in `evidence/` and cited by
the queue.

`authored-share.mjs` is the replacement that needs no hook: it re-derives the
authored share from `plan.roads` through `roadCourses()` and the swept-disc
identity iteration 8 established, and it reproduces both published figures
(region A 213, region B 767 = The Ring 512 + Old Bridge 255).

### `evidence/iter7/curve-cover.mjs` is stale and disagrees with the audit on 149 positions

Its numbers reproduce byte-for-byte (741 positions, 376 coast, 197 bank, 168
bare). But it asks only the **coast and bank** chains — it predates the deck
chain iteration 8 added — so it still reports the four bridge decks as
`bare`, and its own header defines bare as *"on no chain at all, so nothing
repaints it: **the drawn staircase**"*. `mapAudit` on the same tree says all
four decks lie on a curve and none of them is drawn. 149 of its 168 bare
positions are now painted over. Iteration 9's close cites this script
approvingly as being independently reproduced by the selftest's `WHOLE` leg —
which is true of the position **count** (741) and not of the coverage verdict.
