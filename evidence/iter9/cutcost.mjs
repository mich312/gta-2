// What "cut these junctions" would cost, and what the ring has instead.
//
// Two numbers the verdict needs:
//   - how many places the ring can actually be joined today (the interchanges
//     §14.3 D6 says are the chokepoints), and
//   - how much tarmac cutting every held-back mouth would add, i.e. how many
//     driveways the motorway would acquire.
//
// Run: node evidence/iter9/cutcost.mjs
import { loadBake, NEW } from './lib.mjs';
import { T_ROAD, T_BRIDGE, T_RAMP, T_WATER, T_BUILDING } from '../../shared/dist/index.js';

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
      for (let ty = Math.max(0, Math.floor(Math.min(ay, by) - half - 1)); ty <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1)); ty++)
        for (let tx = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1)); tx <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1)); tx++)
          if (segDist(tx + 0.5, ty + 0.5, ax, ay, bx, by) <= half) m[ty * W + tx] = 1;
    }
  }
  return m;
}
const ringMask = courseMask('ring');
const ringRoad = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) if (ringMask[i] === 1 && isRoad(tiles[i])) ringRoad[i] = 1;

/* ---- 1. where the ring can actually be joined -------------------- */
// Every non-ring carriageway tile touching a ring carriageway tile, grouped
// into connected clusters — one cluster is one place you can get on or off.
const touch = new Uint8Array(W * H);
let touchN = 0;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (ringRoad[i] === 1 || !isRoad(tiles[i])) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (ringRoad[ny * W + nx] === 1) { touch[i] = 1; touchN++; break; }
    }
  }
const seen = new Uint8Array(W * H);
const clusters = [];
for (let i = 0; i < W * H; i++) {
  if (touch[i] !== 1 || seen[i]) continue;
  const st = [i]; seen[i] = 1; const bag = [];
  while (st.length) {
    const j = st.pop(); bag.push(j);
    const x = j % W, y = (j - x) / W;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (touch[k] === 1 && !seen[k]) { seen[k] = 1; st.push(k); }
      }
  }
  const cx = Math.round(bag.reduce((a, j) => a + (j % W), 0) / bag.length);
  const cy = Math.round(bag.reduce((a, j) => a + ((j - (j % W)) / W), 0) / bag.length);
  clusters.push({ n: bag.length, cx, cy });
}
clusters.sort((a, b) => b.n - a.n);
console.log(`# 1. how the ring is joined today`);
console.log(`ring carriageway: ${ringRoad.reduce((a, b) => a + b, 0)} tiles`);
console.log(`non-ring carriageway tiles touching it: ${touchN}, in ${clusters.length} separate places:`);
for (const c of clusters) console.log(`   ${c.cx},${c.cy}  ${c.n} tiles of contact`);

/* ---- 2. the cost of cutting every held-back mouth ---------------- */
const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MAXGAP = 4;
let mouths = 0, tilesNeeded = 0;
const used = new Uint8Array(W * H);
for (const [dx, dy] of CARD) {
  const px = dy, py = -dx;
  const flag = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isRoad(tiles[i]) || ringRoad[i] === 1) continue;
      if (isRoad(at(x + dx, y + dy))) continue;
      for (let d = 1; d <= MAXGAP; d++) {
        const t = at(x + dx * d, y + dy * d);
        if (isRoad(t)) { if (ringRoad[(y + dy * d) * W + (x + dx * d)] === 1) flag[i] = d; break; }
        if (t === T_BUILDING || t === T_WATER) break;
      }
    }
  const u2 = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (flag[i] === 0 || u2[i] === 1) continue;
      let a0 = 0, a1 = 0;
      while (x + px * (a0 - 1) >= 0 && y + py * (a0 - 1) >= 0 && flag[(y + py * (a0 - 1)) * W + (x + px * (a0 - 1))] > 0) a0--;
      while (x + px * (a1 + 1) < W && y + py * (a1 + 1) < H && flag[(y + py * (a1 + 1)) * W + (x + px * (a1 + 1))] > 0) a1++;
      let need = 0;
      for (let k = a0; k <= a1; k++) {
        const j = (y + py * k) * W + (x + px * k);
        u2[j] = 1;
        need += flag[j] - 1;
      }
      if (a1 - a0 + 1 < 2) continue;
      mouths++;
      tilesNeeded += need;
    }
}
console.log(`\n# 2. the counterfactual: open every mouth that points at the ring`);
console.log(`mouths >=2 tiles wide reaching ring carriageway within ${MAXGAP}: ${mouths}`);
console.log(`tarmac needed to open them all: ${tilesNeeded} tiles`);
console.log(`that would take the ring from ${clusters.length} places you can join it to ${clusters.length + mouths}.`);
