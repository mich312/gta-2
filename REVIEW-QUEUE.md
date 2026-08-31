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
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:172-188` (no `copIsDown`, no `POWER_INVISIBLE`, and it calls `hasLineOfSight` directly rather than `copSees`)
- repro: `node evidence/round1/C-repro-corpse-witness.mjs`
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
- status: [ ] open        verdict: **CONFIRMED**
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
- status: [x] **FIXED round 3** — gated on `copFleet`; unmasked and fixed officers being run over by their own cruisers        verdict: CONFIRMED
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/traffic.ts:115` (`isAiDriver(d) => d < -1`) against `police.ts:564` (`copDriverId = -100000 - copId`)
- repro: `node evidence/round1/C-probe-traffic-adopts-cruisers.mjs` — prints `tick 17 cop cruisers with an ambient-traffic driver record: 4`
- what happens: a cop cruiser's `driverId` is negative, so `isAiDriver` is true for it. `stepTraffic` (traffic.ts:892, the `isAiDriver` filter at :896 and the `freshDriver` mint at :906) therefore picks it up, mints a `trafficDrivers` record for it and **drives it**, on top of `drivePursuit` driving it in the same tick (`step.ts:133` then `:151`). `stepTrafficPopulation`'s alighting path can then "park" it — `ejectDriver`, `v.driverId = null` — while the officer's `cop.vehicleId` still points at it. Measured before any of the R1-C01 work: the officer went on ghost-driving a car with no driver.
- also in range: `stepTrafficPopulation:1081-1083` lets a **pedestrian** board an abandoned cruiser (`v.driverId !== null` is the only occupancy test), and `:1130-1147` culls cop cruisers at `despawnDist` as if they were ambient stock.
- the R1-C01 fix adds a one-line invariant in `drivePursuit` (an officer whose car's `driverId` is not theirs is on foot), which stops the ghost-driving. It does **not** stop the traffic AI steering a cruiser mid-pursuit — that needs `isAiDriver` to distinguish the two negative bands, or the police band to be excluded where traffic iterates. Left alone deliberately: it is a traffic change, not a police one, and it is bigger than the finding it was found under.
- prior art: `traffic.ts:59` documents the negative-id convention as the thing that separates AI from players. It does not separate two AIs.

### R1-C07 — the trig gate stops at `shared/src/sim`; `shared/src/world` has ~90 unpinned calls
- status: [ ] open        verdict: **CONFIRMED** (found by the R1-C03 fixer)
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
- status: [ ] open        verdict: **CONFIRMED**, count intact at 13
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
- status: [ ] open        verdict: **CONFIRMED**
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
- status: [ ] open        verdict: **CONFIRMED — but the finding names the wrong lever** (verified round 3)
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

### In flight

- **R1-B01** — fixer running on a pinned base.

### Waiting on the author

The three A01 escalations: the Ring's `maxBridgeSpan` (one number, blast radius
measured at zero), Marsh Causeway's reroute, and Coast Road's own finding.
