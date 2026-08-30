import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
for (const f of process.argv.slice(2)) {
  const b64 = readFileSync(f).toString('base64');
  const r = await p.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    let warm = 0, n = 0;
    for (let y = 45; y < img.height - 90; y++) {
      for (let px = 0; px < img.width; px++) {
        if (px > img.width - 215 && y < 165) continue;
        if (px > img.width - 135 && y > img.height - 170) continue;
        const i = (y * img.width + px) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        n++;
        // warm and clearly brighter than the night city: a lamp pool or a lit window
        if (R > 150 && R - B > 45 && G > B) warm++;
      }
    }
    return { warm, n };
  }, b64);
  console.log(f, 'warm-bright px', r.warm, `(${(100 * r.warm / r.n).toFixed(2)}% of ${r.n})`);
}
await b.close();
