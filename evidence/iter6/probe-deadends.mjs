// The nine `road-deadend` sites, item by item: which pass laid the cap, who
// owns the ground it stops on, how far that ground stands from the polygon its
// owner was drawn on, and what the borough's fabric is.
//
// Needs the pass hook in `shared/src/world/layout.ts` (evidence/iter5/README.md).
//   node evidence/iter6/probe-deadends.mjs
import { S, plan } from './lib.mjs';
const { buildLayout, polyBounds, pointInPoly, T_ROAD, T_BRIDGE } = S;

const W = plan.widthTiles;
const H = plan.heightTiles;
const laidBy = new Array(W * H).fill(null);
globalThis.__LAYOUT_PROBE__ = (name, t) => {
  for (let i = 0; i < W * H; i++) {
    const r = t[i] === T_ROAD || t[i] === T_BRIDGE;
    if (r && laidBy[i] === null) laidBy[i] = name;
    else if (!r) laidBy[i] = null;
  }
};
const layout = buildLayout(plan);
delete globalThis.__LAYOUT_PROBE__;
const { owner, water } = layout;

const inPoly = new Uint8Array(W * H);
const depth = new Int32Array(W * H).fill(-1);
const bag = [];
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}
for (let i = 0; i < W * H; i++)
  if (inPoly[i] === 1 && water[i] !== 1) {
    depth[i] = 0;
    bag.push(i);
  }
for (let q = 0; q < bag.length; q++) {
  const i = bag[q];
  const x = i % W;
  const y = (i - x) / W;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (water[j] === 1 || depth[j] >= 0) continue;
    depth[j] = depth[i] + 1;
    bag.push(j);
  }
}

// The nine caps mapaudit reports, as (x, y, heading).
const SITES = [
  [415, 672, 'east'],
  [440, 311, 'south'],
  [485, 311, 'south'],
  [500, 311, 'south'],
  [515, 311, 'south'],
  [530, 311, 'south'],
  [321, 327, 'south'],
  [478, 600, 'south'],
  [342, 312, 'south'],
];
for (const [x, y, dir] of SITES) {
  // The cap and the three tiles behind it, sampled across five columns so a
  // 2- to 6-wide street is covered whatever its centre rounds to.
  const passes = new Map();
  for (let k = -3; k <= 3; k++) {
    for (let d = 0; d <= 2; d++) {
      const tx = dir === 'east' ? x - d : x + k;
      const ty = dir === 'east' ? y + k : y - d;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const p = laidBy[ty * W + tx];
      if (p !== null) passes.set(p, (passes.get(p) ?? 0) + 1);
    }
  }
  const i = y * W + x;
  const own = owner[i];
  const d = plan.districts[own];
  const [px0, py0, px1, py1] = polyBounds(d.area);
  console.log(
    `${String(x).padStart(3)},${String(y).padStart(3)} ${dir.padEnd(5)}  laid by ${[...passes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`)
      .join(' ')
      .padEnd(34)} owner ${d.name.padEnd(15)} fabric ${String(d.street.fabric).padEnd(8)} polyBounds [${px0},${py0}-${px1},${py1}] inPoly ${inPoly[i]} claimDepth ${depth[i]}`,
  );
}
