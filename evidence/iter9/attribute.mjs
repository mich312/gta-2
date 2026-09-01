// Attribution for `road-stops-short`.
//
// Re-derives the caps with mapAudit's own geometry (copied, not imported, so a
// detector change cannot silently move the ground under this), then asks of
// each one a question the detector never asks: WHAT is the carriageway it
// stops short of, and WHO cleared the gap.
//
// The ring/avenue masks are reconstructed from the courses the bake records
// (`city.courses`, kind 'ring' | 'avenue' | 'street' | 'path'), by the same
// swept-disc rule `carveCourse` used to lay them: a tile is on a course if its
// centre is within width/2 of the polyline. Iteration 8 proved that rule
// reproduces the carve exactly for the bridge decks.
//
// Run: node evidence/iter9/attribute.mjs
import { loadBake, NEW } from './lib.mjs';
import {
  T_ROAD, T_BRIDGE, T_RAMP, T_WATER, T_BANK, T_SAND, T_LOT, T_RUNWAY, T_FLOOR,
  T_BUILDING, T_FIELD, T_PARK, T_TREES, T_SIDEWALK,
} from '../../shared/dist/index.js';

const NAME = {
  [T_WATER]: 'water', [T_SAND]: 'sand', [T_BANK]: 'bank', [T_FIELD]: 'field',
  [T_PARK]: 'park', [T_TREES]: 'trees', [T_ROAD]: 'road', [T_SIDEWALK]: 'sidewalk',
  [T_BUILDING]: 'building', [T_FLOOR]: 'floor', [T_LOT]: 'lot', [T_BRIDGE]: 'bridge',
  [T_RAMP]: 'ramp', [T_RUNWAY]: 'runway',
};

const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : tiles[y * W + x]);
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

/* ---- course masks, by kind -------------------------------------- */

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

/** Tiles swept by every course of `kind`, whether or not they ended up road. */
function courseMask(kind, pad = 0) {
  const m = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind !== kind) continue;
    const half = c.width / 2 + pad;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k], [bx, by] = c.points[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1));
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++)
          if (segDist(tx + 0.5, ty + 0.5, ax, ay, bx, by) <= half) m[ty * W + tx] = 1;
    }
  }
  return m;
}

const ringMask = courseMask('ring');
const avenueMask = courseMask('avenue');

// Ring carriageway as it actually lies: the swept disc INTERSECTED with road.
const ringRoad = new Uint8Array(W * H);
let ringRoadN = 0;
for (let i = 0; i < W * H; i++) {
  if (ringMask[i] === 1 && isRoad(tiles[i])) { ringRoad[i] = 1; ringRoadN++; }
}

// `nearRing`: layout.ts's own Chebyshev-2 test, over ring ROAD tiles.
const nearRing = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    if (ringRoad[y * W + x] !== 1) continue;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        nearRing[ny * W + nx] = 1;
      }
  }

// The junction dilation: ground both masks carved, flooded JUNCTION_REACH=9.
const junction = new Uint8Array(W * H);
{
  const bag = [], depth = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++)
    if (ringMask[i] === 1 && avenueMask[i] === 1) { junction[i] = 1; depth[i] = 0; bag.push(i); }
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    if (depth[i] >= 9) continue;
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (junction[j] === 1) continue;
      junction[j] = 1; depth[j] = depth[i] + 1; bag.push(j);
    }
  }
}

/* ---- landmark proximity, as mapAudit asks it -------------------- */
const landmarks = city.landmarks ?? [];
function landmarkNear(x, y, r) {
  for (const L of landmarks) {
    const lx = L.x ?? L.tx ?? 0, ly = L.y ?? L.ty ?? 0;
    const lw = L.w ?? L.wTiles ?? 0, lh = L.h ?? L.hTiles ?? 0;
    const cx = Math.max(lx, Math.min(x, lx + lw)), cy = Math.max(ly, Math.min(y, ly + lh));
    if (Math.hypot(x - cx, y - cy) <= r) return true;
  }
  return false;
}

/* ---- the cap walk, mapAudit's own shape ------------------------- */

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const dirName = (dx, dy) => (dx === 1 ? 'east' : dx === -1 ? 'west' : dy === 1 ? 'south' : 'north');

