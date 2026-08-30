// Like ci/shot.mjs but with a caller-set viewport and a long screenshot timeout,
// because the real client under SwiftShader can take >30 s to present a frame.
import { chromium } from 'playwright';
const [url, out] = process.argv.slice(2);
const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'domcontentloaded' });
const want = Number.parseInt(process.env.WAIT_GROUND ?? '0', 10);
if (want > 0) {
  try {
    await p.waitForFunction((n) => (globalThis.__ground?.resident ?? 0) >= n, want, { timeout: 300000 });
    await p.waitForTimeout(8000);
  } catch { console.log('WAIT_GROUND: residency timeout, shooting anyway'); }
}
await p.waitForTimeout(Number(process.env.SETTLE ?? 3000));
await p.screenshot({ path: out, timeout: 240000 });
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
console.log('shot ok');
await b.close();
