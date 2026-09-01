// Measure, for each authored bridging course, the water the bake actually
// refused: the per-tile `shortest` axis run that trimBridges compares to
// maxBridgeSpan, and the along-course water run.
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan, roadCourses } from '../../shared/dist/index.js';

const plan = parseCityPlan(JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')));
const L = buildLayout(plan);
const { widthTiles: W, heightTiles: H, water } = L;
const wet = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 1 : water[y * W + x] === 1);

// trimBridges' own measure, verbatim in spirit.
function shortestRun(tx, ty) {
  const run = (dx, dy) => {
    let n = 1;
    for (let s = 1; ; s++) { const x = tx + dx * s, y = ty + dy * s; if (x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] !== 1) break; n++; }
    for (let s = 1; ; s++) { const x = tx - dx * s, y = ty - dy * s; if (x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] !== 1) break; n++; }
    return n;
  };
  return Math.min(run(0, 1), run(1, 0), Math.round(run(1, 1) * 1.414), Math.round(run(1, -1) * 1.414));
}

const NAMES = process.argv.slice(2);
for (const road of plan.roads) {
  if (!road.bridges) continue;
  if (NAMES.length && !NAMES.includes(road.name)) continue;
  console.log(`\n=== ${road.name} (width ${road.width})`);
  // sample the resolved course(s) the checker uses
  for (const pts of roadCourses(road)) {
    let runStart = null, maxShort = 0, len = 0;
    const report = [];
    let prev = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      const d = Math.hypot(bx - ax, by - ay); if (!d) continue;
      const steps = Math.max(1, Math.ceil(d * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const tx = Math.round(x), ty = Math.round(y);
        const w = wet(tx, ty);
        if (w) {
          if (runStart === null) { runStart = [tx, ty]; maxShort = 0; len = 0; }
          len += d / steps;
          maxShort = Math.max(maxShort, shortestRun(tx, ty));
          prev = [tx, ty];
        } else if (runStart !== null) {
          report.push({ from: runStart, to: prev, len, maxShort });
          runStart = null;
        }
      }
    }
    if (runStart !== null) report.push({ from: runStart, to: prev, len, maxShort, open: true });
    for (const r of report) {
      if (r.len < 3) continue;
      console.log(`  water run ${r.from} -> ${r.to}  along-course ${r.len.toFixed(0)}  worst per-tile shortest-axis run ${r.maxShort}${r.open ? '  (RUNS OFF THE END)' : ''}`);
    }
  }
}