const caps = [];
for (const [dx, dy] of DIRS) {
  const px = dy, py = -dx;
  const seen = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isRoad(tiles[i]) || seen[i] === 1) continue;
      if (isRoad(at(x + dx, y + dy))) continue;
      let a0 = 0;
      while (isRoad(at(x + px * (a0 - 1), y + py * (a0 - 1))) &&
             !isRoad(at(x + px * (a0 - 1) + dx, y + py * (a0 - 1) + dy))) a0--;
      let a1 = 0;
      while (isRoad(at(x + px * (a1 + 1), y + py * (a1 + 1))) &&
             !isRoad(at(x + px * (a1 + 1) + dx, y + py * (a1 + 1) + dy))) a1++;
      for (let k = a0; k <= a1; k++) {
        const kx = x + px * k, ky = y + py * k;
        if (kx >= 0 && ky >= 0 && kx < W && ky < H) seen[ky * W + kx] = 1;
      }
      const len = a1 - a0 + 1;
      if (len < 2 || len > 6) continue;
      if (isRoad(at(x + px * (a0 - 1), y + py * (a0 - 1)))) continue;
      if (isRoad(at(x + px * (a1 + 1), y + py * (a1 + 1)))) continue;
      let straight = true;
      for (let d = 1; d <= 3 && straight; d++)
        for (let k = a0 - 1; k <= a1 + 1 && straight; k++) {
          const want = k >= a0 && k <= a1;
          if (isRoad(at(x + px * k - dx * d, y + py * k - dy * d)) !== want) straight = false;
        }
      if (!straight) continue;
      const beyond = []; let offMap = false;
      for (let k = a0; k <= a1; k++)
        for (let d = 1; d <= 2; d++) {
          const bx = x + px * k + dx * d, by = y + py * k + dy * d;
          if (bx < 0 || by < 0 || bx >= W || by >= H) offMap = true;
          beyond.push(at(bx, by));
        }
      if (offMap) continue;
      if (beyond.some((t) => t === T_WATER || t === T_BANK || t === T_SAND)) continue;
      if (beyond.some((t) => t === T_LOT || t === T_RUNWAY || t === T_FLOOR)) continue;
      const cxT = x + px * ((a0 + a1) / 2), cyT = y + py * ((a0 + a1) / 2);
      if (landmarkNear(cxT, cyT, 10)) continue;
      let short = 0;
      for (let d = 1; d <= 6 && short === 0; d++)
        for (let k = a0; k <= a1; k++)
          if (isRoad(at(x + px * k + dx * d, y + py * k + dy * d))) { short = d; break; }
      caps.push({ x, y, dx, dy, px, py, a0, a1, len, short, cxT, cyT });
    }
}

const shorts = caps.filter((c) => c.short > 0);
console.log(`caps walked: ${caps.length}   with a carriageway within 6: ${shorts.length}   dead ends: ${caps.length - shorts.length}`);
console.log(`ring: ${ringRoadN} carriageway tiles from ${city.courses.filter((c) => c.kind === 'ring').length} courses;  nearRing band ${nearRing.reduce((a, b) => a + b, 0)} tiles;  junction dilation ${junction.reduce((a, b) => a + b, 0)} tiles`);

/* ---- what is on the far side, and what cleared the gap ---------- */

function classifyFar(c) {
  // the road tiles the cap stops short OF
  const far = [];
  for (let k = c.a0; k <= c.a1; k++) {
    const fx = c.x + c.px * k + c.dx * c.short, fy = c.y + c.py * k + c.dy * c.short;
    if (isRoad(at(fx, fy))) far.push(fy * W + fx);
  }
  const ring = far.filter((i) => ringRoad[i] === 1).length;
  const aven = far.filter((i) => ringRoad[i] !== 1 && avenueMask[i] === 1).length;
  return { far, ring, aven, other: far.length - ring - aven };
}

function gapTiles(c) {
  const g = [];
  for (let d = 1; d < c.short; d++)
    for (let k = c.a0; k <= c.a1; k++) {
      const gx = c.x + c.px * k + c.dx * d, gy = c.y + c.py * k + c.dy * d;
      g.push({ x: gx, y: gy, i: gy * W + gx, t: at(gx, gy) });
    }
  return g;
}

const rows = [];
for (const c of shorts) {
  const f = classifyFar(c);
  const g = gapTiles(c);
  const inBand = g.filter((t) => nearRing[t.i] === 1).length;
  const inJunc = g.filter((t) => junction[t.i] === 1).length;
  const kinds = [...new Set(g.map((t) => NAME[t.t] ?? t.t))].join('+');
  rows.push({
    at: `${Math.round(c.cxT)},${Math.round(c.cyT)}`,
    len: c.len, short: c.short, mag: c.len * c.short, dir: dirName(c.dx, c.dy),
    far: f.ring > 0 ? 'RING' : f.aven > 0 ? 'avenue' : 'street',
    farRing: f.ring, farAven: f.aven, farOther: f.other,
    gap: g.length, gapInShaveBand: inBand, gapInJunction: inJunc, gapTiles: kinds,
  });
}
rows.sort((a, b) => b.mag - a.mag || a.at.localeCompare(b.at));

console.log('\n# every cap that stops short of a carriageway, city-wide');
console.log('# at            len short mag dir    far-side   ring aven other  gap inBand inJunc  gap tiles');
for (const r of rows)
  console.log(
    `${r.at.padEnd(14)}${String(r.len).padEnd(4)}${String(r.short).padEnd(6)}${String(r.mag).padEnd(4)}${r.dir.padEnd(7)}${r.far.padEnd(11)}${String(r.farRing).padEnd(5)}${String(r.farAven).padEnd(5)}${String(r.farOther).padEnd(7)}${String(r.gap).padEnd(5)}${String(r.gapInShaveBand).padEnd(7)}${String(r.gapInJunction).padEnd(8)}${r.gapTiles}`,
  );

const byFar = {};
for (const r of rows) byFar[r.far] = (byFar[r.far] ?? 0) + 1;
console.log('\nfar side:', byFar);
const fullyInBand = rows.filter((r) => r.gapInShaveBand === r.gap).length;
console.log(`gap entirely inside the ring's Chebyshev-2 shave band: ${fullyInBand} of ${rows.length}`);
console.log(`gap touching the junction dilation at all:              ${rows.filter((r) => r.gapInJunction > 0).length} of ${rows.length}`);
