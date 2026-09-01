// Tile-class delta between two bakes, with the carriageway called out.
//
//   node evidence/iter8-country/measure-tile-diff.mjs OLD.city.data.ts NEW.city.data.ts
//
// Carriageway is ROAD | BRIDGE | RAMP, the same set iteration 7's watch uses,
// so "no road moved" here means the same thing it means there.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const NAME = Object.fromEntries(
  Object.entries(S).filter(([k, v]) => k.startsWith('T_') && typeof v === 'number').map(([k, v]) => [v, k]),
);
const load = (p) => {
  const src = readFileSync(p, 'utf8');
  return S.decodeBakedCity(
    JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
  );
};
const a = load(process.argv[2]);
const b = load(process.argv[3]);
const W = a.widthTiles;
const carriage = new Set([S.T_ROAD, S.T_BRIDGE, S.T_RAMP].filter((v) => v !== undefined));
const trans = new Map();
let n = 0;
let road = 0;
let x0 = 1e9;
let y0 = 1e9;
let x1 = -1;
let y1 = -1;
for (let i = 0; i < a.tiles.length; i++) {
  if (a.tiles[i] === b.tiles[i]) continue;
  n++;
  const k = `${NAME[a.tiles[i]]}->${NAME[b.tiles[i]]}`;
  trans.set(k, (trans.get(k) ?? 0) + 1);
  if (carriage.has(a.tiles[i]) || carriage.has(b.tiles[i])) road++;
  const x = i % W;
  const y = (i - x) / W;
  if (x < x0) x0 = x;
  if (y < y0) y0 = y;
  if (x > x1) x1 = x;
  if (y > y1) y1 = y;
}
console.log(`${n} tiles changed; ${road} of them carriageway (ROAD|BRIDGE|RAMP)`);
if (n > 0) console.log(`bounding box ${x0},${y0}-${x1},${y1}`);
for (const [k, v] of [...trans].sort((u, v2) => v2[1] - u[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
if (process.env.CLUSTER) {
  const ch = [];
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) ch.push(i);
  const set = new Set(ch);
  const seen = new Set();
  const runs = [];
  for (const s0 of ch) {
    if (seen.has(s0)) continue;
    const bag = [s0];
    seen.add(s0);
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q];
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const j = (y + dy) * W + x + dx;
          if (set.has(j) && !seen.has(j)) { seen.add(j); bag.push(j); }
        }
      }
    }
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (const j of bag) { const jx = j % W, jy = (j - jx) / W;
      if (jx < bx0) bx0 = jx; if (jy < by0) by0 = jy; if (jx > bx1) bx1 = jx; if (jy > by1) by1 = jy; }
    runs.push({ n: bag.length, bx0, by0, bx1, by1 });
  }
  runs.sort((u, v2) => v2.n - u.n);
  console.log(`${runs.length} clusters of changed tiles (3-tile gap tolerance):`);
  for (const r of runs.slice(0, 12))
    console.log(`   ${String(r.n).padStart(4)} tiles  ${r.bx0},${r.by0}-${r.bx1},${r.by1}   --crop=${Math.max(0, Math.round((r.bx0 + r.bx1) / 2) - 30)},${Math.max(0, Math.round((r.by0 + r.by1) / 2) - 30)},60`);
}
console.log(`blocks ${a.blocks.length} -> ${b.blocks.length}, buildings ${a.buildings.length} -> ${b.buildings.length}`);
