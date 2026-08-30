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

_(pending — the four lenses are running)_
