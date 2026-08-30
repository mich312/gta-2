# REVIEW-QUEUE.md — the loop's state

The review loop's memory. Agents read and write this file; nothing about a
round lives only in an agent's context, so a lost session, a crash or a closed
laptop does not reset the loop.

The prompts are in `.claude/review/`: `REVIEWER.md` plus a lens, then
`VERIFIER.md`, then `FIXER.md`.

## The loop

```
0. evidence   pnpm build && pnpm test && citybake --check   (+ shots)
1. review     3-5 agents, one per LENS, fed the same evidence
2. verify     one adversarial agent per finding — CONFIRMED / REFUTED / UNPROVEN
3. fix        confirmed findings only, partitioned by directory
4. re-evidence  the same commands, diffed against the round's start
```

## Stopping

The loop stops on **whichever comes first**:

- **Budget.** Four rounds, then stop and report regardless of state.
- **Severity floor.** Only `blocking` findings force another round.
  `significant` and `nit` append to `GAPS.md`.
- **Convergence.** If a round's confirmed-blocking count does not fall against
  the round before, or each fix spawns a fresh finding of the same kind, stop.
  That is the reviewers nitpicking, not the code improving.

"Loop until the reviewers are happy" never halts on a game — there is always
another artifact.

## Entry schema

```markdown
### R1-B03 — the ring road's centre dash breaks at junctions
- status: [ ] open | [x] fixed | [~] escalated | [-] refuted | [?] unproven
- round: 1        severity: significant       lens: B
- where: client/src/three/ground.ts:412
- evidence: evidence/round1/ring-dash.png
- repro: `WAIT_GROUND=24 node ci/shot.mjs ".../city3d.html?fly=1&at=330,630&h=300&pitch=45&night=0" /tmp/x.png`
- prior art: WORLDGEN.md §16 (courses), does not cover junction paint order
- fixed by: <sha>   after: evidence/round1/ring-dash-fixed.png
```

IDs are stable and never reused. `R<round>-<lens><n>`. They are what lets
round 2 say "R1-B03 regressed" instead of filing it fresh as R2-B01 —
without them the loop cannot tell progress from churn.

---

## Round 1 — the whole project

**Ground truth, taken at `1469611` before any lens ran:**

```
pnpm build                      clean (tsc -b server)
pnpm test                       87 files, 943 tests, 0 failures
                                4 ignored 'onTaskUpdate' worker errors (ci/test.mjs filter)
citybake --check                Anywhere City 768x768, baked 15121ms, 0 errors
                                1156 blocks, 4066 buildings, 29 landmarks, 66 shops
```

Scope: all of `client/`, `server/`, `shared/`. No fixes this round — round 1
produces the queue only, so the findings can be judged before any coder is
paid to act on them.

### Findings

Filed by the four lenses, then put to an adversarial verifier one at a time.
A finding is not work until it is CONFIRMED.

#### Lens C — the simulation

### R1-C01 — motorised pursuit shuts down permanently; abandoned cruisers are never removed
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:678`, `:747`, `:1110`, `motorise` at `:573-593`
- repro: `node evidence/round1/C-repro-copcars.mjs 4 240 mortal`
- verified: independent run tagging each cruiser by origin (motorise vs roadblock) — all four abandoned by t=20s, none re-motorised over the next 160s. `cop.vehicleId` has exactly one producer, at officer creation. The only escape hatch found is the wreck clearer, which is gated on no player within 260px — closed during a chase, which is when the cars are parked next to the player. `ci/test.mjs police` green 59/59; no test covers a chase past the first dismount.
- correction: the "car at 330 px/s" figure is from code comments; `vehicles.json` tops out at 252. Immaterial.
- prior art: PROGRESS.md "Police pursuit driving" claims this fixed — promotion upheld

### R1-C02 — `noticedBy` skips both its filters: a corpse witnesses crimes, an invisible player is seen
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:172-188` (no `copIsDown`, no `POWER_INVISIBLE`, and it calls `hasLineOfSight` directly rather than `copSees`)
- repro: `node evidence/round1/C-repro-corpse-witness.mjs`
- verified: independent probe brackets it at 20px (noise), 80px (sight), 5000px (neither). Single caller `weapons.ts:271` does not filter. `node ci/test.mjs noise` passes 9/9 with the bug present — the suite is blind to it. `peds.json` `corpseSec: 40` makes the window 40s.
- prior art: none. `police.ts:55` records the identical bug fixed in `anyCopSees` fifteen lines above.

