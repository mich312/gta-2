// The population behind `road-stops-short`.
//
// Two questions the 13 findings cannot answer on their own:
//
//  1. How much of the ring's frontage is a cleared verge? If the shave has
//     cleared the WHOLE length, a street mouth stopping 2 tiles short is not a
//     hole in a fence — it is the verge, and the 13 are where the audit's
//     narrow cap shape happens to fire on ground that looks like every other
//     tile beside the motorway.
//  2. How many street mouths face the ring across that verge in total? The 13
//     are only the ones that pass the detector's `len 2..6`, `straight for 3
//     back`, `no road off either end` filters. Relax them one at a time.
//
// Run: node evidence/iter9/population.mjs
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

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
function courseMask(kind) {
  const m = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind !== kind) continue;
    const half = c.width / 2;
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
const ringMask = courseMask('ring'), avenueMask = courseMask('avenue');
const ringRoad = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) if (ringMask[i] === 1 && isRoad(tiles[i])) ringRoad[i] = 1;

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

/* ---- 1. the ring's own frontage --------------------------------- */
// Every ring carriageway tile with a non-ring tile beside it: walk out 1..3
// and record what the first three tiles of frontage are.

const frontage = { total: 0, cleared: 0, road: 0, byFirst: {}, junctionSide: 0 };
const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    if (ringRoad[y * W + x] !== 1) continue;
    for (const [dx, dy] of CARD) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (ringRoad[ny * W + nx] === 1) continue; // interior of the ring band
      frontage.total++;
      const t = at(nx, ny);
      frontage.byFirst[NAME[t] ?? t] = (frontage.byFirst[NAME[t] ?? t] ?? 0) + 1;
      if (junction[ny * W + nx] === 1) frontage.juncSide = (frontage.juncSide ?? 0) + 1;
      if (isRoad(t)) frontage.road++;
      else frontage.cleared++;
    }
  }
console.log('# 1. the ring\'s frontage — every ring carriageway tile\'s outward neighbours');
console.log(`ring carriageway tiles: ${ringRoad.reduce((a, b) => a + b, 0)}`);
console.log(`frontage faces: ${frontage.total}   road on the far side: ${frontage.road} (${(100 * frontage.road / frontage.total).toFixed(1)}%)   cleared: ${frontage.cleared} (${(100 * frontage.cleared / frontage.total).toFixed(1)}%)`);
console.log('first tile out:', Object.entries(frontage.byFirst).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`of the ${frontage.road} road faces, inside the 9-tile junction dilation: ${(() => {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (ringRoad[y * W + x] !== 1) continue;
    for (const [dx, dy] of CARD) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (ringRoad[ny * W + nx] === 1) continue;
      if (isRoad(at(nx, ny)) && junction[ny * W + nx] === 1) n++;
    }
  }
  return n;
})()}`);

/* ---- 2. every street mouth that faces the ring across a gap ------ */
// No cap-shape filters at all: any road tile whose forward neighbour is not
// road, where walking straight on 1..4 tiles reaches ring carriageway.
// Grouped into contiguous mouths per direction.

const MAXGAP = 4;
const mouthOf = new Int32Array(W * H).fill(-1);
const mouths = [];
for (const [dx, dy] of CARD) {
  const px = dy, py = -dx;
  const flag = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isRoad(tiles[i]) || ringRoad[i] === 1) continue;
      if (isRoad(at(x + dx, y + dy))) continue;
      let hit = 0;
      for (let d = 1; d <= MAXGAP; d++) {
        const t = at(x + dx * d, y + dy * d);
        if (isRoad(t)) { hit = ringRoad[(y + dy * d) * W + (x + dx * d)] === 1 ? d : -1; break; }
        if (t === T_BUILDING || t === T_WATER) break; // an impassable gap is another story
      }
      if (hit > 0) flag[i] = hit;
    }
  // contiguous runs along the perpendicular
  const used = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (flag[i] === 0 || used[i] === 1) continue;
      let a0 = 0, a1 = 0;
      while (flag[(y + py * (a0 - 1)) * W + (x + px * (a0 - 1))] > 0 &&
             x + px * (a0 - 1) >= 0 && y + py * (a0 - 1) >= 0) a0--;
      while (x + px * (a1 + 1) < W && y + py * (a1 + 1) < H &&
             flag[(y + py * (a1 + 1)) * W + (x + px * (a1 + 1))] > 0) a1++;
      let maxGap = 0;
      for (let k = a0; k <= a1; k++) {
        const j = (y + py * k) * W + (x + px * k);
        used[j] = 1;
        if (flag[j] > maxGap) maxGap = flag[j];
      }
      const cx = Math.round(x + px * ((a0 + a1) / 2)), cy = Math.round(y + py * ((a0 + a1) / 2));
      mouths.push({ x: cx, y: cy, dx, dy, width: a1 - a0 + 1, gap: maxGap - 1,
        inJunction: junction[cy * W + cx] === 1 });
    }
}
const wide = mouths.filter((m) => m.width >= 2);
const gapped = wide.filter((m) => m.gap >= 1);
const outsideJ = gapped.filter((m) => !m.inJunction);
console.log('\n# 2. every street mouth pointing at the ring, no cap-shape filters');
console.log(`mouths reaching ring carriageway within ${MAXGAP}: ${mouths.length}   (>=2 tiles wide: ${wide.length})`);
console.log(`  of those, with a gap of >=1 non-road tile: ${gapped.length}`);
console.log(`  of those, outside the 9-tile authored-junction dilation: ${outsideJ.length}`);
console.log(`  gap-0 (mouths that DO meet the ring): ${wide.length - gapped.length}`);
const byGap = {};
for (const m of outsideJ) byGap[m.gap] = (byGap[m.gap] ?? 0) + 1;
console.log('  gap depth histogram (outside junctions):', byGap);
console.log('\n# every gapped mouth outside a junction');
console.log('# at          w  gap dir');
for (const m of outsideJ.sort((a, b) => b.width * b.gap - a.width * a.gap))
  console.log(`${`${m.x},${m.y}`.padEnd(12)}${String(m.width).padEnd(3)}${String(m.gap).padEnd(4)}${m.dx === 1 ? 'east' : m.dx === -1 ? 'west' : m.dy === 1 ? 'south' : 'north'}`);
