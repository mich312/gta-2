/**
 * Screenshot a page against the dev server.
 *
 *   node ci/shot.mjs <url> <out.png> [selector]
 *
 * The evidence PNGs in `evidence/` used to be taken by hand out of a browser,
 * which is why several of them are captioned "taken before the rework below".
 * A screenshot nobody can retake goes stale the first time the thing it shows
 * changes. This makes them reproducible: start `pnpm --filter client dev` and
 * point it at one of the contact-sheet pages.
 *
 * Chromium is already on the box (PLAYWRIGHT_BROWSERS_PATH); do not let
 * anything try to download another one.
 *
 * WAIT_GROUND=<n> waits until the page's painted ground layer has at least
 * that many chunks resident (the city3d flyover exposes it as __ground)
 * before shooting. Under the CI box's software renderer the 2-chunks-a-frame
 * paint budget takes tens of seconds to fill a view, and shooting before it
 * plateaus photographs the flat instanced slabs instead of the painting.
 * **It is not optional for an eye-level shot of the city.**
 *
 * VIEW=<w>x<h> sets the viewport; the default is 1400x700.
 *
 * ## Why the default is 1400x700 and the screenshot timeout is not 30 s
 *
 * This used to shoot at a hard-coded 2200x1000 and take playwright's default
 * 30-second screenshot timeout, and on this box the pair of them meant it
 * **could not take a picture at all**: the bigger frustum wants more painted
 * ground than the paint budget delivers, the software renderer then needs
 * longer than 30 s to produce one frame of it, `page.screenshot` times out,
 * and the run ends having written no file. Iteration 7 of the visual review
 * hit this, worked around it with a private copy, and left a note that the
 * next reader would hit it too. So: a viewport that this box can actually
 * fill, a screenshot timeout with room in it, and — below — a non-zero exit
 * if no file appears, because silently producing nothing is how a broken
 * instrument survives.
 *
 * Residency is polled from node rather than with `waitForFunction`, whose
 * in-page poll is itself starved when a frame costs seconds, and the number
 * reached is PRINTED. A shot taken under target is still worth having; a shot
 * you cannot tell was taken under target is not.
 */
import { existsSync, statSync } from 'node:fs';
import { chromium } from 'playwright';

const [url, out, sel] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node ci/shot.mjs <url> <out.png> [selector]');
  process.exit(2);
}
const [vw, vh] = (process.env.VIEW ?? '1400x700').split('x').map(Number);
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const p = await b.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle' });

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
  await p.waitForTimeout(6000); // let the last-painted chunks upload
}
await p.waitForTimeout(1500);
const el = sel ? await p.$(sel) : null;
await (el ?? p).screenshot({ path: out, timeout: 120000 });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();

if (!existsSync(out) || statSync(out).size === 0) {
  console.error(`shot.mjs: no picture written to ${out}`);
  process.exit(1);
}
console.log(`-> ${out} (${vw}x${vh}, ${statSync(out).size} bytes)`);
