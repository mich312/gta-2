// Locate the islets in `evidence/final-review/islet-zoom.png` by their shape,
// so the new `landuse-staircase` signature can be checked against the picture
// that motivated it rather than against itself.
//
//   node evidence/iter11-instrument/probe-islets.mjs
import { readFileSync } from 'node:fs';
import { decodeBakedCity, T_WATER, T_TREES, T_SAND, T_FIELD } from '../../shared/dist/index.js';

const s = readFileSync('shared/src/world/city.data.ts', 'utf8');
const a = s.indexOf('"');
const b = s.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(s.slice(a, b + 1))));
const W = city.widthTiles;
const H = city.heightTiles;
const t = city.tiles;

const seen = new Uint8Array(W * H);
const out = [];
for (let i = 0; i < t.length; i++) {
  if (seen[i] || t[i] === T_WATER) continue;
  const bag = [i];
  seen[i] = 1;
  for (let k = 0; k < bag.length; k++) {
    const j = bag[k];
    const x = j % W;
    const y = (j - x) / W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (seen[n] || t[n] === T_WATER) continue;
      seen[n] = 1;
      bag.push(n);
    }
  }
  if (bag.length > 4000 || bag.length < 60) continue;
  let x0 = W;
  let y0 = H;
  let x1 = 0;
  let y1 = 0;
  let wood = 0;
  let sand = 0;
  let field = 0;
  for (const j of bag) {
    const x = j % W;
    const y = (j - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (t[j] === T_TREES) wood++;
    else if (t[j] === T_SAND) sand++;
    else if (t[j] === T_FIELD) field++;
  }
  if (wood < 20) continue;
  out.push({ n: bag.length, x0, y0, x1, y1, wood, sand, field });
}
out.sort((p, q) => q.n - p.n);
for (const o of out) {
  console.log(
    `island ${String(o.n).padStart(5)} tiles  bbox ${o.x0},${o.y0}..${o.x1},${o.y1}` +
      `  (${o.x1 - o.x0 + 1}x${o.y1 - o.y0 + 1})  wood ${o.wood} sand ${o.sand} field ${o.field}`,
  );
}
