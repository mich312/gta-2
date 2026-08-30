import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [x0,y0,x1,y1] = process.argv.slice(2,6).map(Number);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
for (const f of process.argv.slice(6)) {
  const b64 = readFileSync(f).toString('base64');
  const r = await p.evaluate(async ({b64,x0,y0,x1,y1}) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    const W = img.width;
    const seen = new Uint8Array(W * img.height);
    const isWarm = (px, py) => {
      const i = (py * W + px) * 4;
      const R = d[i], G = d[i+1], B = d[i+2];
      return R > 110 && R - B > 28 && G >= B;
    };
    let blobs = 0, px_ = 0;
    for (let y = y0; y < y1; y++) for (let px = x0; px < x1; px++) {
      if (!isWarm(px, y) || seen[y*W+px]) continue;
      // flood fill
      let size = 0; const st = [[px,y]]; seen[y*W+px] = 1;
      while (st.length) {
        const [cx, cy] = st.pop(); size++;
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx+dx, ny = cy+dy;
          if (nx<x0||ny<y0||nx>=x1||ny>=y1||seen[ny*W+nx]||!isWarm(nx,ny)) continue;
          seen[ny*W+nx] = 1; st.push([nx,ny]);
        }
      }
      if (size >= 4) { blobs++; px_ += size; }
    }
    return { blobs, px_ };
  }, {b64,x0,y0,x1,y1});
  console.log(f, 'warm blobs', r.blobs, 'warm px', r.px_);
}
await b.close();
