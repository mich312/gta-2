// `street-serves-nothing` at the real scale.
//
// The five hits are fragments that `trimCourses` cut out of long carved
// streets. This asks the two questions that decide whether they are a defect:
//
//  A. CONTINUATION. Walk the PARENT centreline past the fragment's endpoint.
//     If the parent's swept disc is still carriageway out there, the street
//     does not stop — the CENTRELINE stopped, and the detector is reading a
//     trim artefact, not a cap.
//  B. POPULATION. How many baked courses are fragments at all, how many have
//     both ends joining other carriageway, and how many of those the detector
//     flags. The five have to be placed in that population before "noisy" or
//     "real" means anything.
//
// Needs the pass hook in shared/src/world/layout.ts.
//   node evidence/iter10/population.mjs
import { S, loadBake, NEW, plan } from './lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const layRoad = (t) => t === T_ROAD || t === T_BRIDGE; // trimCourses' own onGround
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);

const ranges = [];
globalThis.__PASS_PROBE__ = (n, a, b) => ranges.push([n, a, b]);
const layout = buildLayout(plan);
delete globalThis.__PASS_PROBE__;
const passOf = (i) => (ranges.find(([, a, b]) => i >= a && i < b) ?? ['?'])[0];

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
/** Resample a polyline to points every `step` tiles, with arc length. */
function walk(pts, step = 0.5) {
  const out = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) out.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/* ---- the detector, verbatim ---------------------------------------- */
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');
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
function detectorFires(c) {
  const len = clen(c.points);
  if (len < 4 || len >= 20.000001) return false;
  const p0 = c.points[0], p1 = c.points[1];
  const q1 = c.points[c.points.length - 1], q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  const met = (x, y) => roads.some((o) => o.i !== c.i && distTo(o.points, x, y)[0] <= 2);
  if (met(p0[0], p0[1]) || met(q1[0], q1[1])) return false;
  const half = c.width / 2;
  const b0 = tarmacBeyond(p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0, half, 3);
  const b1 = tarmacBeyond(q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1, half, 3);
  return b0 <= 3 && b1 <= 3;
}

/* ---- parent matching for EVERY baked road course -------------------- */
function parentOf(c) {
  let best = null;
  for (const [j, L] of layout.courses.entries()) {
    if (L.kind !== c.kind || L.width !== c.width) continue;
    let worst = 0;
    for (const [x, y] of c.points) { worst = Math.max(worst, distTo(L.points, x, y)[0]); if (worst > 0.06) break; }
    if (worst <= 0.06 && (best === null || clen(L.points) > best.len)) best = { j, len: clen(L.points), pts: L.points };
  }
  return best;
}

/**
 * CONTINUATION: is the parent's swept disc still carriageway past the
 * fragment's endpoint? Returns tiles of parent centreline beyond the end
 * whose disc holds road, out to `reach`.
 */
function continuation(parentPts, endPt, dirSign, reach = 12, width = 3) {
  const w = walk(parentPts, 0.5);
  // index of the fragment endpoint on the parent
  let bi = 0, bd = Infinity;
  for (let i = 0; i < w.length; i++) {
    const d = Math.hypot(w[i][0] - endPt[0], w[i][1] - endPt[1]);
    if (d < bd) { bd = d; bi = i; }
  }
  let onRoad = 0, sampled = 0;
  for (let s = 1; s <= reach * 2; s++) {
    const i = bi + dirSign * s;
    if (i < 0 || i >= w.length) break;
    sampled++;
    const [x, y] = w[i];
    // full carriageway width, as tarmacBeyond does
    let any = false;
    for (let k = -1; k <= 1 && !any; k++) {
      // perpendicular offsets
      const j = Math.min(w.length - 1, Math.max(0, i + 1));
      const dx = w[j][0] - w[i][0], dy = w[j][1] - w[i][1];
      const n = Math.hypot(dx, dy) || 1;
      const px = -dy / n, py = dx / n;
      const off = (k * width) / 2;
      if (layRoad(at(Math.floor(x + px * off), Math.floor(y + py * off)))) any = true;
    }
    if (any) onRoad++;
  }
  return { sampled, onRoad, tiles: +(onRoad / 2).toFixed(1) };
}

