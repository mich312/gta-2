// The invariant the shipped city satisfies and nothing asserts: no street
// mouth joins the ring outside an authored junction.
//
// Measures the exact quantity the regression test will assert, and then plants
// a cut junction and re-measures — so the number is known to be able to move.
//
// Run: node evidence/iter9/invariant.mjs
import { loadBake, NEW } from './lib.mjs';
import { T_ROAD, T_BRIDGE, T_RAMP, T_WATER } from '../../shared/dist/index.js';

const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles, H = city.heightTiles;
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

function mouthsJoiningRing(tiles) {
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : tiles[y * W + x]);
  const ringMask = courseMask('ring'), avenueMask = courseMask('avenue');
  const ringRoad = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (ringMask[i] === 1 && isRoad(tiles[i])) ringRoad[i] = 1;
  const junction = new Uint8Array(W * H);
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
  const found = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const px = dy, py = -dx;
    const flag = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (ringRoad[i] === 1 || !isRoad(tiles[i]) || junction[i] === 1) continue;
        if (ringRoad[(y + dy) * W + (x + dx)] !== 1) continue;
        flag[i] = 1;
      }
    const used = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (flag[y * W + x] !== 1 || used[y * W + x] === 1) continue;
        let a0 = 0, a1 = 0;
        while (x + px * (a0 - 1) >= 0 && y + py * (a0 - 1) >= 0 && flag[(y + py * (a0 - 1)) * W + (x + px * (a0 - 1))] === 1) a0--;
        while (x + px * (a1 + 1) < W && y + py * (a1 + 1) < H && flag[(y + py * (a1 + 1)) * W + (x + px * (a1 + 1))] === 1) a1++;
        for (let k = a0; k <= a1; k++) used[(y + py * k) * W + (x + px * k)] = 1;
        if (a1 - a0 + 1 < 2) continue;
        found.push(`${Math.round(x + px * ((a0 + a1) / 2))},${Math.round(y + py * ((a0 + a1) / 2))} w=${a1 - a0 + 1}`);
      }
  }
  return { found, ringRoad, junction, at };
}

const base = mouthsJoiningRing(city.tiles);
console.log(`SHIPPED: mouths >=2 tiles wide joining the ring outside the 9-tile authored-junction dilation: ${base.found.length}`);
console.log(base.found.length ? base.found.join('\n') : '  (none)');

/* ---- CONTROL: plant one cut junction and re-measure ------------- */
// The 264,407 mouth, opened: lay the two tiles of grass across its mouth as
// road, exactly what "cut the junction" would do.
const planted = Uint8Array.from(city.tiles);
let plantN = 0;
for (const [gx, gy] of [[265, 406], [265, 407], [265, 408], [266, 406], [266, 407], [266, 408]]) {
  if (isRoad(planted[gy * W + gx])) throw new Error(`control is not planting anything at ${gx},${gy}`);
  planted[gy * W + gx] = T_ROAD;
  plantN++;
}
console.log(`\nCONTROL: planted ${plantN} tiles of tarmac across the 264,407 mouth.`);
const after = mouthsJoiningRing(planted);
console.log(`AFTER PLANT: ${after.found.length} mouth(s) join the ring outside a junction:`);
console.log(after.found.length ? after.found.join('\n') : '  (none) — THE CHECK IS BLIND');
if (after.found.length === base.found.length) {
  console.log('\n*** the check did not move. It cannot go red. Do not trust it. ***');
  process.exit(1);
}
console.log('\nThe check goes red on a planted junction, so its 0 on the shipped city is a measurement.');
