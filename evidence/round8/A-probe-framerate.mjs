/**
 * What does `ci/playLocal.mjs` actually get on this box?
 *
 *   node evidence/round8/A-probe-framerate.mjs
 *
 * Measures the three things the script's budgets depend on and none of which
 * it checks: how long `goto(networkidle)` takes (or whether it ever arrives),
 * the client's real frame rate under SwiftShader, and how much simulated
 * player movement one wall-clock second of held key actually buys.
 *
 * `window.__debug` is READ only.
 */
import { chromium } from 'playwright';

const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5961';
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const p = await b.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

const t0 = Date.now();
await p.goto(`${origin}/?local=1&extrude=1&seed=7&night=0.55`, {
  waitUntil: 'load',
  timeout: 180000,
});
console.log(`goto(load): ${Date.now() - t0} ms`);

// Does networkidle — what playLocal.mjs waits for — ever arrive?
const tIdle = Date.now();
let idle;
try {
  await p.waitForLoadState('networkidle', { timeout: 45000 });
  idle = `${Date.now() - tIdle} ms`;
} catch {
  idle = `NOT REACHED in ${Date.now() - tIdle} ms`;
}
console.log(`networkidle: ${idle}`);

const tTick = Date.now();
try {
  await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 180000 });
  console.log(`first 30 sim ticks: ${Date.now() - tTick} ms`);
} catch {
  console.log(`sim never reached tick 30 in ${Date.now() - tTick} ms`);
}

await p.mouse.click(720, 405);
await p.waitForTimeout(2000);

const read = () =>
  p.evaluate(() => {
    const d = globalThis.__debug ?? {};
    const m = d.me ?? {};
    return {
      fps: d.fps,
      frameMs: d.frameMs,
      frameMsPeak: d.frameMsPeak,
      renderMs: d.renderMs,
      tick: d.tick,
      mode: m.mode,
      pos: { x: m.pos?.x ?? 0, y: m.pos?.y ?? 0 },
      nearest: d.nearestVehicle,
      weapon: m.weapons?.[m.activeWeapon]?.weaponId,
    };
  });

const a = await read();
await p.waitForTimeout(10000);
const c = await read();
console.log(
  `10 s idle: sim advanced ${c.tick - a.tick} ticks (30/s = 300 expected), ` +
    `fps=${c.fps} frameMs=${c.frameMs} peak=${c.frameMsPeak} renderMs=${c.renderMs}`,
);

// A hand-count of real frames: rAF callbacks over 10 s. Read only.
const raf = await p.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t = performance.now();
      const step = () => {
        n++;
        if (performance.now() - t < 10000) requestAnimationFrame(step);
        else res({ n, ms: performance.now() - t });
      };
      requestAnimationFrame(step);
    }),
);
console.log(
  `rAF: ${raf.n} frames in ${Math.round(raf.ms)} ms = ` +
    `${(raf.n / (raf.ms / 1000)).toFixed(2)} fps, ${(raf.ms / raf.n).toFixed(0)} ms/frame`,
);

// How far does a held key actually move the player, per wall-clock second?
for (const ms of [250, 1000, 4000, 12000]) {
  const before = await read();
  await p.keyboard.down('KeyD');
  await p.waitForTimeout(ms);
  await p.keyboard.up('KeyD');
  await p.waitForTimeout(500);
  const after = await read();
  const d = Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y);
  console.log(
    `hold KeyD ${ms} ms -> moved ${d.toFixed(1)} px ` +
      `(${(d / (ms / 1000)).toFixed(1)} px/s), sim ticks ${after.tick - before.tick}`,
  );
}

console.log('state: ' + JSON.stringify(await read()));

const tS = Date.now();
try {
  await p.screenshot({ path: 'evidence/round8/A-probe-frame.png' });
  console.log(`screenshot: ${Date.now() - tS} ms`);
} catch (e) {
  console.log(`screenshot FAILED after ${Date.now() - tS} ms: ${e.message}`);
}

if (errs.length) console.log('page errors: ' + errs.slice(0, 5).join(' | '));
await b.close();
