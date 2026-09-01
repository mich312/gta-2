// Does a car at this street's end cap have anywhere to go? Asked of the TARMAC,
// with no reference to courses at all.
//
// WHY A THIRD MEASURE. Iteration 10's LOOSE join count cannot read zero.
// `population-strict.mjs`'s FOREIGN count can, but it has a blind spot I found
// by dumping the ground under one of its zeroes: FOREIGN only knows tiles inside
// some `city.courses` band, and most of this map's residential tarmac is not
// painted from a course at all — it is carved from the block grid. So
// `#298 254,568->266,568  foreign 0/0/0` is NOT an isolated street: its west end
// runs straight into a north-south street at x=253-255 (dump-298.txt rows
// 559-566) that no baked course owns. FOREIGN 0 there means "meets no AUTHORED
// road", which is not the question the signature asks.
//
// THE MEASURE. From one endpoint, flood the carriageway 4-connected and count
// the tiles reached within R steps that are NOT this course's own paint.
//
// THE FIRST VERSION OF THIS WAS WRONG AND ITS CONTROLS SAID SO. It forbade
// entering the course's band at all, which walls the endpoint in behind its own
// carriageway: the ring read `escape 0 / 0` (control 3) and the islet street read
// 182 at an end the detector calls a cap (control 4). Blocking the band blocks
// the corridor an end would escape THROUGH — at #163's north end every one of the
// seed's four neighbours is band, while the street it joins is two tiles further
// on. Fixed by gating on ARC LENGTH: a band tile is passable while it is within
// D tiles ALONG THE CENTRELINE of the end being tested, and blocked beyond that,
// so you may step off the end sideways but may not drive the length of the street
// and out of the far end.
//
// CONTROLS, all printed before any verdict:
//   1. the distribution over 726 course ends must spread, not pile into a bucket
//   2. a course displaced into open country must read 0
//   3. the longest OPEN-ENDED course must saturate at both ends
//   4. #298, whose two ends I read off the tile dump by eye: its east end stops
//      two tiles short of the ring (the ring shave) and must read LOW; its west
//      end runs into the street at x=253-255 and must read HIGH. One course
//      reading both ways is the control the loose measure could never produce.
//
//   pnpm build && node evidence/iter12-streets/escape.mjs
import { S, loadBake, NEW } from '../iter10/lib.mjs';
const { T_ROAD, T_BRIDGE, T_RAMP } = S;
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const clen = (p) => { let l = 0; for (let k = 1; k < p.length; k++) l += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]); return l; };

/** [distance to the polyline, arc length from its START to the nearest point]. */
function project(pts, x, y) {
  let best = Infinity, bs = 0, acc = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, seg = Math.sqrt(l2);
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) { best = d; bs = acc + seg * t; }
    acc += seg;
  }
  return [best, bs];
}
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');

const R = 60;
/**
 * Tarmac reachable within `R` steps of one end without driving the length of the
 * street. `pts`/`width`/`fromStart` are arguments, so a DISPLACED polyline runs
 * the identical code path and a zero cannot be a dead probe.
 */
function escape(pts, width, fromStart) {
  const half = width / 2 + 0.5;
  const total = clen(pts);
  const D = Math.min(total / 2, 6);
  const end = fromStart ? pts[0] : pts[pts.length - 1];
  /** null = impassable; true = counts as escaped tarmac; false = own paint, walk through. */
  const kind = (x, y) => {
    if (!isRoad(at(x, y))) return null;
    const [d, s] = project(pts, x + 0.5, y + 0.5);
    if (d > half) return true;
    const arc = fromStart ? s : total - s;
    return arc <= D ? false : null;
  };
  const seen = new Set();
  let frontier = [];
  const ex = Math.round(end[0]), ey = Math.round(end[1]);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = ex + dx, y = ey + dy;
    if (kind(x, y) === null) continue;
    const k = y * W + x;
    if (!seen.has(k)) { seen.add(k); frontier.push([x, y]); }
  }
  let out = 0;
  for (let step = 0; step < R && frontier.length; step++) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (seen.has(k)) continue;
        const t = kind(nx, ny);
        if (t === null) continue;
        seen.add(k); next.push([nx, ny]);
        if (t) out++;
      }
    }
    frontier = next;
  }
  return out;
}

