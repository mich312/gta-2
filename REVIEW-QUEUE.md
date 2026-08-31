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
- status: [x] fixed       verdict: **CONFIRMED**
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:678`, `:747`, `:1110`, `motorise` at `:573-593`
- repro: `node evidence/round1/C-repro-copcars.mjs 4 240 mortal`
- verified: independent run tagging each cruiser by origin (motorise vs roadblock) — all four abandoned by t=20s, none re-motorised over the next 160s. `cop.vehicleId` has exactly one producer, at officer creation. The only escape hatch found is the wreck clearer, which is gated on no player within 260px — closed during a chase, which is when the cars are parked next to the player. `ci/test.mjs police` green 59/59; no test covers a chase past the first dismount.
- correction: the "car at 330 px/s" figure is from code comments; `vehicles.json` tops out at 252. Immaterial.
- prior art: PROGRESS.md "Police pursuit driving" claims this fixed — promotion upheld

**Fixed by** `14a24fd` on `worktree-agent-a6f80c5fe8733d452` (not pushed). Both halves, since
they are not exclusive and neither alone is enough:

1. **`remount`** (`police.ts`). An officer on foot whose target is more than
   `2 x dismountDist` away goes back to a free police vehicle within 180 px —
   walking to it when it is out of door reach, boarding on the same
   `enterReach` measure a player boards on. Gated on `carsFromStar`, so it
   cannot motorise a two-star posse. The dismount at `dismountDist` was always
   meant to be temporary; nothing put the officer back.
2. **`retireAbandoned`** (`police.ts`, run at the top of `stepPolice`, before
   dispatch so the budget is counted after the sweep). A driverless, intact
   police vehicle more than `spawnMaxDist` (640 px) from every player and more
   than 180 px from every live officer is removed. 640 is beyond the ring
   dispatch draws from AND beyond the server's 600 px interest radius, so no
   client was ever told the car exists — nothing blinks out in view — and it
   is comfortably past `roadblockAheadDist` (420), so a fresh roadblock is
   never swept.
3. **`GameState.copFleet`** (`state.ts`), a server-only side table on the
   `trafficDrivers` / `vehicleHitTick` idiom: vehicle id -> the officer it was
   issued to. Needed because "an abandoned cruiser" and "the cruiser parked
   outside the police station" are otherwise the same object — a driverless
   `copcar` — and the station's is a vehicle HOME (`amenities.ts:862`,
   `session.ts:325`), the documented answer to "where do I find a police car".
   A distance rule alone would have deleted it. Only fleet cars are remounted
   or retired.
4. One-line invariant in `drivePursuit`: an officer whose car's `driverId` is
   no longer theirs goes on foot. `cop.vehicleId` and `v.driverId` are written
   together and were not read together, so an officer could ghost-drive a car
   the traffic system had parked (see R1-C06 below) — and, now that a second
   officer can board a free car, could have been handed the same one.

**Rejected**: motorising mid-chase (a fresh `motorise` call), which
`maybeSpawnCop:400-404` argues against for good reason — it drops a car under
a standing officer, usually on a pavement, where it wedges on the first tick.
`remount` creates nothing; it puts an officer into a car already parked on a
road because an officer got out of it there.

**Test**: `shared/test/police.test.ts` +2, immediately after the existing "an
officer pulls up and finishes the chase on foot":
- "an officer who pulled up gets back in when the fugitive pulls away" —
  without the fix: `never got back in: expected null to be 501`.
- "the cruisers a chase leaves behind do not outlive it" — a real four-star
  chase, then the fugitive is streets away and clean; without the fix:
  `litter survived the chase: expected 4 to be +0`.
Both were run against the unfixed `police.ts` and fail; police suite 59 -> 61.

**Instrument note.** The round-1 repro does not sustain a chase. Its autopilot
steers directly away from the nearest officer, which drives into a building:
on seed 6006 the fugitive wedges at (4471, 8707) at t≈15s and never moves
again (`me.pos` identical at every 15 s sample from t=15 to t=225). Everything
it prints after that is a stationary suspect with the force standing round
them, and a force that has arrived and got out at a suspect going nowhere is
behaving correctly — so the script can show the defect but not the fix.
`evidence/round1/C-repro-copcars-driving.mjs` is the same measurement over a
fugitive that keeps driving (steers along the road grid, reverses out when it
stops making progress) and adds a `travelled` column so a wedge is visible.

before — `node evidence/round1/C-repro-copcars-driving.mjs 4 240`
```
t= 15s  copcars=3 (driven 0, abandoned 3)  live officers=4   motorised=1  travelled=1984px
t= 45s  copcars=6 (driven 1, abandoned 5)  live officers=11  motorised=2  travelled=3517px
t= 60s  copcars=6 (driven 0, abandoned 6)  live officers=5   motorised=0  travelled=4453px
t=225s  copcars=6 (driven 0, abandoned 6)  live officers=5   motorised=0  travelled=5245px
officers dispatched: 12; ever had a car: 7; still in one at the end: 0
```
after
```
t= 15s  copcars=2 (driven 1, abandoned 1)  live officers=2  motorised=1  travelled=2076px
t= 45s  copcars=5 (driven 2, abandoned 3)  live officers=6  motorised=5  travelled=3536px
t= 60s  copcars=4 (driven 1, abandoned 3)  live officers=6  motorised=3  travelled=4401px
t= 90s  copcars=3 (driven 1, abandoned 2)  live officers=5  motorised=2  travelled=6258px
t=225s  copcars=2 (driven 0, abandoned 2)  live officers=6  motorised=1  travelled=6837px
officers dispatched: 13; ever had a car: 9; still in one at the end: 2
```
The fleet no longer pins at the cap, and officers are still motorised at the
end of a four-star chase instead of nought from t=60s on. (This bench also
wedges eventually, at t≈105s; the moving stretch is the measurement.)

- round-1 repro, for the record: `node evidence/round1/C-repro-copcars.mjs 4 240 mortal` goes from `copcars=6 (driven 0, abandoned 6) motorised=0` at every sample from t=45s, `ever had a car: 6`, to `ever had a car: 9` with occasional motorised officers — the small change is the wedge, not the fix. Its "308 officers dispatched" is a stationary suspect being arrested and re-heated in place.

### R1-C02 — `noticedBy` skips both its filters: a corpse witnesses crimes, an invisible player is seen
- status: [x] **FIXED round 4** — `0c9c534`, the structural route        verdict: CONFIRMED
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:172-188` (no `copIsDown`, no `POWER_INVISIBLE`, and it calls `hasLineOfSight` directly rather than `copSees`)
- repro: `node evidence/round3/F-R1-C02-corpse-witness.mjs` — **the round-1 script no longer demonstrates anything**, see below
- verified: independent probe brackets it at 20px (noise), 80px (sight), 5000px (neither). Single caller `weapons.ts:271` does not filter. `node ci/test.mjs noise` passes 9/9 with the bug present — the suite is blind to it. `peds.json` `corpseSec: 40` makes the window 40s.
- prior art: none. `police.ts:55` records the identical bug fixed in `anyCopSees` fifteen lines above.

