/**
 * Does a ground point land where the HUD draws it?
 *
 * R9-B01: the HUD, the name tags and the tracers drew at `world - cam`, on the
 * stated grounds that the 3D camera hangs straight down. `GAME_PITCH` is 10.
 * `evidence/round9/B-probe-project.mjs` measured the error; this one measures
 * BOTH mappings against the same real camera in the same run:
 *
 *   old  = world - cam                       (what the HUD used to do)
 *   new  = projectGround(...)                (client/src/render/project.ts)
 *
 * The pitch-0 control must print zeros in both columns - the new projection
 * takes the identity branch there, so it is exact and not merely close.
 *
 *   pnpm --filter client dev --port 5985
 *   node evidence/round10/B-probe-hudproject.mjs <pitch> <viewHeight>
 */
import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
const pitch = process.argv[2] ?? '10';
const vh = Number(process.argv[3] ?? 360);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// 1400x800 => aspect 1.75, exactly MAX_VIEW_W/MAX_VIEW_H (700x400).
const p = await b.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const url = `http://localhost:5985/city3d.html?fly=1&at=400,400&h=${vh}&pitch=${pitch}&night=0`;
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => globalThis.__city, null, { timeout: 300000 });
const out = await p.evaluate(async ({ vh }) => {
  const THREE = (await import('/node_modules/.vite/deps/three.js').catch(() => null))
    ?? (await import('three'));
  // The very modules the client ships - the same singletons the page holds.
  const vp = await import('/src/render/viewport.ts');
  const proj = await import('/src/render/project.ts');
  const view = globalThis.__city;
  const cv = document.getElementById('view');
  const aspect = cv.width / cv.height;
  const vw = Math.round(vh * aspect); // world px across the frame
  // Put the shared viewport on the frame this probe measures, so
  // `projectGround` reads the same frame the identity below is built from.
  vp.setViewport(vp.fixedViewport(vw, vh));
  const fx = 400 * 16;
  const fy = 400 * 16; // the held focus, world px
  const cam = { x: fx - vw / 2, y: fy - vh / 2 };
  view.lookAt(fx, fy);
  view.world.updateMatrixWorld(true);
  view.camera.updateMatrixWorld(true);
  const rows = [];
  const v = new THREE.Vector3();
  const at = { x: 0, y: 0 };
  // Worst error before any rounding, so "0.0" in the table cannot hide a
  // projection that is merely close.
  let rawOld = 0;
  let rawNew = 0;
  for (const fyf of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    for (const fxf of [0.05, 0.5, 0.95]) {
      const wx = cam.x + vw * fxf;
      const wy = cam.y + vh * fyf;
      v.set(wx, wy, 0).applyMatrix4(view.world.matrixWorld).project(view.camera);
      // Where the renderer actually puts it, in world px from the frame origin
      const rx = (v.x * 0.5 + 0.5) * vw;
      const ry = (-v.y * 0.5 + 0.5) * vh;
      const ox = wx - cam.x;
      const oy = wy - cam.y; // the old identity
      proj.projectGround(wx, wy, cam, at); // the new mapping
      rawOld = Math.max(rawOld, Math.hypot(ox - rx, oy - ry));
      rawNew = Math.max(rawNew, Math.hypot(at.x - rx, at.y - ry));
      rows.push({
        fxf, fyf,
        rx: +rx.toFixed(1), ry: +ry.toFixed(1),
        odx: +(ox - rx).toFixed(1), ody: +(oy - ry).toFixed(1),
        ndx: +(at.x - rx).toFixed(1), ndy: +(at.y - ry).toFixed(1),
      });
    }
  }
  return { vw, vh, aspect, rows, rawOld, rawNew };
}, { vh });
console.log(`pitch=${pitch} viewHeight=${out.vh} viewWidth=${out.vw} aspect=${out.aspect.toFixed(3)}`);
console.log('  frac x  frac y |  3D lands at   |  OLD world-cam err | NEW projectGround err');
let worstOld = 0;
let worstNew = 0;
for (const r of out.rows) {
  worstOld = Math.max(worstOld, Math.hypot(r.odx, r.ody));
  worstNew = Math.max(worstNew, Math.hypot(r.ndx, r.ndy));
  console.log(
    `   ${r.fxf.toFixed(2)}    ${r.fyf.toFixed(2)}  | ${String(r.rx).padStart(6)} ${String(r.ry).padStart(6)} `
    + `| ${String(r.odx).padStart(8)} ${String(r.ody).padStart(8)} `
    + `| ${String(r.ndx).padStart(9)} ${String(r.ndy).padStart(9)}`,
  );
}
console.log(`worst error, world px:  OLD ${worstOld.toFixed(2)}   NEW ${worstNew.toFixed(2)}`);
console.log(`worst error unrounded:  OLD ${out.rawOld.toExponential(3)}   NEW ${out.rawNew.toExponential(3)}`);
await b.close();
