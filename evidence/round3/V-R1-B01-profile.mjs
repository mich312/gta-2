import { chromium } from '/home/user/gta-2/node_modules/playwright/index.mjs';
import { readFileSync } from 'fs';
// profile.mjs y x0 x1 file... -> prints luma along a horizontal scanline for each file
const [Y, X0, X1, ...files] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const rows = [];
for (const f of files) {
  const data = readFileSync(f).toString('base64');
  const r = await p.evaluate(async ({ data, Y, X0, X1 }) => {
    const img = new Image(); img.src='data:image/png;base64,'+data; await img.decode();
    const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
    const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(img,0,0);
    const d=x.getImageData(X0,Y,X1-X0,1).data; const out=[];
    for(let i=0;i<X1-X0;i++){const j=i*4;out.push(+(0.2126*d[j]+0.7152*d[j+1]+0.0722*d[j+2]).toFixed(0));}
    return out;
  }, { data, Y:+Y, X0:+X0, X1:+X1 });
  rows.push([f.split('/').pop(), r]);
}
const n = rows[0][1].length;
let head = 'x    '; for (let i=0;i<n;i+=4) head += String(+X0+i).padStart(6);
console.log(head);
for (const [name, r] of rows) {
  let s = name.padEnd(30).slice(0,30); let line='';
  for (let i=0;i<n;i+=4) line += String(r[i]).padStart(6);
  console.log(s + line);
}
await b.close();
