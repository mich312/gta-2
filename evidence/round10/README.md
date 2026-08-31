# Round 10, lens B fixes — how to retake every picture and number here

Everything below wants the client dev server on port 5985:

```bash
pnpm --filter client dev --port 5985
```

## R9-B01 — the HUD drew ground points at `world - cam` under a tilted camera

`B-probe-hudproject.mjs` projects a 3x5 grid of ground points through the REAL
`CityView` camera on the flyover page, and compares two mappings against it in
the same run: the old `world - cam` identity, and `projectGround` out of
`client/src/render/project.ts` — the shipped module, imported from the dev
server, not a re-implementation.

```bash
node evidence/round10/B-probe-hudproject.mjs 10 360   # the shipped pitch, 1280x720
node evidence/round10/B-probe-hudproject.mjs  0 360   # the control
node evidence/round10/B-probe-hudproject.mjs 10 400   # the view ceiling
node evidence/round10/B-probe-hudproject.mjs  0 400
```

| file | what it shows |
| --- | --- |
| `B-probe-project-p10-360-before.txt` | round 9's instrument, unchanged, reproducing the finding |
| `B-probe-project-p0-360-before.txt` | its control, all zeros, before any change |
| `B-probe-project-p0-360-after.txt` | the same control after the fix, still all zeros |
| `B-probe-hudproject-p10-360-after.txt` | OLD worst 16.14 px, NEW worst 1.0e-12 px |
| `B-probe-hudproject-p0-360-after.txt` | both columns zero, and NEW is bit-identical to OLD |
| `B-probe-hudproject-p10-400-after.txt` | at the ceiling: OLD worst 17.98 px, NEW 2.1e-13 px |
| `B-probe-hudproject-p0-400-after.txt` | the ceiling's control |

`B-probe-project.mjs` is round 9's script on port 5985; it measures the camera
against the identity and never touches client code, so it is the independent
witness rather than the fix marking its own homework.

The check that would have caught it lives with the other GPU-free 3D tests:
`client/test/hudProjection.test.ts`.

## R9-B02 — a respray garage and a clinic wore the clothing shop's front in 2D

Pixels straight out of the shipped painter (`__ground.painter.buildChunk`),
seed 7:

```bash
node evidence/round10/B-probe-shopcolour.mjs        # hex codes per shop kind
node evidence/round10/B-shopfront-strip.mjs evidence/round10/B-shopfronts-after.png
```

| file | what it shows |
| --- | --- |
| `B-probe-shopcolour-before.txt` | spray and clinic on `#6db8d6`, pixel-identical to clothing |
| `B-probe-shopcolour-after.txt` | spray and clinic on `#d6b96d`, clothing alone on `#6db8d6` |
| `B-shopfronts-before.png` | the four kinds side by side: two blue fronts that should not be |
| `B-shopfronts-after.png` | the same four, with the garage amber |

The "before" pictures were taken with `client/src/render/tiles.ts` reverted in
place (`cp` aside, `git checkout --`, `cp` back) — never `git stash`, which is
shared across every worktree in this project.

Look at the spray cell of `B-shopfronts-before.png`: the awning is the clothing
shop's blue while the threshold square two tiles up, painted by
`paintShopFloor`, is already amber. The bug is visible inside a single frame.
# round 10 — R9-D01, R9-D02, R9-D04

Two instruments, both of which reported confidently wrong things.

| file | what it is | retake |
| --- | --- | --- |
| `D01-badfilter.txt` | `ci/test.mjs` on a filter that matches nothing, before and after, plus the two controls | `node ci/test.mjs nosuchtestfilterxyz; node ci/test.mjs noise` |
| `D01-full-suite.txt` | the unfiltered run, unchanged — including one contention flake (`session.test.ts`) and its clean rerun | `pnpm test` |
| `final-test.txt` | the closing `pnpm test`: 91 files, 981 tests, 5 filtered `onTaskUpdate` worker errors, exit 0 | `pnpm test` |
| `D02-rate.mjs` | failure-rate harness: N runs of `persistCheck`, per-run pass/fail, per-run orphan count, per-run loadavg; kills orphans between runs so they cannot inflate the reading | `node evidence/round10/D02-rate.mjs 20 label` |
| `D02-load.mjs` | background CPU load, so the rate can be read at the load that exposed the race | `node evidence/round10/D02-load.mjs 5 420` |
| `D02-before-quiet.txt` | 4/20 failures at load 1.4-2.9, unfixed | — (needs the tree at 9d8ff2c) |
| `D02-before-load.txt` | 11/20 failures at load 5.6-10.0, unfixed, every one `timeout waiting for wallet` | — (needs the tree at 9d8ff2c) |
| `D02-after-quiet.txt` | 0/20 at load 0.6-1.3 | `node evidence/round10/D02-rate.mjs 20 "AFTER quiet"` |
| `D02-after-load.txt` | 0/25 at load 5.6-6.7 | start `D02-load.mjs 5 700`, wait for loadavg ~5.5, then `D02-rate.mjs 25 "AFTER load5.6"` |
| `D02-after-load-heavy.txt` | 0/20 at load 9.1-11.5 — above the band where the unfixed tree failed 11/20 | two `D02-load.mjs 5 500`, wait for loadavg ~9, then `D02-rate.mjs 20 "AFTER load9.0"` |
| `D02-stale-frame-probe.txt` | the trap in this fix: a buffer that answers with the join-time guest wallet would turn the false red into a false green. The probe that caught it, and the teeth check that shows a real loss still fails. | see the file |
| `D04-orphan-control.txt` | a *forced* failure, with and without the cleanup, plus the SIGTERM path | see the file |

A single pass proves nothing here: the race failed 1-in-5 quiet and better than
1-in-2 loaded, so it passes a single run on a fixed **or** an unfixed tree. Read
the rate, at a stated load, or do not read it at all.
