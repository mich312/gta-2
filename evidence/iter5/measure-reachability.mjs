// Reachability of the shipped carriageway, before and after.
//
//   node evidence/iter5/measure-reachability.mjs [path/to/city.data.ts]
//
// Two numbers, the same two iteration 4's investigation used:
//   * the 4-connected components of carriageway, largest first;
//   * mean travel distance over carriageway between landmarks.
// Iteration 4 measured the mean from ONE landmark to the other 26 (485.2);
// this walks every landmark as a source and averages over all ordered pairs,
// so it is a strictly larger sample of the same quantity. Run it on both
// assets to compare — the absolute number only means something against
// itself.
import { loadBake, NEW, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP } = S;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const path = process.argv[2] ?? NEW;
const city = loadBake(path);
const W = city.widthTiles,
  H = city.heightTiles,
  tiles = city.tiles;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const lab = new Int32Array(W * H).fill(-1);
const sizes = [];
let id = 0;
for (let s = 0; s < W * H; s++) {
  if (lab[s] >= 0 || !isRoad(tiles[s])) continue;
  const bag = [s];
  lab[s] = id;
  let n = 0;
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q],
      x = i % W,
      y = (i - x) / W;
    n++;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (lab[j] >= 0 || !isRoad(tiles[j])) continue;
      lab[j] = id;
      bag.push(j);
    }
  }
  sizes.push(n);
  id++;
}
sizes.sort((a, b) => b - a);
let road = 0;
for (let i = 0; i < W * H; i++) if (isRoad(tiles[i])) road++;

const nearestRoad = (x, y) => {
  for (let r = 0; r < 60; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const nx = Math.round(x) + dx,
          ny = Math.round(y) + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (isRoad(tiles[ny * W + nx])) return ny * W + nx;
      }
  return -1;
};
const bfs = (from) => {
  const d = new Int32Array(W * H).fill(-1);
  const q = [from];
  d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h],
      x = i % W,
      y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (d[j] >= 0 || !isRoad(tiles[j])) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  return d;
};

const anchors = city.landmarks.map((l) => ({ name: l.name, i: nearestRoad(l.x + l.w / 2, l.y + l.h / 2) })).filter((a) => a.i >= 0);
let sum = 0,
  pairs = 0,
  unreach = 0;
for (const a of anchors) {
  const d = bfs(a.i);
  for (const b of anchors) {
    if (b === a) continue;
    if (d[b.i] < 0) {
      unreach++;
      continue;
    }
    sum += d[b.i];
    pairs++;
  }
}
console.log(`${path.split('/').slice(-1)[0]}  (${process.env.LABEL ?? ''})`);
console.log(`  carriageway ${road} tiles in ${sizes.length} component(s): ${sizes.slice(0, 6).join(', ')}${sizes.length > 6 ? ', ...' : ''}`);
console.log(`  ${anchors.length} landmarks on the network; mean landmark-to-landmark travel distance ${(sum / pairs).toFixed(1)} over ${pairs} ordered pairs, ${unreach} unreachable`);
