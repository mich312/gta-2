/**
 * What colour does the 2D tile painter give each shop's SHOPFRONT?
 *
 * `tiles.ts:2789` (paintShops — step 5, drawn last over everything else in the
 * chunk) has a three-way accent that falls through to `palette.shopClothing`;
 * `tiles.ts:1826` (paintShopFloor) and `cityGeometry.ts:570` (the 3D threshold
 * accent) both carry the full four-way including `palette.shopSpray`.
 *
 * Reads the real painter out of the running flyover page (`__ground.painter`),
 * so it is the shipped code path and not a re-implementation.
 *
 *   pnpm --filter client dev --port 5985
 *   node evidence/round10/B-probe-shopcolour.mjs
 */
import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await p.goto('http://localhost:5985/city3d.html?fly=1&at=400,400&h=270&pitch=10', {
  waitUntil: 'domcontentloaded', timeout: 300000,
});
await p.waitForFunction(() => globalThis.__ground?.painter, null, { timeout: 300000 });
const out = await p.evaluate(() => {
  const g = globalThis.__ground;
  const map = g.map;
  const t = g.painter;
  const TD = 32, CT = 8;
  const rows = [];
  const seen = new Set();
  for (const s of map.shops) {
    if (seen.has(s.kind)) continue;
    seen.add(s.kind);
    const cx = Math.floor(s.doorX / CT), cy = Math.floor(s.doorY / CT);
    const canvas = t.buildChunk(cx, cy);           // the canvas the 2D renderer blits
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const bx = (s.doorX - cx * CT) * TD;
    const by = (s.doorY - cy * CT) * TD;
    const at = (dx, dy) => {
      const d = ctx.getImageData(bx + dx, by + dy, 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    };
    // paintShops (tiles.ts:2795-2803): board fill at +2s, awning band at +2s..+5s,
    // highlight at +3s, doormat stripes at +8s.  s = RENDER_SCALE = 2.
    // ...and one interior tile, painted by paintShopFloor (tiles.ts:1826),
    // which DOES carry the four-way accent.
    const r = s.interior;
    let inside = '-';
    if (r.w > 0 && r.h > 0) {
      const icx = Math.floor(r.x / CT), icy = Math.floor(r.y / CT);
      const ic = t.buildChunk(icx, icy).getContext('2d', { willReadFrequently: true });
      const ix = (r.x - icx * CT) * TD, iy = (r.y - icy * CT) * TD;
      const d2 = ic.getImageData(ix + 16, iy + 7, 1, 1).data;
      inside = '#' + [d2[0], d2[1], d2[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    }
    rows.push({ kind: s.kind, door: [s.doorX, s.doorY],
                awning: at(16, 6), board: at(16, 24), mat: at(11, 20), inside });
  }
  const counts = {};
  for (const s of map.shops) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return { rows, counts };
});
console.log('palette    shopGun #c8583c   shopClothing #3ca0c8   shopSpray #c8a13c');
console.log('shop count', JSON.stringify(out.counts));
for (const r of out.rows) {
  console.log(`${r.kind.padEnd(9)} door ${String(r.door).padEnd(11)} awning ${r.awning}  doormat ${r.mat}  interiorSample ${r.inside}`);
}
await b.close();
