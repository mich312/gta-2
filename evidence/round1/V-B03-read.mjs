import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const files = process.argv.slice(2);
const pts = [[640,150],[700,60],[460,470],[500,500]];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
for (const f of files) {
  const data = readFileSync(f).toString('base64');
  const res = await p.evaluate(async ({ data, pts }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const out = { size: [img.width, img.height], px: [], hist: 0, total: 0 };
    for (const [px, py] of pts) {
      const d = x.getImageData(px, py, 1, 1).data;
      out.px.push([px, py, d[0], d[1], d[2]]);
    }
    // whole-frame luma histogram, HUD-masked: skip bottom 120 rows and top 60 rows
    const all = x.getImageData(0, 0, img.width, img.height).data;
    let below = 0, total = 0;
    for (let yy = 60; yy < img.height - 120; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const i = (yy * img.width + xx) * 4;
        const l = 0.2126*all[i] + 0.7152*all[i+1] + 0.0722*all[i+2];
        if (l < 32) below++;
        total++;
      }
    }
    out.hist = below / total; out.total = total;
    return out;
  }, { data, pts });
  console.log(f, JSON.stringify(res.size));
  for (const q of res.px) {
    const l = (0.2126*q[2] + 0.7152*q[3] + 0.0722*q[4]).toFixed(1);
    const r = Math.hypot(q[0]-res.size[0]/2, q[1]-res.size[1]/2).toFixed(1);
    console.log(`  (${q[0]},${q[1]}) rgb(${q[2]},${q[3]},${q[4]}) luma=${l} r=${r}`);
  }
  console.log(`  frac below luma32 (rows 60..h-120): ${(res.hist*100).toFixed(1)}%`);
}
await b.close();
