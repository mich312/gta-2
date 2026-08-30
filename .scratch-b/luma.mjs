import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const files = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
for (const f of files) {
  const b64 = readFileSync(f).toString('base64');
  const r = await p.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    // World only: skip the HUD strips (top 40, bottom 80, right 200 above y=160, right 120 below y=560)
    let sum = 0, n = 0;
    const hist = new Array(16).fill(0);
    for (let y = 45; y < img.height - 85; y++) {
      for (let px = 0; px < img.width; px++) {
        if (px > img.width - 210 && y < 165) continue;      // minimap
        if (px > img.width - 130 && y > img.height - 160) continue; // export list
        const i = (y * img.width + px) * 4;
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l; n++;
        hist[Math.min(15, Math.floor(l / 16))]++;
      }
    }
    return { mean: sum / n, n, hist: hist.map((v) => +(100 * v / n).toFixed(1)) };
  }, b64);
  console.log(f, 'mean luma', r.mean.toFixed(1), 'hist%', r.hist.join(' '));
}
await b.close();