/* ---------------- CONTROLS ---------------- */
console.log(`=== CONTROLS (flood radius R=${R} steps) ===\n`);
const E = new Map();
for (const c of roads) E.set(c.i, [escape(c.points, c.width, true), escape(c.points, c.width, false)]);

const buckets = [0, 1, 5, 20, 100, 500, 2000, Infinity];
const counts = new Array(buckets.length).fill(0);
for (const [a, b] of E.values()) for (const v of [a, b]) counts[buckets.findIndex((t) => v <= t)]++;
console.log(`CONTROL 1 — distribution over ${roads.length * 2} course ends`);
let lo = 0;
for (const [i, t] of buckets.entries()) { console.log(`  escape ${lo}..${t === Infinity ? '∞' : t}: ${counts[i]}`); lo = t === Infinity ? lo : t + 1; }
console.log(`  => ${counts.filter((n) => n > 0).length >= 3 ? counts.filter((n) => n > 0).length + ' populated buckets — the measure spreads' : 'piles into one bucket — BROKEN'}\n`);

const probe = roads.find((c) => clen(c.points) > 8 && clen(c.points) < 20);
console.log(`CONTROL 2 — course #${probe.i} displaced into open country (identical code path)`);
for (const [sx, sy] of [[0, 0], [40, 40], [-200, -200]]) {
  const moved = probe.points.map(([x, y]) => [x + sx, y + sy]);
  console.log(`  shift ${String(sx).padStart(4)},${String(sy).padStart(4)}: escape ${escape(moved, probe.width, true)} / ${escape(moved, probe.width, false)}`);
}

// NOT the ring: the ring is a closed loop, its two endpoints are the same place,
// and "which way is out of this end" is not a question it has an answer to.
const open = roads.filter((c) => Math.hypot(c.points[0][0] - c.points[c.points.length - 1][0], c.points[0][1] - c.points[c.points.length - 1][1]) > 20);
const longest = open.reduce((b, c) => (clen(c.points) > clen(b.points) ? c : b), open[0]);
{
  const [a, b] = E.get(longest.i);
  console.log(`\nCONTROL 3 — longest OPEN-ENDED course #${longest.i}, ${clen(longest.points).toFixed(0)} tiles: escape ${a} / ${b}`);
  console.log(`  => ${a > 500 && b > 500 ? 'saturates at both ends, as a road across the city must' : 'DID NOT saturate — the measure is wrong'}`);
}
{
  const [a, b] = E.get(298);
  console.log(`\nCONTROL 4 — #298, both ends read off dump-298.txt by eye:`);
  console.log(`  WEST end 254,568 runs into the street at x=253-255 -> must be HIGH: ${a}`);
  console.log(`  EAST end 266,568 stops two tiles short of the ring  -> must be LOW : ${b}`);
  console.log(`  => ${a > 100 && b <= 20 ? 'one course, read both ways — the measure discriminates WITHIN a street' : 'FAILED — it does not match the ground'}`);
}

/* ---------------- the six under review ---------------- */
console.log('\n=== the five flagged, and #332 which population-strict called terminal but the detector does not flag ===\n');
const TERM = 20;
for (const i of [129, 163, 272, 298, 332, 362]) {
  const c = roads.find((r) => r.i === i);
  const p = c.points[0], q = c.points[c.points.length - 1];
  const [a, b] = E.get(i);
  const t = (v) => (v <= TERM ? 'TERMINAL' : 'open    ');
  console.log(`#${i} ${p[0].toFixed(0)},${p[1].toFixed(0)}->${q[0].toFixed(0)},${q[1].toFixed(0)} len=${clen(c.points).toFixed(1)}`);
  console.log(`   escape A ${String(a).padStart(4)} ${t(a)}   escape B ${String(b).padStart(4)} ${t(b)}   => ${a <= TERM && b <= TERM ? 'BOTH ENDS TERMINAL' : 'at least one end opens into the network'}`);
}

