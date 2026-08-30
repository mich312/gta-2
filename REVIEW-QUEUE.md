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
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:678`, `:747`, `:1110`, `motorise` at `:573-593`
- repro: `node evidence/round1/C-repro-copcars.mjs 4 240 mortal`
- prior art: PROGRESS.md "Police pursuit driving" claims this fixed — filed as a promotion

### R1-C02 — `noticedBy` skips both its filters: a corpse witnesses crimes, an invisible player is seen
- status: [ ] open        verdict: **CONFIRMED**
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:172-188` (no `copIsDown`, no `POWER_INVISIBLE`, and it calls `hasLineOfSight` directly rather than `copSees`)
- repro: `node evidence/round1/C-repro-corpse-witness.mjs`
- verified: independent probe brackets it at 20px (noise), 80px (sight), 5000px (neither). Single caller `weapons.ts:271` does not filter. `node ci/test.mjs noise` passes 9/9 with the bug present — the suite is blind to it. `peds.json` `corpseSec: 40` makes the window 40s.
- prior art: none. `police.ts:55` records the identical bug fixed in `anyCopSees` fifteen lines above.

### R1-C03 — `Math.atan2`/`Math.hypot` in shared sim code, writing hashed fields
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/weapons.ts:361-363`, `traffic.ts:1397`, `police.ts:480`, `:778`
- repro: `node evidence/round1/C-repro-math-trig.mjs`
- prior art: WORLDGEN.md §41.5 fixed this class in worldgen; the sweep never covered `shared/src/sim`

### R1-C04 — the car bomb is free arson, and its casualties are credited to nobody
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/fittings.ts:54-58` (bypasses `damageVehicle`, so `igniterId` never set)
- repro: `node evidence/round1/C-repro-carbomb.mjs`
- prior art: GAPS.md K1 built arson attribution; the bomb branch was never threaded into it

### R1-C05 — `maybeRoadblock`'s per-kind budget is algebraically a no-op
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: C
- where: `shared/src/sim/police.ts:775` — the `+ 2` appears on both sides and cancels
- repro: `node evidence/round1/C-repro-roadblock-cap.mjs`
- prior art: GTA.md P3c states the intent; the defect in the check is recorded nowhere

#### Lens D — the seams

### R1-D01 — a page reload reconnects the player to a body they cannot move
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: D
- where: `server/src/session.ts:422`, `:475` against `client/src/main.ts:303` (`let seq = 1`)
- repro: `node evidence/round1/D-repro-resume-input.mjs`
- prior art: BUGS.md §11.1 and §11.4 cover other halves of resume, not the sequence watermark

### R1-D02 — the published evidence no longer reproduces from its own retake commands
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: D
- where: `evidence/README.md` and 13 of the 15 checkable PNGs it indexes
- repro: `node evidence/round1/D-pngdiff.mjs evidence/<name>.png <retake>`
- prior art: none. REVIEW-WORLDGEN.md:6 states the invariant this violates.

### R1-D03 — `ci/deploy.sh` ships whatever `origin/main` is, not the commit the suite passed
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: D
- where: `ci/deploy.sh:30-32` against the `test` job in `.github/workflows/deploy.yml`
- repro: read the two files together (no execution possible — the deploy host is unreachable)
- prior art: PLAN-WORLDGEN.md wave 0.4 closed the workflow gate, not the checkout

### R1-D04 — a Node build that gains `node:sqlite` silently abandons the JSON fallback's accounts
- status: [ ] open        verdict: pending
- round: 1   severity: significant   lens: D
- where: `server/src/economy/createStore.ts:25-26`
- repro: `node evidence/round1/D-repro-backend-swap.mjs`
- prior art: none. `createStore.test.ts` never boots twice at one path with availability changing.

### R1-D05 — a client rejected for protocol mismatch reconnects every two seconds for ever
- status: [ ] open        verdict: pending
- round: 1   severity: nit   lens: D
- where: `client/src/net/connection.ts:75-81` against `client/src/main.ts:682-687`
- prior art: none. BUGS.md §11 covers the server's side, not the client's retry policy.

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
