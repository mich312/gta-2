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
 * paint budget takes tens of seconds to fill a view, and the fixed wait
 * below photographs the flat instanced slabs instead of the painting.
 */
import { chromium } from 'playwright';
const [url, out, sel] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 2200, height: 1000 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle' });
const wantGround = Number.parseInt(process.env.WAIT_GROUND ?? '0', 10);
if (wantGround > 0) {
  try {
    await p.waitForFunction((n) => (globalThis.__ground?.resident ?? 0) >= n, wantGround, { timeout: 180000 });
    await p.waitForTimeout(6000); // let the last-painted chunks upload
  } catch {
    console.log('WAIT_GROUND: residency timeout, shooting anyway');
  }
}
await p.waitForTimeout(1500);
const el = sel ? await p.$(sel) : null;
await (el ?? p).screenshot({ path: out });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();
