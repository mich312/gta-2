import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const [outPath, ...files] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const datas = files.map(f => readFileSync(f).toString('base64'));
const png = await p.evaluate(async ({ datas }) => {
  const W = 480, H = 270;
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  const x = c.getContext('2d');
  for (let i = 0; i < datas.length; i++) {
    const img = new Image(); img.src = 'data:image/png;base64,' + datas[i]; await img.decode();
    x.drawImage(img, (i % 2) * W, Math.floor(i / 2) * H, W, H);
  }
  return c.toDataURL('image/png').split(',')[1];
}, { datas });
writeFileSync(outPath, Buffer.from(png, 'base64'));
await b.close();
