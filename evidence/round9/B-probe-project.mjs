/**
 * Does a ground point land where the HUD thinks it does?
 *
 * The HUD, the tracers, the name tags and mouse aim all use one identity:
 * screen = world - cam, with the frame covering viewport.w x viewport.h world
 * px. `renderer.ts:800` states it as "the 3D camera hangs straight down over
 * the middle of the same frame". The shipped GAME_PITCH is 10, not 0.
 *
 * This projects a grid of ground points through the real CityView camera and
 * reports how far each lands from where that identity puts it, in world px.
 *
 *   node evidence/round9/B-probe-project.mjs <pitch> <viewHeight>
 */
import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
const pitch = process.argv[2] ?? '10';
const vh = Number(process.argv[3] ?? 400);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// 1400x800 => aspect 1.75, exactly MAX_VIEW_W/MAX_VIEW_H (700x400).
const p = await b.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const url = `http://localhost:5981/city3d.html?fly=1&at=400,400&h=${vh}&pitch=${pitch}&night=0`;
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => globalThis.__city, null, { timeout: 300000 });
const out = await p.evaluate(async ({ vh }) => {
  const THREE = await import('/node_modules/.vite/deps/three.js').catch(() => null)
    ?? await import('three');
  const view = globalThis.__city;
  const cv = document.getElementById('view');
  const aspect = cv.width / cv.height;
  const vw = vh * aspect;                       // world px across the frame
  const fx = 400 * 16, fy = 400 * 16;           // the held focus, world px
  const camx = fx - vw / 2, camy = fy - vh / 2; // the HUD's camera origin
  view.lookAt(fx, fy);
  view.world.updateMatrixWorld(true);
  view.camera.updateMatrixWorld(true);
  const rows = [];
  const v = new THREE.Vector3();
  for (const fyf of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    for (const fxf of [0.05, 0.5, 0.95]) {
      const wx = camx + vw * fxf, wy = camy + vh * fyf;
      v.set(wx, wy, 0).applyMatrix4(view.world.matrixWorld).project(view.camera);
      // Where the renderer actually puts it, in world px from the frame origin
      const rx = (v.x * 0.5 + 0.5) * vw;
      const ry = (-v.y * 0.5 + 0.5) * vh;
      // Where the HUD identity puts it
      const hx = wx - camx, hy = wy - camy;
      rows.push({ fxf, fyf, rx: +rx.toFixed(1), ry: +ry.toFixed(1),
                  hx: +hx.toFixed(1), hy: +hy.toFixed(1),
                  dx: +(rx - hx).toFixed(1), dy: +(ry - hy).toFixed(1) });
    }
  }
  return { vw, vh, aspect, rows };
}, { vh });
console.log(`pitch=${pitch} viewHeight=${out.vh} viewWidth=${out.vw.toFixed(0)} aspect=${out.aspect.toFixed(3)}`);
console.log('  frac x  frac y |  3D lands at   |  HUD draws at  |  error (world px)');
for (const r of out.rows) {
  console.log(
    `   ${r.fxf.toFixed(2)}    ${r.fyf.toFixed(2)}  | ${String(r.rx).padStart(6)} ${String(r.ry).padStart(6)} ` +
    `| ${String(r.hx).padStart(6)} ${String(r.hy).padStart(6)} | ${String(r.dx).padStart(6)} ${String(r.dy).padStart(6)}`,
  );
}
await b.close();
