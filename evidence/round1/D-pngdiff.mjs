import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decode(path) {
  const buf = readFileSync(path);
  let off = 8; let w=0,h=0,bd=0,ct=0; const idat=[];
  let plte=null, trns=null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off+4, off+8);
    const data = buf.subarray(off+8, off+8+len);
    if (type === 'IHDR') { w=data.readUInt32BE(0); h=data.readUInt32BE(4); bd=data[8]; ct=data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (bd !== 8) throw new Error('bitdepth '+bd+' unsupported for '+path);
  const ch = ct===6?4:ct===2?3:ct===0?1:ct===3?1:ct===4?2:0;
  if (!ch) throw new Error('colortype '+ct);
  const stride = w*ch;
  const out = Buffer.alloc(h*stride);
  let p=0;
  for (let y=0;y<h;y++){
    const f = raw[p++];
    const line = raw.subarray(p, p+stride); p+=stride;
    const prev = y>0 ? out.subarray((y-1)*stride, y*stride) : Buffer.alloc(stride);
    const cur = out.subarray(y*stride, (y+1)*stride);
    for (let x=0;x<stride;x++){
      const a = x>=ch ? cur[x-ch] : 0, b = prev[x], c = x>=ch ? prev[x-ch] : 0;
      let v = line[x];
      if (f===1) v += a; else if (f===2) v += b; else if (f===3) v += ((a+b)>>1);
      else if (f===4){ const pp=a+b-c, pa=Math.abs(pp-a), pb=Math.abs(pp-b), pc=Math.abs(pp-c);
        v += (pa<=pb && pa<=pc)?a:(pb<=pc?b:c); }
      cur[x]=v&255;
    }
  }
  // expand palette
  if (ct===3 && plte) {
    const rgba = Buffer.alloc(w*h*4);
    for (let i=0;i<w*h;i++){ const idx=out[i]; rgba[i*4]=plte[idx*3]; rgba[i*4+1]=plte[idx*3+1]; rgba[i*4+2]=plte[idx*3+2]; rgba[i*4+3]= trns && idx<trns.length ? trns[idx] : 255; }
    return {w,h,ch:4,px:rgba};
  }
  return {w,h,ch,px:out};
}

const [a,b,diffOut] = process.argv.slice(2);
const A = decode(a), B = decode(b);
if (A.w!==B.w||A.h!==B.h) { console.log(`SIZE DIFFER ${a} ${A.w}x${A.h} vs ${b} ${B.w}x${B.h}`); process.exit(0); }
let n=0, maxd=0; const px=A.w*A.h;
const mask = Buffer.alloc(px*4);
for (let i=0;i<px;i++){
  let d=0;
  for (let c=0;c<Math.min(A.ch,B.ch);c++) d=Math.max(d, Math.abs(A.px[i*A.ch+c]-B.px[i*B.ch+c]));
  if (d>0){ n++; maxd=Math.max(maxd,d); mask[i*4]=255; mask[i*4+1]=0; mask[i*4+2]=0; mask[i*4+3]=255; }
  else { const g = A.px[i*A.ch]; mask[i*4]=g; mask[i*4+1]=g; mask[i*4+2]=g; mask[i*4+3]=255; }
}
console.log(`${a} vs ${b}: ${A.w}x${A.h} differing px ${n}/${px} (${(100*n/px).toFixed(3)}%) maxchan ${maxd}`);
if (diffOut && n>0) {
  const { encodePng } = await import('/home/user/gta-2/server/dist/tools/png.js');
  writeFileSync(diffOut, encodePng(A.w, A.h, new Uint8Array(mask)));
  console.log('wrote '+diffOut);
}