### R1-C03 — `Math.atan2`/`Math.hypot` in shared sim code, writing hashed fields
- status: [ ] open        verdict: **CONFIRMED**, and understated
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/weapons.ts:361-363`, `traffic.ts:1397`, `police.ts:480`, `:778`
- repro: `node evidence/round1/C-repro-math-trig.mjs`
- verified: the reviewer's part-3 instrument (Math.atan2 vs the repo's own `dAtan2`) is weak — that difference is deliberate. Rebuilt without it, comparing V8 against a hypothetical +1-ulp engine (ECMA-262-legal): the frontal verdict still flips, and `ped.dirX` still diverges in 31% of carjack door offsets. Values traced into `net/hash.ts:111,123-126`; `snapshot.ts` applies no rounding.
- understated: also unpinned — `peds.ts:232,247,329,393`, `traffic.ts:1138,1186`, `daynight.ts:35`
- prior art: WORLDGEN.md §41.5 fixed this class in worldgen; the sweep never covered `shared/src/sim`. The repo argues this case against itself at `courseIndex.ts:67`, `geometry.ts:434`, `traffic.ts:436`.

### R1-C04 — the car bomb is free arson, and its casualties are credited to nobody
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/fittings.ts:54-58` (bypasses `damageVehicle`, so `igniterId` never set)
- repro: `node evidence/round1/C-repro-carbomb.mjs`
- verified: the reviewer's script *printed* the attribution chain as static text; the verifier instrumented the real fuse tick instead and measured `attackerId = -1`. `igniterId` has two writers, both inside `damageVehicle`. No fitting-owner field exists on `VehicleState`. `fittings.test.ts:241` asserts condition/fuse/ammo only — nothing pins the current behaviour as intended.
- prior art: GAPS.md K1 built arson attribution; the bomb branch was never threaded into it

### R1-C05 — `maybeRoadblock`'s per-kind budget is algebraically a no-op
- status: [ ] open        verdict: **CONFIRMED in mechanism, DOWNGRADED**
- round: 1   severity: ~~significant~~ **nit**   lens: C
- where: `shared/src/sim/police.ts:775` — the `+ 2` appears on both sides and cancels
- repro: `node evidence/round1/C-repro-roadblock-cap.mjs`
- verified: the algebra holds and both jumps were attributed to roadblock ticks (two driverless vehicles 27.96px apart = 2x the 14px offset at `:803`). One-character fix: `cap + 2` -> `cap`.
- **but**: `shared/test/police.test.ts:1670` asserts `cap + 2` as deliberate, with reasoning, and is green. The prior-art claim "recorded nowhere" is false. And the motivation fails its own bar: tank cap 3 + 2 = 5, against a stated intent of "cannot end up with six tanks". Bounded and non-cumulative; permanence belongs to R1-C01, not here.
- correction: the citation "GTA.md P3c" is mislabelled — the string appears nowhere in the repo; the sentence is in GTA.md's "S3 — the military at five stars".

#### Lens D — the seams

### R1-D01 — a page reload reconnects the player to a body they cannot move
- status: [ ] open        verdict: **CONFIRMED**, and understated
- round: 1   severity: significant   lens: D
- where: `server/src/session.ts:422`, `:475` against `client/src/main.ts:303` (`let seq = 1`)
- repro: `node evidence/round1/D-repro-resume-input.mjs`
- verified: the reviewer's script bypasses `GameHost.handleJoin`, so the verifier re-ran it end-to-end through the real host with binary-codec wire frames, plus a control. Reloaded numbering moves the character **0 px**; a control that continues at seq 901 moves it **114 px**. Same server, same resumed body, same 150 inputs.
- understated: the dead window is the *prior play duration*, not 120s — `RESUME_GRACE_MS` bounds only how late a resume is accepted. An hour of play then a reload = ~an hour of ignored input.
- prior art: BUGS.md §11.1 and §11.4 cover other halves of resume, not the sequence watermark

### R1-D02 — the published evidence no longer reproduces from its own retake commands
- status: [ ] open        verdict: **CONFIRMED**, count intact at 13
- round: 1   severity: significant   lens: D
- where: `evidence/README.md` and 13 of the 15 checkable PNGs it indexes
- repro: `node evidence/round1/D-pngdiff.mjs evidence/<name>.png <retake>`
- verified: the instrument was validated first — the same command run twice diffs to `0/313600 (0.000%)`, so the renderer is bit-deterministic and the percentages cannot be encoder noise. Size mismatches exit early and contribute no percentage. Three rows independently re-rendered from the README's own commands: 66.152% / 1.283% / SIZE DIFFER 480x480 vs 1536x1536. Commits-behind reproduce exactly (39/32/71).
- the "historical before-shot" refutation fails: one disclaimer exists in the whole README (`street-ambulance.png`) and it is not among the 13. The two before-flavoured rows are `--tiles` renders of the *current* generator with a layer off, both with live retake commands.
- correction: the `vector-p1-coast.png` caption attribution is a misread — the "26 degree borough" phrase belongs to a different crop. The 66% divergence is real (25-30 degree fabric -> axis-aligned grid); the gloss on why was wrong. And REVIEW-WORLDGEN.md:5 promises a retake command *exists*, not that it still reproduces.
- sharpest row: `airstrip.png` — the committed 480x480 is the pre-Anywhere-City generator. The same command now emits the archipelago at 1536x1536. Not drift; a different city.

