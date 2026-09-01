// Try a candidate control polygon for one road against the real water mask,
// without rebaking: report, along the smoothed course, the wet runs and how
// much dry margin each sample has.
//   node evidence/iter11/probe-try.mjs '<json array of [x,y]>' [curve]
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan, smoothPolyline } from '../../shared/dist/index.js';

const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const L = buildLayout(plan);
const { widthTiles: W, heightTiles: H, water } = L;
const wet = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? true : water[y * W + x] === 1);

const raw = JSON.parse(process.argv[2]);
const curve = process.argv[3] !== 'false';
const pts = curve ? smoothPolyline(raw, 3) : raw;

// Chebyshev distance to the nearest wet tile: how much dry margin the
// centreline has. A width-4 road wants >= 2.
const margin = (x, y) => {
  if (wet(x, y)) return -1;
  for (let r = 1; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (wet(x + dx, y + dy)) return r - 1;
      }
    }
  }
  return 12;
};

function shortestRun(tx, ty) {
  const run = (dx, dy) => {
    let n = 1;
    for (let s = 1; ; s++) {
      const x = tx + dx * s;
      const y = ty + dy * s;
      if (x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] !== 1) break;
      n++;
    }
    for (let s = 1; ; s++) {
      const x = tx - dx * s;
      const y = ty - dy * s;
      if (x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] !== 1) break;
      n++;
    }
    return n;
  };
  return Math.min(run(0, 1), run(1, 0), Math.round(run(1, 1) * 1.414), Math.round(run(1, -1) * 1.414));
}

let runStart = null;
let maxShort = 0;
let len = 0;
let prev = null;
let worstMargin = 99;
let worstAt = null;
let total = 0;
const out = [];
for (let k = 0; k + 1 < pts.length; k++) {
  const [ax, ay] = pts[k];
  const [bx, by] = pts[k + 1];
  const d = Math.hypot(bx - ax, by - ay);
  if (!d) continue;
  const steps = Math.max(1, Math.ceil(d * 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const tx = Math.round(ax + (bx - ax) * t);
    const ty = Math.round(ay + (by - ay) * t);
    total += d / steps;
    if (wet(tx, ty)) {
      if (runStart === null) {
        runStart = [tx, ty];
        maxShort = 0;
        len = 0;
      }
      len += d / steps;
      maxShort = Math.max(maxShort, shortestRun(tx, ty));
      prev = [tx, ty];
    } else {
      const m = margin(tx, ty);
      if (m < worstMargin) {
        worstMargin = m;
        worstAt = [tx, ty];
      }
      if (runStart !== null) {
        out.push({ from: runStart, to: prev, len, maxShort });
        runStart = null;
      }
    }
  }
}
if (runStart !== null) out.push({ from: runStart, to: prev, len, maxShort, open: true });
console.log(`course length ${total.toFixed(0)} tiles; ${out.length} wet run(s)`);
for (const r of out) {
  if (r.len < 1) continue;
  console.log(
    `  wet ${r.from} -> ${r.to}  len ${r.len.toFixed(0)}  worst shortest-axis run ${r.maxShort}` +
      `${r.open ? '  (RUNS OFF THE END)' : ''}`,
  );
}
console.log(`  tightest dry margin on the centreline: ${worstMargin} tiles at ${worstAt}`);
