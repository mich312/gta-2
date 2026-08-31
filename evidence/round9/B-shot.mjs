/**
 * ci/shot.mjs with the timeouts a 0.37-fps software 3D page needs.
 *   node evidence/round9/B-shot.mjs <url> <out.png> [groundChunks]
 */
import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
const [url, out, want = '24'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 300000 });
const n = Number(want);
if (n > 0) {
  try {
    await p.waitForFunction((k) => (globalThis.__ground?.resident ?? 0) >= k, n, { timeout: 300000 });
    await p.waitForTimeout(12000);
  } catch { console.log('WAIT_GROUND: residency timeout, shooting anyway'); }
} else {
  await p.waitForTimeout(20000);
}
await p.screenshot({ path: out });
console.log('hud:', await p.$eval('#hud', (e) => e.textContent).catch(() => '-'));
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();
