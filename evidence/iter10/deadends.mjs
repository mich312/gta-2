// Confirming iteration 6's attribution of the four surviving `road-deadend`
// caps before building on it, and asking the two questions iteration 6 left:
// is the crescent `drop` at 478,600 really a deliberate hash decision, and
// does the shore band at 415,672 really just run out?
//
// Needs the pass hook in shared/src/world/layout.ts:
//   for (const pass of passes) { const n0 = courses.length; pass();
//     globalThis.__PASS_PROBE__?.(pass.name, n0, courses.length, tiles); }
//
//   node evidence/iter10/deadends.mjs
import { S, plan, loadBake, NEW } from './lib.mjs';
const { buildLayout, polyBounds, pointInPoly, T_ROAD, T_BRIDGE, T_RAMP } = S;

const W = plan.widthTiles;
const H = plan.heightTiles;

/* laid-by, iteration 6's own rule: the LAST pass to leave road here. */
const laidBy = new Array(W * H).fill(null);
const snaps = [];
globalThis.__PASS_PROBE__ = (name, a, b, t) => {
  snaps.push([name, t.slice()]);
  for (let i = 0; i < W * H; i++) {
    const r = t[i] === T_ROAD || t[i] === T_BRIDGE;
    if (r && laidBy[i] === null) laidBy[i] = name;
    else if (!r) laidBy[i] = null;
  }
};
const layout = buildLayout(plan);
delete globalThis.__PASS_PROBE__;
const { owner, water } = layout;

/* claimDepth: BFS out from every in-polygon land tile. */
const inPoly = new Uint8Array(W * H);
const depth = new Int32Array(W * H).fill(-1);
const bag = [];
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}
for (let i = 0; i < W * H; i++) if (inPoly[i] === 1 && water[i] !== 1) { depth[i] = 0; bag.push(i); }
for (let q = 0; q < bag.length; q++) {
  const i = bag[q], x = i % W, y = (i - x) / W;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (water[j] === 1 || depth[j] >= 0) continue;
    depth[j] = depth[i] + 1;
    bag.push(j);
  }
}

const SITES = [
  [415, 672, 'east'],
  [321, 327, 'south'],
  [478, 600, 'south'],
  [342, 312, 'south'],
];
console.log('=== iteration 6 attribution, re-measured ===');
for (const [x, y, dir] of SITES) {
  const passes = new Map();
  for (let k = -3; k <= 3; k++)
    for (let d = 0; d <= 2; d++) {
      const tx = dir === 'east' ? x - d : x + k;
      const ty = dir === 'east' ? y + k : y - d;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const p = laidBy[ty * W + tx];
      if (p !== null) passes.set(p, (passes.get(p) ?? 0) + 1);
    }
  const i = y * W + x;
  const d = plan.districts[owner[i]];
  const [px0, py0, px1, py1] = polyBounds(d.area);
  const inRect = x >= px0 && x <= px1 && y >= py0 && y <= py1;
  console.log(
    `${String(x).padStart(3)},${String(y).padStart(3)} ${dir.padEnd(5)} laid by ${[...passes.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ').padEnd(30)}` +
    ` owner ${d.name.padEnd(14)} fabric ${String(d.street.fabric).padEnd(9)} inPoly ${inPoly[i]} inRect ${inRect ? 1 : 0} claimDepth ${depth[i]}`,
  );
}

/* ---- what is on the ground straight past each cap? ------------------ */
console.log('\n=== the ground the cap faces, 12 tiles out ===');
const NAMES = { 0: 'FIELD', 1: 'ROAD', 2: 'SIDEWALK', 3: 'BUILDING', 4: 'WATER', 5: 'PARK', 6: 'TREES', 7: 'SAND', 8: 'BRIDGE', 9: 'RAMP', 10: 'LOT', 11: 'BANK', 12: 'RUNWAY', 13: 'FLOOR' };
const city = loadBake(NEW);
const tid = Object.fromEntries(Object.entries(S).filter(([k]) => k.startsWith('T_')).map(([k, v]) => [v, k.slice(2)]));
for (const [x, y, dir] of SITES) {
  const dx = dir === 'east' ? 1 : 0, dy = dir === 'east' ? 0 : 1;
  const row = [];
  for (let s = 0; s <= 12; s++) {
    const tx = x + dx * s, ty = y + dy * s;
    row.push(tid[city.tiles[ty * W + tx]] ?? '?');
  }
  console.log(`${x},${y} ${dir}: ${row.join(' ')}`);
}
