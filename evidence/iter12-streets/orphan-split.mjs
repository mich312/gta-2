// What IS the orphan tarmac, and how far is the nearest real street?
//
// `population-strict.mjs` splits every join into FOREIGN (a tile inside another
// baked course's band) and ORPHAN (a tile inside nobody's). Three of the five
// hits read FOREIGN 0/0/0 and all their signal in ORPHAN. "Orphan" is two very
// different things and the verdict turns on which:
//
//   SELF-LEAK  the course's OWN paint, past `width/2 + 0.5` — the round end cap
//              and the outside of every bend. Touching this is touching itself.
//   UNOWNED    tarmac no course claims but that is not this course's paint
//              either: junction blobs, lot aprons, bridge approach flares.
//
// A fragment whose only neighbours are SELF-LEAK is a genuinely isolated stub.
// One that touches UNOWNED tarmac is plumbed into something the course model
// does not name, which is a different verdict.
//
// And the physical question underneath both, since the carriageway is one
// 4-connected component and reachability therefore cannot see any of this:
// walking on tarmac only, HOW FAR from this street's own paint to the nearest
// tile belonging to some OTHER baked course? A street plumbed into the network
// reads 1. A street you can only reach by driving a long way over nameless
// tarmac reads high. That is a geodesic, not a straight line, so it cannot be
// fooled by a bend.
//
// CONTROL: the same geodesic over all 44 short fragments and over the 65 whole
// courses. If it does not separate them it is not measuring connection.
//
//   pnpm build && node evidence/iter12-streets/orphan-split.mjs
import { S, loadBake, NEW } from '../iter10/lib.mjs';
const { T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const clen = (p) => { let l = 0; for (let k = 1; k < p.length; k++) l += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]); return l; };
function distTo(pts, x, y) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) best = d;
  }
  return best;
}
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');
function bandOf(pts, width) {
  const half = width / 2 + 0.5;
  const set = new Set();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys)) - 4); y <= Math.min(H - 1, Math.ceil(Math.max(...ys)) + 4); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs)) - 4); x <= Math.min(W - 1, Math.ceil(Math.max(...xs)) + 4); x++)
      if (isRoad(at(x, y)) && distTo(pts, x + 0.5, y + 0.5) <= half) set.add(y * W + x);
  return set;
}
const bands = new Map();
const ownerOf = new Int32Array(W * H).fill(-1);
for (const c of roads) {
  const b = bandOf(c.points, c.width);
  bands.set(c.i, b);
  for (const k of b) if (ownerOf[k] === -1) ownerOf[k] = c.i;
}
// a tile may sit in two bands; keep the full membership for the "other course" test
const multi = new Map();
for (const c of roads) for (const k of bands.get(c.i)) {
  const l = multi.get(k); if (l) l.push(c.i); else multi.set(k, [c.i]);
}
const ownedByOther = (k, self) => { const l = multi.get(k); return !!l && l.some((j) => j !== self); };

/**
 * Tiles of tarmac you must cross, starting from this course's own band, before
 * standing on tarmac that belongs to some other baked course. 0 would mean the
 * course's own band already contains foreign tarmac; 1 means it is 4-adjacent.
 * Infinity means no other course is reachable over tarmac at all.
 */
function geodesicToOtherCourse(self) {
  const start = bands.get(self);
  const seen = new Uint8Array(W * H);
  let frontier = [];
  for (const k of start) { seen[k] = 1; frontier.push(k); if (ownedByOther(k, self)) return 0; }
  let d = 0;
  while (frontier.length) {
    d++;
    const next = [];
    for (const k of frontier) {
      const x = k % W, y = (k - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (seen[nk] || !isRoad(at(nx, ny))) continue;
        if (ownedByOther(nk, self)) return d;
        seen[nk] = 1;
        next.push(nk);
      }
    }
    frontier = next;
  }
  return Infinity;
}

/* ---- CONTROL: does the geodesic separate anything? ----------------- */
console.log('=== CONTROL — the geodesic over every baked road course ===\n');
const geo = new Map();
for (const c of roads) geo.set(c.i, geodesicToOtherCourse(c.i));
const hist = new Map();
for (const g of geo.values()) hist.set(g, (hist.get(g) ?? 0) + 1);
const keys = [...hist.keys()].sort((a, b) => a - b);
for (const k of keys) console.log(`  geodesic ${k === Infinity ? 'unreachable' : String(k).padStart(3)} : ${hist.get(k)} courses`);
const spread = keys.filter((k) => k > 1).length;
console.log(`  => the measure reads ${keys.length} distinct values; ${spread > 0 ? 'it separates plumbed-in from far — usable' : 'EVERY course reads the same — BROKEN'}\n`);

/* ---- the six courses this iteration has to rule on ------------------ */
const SUBJECTS = [129, 163, 272, 298, 332, 362];
console.log('=== the five flagged (+ #332, strict-terminal and NOT flagged) ===\n');
for (const i of SUBJECTS) {
  const c = roads.find((r) => r.i === i);
  const own = bands.get(i);
  const half = c.width / 2 + 0.5;
  let selfLeak = 0, unowned = 0, foreign = 0;
  const unownedTiles = [];
  for (const k of own) {
    const x = k % W, y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, nk = ny * W + nx;
      if (own.has(nk) || !isRoad(at(nx, ny))) continue;
      if (ownedByOther(nk, i)) { foreign++; continue; }
      // not another course's: is it MY OWN paint, or nobody's?
      if (distTo(c.points, nx + 0.5, ny + 0.5) <= half + 1.5) selfLeak++;
      else { unowned++; unownedTiles.push([nx, ny]); }
    }
  }
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  console.log(`#${i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)} len=${clen(c.points).toFixed(1)} w=${c.width} ${c.kind}`);
  console.log(`   adjacent tarmac: FOREIGN ${foreign}  SELF-LEAK ${selfLeak}  UNOWNED ${unowned}`);
  console.log(`   geodesic to the nearest other course, over tarmac: ${geo.get(i) === Infinity ? 'unreachable' : geo.get(i)} tile(s)`);
  if (unowned) console.log(`   unowned neighbours at: ${unownedTiles.slice(0, 8).map(([x, y]) => `${x},${y}`).join(' ')}${unowned > 8 ? ' ...' : ''}`);
  console.log('');
}
