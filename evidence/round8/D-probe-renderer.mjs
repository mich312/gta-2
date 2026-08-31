/**
 * Which renderer is `ci/playLocal.mjs` actually driving, and what does it cost?
 *
 *   node evidence/round8/D-probe-renderer.mjs
 *
 * `main.ts:249` — `wants3d = params.get('render') !== '2d'` — so the 3D
 * three.js renderer is the DEFAULT, and `playLocal.mjs` passes no `render=`.
 * Every plate it has ever tried to take has therefore gone through WebGL, and
 * on a box with no GPU that is SwiftShader. This measures the same session
 * through both renderers.
 *
 * `window.__debug` is READ only.
 */
import { chromium } from 'playwright';

const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5961';
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const b = await chromium.launch({ executablePath: exe });

const rafRate = (p, ms = 8000) =>
  p.evaluate(
    (ms) =>
      new Promise((res) => {
        let n = 0;
        const t = performance.now();
        const step = () => {
          n++;
          if (performance.now() - t < ms) requestAnimationFrame(step);
          else res({ n, ms: performance.now() - t });
        };
        requestAnimationFrame(step);
      }),
    ms,
  );

for (const q of [
  'local=1&extrude=1&seed=7&night=0.55', // exactly what playLocal.mjs asks for
  'local=1&extrude=1&seed=7&night=0.55&render=2d',
  'local=1&extrude=1&seed=7&night=0.55&render=2d&lights=cheap',
  'local=1&seed=7&night=0.55&render=2d',
]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  const warn = [];
  p.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warn.push(m.text());
  });
  await p.goto(`${origin}/?${q}`, { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 180000 });
  await p.mouse.click(720, 405);
  await p.waitForTimeout(2000);
  const r = await rafRate(p);
  const fps = r.n / (r.ms / 1000);

  // Now the thing that actually matters for the harness: how much walking does
  // one wall-clock second of held key buy?
  const before = await p.evaluate(() => {
    const m = globalThis.__debug?.me ?? {};
    return { x: m.pos?.x ?? 0, y: m.pos?.y ?? 0, tick: globalThis.__debug?.tick };
  });
  await p.keyboard.down('KeyW');
  await p.waitForTimeout(6000);
  await p.keyboard.up('KeyW');
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => {
    const m = globalThis.__debug?.me ?? {};
    return { x: m.pos?.x ?? 0, y: m.pos?.y ?? 0, tick: globalThis.__debug?.tick };
  });
  const moved = Math.hypot(after.x - before.x, after.y - before.y);

  const tS = Date.now();
  let shotMs = -1;
  try {
    await p.screenshot({ path: `evidence/round8/D-${q.includes('render=2d') ? '2d' : '3d'}.png`, timeout: 90000 });
    shotMs = Date.now() - tS;
  } catch {
    shotMs = -(Date.now() - tS);
  }
  console.log(
    `?${q}\n   ${fps.toFixed(2)} fps (${(r.ms / r.n).toFixed(0)} ms/frame), ` +
      `6 s of KeyW moved ${moved.toFixed(0)} px, screenshot ${shotMs} ms` +
      (warn.length ? `\n   console: ${warn.slice(0, 2).join(' | ')}` : ''),
  );
  await p.close();
}
await b.close();
