// ASCII dump of the water mask with the authored courses overlaid.
//   node evidence/iter11/probe-map.mjs <x0> <y0> <x1> <y1> <step>
// '.' all water   '#' all land   '+' mixed   C/R/M = Coast Road / Ring / Marsh
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan, roadCourses } from '../../shared/dist/index.js';

const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const L = buildLayout(plan);
const { widthTiles: W, water } = L;
const [x0, y0, x1, y1, step] = process.argv.slice(2).map(Number);

const names = new Map([
  ['Coast Road', 'C'],
  ['The Ring', 'R'],
  ['Marsh Causeway', 'M'],
]);
const mark = new Map();
for (const road of plan.roads) {
  const ch = names.get(road.name);
  if (!ch) continue;
  for (const pts of roadCourses(road)) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const d = Math.hypot(bx - ax, by - ay) || 1;
      const n = Math.ceil(d * 2);
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        mark.set(`${Math.round(ax + (bx - ax) * t)},${Math.round(ay + (by - ay) * t)}`, ch);
      }
    }
  }
}

console.log(`cols ${x0}..${x1} step ${step}   rows ${y0}..${y1}`);
for (let y = y0; y <= y1; y += step) {
  let line = String(y).padStart(4) + ' ';
  for (let x = x0; x <= x1; x += step) {
    let m = null;
    let anyLand = false;
    let anyWet = false;
    for (let dy = 0; dy < step; dy++) {
      for (let dx = 0; dx < step; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= W || py >= L.heightTiles) continue;
        if (mark.has(`${px},${py}`)) m = mark.get(`${px},${py}`);
        if (water[py * W + px] === 1) anyWet = true;
        else anyLand = true;
      }
    }
    line += m ?? (anyLand ? (anyWet ? '+' : '#') : '.');
  }
  console.log(line);
}
