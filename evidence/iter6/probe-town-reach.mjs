// If the block cut clipped to the same thing the esplanade does — the ground a
// borough OWNS within `CLAIM_REACH` of the ground it was DRAWN on — instead of
// to `polyBounds(d.area)`, how much ground changes hands?
//
// Two directions, and both matter:
//   gained  owned, within reach, but OUTSIDE the borough's polygon bbox — the
//           ground the lattice and the block cut never arrive at today.
//   lost    owned, inside the bbox, but BEYOND reach — town the depth gate
//           would take away from a pass that lays it today.
//
// Needs the pass hook only for `claimDepth`, which `buildLayout` does not
// return; it is recomputed here from `owner` + `water` exactly as
// `paintOwnership` does (BFS over land from the polygon-owned tiles).
//
//   node evidence/iter6/probe-town-reach.mjs [reach]
import { loadBake, NEW, S, plan } from './lib.mjs';
const { buildLayout, polyBounds, pointInPoly, T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR } = S;

const REACH = Number(process.argv[2] ?? 24);
const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const layout = buildLayout(plan);
const { owner, water } = layout;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

// claimDepth, recomputed: 0 inside the authored polygon, D1's BFS depth over
// land outside it.
const depth = new Int32Array(W * H).fill(-1);
const inPoly = new Uint8Array(W * H);
const bag = [];
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}
for (let i = 0; i < W * H; i++) {
  if (inPoly[i] === 1 && water[i] !== 1) {
    depth[i] = 0;
    bag.push(i);
  }
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

console.log(`# CLAIM_REACH = ${REACH}`);
console.log('# per borough: the rect the lattice and block cut run over today (polyBounds),');
console.log('# and the rect they would run over if they clipped to owner-within-reach.');
let gained = 0;
let lost = 0;
for (const [di, d] of plan.districts.entries()) {
  const [rx, ry, rx1, ry1] = polyBounds(d.area);
  let nx0 = W;
  let ny0 = H;
  let nx1 = -1;
  let ny1 = -1;
  let g = 0;
  let l = 0;
  for (let i = 0; i < W * H; i++) {
    if (owner[i] !== di || water[i] === 1) continue;
    const x = i % W;
    const y = (i - x) / W;
    const inRect = x >= rx && x <= rx1 && y >= ry && y <= ry1;
    const near = depth[i] >= 0 && depth[i] <= REACH;
    if (near) {
      if (x < nx0) nx0 = x;
      if (y < ny0) ny0 = y;
      if (x > nx1) nx1 = x;
      if (y > ny1) ny1 = y;
      if (!inRect) g++;
    } else if (inRect) l++;
  }
  gained += g;
  lost += l;
  console.log(
    `${d.name.padEnd(16)} poly [${rx},${ry}-${rx1},${ry1}]  reach [${nx0},${ny0}-${nx1},${ny1}]  gained ${g}  lost ${l}`,
  );
}
console.log(`\ntotal gained ${gained}, total lost ${lost}`);

// And what that does to the two flagged regions.
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const seen = new Uint8Array(W * H);
for (let s = 0; s < W * H; s++) {
  if (seen[s] === 1 || inPoly[s] === 1 || tiles[s] === T_WATER) continue;
  const q = [s];
  seen[s] = 1;
  const f = { land: 0, road: 0, built: 0, near: 0, nearFree: 0, x0: W, y0: H, x1: -1, y1: -1 };
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % W;
    const y = (i - x) / W;
    f.land++;
    if (x < f.x0) f.x0 = x;
    if (y < f.y0) f.y0 = y;
    if (x > f.x1) f.x1 = x;
    if (y > f.y1) f.y1 = y;
    if (isRoad(tiles[i])) f.road++;
    if (tiles[i] === T_BUILDING || tiles[i] === T_FLOOR) f.built++;
    if (depth[i] >= 0 && depth[i] <= REACH) {
      f.near++;
      if (!isRoad(tiles[i])) f.nearFree++;
    }
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] === 1 || inPoly[j] === 1 || tiles[j] === T_WATER) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  if (f.land < 1000 || f.road / f.land < 0.1) continue;
  console.log(
    `\nregion ${f.x0},${f.y0}-${f.x1},${f.y1}: land ${f.land}, road ${f.road}, built ${f.built}` +
      `\n  within reach ${REACH}: ${f.near} tiles (${((100 * f.near) / f.land).toFixed(1)}%), ` +
      `${f.nearFree} of them not already carriageway — the ground a block cut could reach`,
  );
}
