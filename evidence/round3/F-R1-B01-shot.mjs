/**
 * Photograph the real client for R1-B01.
 *
 *   node evidence/round3/F-R1-B01-shot.mjs <url> <out.png>
 *
 * `ci/shot.mjs` waits for `networkidle` with playwright's 30 s default, which
 * the live client never reaches: the offline host worker and the render loop
 * keep the page busy for as long as it is open. This waits for `load`, then
 * for the game to have a tick behind it, then lets the scene settle before
 * shooting at a fixed 1280x720 — the size of the round-3 R1-B01 plates, so a
 * pixel address means the same thing across both sets.
 */
import { chromium } from 'playwright';
const [url, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'load', timeout: 120000 });
try {
  await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 120000 });
} catch { console.log('tick wait timed out, shooting anyway'); }
await p.waitForTimeout(Number(process.env.SETTLE ?? 12000));
await p.screenshot({ path: out });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 8).join('\n'));
await b.close();
