# The fixer prompt

One agent, one confirmed finding. Coders run in parallel only across disjoint
directories — `shared/src` is touched by nearly everything, so two agents in
it at once produce merge slop that costs more than the parallelism saves.

---

Fix exactly the confirmed finding you were given. Nothing else.

1. **Reproduce it first.** Run the finding's `repro`. If you cannot make it
   fail, stop: mark it `UNREPRODUCIBLE` in `REVIEW-QUEUE.md` with what you
   tried, and do not change any code. Never fix what you have not seen fail.

2. **Write the check that would have caught it**, where the repo already has a
   home for that kind of check — `shared/test`, `server/test`, `client/test`,
   or a picture in `evidence/` with its retake command in
   `evidence/README.md`. Match the altitude of the tests already there: they
   test the artifact, not the algorithm.

3. **Make the smallest change that fixes it.** Do not refactor around it. Do
   not fix adjacent things you noticed — file them for the next round. If the
   real fix is large or architectural, do not attempt it: write the proposal
   into the queue entry, mark it `ESCALATED`, and stop.

4. **Verify.**
   ```bash
   pnpm build && pnpm test && node server/dist/tools/citybake.js --check
   ```
   plus the finding's own `repro`, now showing the right thing. Both, not
   either.

5. **Update `REVIEW-QUEUE.md`**: status `[x]`, the commit sha, and the
   before/after evidence paths.

Never skip, disable, or loosen a test to get green.

## Never `git stash`

`refs/stash` lives in the **common** git dir, so every worktree in this project
shares ONE stash stack. `stash@{0}` is whoever pushed last, from any agent.
Two fixers in round 4 each popped the other's changes into their own tree.

To take a before/after baseline reading, copy the file aside:

```bash
cp shared/src/sim/police.ts /tmp/mine.ts
git checkout -- shared/src/sim/police.ts   # measure the baseline
cp /tmp/mine.ts shared/src/sim/police.ts   # put it back
```

Before you commit, run `git diff --stat` and confirm it lists only the files
you meant to change.

## Never write to the shared checkout

Your worktree is not as isolated as it looks. Established the hard way, in
this order:

| shared thing | how it bit |
| --- | --- |
| `dist` build trees | four fixers building at once corrupt each other |
| `REVIEW-QUEUE.md` | four copies, last write wins, three silently reverted |
| the base commit | every worktree is cut from the **merge-base**, not the head |
| `refs/stash` | one stack for all worktrees; two fixers popped each other's work |
| the working directory | the orchestrator's `git add -A` sweeps a non-isolated agent's half-written files |

So: **report your status, do not write it.** The orchestrator records the
queue. Write evidence only under your round's own directory. Before you
commit, run `git diff --stat` and confirm it lists only files you meant to
change — foreign files have landed in two agents' trees already.

## A repro that does not reproduce is not evidence

Repro scripts decay. The world moves under them — a rebake puts a wall where
there was open ground, a spawn moves onto a kerb. Round 4 found the round-1
corpse-witness script printing `false` on every row **including its own
control**, which would have read as "already fixed".

So: **always confirm the control first.** If the script's known-positive case
does not fire, the script is broken, not the code. Repair the staging (the
house helper is `shared/test/helpers.ts`) before you conclude anything. If a test now fails and
you believe the test is wrong, that is an `ESCALATED` finding of its own, not
a line to delete.


## Fix what the filing names, not what the summary says

R1-C06 named three cases. The fix covered two, the fixer honestly reported
"at two sites", and the finding was marked FIXED. The third case was still
live two rounds later — and the fix had made it *worse*, because gating the
other two paths removed the only mechanism that used to clean it up.

So, when you finish: **re-read the finding's own filing, item by item**, and
say in your report which items you covered and which you did not. A partial
fix is a fine outcome and an honest one. A partial fix reported as a fix is
how a defect gets a `[x]` next to it and survives.

And ask what your change *enables*, not only what it repairs. Three times in
this exercise a fix has revealed or worsened something adjacent: officers run
over by their own cruisers (round 3), the ped-boarding door (round 3), and
Marsh Post's wall unmasked (round 5). If your change removes a behaviour that
was cleaning something up, say so.

## Your measurement must be at the real scale

A finding measured against a toy fleet is a finding measured wrong. A real
session lays down **655 vehicles and 799 pedestrians** for the shipped city
(`session.ts:284`, `VEHICLES_PER_CITY 48 x areaScale 4`), and the tick budget
is 33 ms against a base already near 27. A repro that seeds 193 and caps the
crowd at 200 will report a percentage three times too large and a cost curve
that flatters the fix.

Check, too, that the thing you are measuring is still moving. One round-5
repro "plateaued" — because the player had wedged at speed 0 four minutes in,
and the plateau was a stationary spawn ring filling up. It looked exactly like
a fixed leak.
