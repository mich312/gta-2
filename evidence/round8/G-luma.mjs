/**
 * Mean luminance of a plate, so "this one looks darker than that one" stops
 * being a matter of opinion.
 *
 *   node evidence/round8/G-luma.mjs <a.png> [b.png ...]
 *
 * The PNG decoder is `evidence/round1/D-pngdiff.mjs`'s, imported rather than
 * copied.
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decode(path) {
  const buf = readFileSync(path);
  let off = 8;
  let w = 0,
    h = 0,
    bd = 0,
    ct = 0;
  const idat = [];
  let plte = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (bd !== 8) throw new Error('bitdepth ' + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 3 ? 1 : ct === 4 ? 2 : 0;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0,
        b = prev[x],
        c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c,
          pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, plte, ct, px: out };
}

for (const path of process.argv.slice(2)) {
  const im = decode(path);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < im.px.length; i += im.ch) {
    let r, g, b;
    if (im.ct === 3) {
      const j = im.px[i] * 3;
      r = im.plte[j];
      g = im.plte[j + 1];
      b = im.plte[j + 2];
    } else if (im.ct === 0 || im.ct === 4) {
      r = g = b = im.px[i];
    } else {
      r = im.px[i];
      g = im.px[i + 1];
      b = im.px[i + 2];
    }
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    n++;
  }
  console.log(`${path}: ${im.w}x${im.h} mean luma ${(sum / n).toFixed(1)}/255`);
}