/* ---------------- the population ---------------- */
console.log('\n=== POPULATION — the detector\'s length window, by end-escape ===\n');
function detectorFires(c) {
  const len = clen(c.points);
  if (len < 4 || len >= 20.000001) return false;
  const p0 = c.points[0], p1 = c.points[1];
  const q1 = c.points[c.points.length - 1], q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  const met = (x, y) => roads.some((o) => o.i !== c.i && project(o.points, x, y)[0] <= 2);
  if (met(p0[0], p0[1]) || met(q1[0], q1[1])) return false;
  const half = c.width / 2;
  const beyond = (x, y, dx, dy) => {
    const px = -dy, py = dx;
    const steps = Math.max(1, Math.round(half * 2));
    for (let s = 1; s <= 4; s++) {
      let any = false;
      for (let k = 0; k <= steps && !any; k++) {
        const off = -half + (k * half * 2) / steps;
        if (isRoad(at(Math.floor(x + dx * s + px * off), Math.floor(y + dy * s + py * off)))) any = true;
      }
      if (!any) return s - 1;
    }
    return Infinity;
  };
  return beyond(p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0) <= 3
    && beyond(q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1) <= 3;
}
const inWindow = roads.filter((c) => { const L = clen(c.points); return L >= 4 && L < 20.000001; });
let both = 0, one = 0, none = 0;
const bothList = [];
for (const c of inWindow) {
  const [a, b] = E.get(c.i);
  if (a <= TERM && b <= TERM) { both++; bothList.push(c); }
  else if (a <= TERM || b <= TERM) one++;
  else none++;
}
console.log(`courses in the detector's length window [4,20): ${inWindow.length}`);
console.log(`  BOTH ends terminal (escape<=${TERM}) : ${both}`);
console.log(`  one end terminal                     : ${one}`);
console.log(`  neither                              : ${none}`);
console.log(`\nevery both-ends-terminal course in the window:`);
for (const c of bothList) {
  const p = c.points[0], q = c.points[c.points.length - 1];
  const [a, b] = E.get(c.i);
  console.log(`  #${c.i} ${p[0].toFixed(0)},${p[1].toFixed(0)}->${q[0].toFixed(0)},${q[1].toFixed(0)} len=${clen(c.points).toFixed(1)} escape ${a}/${b}  detector flags: ${detectorFires(c)}`);
}
let tp = 0, fp = 0, fn = 0;
for (const c of inWindow) {
  const [a, b] = E.get(c.i);
  const real = a <= TERM && b <= TERM;
  const fired = detectorFires(c);
  if (real && fired) tp++; else if (!real && fired) fp++; else if (real && !fired) fn++;
}
console.log(`\ndetector vs end-escape over the window: ${tp} true positive, ${fp} false positive, ${fn} false negative`);

/* ---- and the same over EVERY baked road course, not just the window --- */
let allBoth = 0;
const allList = [];
for (const c of roads) {
  const [a, b] = E.get(c.i);
  if (a <= TERM && b <= TERM) { allBoth++; allList.push([c, a, b]); }
}
console.log(`\nover ALL ${roads.length} baked road courses, both ends terminal: ${allBoth}`);
for (const [c, a, b] of allList) {
  const p = c.points[0], q = c.points[c.points.length - 1];
  console.log(`  #${c.i} ${p[0].toFixed(0)},${p[1].toFixed(0)}->${q[0].toFixed(0)},${q[1].toFixed(0)} len=${clen(c.points).toFixed(1)} ${c.kind} escape ${a}/${b}  detector flags: ${detectorFires(c)}`);
}
