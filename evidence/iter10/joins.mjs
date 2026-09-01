// `street-serves-nothing`, the two questions the signature never asked:
//
//  (1) Is the flagged course a FRAGMENT? `trimCourses` (bake.ts) splits a
//      recorded centreline wherever it leaves the finished carriageway, so one
//      carved street can arrive in the bake as several courses. A fragment's
//      endpoints are not the street's endpoints.
//  (2) Where does the flagged course's own TARMAC touch other road? The
//      detector asks two things at each end — is another CENTRELINE within 2
//      tiles, and is there road along a STRAIGHT ray — and a join that is
//      neither (a bend, a course trimmed back off its own tarmac) is invisible
//      to both.
//
// Needs the pass hook in shared/src/world/layout.ts (see attribute-streets.mjs).
//   node evidence/iter10/joins.mjs
import { S, loadBake, NEW, plan } from './lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);

const ranges = [];
globalThis.__PASS_PROBE__ = (n, a, b) => ranges.push([n, a, b]);
const layout = buildLayout(plan);
delete globalThis.__PASS_PROBE__;
const passOf = (i) => (ranges.find(([, a, b]) => i >= a && i < b) ?? ['?'])[0];

function clen(pts) {
  let l = 0;
  for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return l;
}
function distTo(pts, x, y) {
  let best = Infinity;
  let bt = 0;
  let acc = 0;
  const total = clen(pts);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) {
      best = d;
      bt = total === 0 ? 0 : (acc + Math.sqrt(l2) * t) / total;
    }
    acc += Math.sqrt(l2);
  }
  return [best, bt];
}

/* ---- the five hits, taken from the detector's own criteria --------- */
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');
const MEET = 2;
const CAP = 3;
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
const hits = [];
for (const c of roads) {
  const len = clen(c.points);
  if (len < 4 || len >= 20.000001) continue;
  const p0 = c.points[0];
  const p1 = c.points[1];
  const q1 = c.points[c.points.length - 1];
  const q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  const met = (x, y) => roads.some((o) => o.i !== c.i && distTo(o.points, x, y)[0] <= MEET);
  if (met(p0[0], p0[1]) || met(q1[0], q1[1])) continue;
  const half = c.width / 2;
  const b0 = tarmacBeyond(p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0, half, CAP);
  const b1 = tarmacBeyond(q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1, half, CAP);
  if (b0 > CAP || b1 > CAP) continue;
  hits.push({ c, len, p0, q1, b0, b1 });
}

/* ---- (1) fragment test: match each hit to its layout parent -------- */
// A baked course is a run of a layout course, so its points are a contiguous
// quantised subsequence. Match by "every point of the hit lies on the parent".
function parentOf(hit) {
  let best = null;
  for (const [j, L] of layout.courses.entries()) {
    if (L.kind !== hit.c.kind || L.width !== hit.c.width) continue;
    let worst = 0;
    for (const [x, y] of hit.c.points) worst = Math.max(worst, distTo(L.points, x, y)[0]);
    if (worst <= 0.06 && (best === null || clen(L.points) > best.len)) {
      best = { j, len: clen(L.points), pts: L.points, worst };
    }
  }
  return best;
}

/* ---- (2) where the hit's own tarmac joins other road --------------- */
function joins(c) {
  const half = c.width / 2 + 0.5;
  const own = new Set();
  const cx0 = Math.max(0, Math.floor(Math.min(...c.points.map((p) => p[0]))) - 4);
  const cx1 = Math.min(W - 1, Math.ceil(Math.max(...c.points.map((p) => p[0]))) + 4);
  const cy0 = Math.max(0, Math.floor(Math.min(...c.points.map((p) => p[1]))) - 4);
  const cy1 = Math.min(H - 1, Math.ceil(Math.max(...c.points.map((p) => p[1]))) + 4);
  for (let y = cy0; y <= cy1; y++)
    for (let x = cx0; x <= cx1; x++)
      if (isRoad(at(x, y)) && distTo(c.points, x + 0.5, y + 0.5)[0] <= half) own.add(y * W + x);
  // road tiles 4-adjacent to own tarmac but not own
  const outs = [];
  for (const k of own) {
    const x = k % W;
    const y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const nk = ny * W + nx;
      if (own.has(nk) || !isRoad(at(nx, ny))) continue;
      outs.push([nx, ny, distTo(c.points, x + 0.5, y + 0.5)[1]]);
    }
  }
  // bucket by position along the course: END A (t<0.15), MIDDLE, END B (t>0.85)
  let a = 0;
  let m = 0;
  let b = 0;
  for (const [, , t] of outs) (t < 0.15 ? a++ : t > 0.85 ? b++ : m++);
  return { total: outs.length, a, m, b, outs };
}

console.log(`# ${hits.length} hits reproduced\n`);
for (const h of hits) {
  const p = parentOf(h);
  const j = joins(h.c);
  console.log(`## baked course #${h.c.i}  ${h.p0[0].toFixed(0)},${h.p0[1].toFixed(0)} -> ${h.q1[0].toFixed(0)},${h.q1[1].toFixed(0)}  len=${h.len.toFixed(1)}`);
  if (p) {
    const frag = p.len > h.len + 0.5;
    console.log(`   parent: layout course #${p.j} (${passOf(p.j)}) len=${p.len.toFixed(1)}  =>  ${frag ? `FRAGMENT — trimCourses cut ${(p.len - h.len).toFixed(1)} tiles off a ${p.len.toFixed(1)}-tile street` : 'WHOLE — the carved street is this long'}`);
    console.log(`   parent ends: ${p.pts[0][0].toFixed(0)},${p.pts[0][1].toFixed(0)} -> ${p.pts[p.pts.length - 1][0].toFixed(0)},${p.pts[p.pts.length - 1][1].toFixed(0)}`);
  } else console.log('   parent: NOT MATCHED');
  console.log(`   tarmac joins other carriageway at ${j.total} tile faces:  END A ${j.a} | MIDDLE ${j.m} | END B ${j.b}`);
  console.log(`   => ${j.a > 0 && j.b > 0 ? 'BOTH ENDS JOIN OTHER ROAD' : j.a > 0 || j.b > 0 ? 'ONE END JOINS OTHER ROAD' : 'NEITHER END JOINS — genuinely terminal both ends'}`);
  console.log('');
}
