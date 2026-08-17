// The suite, run through vitest's node API so the exit code can tell a
// failing test from the runner's own starvation noise.
//
// On any box where a worker's synchronous stretch (a 20-second bakeCity,
// slowed further under CPU contention) outlives vitest's 60-second worker
// RPC timeout, the worker wakes to find its own timeout timer ahead of the
// reply already sitting in its queue, and vitest records an unhandled
// `[vitest-worker]: Timeout calling "onTaskUpdate"` error — then exits 1
// with every test passed. CI's 4-core runner and the dev containers both
// do this routinely (PROGRESS.md, the 3.2 follow-ups); it blocked a green
// main from deploying, which is what this runner exists to stop.
//
// The filter is a single exact signature, and ONLY that: any test failure
// and any other unhandled error still fails the run. This is vitest 4's
// `onUnhandledError` hook, hand-rolled because 3.2 does not have it yet —
// when vitest is upgraded, fold the filter into the config and delete this.
import { startVitest } from 'vitest/node';

const KNOWN = 'Timeout calling "onTaskUpdate"';

const filters = process.argv.slice(2);
const vitest = await startVitest('test', filters, { run: true, watch: false });
if (!vitest) process.exit(1);
await vitest.close();

const files = vitest.state.getFiles();
const failed = [];
const walk = (tasks, file) => {
  for (const t of tasks) {
    if (t.result?.state === 'fail') failed.push(`${file}: ${t.name}`);
    if (t.tasks) walk(t.tasks, file);
  }
};
for (const f of files) {
  if (f.result?.state === 'fail') failed.push(`${f.filepath} (file-level)`);
  walk(f.tasks ?? [], f.filepath);
}

const unhandled = vitest.state.getUnhandledErrors();
const real = unhandled.filter((e) => !String(e?.message ?? e).includes(KNOWN));
const noise = unhandled.length - real.length;

if (noise > 0) {
  console.error(
    `[ci/test] ignored ${noise} known '${KNOWN}' worker error(s): ` +
      'runner starvation noise, not a test failure — see ci/test.mjs.',
  );
}
for (const e of real) console.error('[ci/test] unhandled error:', e);

// A suite that silently failed to collect is not a green suite. (Only for
// the full run — a CLI filter legitimately narrows the set.)
if (filters.length === 0 && files.length < 50) {
  console.error(`[ci/test] FAIL: only ${files.length} test files collected — the suite did not run.`);
  process.exit(1);
}
if (failed.length > 0 || real.length > 0) {
  console.error(`[ci/test] FAIL: ${failed.length} failed test(s), ${real.length} real unhandled error(s).`);
  for (const f of failed) console.error('  -', f);
  process.exit(1);
}
console.log(`[ci/test] green: ${files.length} files, 0 failures, ${noise} ignored runner-noise error(s).`);
process.exit(0);
