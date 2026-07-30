/**
 * Render-cost bench (SHIP.md U2, and §11 risk 2).
 *
 *   pnpm --filter client dev &
 *   node ci/renderBench.mjs
 *
 * Answers one question: does true parallax extrusion fit in the frame budget,
 * or does it force the GPU renderer (V1) forward from month 14?
 *
 * Measures CPU milliseconds inside the world render only — not the rAF delta,
 * which vsync pins at 16.7 and which therefore cannot see headroom at all. The
 * camera is driven along a fixed path from a fixed seed so the two
 * configurations look at the same city from the same places; the offline host
 * (`?local=1`) is what makes that reproducible without a server in the loop.
 */
import { chromium } from 'playwright';

const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const SECONDS = Number(process.env.BENCH_SECONDS ?? 14);

/** The two display sizes GRAPHICS.md quotes its existing numbers at. */
const VIEWPORTS = [
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '2560x1440', width: 2560, height: 1440 },
];

/**
 * Both arms pin `render=2d`.
 *
 * 3D is the default (`main.ts` reads `render !== '2d'`), so without this both
 * arms rendered in 3D — where `extrude` only touches `TileLayer`, which never
 * runs. The bench was comparing a configuration against itself and reporting
 * `tiles.lastBuildingsDrawn`, which is only ever assigned inside
 * `if (this.extruded)` and so was permanently 0. Every number it produced was
 * a measurement of nothing.
 */
const CONFIGS = [
  { label: 'baked walls  ', q: '&render=2d' },
  { label: 'parallax     ', q: '&render=2d&extrude=1' },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});

async function measure(viewport, q) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${origin}/?local=1&seed=7&night=0.25${q}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.mouse.click(viewport.width / 2, viewport.height / 2);

  // Drive. A moving camera is the honest case: it forces chunk builds, brings
  // new buildings into the cull, and is when a renderer actually misses.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1500); // let the samples from standing still age out
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await page.waitForTimeout(500);
  }
  await page.keyboard.up('KeyD');

  const out = await page.evaluate(() => ({
    render: globalThis.__debug?.renderMs,
    fps: globalThis.__debug?.fps,
    frameMs: globalThis.__debug?.frameMs,
    buildings: globalThis.__debug?.buildings,
  }));
  await page.close();
  if (errs.length) throw new Error(errs.join('\n'));
  return out;
}

/**
 * Interleave the two configurations and take the median of several passes.
 *
 * Measuring A fully, then B fully, cannot tell a real difference from the box
 * drifting under load — and this box drifts: the same config measured 4.9 ms
 * in one run and 11.9 ms in the next, for reasons that had nothing to do with
 * the renderer. Alternating ABAB and taking medians makes drift hit both
 * arms equally, which is the only way to get a usable answer without a quiet
 * machine.
 */
const REPEATS = Number(process.env.BENCH_REPEATS ?? 3);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`render cost — ${SECONDS}s of driving, seed 7, median of ${REPEATS} interleaved passes\n`);
console.log('                          p50      p95      p99     fps   buildings');
for (const vp of VIEWPORTS) {
  const runs = CONFIGS.map(() => []);
  for (let pass = 0; pass < REPEATS; pass++) {
    for (let c = 0; c < CONFIGS.length; c++) {
      runs[c].push(await measure(vp, CONFIGS[c].q));
    }
  }
  console.log(`${vp.label}`);
  for (let c = 0; c < CONFIGS.length; c++) {
    const rs = runs[c];
    const f = (pick) => `${median(rs.map(pick)).toFixed(2)}ms`.padStart(8);
    console.log(
      `  ${CONFIGS[c].label}${f((r) => r.render?.p50 ?? 0)} ${f((r) => r.render?.p95 ?? 0)}` +
        ` ${f((r) => r.render?.p99 ?? 0)}   ${median(rs.map((r) => r.fps ?? 0))
          .toFixed(0)
          .padStart(3)}   ${String(rs[0].buildings ?? 0).padStart(6)}`,
    );
  }
}
await browser.close();
