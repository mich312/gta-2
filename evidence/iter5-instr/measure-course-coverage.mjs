// City-wide course coverage, by the measure WORLDGEN.md §26.1 uses:
// what fraction of CARRIAGEWAY tiles lie under a non-`path` course.
//
// The rule is not re-derived. `courseCoverPlane` and `isRoad` below are
// transcribed from `server/src/tools/mapAudit.ts` (signature 12,
// `course-coverage-outlier`), which is itself a copy of the renderer's own
// `courseCover` in `client/src/render/tiles.ts` — the tile centre within
// `width / 2 + 0.05` of a non-`path` centreline. §26.1 measures the same
// thing city-wide.
//
// THE CONTROL: a transcribed rule can be transcribed wrong, so this also
// re-derives the audit's per-borough table and prints it beside the numbers
// `pnpm mapaudit --only=course-coverage-outlier` and
// evidence/iter4/coverage-after.txt report. If the boroughs do not match to
// a tenth of a percent, the instrument is wrong and the city-wide number
// below it means nothing.
//
// Run from the repo root: node evidence/iter5-instr/measure-course-coverage.mjs
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity,
  parseCityPlan,
  pointInPoly,
  T_BRIDGE,
  T_RAMP,
  T_ROAD,
  T_WATER,
} from '../../shared/dist/index.js';

// `--data=path` measures another bake — how the before/after below was taken.
const DATA =
  process.argv.slice(2).find((a) => a.startsWith('--data='))?.slice(7) ??
  'shared/src/world/city.data.ts';
const PLAN =
  process.argv.slice(2).find((a) => a.startsWith('--plan='))?.slice(7) ??
  'shared/data/city-plan.json';

function loadBake(path) {
  const src = readFileSync(path, 'utf8');
  const a = src.indexOf('"');
  const b = src.lastIndexOf('"');
  return decodeBakedCity(JSON.parse(JSON.parse(src.slice(a, b + 1))));
}

const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

function courseCoverPlane(city) {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const cover = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind === 'path') continue;
    const inner = c.width / 2 + 0.05;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k];
      const [bx, by] = c.points[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - inner - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + inner + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - inner - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + inner + 1));
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const px = tx + 0.5 - ax;
          const py = ty + 0.5 - ay;
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
          const qx = px - t * dx;
          const qy = py - t * dy;
          if (qx * qx + qy * qy <= inner * inner) cover[ty * W + tx] = 1;
        }
      }
    }
  }
  return cover;
}

// `ownerPlane` from mapAudit.ts:1579, transcribed including the flood fill
// that hands unowned dry land to the borough beside it.
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
function ownerPlane(plan, tiles, W, H) {
  const owner = new Int16Array(W * H).fill(-1);
  for (const [di, d] of plan.districts.entries()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of d.area) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
      for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
        if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
      }
    }
  }
  const bag = [];
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] >= 0 && tiles[i] !== T_WATER) bag.push(i);
  }
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (tiles[j] === T_WATER || owner[j] >= 0) continue;
      owner[j] = owner[i];
      bag.push(j);
    }
  }
  return owner;
}

const city = loadBake(DATA);
const plan = parseCityPlan(JSON.parse(readFileSync(PLAN, 'utf8')));
const W = city.widthTiles;
const H = city.heightTiles;
const cover = courseCoverPlane(city);

// ---- the §26.1 number: every carriageway tile in the city, borough or not.
let road = 0;
let covered = 0;
for (let i = 0; i < city.tiles.length; i++) {
  if (!isRoad(city.tiles[i])) continue;
  road++;
  if (cover[i] === 1) covered++;
}

// ---- the control: the audit's own per-borough table.
const owner = ownerPlane(plan, city.tiles, W, H);
const n = plan.districts.length;
const bRoad = new Int32Array(n);
const bCov = new Int32Array(n);
for (let i = 0; i < city.tiles.length; i++) {
  if (!isRoad(city.tiles[i])) continue;
  const d = owner[i];
  if (d < 0) continue;
  bRoad[d]++;
  if (cover[i] === 1) bCov[d]++;
}
const rows = [];
for (const [di, d] of plan.districts.entries()) {
  if (bRoad[di] < 500) continue; // COVERAGE_MIN_ROAD
  rows.push({ name: d.name, road: bRoad[di], covered: bCov[di], rate: bCov[di] / bRoad[di] });
}
rows.sort((a, b) => a.rate - b.rate);

console.log(`bake: ${DATA}`);
console.log('CONTROL — per-borough, the audit\'s own rated boroughs:');
console.log('district                  road  covered    rate');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(22)}${String(r.road).padStart(6)}${String(r.covered).padStart(9)}` +
      `${(100 * r.rate).toFixed(1).padStart(8)}%`,
  );
}
const sorted = rows.map((r) => r.rate).sort((a, b) => a - b);
console.log(`rated boroughs ${rows.length}  MEDIAN rate ${(100 * sorted[Math.floor(sorted.length / 2)]).toFixed(1)}%`);
const bTot = rows.reduce((s, r) => s + r.road, 0);
const bCovTot = rows.reduce((s, r) => s + r.covered, 0);
console.log(`rated-borough coverage ${bCovTot} / ${bTot} = ${(100 * bCovTot / bTot).toFixed(1)}%`);
console.log();
console.log('THE §26.1 MEASURE — every carriageway tile in the city:');
console.log(`courses cover ${covered} of ${road} carriageway tiles = ${(100 * covered / road).toFixed(1)}%`);
console.log(`courses: ${city.courses.length} total, ${city.courses.filter((c) => c.kind !== 'path').length} non-path`);
const kinds = {};
for (const c of city.courses) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
console.log(`kinds ${JSON.stringify(kinds)}`);
