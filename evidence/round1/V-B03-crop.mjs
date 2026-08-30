import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
const [outPath, ...files] = process.argv.slice(2);
const pts = [[640,150],[700,60],[460,470],[500,500]];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const datas = files.map(f => readFileSync(f).toString('base64'));
const png = await p.evaluate(async ({ datas, pts }) => {
  const S = 100; // crop size
  const c = document.createElement('canvas');
  c.width = S * pts.length; c.height = S * datas.length;
  const x = c.getContext('2d');
  for (let r = 0; r < datas.length; r++) {
    const img = new Image(); img.src = 'data:image/png;base64,' + datas[r]; await img.decode();
    for (let k = 0; k < pts.length; k++) {
      x.drawImage(img, pts[k][0]-S/2, pts[k][1]-S/2, S, S, k*S, r*S, S, S);
      x.strokeStyle = '#ff00ff'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(k*S+S/2-6, r*S+S/2); x.lineTo(k*S+S/2-2, r*S+S/2);
      x.moveTo(k*S+S/2+2, r*S+S/2); x.lineTo(k*S+S/2+6, r*S+S/2);
      x.moveTo(k*S+S/2, r*S+S/2-6); x.lineTo(k*S+S/2, r*S+S/2-2);
      x.moveTo(k*S+S/2, r*S+S/2+2); x.lineTo(k*S+S/2, r*S+S/2+6); x.stroke();
      x.strokeStyle = '#00ff00'; x.strokeRect(k*S+0.5, r*S+0.5, S-1, S-1);
    }
  }
  return c.toDataURL('image/png').split(',')[1];
}, { datas, pts });
writeFileSync(outPath, Buffer.from(png, 'base64'));
await b.close();
