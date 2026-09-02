/**
 * Cross-host determinism gate (SHIP.md T1).
 *
 *   pnpm build && pnpm --filter client dev &
 *   node ci/hostParity.mjs [seed] [ticks]
 *
 * Runs the same session in Node and in a browser and compares every sampled
 * tick hash. This is the check that decides whether the offline host is the
 * game or a fork of it: `step()` has to stay bit-identical on any host
 * (ROADMAP.md §0, invariant 1), and the whole reason the port is safe to make
 * is that this is cheap to prove rather than a matter of opinion.
 *
 * Exits non-zero and names the first divergent tick.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const seed = process.argv[2] ?? '7';
const ticks = process.argv[3] ?? '600';
const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

const node = JSON.parse(
  execFileSync('node', ['server/dist/tools/hostProbeNode.js', seed, ticks], {
    encoding: 'utf8',
  }),
);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const heights = process.env.HEIGHTS === '1' ? '&heights=1' : '';
await page.goto(`${origin}/host-probe.html?seed=${seed}&ticks=${ticks}${heights}`);
await page.waitForFunction(() => globalThis.__probe !== undefined, null, { timeout: 120_000 });
const web = await page.evaluate(() => globalThis.__probe);
await browser.close();

if (errs.length) {
  console.error('page errors:\n' + errs.join('\n'));
  process.exit(1);
}

const problems = [];
if (node.samples.length !== web.samples.length) {
  problems.push(`sample counts differ: node ${node.samples.length}, browser ${web.samples.length}`);
}
for (let i = 0; i < Math.min(node.samples.length, web.samples.length); i++) {
  const a = node.samples[i];
  const b = web.samples[i];
  if (a.tick !== b.tick || a.hash !== b.hash) {
    problems.push(`tick ${a.tick}: node ${a.hash} !== browser ${b.hash}`);
    break; // the first divergence is the only informative one
  }
}
if (node.final !== web.final) {
  problems.push(`final: node ${node.final} !== browser ${web.final}`);
}

const label = `seed=${seed} ticks=${ticks} samples=${node.samples.length}`;
if (problems.length) {
  console.error(`host parity FAILED — ${label}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`host parity OK — ${label}, final hash ${node.final}`);
console.log('  the same simulation, in Node and in a browser, tick for tick.');
