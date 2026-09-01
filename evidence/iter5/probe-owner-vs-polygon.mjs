// Where does the lattice on unclaimed ground come from?
//
// `paintOwnership` (layout.ts) floods `owner` over EVERY dry tile, then
// `weaveFabrics` clips each borough's lattice to `owner === di`. So the
// lattice follows the flood, not the polygon. This prints how far the flood
// reaches past the authored outlines, and how much carriageway sits at each
// distance — the number that decides where a claim-radius cut would fall.
import { loadBake, plan, NEW, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, pointInPoly } = S;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const city = loadBake(NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  tiles = city.tiles;

const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [px, py] of d.area) {
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (!inPoly[i] && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[i] = 1;
    }
}

// 4-connected distance from the nearest polygon-claimed tile, measured over
// dry land only — the same ground the ownership flood walks.
const dist = new Int32Array(W * H).fill(-1);
const q = [];
for (let i = 0; i < W * H; i++)
  if (inPoly[i] && tiles[i] !== T_WATER) {
    dist[i] = 0;
    q.push(i);
  }
for (let h = 0; h < q.length; h++) {
  const i = q[h],
    x = i % W,
    y = (i - x) / W;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx,
      ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (dist[j] >= 0 || tiles[j] === T_WATER) continue;
    dist[j] = dist[i] + 1;
    q.push(j);
  }
}

let land = 0,
  road = 0,
  outLand = 0,
  outRoad = 0,
  unreached = 0,
  unreachedRoad = 0;
const bucket = new Map();
for (let i = 0; i < W * H; i++) {
  if (tiles[i] === T_WATER) continue;
  land++;
  if (isRoad(tiles[i])) road++;
  if (inPoly[i]) continue;
  outLand++;
  if (isRoad(tiles[i])) outRoad++;
  const d = dist[i];
  if (d < 0) {
    unreached++;
    if (isRoad(tiles[i])) unreachedRoad++;
    continue;
  }
  const b =
    d <= 4 ? '01-04'
    : d <= 8 ? '05-08'
    : d <= 12 ? '09-12'
    : d <= 16 ? '13-16'
    : d <= 24 ? '17-24'
    : d <= 40 ? '25-40'
    : d <= 80 ? '41-80'
    : '81+';
  const e = bucket.get(b) ?? [0, 0];
  e[0]++;
  if (isRoad(tiles[i])) e[1]++;
  bucket.set(b, e);
}
console.log(`dry land ${land}, carriageway ${road}`);
console.log(`land outside every district polygon: ${outLand} tiles, ${outRoad} carriageway`);
console.log(
  `unreachable-over-land from any polygon tile (islets the wet wave claims): ${unreached} tiles, ${unreachedRoad} carriageway`,
);
console.log('\ndistance from the nearest polygon tile, walked over land:');
console.log('  band     land   carriageway   cumulative carriageway');
let cum = 0;
for (const b of ['01-04', '05-08', '09-12', '13-16', '17-24', '25-40', '41-80', '81+']) {
  const e = bucket.get(b);
  if (!e) continue;
  cum += e[1];
  console.log(`  ${b.padEnd(7)} ${String(e[0]).padStart(6)}   ${String(e[1]).padStart(6)}        ${String(cum).padStart(6)}`);
}
