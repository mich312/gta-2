/**
 * A picture of the shopfront each kind of shop wears in 2D.
 *
 * The companion to `B-probe-shopcolour.mjs`: same chunk canvases out of the
 * same shipped painter (`__ground.painter`), but cropped around each doorway
 * and blown up, so "spray and clinic wear the clothing shop's front" is a
 * thing you can look at rather than three hex codes.
 *
 *   pnpm --filter client dev --port 5985
 *   node evidence/round10/B-shopfront-strip.mjs <out.png>
 */
import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
const out = process.argv[2] ?? 'evidence/round10/B-shopfronts.png';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 560, height: 200 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await p.goto('http://localhost:5985/city3d.html?fly=1&at=400,400&h=270&pitch=10', {
  waitUntil: 'domcontentloaded',
  timeout: 300000,
});
await p.waitForFunction(() => globalThis.__ground?.painter, null, { timeout: 300000 });
const kinds = await p.evaluate(() => {
  const g = globalThis.__ground;
  const t = g.painter;
  const TD = 32;
  const CT = 8;
  const ZOOM = 5;
  const CELL = 3; // tiles across, centred on the doorway
  const seen = new Map();
  for (const s of g.map.shops) if (!seen.has(s.kind)) seen.set(s.kind, s);
  const order = ['gun', 'clothing', 'spray', 'clinic'].filter((k) => seen.has(k));
  const strip = document.createElement('canvas');
  strip.width = order.length * CELL * TD * ZOOM;
  strip.height = CELL * TD * ZOOM + 22;
  const sc = strip.getContext('2d');
  sc.imageSmoothingEnabled = false;
  sc.fillStyle = '#101418';
  sc.fillRect(0, 0, strip.width, strip.height);
  order.forEach((kind, i) => {
    const s = seen.get(kind);
    const cx = Math.floor(s.doorX / CT);
    const cy = Math.floor(s.doorY / CT);
    const canvas = t.buildChunk(cx, cy);
    const bx = (s.doorX - cx * CT - 1) * TD;
    const by = (s.doorY - cy * CT - 1) * TD;
    sc.drawImage(
      canvas, bx, by, CELL * TD, CELL * TD,
      i * CELL * TD * ZOOM, 22, CELL * TD * ZOOM, CELL * TD * ZOOM,
    );
    sc.fillStyle = '#e8f0e8';
    sc.font = '14px monospace';
    sc.fillText(kind, i * CELL * TD * ZOOM + 6, 15);
  });
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.appendChild(strip);
  strip.id = 'strip';
  return order;
});
await p.setViewportSize({ width: kinds.length * 3 * 32 * 5, height: 3 * 32 * 5 + 22 });
await p.locator('#strip').screenshot({ path: out });
console.log('kinds', kinds.join(' '), '->', out);
await b.close();
