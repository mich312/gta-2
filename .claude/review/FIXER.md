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

Never skip, disable, or loosen a test to get green. If a test now fails and
you believe the test is wrong, that is an `ESCALATED` finding of its own, not
a line to delete.
