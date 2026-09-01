// `street-serves-nothing` — the population, recomputed STRICTLY.
//
// Iteration 10 left this signature open because its own control refused the
// headline. `evidence/iter10/population.mjs` reported "the detector flags 5 of
// 44 indistinguishable short fragments (11.4%)", and
// `evidence/iter10/joins-control.mjs` then said of the measure behind that
// denominator:
//
//     courses with ZERO joining tarmac anywhere:      0
//     => the measure NEVER reads zero — BROKEN, it cannot discriminate
//
// A measure that never reads zero cannot say "terminal". This script replaces
// it and shows the replacement reading BOTH ways before using it.
//
// WHY THE LOOSE MEASURE CANNOT READ ZERO. `joins()` calls a road tile "own" if
// it lies within `width/2 + 0.5` of the course's centreline, then counts any
// 4-adjacent road tile OUTSIDE that set as a join. But the bake paints a
// course with a swept disc plus a ROUND CAP at each end, so a course's own
// paint reaches past `width/2 + 0.5` — at the caps and on the outside of every
// bend. Every course therefore "joins" ITSELF. That is not a bug in the tally;
// it is a wrong definition of the thing being tallied.
//
// THREE MEASURES, per course, over the same 4-adjacency:
//   loose    — iteration 10's, verbatim, kept as the control that must stay high
//   foreign  — the neighbour tile is inside ANOTHER baked course's own band
//              ("does this street meet a street", the strict question)
//   orphan   — the neighbour tile belongs to NO course's band (junction blobs,
//              lot aprons, bridge approaches, and this course's own cap leak)
//
// loose = foreign + orphan by construction, so the split says exactly how much
// of iteration 10's signal was tarmac belonging to nobody.
//
//   pnpm build && node evidence/iter12-streets/population-strict.mjs
import { S, loadBake, NEW, plan } from '../iter10/lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

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

/** Road tiles within `width/2 + 0.5` of a polyline — iteration 10's own band. */
function bandOf(pts, width) {
  const half = width / 2 + 0.5;
  const set = new Set();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys)) - 4); y <= Math.min(H - 1, Math.ceil(Math.max(...ys)) + 4); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs)) - 4); x <= Math.min(W - 1, Math.ceil(Math.max(...xs)) + 4); x++)
      if (isRoad(at(x, y)) && distTo(pts, x + 0.5, y + 0.5)[0] <= half) set.add(y * W + x);
  return set;
}

/* ---- ownership map: tile -> which baked courses claim it ------------ */
const owners = new Map();
for (const c of roads) {
  for (const k of bandOf(c.points, c.width)) {
    const l = owners.get(k);
    if (l) l.push(c.i); else owners.set(k, [c.i]);
  }
}

/**
 * The three tallies, bucketed along the course: END A (t<0.15), MIDDLE, END B
 * (t>0.85) — the same buckets iteration 10 used, so the numbers are comparable.
 * `pts`/`width`/`selfIdx` are separate arguments so a DISPLACED polyline (which
 * is no course at all) can be measured by the identical code path.
 */
function measure(pts, width, selfIdx) {
  const own = bandOf(pts, width);
  const z = () => ({ a: 0, m: 0, b: 0 });
  const loose = z(), foreign = z(), orphan = z();
  for (const k of own) {
    const x = k % W, y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, nk = ny * W + nx;
      if (own.has(nk) || !isRoad(at(nx, ny))) continue;
      const t = distTo(pts, x + 0.5, y + 0.5)[1];
      const bucket = t < 0.15 ? 'a' : t > 0.85 ? 'b' : 'm';
      loose[bucket]++;
      const o = owners.get(nk);
      if (o && o.some((j) => j !== selfIdx)) foreign[bucket]++; else orphan[bucket]++;
    }
  }
  return { own: own.size, loose, foreign, orphan };
}

const fmt = (t) => `${t.a}/${t.m}/${t.b}`;
const bothEnds = (t) => t.a > 0 && t.b > 0;
const eitherEnd = (t) => t.a > 0 || t.b > 0;

/* ================= CONTROLS, before any conclusion ================== */
console.log('=== CONTROLS — the strict measure must read BOTH ways ===\n');

const M = new Map();
for (const c of roads) M.set(c.i, measure(c.points, c.width, c.i));

let looseZeroBoth = 0, foreignZeroBoth = 0, foreignHigh = 0, orphanZeroBoth = 0;
for (const c of roads) {
  const m = M.get(c.i);
  if (!eitherEnd(m.loose)) looseZeroBoth++;
  if (!eitherEnd(m.foreign)) foreignZeroBoth++;
  if (bothEnds(m.foreign)) foreignHigh++;
  if (!eitherEnd(m.orphan)) orphanZeroBoth++;
}
console.log(`CONTROL 1 — distribution over all ${roads.length} baked road courses`);
console.log(`  LOOSE   reads zero at both ends for    ${looseZeroBoth} / ${roads.length}`);
console.log(`  FOREIGN reads zero at both ends for    ${foreignZeroBoth} / ${roads.length}`);
console.log(`  FOREIGN reads NONZERO at both ends for ${foreignHigh} / ${roads.length}`);
console.log(`  ORPHAN  reads zero at both ends for    ${orphanZeroBoth} / ${roads.length}`);
const c1 = foreignZeroBoth > 0 && foreignHigh > 0;
console.log(`  => FOREIGN ${c1 ? 'CAN read zero AND nonzero — it discriminates' : 'is BROKEN'}`);
console.log(`  => LOOSE ${looseZeroBoth === 0 ? 'never reads zero — reproduces iteration 10s broken control' : 'reads zero somewhere'}\n`);

