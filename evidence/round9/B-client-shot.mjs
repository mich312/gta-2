/**
 * Photograph the REAL client (index.html), which defaults to the 3D renderer.
 *   node evidence/round9/B-client-shot.mjs <url> <out.png> [settleMs]
 * Waits on the offline host's own clock, not on networkidle: the render loop
 * never lets a live page go idle.
 */
import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
const [url, out, settle = '25000'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'load', timeout: 300000 });
try {
  await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 60, null, { timeout: 300000 });
} catch { console.log('tick wait timed out, shooting anyway'); }
await p.waitForTimeout(Number(settle));
await p.screenshot({ path: out });
console.log('debug:', JSON.stringify(await p.evaluate(() => {
  const d = globalThis.__debug ?? {};
  return { tick: d.tick, me: d.me && { x: Math.round(d.me.pos.x), y: Math.round(d.me.pos.y), mode: d.me.mode },
           cam: d.cam, lights3d: d.lights3d, peds: d.peds, props: d.props, vehicles: d.vehicles, fx: d.fx };
})));
if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 10).join('\n'));
await b.close();
