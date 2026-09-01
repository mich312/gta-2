/* `ci/shot.mjs` with a longer navigation budget.
 *
 * `ci/shot.mjs` waits for `networkidle` on playwright's default 30 s. The
 * 768x768 city is baked in the page before the first frame, and on this box
 * that alone outlives the budget, so the shot dies during NAVIGATION rather
 * than during the screenshot the tool already fixed. Same tool otherwise:
 * ground residency polled and PRINTED, non-zero exit when no file appears.
 *
 *   node evidence/iter12/shot.mjs <url> <out.png>
 */
import { existsSync, statSync } from 'node:fs';
import { chromium } from 'playwright';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node evidence/iter12/shot.mjs <url> <out.png>');
  process.exit(2);
}
const [vw, vh] = (process.env.VIEW ?? '1000x1000').split('x').map(Number);
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const p = await b.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'load', timeout: 300000 });

const wantGround = Number.parseInt(process.env.WAIT_GROUND ?? '0', 10);
if (wantGround > 0) {
  const deadline = Date.now() + 300000;
  let seen = 0;
  for (;;) {
    seen = await p.evaluate(() => globalThis.__ground?.resident ?? 0);
    if (seen >= wantGround || Date.now() >= deadline) break;
    await p.waitForTimeout(3000);
  }
  console.log(`ground resident=${seen} (wanted ${wantGround})`);
  if (seen < wantGround) console.log('WAIT_GROUND: under target, shooting anyway');
  await p.waitForTimeout(6000);
}
await p.waitForTimeout(2000);
await p.screenshot({ path: out, timeout: 180000 });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();

if (!existsSync(out) || statSync(out).size === 0) {
  console.error(`shot: no picture written to ${out}`);
  process.exit(1);
}
console.log(`-> ${out} (${vw}x${vh}, ${statSync(out).size} bytes)`);