### R1-C03 — `Math.atan2`/`Math.hypot` in shared sim code, writing hashed fields
- status: [x] fixed       verdict: **CONFIRMED**, and understated
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/weapons.ts:361-363`, `traffic.ts:1397`, `police.ts:480`, `:778`
- repro: `node evidence/round1/C-repro-math-trig.mjs`
- verified: the reviewer's part-3 instrument (Math.atan2 vs the repo's own `dAtan2`) is weak — that difference is deliberate. Rebuilt without it, comparing V8 against a hypothetical +1-ulp engine (ECMA-262-legal): the frontal verdict still flips, and `ped.dirX` still diverges in 31% of carjack door offsets. Values traced into `net/hash.ts:111,123-126`; `snapshot.ts` applies no rounding.
- understated: also unpinned — `peds.ts:232,247,329,393`, `traffic.ts:1138,1186`, `daynight.ts:35`
- prior art: WORLDGEN.md §41.5 fixed this class in worldgen; the sweep never covered `shared/src/sim`. The repo argues this case against itself at `courseIndex.ts:67`, `geometry.ts:434`, `traffic.ts:436`.

**Fixed by** `14a24fd` on `worktree-agent-a6f80c5fe8733d452` (not pushed). All thirteen calls in five
files — the four sites filed and the seven the verifier added, following §41.5's own
approach — `Math.hypot` -> `Math.sqrt` (ECMA-262 pins sqrt to the exactly
rounded result and leaves hypot approximated), `Math.atan2` -> `dAtan2`,
`Math.cos` -> `dCos`:

| file | was | now |
|---|---|---|
| `weapons.ts:361-363` | `Math.atan2` x3 (shield facing/bearing) | `dAtan2` |
| `traffic.ts:1397` | `Math.hypot` (`ejectDriver`, the carjack door) | `Math.sqrt(dx*dx+dy*dy)` |
| `traffic.ts:1138,1186` | `Math.hypot` | `distVec` |
| `police.ts:480,778` | `Math.hypot` | `lenVec` |
| `peds.ts:232,247` | `Math.hypot` | `distVec` |
| `peds.ts:329,393` | `Math.hypot` | `Math.sqrt(dx*dx+dy*dy)` |
| `daynight.ts:35` | `Math.cos(tod * 2 * Math.PI)` | `dCos(tod * TWO_PI)` |

`lenVec`/`distVec` (`math/vec.ts`) are already the `Math.sqrt` form; no new
helper was added. Every site carries a comment saying which value it reaches.

`daynight.ts:35` is worth naming: it looks like renderer-only, and is not.
`nightAmount` -> `crowdScale` -> `session.ts:497 topUpPeds`, which **rounds**
it into a pedestrian spawn target — so a last-bit disagreement between two
hosts is one pedestrian more on one of them, and the ambient stream diverges
from there. That is precisely what `ci/hostParity.mjs` exists to catch.

**Test**: `shared/test/trig.test.ts` gains "the trig rule holds in sim code" —
a source gate over `shared/src/sim/**`, in the file whose own header already
said "the rule is only that SIM code never does" without enforcing it. Scanned
rather than listed, on the reasoning `server/test/portable.test.ts` gives for
walking its import graph: a roster goes stale the first time somebody adds a
file, silently. Run against the unfixed tree it names every one of them and fails. Scope is `shared/src/sim` only — worldgen has its own, larger, question
and §41.5 covered part of it; widening the gate to `shared/src/world` is a
separate piece of work, filed below as R1-C07.

- `pnpm parity`: **host parity OK — seed=7 ticks=600 samples=20, final hash 437625668** ("the same simulation, in Node and in a browser, tick for tick"). This is the instrument that exists for exactly this property, and it passes after the change.
- no test expectation was changed. The suite is green as it stood; the numerics moved by less than any assertion's tolerance (`dSin` is within 6e-8 of `Math.sin`, and the sqrt/hypot swap moves values by at most one ulp).

### R1-C04 — the car bomb is free arson, and its casualties are credited to nobody
- status: [x] **FIXED round 4** — `a253655`, charged at arming        verdict: CONFIRMED
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/fittings.ts:54-58` (bypasses `damageVehicle`, so `igniterId` never set)
- repro: `node evidence/round1/C-repro-carbomb.mjs`
- verified: the reviewer's script *printed* the attribution chain as static text; the verifier instrumented the real fuse tick instead and measured `attackerId = -1`. `igniterId` has two writers, both inside `damageVehicle`. No fitting-owner field exists on `VehicleState`. `fittings.test.ts:241` asserts condition/fuse/ammo only — nothing pins the current behaviour as intended.
- prior art: GAPS.md K1 built arson attribution; the bomb branch was never threaded into it

### R1-C05 — `maybeRoadblock`'s per-kind budget is algebraically a no-op
- status: [x] **FIXED round 3** — option (b), written honestly as `cars > cap`, no behaviour change        verdict: CONFIRMED in mechanism, DOWNGRADED
- round: 1   severity: ~~significant~~ **nit**   lens: C
- where: `shared/src/sim/police.ts:775` — the `+ 2` appears on both sides and cancels
- repro: `node evidence/round1/C-repro-roadblock-cap.mjs`
- verified: the algebra holds and both jumps were attributed to roadblock ticks (two driverless vehicles 27.96px apart = 2x the 14px offset at `:803`). One-character fix: `cap + 2` -> `cap`.
- **but**: `shared/test/police.test.ts:1670` asserts `cap + 2` as deliberate, with reasoning, and is green. The prior-art claim "recorded nowhere" is false. And the motivation fails its own bar: tank cap 3 + 2 = 5, against a stated intent of "cannot end up with six tanks". Bounded and non-cumulative; permanence belongs to R1-C01, not here.
- correction: the citation "GTA.md P3c" is mislabelled — the string appears nowhere in the repo; the sentence is in GTA.md's "S3 — the military at five stars".

#### Found while fixing round 1 (lens C's ground), filed for round 2

### R1-C06 — ambient traffic adopts police cruisers as its own cars
- status: [~] **REOPENED round 5** — fixed at two sites, a third was never gated; see R5-C01        verdict: CONFIRMED, partially fixed
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/traffic.ts:115` (`isAiDriver(d) => d < -1`) against `police.ts:564` (`copDriverId = -100000 - copId`)
- repro: `node evidence/round1/C-probe-traffic-adopts-cruisers.mjs` — prints `tick 17 cop cruisers with an ambient-traffic driver record: 4`
- what happens: a cop cruiser's `driverId` is negative, so `isAiDriver` is true for it. `stepTraffic` (traffic.ts:892, the `isAiDriver` filter at :896 and the `freshDriver` mint at :906) therefore picks it up, mints a `trafficDrivers` record for it and **drives it**, on top of `drivePursuit` driving it in the same tick (`step.ts:133` then `:151`). `stepTrafficPopulation`'s alighting path can then "park" it — `ejectDriver`, `v.driverId = null` — while the officer's `cop.vehicleId` still points at it. Measured before any of the R1-C01 work: the officer went on ghost-driving a car with no driver.
- also in range: `stepTrafficPopulation:1081-1083` lets a **pedestrian** board an abandoned cruiser (`v.driverId !== null` is the only occupancy test), and `:1130-1147` culls cop cruisers at `despawnDist` as if they were ambient stock.
- the R1-C01 fix adds a one-line invariant in `drivePursuit` (an officer whose car's `driverId` is not theirs is on foot), which stops the ghost-driving. It does **not** stop the traffic AI steering a cruiser mid-pursuit — that needs `isAiDriver` to distinguish the two negative bands, or the police band to be excluded where traffic iterates. Left alone deliberately: it is a traffic change, not a police one, and it is bigger than the finding it was found under.
- prior art: `traffic.ts:59` documents the negative-id convention as the thing that separates AI from players. It does not separate two AIs.

### R1-C07 — the trig gate stops at `shared/src/sim`; `shared/src/world` has ~90 unpinned calls
- status: [x] **FIXED round 8** — `f9e99eb`; 8 of 97 calls, not a sweep
- round: 1   severity: nit   lens: C
- where: `shared/src/world/` — `layout.ts`, `plangen.ts`, `buildings.ts`, `heights.ts`, `turf.ts`, `amenities.ts`, `volume.ts`, `bake.ts`, `geometry.ts`, `marks.ts`
- repro: `grep -rn "Math\.\(hypot\|atan2\|sin\|cos\)(" shared/src/world/ | wc -l`
- why it is a nit and not a blocker: worldgen runs once per window and the result is a map, not a stepped state — it does not go through `hashSnapshot`. But `generateCity` is shared code that both hosts run (`ci/hostParity.mjs` regenerates it on each side), so the class is the same one §41.5 already found and fixed two instances of, and there is no gate keeping the rest out.
- what the R1-C03 fix did NOT do: widen `shared/test/trig.test.ts`'s scan to `shared/src/world`. Turning ~90 sites is a worldgen change with its own review, and `dSin`/`dCos` are only accurate to ~6e-8 — enough for the sim, possibly not for a distance field. Needs a decision, not a sweep.

#### Lens D — the seams

### R1-D01 — a page reload reconnects the player to a body they cannot move
- status: [x] fixed       verdict: **CONFIRMED**, and understated
- fixed by: `745e7f7`, merged. **Chose**: `welcome` carries `inputSeq` (the slot's `lastQueuedSeq`, 0 on a fresh join); the client takes `max(seq, inputSeq + 1)`. `PROTOCOL_VERSION` 8 -> 9.
- **rejected**: resetting `lastQueuedSeq` on resume — it pays for a client counter bug with the slot's whole replay guard, and the zombie socket makes that concrete: `handleJoin` closes the old conn, but a close is a handshake, so frames already on the wire still arrive with `playerId` set. With the watermark intact they die on the guard. The same numbering also drives prediction (`reconcile` filters `pending` on `seq > ackSeq`), so a client at seq 1 against ack 900 discards its whole buffer every message.
- `max` not assignment: an in-session reconnect is already ahead of the server, and rewinding renumbers inputs the predictor still holds.
- after: `welcome.inputSeq=300 lastQueuedSeq=300 accepted=150 moved 389.25 px`; control (old numbering) `accepted=0 moved 0.00 px`. Suite 88 files / 945 tests, +2 mine. Negative control run: forcing `inputSeq` to 0 fails the new test twice.
- round: 1   severity: significant   lens: D
- where: `server/src/session.ts:422`, `:475` against `client/src/main.ts:303` (`let seq = 1`)
- repro: `node evidence/round1/D-repro-resume-input.mjs`
- verified: the reviewer's script bypasses `GameHost.handleJoin`, so the verifier re-ran it end-to-end through the real host with binary-codec wire frames, plus a control. Reloaded numbering moves the character **0 px**; a control that continues at seq 901 moves it **114 px**. Same server, same resumed body, same 150 inputs.
- understated: the dead window is the *prior play duration*, not 120s — `RESUME_GRACE_MS` bounds only how late a resume is accepted. An hour of play then a reload = ~an hour of ignored input.
- prior art: BUGS.md §11.1 and §11.4 cover other halves of resume, not the sequence watermark
- fix: `welcome` now carries `inputSeq` (the slot's `lastQueuedSeq`, 0 on a fresh join) and the client resumes its counter from it — `seq = Math.max(seq, msg.inputSeq + 1)` in the welcome handler, so a reconnect that never reloaded is never renumbered backwards under inputs its predictor still holds. `PROTOCOL_VERSION` 8 -> 9 (the welcome payload changed shape). Files: `shared/src/net/messages.ts`, `shared/src/constants.ts`, `server/src/host.ts:542`, `client/src/main.ts:623`.
- not taken: resetting `lastQueuedSeq` on resume. It buys a client-side counter bug with the slot's whole replay guard, and the same numbering drives prediction reconciliation through `ackSeq`, which only lines up if it stays monotonic. The guard at `session.ts:475` is untouched and just as strict — §11.1 (a still-connected slot refusing a reconnect) and §11.4 (tokens never rotated) are both unchanged.
- before/after: `node evidence/round1/D-repro-resume-input.mjs` — the script now runs the Session-level mechanism AND the same reload end to end through `GameHost` with binary-codec frames. Reloaded client resuming from welcome: `accepted=150 moved 389.25 px`. Control that restarts at seq 1: `accepted=0 moved 0.00 px` (the guard, still doing its job). Part 1 still prints `0 of 150` at the `Session` level, because that is the guard, not the bug.
- test: `server/test/resumeInput.test.ts`, two tests end to end through the real host. With `inputSeq` forced to 0 (pre-fix) they fail on both the wire field and `expected 0 to be greater than 50` px of movement.
- verification: `pnpm build` clean; `pnpm test` 88 files / 945 tests / 0 failures (4 ignored onTaskUpdate runner-noise errors); `citybake --check` exit 0, 1156 blocks / 4066 buildings / 29 landmarks / 66 shops, unchanged from the round's ground truth.

### R1-D02 — the published evidence no longer reproduces from its own retake commands
- status: [x] **FIXED round 5** — `526fe83` + a post-merge re-retake; every deterministic plate now reproduces at 0px        verdict: CONFIRMED
- round: 1   severity: significant   lens: D
- where: `evidence/README.md` and 13 of the 15 checkable PNGs it indexes
- repro: `node evidence/round1/D-pngdiff.mjs evidence/<name>.png <retake>`
- verified: the instrument was validated first — the same command run twice diffs to `0/313600 (0.000%)`, so the renderer is bit-deterministic and the percentages cannot be encoder noise. Size mismatches exit early and contribute no percentage. Three rows independently re-rendered from the README's own commands: 66.152% / 1.283% / SIZE DIFFER 480x480 vs 1536x1536. Commits-behind reproduce exactly (39/32/71).
- the "historical before-shot" refutation fails: one disclaimer exists in the whole README (`street-ambulance.png`) and it is not among the 13. The two before-flavoured rows are `--tiles` renders of the *current* generator with a layer off, both with live retake commands.
- correction: the `vector-p1-coast.png` caption attribution is a misread — the "26 degree borough" phrase belongs to a different crop. The 66% divergence is real (25-30 degree fabric -> axis-aligned grid); the gloss on why was wrong. And REVIEW-WORLDGEN.md:5 promises a retake command *exists*, not that it still reproduces.
- sharpest row: `airstrip.png` — the committed 480x480 is the pre-Anywhere-City generator. The same command now emits the archipelago at 1536x1536. Not drift; a different city.

### R1-D03 — `ci/deploy.sh` ships whatever `origin/main` is, not the commit the suite passed
- status: [x] **FIXED** — round 2        verdict: CONFIRMED
- round: 1   severity: significant   lens: D
- where: `ci/deploy.sh:30-32` against the `test` job in `.github/workflows/deploy.yml`
- repro: read the two files together (no execution possible — the deploy host is unreachable)
- verified from the files: zero hits for `GITHUB_SHA|github.sha|SendEnv|bash -s --|if:` across all of `.github/workflows/` and `ci/` — no commit crosses the SSH boundary. `concurrency: deploy-gta` is a static literal with `cancel-in-progress: false`. `workflow_dispatch` carries no branch filter while `on.push` does, so the dispatch hole needs no runtime assumption.
- inference, stated: the push-during-test race rests on Actions' documented queuing semantics, unobservable from the repo.
- **fixed**: the sha crosses as `DEPLOY_SHA: ${{ github.sha }}` (an env value, never interpolated into script text), shape-checked `^[0-9a-f]{40}$` on both sides, and arrives as a required `$1`. `deploy.sh` no longer resolves its own target. Resolution precedes any reset — fetch, `cat-file -e`, a direct sha fetch for what the default refspec missed, re-check — and a sha the server cannot obtain exits 1 with the old checkout and the running container untouched. `PREV`/`NEW` and the rollback are unchanged.
- **the dispatch hole is closed, not moved**: pinning alone would have made a dispatch from branch `foo` deploy `foo` — unreviewed branch code in production. The deploy job now carries `if: github.ref == 'refs/heads/main'`, at job level so the step holding `DEPLOY_SSH_KEY` is never scheduled off main.
- verified live: all four refusal paths exit 2 before any side effect (no arg, `origin/main`, `abc; rm -rf /`, short `abc`); `bash -n` and `shellcheck 0.10.0` clean; both workflows parse. Reasoned-only, no deploy host reachable: the SSH stdin+argv mechanics end to end, `allowReachableSHA1InWant`, the force-push refusal, concurrency ordering.
- no test written, deliberately: `shared/test`, `server/test` and `client/test` are all in-process game-logic suites and none imports `node:child_process`; a text-grep test would sit below the altitude of everything around it. The check that would catch this class is shellcheck wired into `test.yml` — noted, not done, as it widens scope.
- prior art: PLAN-WORLDGEN.md wave 0.4 closed the workflow gate, not the checkout

### R1-D04 — a Node build that gains `node:sqlite` silently abandons the JSON fallback's accounts
- status: [-] refuted        verdict: **REFUTED as filed**
- round: 1   severity: ~~significant~~ —   lens: D
- where: `server/src/economy/createStore.ts:25-26`
- repro: `node evidence/round1/D-repro-backend-swap.mjs`
- refuted: the code half is accurate, but the trigger does not exist. Node 22 already ships `node:sqlite` unflagged (`v22.22.2` -> `DatabaseSync, StatementSync, constants, backup`), and `git log -p --follow -- Dockerfile` shows the base image has **one revision in its whole history** — `node:24-slim` from the start. No sqlite-less image ever stood behind `/app/data`, so no `persist.json` was ever written to be abandoned. The cited version gap has `node:sqlite` on both sides and points the wrong way.
- per VERIFIER.md, a finding that needs rewriting to survive is refuted as filed. The residual is real and is filed separately as R1-D07.

### R1-D05 — a client rejected for protocol mismatch reconnects every two seconds for ever
- status: [x] **FIXED round 2** — promoted mid-round because D01's protocol bump made it certain        verdict: CONFIRMED
- round: 1   severity: nit   lens: D
- where: `client/src/net/connection.ts:75-81` against `client/src/main.ts:682-687`
- verified live: a throwaway `ws` server on an ephemeral port answering any join with `{code:'protocol'}` then closing, against the real unmodified `Connection`. Five sockets in nine seconds, gaps 2016/2006/2007/2005 ms, still going at harness exit. `attempts` reads 1 every cycle — the socket does open before the rejection and `onopen` zeroes it — so nothing accumulates toward a ceiling even if one were added.
- prior art: none. BUGS.md §11 covers the server's side, not the client's retry policy.

### R1-D06 — `deploy.sh`'s health check accepts any 1xx-4xx, so a 404 counts as healthy
- status: [x] **FIXED** — round 2        verdict: CONFIRMED (surfaced by the D03 verifier, not by a lens)
- round: 1   severity: significant   lens: D
- where: `ci/deploy.sh:23` — `healthy()` matches `[1-4][0-9][0-9]`
- why it matters: the rollback at `deploy.sh:38-46` lives entirely in this check's fall-through. A deploy that comes up serving 404 rolls back nothing. Compounds R1-D03.
- **fixed**: `[1-4][0-9][0-9]` -> `2[0-9][0-9]`, after establishing what answers the port: `docker-compose.yml` publishes `127.0.0.1:8080` straight at the game's Node process, so the check talks to `createStaticServer` with no proxy between. That handler answers 200, or 500 when the client bundle is missing, and 403 only on path traversal; it never redirects. So 3xx buys nothing and 4xx/5xx is precisely what disarmed the rollback — 2xx-only is right, not merely stricter. Predicate exercised over 16 codes (100/199/200/204/299/300/301/302/399/400/403/404/499/500/502/000).
- prior art: none found.

### R1-D07 — the store's `.json` -> `.db` direction is silent for host operators
- status: [x] **FIXED round 3** — the sqlite branch names the sibling it will not read        verdict: CONFIRMED
- round: 1   severity: nit   lens: D
- where: `server/src/economy/createStore.ts:25-36`
- why it matters: README.md:82-87 tells host operators on pre-22.5, flagged 22.5-22.12, or `--without-sqlite` builds that they land on the sibling `.json`. The fallback warns in the `.db` -> `.json` direction; the reverse is silent. Not reachable through Docker, which is why R1-D04 was refuted — but reachable for a documented class of operator.
- prior art: none found.

#### Lens A — worldgen

### R1-A01 — Kelvin Bridge and Marsh Causeway bake to nothing
- status: [x] fixed (Kelvin Bridge) + [~] escalated (Marsh Causeway, the Ring's east crossing)
- fixed by: `01332db` (worktree branch `worktree-agent-a666958f7e415fc23`, not pushed)
- round: 1   severity: **blocking**   lens: A
- where: `shared/data/city-plan.json` (both roads); `layout.ts:2298-2356` (no-piers pass); `cityCheck.ts:42` (no rule)
- repro: `node server/dist/tools/mapgen.js --crop=436,336,44 --scale=16 --out=…`
- verified: census re-run independently — BRIDGE=0 at both sites, unbroken water across both channels. Both refutations failed: both roads are `"bridges": true` with author's notes ("The signature span… the shortest way between the two halves of the city"), and WORLDGEN.md:961 names both as strait crossings.
- **worse than filed**: a connected-component enumeration of every deck returns **6 crossings, not 8** — the Ring's east crossing is also absent, so the entire eastern half of the strait has none. Detours measured by BFS: 726 and 984 road tiles against euclidean 121 and 124 (6x and 8x).
- severity checked against REVIEWER.md's ladder: the render shows a four-lane carriageway with a painted centre line ending in a rounded cap on a bare bank. "Geometry the player sees that is plainly wrong" — blocking stands.
- prior art: WORLDGEN.md §23.1 files the deck removal as a FIX and never records that the crossing is gone; §12.3 still claims it.

**Round 2 — the gate, built first.** `checkCity` rule 5: for every `bridges: true`
road, walk the courses the layout actually carves (`roadCourses`, moved to
`plan.ts` so the checker and the bake cannot drift apart — for a dual
carriageway that is the two offsets, not the reservation down the middle) and
report any stretch longer than the road is wide where no tile of the
carriageway's cross-section is road or bridge.

Not in `parseCityPlan`, for the reason `plan.ts:442` already gives about
`bandShore`: the geography is not rasterised at parse time, so "is there land
at the end of this line" is not a question the schema can ask. In `checkCity`
it also holds a *generated* plan to the same rule.

**A warning, not an error, and that was a judgement call.** The rule reports a
disagreement between the plan and the map, and which of the two is wrong is a
design decision each time. Making it an error today would leave
`citybake --check` permanently red on three pre-existing crossings nobody has
decided about — worse than a rule that names them. Enforcement is not lost:
`server/test/shippedCity.test.ts` pins the surviving six messages verbatim, so
a *new* broken crossing, or one of these getting worse, is a red `pnpm test`.
**Promote the rule to `error` once the three below are decided.**

- **reproduction** (the gate on the shipped city, before any plan edit):
  `evidence/round2/A01-gate-before.txt` — 7 warnings, naming Kelvin Bridge and
  Marsh Causeway as filed, plus three the finding did not have.
- **fixed — Kelvin Bridge.** The polyline ran `[[452,288],[452,400]]`; the
  warped south bank at x=452 is at y=415. Extended to `[452,418]`, three tiles
  onto the bank. The deck now has two landfalls, survives the no-piers pass,
  and the crossing is 52 tiles of water against `maxBridgeSpan` 72. Deck
  components 9 -> 10; the new one is 214 tiles at (450,357)-(453,414).
  before: `evidence/round2/A01-kelvin-bridge-before.png`
  after:  `evidence/round2/A01-kelvin-bridge-after.png`
- **new test**: `server/test/bridgingRoads.test.ts` bakes the plan with Kelvin
  Bridge put back to y=400 and asserts the checker names it. Plus
  `server/test/shippedCity.test.ts` — the warning pin, and "builds Kelvin
  Bridge" on the shipped bytes.

#### ESCALATED — Marsh Causeway
The north end (566,292) is 17 tiles out in open water (the bank at x=566 is
y=275), and the bay it aims at is **93-100 tiles** wide on that line against
`maxBridgeSpan` 72. Not a polyline nudge. Measured options:

| option | cost | measured |
|---|---|---|
| extend the polyline north to the bank | one number | makes the *landfall* right and the crossing still 98 tiles: the warning changes wording, the causeway is still not there. **Cosmetic. Do not do this.** |
| reroute to the narrows at x≈600 (`[[600,290],[600,375]]`) | moves the causeway ~34 tiles east | the bay is **62 tiles** there. Baked: deck tiles 1496 -> 1742, Marsh Causeway's warning gone, `checkCity` 0 errors. **Works** — but it lands somewhere else on both banks, and where a named causeway meets Marsh End is an authoring decision, not a fixer's. |
| raise `maxBridgeSpan` past 100 | one number, whole-map blast radius | not measured; 100 is longer than the Kelvin is wide, so "wider than this and the water is sea" stops meaning anything. |
| accept it: drop `bridges` and let the boat be the way across | one flag | honest, and the plan's own note for `maxBridgeSpan` argues for it. Costs the causeway its name. |

#### ESCALATED — the Ring's east crossing, and it is a THIRD cause
Not a short polyline and not a wide sea: it misses by **one to three tiles**.
The eastern bay's vertical water span by column, from the finished mask:

```
x=592  62      x=628  71      x=644  73  <- ring cw0
x=608  63      x=636  71      x=648  73
x=620  70      x=640  72      x=652  75  <- ring cw1
```

`maxBridgeSpan` is 72, and `trimBridges` drops a deck whose narrowest run is
*strictly greater*. So the ring crosses at 73-75 and both carriageways go.
Measured: `maxBridgeSpan: 76` restores it — deck tiles 1496 -> 2078, 0 errors,
and nothing else in the city gains a deck (the whole +582 is the ring's two
carriageways). One number, and the smallest fix on this page — but it is the
plan's definition of what counts as sea, so it wants the author, not me.
The alternative is moving the ring's east side ~16 tiles west to x≈628, which
is a signature road through Marsh End.

#### Knock-on, all in the same commit
Three tests went red on the rebake. None was loosened; all three assertions
they were written to make still stand.

- `shared/test/coastCache.test.ts` — **the test's classifier was wrong, and the
  fix exposed it.** A bridge deck spans its channel wall to wall, so restoring
  Kelvin Bridge sealed the reach of the strait between it and Old Bridge from
  the map border: enclosed water 20,249 -> 29,286 tiles. Three of the seven
  known waterline TIES fell inside it, and the test asked "is this water the
  border flood cannot reach" *before* "is this tile exactly on a ring", so it
  reported them as ponds — water carved behind the curve's back, at distance
  **0.0000** from the curve. The two `else if` arms are now in the other
  order. Every assertion is unchanged (`unexplained === 0`, `ties <= 16`,
  `decks > 0`, `ponds === 0`) and the pond detector is not blinded: an
  unringed pond is nowhere near a ring, so it still lands in the pond arm.
  **Worth a reviewer's eye** — it is the one place a test changed shape.
- `shared/test/police.test.ts` "lifting one under a cop's nose is" and
  `shared/test/powerups.test.ts` "the jail card is spent instead of the
  arrest" — both staged their officer at a FIXED offset (+12 px, +8 px) from
  the player spawn. The rebake moved the spawn list; this seed's player now
  lands on a kerb, and the ground east of it is the building behind the
  pavement, so the officer was placed inside a wall and witnessed nothing.
  Both now use `clearSpot`, which is what their own siblings do and what
  `police.test.ts:1177` already records an hour lost to.
- `server/test/session.test.ts` failed once under load in the full run and
  passes on its own. Runner starvation, not a change.

#### Not R1-A01, found by its gate — the Coast Road
Three stretches, **169 + 79 + 22 tiles**, where the Coast Road has no
carriageway at all: the coastline warp moved the south shore inland of the
course the road was drawn on, so for a third of its length the road is out at
sea. Nobody had filed this. Left alone (out of scope), pinned in
`shippedCity.test.ts`, **file it as its own round-3 finding.**

### R1-A02 — Hollis Creek is crossed nowhere along its length
- status: [x] **FIXED round 4** — `ac4894f`, detours 458->20 and 124->6        verdict: CONFIRMED
- round: 1   severity: significant   lens: A
- where: `city-plan.json` — The Esplanade and Longacre Road, both `bridges: false`
- verified by counterfactual, which is what settles "deliberate or not": flipping **every** road to `bridges:true` adds 41 bridge tiles in exactly 2 clusters, both on this creek. Seven of the nine `false` roads are inert — they never touch bridgeable water. `bridgeable()` already refuses open water on its own, so the flag does no anti-causeway duty anywhere. And the field's documented rationale (`plan.ts:191`, "which roads are big enough") cannot be why, since every road in the plan is `width: 4`. The split tracks names, not what each course crosses.
- detours re-measured from the shipped bake: 464 and 123 steps (filed: 453 and 124).
- correction: "Hollis appears nowhere in WORLDGEN.md" — "Hollis Farm" is at line 958. Different feature.
- prior art: none. No recorded decision to argue with, just an absence.

### R1-A03 — The Docks' contour fabric lays no cross streets
- status: [x] fixed
- fixed by: `01332db` (same commit as R1-A01 — one rebake)
- round: 1   severity: significant   lens: A
- where: `layout.ts:1625` (contour cross streets) and `layout.ts:1273` (`frameDeg` PCA)
- **the reviewer found the symptom; the verifier found the cause.** `frameDeg`'s PCA samples only tiles with `bandField <= 2`. The Docks' banding shore is on its **east** side, so the true mean tangent is 90 degrees — but the nearest owned dry tile is 9 away, nothing matches, `n === 0`, and it silently falls back to the authored `angle: 0`. The cross streets are carved **parallel to the bands they were meant to cross**.
- causal test, forcing only `frameDeg = 90` and changing nothing else:
  `baseline: 12 blocks, median 1691, biggest 27x158` -> `forced: 51 blocks, median 330, biggest 28x22`
  28x22 is the authored 28x24 cell. The pitch is honoured everywhere and silently dropped here.
- **latent beyond this district**: Terraces and Beachfront take the same fallback and survive only because their shore is horizontal, so `angle: 0` happens to equal the true tangent. Any future borough on a non-horizontal shore inherits the bug.
- prior art: none found.

**Round 2 — fixed at the fallback, not at The Docks.** The defect is the
*absolute* threshold. `bandField <= 2` assumes a contour borough owns dry
ground within two units of the water it bands against, which is false whenever
its `bandShore` box sits off its own land. So the sample is taken **relative to
the borough**: find the lowest `bandField` over the borough's own dry tiles
(`floor`), then sample `bandField <= floor + 2` — the borough's innermost band,
whatever distance that turns out to be, with the same two units of thickness.

Measured `floor` / `n` / `frameDeg`, over the shipped plan:

```
The Terraces   floor=8   n=10    frameDeg=178   (authored 0)   <- ALSO had n===0
Beachfront     floor=1   n=146   frameDeg=1     (authored 0)
The Docks      floor=9   n=56    frameDeg=90    (authored 0)
```

The Terraces was the second silent fallback and nobody had noticed: it is 2
degrees off the authored angle, which is why it looked fine. Beachfront was
the only one measuring anything at all.

And **no silent guess is left**: if a contour borough owns no dry ground, there
is no shore to take a frame from and `buildLayout` now throws, the way it
already throws for a `bandShore` box with no water in it. `n` can no longer be
zero by construction — `floor` comes from a tile the sample filter accepts.

- **before** (whole-city census, per district, blocks / median area / biggest):
  `The Docks   14 blocks  median 1691  biggest 27x158`
- **after**:
  `The Docks   51 blocks  median  330  biggest  30x22`  (authored cell 28x24)
  `The Terraces 155 -> 148`, `Beachfront 124 -> 124`, city total 1156 -> 1182
- before: `evidence/round2/A03-docks-before.png`
- after:  `evidence/round2/A03-docks-after.png`
- **new test**: `shared/test/city.test.ts` — "cuts every contour borough across
  its bands, at whatever angle its shore runs". Every contour borough, not The
  Docks: median block area under 1.5x its authored cell, and more than 20
  blocks. The Docks scored 2.5x and 14 before the fix.
- **knock-on, and it is in the same commit**: giving The Docks its cross
  streets put one of them through the `Harbour Precinct` landmark rect, and
  `bakeCity` refused the plan. Moved to the rect `citybake --fit` named,
  `[87,317] -> [83,328]`, 15 tiles down the same quay.

### R1-A04 — known: a public street still crosses Marsh End Airfield's runway
- status: [-] refuted        verdict: **REFUTED as filed**
- round: 1   severity: ~~significant~~ —   lens: A
- the tile identity is right — 14 genuine `T_ROAD` inside the rect, no `T_LOT` apron anywhere in it. But the **promotion warrant is not**: the reviewer quoted past a caveat. `PLAN-WORLDGEN.md:111` says "DELIVERED — **see PROGRESS.md**" one clause before the sentence quoted, and `PROGRESS.md:277` reads: "the one crossing that remains at Marsh End is the bake's own two-tile access driveway to the hangar, which is a taxiway with a job."
- mechanism confirmed independently: `bake.ts:546` cuts a driveway from every non-`byAir` landmark door; Marsh End's baked door is tile (519,606), immediately south of the stub's last road tile. The stub dead-ends at the rect's south edge into bare field — an access track, not a through route. The render shows a band with no kerb casing, no centre dashes, no ribbon stroke.
- the census confirms the note's diagnosis rather than disproving it. Residuals refiled as R1-A08.

### R1-A05 — `checkCity`'s "has no road to it" does not look for a road
- status: [x] **FIXED round 3** — frontage check ADDED (prior-art re-check made this the right half)        verdict: CONFIRMED
- round: 1   severity: nit   lens: A
- verified: `drivable()` is genuinely the sim's own rule (`plainSolid`, `collide.ts:44`, blocks the same three tiles), so the *predicate* is defensible — a landmark reachable across a car park really is vehicle-reachable. What it does not defend is the *message*, or `city.test.ts:170`, which scans for real `T_ROAD`/`T_BRIDGE` frontage. The suite is strictly stronger than the checker whose error string claims the same property.
- repro reproduced: 285 carriageway tiles erased around Mercy General, `checkCity` returns `[]`.
- trimmed: "walling a hospital off from the street network" overstates it — nothing genuinely unreachable ships.
- **prior art UNVERIFIED**: the verifier searched for `GAPS.md` inside `.claude/review/` instead of the repo root. Cheap to re-check in round 2.

### R1-A06 — `parseCityPlan` bounds-checks landmarks but not roads, rivers or districts
- status: [x] **FIXED round 3** — `width < 1` refused; bounds refuse only wholly-off-map, because boroughs overhang by design        verdict: CONFIRMED
- round: 1   severity: nit   lens: A
- **sharper than filed**: the width-0 road becomes a course that `decodeBakedCity` explicitly rejects — `bake.ts:1137`, `'a course with no line or no width'`. The parser waves through a value its own asset decoder calls malformed, one pipeline stage and fifteen seconds later.
- also accepted, unfiled by the reviewer: **negative** widths, identically.
- off-map geometry clips safely everywhere (`lay()`, `onGround`, `pointInPoly`), so the harm is silence, not corruption. Nit is right.
- **do not merge with A01**: A01's landfall gate would catch an off-map endpoint on a bridging road, but the zero-width road is entirely on land and passes it untouched, and off-map rivers and district polygons never reach a bridge gate. Two fixes.

### R1-A08 — wave 2.3 stands DELIVERED with two promises unkept
- status: [x] **FIXED round 3** — runway rule added (not the naive one); huts moved off both slabs        verdict: CONFIRMED
- round: 1   severity: nit   lens: A
- the promised `cityCheck` rule — no street tile inside a runway rect — does not exist; `city.test.ts:743` asserts only the converse (every `T_RUNWAY` tile is inside a rect). And the huts were never moved off the slabs: 9 `T_BUILDING` tiles at each strip's corner with runway on all sides beneath them.
- side effect confirmed: `runwayCentreRow` (`tiles.ts:159`) walks per column, so the hut-shortened columns jog the centreline — at Marsh End x=507, and at **Gannet x=79**, which the reviewer missed.

#### Lens B — the renderer

### R1-B01 — street lamps and shop signs burn at midday in 3D
- status: [x] **FIXED round 3** — `d342238`; the bloom threshold became a ratio to the key light        verdict: CONFIRMED
- round: 1   severity: significant   lens: B
- **the floor is not the defect.** Isolated with `?post=off` (bloom off, lights on) against `?post=off&lights=off`: direct illumination at midday is **+1 to +3 / 255** across the whole surround — imperceptible, exactly as the comment promises. What the player sees is the **bloom halo**: a 74 cd source ~3 world px from its own emissive fixture pushes it past `BLOOM_THRESHOLD` 1.05 and `UnrealBloomPass` paints the halo. That is the mechanism `lights3d.ts:576-583` describes and repaired for headlights only.
- **do not cut `lights3d.ts:361`.** `renderer.ts:503` carries the identical `lit = 0.15 + 0.85 * night` and pushes the identical 0.075 alpha; 2D throws the same floor and it comes out invisible because 2D has no thresholded bloom. Cutting the floor moves the night curve and diverges the two renderers, which the file exists to mirror.
- confirmed real: at (40,450) the 3D midday frame reads luma **129** where `lights=off` reads **4** — deep shade lifted thirty-fold at noon; the lamp does ~two-thirds as much visible work at midday as at midnight. Arithmetic exact: `lit` 0.15 -> alpha 0.075 -> `intensityOf` 73.5 cd -> `applyPoint` 73.8 cd.
- **not the B03 shape** — tested explicitly. B03 was two independently documented endpoints; here three authored statements (GAPS.md:579 in a section GAPS.md:13 records as built, `lights3d.ts:366-368`, `post.ts:85-90`) say a lamp must not burn at noon, and the file records the bloom interaction as a bug it already fixed for another light family. A defect, not a design question.
- corrections to the filing: the blown bulb is bright **art** in both renderers (`sprites.json` `lampBulb`), not the floor — the floor adds ~17 luma there; there is no "warm pool"; and the finding's 2D pixels were not on a lamp at all — at pitch 10 a 14 px head leans 7-20 screen px, so "the same pixel" was never a sound method.
- evidence: `evidence/round3/V-R1-B01-*.png` (+ `-profile.mjs`, `-read.mjs`)
- where: `lights3d.ts:361` (`lit = 0.15 + 0.85 * night`), consumed at `:379` and `:400`
- prior art: REVIEW-3D.md records the *vehicle* version as fixed; the lamp/shop floor is recorded nowhere. `lights3d.ts:576-583` diagnoses the same floor for the other light family and gave headlights 0.06; the lamps that sentence names kept 0.15.

### R1-B02 — the lit windows that carry 2D night have no 3D equivalent the camera can see
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: B
- verified with re-taken frames at the shipped default camera (`GAME_PITCH` 10, `render=3d` default):
  `warm pixels 64 (2D) vs 17 (3D) | brightest warm lum 196 vs 131 | below luma 32: 0.5% vs 25.0%`
- **stronger than filed**: `drawWindows` never runs in 3D at all. `main.ts:1077` calls the `LightPass` it writes into only in the 2D branch and the fallback `catch`. The 96-light budget is structurally unreachable, not outshone.
- albedo proved arithmetically, not just read: `uLit` is `0xffd9a0` = (255,217,160); the measured lit pane is `rgb(140,120,95)` — 0.55/0.55/0.59 on every channel. A fully-lit pane sits at the night rig's ceiling, so it cannot glow, cannot bloom, casts nothing. On the other facade in the same block the panes come out *darker* than the wall.
- where the finding was loose (conceded, not fatal): the camera sees more wall than "one strip", and the facade does render visibly lit panes at ~1.5x wall luma.
- evidence: `evidence/round1/V-B02-block-2d.png` against `V-B02-block-3d.png` — seven warm glow pools ringing the block against dark slabs and two faintly striped walls.

### R1-B03 — the two renderers agree at midday and disagree by 1.7x at dusk
- status: [x] **closed — won't fix, working as designed**
- round: 1   severity: ~~significant~~ **escalated**   lens: B
- the measurement reproduces: 3D luma 22.8 vs 2D 40.7 at `night=0.6`; midday agrees to **1/255**, tighter than filed. Lighting arithmetic confirmed (2.50 against 4.75 = 52.6%; the 2D grade multiply is exactly 187).
- **but no invariant is violated.** `BUGS.md` §4 explicitly declines to touch the night end: "The night end is left exactly where it was tuned — night has to actually be dark or a street lamp cannot read against it, and that is the whole point of having lamps." Both night levels are independently and deliberately documented (`cityView.ts:433`, `config.ts:57`, `PROGRESS.md:598`). §4 also pre-dismisses whole-frame luma as evidence, weakening the finding's histogram paragraph.
- what survives: §4's own operative criterion is the modal road pixel, and *that* agrees at noon and fails at dusk. So "calibrated at one point on a two-point curve" is fair — but closing the gap means overriding two documented art decisions.
- **DECIDED by the user, 2026-08-31: leave it — working as designed.** The two renderers were tuned independently for stated reasons; the 2D path is a fallback and need not match numerically at every hour. Closed as a non-defect. Round 2's lens B must not re-file it: it is now prior art.
- correction: the vignette claim is wrong for (700,60) (r=305.9, outside the 230.4 inner radius) — immaterially, since the contamination shrinks the gap rather than creating it.

### R1-B04 — `city3d.html`'s draw/triangle readout has reported `draws 1  tris 0k` since the post chain landed
- status: [x] **FIXED round 3** — draws 1 -> 238, tris 0k -> 7031k        verdict: CONFIRMED
- round: 1   severity: nit   lens: B
- verified in the installed three@0.185.1: `info.reset()` at `three.module.js:17696` with `autoReset` defaulting true, and zero `autoReset` hits anywhere in the repo. The composer's last pass is the grade quad, so its 1 draw / 2 triangles is all that survives.
- **the refutation failed**: `3D.md:179`'s "9 draw calls, 57,767 instances, 762k triangles" is quoted verbatim from this HUD — the cited screenshot's overlay reads exactly those numbers. `ci/renderBench.mjs` is not an alternative source: it has no draw/triangle instrument at all.
- **round-2 candidate, unverified**: `ci/renderBench.mjs:37-39` reportedly has *both arms pinned to `render=2d`*. REVIEW-3D.md records fixing this same instrument for "comparing 3D against 3D". Nobody tested whether the current state is deliberate.

### R1-B05 — scenery prop pools still zero-scale their tails
- status: [x] **FIXED round 3** — prop instances per frame 768 -> 56        verdict: CONFIRMED
- round: 1   severity: nit   lens: B
- the "maybe it is static" refutation was tested empirically, not argued: the shipped city run through the real placement code gives 1600 props total, worst-case 67 on screen at the shipped AOI radius, fullest single pool 55 of 192. `updateProps` runs every frame from `requestAnimationFrame` with no dirty check, `used` varies per frame (props flip `bin` -> `bin_broken`), and `frustumCulled = false` on both mesh and twin removes the only escape.
- tightened: the outline twin is `castShadow = false`, so the three payments are main-pass mesh + shadow-pass mesh + main-pass twin — the count of three is right, the attribution was not.
- fix is two lines matching the neighbours (`entities.ts:399`, `worldObjects.ts:155`).

### Checked and deliberately not filed

Lens D: interest-radius enter/leave (held by `server/test/interest.test.ts`); the
`MAX_PLAYERS` reconnect exemption (the README's claim holds); `ci/test.mjs`'s
known-error filter (no input found that makes it swallow a real failure); two
real but unreachable `FileStore` weaknesses (whole-ledger rewrite per
transaction, 6.1 ms at 20k rows against a 33.3 ms tick; an unguarded
`JSON.parse` that turns an unreadable save into a boot loop).

Not checked: `play-dusk/drift/foot.png` — `ci/playLocal.mjs` hung in `getInCar`
past 420 s twice under container contention.


---

## Round 2 — the top tier

Six confirmed findings go to fixers. The nits, the evidence refresh (D02) and
the two verifier-surfaced findings (D06, D07) stay open for round 3.

**The partition rule, corrected by round 1's experience.** "Parallel only
across disjoint directories" is not sufficient in this repo: every fixer runs
`pnpm build`, which writes shared `server/dist` and `shared/dist`, so four
agents in one checkout corrupt each other's output whatever source files they
touch. The partition must be by **build artifact**, which means one git
worktree per group.

| worktree | findings | serial because |
| --- | --- | --- |
| worldgen | A01 then A03 | both edit `layout.ts`; both force a rebake of `city.data.ts`, which must happen once, at the end |
| sim | C01 then C03 | both edit `police.ts` |
| netcode | D01 | `server/src/session.ts` + `client/src/main.ts` |
| ci | D03 | `ci/deploy.sh` + `.github/workflows/`, no build — **merged** |

### Not in round 2, and why

- **B03** — closed above. A decision, taken.
- **D02** (13 stale evidence PNGs) — real, but a documentation-debt job, and
  the worldgen fixes in this round will invalidate more of them. Retake after
  the city is rebaked, not before.
- **B01** — its verifier had not returned when round 1 closed. Unverified
  findings do not go to fixers.
- the nits (A05, A06, A08, B04, B05, C05, D05, D07) and D06 — round 3.

### A correction to the loop, found by running it

**Fixers must not write to `REVIEW-QUEUE.md`.** Worktree isolation refused the
D03 fixer's edit, and it was right to refuse: the queue is shared mutable
state, four fixers hold four copies of it, and the last one to copy its
version back would silently revert the other three. `FIXER.md` step 5 asks for
exactly that race.

The fix is to invert it: a fixer **reports** its status, evidence paths and
escalations, and the orchestrator writes them into the queue. The fixer's own
worktree copy is scratch. Round 3's `FIXER.md` should say so.

This is the second time the round has taught the same lesson — the first was
that partitioning by directory is not enough when every agent builds into a
shared `dist`. Both are the same shape: **isolation has to cover everything
two agents can both write, not just their source files.**

### The D01 -> D05 coupling, and why it promoted a nit mid-round

`R1-D01`'s fix bumps `PROTOCOL_VERSION` 8 -> 9. `R1-D05` — confirmed, filed a
nit, slated for round 3 — is that a client rejected for `code:'protocol'`
reconnects every 2 s for ever with no ceiling.

D05's own "why it matters" named this exact trigger: *"the state of every tab
left open across a deploy that bumps it."* So shipping D01 alone would convert
a theoretical nit into a certainty, on the next deploy, from every stale tab at
once. D05 was promoted into round 2 and dispatched.

**Neither agent could have caught this.** The D01 fixer was scoped to D01 and
was right not to wander; the D05 verifier had no way to know a protocol bump
was coming. It is visible only from above, holding both. That is an argument
for the orchestrator re-reading the whole queue after each fix lands, not just
the entry that changed — and for `FIXER.md` to ask what a fix *enables* as
well as what it repairs.


---

## Round 2 closed — verified on the merged tree

All five fixer branches merged, then verified together on a quiet box. A fix
green in its own worktree says nothing about the five together, which is why
this run exists.

```
pnpm build          clean
pnpm test           90 files, 953 tests, 0 failures
                    3 ignored 'onTaskUpdate' worker errors (ci/test.mjs filter)
citybake --check    exit 0 — 1182 blocks, 4014 buildings, 29 landmarks, 66 shops
                    6 warnings, every one pinned by name in shippedCity.test.ts
pnpm parity         host parity OK — seed=7 ticks=600 samples=20, hash 4007836798
```

Ground truth moved 87 files / 943 tests -> **90 / 953**; the ten added tests are
the round's own. The city moved 1156 blocks / 4066 buildings -> 1182 / 4014,
which is A03's restored cross streets.

**On the parity hash.** The sim fixer's worktree reported `437625668`; the
merged tree reports `4007836798`. Expected: the worldgen rebake changed the
map, so the simulation runs over different ground. Parity asserts the two
hosts agree with each other tick for tick, not that a hash is constant.

**`pnpm parity` needs a vite dev server on 5173** and dies
`ERR_CONNECTION_REFUSED` without one. A harness prerequisite, not a
regression — but it cost a diagnosis here and is worth a line in the script.

### Fixed this round

| id | what |
| --- | --- |
| R1-A01 | Kelvin Bridge built, and a bridging gate that found four more broken crossings |
| R1-A03 | the contour frame fallback, fixed at the cause rather than at The Docks |
| R1-C01 | pursuit stays motorised; abandoned cruisers retired, with provenance |
| R1-C03 | 13 unpinned trig calls across 5 files, plus a source gate |
| R1-D01 | a reloaded client resumes its input numbering from the server |
| R1-D03 | the deploy names the commit the suite passed |
| R1-D05 | a protocol rejection stops retrying; `full` untouched |
| R1-D06 | the health check accepts 2xx only |

### Open, ranked for round 3

1. **The three escalations** below — decisions, not code.
2. **R1-D02**, and it grew: the rebake changed the city again, so more than
   thirteen of the fifteen checkable PNGs are now stale. Retake *after* the
   escalations land. Second time sequencing has mattered.
3. **R1-C06** (significant) — ambient traffic mints a driver record for a
   cruiser and steers it while `drivePursuit` drives it in the same tick.
4. **R1-B01** — never verified; its verifier had not returned when round 1
   closed. Verify before fixing.
5. **Coast Road** — three uncrossed stretches the gate found and no lens filed.
6. The nits: A05, A06, A08, B04, B05, C05, C07, D07.

### The escalations, for the author

| what | the change | measured consequence |
| --- | --- | --- |
| the Ring's east crossing | `maxBridgeSpan: 72 -> 76` | misses by 1-3 tiles; restores the deck (1496 -> 2078) and gives **nothing else in the city** a deck |
| Marsh Causeway | reroute to the narrows at x=600 | 62 tiles against a 93-100 tile bay on the drawn line; works (deck -> 1742, 0 errors) but moves where a named causeway meets both banks |
| Coast Road | its own finding first | the coastline warp moved the south shore inland of the drawn course; 169 + 79 + 22 tiles |

Once these land, promote the gate from `warning` to `error`. A
warning-not-error decision is the kind that quietly never gets promoted, so it
is written down here rather than remembered.


---

## Round 3

### Fixed

| id | what | measured |
| --- | --- | --- |
| R1-B04 | `renderer.info.autoReset` off, reset at the top of `render()` so counts span shadow map, scene and every post pass | `draws 1 tris 0k` -> `draws 238 tris 7031k` |
| R1-B05 | scenery shortens `mesh.count`/`outline.count` to `used`, matching its two neighbours; the placement guard moves to a stored `capacity` because the draw length is no longer safe to guard against | prop instances per frame **768 -> 56** |
| R1-D07 | the sqlite branch names a sibling `.json` it will not read, and says which env var would read it | test fails without the fix |

**`3D.md`'s figures were corrected as a knock-on**: the "9 draws / 762k" and
"179 draws / 3.2M" quoted under the table were scene+shadow only, because the
readout they came off could not see the post chain. Fresh numbers run about a
dozen draws higher.

### R1-A05, A06, A08 fixed

**A05 — the botched prior-art check changed the answer.** Round 1's verifier
searched `.claude/review/` instead of the repo root, so "prior art: none found"
was never established. Re-checked properly: `GAPS.md` has nothing, but
`WORLDGEN.md:1007-1009` and `PROGRESS.md:515` **both** state the bake validates
"every landmark with a road within six tiles" — the exact property the error
message claimed. That decided the fix. Had the checker's message merely been
sloppy, correcting the wording would have been right; because it is documented
doctrine, and `checkCity` is the only gate a *generated* city passes
(`city.test.ts` kept the promise for the drawn city alone), the check itself
had to be added. Two accurate messages now: the flood keeps its meaning under
an honest title, and a new `T_ROAD`/`T_BRIDGE` frontage scan over the same
13x13 neighbourhood the suite uses. Shipped city and 12 generated seeds clean.

**A06 — the bounds rule is deliberately weak, and measured before choosing.**
`width < 1` fails, citing `decodeBakedCity`'s own words. But a shape is refused
only when drawn **entirely** off the map, because generated boroughs overhang
the edge by up to 40 tiles on purpose and `The Approaches` sits at -20,-20 on
every seed. An "inside the map" rule — the obvious reading of the finding —
would have broken `plangen` outright. 119 generated plans (40 seeds x 3 sizes)
still parse.

**A08 — the rule is not the naive one.** "Carriageway touching two sides = a
crossing" cries wolf: on plangen seeds 512 and 520 the airfield door is on the
far side, so the bake's own driveway crosses the whole rect and touches street
at both ends. The line that holds: lift the strip's own carriageway out of the
map, flood the rest, and count an opening onto the **largest remaining piece**
as a way in — an opening onto a 12-tile stub is the far end of the same
driveway. Marsh End's taxiway silent, a loop of street across a runway an
error, 12/12 generated cities clean. One documented blind spot: a strip that is
a city's only link reads as a spur.

The huts move by widening each rect over three columns of apron rather than by
moving the strips; both keep a 30-tile run. The centreline jog the round-1
finding predicted is gone and pinned: Marsh End columns 504-506 read 603
against 602 elsewhere, now all 602; Gannet 76-78 read 644 against 643, now all
643.

### R1-C06 fixed — and it uncovered the round's biggest defect

Gated on round 2's `copFleet` register rather than on `isAiDriver`, at two
sites in `traffic.ts`: `stepTraffic`'s mint-and-steer, and the population
cull's **decision** but not its `aiCount++` — moving cruisers out of the
ambient budget would change traffic density, a different change. Every
`isAiDriver` call site was enumerated and ruled on; `tryCarjack` is
deliberately untouched, because jacking an occupied cruiser is the genre verb
and is the live path C01's invariant exists to catch. Excluding it would make
that invariant dead code.

Probe: `tick 17 … : 4` -> `1200 ticks, no cop cruiser ever held an
ambient-traffic driver record`.

**What removing the double-drive exposed.** `stepTraffic` had been integrating
a pursuing cruiser a second time each tick. With one pair of hands on the
wheel a cruiser finally winds up to `copCarSpeed` — and the run-over sweep's
officer loop (`weapons.ts:747`) has no equivalent of the player loop's
`mode !== 'foot'`, while `ride()` parks the officer on their own car's centre.
**Every motorised officer was being run over by the car they were driving**,
dead by tick 41 (health 50 -> 43.5 -> 32.9 -> 10.9 -> 0). C06 cannot land
without the one-line driver exclusion, so it is in this change rather than
filed.

This is the loop catching something across rounds. Round 2's C01 after-numbers
recorded `live officers=6` against a `maxCopsTotal` of **24**, and nobody
questioned it — the fix under test had improved the number it was watching, so
the number it was not watching went unread. The force now runs 23-24.

### R1-C05 — option (b), no behaviour change

The line is rewritten honestly as `cars > cap` with the reasoning in a
comment; `police.test.ts`'s deliberate `cap + 2` assertion and its comment are
untouched. The argument against "fixing" it to `cars + 2 > cap`: that spends
the roadblock pair out of the same budget `motorise` spends, so with
`vehicleCaps.tank = 3` and a five-star wave that turns out two tanks, a
roadblock would need `cars <= 1` — one wave permanently forbidding every
five-star roadblock, which is the armoured roadblock S3 exists for. GTA.md S3
asks only that the city "cannot end up with six tanks in it"; 3 + 2 = 5 < 6,
met as it stands.

### Filed for a later round, not fixed

Carjacking a cruiser with an officer in it spawns a **new** fleeing civilian
ped (`tryCarjack`'s ejection) while the officer separately goes on foot via
C01's invariant — one driver becomes two people. Pre-existing and out of scope
where it was found.

### Refuted: the renderBench suspicion

Round 2's B04 verifier flagged, unverified, that `ci/renderBench.mjs:37-39`
pins **both arms** to `render=2d`. It does — **and that is correct.** The A/B
variable is `&extrude=1`, and `extrude` only touches `TileLayer`
(`main.ts:273`), which never runs under the 3D renderer. The bench answers
SHIP.md U2, a 2D question. The comment at :28-35 is the record of the earlier
fix: before it, both arms defaulted to 3D, were genuinely identical, and
reported a permanently-zero `lastBuildingsDrawn`. Pinning `render=2d` is what
made the two arms differ. Nothing to fix.

That is the second unverified suspicion this loop has generated and then
killed. Worth noting that both came from verifiers speculating past their
brief — useful, but they belong in the queue as suspicions, never as findings.

### The stale base is systematic, not incidental — and it supersedes what this file said about it first

**Every worktree in this project is cut from `1469611`, the original `main`
merge.** Verified across all eight created in rounds 2 and 3:

```
a135733d a3252439 a666958f a6f80c5f
a89c873f a8a6aa0e ab1f2dda ad21c1da   -> all base=1469611
```

Worktree isolation cuts from the merge-base, not the branch head. That is a
property of the tool, not a mistake any agent made.

**What it means for rounds 2 and 3.** Every fixer's own "green" was run
against a tree missing all the others' work — including its own round's
siblings. Their code merged cleanly only because the partitions really were
disjoint. Two agents came close to the edge: the sim fixer needed C01's
round-2 code, found it absent and fast-forwarded itself; the B01 fixer refused
to start at all.

**Why nothing was silently wrong.** The rule already written here —
*the combined run is authoritative, a fixer's own green never is* — is the
only reason. Round 2's real verification (90 files, 953 tests, parity OK) ran
in the main checkout with everything merged. Had that backstop not existed,
three rounds of void verification would have read exactly like three rounds of
passing verification.

**It also re-explains an earlier entry.** The note above about fixers racing
on `REVIEW-QUEUE.md` is right as policy but wrong on mechanism: the round-2
D03 fixer could not find the file in its worktree because `0172a8e` — the
commit that added it — was not in its stale base. Keep the policy; correct the
diagnosis.

**The rule from here**: every worktree dispatch begins with an explicit
`git fetch origin <branch> && git reset --hard <named sha>`, and the agent
states the post-reset commit in its report. Pin a sha, never "latest" — the
branch head moves while an agent works, as the B01 fixer observed it doing
three times in one sitting.

### The earlier, narrower version of this lesson (kept for the record)

The renderer worktree was cut from **`1469611`, the original `main` merge** —
before round 1 — while the other two round-3 worktrees were correctly based on
round 2's head. Its code merged cleanly (rounds 1-2 touched none of
`scenery.ts`, `cityView.ts`, `createStore.ts`), but **its verification was
void**: it ran the suite and `citybake --check` against a tree with none of
this work in it, and reported the round-1 city (1156 blocks / 4066 buildings)
as if current. Its triangle measurements were taken on the old map.

Caught only because a bake statistic in its report did not match the branch.

**It happened to two of the three.** The sim worktree was cut from `1469611`
as well — but that agent noticed on its own and fast-forwarded to `42c5cb0`
before starting, because C06 sits directly on C01's round-2 work and it went
looking for it. The renderer agent had no such dependency to trip over, so
nothing prompted it to check. That is the tell: a stale base is invisible
unless something you need is missing from it.

So, for round 4 onward: **every worktree agent states its base commit in its
first report, and the orchestrator re-verifies on the merged tree regardless.**
The second half of that rule already existed and is what makes this survivable
— the combined run is authoritative, a fixer's own green never is.

This is the same lesson a third time: build artifacts, then shared queue
state, now the base commit itself. **Isolation has to cover everything two
agents can both write — and every input either one can read.**


---

## Queue reconciliation, after round 3

The status lines had drifted: fixes were recorded in each round's prose section
but nine entries still read `[ ] open`. Corrected above. **The loop's memory is
only as good as the field you can count** — a narrative that says "fixed" and a
status field that says "open" is worse than either alone, because the tally
lies while reading correct.

### Genuinely open, confirmed, never dispatched

| id | severity | note |
| --- | --- | --- |
| R1-C02 | significant | `noticedBy` — a corpse witnesses crimes, an invisible player is seen. Confirmed round 1, never fixed. |
| R1-C04 | significant | the car bomb is free arson, credited to nobody. Confirmed round 1, never fixed. |
| R1-A02 | significant | Hollis Creek crossed nowhere. Confirmed round 1, never fixed. |
| R1-D02 | significant | the stale evidence PNGs — now staler, three rebakes later. |
| R1-C07 | nit | the trig gate stops at `shared/src/sim`; `shared/src/world` has ~90 unpinned calls. Needs a worldgen decision. |
| *(new)* | — | carjacking an occupied cruiser makes one driver into two people. Filed by the C06 fixer. |

### Closed without a fix

- **R1-B03** — won't fix, working as designed (your decision).
- **R1-A04**, **R1-D04** — refuted as filed; both residuals refiled and now fixed
  (A08, D07).
- **the renderBench suspicion** — refuted; the instrument is correct.

### R1-B01 fixed — and both earlier diagnoses were wrong

The filing blamed the day floor. Round 3's verifier blamed "the bloom". Neither
was the mechanism.

`UnrealBloomPass`'s high pass **emits the whole texel it admits, not the
excess**, so a surface 2% over threshold glows as hard as a source 2000% over —
and `BLOOM_THRESHOLD` was an **absolute** 1.05 while the rig swings its key
light **4.75x** across the day. At noon, sunlit art clears an absolute
threshold on its own.

Fix: the threshold becomes a ratio — 1.05 *per unit of key light* — with
`CityView` handing `PostChain` the sum of the three intensities it has just
written, so retuning the rig cannot leave the threshold behind. ~10 lines, two
files.

**Why this is a framing and not a fudge factor**: sweeping the absolute
threshold puts the halo's collapse at 5.0, and the key-light ratio predicts
**4.99**.

The other two routes were killed by measurement, not argument. Cutting the day
floor needs it at **exactly 0.00** — 0.06, the headlight's own floor, still
leaves a halo of 67 — and zero contradicts `lights3d.test.ts`'s assertion that
the lamps are still on their posts at midday. Selective bloom would need a
second full scene render: in three@0.185.1 `layers.test` is only evaluated
against the camera, never per object.

Measured: midday (40,450) **129 -> 3** against a lights-off control of 4.
Night unchanged **by construction** — the key light sums to exactly 1.00 at
midnight, so the threshold is still 1.05 — and verified against a noise floor,
which is the part worth copying: **290** pixels differ by >25 luma between
builds at night, against **411** between two runs of the *same* build. The
change is smaller than the noise, and the noise was identified (lamp flicker on
wall-clock, plus a random HUD guest name).

Both renderers stayed in step by not being touched: `lights3d.ts:361` and
`renderer.ts:503` still carry `0.15 + 0.85 * night` character for character.
The change lives entirely in the 3D post chain, which has no 2D counterpart.

Stated trade, in the code comment: at midday a source must now be brighter than
a sunlit white surface to bloom.

### Filed by the B01 fixer, for a later round

The headlight floor was cut to 0.06 **because of this same bloom mechanism** —
aimed at the same wrong lever this finding was. With the threshold now scaled
to the key light, that floor may no longer need to differ from the lamps' 0.15.
Separately, 3D headlights diverge from 2D's, which have no night gating at all
(constant 0.46/0.32/0.7, `renderer.ts:1772-1793`). A real divergence, predating
this finding; reverting is its own measured decision.

### Waiting on the author

The three A01 escalations: the Ring's `maxBridgeSpan` (one number, blast radius
measured at zero), Marsh Causeway's reroute, and Coast Road's own finding.


---

## Round 3 closed — verified on the merged tree

```
pnpm build                       clean
npx tsc -p client --noEmit       clean   (pnpm build is tsc -b server only)
pnpm test                        91 files, 966 tests, 0 failures
                                 5 ignored 'onTaskUpdate' runner-noise errors
citybake --check                 exit 0 — 1182 blocks, 4014 buildings
                                 the 6 pinned bridging warnings, unchanged
pnpm parity                      host parity OK — hash 164516877
```

Ground truth across the exercise: **87 files / 943 tests -> 90 / 953 -> 91 / 966.**

Nine findings fixed this round (A05, A06, A08, B01, B04, B05, C05, C06, D07),
one suspicion refuted (renderBench), and one defect found and fixed that was
never in the queue at all — officers being run over by their own cruisers.

### Round 4 — the findings that were crowded out

Not leftovers: three confirmed `significant` findings with round-1
verification already banked, which no round ever dispatched.

| id | what |
| --- | --- |
| R1-C02 | `noticedBy` skips both its filters — a corpse witnesses crimes, and invisibility cannot stop the cool-down clock |
| R1-C04 | the car bomb is free arson; every casualty is credited to `attackerId = -1` |
| R1-A02 | Hollis Creek is crossed nowhere; both southern arterials dead-end at its banks |

**R1-D02 goes last, in round 5.** Three rebakes have happened since it was
filed, so more than the original thirteen plates are stale. Retaking before the
city stops moving would only have to be redone.

Every round-4 dispatch pins its base sha explicitly and the agent reports the
commit it lands on — established as systematic, not incidental.


## Round 4 — two more corrections to the loop, both found by running it

### The shared stash stack (my instruction caused this)

`refs/stash` lives in the **common** git dir, so every worktree agent shares
one stack. The C02 fixer pushed a stash, popped the **C04 fixer's**
`fittings.ts` + `vehicleDamage.ts` into its own tree, and dropped it; the C04
fixer concurrently popped C02's `police.ts`. Both recovered, both re-stashed
the other's work with a naming message, and the C02 fixer verified its commit
with `git diff --stat` before committing. Nothing was lost.

The cause was **my prompt**: every round-3 and round-4 brief said "if you
suspect your change, stash it and run the baseline". That technique came from
round 2's D05 fixer, where it was correct — one agent, no contention. It does
not survive four concurrent worktrees. `FIXER.md` now forbids `git stash` and
gives the copy-aside recipe instead.

Fourth instance of one class: build artifacts, the queue file, the base
commit, now the stash stack. **"Isolated" worktrees share every ref that lives
in the common git dir.**

### A repro that does not reproduce is not evidence

The round-1 corpse-witness script posts its officer at a hard-coded `+80px`,
which was open ground when written and is **inside a wall** after rounds 2-3
moved the city. It printed `false` on every row — including its own
live-and-visible control.

A fixer trusting it would have concluded the bug was already fixed and closed
R1-C02 without changing a line. The C02 fixer noticed the control was dead,
restaged on a genuinely clear line using the house rule from
`shared/test/helpers.ts`, and reproduced the round-1 numbers exactly.

**Always confirm the control first**; a dead control means the instrument is
broken, not the code. `FIXER.md` now says so. This also means every repro
script banked in earlier rounds is suspect after a rebake — they are evidence
of what was true when written, not standing tests.


---

## Round 4 closed — verified on the merged tree

```
pnpm build                       clean
npx tsc -p client --noEmit       clean
pnpm test                        91 files, 970 tests, 0 failures
citybake --check                 exit 0 — 1182 blocks, 4014 buildings, 6 pinned warnings
pnpm parity                      host parity OK — hash 3118957723
```

Ground truth: **87/943 -> 90/953 -> 91/966 -> 91/970.**

All three crowded-out `significant` findings fixed: C02, C04, A02.

**A parity result was nearly accepted on the wrong evidence.** The first run
reported OK, but vite had landed on 5176 because finished agents' dev servers
still held 5173-5175, and `hostParity.mjs` defaults to 5173 — so it had
measured someone else's tree. Re-run against a confirmed-clean 5173
(`host-probe -> 200`) it gives the same hash, so the answer was right; the
evidence for it was not. Same shape as the dead-control lesson: **check what
your instrument is pointed at before believing what it says.**

### What round 4 taught about the round-2 gate

A02's fixer established two limits on the bridging gate round 2 built:

1. **It reads the artifact, not the plan.** With the new plan but the old
   `city.data.ts`, a seventh warning appeared; the rebake removed it.
2. **It could not have found this finding.** Longacre's gap is 4 tiles against
   a road `width: 4`, and the gate only reports a stretch *longer than the road
   is wide*. Narrow gaps are invisible to it.

Recorded because round 3's notes credit that gate with "finding four more
broken crossings" — true, and bounded.

## Round 5 — the evidence refresh, and the convergence test

The city has finally stopped moving, so **R1-D02** can be retaken. Four
rebakes have happened since it was filed (A01, A03, A08, A02), so the original
count of thirteen stale plates is a floor, not a total.

Round 5 also runs the **convergence test** the stopping rules turn on: two
fresh review lenses over the areas this exercise changed most. The question is
not whether they find something — a review always finds something — but
whether they find anything *confirmed and significant*. If they do not, the
loop has converged and the budget should stop.


## Round 5 — the convergence test, and it came back negative

**The loop has not converged.** A fresh lens A, run on `45bfb3b` after four
rounds of review and fixing, returned a **`blocking`** finding.

### R5-A01 — the bake carves respray garages through eight landmarks
- status: [x] **FIXED round 5** — `00b5dca`; quota unchanged at 66, landmark-hosted 8 -> 0        verdict: **CONFIRMED blocking**
- round: 5   severity: **blocking**   lens: A
- where: `amenities.ts:270` (`placeShopsFixed` walks `city.buildings` with no
  landmark filter), called from `bake.ts:855`
- 8 of 66 shops: three POLICE STATIONS (Kelvin Road, Sunridge, Marsh Post),
  three hospitals, and both named towers.
- why blocking, if it holds: a respray is `clearHeat` (`step.ts:246`) — "heat,
  wanted level and the interest of every cop already on the street all go at
  once". The way to end a chase becomes driving into the nearest police
  station.
- mechanism: `stamp()` pushes each landmark's mass into the same `buildings`
  array as the houses and marks it in a `landmarkBuilt` WeakSet — which is
  consulted in exactly **one** place, the block-clearing pass at `bake.ts:528`
  that WORLDGEN.md §30.2 added. `bakeCity`'s last act hands the whole array to
  `placeShopsFixed`, which carves an interior and a two-tile garage door
  through a wall the plan asked to be solid.

### Why four rounds missed it

- `checkCity` has no rule for it.
- `shippedCity.test.ts` **passes**: the doors are on pavement and the entries
  on floor, so gate rule 3 is satisfied.
- `city.test.ts`'s "gives stadiums and power stations an inside, not a slab"
  asserts the *opposite* property, for two of thirteen landmark kinds.
- **It is shipped-city-only.** Plangen seeds 7, 512 and 900 give zero
  landmark-hosted shops. The spray quota relaxes through `minDist`/`minSize`
  until the search reaches the landmark records at the END of `buildings` — so
  no generated-city sweep would ever have found it.

### What this says about the method

My round-1 advice to you was that "loop until the reviewers are happy" never
halts, and that the budget is the real stopping rule. Round 5 is the empirical
confirmation, and it is stronger than the original argument:

- Round 1: 1 blocking. Rounds 2-4: 0 blocking. Round 5: **1 blocking**.
- The yield did not decay. **The same lens, over the same code, with different
  attention, found different things.** Nothing about the first four rounds was
  lazy — round 1's lens A produced six findings, five confirmed, one of which
  was the missing crossings.

So "review until clean" is not reachable by adding rounds. What a round
converges on is *the lens's attention on that pass*, not the code. The honest
stopping rules remain: a fixed budget, a severity floor, and the acceptance
that a review is a sample, not a proof.

The same round also confirms the fixes hold: lens A independently verified
R1-A02, R1-A03 and R1-A08 in the shipped artifact, checked the freshness gate
really binds the committed bytes, and reproduced the six pinned bridging
warnings verbatim.

### Also filed by lens A (nits)

- **R5-A02** — **REFUTED round 6 as filed.** The symptom is real; every causal claim is false. Marsh Post *did* claim a block, and its mass survives its own stamp intact — all 49 tiles `T_BUILDING`. The block fill wrote `T_PARK` and `solid()` overwrote it unconditionally. The park that ships is written **twelve landmarks later by Chapel Green** through the reclaim apron at `bake.ts:542`, whose only guard is `paintable()` — which explicitly permits `T_BUILDING`. Chapel Green's rect plus `APRON = 4`, clipped to the police rect, is exactly the affected tiles. **A fix aimed at `fillRegion` would change nothing.** Count is 18, not 7 — the 7 was accurate for the pre-R5-A01 bytes it audited and stale for the branch it was filed against. Original filing follows:
  7 tiles where the building record says wall and the tile plane says grass, so
  mass and collision disagree over the same ground. `fillRegion` writes through
  the block mask with no `landmarkBuilt` guard; a landmark only gets its plot
  back if it claimed a block, and Marsh Post did not.
- **R5-A03** — five motorboats moored in two ornamental park ponds.
  **FIXED round 7** — `9a4eaab`; landlocked moorings 5 of 460 -> 0 of 460.
  **CONFIRMED round 6.** Every refutation failed: `collide.ts:45` makes
  water-or-bridge exactly what a boat may occupy, so the flood is the right
  medium test and if anything over-connects; re-run 8-connected the ponds stay
  isolated at 86 and 107 tiles with a wholly dry perimeter (`T_SAND:100
  T_PARK:6` / `T_SAND:108 T_PARK:4`); and the boats are live entities —
  `session.ts:353` emits a real `spawnVehicle` for each, boardable from a bank
  within three tiles.
  `placeBoatSpawns` asks for 3x3 of open water and a bank within three tiles,
  and never asks whether that water reaches anywhere. BUGS.md §9.2 established
  no boat is shut in by a bridge — it did not consider a pond.

Lens A also declined to file `pitchX: 0` baking silently to one street, on the
grounds that it is the same shape as R1-A06 whose fix was deliberately scoped
and whose value is legal for parks. That is the prior-art rule working.


## Lens C's convergence pass — three significant, one nit

### R5-C01 — a pedestrian boards a parked police vehicle and both are lost for the session
- status: [x] **FIXED round 7** — `20cb93d`; natural play 3 of 6 seeds -> 0 of 6
- round: 5   severity: significant   lens: C
- where: `traffic.ts:1111`, the boarding scan in `stepBoarding`
- **this is the unfixed half of R1-C06, which this file marked `[x] FIXED round 3`.** C06's own filing named it — "also in range: lets a pedestrian board an abandoned cruiser" — and the round-3 fix went in "at two sites in `traffic.ts`". The boarding scan is a **third** site and was not one of them. I recorded the finding closed without checking every part of it was.
- **the C06 fix made it permanent.** Before the gate, a boarded cruiser was at least driven and culled like any ambient car. Now `stepTraffic` skips it (so `driver.trip` never advances and nobody alights), `retireAbandoned` and `remount` skip it (`driverId !== null`), and the cull counts it against the ambient budget then refuses to remove it.
- measured, natural play, no staging: 4 of 6 seeds froze a **tank** within ten minutes — permanently spending one of three `vehicleCaps.tank` slots that `motorise` counts. The same permanent-budget exhaustion R1-C01 fixed for cruisers, through a door the C06 fix left open.
- repro: `node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 500 natural`
- **verified round 6.** The charge was checked against the original filing rather than taken on trust: `REVIEW-QUEUE.md:244`, unchanged since round 1, reads "also in range: `stepTrafficPopulation:1081-1083` lets a **pedestrian** board an abandoned cruiser … and `:1130-1147` culls cop cruisers at `despawnDist`". The cull half was fixed; the pedestrian half was named, excluded, and marked FIXED.
- **"made it worse" proved by emulation.** `traffic.ts` consults `copFleet` at exactly two places, so running identical staging with the vehicle absent from the register is a faithful pre-C06 emulation:
  ```
  PRE-C06 emulation:   maxTrip=2996  movedPx=138.5  driverIdClearedAt=301
  NOW (copFleet gate): maxTrip=0     movedPx=0.0    driverIdClearedAt=null
  ```
  Before, the cull handed `driverId` back the first tick the player passed `despawnDist`. After, never.
- **stuck confirmed against every writer of `driverId`**: `stepTraffic`, the cull, `retireAbandoned`, `remount`, `tryEnterVehicle` and the alighting sweep all skip it — the last because `trip` is incremented only inside the gated `stepTraffic`. 30000 ticks (16.7 min) with no release. And the pin is exactly the ambient driver id: forcing it back to null makes `retireAbandoned` delete the vehicle on that same tick.
- **the one crack**: `tryCarjack` (`traffic.ts:1462`) has no `copFleet` gate, so a **player** at the door can take it. For a frozen tank that is not an exit, it is free armour.
- **correction, from the tree moving**: natural play now reproduces on **3 of 6 seeds, and a different set** than filed — R5-A01's blocking fix changed worldgen after R5-C01 was written, so `generateCity(6006)` is a different city and the chases evolve differently. Seed 101 boards a **tank** 55 s into unstaged five-star play; still in the same pixel ten minutes later, 5 tanks on the map against `vehicleCaps.tank` of 3.

## The process failure R5-C01 exposes

I marked R1-C06 `[x] FIXED` on a fixer's report without checking that every
part the filing named was covered. The fixer said "at two sites in
`traffic.ts`" and was honest; the filing named three cases; nobody compared
the two lists.

The verify pass guards a finding on the way *in*. Nothing guarded it on the way
*out*. So the rule this needs is the mirror of the one already here: **a
finding may only be closed against its own filing, item by item** — and where
a fixer reports fixing fewer sites than the filing names, that is a partial
close, not a close.

Round 4's queue reconciliation caught statuses that had drifted from reality.
This is the same failure one level down: the status was *right* that work
happened, and wrong about what the work covered.

### R5-C02 — a body on the tarmac stops a car gun's rounds and bursts a rocket
- status: [x] **FIXED round 7** — `a15bc3c`; `copCanBeShot` extracted and asked at all four sites
- round: 5   severity: significant   lens: C
- where: `fittings.ts:163-165`, `projectiles.ts:188-190`
- `fireOnce` skips downed officers on purpose (`weapons.ts:165`, "shoot through a body, not into it"). `fireCarGuns` and `nearestHitAlong` do not: they select the corpse as the hit, and `damageCop` then returns immediately on `copIsDown` — the round is absorbed, for the 40 s the body lies there.
- measured: car guns 9 damage clear line -> **0** with a corpse at 60px; rocket 107.5 -> **32.5**. SMG unaffected (control).
- these are the five- and six-star weapons, used exactly when the street is full of officers you just killed. Your own kills become cover for the wave behind them.
- prior art: R1-C02 fixed the same "a body is not a live officer" mistake in `noticedBy` and **did not sweep the hit tests**. Third instance of that class.
- **verified round 6.** The "a rocket is contact-fused, a corpse is a physical object" defence predicts a standing *living* person fuses it too. It does not:
  ```
  blocker=none      cargun 9  reach 100   rocket 107.5
  blocker=livePed   cargun 0  reach  40   rocket 107.5   <- transparent
  blocker=deadCop   cargun 0  reach  40   rocket  32.5
  blocker=liveCop   cargun 0  reach  40   rocket  32.5
  ```
  So the implemented rule is not "physical bodies fuse rockets" but "anything still in `state.cops`, alive or dead" — the missing `copIsDown`, not physics. No split verdict.
- **the detail that settles intent**: `fireCarGuns` applies the rule to *pedestrian* corpses eight lines below where it misses it for officers — `if (!ped || ped.mode === 'dead') continue; // a body does not stop a bullet`. One function, one screenful, one oversight. `nearestHitAlong`'s doc comment claims a parity it does not have.
- `damageCop` absorbs the round at `weapons.ts:345`, the first statement in the function; `git log -L` shows the `fittings.ts` cop loop unchanged since the file was introduced, so nothing made corpses collidable on purpose.

### R5-C03 — the ambient cull leaks a permanent driverless car every time it fires
- status: [x] **FIXED round 7** — `20cb93d`; both leak paths, one sweep
- round: 5   severity: significant   lens: C
- where: `traffic.ts:1189` against `putAiVehicle` at `:1314`
- the cull writes `driverId = null` with the comment "becomes an ordinary parked car, then is reused", and `putAiVehicle` mints a brand-new entity instead. Nothing in `shared/src` removes an intact driverless non-police vehicle. The one reuse channel needs a ped within 40 px, and a culled car is by construction 1100 px from every player.
- measured over 20 minutes of one player driving: vehicles 193 -> 286 (**+48%**), sim cost 2299 -> 4107 ms/1000 ticks (**+79%**), still climbing.
- prior art: R1-C01 fixed this exact shape for cruisers and built `retireAbandoned`; the ambient fleet has no equivalent.

### R5-C04 — `police.json`'s `hard` preset sets `carsFromStar: 2`, and no car appears at two stars
- status: [-] **REFUTED round 6**
- round: 5   severity: ~~nit~~ —   lens: C
- the narrow observation reproduces: no unit *arrives* motorised at two stars, because `waves["2"]` is `vehicle: null` and no preset overrides `waves`. But the conclusion is wrong.
- **`remount`'s gate is live at exactly two stars** (`police.ts:1189-1193`), and the two presets differ there. Controlled probe — same seed, same tick, same natural dismount, only the preset changed:
  ```
  hard   (carsFromStar=2): at 2 stars, back in the cruiser? YES at tick 0
  normal (carsFromStar=3): at 2 stars, back in the cruiser? no (300 ticks)
  ```
  A cruiser under a two-star posse on hard and not on normal — the motorised response starting one star earlier, which is what the key names.
- the reachable path is ordinary play: heat decaying 3 -> 2 while an officer stands beside the cruiser he stepped out of, which `retireAbandoned` preserves on purpose ("A car with an officer walking back to it (see `remount`) is kept").
- the finding's other claim is right but immaterial — `waveUnits`' fallback is unreachable in shipped data. That leaves **one** live reader, not zero. It mistook "no car spawns at two stars" for "the key moves nothing".
- **note**: `remount` is round 3's C01 fix. This key may well have been much closer to dead before this exercise started.

### What lens C checked and did not file

Determinism (no wall-clock or `Math.random` in `shared/src/sim`; every `Object.keys`
walk over integer keys; `cloneState` covers all four side tables); the trust
boundary (`sanitizeIntent`, `viewTick` re-clamped in `rewoundWorld`, one intent per
tick, `buy` fully server-validated); physics (half-tile sub-stepping, no tunnelling
at any tuned speed); **R1-C01 and R1-C06 re-verified under 9000-tick five-star
chases on four seeds with per-tick invariants — zero violations**; `pnpm bots` and
`pnpm chase` as documented.

## A fifth shared-state instance, and this one is mine

`b3f4e67` — my own commit — swept lens C's in-progress repro scripts into the
tree, because I ran `git add -A` in the main checkout while the convergence
reviewers were still writing there. I dispatched them **without** worktree
isolation deliberately, so they would read the real tree; the cost is that they
share the working directory with the orchestrator.

Harmless here (evidence files committed early). But the list is now: build
artifacts, the queue file, the base commit, the stash stack, and the working
directory itself. **Every one was a thing two agents could both touch that
neither was told about.**


### R5-A01 verified, then fixed

The verification did the thing worth copying: it **priced the fix before
anyone attempted it.** Re-running `placeShopsFixed` with the 14 landmark
masses removed still filled the whole quota — 66 shops, identical
distribution — so "we would have to rebalance the shop quota" was settled as a
non-issue before a fixer could spend a round discovering it.

It also made the finding worse than filed: spray is a `drivethrough` with
`reach = DOORWAY_RADIUS_PX * 2`, so **the buy succeeds from the road tile
outside**. You need not enter the police station at all. And the three clinic
doors are byte-identical to three spray doors, breaking an invariant
`amenities.ts:1163` states about itself — "A clinic has no room you can walk
into: the ward is solid."

Two prose claims were corrected and neither touched the mechanism: the towers
are 3-4 storeys, not sheds; and the vector layer *shows* the carved room
rather than hiding it, because `extrude.ts:83` refuses to mass any building
containing `T_FLOOR`.

**The fix**: `landmarkBuilt` threaded as a **required** parameter, so no
future caller can silently omit it — the failure mode that created this bug.
Both a `checkCity` rule and a `city.test.ts` assertion, because they gate
different artifacts: `checkCity` gates what the bake may write and holds a
generated city to the rule; the test asserts over the shipped bytes the game
loads. A rule in only one would have passed forever while the bug shipped —
which is how it survived four rounds. Both were confirmed to fire against the
pre-fix bake before being trusted.

### R5-A04 — filed by the fixer, not fixed: a park's paint overruns Marsh Post

- status: [x] **FIXED round 7** — `9a4eaab`; landmarks affected 1 of 29 -> 0 of 29. Closes R5-A02's symptom too.
- 11 `floor -> park` tiles in the fix's plane diff turned out to be
  **pre-existing and merely unmasked**: a park's ground paint overruns three
  columns of Marsh Post's stamped footprint, and the illegal shop carve had
  been painting `T_FLOOR` back over two of them. Marsh Post now draws as a
  four-tile-wide building inside a seven-tile landmark rect.
- Nothing in `checkCity` asks whether a landmark's own mass survived the
  ground passes.
- **CONFIRMED round 6, and it is the correct attribution.** Every number checks
  against the shipped bytes: columns 540-542 x rows 549-554 all `T_PARK`;
  pre-fix `{FLOOR:27, PARK:7}` -> post-fix `{PARK:18}`, so 11 unmasked; two of
  the three columns had been `T_FLOOR`; Marsh Post draws 4 tiles wide in a
  7-tile rect.
- **One defect, not two.** A02 saw the 7 tiles the shop carve left uncovered and
  guessed the wrong pass; A04 saw the other 11 once R5-A01 stopped hiding them,
  and named the right one. Fixing A04 closes A02's symptom entirely.
- **Severity: nit, arguably below where both were filed.** Nothing downstream
  reads the building record for solidity — `collide.ts:67`, `volume.ts:377`,
  `cityGeometry.ts:643`, `extrude.ts:74` all follow the tile plane, so there is
  no wall to walk through: the east third is absent from collision, volume and
  drawing alike, consistently. What remains is bookkeeping (a `Building` record
  over-claiming three columns) plus one cosmetic parallax slab thrown over the
  park by the 2D lean.
- **The keeper**: the bake has no assertion that a landmark's stamped mass is
  still there when the bake ends. An apron guarded only by `paintable()` will do
  this to any landmark standing within four tiles of a later one. Census of all
  29 landmarks: affected = 1. A `checkCity` rule comparing each landmark rect
  against `RECIPES[kind].parts` is the fix, and
  `evidence/round6/V-R5-A02-A04-landmark-mass-census.mjs` already implements it.


## R1-D02 fixed — and the sequencing hazard bit anyway

~30 plates retaken, **three retake commands repaired**, five captions
rewritten, four plates recorded as un-retakeable *with reasons* rather than
left looking current.

**The instrument was calibrated per plate class first**, which is the part to
copy. Two runs of the same command give:

| plate class | same-command noise floor |
| --- | --- |
| `mapgen` / `plangen` crop | **0 px** |
| contact sheet via `ci/shot.mjs` | **0 px** |
| `city3d.html` flyover | 241/2,200,000 = 0.011% |
| live client via `F-R1-B01-shot.mjs` | 141,099/921,600 = **15.31%** |

So a whole-frame percentage means nothing on a live-client plate, which is why
the round-3 R1-B01 set could not be surveyed the same way.

**Three commands were broken, not merely stale.** `plangen-seed500`'s
documented line passes `--seed 500`, but plangen parses `--key=value` only —
it silently drew seed **NaN** into `plangen-seedNaN.png`. `plangen-shore` had
the same fault plus a bare `--crop` that threw before drawing. `airstrip`'s
command draws the whole 1536x1536 map, i.e. the same picture as
`city-anywhere`.

**Four captions described a coastline that no longer exists** — written in
terms of the bevel cutting 45-degree wedges out of a staircase, when the coast
moved onto a curve upstream of the raster and there is no staircase left.

**A third dead instrument, found and repaired.** `fallSheet.ts` held the
throttle while climbing, so the chopper ended 150 ticks downrange over solid
ground, `exitVehicle` found no clear spot beside the hull, the door never
opened, and the sheet flat-lined — reading as "the fall no longer happens".
After the round-1 corpse-witness script and the round-4 parity port, that is
three instruments in two rounds that were confidently reporting nothing.

### The sequencing hazard bit anyway

This entry was deliberately scheduled last, after four rebakes. It still went
stale during its own round, because the R5-A01 blocking fix rebaked the city
**while D02 was running**. Re-surveyed on the merged tree, four plates had
drifted — `city-anywhere` (809 px), `vector-p1-coast` (0.428%),
`city-roadnet` (160 px), `city-lanes` (135 px) — and were retaken; all four
now reproduce at 0 px.

The lesson is not "schedule it later". It is that **an evidence refresh is
only valid against a frozen tree**, and no ordering achieves that while other
work is in flight. If this were a standing job it should run as a gate on the
merge commit, not as a task in a round.

The naive re-survey also flagged four `*-before.png` plates as drifted. They
are deliberately historical and are *supposed* to differ — worth noting because
an automated staleness gate would need that exclusion, or it would cry wolf on
every before-shot in the repo.


---

# Round 5 closed — and the exercise, at five iterations

```
pnpm build                     clean
npx tsc -p client --noEmit     clean
pnpm test                      91 files, 971 tests, 0 failures
citybake --check               exit 0 — 1182 blocks, 4014 buildings, 66 shops
                               6 pinned bridging warnings (escalations, not defects)
pnpm parity                    host parity OK — hash 936946305
                               (verified against a CONFIRMED own server: the first
                                run hit a leftover agent's vite on 5173, the same
                                trap as round 4)
```

**Ground truth: 87 files / 943 tests -> 91 / 971.** 60 commits, 40 source files,
+2410/-136.

## The tally

| | |
| --- | --- |
| fixed | **23** |
| open | 8 |
| refuted as filed | 3 |
| escalated to the author | 3 |
| unverifiable here | 1 |

## Did it converge? No — and that is the result

| round | blocking | what happened |
| --- | --- | --- |
| 1 | 1 | 21 filed, 17 confirmed, 2 refuted, 1 closed by decision |
| 2 | 0 | 8 fixed, 3 escalated |
| 3 | 0 | 9 fixed + a defect found *underneath* a fix |
| 4 | 0 | 3 fixed — the ones the queue's own drift had hidden |
| 5 | **1** | convergence test **negative**: 1 blocking + 3 significant, and R1-C06 reopened |

The yield did not decay. Round 5's lens A was no more diligent than round 1's —
it looked at different things, and one of them was a police station you can
drive into to clear your wanted level. **A review is a sample, not a proof.**

So the round-1 advice holds, for a stronger reason than it was given: the
budget is not a pragmatic compromise against an achievable clean state. There
is no clean state to converge on. The budget is the whole stopping rule, and
the severity floor is what makes stopping safe.

## What the loop found out about itself

Six corrections, every one discovered by running it, none by designing it:

1. **Partition by build artifact, not directory** — every fixer writes shared
   `dist` trees.
2. **Fixers must not write the queue** — four concurrent copies, last write
   wins.
3. **Worktrees are cut from the merge-base, not the head** — all eight, every
   round. Survivable only because the combined run is authoritative.
4. **Never `git stash`** — `refs/stash` is in the common git dir; two fixers
   popped each other's work. *My instruction caused it.*
5. **`git add -A` in the main checkout** sweeps non-isolated reviewers' files.
   *Also mine.*
6. **A dead control is a broken instrument, not a passing test** — three
   instruments in two rounds were confidently reporting nothing: the
   corpse-witness repro (a wall grew where it staged its officer), `fallSheet`
   (the chopper drifted off its own landing site), and `pnpm parity` twice
   (pointed at another agent's server).

Every one is the same shape: **isolation has to cover everything two agents
can both write, and every input either one can read.**

## Still open

- **8 findings**, none blocking: R5-C01 (C06's reopened half), R5-C02, R5-C03,
  R5-A02/A04 (the same Marsh Post defect from two directions), R5-C04, C07,
  and `ci/playLocal.mjs` hanging in `getInCar`.
- **3 escalations** for the author: the Ring's `maxBridgeSpan` (one number,
  blast radius measured at zero), Marsh Causeway's reroute, Coast Road's own
  finding.
- **Then promote the bridging gate from `warning` to `error`.**


## Round 7 — worldgen

**A04: guard the paint, not re-stamp.** `solid()` marks a landmark-mass plane;
`ground()` skips a marked tile. The re-stamp alternative was rejected with a
reason worth keeping: `stamp()` also pushes the `Building` and `Landmark`
records and runs `findDoorway`, so re-running it duplicates records or needs
splitting — and a mass re-laid at the end goes down **over** the kerb ring, the
driveway cut and the tree clearing that every later pass drew around where the
walls stood. Refusing the paint leaves every pass byte-identical except the 18
tiles in dispute.

It also sits one line from the existing `landmarkBuilt` guard, which already
refuses to *demolish* another landmark's records. The two halves of that
promise now agree — the bake would not delete a landmark's record, but would
happily paint over its walls.

**The check**: `checkCity` rule 2b re-derives each landmark's solid parts from
the recipe (`landmarkParts`, newly exported) and errors on any tile the plane
no longer backs; mirrored in `city.test.ts` on the round-5 shop rule's
precedent. Verified against `plangen` so it does not fire on generated cities.

**A03: one flood, not 460.** A border-seeded flood over the water-or-bridge
medium labels the sea once per `placeBoatSpawns`, then each candidate is a
lookup. Border-seeded rather than largest-component because the city is an
island in an ocean running off all four sides, so "connected to the border" *is*
"can get out to sea". **6 ms** against a 16 s bake; a flood per candidate would
have been 13,391. The medium is water-or-bridge because that is exactly what
`plainSolid` permits a boat, so BUGS.md §9.2's bridge guarantee is preserved by
the same test.

The guard sits with `roomy`/`bank` rather than at push time because the scan
yields 557 candidates against a cap of 460 — any change to the list reshuffles
which moorings ship, so there was no minimality to buy by filtering late.

**Both controls confirmed by reverting**: `affected=1` and `5 of 460` reproduce
on the reverted files.

**The census script was intact.** I swept it into a commit while it was being
written (lesson 5, again) and flagged it for checking. It was complete at 58
lines. The risk was real; the outcome was luck, which is the argument for
fixing the process rather than trusting the outcome.


### R7-C05 — `scanAhead` brakes ambient traffic for a corpse in the road
- status: [ ] open        verdict: **CONFIRMED round 8** — nit-to-minor; the refutation died on the file's own adjacent lines
- round: 7   severity: nit   lens: C
- where: `shared/src/sim/traffic.ts:426`
- **the fourth instance of "a body is not a live officer"**, after `anyCopSees`
  (fixed long ago), `noticedBy` (R1-C02, round 4) and the two hit tests
  (R5-C02, round 7). Different question though — physical avoidance rather
  than a ray — so it may well be correct to brake for a body. Verify before
  fixing.
- the C02 fixer read it and correctly left it alone: it is another agent's file
  this round.
- **verified round 8, and the "braking for a body is what a driver does"
  defence failed on the file's own lines.** `scanAhead` folds four obstacle
  sources into one gap; three exclude bodies and one does not:
  ```
  :414  if (!ped || ped.mode === 'dead') continue; // traffic does not queue behind a body
  :422  if (!p || p.mode !== 'foot') continue;     // a dead player is skipped
  :426  for (const id of state.cops.ids) { if (!cop || cop.vehicleId !== null) continue; ...
  ```
  So it was never the "is it a ray?" question. **A dead civilian is driven over;
  a dead officer stops the street.**
- **the contact model already agrees with the pedestrian rule**: `weapons.ts:774`
  means a car cannot strike a downed officer, so `scanAhead` brakes to a full
  stop for something it can no longer collide with — against its own doc comment
  at `traffic.ts:341`: *"The obstacle model has to agree with the contact model
  or the IDM is solving the wrong problem."*
- measured on `e2ae1d6`: `deadCop passTick=1239` against a body removed at 1199,
  so the lane is blocked for the **whole 40 s `corpseSec` window** — nothing
  moves the body — with 3 horns and 3 stuck-recovery reversals. `deadPed` is
  byte-identical to no obstacle at all; `liveCop` is byte-identical to
  `deadCop`, i.e. the driver cannot tell a corpse from a live officer.
- reachable in ordinary play: `ride()` parks a motorised officer on the
  cruiser's centre and `damageCop` clears `vehicleId` on death, so shooting an
  officer in a cruiser leaves the corpse dead-centre in the lane.
- **defect, not an aesthetic call** — not because driving through a corpse is
  self-evidently right, but because the file states that rule for pedestrians
  and players, the run-over code states it for cops, and only this loop does not.

### On the helper, and why four instances justify it

The C02 fix extracts `copCanBeShot` and asks it at **all four** sites, including
`fireOnce`, which was already right. That conversion changes no behaviour and is
the point: three sites had independently got the condition wrong, which is
evidence it is not memorable as an inline expression. The codebase already
argues this about itself — `onTheGround` in `bodies.ts`: *"one predicate, asked
everywhere… so the answer cannot differ between the systems."*

R7-C05 is the fifth site and was found **because** the rule now has a name to
grep for.


## Round 7 — the simulation

### R5-C01 fixed, and the carjack question answered the other way

One line in `stepBoarding`'s scan — the third site of the R1-C06 rule, and the
only one that **writes** rather than declines. Natural play: 3 of 6 seeds
boarding a police vehicle within ten minutes -> **0 of 6 in 18000 ticks**.
Staged budget rows `frozen=2 circulating=12` -> `frozen=0 circulating=14`.

**`tryCarjack` stays ungated**, against the way my brief leaned. The fixer
traced every writer of `driverId` in `shared/src` and established that
`stepBoarding` was the **only** producer of an ai-band driver on a `copFleet`
vehicle. So once C01 is fixed, every `copFleet` vehicle the jack can see has an
officer in it — exactly the live path round 3 kept deliberately. *"Being handed
a free tank was a symptom of the freeze, not of carjacking."* Gating it would
have deleted a genre verb to fix a bug the sibling fix had already removed.

### R5-C03 fixed by provenance, and the measurement that settles it

`state.ambientFleet` — `copFleet`'s twin, sole writer `putAiVehicle`, swept by
`reclaimAmbient` once a registered vehicle is driverless, intact, non-police and
past `despawnDist` (1100 px, well outside the 600 px interest radius, so nothing
blinks out in view). The cull and the alight path end in the same state, so **one
sweep covers both** — which is what round 6's correction required.

Provenance rather than a cap or a recycle, because the kerbside stock is a
*designed* budget: a car a ped borrowed from a kerb must revert to street
furniture rather than be deleted. `tryEnterVehicle` and `tryCarjack` drop the id
the moment a person takes the wheel, so a car the player parked is never eaten.

| | before | after |
| --- | --- | --- |
| 10 min driving | 655 -> 727 (+11.0%) | 655 -> 700 (+6.9%) |
| **player leaves the district** | stays **727** — all 72 permanent | returns to **exactly 655** |
| minted / removed | 78 / 6 | 90 / 45 |
| sim cost at t=600s | 32.5 s/1000 ticks | 28.6 s/1000 ticks |

**Both trees plateau while the player stays local**, so a plateau proves
nothing — the litter simply fills the spawn ring until the 30 px occupancy test
rejects everything. The "player leaves" row is the one that distinguishes a
fixed leak from a full ring, and it is the trap the original repro fell into.

**Two of the four new tests pass both before and after, by design** — "a car the
city parked is demoted, never deleted" and "a car the player took and parked is
never eaten". They are not regression tests for the bug; they guard the *fix*
from going too far, which matters because the obvious implementation would
quietly eat the player's car and the city's designed stock.

### Filed, not fixed

`motorise`'s per-kind budget counts every vehicle of the kind on the map, so the
C03 leak had been silently eating the police allowance too. That connection is
moot now, but the counting rule stays fragile — the same shape as R1-C05's
roadblock arithmetic.


---

## Round 7 closed — verified on the merged tree

```
pnpm build                     clean
npx tsc -p client --noEmit     clean
pnpm test                      91 files, 980 tests, 0 failures
citybake --check               exit 0 — 1182 blocks, 4014 buildings, 6 pinned warnings
pnpm parity                    host parity OK — hash 1180701091
                               (against a confirmed own server on 5175)
```

**Ground truth: 87/943 -> 90/953 -> 91/966 -> 91/970 -> 91/971 -> 91/980.**

Five fixed this round: C01, C02, C03, A03, A04.

### The round's lesson: brief with evidence and constraints, not instructions

**Two of five fixers reached a different conclusion than my brief pointed at,
and both were right.**

- I leaned toward gating `tryCarjack`. The fixer traced every writer of
  `driverId` and showed that once C01 lands, no `copFleet` vehicle can carry a
  civilian driver at all — so gating would have deleted a genre verb to fix a
  symptom the sibling fix had already removed.
- The obvious A04 repair is to re-stamp the landmark. The fixer rejected it
  because a mass re-laid at the end goes down over the kerb ring, the driveway
  cut and the tree clearing that later passes drew *around where the walls
  stood*.

Both briefs gave the verified mechanism, the things that must not break, and an
explicit "argue your choice". Neither gave a patch. That is the shape that
produced better answers than the ones I had.

## Round 8 — what is left

| item | state |
| --- | --- |
| **R1-C07** | ~90 unpinned `Math` trig calls in `shared/src/world`, which `hostParity` runs on both hosts. Flagged in round 3 as needing a worldgen decision, never taken. |
| **`ci/playLocal.mjs` hangs** | hangs in `getInCar`; three evidence plates cannot be retaken. Round 5 could not tell whether it is box-specific. |
| **R7-C05** | `scanAhead` brakes ambient traffic for a corpse — the fifth site of the class, and unverified. May be correct behaviour. |
| **`motorise`'s counting** | counts every vehicle of the kind on the map; fragile, same shape as R1-C05. Filed, not verified. |

Still with the author: the Ring's `maxBridgeSpan`, Marsh Causeway, Coast Road —
and then promote the bridging gate from `warning` to `error`.


## Round 8 — R1-C07, investigated rather than swept

Filed in round 3 as "~90 unpinned calls in `shared/src/world`, needs a worldgen
decision" and left for five rounds. The answer was neither a sweep nor a
closure.

**The escape hatch I offered was wrong.** "Baked offline, shipped as bytes" is
half true, and `generate.ts:41-52` says so: GROUND (tiles, blocks, buildings,
landmarks) is decoded from `city.data.ts`; **FURNITURE** (parked cars, ped
spawns, props, moorings, ramps, turf, packages) is derived **per session from
the seed**, on whatever host is asking — `session.ts:243`, `main.ts:650`
("the whole city regenerates locally from the seed"), `live.ts:127`,
`bot.ts:126`, `run.ts:35`. `hostParity` exercises the path players use.

**Instrumented, not grepped.** Of 97 `Math` calls, **8 execute at runtime**:
`drivableNear`, `bearingCarriageway`, `diagonalRoadDir`, `placeParking`,
`assignTurf`. The other 89 are `plangen` (a drafting tool a human edits the
output of), `citybake` (header: *"runs when somebody edits the plan, never when
somebody plays"*) and the 3D render.

**The defect is not precision loss.**

```
Math.sin(PI) = 1.2246467991473532e-16     dSin(PI) = 0
const rightDot = kerbWest ? Math.sin(a) : -Math.cos(a);
const heading  = rightDot > 0 ? a : a + PI;
```

On an east-west street `a` is exactly `PI`, so that `> 0` test is decided by
**the sign of the residue of pi's own float representation** — which ECMA-262
does not pin. A conforming engine returning 0 or a hair negative parks that car
facing the opposite way, and the heading is hashed. The round-3 fixer's
precision worry was real but aimed at the bake path, which shares no trig site
with the runtime path.

**The gate is a runtime count, not a source scan.** It runs `generateCity` with
`Math` instrumented and asserts zero unpinned calls. A roster goes stale
(FIXER.md's own warning); an import-graph walk over-approximates —
`buildings.ts` *is* in `generate.ts`'s graph and its trig never executes.
Counting can do neither. Two-pass: bare tally on the green path, stack capture
only on failure.

`city.data.ts` byte-identical, parity hash unchanged, and the behavioural
change stated plainly: one parked car per city, in ~3 seeds in 8, now faces the
other way. It was a coin flip before; it is the same coin on every host now.

### Filed separately, low priority

The 89 remaining calls stay unpinned deliberately. The one real exposure left is
`citybake --check` reproducing the committed bake on a **non-V8 CI runner** —
which would fail loudly rather than desync a session, and pinning it means
rebaking the city. That genuinely is the worldgen decision round 3 described.


## Round 8 — `ci/playLocal.mjs` fixed; three plates retakeable again

Un-retakeable for the whole exercise, recorded as such in round 5. **Root cause
is one line and it is not the box.**

`client/src/main.ts:249` — `const wants3d = params.get('render') !== '2d'`. 3D
is the default and a URL that says nothing gets it; `playLocal` never said. So
every attempt since the 3D default landed drove three.js through SwiftShader —
**while passing `extrude=1`, which only the 2D tile layer reads.** The script
was asking for a 2D-renderer feature without asking for the 2D renderer.

| | fps | ms/frame | screenshot |
| --- | --- | --- | --- |
| 3D (what it was getting) | **0.37** | 2712 | 43 s |
| 2D (`?render=2d`) | **57-60** | 17 | 0.2 s |

At 0.37 fps a 240 ms key hold falls entirely between two input samples — that
is the `getInCar` "hang". Round 5's suspect was wrong: `networkidle` arrives in
828 ms, and the 30 s screenshot default was a second-order symptom.

**Not the box's rasteriser**: an empty page and a full-viewport canvas fill both
hold 59.8 fps here, and the 3D rate is unchanged at 1/16 of the pixels.

**Whole run: 35 seconds, three plates, exit 0.**

### The shutter now has a gate

Each scene declares what must be true of `__debug` at the moment of the
screenshot and **throws instead of shooting**. That is round 5's lesson made
mechanical — its run 1 produced a `play-dusk.png` showing the player on foot
with fists. An intermediate version of this fix produced a car *stopped*
against a kerb with skid marks behind it, which is exactly why the drift scene
gates on the car still moving as well as on the decal pool growing.

All three plates were verified against their captions, and two captions were
corrected rather than faked around: the dusk plate's "taxi crossing under
signals" was traffic that happened to be passing on the day, and the drift
plate's `tyre gone` notice was incidental crash damage.

### Filed: the HUD has no street name

`hud.place` is the landmark you are standing in and `hud.district` the borough;
the lines top right are the **kill feed**, and "Kessler Row" / "The Quay" in
them are **gang names**. `evidence/README.md` claimed a street name in two
captions — one fixed here, and the same wrong phrase remains in
`render-3d-client.png`'s caption.


---

## Round 8 closed — verified on the merged tree

```
pnpm build                     clean
npx tsc -p client --noEmit     clean
pnpm test                      91 files, 981 tests, 0 failures
citybake --check               exit 0 — 1182 blocks, 4014 buildings, 6 pinned warnings
pnpm parity                    host parity OK — hash 1180701091, unchanged by C07
                               (against a confirmed own server, probe -> 200)
```

**Ground truth: 87/943 -> 90/953 -> 91/966 -> 91/970 -> 91/971 -> 91/980 -> 91/981.**

Three items closed: **R1-C07** (8 of 97 calls, the pi-residue divergence),
**`ci/playLocal.mjs`** (35 s, three plates, after eight rounds un-retakeable),
**R7-C05 verified** (confirmed, nit-to-minor, unfixed).

### What round 8 says about long-deferred items

All three had sat for rounds, and all three turned out to be smaller and more
tractable than their filings implied:

- **C07** was "~90 unpinned calls, needs a worldgen decision" for five rounds.
  The runtime count is **8**, and the fix is hash-neutral. The "~90" was a grep
  from round 3 that nobody re-counted.
- **playLocal** was "hangs in `getInCar`, probably needs a GPU" for eight
  rounds. It needed one URL parameter.
- **R7-C05** was "may well be correct behaviour". The file already ruled the
  other way, ten lines up.

The common shape: **each was deferred on a plausible reason nobody had
measured.** A grep count, a hardware assumption, a category judgement. All
three collapsed in one round once someone counted, profiled, or read the
adjacent lines.

That is a cheaper failure than a wrong fix, but it is a real one — and it is an
argument for a periodic pass over the *deferred* pile specifically, not just
over the code.

## Round 9 — the convergence sample, on the lenses left alone

Round 5 re-sampled A and C, the lenses with the **most** attention, and still
found a `blocking` defect. Round 9 samples **B and D**, reviewed exactly once
each, in round 1.

If yield tracks attention, these should produce more. If a review is simply a
sample whose draw is independent of prior effort, they will produce about the
same. Either answer is informative about how many rounds this method needs.


## Round 9 — lens D (reviewed once, in round 1)

**3 significant, 2 nits.** The convergence answer for the least-attended lens
is: it still yields.

### R9-D01 — `ci/test.mjs` reports green and exits 0 when its filter matches nothing
- status: [ ] open   severity: significant
- where: `ci/test.mjs:53` (empty-collection guard gated on `filters.length === 0`) and `:62-63` (unconditional green print)
```
node ci/test.mjs nosuchtestfilterxyz  ->  green: 0 files, 0 failures   exit 0
npx vitest run nosuchtestfilterxyz    ->  exit 1
```
The wrapper is **more permissive than the runner it wraps**. Confirmed
independently.
- **This is a defect in this exercise's own instrument.** `REVIEWER.md:25`
  instructs every reviewer to run `node ci/test.mjs <filter>`. A mistyped
  filter, or a test renamed by another lens's fix, answers `green: 0 files` —
  which reads as "verified, the test passes" about a test that no longer
  exists.
- **Exposure, checked**: the filters used in these nine rounds were `noise` and
  `police`, and every recorded result carries a non-zero count (9/9, 10/10,
  59/59, 41/41, 45/45). A no-match run prints `0 files`, which none did. **No
  verification here was fooled** — a close call, not a hit.
- CI itself is unexposed: both workflows call `pnpm test` unfiltered, where the
  `< 50` guard applies.

### R9-D02 — `persistCheck` accuses the server of losing a wallet it did send
- status: [ ] open   severity: significant
- where: `server/src/tools/persistCheck.ts:62-66` — `next()` registers its waiter
  only in the microtask **after** the previous `await` resolves
- the wallet is delivered at 1695 ms and the waiter appears at 1695 ms, the same
  event-loop turn, so it lands before anyone is listening. The server is
  innocent: a full frame trace shows both lives answering `account {ok:true}`
  then `wallet {cash:500}`, 500 before the restart and 500 after.
- 1 of 10 failures on a quiet box, 6 of 10 at load 5.9, **10 of 10** with
  orphans left running.
- **Fourth instrument this exercise has caught lying**, after the
  corpse-witness repro, `fallSheet`, and `pnpm parity` pointed at another
  agent's server. This one is the worst of the four: `README.md:180` publishes
  it as the e2e persistence check and `ROADMAP.md:563` makes it the gate for
  anything touching the economy, and its failure message reads as *the save
  file did not come back*.

### R9-D03 — `README.md` describes a city half the size, with half the boroughs
- status: [ ] open   severity: significant
- `README.md:96-104`, present tense: "384x384 tiles … three boroughs joined by
  four bridges", table listing Port Vasco, Ravenhill, Sunridge.
- Shipped: **768x768**, **six boroughs** (Kelvin, Ravenhill, Sunridge, Marsh
  End, Port Vasco, Gannet Rock), 16 districts, five crossing-named roads.
- `evidence/README.md` describes the real city, so the evidence index and the
  front door disagree about size, borough count and crossing count.
- **Three of this exercise's own findings — R1-A01, R1-A02, R5-A01 — are about
  places the README says the city does not have.**
- `PROGRESS.md:412` records the change the README missed.

### R9-D04 (nit) — a failed `persistCheck` orphans a live 30 Hz server
- `main().catch()` exits without touching its children; `server.kill` is only on
  the happy path. Ten failures took the box from load 1.5 to **8.44**, and the
  failure rate from 1-in-10 to 10-in-10. A positive feedback loop on top of
  R9-D02 — debugging it the obvious way, by running it again, loads your own box
  with every attempt.

### R9-D05 (nit) — `city-anywhere.png` drifts by 72 px
- **and I inferred this wrong.** Seeing lens D retake a dozen plates, I said the
  evidence had gone stale a third time and called it structural. It widened the
  spot-check from three plates to all twelve and **eleven reproduce at 0 px**
  five rebakes on. R1-D02's fix is holding.
- The one drift is 72 px (0.003%), a single 6x12 cluster at Marsh Post from
  round 7's own A04 fix. Round 5's prediction — "an evidence refresh is only
  valid against a frozen tree" — came true at the smallest possible size, not
  the largest.

### Checked and not filed

Reconnect (`maxPlayers` exemption holds; R1-D01 and R1-D05 both still hold);
interest-radius boundary crossings; both persistence backends' `putAccount`
conflict behaviour (differs, but no caller exercises it); the deploy gate
(R1-D03 and R1-D06 still hold). Two unmeasured hunches went to a labelled
**suspicions** section, per the new REVIEWER.md rule — CI never compiles or
bundles the client, and `pnpm parity` is called a gate but runs in no workflow.


## Round 9 — lens B (reviewed once, in round 1)

**2 significant, 1 nit.** Same answer as lens D: a lens left alone still yields
at round-1 severity.

### R9-B01 — the HUD's world-space identity was verified at pitch 0, and the shipped camera is 10 degrees
- status: [x] **FIXED round 10** — `bbbfc11`; worst error 16.14 world px -> 1.026e-12
- where: `renderer.ts:801` (the stated identity), `main.ts:246` (`GAME_PITCH` 10),
  consumers `renderer.ts:815` (`drawNameTags`) and `hud.ts:406-407` (tracers)
- `drawNameTags`'s docstring states the rule the whole HUD layer draws by:
  *"the 3D camera hangs straight down over the middle of the same frame, so a
  point on the ground lands at `world - cam` in either view."* **It does not
  hang straight down.** `REVIEW-3D.md` Part four verified the two frames agree
  *"at pitch 0 with the world tile grid overlaid"*, and the same document's
  later "The camera tilts 10 degrees" entry moved the camera without
  re-verifying it.
```
pitch=10           3D lands at     HUD draws at     error (world px)
 frac 0.05,0.05     44.4  27.7      31.5   18        12.9   9.7
 frac 0.05,0.50     31.5  180       31.5  180         0     0     <- exact
 frac 0.05,0.95     17.3  347.5     31.5  342       -14.2   5.5
```
- the control is exact: the same probe at `pitch=0` prints `0 0` on all fifteen
  rows, so the divergence is entirely the 10 degrees. At the view ceiling it
  reaches 15.8 px.
- **why nine rounds missed it**: the error is exactly 0 at screen centre and
  along the horizontal midline — the local player, where everyone looks, is the
  one place it cannot show.
- aim is **not** affected, checked rather than assumed: `keyboard.ts:138` sends
  an angle from the player's screen position, and the induced angular error at
  the worst corner is 0.3 degrees.

### R9-B02 — in 2D a respray garage and a clinic wear the clothing shop's front
- status: [x] **FIXED round 10** — `bbbfc11`; 31 of 71 shops now wear their own colour
- where: `tiles.ts:2788-2793` (`paintShops`) — the three-way accent falls through
  to `palette.shopClothing`, so `spray` and `clinic` both land on it
- `palette.shopSpray` **exists** and the two sibling paths carry the full
  four-way: `tiles.ts:1826-1833` (`paintShopFloor`) and
  `cityGeometry.ts:570-575` (the 3D accent). Pixels read out of the shipped
  painter: spray and clinic are pixel-identical to clothing —
  **31 of 71 shops, 44%**.
- `BUGS.md` §2.5 rests its whole 3D shop-accent fix on the stated invariant
  *"in 2D the shop's accent colour is how you identify it"* — and in 2D it does
  not identify the most common shop in the city.
- **rhymes with R5-A01**: that made resprays unfindable by carving them into
  police stations; this makes them unidentifiable by painting them blue.

### R9-B03 (nit) — two stale comments are still holding four aircraft heights down
- `spriteMesh.ts:52` says `alpha` is "not honoured here" and `entities.ts:169`
  says `spriteMesh` honours neither — but `spriteMesh.ts:156` is
  `const plate = s.alpha !== undefined && s.alpha < 0.5`, and every `rotorBlur`
  disc is 0.16-0.25, i.e. already drawn as a thin plate. `REVIEW-3D.md` Part
  three records the fix.
- the consequence, not the comment: `Z_BY_SPRITE` pins `heli`/`gunship`/
  `chopper`/`plane` at the bare 1.5 default **because of the drum**, and the
  drum is gone. Four vehicle kinds carry a height decision whose only stated
  reason no longer exists, while every other entry in that table was tuned.

### Confirmed still open

**R1-B02** reproduces unchanged — the 2D night frame carries dozens of window
pools and the 3D none, same seed, hour and camera. Confirmed round 1, never
fixed, still true nine rounds on.

### Checked and not filed

R1-B04 holds (`draws 197 tris 6964k`); signal-head placement is
character-for-character identical between renderers; scenery planting parity
holds; the four `customProgramCacheKey` sharings are safe in the installed
three (the program cache is per material); `?night=0` is not swallowed;
`worldResolutionMult` is right at dpr 1 and 2; the only page error on any
renderer is a favicon 404. Two hunches went to a labelled **suspicions**
section: a shop's interior light is pushed at a constant `alpha: 0.5` with no
`lit` factor (640 cd at noon against the street lamp's 73.5 that R1-B01 was
filed over), and a `lights3d` turnover reading.

## The convergence answer, from two independent samples

| sample | lens | prior attention | result |
| --- | --- | --- | --- |
| round 5 | A, C | most in the exercise | **1 blocking** + 3 significant |
| round 9 | B, D | reviewed once, in round 1 | **5 significant** + 3 nits |

**Yield does not track attention, and it does not decay.** Both samples found
work at the severity the first round found it. A review is a sample; the draw
is roughly independent of how much reviewing came before.

That settles the question the whole exercise was built to answer. Rounds are
not converging on a clean codebase — they are converging on *nothing*, and the
budget is the only stopping rule there was ever going to be.


## Round 10 — the renderer

**B01**: `client/src/render/project.ts` — `projectGround(wx, wy, cam, out)`, one
mapping both renderers ask. Identity branch when no 3D camera is registered or
at pitch 0, so the 2D path cannot move; `CityView` registers its own `pitch`
and `FOV_Y` in its constructor and clears them in `dispose()`, so the HUD and
the camera cannot drift apart the way the comment and `GAME_PITCH` did.

Closed form rather than a matrix round-trip, because `render/` must not pull the
3D renderer in behind it — and exact rather than approximate:
`depth = H - dy·sin p`, `scale = H/depth`,
`screen = centre + (dx·scale, dy·cos p·scale)`, literally the identity at
`p = 0`.

**The proof that 2D did not move is the right one**: the pitch-0 worst error
after the change is `7.944e-15` — *the same number as before, bit for bit*. At
pitch 10, worst error **16.14 world px -> 1.026e-12**; at the 700x400 ceiling,
17.98 -> 2.050e-13.

**The test is built to fail loudly if the premise changes**: five GPU-free
tests, two asserting the identity with `toBe` rather than `toBeCloseTo`, and one
asserting the OLD identity is off by >10 px at pitch 10 — so if the camera is
ever un-tilted, the suite reports that the fix has become dead code instead of
silently passing.

**B02**: `paintShops` gains the four-way its two siblings already carry. **No
clinic colour was invented** — the palette has none, so `clinic` falls through
to `shopSpray` with a comment, which is what the siblings do. The point was to
make three call sites agree, not to add a fourth scheme. Noted for whoever
makes that design call: `minimap.ts:284` and `hud.ts:210,223` already use
`#e06a6a` for clinics, so a candidate exists — but promoting it to the palette
would also touch `cityGeometry.ts` and `mapRender.ts`.

The before picture makes the case unaided: **in the spray cell the awning is the
clothing shop's blue while the threshold square two tiles up, painted by
`paintShopFloor`, is already amber.** The bug contradicted itself inside one
frame.

### Filed by the fixer, not fixed

- **`client/src/debug/overlay.ts:60-89`** uses the same `pos - cam` identity to
  draw hitboxes and the prediction markers, so under 3D it is off by the same
  ~16 px at the frame edge. One line per site now that `projectGround` exists.
- **`server/src/tools/mapRender.ts:737-743`** has the same class with a
  **fourth** scheme — `gun -> shopGun`, `spray -> uiAccent`, everything else
  including `clinic -> shopClothing`. **The offline map render marks clinics as
  clothing shops.** Left alone because it is another fixer's directory this
  round.
