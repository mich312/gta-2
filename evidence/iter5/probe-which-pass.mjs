// Which pass lays the carriageway on ground no district polygon claims?
//
// Needs the temporary `__LAYOUT_PROBE__` hook in layout.ts's pass loop; it is
// NOT in the shipped tree. To retake:
//   git stash is forbidden here (see .claude/review/FIXER.md) — instead patch
//   the pass loop in shared/src/world/layout.ts to call
//   globalThis.__LAYOUT_PROBE__?.(pass.name, tiles) after each pass, rebuild,
//   run this, then restore the file from a copy taken aside first.
import { plan, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, pointInPoly, buildLayout } = S;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const W = plan.widthTiles,
  H = plan.heightTiles;

const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [px, py] of d.area) {
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (!inPoly[i] && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[i] = 1;
    }
}

// The two regions the finding names, as rects.
const REGIONS = [
  ['A headland', 393, 312, 549, 365],
  ['B shoulder', 267, 312, 365, 375],
];

const rows = [];
globalThis.__LAYOUT_PROBE__ = (name, tiles) => {
  const row = [name];
  let outAll = 0;
  for (let i = 0; i < W * H; i++) if (!inPoly[i] && tiles[i] !== T_WATER && isRoad(tiles[i])) outAll++;
  row.push(outAll);
  for (const [, x0, y0, x1, y1] of REGIONS) {
    let n = 0;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const i = ty * W + tx;
        if (!inPoly[i] && isRoad(tiles[i])) n++;
      }
    row.push(n);
  }
  rows.push(row);
};

buildLayout(plan);

console.log('carriageway laid on land outside every district polygon, after each pass:');
console.log(`  ${'pass'.padEnd(20)} ${'city-wide'.padStart(9)} ${'A headland'.padStart(11)} ${'B shoulder'.padStart(11)}`);
let prev = [0, 0, 0];
for (const [name, ...c] of rows) {
  const delta = c.map((v, k) => v - prev[k]);
  console.log(
    `  ${name.padEnd(20)} ${String(c[0]).padStart(9)} ${String(c[1]).padStart(11)} ${String(c[2]).padStart(11)}   (+${delta.join(', +')})`,
  );
  prev = c;
}
