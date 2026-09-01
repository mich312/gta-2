// Control for the `joins` measure used in population.mjs.
//
// A measure that can only say "joins" proves nothing. Three ways to make it
// go to zero, all on the shipped bake:
//   1. the distribution over all 364 baked road courses — if none reads 0,
//      the measure cannot discriminate;
//   2. a course displaced 40 tiles into open country — must read 0;
//   3. the joins restricted to tiles belonging to ANOTHER baked course, which
//      is the stricter question ("does it meet a street", not "is there
//      tarmac"), reported alongside the loose one for the five hits.
//
//   node evidence/iter10/joins-control.mjs
import { S, loadBake, NEW } from './lib.mjs';
const { T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const clen = (p) => { let l = 0; for (let k = 1; k < p.length; k++) l += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]); return l; };
function distTo(pts, x, y) {
  let best = Infinity, bt = 0, acc = 0;
  const total = clen(pts);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) { best = d; bt = total === 0 ? 0 : (acc + Math.sqrt(l2) * t) / total; }
    acc += Math.sqrt(l2);
  }
  return [best, bt];
}
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');

function joins(pts, width, otherOnly = false, selfIdx = -1) {
  const half = width / 2 + 0.5;
  const own = new Set();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys)) - 4); y <= Math.min(H - 1, Math.ceil(Math.max(...ys)) + 4); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs)) - 4); x <= Math.min(W - 1, Math.ceil(Math.max(...xs)) + 4); x++)
      if (isRoad(at(x, y)) && distTo(pts, x + 0.5, y + 0.5)[0] <= half) own.add(y * W + x);
  let a = 0, m = 0, b = 0;
  for (const k of own) {
    const x = k % W, y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (own.has(ny * W + nx) || !isRoad(at(nx, ny))) continue;
      if (otherOnly) {
        const onOther = roads.some((o) => o.i !== selfIdx && distTo(o.points, nx + 0.5, ny + 0.5)[0] <= o.width / 2 + 0.5);
        if (!onOther) continue;
      }
      const t = distTo(pts, x + 0.5, y + 0.5)[1];
      t < 0.15 ? a++ : t > 0.85 ? b++ : m++;
    }
  }
  return { a, m, b, own: own.size };
}

/* ---- control 1: the distribution over every baked road course ------ */
let zero = 0, endsZero = 0;
const hist = new Map();
for (const c of roads) {
  const j = joins(c.points, c.width);
  const tot = j.a + j.m + j.b;
  if (tot === 0) zero++;
  if (j.a === 0 && j.b === 0) endsZero++;
  hist.set(tot, (hist.get(tot) ?? 0) + 1);
}
console.log(`CONTROL 1 — distribution over all ${roads.length} baked road courses`);
console.log(`  courses with ZERO joining tarmac anywhere:      ${zero}`);
console.log(`  courses with zero at BOTH ends (a=0 and b=0):   ${endsZero}`);
console.log(`  => the measure ${zero > 0 || endsZero > 0 ? 'CAN read zero' : 'NEVER reads zero — BROKEN, it cannot discriminate'}`);

/* ---- control 2: a course displaced into open country --------------- */
const probe = roads.find((c) => clen(c.points) > 8 && clen(c.points) < 20);
for (const shift of [[0, 0], [0, -40], [40, 40], [-60, 0]]) {
  const moved = probe.points.map(([x, y]) => [x + shift[0], y + shift[1]]);
  const j = joins(moved, probe.width);
  console.log(`CONTROL 2 — course #${probe.i} shifted by ${shift[0]},${shift[1]}: own=${j.own} joins a/m/b = ${j.a}/${j.m}/${j.b}`);
}

/* ---- control 3: strict "meets another COURSE" for the five --------- */
console.log('\nCONTROL 3 — the five hits, loose (any tarmac) vs strict (tarmac belonging to another baked course)');
function tarmacBeyond(x, y, dx, dy, half, limit) {
  const px = -dy, py = dx;
  const steps = Math.max(1, Math.round(half * 2));
  for (let s = 1; s <= limit + 1; s++) {
    let any = false;
    for (let k = 0; k <= steps && !any; k++) {
      const off = -half + (k * half * 2) / steps;
      if (isRoad(at(Math.floor(x + dx * s + px * off), Math.floor(y + dy * s + py * off)))) any = true;
    }
    if (!any) return s - 1;
  }
  return Infinity;
}
for (const c of roads) {
  const len = clen(c.points);
  if (len < 4 || len >= 20.000001) continue;
  const p0 = c.points[0], p1 = c.points[1];
  const q1 = c.points[c.points.length - 1], q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  const met = (x, y) => roads.some((o) => o.i !== c.i && distTo(o.points, x, y)[0] <= 2);
  if (met(p0[0], p0[1]) || met(q1[0], q1[1])) continue;
  const half = c.width / 2;
  if (tarmacBeyond(p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0, half, 3) > 3) continue;
  if (tarmacBeyond(q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1, half, 3) > 3) continue;
  const loose = joins(c.points, c.width);
  const strict = joins(c.points, c.width, true, c.i);
  console.log(`  #${c.i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)}  loose a/m/b ${loose.a}/${loose.m}/${loose.b}   strict a/m/b ${strict.a}/${strict.m}/${strict.b}`);
}
