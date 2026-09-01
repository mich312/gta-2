// How fast does the painted ground actually fill for a given city3d view?
//   node evidence/iter7/probe-ground.mjs "<url>" [seconds]
// Prints __ground.resident every 10s so a WAIT_GROUND target can be chosen
// from measurement rather than guessed.  LENS-B is emphatic that shooting
// before the ground is resident photographs flat slabs; this says when.
import { chromium } from 'playwright';

const [url, secs] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1400, height: 700 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle' });
const until = Date.now() + (Number(secs ?? 120) * 1000);
let last = -1;
while (Date.now() < until) {
  const g = await p.evaluate(() => ({
    resident: globalThis.__ground?.resident ?? null,
    want: globalThis.__ground?.wanted ?? globalThis.__ground?.total ?? null,
    keys: globalThis.__ground ? Object.keys(globalThis.__ground) : null,
  }));
  if (g.resident !== last) console.log(`${new Date().toISOString().slice(11, 19)} ${JSON.stringify(g)}`);
  last = g.resident;
  await p.waitForTimeout(5000);
}
if (errs.length) console.log('PAGE ERRORS:\n' + errs.join('\n'));
await b.close();
