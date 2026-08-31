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
