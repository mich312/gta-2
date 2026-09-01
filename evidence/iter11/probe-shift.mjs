// How far a candidate course moves the authored one, and how much dry margin
// it keeps. Answers "is this reroute minimal" with a number.
//   node evidence/iter11/probe-shift.mjs '<json points>'
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan, smoothPolyline } from '../../shared/dist/index.js';

const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const L = buildLayout(plan);
const { widthTiles: W, heightTiles: H, water } = L;
const old = smoothPolyline(
  plan.roads.find((r) => r.name === 'Coast Road').points,
  3,
);
const neu = smoothPolyline(JSON.parse(process.argv[2]), 3);

const sample = (pts) => {
  const out = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d));
    for (let s = 0; s < n; s++) out.push([ax + (bx - ax) * (s / n), ay + (by - ay) * (s / n)]);
  }
  out.push(pts[pts.length - 1]);
  return out;
};
const A = sample(old);
const B = sample(neu);
const nearest = (p, set) => Math.min(...set.map(([x, y]) => Math.hypot(x - p[0], y - p[1])));

let max = 0;
let at = null;
let sum = 0;
for (const p of B) {
  const d = nearest(p, A);
  sum += d;
  if (d > max) {
    max = d;
    at = p.map(Math.round);
  }
}
console.log(`course moved: mean ${(sum / B.length).toFixed(1)} tiles, max ${max.toFixed(0)} at ${at}`);

const wet = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? true : water[y * W + x] === 1);
const margin = (x, y) => {
  if (wet(x, y)) return -1;
  for (let r = 1; r <= 14; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (wet(x + dx, y + dy)) return r - 1;
      }
    }
  }
  return 14;
};
const tight = [];
for (const [x, y] of B) {
  const m = margin(Math.round(x), Math.round(y));
  if (m < 3) tight.push([Math.round(x), Math.round(y), m]);
}
console.log(`samples with dry margin < 3: ${tight.length}`);
for (const t of tight.slice(0, 40)) console.log(`  ${t[0]},${t[1]}  margin ${t[2]}`);