/* CONTROL 2 — a real course displaced into open country must read 0 on
   FOREIGN, and the same course left where it is must not. Same code path, so a
   zero here cannot be a dead probe. */
const probe = roads.find((c) => clen(c.points) > 8 && clen(c.points) < 20);
console.log(`CONTROL 2 — course #${probe.i} displaced (identical code path)`);
for (const [sx, sy] of [[0, 0], [0, -40], [40, 40], [-60, 0], [-200, -200]]) {
  const moved = probe.points.map(([x, y]) => [x + sx, y + sy]);
  const m = measure(moved, probe.width, probe.i);
  console.log(`  shift ${String(sx).padStart(4)},${String(sy).padStart(4)}: own=${String(m.own).padStart(3)}  loose ${fmt(m.loose).padEnd(9)} foreign ${fmt(m.foreign).padEnd(9)} orphan ${fmt(m.orphan)}`);
}

/* CONTROL 3 — a course that is unarguably plumbed in must read HIGH on
   FOREIGN. Take the longest baked road course on the map. */
const longest = roads.reduce((b, c) => (clen(c.points) > clen(b.points) ? c : b), roads[0]);
{
  const m = M.get(longest.i);
  console.log(`\nCONTROL 3 — longest course #${longest.i} (${clen(longest.points).toFixed(0)} tiles, ${longest.kind})`);
  console.log(`  loose ${fmt(m.loose)}   foreign ${fmt(m.foreign)}   orphan ${fmt(m.orphan)}`);
  console.log(`  => ${bothEnds(m.foreign) ? 'FOREIGN nonzero at both ends, as a plumbed-in road must be' : 'FOREIGN FAILED on a known-connected road — measure is wrong'}`);
}

/* ================= the detector, verbatim ========================== */
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

/* ---- fragment classification, as iteration 10 did it --------------- */
const layout = buildLayout(plan);
if (!layout.courses || layout.courses.length === 0) throw new Error('buildLayout returned no courses — probe is blind, refusing to report');
console.log(`\n(parent source: buildLayout(plan) -> ${layout.courses.length} authored courses — assertion fired, probe is not blind)`);
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

/* ================= B. the population, STRICTLY ===================== */
console.log('\n=== POPULATION — the same 44, under FOREIGN instead of LOOSE ===\n');
const shortFrag = [];
let nFrag = 0, nWhole = 0, nUnmatched = 0;
for (const c of roads) {
  const p = parentOf(c);
  if (!p) { nUnmatched++; continue; }
  const L = clen(c.points);
  if (p.len > L + 0.5) { nFrag++; if (L >= 4 && L < 20.000001) shortFrag.push({ c, p, L }); }
  else nWhole++;
}
console.log(`baked road courses ${roads.length}: whole ${nWhole}, fragments ${nFrag}, unmatched ${nUnmatched}`);
console.log(`short fragments in the detector's length window [4,20): ${shortFrag.length}\n`);

const tally = (pick) => {
  let both = 0, one = 0, none = 0, flaggedNone = 0, flaggedTotal = 0;
  for (const f of shortFrag) {
    const t = pick(M.get(f.c.i));
    const fired = detectorFires(f.c);
    if (fired) flaggedTotal++;
    if (t.a > 0 && t.b > 0) both++;
    else if (t.a > 0 || t.b > 0) one++;
    else { none++; if (fired) flaggedNone++; }
  }
  return { both, one, none, flaggedNone, flaggedTotal };
};
for (const [name, pick] of [['LOOSE  ', (m) => m.loose], ['FOREIGN', (m) => m.foreign]]) {
  const t = tally(pick);
  console.log(`${name}: both ends join ${t.both}   one end ${t.one}   NEITHER (terminal) ${t.none}`);
  console.log(`         of the ${t.none} terminal, the detector flags ${t.flaggedNone}; it flags ${t.flaggedTotal} of ${shortFrag.length} overall`);
}

/* ---- the five, side by side ---------------------------------------- */
console.log('\n=== THE FIVE FLAGGED, loose vs foreign vs orphan ===\n');
for (const c of roads.filter(detectorFires)) {
  const m = M.get(c.i);
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  console.log(`#${c.i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)} len=${clen(c.points).toFixed(1)}`);
  console.log(`   own ${m.own}  loose ${fmt(m.loose).padEnd(10)} foreign ${fmt(m.foreign).padEnd(10)} orphan ${fmt(m.orphan)}`);
  console.log(`   => ${eitherEnd(m.foreign) ? 'meets another course at ' + (bothEnds(m.foreign) ? 'BOTH ends' : 'ONE end') : 'meets NO other course at either end — STRICT TERMINAL'}`);
}

/* ---- and the terminal population named, so it can be looked at ----- */
console.log('\n=== EVERY strict-terminal short fragment on the map ===\n');
for (const f of shortFrag) {
  const m = M.get(f.c.i);
  if (eitherEnd(m.foreign)) continue;
  const p0 = f.c.points[0], q1 = f.c.points[f.c.points.length - 1];
  console.log(`  #${f.c.i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)} len=${f.L.toFixed(1)} w=${f.c.width} kind=${f.c.kind}  flagged=${detectorFires(f.c)}  foreign ${fmt(m.foreign)} orphan ${fmt(m.orphan)}`);
}
