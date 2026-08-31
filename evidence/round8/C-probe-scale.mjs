/**
 * Where do the 2.7 s go?
 *
 *   node evidence/round8/C-probe-scale.mjs
 *
 * `B-probe-flags.mjs` showed the client's own draw costing under 17 ms while
 * frames still arrived 2.7 s apart, so the cost is not the game's render pass.
 * This separates the three remaining candidates: the browser itself (an empty
 * page's rAF rate), the raster area (the same game at a quarter of the
 * pixels), and the simulation worker (the game with the sim's own load).
 *
 * `window.__debug` is READ only.
 */
import { chromium } from 'playwright';
import { cpus, loadavg } from 'node:os';

const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5961';
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
console.log(`cpus=${cpus().length} loadavg=${loadavg().map((n) => n.toFixed(2)).join(' ')}`);

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

const b = await chromium.launch({ executablePath: exe });

// 1. An empty page. No game, no canvas, no worker.
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  await p.goto('about:blank');
  const r = await rafRate(p);
  console.log(`empty page 1440x810: ${(r.n / (r.ms / 1000)).toFixed(2)} fps`);
  await p.close();
}

// 2. An empty page that paints — a full-viewport 2D canvas, nothing else.
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 } });
  await p.setContent(
    '<canvas id=c width=1440 height=810></canvas><script>' +
      'const x=document.getElementById("c").getContext("2d");' +
      'let i=0;(function f(){i++;x.fillStyle="hsl("+(i%360)+",50%,50%)";x.fillRect(0,0,1440,810);requestAnimationFrame(f)})();' +
      '</script>',
  );
  const r = await rafRate(p);
  console.log(`bare canvas 1440x810 fill: ${(r.n / (r.ms / 1000)).toFixed(2)} fps`);
  await p.close();
}

// 3. The game, at three viewport sizes.
for (const [w, h] of [
  [1440, 810],
  [720, 405],
  [360, 203],
]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.goto(`${origin}/?local=1&extrude=1&seed=7&night=0.55`, {
    waitUntil: 'load',
    timeout: 180000,
  });
  await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 180000 });
  await p.waitForTimeout(2000);
  const r = await rafRate(p);
  const d = await p.evaluate(() => ({
    renderMs: globalThis.__debug?.renderMs,
    buildings: globalThis.__debug?.buildings,
  }));
  console.log(
    `game ${w}x${h}: ${(r.n / (r.ms / 1000)).toFixed(2)} fps ` +
      `(${(r.ms / r.n).toFixed(0)} ms/frame), renderMs p50=${d.renderMs?.p50?.toFixed?.(1)} ` +
      `buildings=${d.buildings}`,
  );
  await p.close();
}

// 4. The game page with the render loop's own draw removed from the equation:
//    the offline host worker alone, no client. Not reachable, so instead:
//    the game at 1440x810 with `extrude=0`, the cheapest tile pass.
{
  const p = await b.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  await p.goto(`${origin}/?local=1&seed=7&night=0`, { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 180000 });
  await p.waitForTimeout(2000);
  const r = await rafRate(p);
  console.log(`game 1440x810, no extrude, day: ${(r.n / (r.ms / 1000)).toFixed(2)} fps`);
  await p.close();
}

await b.close();
