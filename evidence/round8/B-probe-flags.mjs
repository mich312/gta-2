/**
 * Is the 0.25 fps the box, or the browser's configuration?
 *
 *   node evidence/round8/B-probe-flags.mjs
 *
 * The client draws through canvas 2D (`client/src/render/canvas.ts`), which
 * headless chromium accelerates through GL — and with no GPU that GL is
 * SwiftShader. This sweeps a few launch configurations and counts real rAF
 * frames in each, so "there is no GPU here" can be replaced by a number per
 * configuration instead of one number for the box.
 *
 * `window.__debug` is READ only.
 */
import { chromium } from 'playwright';

const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5961';
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';

const configs = [
  { name: 'default (what playLocal uses)', args: [] },
  { name: '--disable-gpu', args: ['--disable-gpu'] },
  { name: '--disable-gpu --disable-accelerated-2d-canvas', args: ['--disable-gpu', '--disable-accelerated-2d-canvas'] },
  { name: '--disable-gpu-vsync --disable-frame-rate-limit', args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] },
  {
    name: '--disable-gpu + vsync off',
    args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  },
];

for (const cfg of configs) {
  const b = await chromium.launch({ executablePath: exe, args: cfg.args });
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  try {
    await p.goto(`${origin}/?local=1&extrude=1&seed=7&night=0.55`, {
      waitUntil: 'load',
      timeout: 180000,
    });
    await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 180000 });
    await p.mouse.click(720, 405);
    await p.waitForTimeout(3000);
    const raf = await p.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const t = performance.now();
          const step = () => {
            n++;
            if (performance.now() - t < 8000) requestAnimationFrame(step);
            else res({ n, ms: performance.now() - t });
          };
          requestAnimationFrame(step);
        }),
    );
    const d = await p.evaluate(() => {
      const x = globalThis.__debug ?? {};
      return { fps: x.fps, renderMs: x.renderMs, frameMs: x.frameMs };
    });
    const tS = Date.now();
    let shot = 'ok';
    try {
      await p.screenshot({ path: `evidence/round8/B-flags-${cfg.args.length}.png`, timeout: 60000 });
    } catch (e) {
      shot = `FAILED: ${e.message.split('\n')[0]}`;
    }
    console.log(
      `${cfg.name}: ${(raf.n / (raf.ms / 1000)).toFixed(2)} fps ` +
        `(${(raf.ms / raf.n).toFixed(0)} ms/frame), renderMs p50=${d.renderMs?.p50?.toFixed?.(1)} ` +
        `p95=${d.renderMs?.p95?.toFixed?.(1)}, screenshot ${Date.now() - tS} ms ${shot}`,
    );
  } catch (e) {
    console.log(`${cfg.name}: ERROR ${e.message.split('\n')[0]}`);
  }
  await b.close();
}
