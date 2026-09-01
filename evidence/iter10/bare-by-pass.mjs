// Which pass lays the 12,333 carriageway tiles no course describes?
//
// A road tile outside every baked course's swept disc is drawn by the per-tile
// painter: bare asphalt, no kerb casing, no edge line, no centre dash, and the
// rasterised staircase along its edge. This attributes every one of them to the
// LAST layout pass that left road there — iteration 6's own rule.
//
// CONTROL: the attribution must tile the whole set (every bare tile gets a
// pass, and the per-pass counts must sum to the total).
//
// Needs the pass hook in shared/src/world/layout.ts.
//   node evidence/iter10/bare-by-pass.mjs
import { S, loadBake, NEW, plan } from './lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

const laidBy = new Array(W * H).fill(null);
globalThis.__PASS_PROBE__ = (name, a, b, t) => {
  for (let i = 0; i < W * H; i++) {
    const r = t[i] === T_ROAD || t[i] === T_BRIDGE;
    if (r && laidBy[i] === null) laidBy[i] = name;
    else if (!r) laidBy[i] = null;
  }
};
buildLayout(plan);
delete globalThis.__PASS_PROBE__;

const cover = new Uint8Array(W * H);
for (const c of city.courses) {
  if (c.kind === 'path') continue;
  const half = c.width / 2 + 0.55;
  for (let k = 0; k + 1 < c.points.length; k++) {
    const [ax, ay] = c.points[k], [bx, by] = c.points[k + 1];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1));
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        if (cover[ty * W + tx]) continue;
        let t = l2 === 0 ? 0 : ((tx + 0.5 - ax) * dx + (ty + 0.5 - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(ax + dx * t - tx - 0.5, ay + dy * t - ty - 0.5) <= half) cover[ty * W + tx] = 1;
      }
  }
}

const bare = new Map();
const all = new Map();
let road = 0, bareN = 0, unattributed = 0;
for (let i = 0; i < W * H; i++) {
  if (!isRoad(city.tiles[i])) continue;
  road++;
  const p = laidBy[i] ?? '(laid after the layout / by the bake)';
  all.set(p, (all.get(p) ?? 0) + 1);
  if (!cover[i]) {
    bareN++;
    if (laidBy[i] === null) unattributed++;
    bare.set(p, (bare.get(p) ?? 0) + 1);
  }
}
console.log(`carriageway ${road}, bare (no ribbon) ${bareN}\n`);
console.log('pass                              road tiles     bare      % of that pass    % of all bare');
const rows = [...all.entries()].sort((a, b) => (bare.get(b[0]) ?? 0) - (bare.get(a[0]) ?? 0));
let sum = 0;
for (const [p, n] of rows) {
  const b = bare.get(p) ?? 0;
  sum += b;
  console.log(`${p.padEnd(34)}${String(n).padStart(8)}${String(b).padStart(10)}${((b / n) * 100).toFixed(1).padStart(15)}%${((b / bareN) * 100).toFixed(1).padStart(16)}%`);
}
console.log(`\nCONTROL: per-pass bare sums to ${sum}, total bare is ${bareN} — ${sum === bareN ? 'tiles the set exactly' : 'MISMATCH'}`);
console.log(`CONTROL: bare tiles with no pass attribution: ${unattributed}`);