### R1-D03 — `ci/deploy.sh` ships whatever `origin/main` is, not the commit the suite passed
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: D
- where: `ci/deploy.sh:30-32` against the `test` job in `.github/workflows/deploy.yml`
- repro: read the two files together (no execution possible — the deploy host is unreachable)
- verified from the files: zero hits for `GITHUB_SHA|github.sha|SendEnv|bash -s --|if:` across all of `.github/workflows/` and `ci/` — no commit crosses the SSH boundary. `concurrency: deploy-gta` is a static literal with `cancel-in-progress: false`. `workflow_dispatch` carries no branch filter while `on.push` does, so the dispatch hole needs no runtime assumption.
- inference, stated: the push-during-test race rests on Actions' documented queuing semantics, unobservable from the repo.
- fix: `git reset --hard "$GITHUB_SHA"`, with the sha passed over the SSH invocation.
- prior art: PLAN-WORLDGEN.md wave 0.4 closed the workflow gate, not the checkout

### R1-D04 — a Node build that gains `node:sqlite` silently abandons the JSON fallback's accounts
- status: [-] refuted        verdict: **REFUTED as filed**
- round: 1   severity: ~~significant~~ —   lens: D
- where: `server/src/economy/createStore.ts:25-26`
- repro: `node evidence/round1/D-repro-backend-swap.mjs`
- refuted: the code half is accurate, but the trigger does not exist. Node 22 already ships `node:sqlite` unflagged (`v22.22.2` -> `DatabaseSync, StatementSync, constants, backup`), and `git log -p --follow -- Dockerfile` shows the base image has **one revision in its whole history** — `node:24-slim` from the start. No sqlite-less image ever stood behind `/app/data`, so no `persist.json` was ever written to be abandoned. The cited version gap has `node:sqlite` on both sides and points the wrong way.
- per VERIFIER.md, a finding that needs rewriting to survive is refuted as filed. The residual is real and is filed separately as R1-D07.

### R1-D05 — a client rejected for protocol mismatch reconnects every two seconds for ever
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: nit   lens: D
- where: `client/src/net/connection.ts:75-81` against `client/src/main.ts:682-687`
- verified live: a throwaway `ws` server on an ephemeral port answering any join with `{code:'protocol'}` then closing, against the real unmodified `Connection`. Five sockets in nine seconds, gaps 2016/2006/2007/2005 ms, still going at harness exit. `attempts` reads 1 every cycle — the socket does open before the rejection and `onopen` zeroes it — so nothing accumulates toward a ceiling even if one were added.
- prior art: none. BUGS.md §11 covers the server's side, not the client's retry policy.

### R1-D06 — `deploy.sh`'s health check accepts any 1xx-4xx, so a 404 counts as healthy
- status: [ ] open        verdict: **CONFIRMED** (surfaced by the D03 verifier, not by a lens)
- round: 1   severity: significant   lens: D
- where: `ci/deploy.sh:23` — `healthy()` matches `[1-4][0-9][0-9]`
- why it matters: the rollback at `deploy.sh:38-46` lives entirely in this check's fall-through. A deploy that comes up serving 404 rolls back nothing. Compounds R1-D03.
- prior art: none found.

### R1-D07 — the store's `.json` -> `.db` direction is silent for host operators
- status: [ ] open        verdict: **CONFIRMED** (the surviving residual of R1-D04)
- round: 1   severity: nit   lens: D
- where: `server/src/economy/createStore.ts:25-36`
- why it matters: README.md:82-87 tells host operators on pre-22.5, flagged 22.5-22.12, or `--without-sqlite` builds that they land on the sibling `.json`. The fallback warns in the `.db` -> `.json` direction; the reverse is silent. Not reachable through Docker, which is why R1-D04 was refuted — but reachable for a documented class of operator.
- prior art: none found.

#### Lens A — worldgen

_(running)_

#### Lens B — the renderer

_(running)_

### Checked and deliberately not filed

Lens D: interest-radius enter/leave (held by `server/test/interest.test.ts`); the
`MAX_PLAYERS` reconnect exemption (the README's claim holds); `ci/test.mjs`'s
known-error filter (no input found that makes it swallow a real failure); two
real but unreachable `FileStore` weaknesses (whole-ledger rewrite per
transaction, 6.1 ms at 20k rows against a 33.3 ms tick; an unguarded
`JSON.parse` that turns an unreadable save into a boot loop).

Not checked: `play-dusk/drift/foot.png` — `ci/playLocal.mjs` hung in `getInCar`
past 420 s twice under container contention.
