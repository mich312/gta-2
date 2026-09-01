// `ci/shot.mjs` with two things this box needs and that one hard-codes: a
// smaller viewport, and a screenshot timeout longer than 30s.
//
//   node evidence/iter7/shot.mjs "<url>" <out.png>
//   WAIT_GROUND=<n>  wait for that many resident painted-ground chunks
//   VIEW=<w>x<h>     viewport, default 1400x700
//
// ci/shot.mjs shoots at 2200x1000, which under the software renderer wants
// more ground chunks than the 2-per-frame paint budget delivers and then
// times out the screenshot itself at 30s.  LENS-B's warning stands and is
// the whole reason for WAIT_GROUND here: shooting before the ground is
// resident photographs the flat instanced slabs, not the city.
import { chromium } from 'playwright';

const [url, out] = process.argv.slice(2);
const [vw, vh] = (process.env.VIEW ?? '1400x700').split('x').map(Number);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url, { waitUntil: 'networkidle' });

const want = Number.parseInt(process.env.WAIT_GROUND ?? '0', 10);
if (want > 0) {
  const deadline = Date.now() + 300000;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await p.evaluate(() => globalThis.__ground?.resident ?? 0);
    if (seen >= want) break;
    await p.waitForTimeout(3000);
  }
  console.log(`ground resident=${seen} (wanted ${want})`);
  if (seen < want) console.log('WARNING: shooting under target residency');
  await p.waitForTimeout(6000); // let the last-painted chunks upload
}
await p.waitForTimeout(1500);
await p.screenshot({ path: out, timeout: 120000 });
console.log(`-> ${out}`);
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();
