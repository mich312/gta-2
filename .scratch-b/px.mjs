import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, ...pts] = process.argv.slice(2);
const b64 = readFileSync(file).toString('base64');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const out = await p.evaluate(async ({ b64, pts }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const res = { size: [img.width, img.height], px: [] };
  for (const s of pts) {
    const [px, py] = s.split(',').map(Number);
    const d = x.getImageData(px, py, 1, 1).data;
    res.px.push(`${px},${py} = rgb(${d[0]},${d[1]},${d[2]})`);
  }
  return res;
}, { b64, pts });
console.log(out.size.join('x'));
console.log(out.px.join('\n'));
await b.close();
