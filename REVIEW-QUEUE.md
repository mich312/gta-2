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
- status: [ ] open        verdict: **CONFIRMED**
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
- status: [ ] open        verdict: **CONFIRMED** (the surviving residual of R1-D04)
- round: 1   severity: nit   lens: D
- where: `server/src/economy/createStore.ts:25-36`
- why it matters: README.md:82-87 tells host operators on pre-22.5, flagged 22.5-22.12, or `--without-sqlite` builds that they land on the sibling `.json`. The fallback warns in the `.db` -> `.json` direction; the reverse is silent. Not reachable through Docker, which is why R1-D04 was refuted — but reachable for a documented class of operator.
- prior art: none found.

#### Lens A — worldgen

### R1-A01 — Kelvin Bridge and Marsh Causeway bake to nothing
- status: [ ] open        verdict: **CONFIRMED — blocking upheld**
- round: 1   severity: **blocking**   lens: A
- where: `shared/data/city-plan.json` (both roads); `layout.ts:2298-2356` (no-piers pass); `cityCheck.ts:42` (no rule)
- repro: `node server/dist/tools/mapgen.js --crop=436,336,44 --scale=16 --out=…`
- verified: census re-run independently — BRIDGE=0 at both sites, unbroken water across both channels. Both refutations failed: both roads are `"bridges": true` with author's notes ("The signature span… the shortest way between the two halves of the city"), and WORLDGEN.md:961 names both as strait crossings.
- **worse than filed**: a connected-component enumeration of every deck returns **6 crossings, not 8** — the Ring's east crossing is also absent, so the entire eastern half of the strait has none. Detours measured by BFS: 726 and 984 road tiles against euclidean 121 and 124 (6x and 8x).
- severity checked against REVIEWER.md's ladder: the render shows a four-lane carriageway with a painted centre line ending in a rounded cap on a bare bank. "Geometry the player sees that is plainly wrong" — blocking stands.
- prior art: WORLDGEN.md §23.1 files the deck removal as a FIX and never records that the crossing is gone; §12.3 still claims it.

### R1-A02 — Hollis Creek is crossed nowhere along its length
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: A
- where: `city-plan.json` — The Esplanade and Longacre Road, both `bridges: false`
- verified by counterfactual, which is what settles "deliberate or not": flipping **every** road to `bridges:true` adds 41 bridge tiles in exactly 2 clusters, both on this creek. Seven of the nine `false` roads are inert — they never touch bridgeable water. `bridgeable()` already refuses open water on its own, so the flag does no anti-causeway duty anywhere. And the field's documented rationale (`plan.ts:191`, "which roads are big enough") cannot be why, since every road in the plan is `width: 4`. The split tracks names, not what each course crosses.
- detours re-measured from the shipped bake: 464 and 123 steps (filed: 453 and 124).
- correction: "Hollis appears nowhere in WORLDGEN.md" — "Hollis Farm" is at line 958. Different feature.
- prior art: none. No recorded decision to argue with, just an absence.

### R1-A03 — The Docks' contour fabric lays no cross streets
- status: [ ] open        verdict: **CONFIRMED — and root-caused**
- round: 1   severity: significant   lens: A
- where: `layout.ts:1625` (contour cross streets) and `layout.ts:1273` (`frameDeg` PCA)
- **the reviewer found the symptom; the verifier found the cause.** `frameDeg`'s PCA samples only tiles with `bandField <= 2`. The Docks' banding shore is on its **east** side, so the true mean tangent is 90 degrees — but the nearest owned dry tile is 9 away, nothing matches, `n === 0`, and it silently falls back to the authored `angle: 0`. The cross streets are carved **parallel to the bands they were meant to cross**.
- causal test, forcing only `frameDeg = 90` and changing nothing else:
  `baseline: 12 blocks, median 1691, biggest 27x158` -> `forced: 51 blocks, median 330, biggest 28x22`
  28x22 is the authored 28x24 cell. The pitch is honoured everywhere and silently dropped here.
- **latent beyond this district**: Terraces and Beachfront take the same fallback and survive only because their shore is horizontal, so `angle: 0` happens to equal the true tangent. Any future borough on a non-horizontal shore inherits the bug.
- prior art: none found.

