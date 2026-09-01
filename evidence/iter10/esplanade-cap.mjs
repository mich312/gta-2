// 415,672 — the brief (from iteration 6) says the cap is "where the shore band
// runs out". deliberate.mjs shows the band does NOT run out: shoreDist stays
// inside layEsplanade's own 3 <= sd < 6 window for 11 more tiles east.
//
// So which of layEsplanade's four gates actually stopped the carve? This
// replays every one of them tile by tile along y=672, using the pass's own
// fields — `preEsp` taken from the pass-probe snapshot after carveAuthoredRoads,
// which is exactly what layEsplanade assigns it.
//
// CONTROL: the same replay must return "candidate" for the tiles that DID get
// road (409..415). A replay that refuses everything, or accepts everything,
// is not a replay.
//
//   node evidence/iter10/esplanade-cap.mjs
import { S, plan } from './lib.mjs';
const { buildLayout, pointInPoly, T_ROAD, T_BRIDGE } = S;

const W = plan.widthTiles;
const H = plan.heightTiles;

const snaps = new Map();
globalThis.__PASS_PROBE__ = (name, a, b, t) => { if (!snaps.has(name)) snaps.set(name, t.slice()); };
const layout = buildLayout(plan);
delete globalThis.__PASS_PROBE__;
const { owner, water } = layout;
const preEsp = snaps.get('carveAuthoredRoads'); // layEsplanade's own preEsp

function distanceField(mask, want) {
  const D = new Float32Array(W * H).fill(1e9);
  for (let i = 0; i < D.length; i++) if (mask[i] === want) D[i] = 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 1e9 : D[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    D[y * W + x] = Math.min(D[y * W + x], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--)
    D[y * W + x] = Math.min(D[y * W + x], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
  return D;
}
function blurField(field, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const cx = (v) => (v < 0 ? 0 : v >= W ? W - 1 : v);
  const cy = (v) => (v < 0 ? 0 : v >= H ? H - 1 : v);
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += field[y * W + cx(x)];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = acc / (2 * r + 1); acc += field[y * W + cx(x + r + 1)] - field[y * W + cx(x - r)]; }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[cy(y) * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = acc / (2 * r + 1); acc += tmp[cy(y + r + 1) * W + x] - tmp[cy(y - r) * W + x]; }
  }
  return out;
}
const shoreDist = distanceField(water, 1);
const shoreSmooth = blurField(shoreDist, 3);

function shoreParallelRoadNear(tx, ty) {
  const gx = shoreSmooth[Math.min(W - 1, tx + 1) + ty * W] - shoreSmooth[Math.max(0, tx - 1) + ty * W];
  const gy = shoreSmooth[tx + Math.min(H - 1, ty + 1) * W] - shoreSmooth[tx + Math.max(0, ty - 1) * W];
  const len = Math.hypot(gx, gy) || 1;
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const px = Math.round(tx + (gx / len) * k), py = Math.round(ty + (gy / len) * k);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const t = preEsp[py * W + px];
    if (t !== T_ROAD && t !== T_BRIDGE) continue;
    const innermost = shoreDist[ty * W + tx] <= 8;
    if (!innermost || shoreDist[py * W + px] <= 6) return true;
  }
  return false;
}

/* claimDepth, for inReachRuns */
const depth = new Int32Array(W * H).fill(-1);
{
  const bag = [];
  for (const d of plan.districts) {
    const xs = d.area.map((p) => p[0]), ys = d.area.map((p) => p[1]);
    for (let ty = Math.max(0, Math.floor(Math.min(...ys))); ty <= Math.min(H - 1, Math.ceil(Math.max(...ys))); ty++)
      for (let tx = Math.max(0, Math.floor(Math.min(...xs))); tx <= Math.min(W - 1, Math.ceil(Math.max(...xs))); tx++)
        if (pointInPoly(d.area, tx + 0.5, ty + 0.5) && water[ty * W + tx] !== 1 && depth[ty * W + tx] < 0) { depth[ty * W + tx] = 0; bag.push(ty * W + tx); }
  }
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q], x = i % W, y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (water[j] === 1 || depth[j] >= 0) continue;
      depth[j] = depth[i] + 1; bag.push(j);
    }
  }
}

console.log('=== layEsplanade candidate test, replayed along y=672 ===');
console.log('  x    water owner              rural fabric   sd     3<=sd<6  shoreParallelRoadNear  => candidate?   road in bake?');
const CITY = (await import('./lib.mjs')).loadBake((await import('./lib.mjs')).NEW);
for (let x = 405; x <= 430; x++) {
  const i = 672 * W + x;
  const own = owner[i];
  const d = own >= 0 ? plan.districts[own] : null;
  const sd = shoreDist[i];
  const inWin = sd >= 3 && sd < 6;
  const contourSkip = d && d.street.fabric === 'contour' && pointInPoly(d.area, x + 0.5, 672.5);
  const spr = shoreParallelRoadNear(x, 672);
  const cand = water[i] !== 1 && own >= 0 && d && !d.rural && !contourSkip && inWin && !spr;
  const isRoad = CITY.tiles[i] === T_ROAD || CITY.tiles[i] === T_BRIDGE;
  console.log(`  ${String(x).padStart(3)}    ${water[i]}     ${(d ? d.name : '-').padEnd(18)} ${d && d.rural ? 'YES ' : 'no  '} ${(d ? String(d.street.fabric) : '-').padEnd(8)} ${sd.toFixed(2).padStart(5)}  ${inWin ? 'YES' : 'no '}      ${spr ? 'SUPPRESSES' : '-         '}             ${cand ? 'CANDIDATE' : 'refused  '}      ${isRoad ? 'ROAD' : '-'}`);
}
console.log('\nCONTROL: the replay must say CANDIDATE exactly where the bake has esplanade road (409..415).');