/** road tiles 4-adjacent to the course's own tarmac, bucketed along it */
function joins(c) {
  const half = c.width / 2 + 0.5;
  const own = new Set();
  const xs = c.points.map((p) => p[0]), ys = c.points.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys)) - 4); y <= Math.min(H - 1, Math.ceil(Math.max(...ys)) + 4); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs)) - 4); x <= Math.min(W - 1, Math.ceil(Math.max(...xs)) + 4); x++)
      if (isRoad(at(x, y)) && distTo(c.points, x + 0.5, y + 0.5)[0] <= half) own.add(y * W + x);
  let a = 0, m = 0, b = 0;
  for (const k of own) {
    const x = k % W, y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = (y + dy) * W + (x + dx);
      if (own.has(nk) || !isRoad(at(x + dx, y + dy))) continue;
      const t = distTo(c.points, x + 0.5, y + 0.5)[1];
      t < 0.15 ? a++ : t > 0.85 ? b++ : m++;
    }
  }
  return { a, m, b, own: own.size };
}

/* ==================== A. the five, in detail ======================== */
console.log('=== A. the five hits: does the STREET stop, or only the CENTRELINE? ===\n');
const flagged = roads.filter(detectorFires);
for (const c of flagged) {
  const p = parentOf(c);
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  const j = joins(c);
  console.log(`## #${c.i}  ${p0[0].toFixed(0)},${p0[1].toFixed(0)} -> ${q1[0].toFixed(0)},${q1[1].toFixed(0)}  len=${clen(c.points).toFixed(1)}  pass=${p ? passOf(p.j) : '?'}`);
  if (p) {
    // which parent direction is "beyond" each end
    const w = walk(p.pts, 0.5);
    const iA = w.reduce((bi, pt, i) => (Math.hypot(pt[0] - p0[0], pt[1] - p0[1]) < Math.hypot(w[bi][0] - p0[0], w[bi][1] - p0[1]) ? i : bi), 0);
    const iB = w.reduce((bi, pt, i) => (Math.hypot(pt[0] - q1[0], pt[1] - q1[1]) < Math.hypot(w[bi][0] - q1[0], w[bi][1] - q1[1]) ? i : bi), 0);
    const cA = continuation(p.pts, p0, iA < iB ? -1 : +1, 12, c.width);
    const cB = continuation(p.pts, q1, iA < iB ? +1 : -1, 12, c.width);
    console.log(`   parent #${p.j} len=${p.len.toFixed(1)} -> fragment kept ${((clen(c.points) / p.len) * 100).toFixed(0)}%`);
    console.log(`   parent carriageway BEYOND end A: ${cA.tiles}/${(cA.sampled / 2).toFixed(1)} tiles   BEYOND end B: ${cB.tiles}/${(cB.sampled / 2).toFixed(1)} tiles`);
  }
  console.log(`   own tarmac ${j.own} tiles; joins other carriageway  END A ${j.a} | MIDDLE ${j.m} | END B ${j.b}\n`);
}

/* ==================== B. the population ============================= */
console.log('=== B. city-wide population ===\n');
let nFrag = 0, nWhole = 0, nUnmatched = 0;
const shortFrag = [];
for (const c of roads) {
  const p = parentOf(c);
  if (!p) { nUnmatched++; continue; }
  const L = clen(c.points);
  if (p.len > L + 0.5) { nFrag++; if (L >= 4 && L < 20.000001) shortFrag.push({ c, p, L }); }
  else nWhole++;
}
console.log(`baked road courses          ${roads.length}`);
console.log(`  whole (parent kept)       ${nWhole}`);
console.log(`  FRAGMENTS (trimCourses)   ${nFrag}`);
console.log(`  parent not matched        ${nUnmatched}`);
console.log(`\nshort fragments in the detector's own length window [4,20): ${shortFrag.length}`);
let bothJoin = 0, oneJoin = 0, noJoin = 0, flaggedOfThese = 0;
for (const f of shortFrag) {
  const j = joins(f.c);
  if (j.a > 0 && j.b > 0) bothJoin++;
  else if (j.a > 0 || j.b > 0) oneJoin++;
  else noJoin++;
  if (detectorFires(f.c)) flaggedOfThese++;
}
console.log(`  both ends join other carriageway   ${bothJoin}`);
console.log(`  one end joins                      ${oneJoin}`);
console.log(`  NEITHER end joins (truly terminal) ${noJoin}`);
console.log(`  of these, the detector flags        ${flaggedOfThese}`);
console.log(`\n=> the detector flags ${flaggedOfThese} of ${shortFrag.length} indistinguishable short fragments (${((flaggedOfThese / shortFrag.length) * 100).toFixed(1)}%)`);
