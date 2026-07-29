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
 */
import { chromium } from 'playwright';
const [url, out, sel] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 2200, height: 1000 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const el = sel ? await p.$(sel) : null;
await (el ?? p).screenshot({ path: out });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();
