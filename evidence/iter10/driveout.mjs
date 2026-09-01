// The player-facing question for `street-serves-nothing`, and its control.
//
// MEASURE: stand at one end of the flagged street. Flood the carriageway from
// the tiles 4-adjacent to that end of its own tarmac, FORBIDDEN to re-enter
// the street itself. How far can you get? That is "can I drive out of this end
// without turning round", which is the thing the signature claims you cannot.
//
// CONTROL: the same measure at the four `road-deadend` caps, which are capped
// by construction and MUST read near zero, and at four ordinary mid-city
// junctions, which must read far. A measure that reads "far" everywhere is a
// measure that cannot say anything.
//
//   node evidence/iter10/driveout.mjs
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

/** Own tarmac of a course: road tiles within width/2 + 0.5 of its centreline. */
function ownTarmac(pts, width) {
  const half = width / 2 + 0.5;
  const own = new Set();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys)) - 4); y <= Math.min(H - 1, Math.ceil(Math.max(...ys)) + 4); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs)) - 4); x <= Math.min(W - 1, Math.ceil(Math.max(...xs)) + 4); x++)
      if (isRoad(at(x, y)) && distTo(pts, x + 0.5, y + 0.5)[0] <= half) own.add(y * W + x);
  return own;
}

/**
 * Flood the carriageway from `seeds`, forbidden to enter `blocked`.
 * Returns tiles reached and the furthest Chebyshev distance from `origin`.
 */
function flood(seeds, blocked, origin, cap = 4000) {
  const seen = new Set();
  const bag = [];
  for (const [x, y] of seeds) {
    const k = y * W + x;
    if (!blocked.has(k) && isRoad(at(x, y)) && !seen.has(k)) { seen.add(k); bag.push([x, y]); }
  }
  let far = 0;
  for (let q = 0; q < bag.length && seen.size < cap; q++) {
    const [x, y] = bag[q];
    far = Math.max(far, Math.max(Math.abs(x - origin[0]), Math.abs(y - origin[1])));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (seen.has(k) || blocked.has(k) || !isRoad(at(nx, ny))) continue;
      seen.add(k); bag.push([nx, ny]);
    }
  }
  return { tiles: seen.size, far: Math.round(far) };
}

/** Drive-out at one end of a course. */
function driveOut(c, which) {
  const own = ownTarmac(c.points, c.width);
  const end = which === 'A' ? c.points[0] : c.points[c.points.length - 1];
  const seeds = [];
  for (const k of own) {
    const x = k % W, y = (k - x) / W;
    const t = distTo(c.points, x + 0.5, y + 0.5)[1];
    if (which === 'A' ? t >= 0.15 : t <= 0.85) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!own.has((y + dy) * W + (x + dx)) && isRoad(at(x + dx, y + dy))) seeds.push([x + dx, y + dy]);
    }
  }
  return flood(seeds, own, [Math.round(end[0]), Math.round(end[1])]);
}

/* ---- CONTROL: the four road-deadend caps --------------------------- */
// A cap tile's whole street is the blockage; drive-out from PAST the cap must
// find nothing. Seed at the tiles just beyond the cap, in the cap's own
// direction, blocking the carriageway component behind it.
console.log('=== CONTROL A: the four road-deadend caps (must read NEAR ZERO) ===');
const deadends = [[415, 672, 1, 0], [321, 327, 0, 1], [478, 600, 0, 1], [342, 312, 0, 1]];
for (const [x, y, dx, dy] of deadends) {
  // seed the 3 tiles immediately beyond the cap face, block everything behind
  const blocked = new Set();
  for (let s = -30; s <= 0; s++)
    for (let k = -3; k <= 3; k++) {
      const bx = x + dx * s + (dy ? k : 0), by = y + dy * s + (dx ? k : 0);
      if (isRoad(at(bx, by))) blocked.add(by * W + bx);
    }
  const seeds = [];
  for (let s = 1; s <= 2; s++)
    for (let k = -2; k <= 2; k++) seeds.push([x + dx * s + (dy ? k : 0), y + dy * s + (dx ? k : 0)]);
  const f = flood(seeds, blocked, [x, y]);
  console.log(`  cap ${x},${y} facing ${dx},${dy}: ${f.tiles} tiles beyond, reaching ${f.far} away`);
}

/* ---- CONTROL: four ordinary junctions ------------------------------ */
console.log('\n=== CONTROL B: four long ordinary courses (must read FAR at both ends) ===');
const long = roads.filter((c) => clen(c.points) > 60).slice(0, 4);
for (const c of long) {
  const a = driveOut(c, 'A'), b = driveOut(c, 'B');
  console.log(`  #${c.i} ${c.kind} len=${clen(c.points).toFixed(0)}: END A ${a.tiles}t/${a.far} away | END B ${b.tiles}t/${b.far} away`);
}

/* ---- the five hits -------------------------------------------------- */
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
const hits = [];
for (const c of roads) {
  const len = clen(c.points);
  if (len < 4 || len >= 20.000001) continue;
  const p0 = c.points[0], p1 = c.points[1];
  const q1 = c.points[c.points.length - 1], q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  if (roads.some((o) => o.i !== c.i && (distTo(o.points, p0[0], p0[1])[0] <= 2 || distTo(o.points, q1[0], q1[1])[0] <= 2))) continue;
  const half = c.width / 2;
  if (tarmacBeyond(p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0, half, 3) > 3) continue;
  if (tarmacBeyond(q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1, half, 3) > 3) continue;
  hits.push(c);
}
console.log(`\n=== THE ${hits.length} street-serves-nothing HITS ===`);
for (const c of hits) {
  const a = driveOut(c, 'A'), b = driveOut(c, 'B');
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  const verdict = a.far >= 20 && b.far >= 20 ? 'DRIVES OUT BOTH ENDS'
    : a.far >= 20 || b.far >= 20 ? 'DRIVES OUT ONE END' : 'TERMINAL BOTH ENDS';
  console.log(`  #${c.i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)}: END A ${a.tiles}t/${a.far} away | END B ${b.tiles}t/${b.far} away  => ${verdict}`);
}

/* ---- population: the same measure over every short fragment -------- */
console.log('\n=== POPULATION: drive-out over every baked road course of length [4,20) ===');
const shorts = roads.filter((c) => { const l = clen(c.points); return l >= 4 && l < 20.000001; });
let both = 0, one = 0, none = 0;
for (const c of shorts) {
  const a = driveOut(c, 'A'), b = driveOut(c, 'B');
  if (a.far >= 20 && b.far >= 20) both++;
  else if (a.far >= 20 || b.far >= 20) one++;
  else none++;
}
console.log(`  short baked courses            ${shorts.length}`);
console.log(`  drive out BOTH ends            ${both}`);
console.log(`  drive out ONE end              ${one}`);
console.log(`  drive out NEITHER end          ${none}`);
console.log(`  flagged by street-serves-nothing ${hits.length}`);
