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
