// Attribution for `street-serves-nothing`: which layout pass laid each flagged
// course, and — the question the `noisy` label rests on — whether the tarmac
// really stops at both ends or merely leaves the detector's STRAIGHT ray.
//
// Needs the pass hook in `shared/src/world/layout.ts`:
//   for (const pass of passes) { const n0 = courses.length; pass();
//     globalThis.__PASS_PROBE__?.(pass.name, n0, courses.length, tiles); }
// Copy the file aside, patch, build, measure, copy back — never `git stash`.
//
//   node evidence/iter10/attribute-streets.mjs
import { S, loadBake, NEW, plan } from './lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);

/* ---- pass attribution: course index ranges ------------------------- */
const ranges = [];
if (!process.env.NO_PROBE) {
  globalThis.__PASS_PROBE__ = (name, a, b) => {
    if (b > a) ranges.push([name, a, b]);
  };
  buildLayout(plan);
  delete globalThis.__PASS_PROBE__;
  console.log('# course index ranges by pass (control: they must tile [0,%d))', city.courses.length);
  for (const [n, a, b] of ranges) console.log(`#   ${n.padEnd(18)} [${a}, ${b})  n=${b - a}`);
  const covered = ranges.reduce((s, [, a, b]) => s + (b - a), 0);
  console.log(`#   CONTROL total ${covered} vs bake courses ${city.courses.length}` +
    (covered === city.courses.length ? '  OK' : '  MISMATCH'));
}
const passOf = (i) => (ranges.find(([, a, b]) => i >= a && i < b) ?? ['?'])[0];

/* ---- mapAudit's own geometry, reimplemented verbatim --------------- */
function courseLength(c) {
  let len = 0;
  for (let k = 1; k < c.points.length; k++) {
    const [ax, ay] = c.points[k - 1];
    const [bx, by] = c.points[k];
    len += Math.hypot(bx - ax, by - ay);
  }
  return len;
}
function distToCourse(c, x, y) {
  let best = Infinity;
  for (let k = 0; k + 1 < c.points.length; k++) {
    const [ax, ay] = c.points[k];
    const [bx, by] = c.points[k + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) best = d;
  }
  return best;
}
function tarmacBeyond(x, y, dx, dy, half, limit) {
  const px = -dy;
  const py = dx;
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

/* ---- the detector, rerun so the hits are ours, not parsed ---------- */
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');
const MEET = 2;
const MAXLEN = 20.000001; // mapaudit's maxLen; hits run to 19.9
const CAP = 3;
const hits = [];
for (const c of roads) {
  const len = courseLength(c);
  if (len < 4 || len >= MAXLEN) continue;
  const p0 = c.points[0];
  const p1 = c.points[1];
  const q1 = c.points[c.points.length - 1];
  const q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  const met = (x, y) => roads.some((o) => o.i !== c.i && distToCourse(o, x, y) <= MEET);
  if (met(p0[0], p0[1]) || met(q1[0], q1[1])) continue;
  const half = c.width / 2;
  const b0 = tarmacBeyond(p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0, half, CAP);
  const b1 = tarmacBeyond(q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1, half, CAP);
  if (b0 > CAP || b1 > CAP) continue;
  hits.push({ c, len, p0, q1, b0, b1 });
}
console.log(`\n# reproduced ${hits.length} hits (mapaudit reports 5)`);

/* ---- the real question: does the tarmac carry on around a bend? ---- */
// A flood of carriageway from the endpoint that is FORBIDDEN to re-enter the
// street's own swept disc. If it escapes far, the street continues; if it dies
// in a handful of tiles, the endpoint really is a cap.
function escape(c, ex, ey, limit = 60) {
  const half = c.width / 2 + 1.0;
  const own = (x, y) => distToCourse(c, x + 0.5, y + 0.5) <= half;
  // seed: road tiles within 2 of the endpoint that are NOT the street's own
  const seeds = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const x = Math.floor(ex) + dx;
      const y = Math.floor(ey) + dy;
      if (isRoad(at(x, y)) && !own(x, y)) seeds.push([x, y]);
    }
  if (seeds.length === 0) return { tiles: 0, far: 0 };
  const seen = new Set();
  const bag = [];
  for (const [x, y] of seeds) {
    const k = y * W + x;
    if (!seen.has(k)) { seen.add(k); bag.push([x, y]); }
  }
  let far = 0;
  for (let q = 0; q < bag.length && bag.length < 20000; q++) {
    const [x, y] = bag[q];
    far = Math.max(far, Math.hypot(x - ex, y - ey));
    if (far > limit) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const k = ny * W + nx;
      if (seen.has(k) || !isRoad(at(nx, ny)) || own(nx, ny)) continue;
      seen.add(k);
      bag.push([nx, ny]);
    }
  }
  return { tiles: seen.size, far: +far.toFixed(1) };
}

// Does the street's own tarmac TOUCH another course's tarmac anywhere along
// its length (a mid-span join the endpoint test cannot see)?
function midspanTouch(c) {
  const half = c.width / 2 + 0.5;
  const others = roads.filter((o) => o.i !== c.i);
  const touch = new Map();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!isRoad(at(x, y))) continue;
      if (distToCourse(c, x + 0.5, y + 0.5) > half) continue;
      for (const o of others) {
        if (distToCourse(o, x + 0.5, y + 0.5) <= o.width / 2 + 0.5) {
          touch.set(o.i, (touch.get(o.i) ?? 0) + 1);
        }
      }
    }
  return [...touch.entries()].sort((a, b) => b[1] - a[1]);
}

console.log('\n# per-hit attribution');
for (const h of hits) {
  const { c, p0, q1 } = h;
  const e0 = escape(c, p0[0], p0[1]);
  const e1 = escape(c, q1[0], q1[1]);
  const ms = midspanTouch(c);
  console.log(`\n## course #${c.i}  ${c.kind} w=${c.width}  len=${h.len.toFixed(1)}  pass=${passOf(c.i)}`);
  console.log(`   ends  ${p0[0].toFixed(0)},${p0[1].toFixed(0)} -> ${q1[0].toFixed(0)},${q1[1].toFixed(0)}   straight-ray beyond: ${h.b0} / ${h.b1}`);
  console.log(`   escape flood off END A: ${e0.tiles} road tiles, reaching ${e0.far} tiles away`);
  console.log(`   escape flood off END B: ${e1.tiles} road tiles, reaching ${e1.far} tiles away`);
  console.log(`   mid-span tarmac shared with other courses: ${ms.length === 0 ? 'NONE' : ms.slice(0, 5).map(([i, n]) => `#${i}(${passOf(i)},${n}t)`).join(' ')}`);
  console.log(`   points: ${c.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}`);
}
