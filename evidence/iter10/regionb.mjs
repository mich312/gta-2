// Are the two Ravenhill spine deadends inside the SAME ground that
// `lanes-serving-nothing` region B flags? Iteration 6 proved that region cannot
// be closed by removing road — the only route is clipping the block cut to
// owner-within-CLAIM_REACH, 12,782 tiles changing hands, escalated as a plan
// decision. If these caps sit in it, they are not independently fixable.
//
// Region B is rebuilt the way mapAudit builds it: connected components of dry
// land outside every district polygon (point-in-polygon, no flood).
//
//   node evidence/iter10/regionb.mjs
import { S, loadBake, NEW, plan } from './lib.mjs';
const { polyBounds, pointInPoly, T_WATER, T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (!inPoly[ty * W + tx] && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}
const seen = new Uint8Array(W * H);
const regions = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] || inPoly[s] || tiles[s] === T_WATER) continue;
  const bag = [s];
  seen[s] = 1;
  const f = { land: 0, road: 0, x0: W, y0: H, x1: -1, y1: -1, cells: new Set() };
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q], x = i % W, y = (i - x) / W;
    f.land++;
    f.cells.add(i);
    if (isRoad(tiles[i])) f.road++;
    if (x < f.x0) f.x0 = x; if (x > f.x1) f.x1 = x;
    if (y < f.y0) f.y0 = y; if (y > f.y1) f.y1 = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] || inPoly[j] || tiles[j] === T_WATER) continue;
      seen[j] = 1; bag.push(j);
    }
  }
  regions.push(f);
}
regions.sort((a, b) => b.road - a.road);
console.log('the two regions lanes-serving-nothing flags:');
for (const r of regions.slice(0, 2))
  console.log(`  [${r.x0},${r.y0}-${r.x1},${r.y1}]  land ${r.land}  road ${r.road}  (${((r.road / r.land) * 100).toFixed(1)}%)`);

console.log('\nare the four road-deadend caps inside one of them?');
for (const [x, y, name] of [[415, 672, 'esplanade'], [321, 327, 'Ravenhill spine'], [478, 600, 'crescent'], [342, 312, 'Ravenhill spine']]) {
  const i = y * W + x;
  const k = regions.findIndex((r) => r.cells.has(i));
  console.log(`  ${String(x).padStart(3)},${String(y).padStart(3)} ${name.padEnd(16)} ${k === 0 ? 'REGION A (the 1198-road one)' : k === 1 ? 'REGION B (the 1140-road one)' : k < 0 ? 'inside a district polygon — not in any fringe region' : `fringe region #${k} (land ${regions[k].land}, road ${regions[k].road})`}`);
}