### R1-A04 — known: a public street still crosses Marsh End Airfield's runway
- status: [-] refuted        verdict: **REFUTED as filed**
- round: 1   severity: ~~significant~~ —   lens: A
- the tile identity is right — 14 genuine `T_ROAD` inside the rect, no `T_LOT` apron anywhere in it. But the **promotion warrant is not**: the reviewer quoted past a caveat. `PLAN-WORLDGEN.md:111` says "DELIVERED — **see PROGRESS.md**" one clause before the sentence quoted, and `PROGRESS.md:277` reads: "the one crossing that remains at Marsh End is the bake's own two-tile access driveway to the hangar, which is a taxiway with a job."
- mechanism confirmed independently: `bake.ts:546` cuts a driveway from every non-`byAir` landmark door; Marsh End's baked door is tile (519,606), immediately south of the stub's last road tile. The stub dead-ends at the rect's south edge into bare field — an access track, not a through route. The render shows a band with no kerb casing, no centre dashes, no ribbon stroke.
- the census confirms the note's diagnosis rather than disproving it. Residuals refiled as R1-A08.

### R1-A05 — `checkCity`'s "has no road to it" does not look for a road
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: nit   lens: A
- verified: `drivable()` is genuinely the sim's own rule (`plainSolid`, `collide.ts:44`, blocks the same three tiles), so the *predicate* is defensible — a landmark reachable across a car park really is vehicle-reachable. What it does not defend is the *message*, or `city.test.ts:170`, which scans for real `T_ROAD`/`T_BRIDGE` frontage. The suite is strictly stronger than the checker whose error string claims the same property.
- repro reproduced: 285 carriageway tiles erased around Mercy General, `checkCity` returns `[]`.
- trimmed: "walling a hospital off from the street network" overstates it — nothing genuinely unreachable ships.
- **prior art UNVERIFIED**: the verifier searched for `GAPS.md` inside `.claude/review/` instead of the repo root. Cheap to re-check in round 2.

### R1-A06 — `parseCityPlan` bounds-checks landmarks but not roads, rivers or districts
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: nit   lens: A
- **sharper than filed**: the width-0 road becomes a course that `decodeBakedCity` explicitly rejects — `bake.ts:1137`, `'a course with no line or no width'`. The parser waves through a value its own asset decoder calls malformed, one pipeline stage and fifteen seconds later.
- also accepted, unfiled by the reviewer: **negative** widths, identically.
- off-map geometry clips safely everywhere (`lay()`, `onGround`, `pointInPoly`), so the harm is silence, not corruption. Nit is right.
- **do not merge with A01**: A01's landfall gate would catch an off-map endpoint on a bridging road, but the zero-width road is entirely on land and passes it untouched, and off-map rivers and district polygons never reach a bridge gate. Two fixes.

### R1-A08 — wave 2.3 stands DELIVERED with two promises unkept
- status: [ ] open        verdict: **CONFIRMED** (the surviving residual of A04)
- round: 1   severity: nit   lens: A
- the promised `cityCheck` rule — no street tile inside a runway rect — does not exist; `city.test.ts:743` asserts only the converse (every `T_RUNWAY` tile is inside a rect). And the huts were never moved off the slabs: 9 `T_BUILDING` tiles at each strip's corner with runway on all sides beneath them.
- side effect confirmed: `runwayCentreRow` (`tiles.ts:159`) walks per column, so the hut-shortened columns jog the centreline — at Marsh End x=507, and at **Gannet x=79**, which the reviewer missed.

#### Lens B — the renderer

### R1-B01 — street lamps and shop signs burn at midday in 3D
- status: [ ] open        verdict: pending (verifier still running at round close)
- round: 1   severity: significant   lens: B
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
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: nit   lens: B
- verified in the installed three@0.185.1: `info.reset()` at `three.module.js:17696` with `autoReset` defaulting true, and zero `autoReset` hits anywhere in the repo. The composer's last pass is the grade quad, so its 1 draw / 2 triangles is all that survives.
- **the refutation failed**: `3D.md:179`'s "9 draw calls, 57,767 instances, 762k triangles" is quoted verbatim from this HUD — the cited screenshot's overlay reads exactly those numbers. `ci/renderBench.mjs` is not an alternative source: it has no draw/triangle instrument at all.
- **round-2 candidate, unverified**: `ci/renderBench.mjs:37-39` reportedly has *both arms pinned to `render=2d`*. REVIEW-3D.md records fixing this same instrument for "comparing 3D against 3D". Nobody tested whether the current state is deliberate.

### R1-B05 — scenery prop pools still zero-scale their tails
- status: [ ] open        verdict: **CONFIRMED**
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
