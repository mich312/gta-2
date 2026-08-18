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
 * SHOT_TIMEOUT=<ms> overrides Playwright's 30s screenshot timeout, for a
 * page whose frames take longer than that (see below). WAIT_MS=<ms>
 * overrides the 180s cap on the residency wait, which at `?h=2400` is not
 * enough to paint the view: 2 chunks a frame at a seventh of a frame a
 * second is a quarter of a chunk a second.
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
    await p.waitForFunction((n) => (globalThis.__ground?.resident ?? 0) >= n, wantGround, {
      timeout: Number.parseInt(process.env.WAIT_MS ?? '180000', 10),
    });
    await p.waitForTimeout(6000); // let the last-painted chunks upload
  } catch {
    console.log('WAIT_GROUND: residency timeout, shooting anyway');
  }
}
await p.waitForTimeout(1500);
const el = sel ? await p.$(sel) : null;
// A screenshot has to wait for a FRAME, and the city3d flyover renders one
// every few seconds under the software renderer — at `?h=2400` it is slower
// than Playwright's 30s default, so the retake of the headland shot failed
// three times running and left a black "building…" PNG in `evidence/` the
// once it did not. SHOT_TIMEOUT overrides it; 0 waits forever.
await (el ?? p).screenshot({
  path: out,
  timeout: Number.parseInt(process.env.SHOT_TIMEOUT ?? '30000', 10),
});
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();
