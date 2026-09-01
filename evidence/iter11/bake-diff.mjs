// Diff two tile planes dumped by bake-dump.mjs: total changed tiles, the
// transitions, and the changed tiles clustered into bounding boxes so a
// "blast radius of zero" claim can be checked rather than believed.
//   node evidence/iter11/bake-diff.mjs <a.bin> <b.bin>
import { readFileSync } from 'node:fs';

const W = 768;
const a = readFileSync(process.argv[2]);
const b = readFileSync(process.argv[3]);
if (a.length !== b.length) throw new Error('size mismatch');

const NAME = {
  0: 'FIELD', 1: 'ROAD', 2: 'SIDEWALK', 3: 'BUILDING', 4: 'PARK', 5: 'LOT',
  6: 'WATER', 7: 'BRIDGE', 9: 'FLOOR', 10: 'BANK', 11: 'TREES', 12: 'SAND',
  13: 'RUNWAY',
};
const kinds = new Map();
const pts = [];
for (let i = 0; i < a.length; i++) {
  if (a[i] === b[i]) continue;
  const k = `${NAME[a[i]] ?? a[i]} -> ${NAME[b[i]] ?? b[i]}`;
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
  pts.push([i % W, (i - (i % W)) / W]);
}
console.log(`changed tiles: ${pts.length} of ${a.length}`);
for (const [k, n] of [...kinds].sort((p, q) => q[1] - p[1])) console.log(`  ${n.toString().padStart(6)}  ${k}`);

// Cluster by 24-tile grid cells, then merge touching cells into boxes.
const cell = 24;
const cells = new Set(pts.map(([x, y]) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`));
const seen = new Set();
const boxes = [];
for (const c of cells) {
  if (seen.has(c)) continue;
  const bag = [c];
  seen.add(c);
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let q = 0; q < bag.length; q++) {
    const [cx, cy] = bag[q].split(',').map(Number);
    x0 = Math.min(x0, cx); y0 = Math.min(y0, cy);
    x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = `${cx + dx},${cy + dy}`;
        if (cells.has(n) && !seen.has(n)) { seen.add(n); bag.push(n); }
      }
    }
  }
  let n = 0;
  for (const [x, y] of pts) {
    if (x >= x0 * cell && x < (x1 + 1) * cell && y >= y0 * cell && y < (y1 + 1) * cell) n++;
  }
  boxes.push({ box: [x0 * cell, y0 * cell, (x1 + 1) * cell - 1, (y1 + 1) * cell - 1], n });
}
boxes.sort((p, q) => q.n - p.n);
console.log(`regions: ${boxes.length}`);
for (const bx of boxes) console.log(`  ${String(bx.n).padStart(6)} tiles in [${bx.box.join(', ')}]`);
