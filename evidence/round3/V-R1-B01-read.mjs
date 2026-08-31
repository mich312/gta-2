import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
import { readFileSync } from 'fs';
// usage: read.mjs file [x,y ...]
const [file, ...rest] = process.argv.slice(2);
const pts = rest.map((s) => s.split(',').map(Number));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const data = readFileSync(file).toString('base64');
const res = await p.evaluate(async ({ data, pts }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + data;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const out = { size: [img.width, img.height], px: [] };
  for (const [px, py] of pts) {
    const d = x.getImageData(px, py, 1, 1).data;
    out.px.push([px, py, d[0], d[1], d[2]]);
  }
  return out;
}, { data, pts });
console.log(file, JSON.stringify(res.size));
for (const q of res.px) {
  const l = (0.2126*q[2] + 0.7152*q[3] + 0.0722*q[4]).toFixed(1);
  console.log(`  (${q[0]},${q[1]}) rgb(${q[2]},${q[3]},${q[4]}) luma=${l}`);
}
await b.close();
