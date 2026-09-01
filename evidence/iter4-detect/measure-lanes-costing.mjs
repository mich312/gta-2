import { loadBake, plan, NEW, ROOT, S } from './lib.mjs';
const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR, T_SIDEWALK, T_LOT, pointInPoly } = S;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;

const inPoly = new Uint8Array(W * H);
const owner = new Int16Array(W * H).fill(-1);
for (const [di, d] of plan.districts.entries()) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of d.area) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) { inPoly[ty * W + tx] = 1; owner[ty * W + tx] = di; }
}

// built share per BLOCK, grouped rural / urban
let rl = 0, rb = 0, ul = 0, ub = 0;
for (const b of city.blocks) {
  let l = 0, bu = 0;
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++)
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) {
      const t = tiles[y * W + x];
      if (t === T_WATER) continue;
      l++;
      if (t === T_BUILDING || t === T_FLOOR) bu++;
    }
  if (b.rural) { rl += l; rb += bu; } else { ul += l; ub += bu; }
}
console.log(`built share INSIDE blocks:  rural blocks ${rb}/${rl} = ${(100 * rb / rl).toFixed(1)}%   urban blocks ${ub}/${ul} = ${(100 * ub / ul).toFixed(1)}%`);
const foot = city.buildings.reduce((a, b) => a + b.w * b.h, 0) / city.buildings.length;
console.log(`mean building footprint ${foot.toFixed(1)} tiles`);

// pavement share inside urban blocks — the other cost of an urban treatment
let up = 0, rp = 0;
for (const b of city.blocks) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++)
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) {
      const t = tiles[y * W + x];
      if (t !== T_SIDEWALK && t !== T_LOT) continue;
      if (b.rural) rp++; else up++;
    }
}
console.log(`pavement+lot INSIDE blocks: rural ${(100 * rp / rl).toFixed(1)}%   urban ${(100 * up / ul).toFixed(1)}%`);

// regions, and which districts they touch
function findRegions() {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || inPoly[s] || tiles[s] === T_WATER) continue;
    const bag = [s]; seen[s] = 1;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, road = 0, built = 0;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q], x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      if (isRoad(tiles[i])) road++;
      if (tiles[i] === T_BUILDING || tiles[i] === T_FLOOR) built++;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] || inPoly[j] || tiles[j] === T_WATER) continue;
        seen[j] = 1; bag.push(j);
      }
    }
    if (bag.length >= 1000 && road / bag.length >= 0.1 && built / bag.length < 0.01) out.push({ bag, x0, y0, x1, y1, road, built });
  }
  return out;
}
for (const r of findRegions()) {
  const touch = new Map();
  for (const i of r.bag) {
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const o = owner[ny * W + nx];
      if (o >= 0) touch.set(o, (touch.get(o) ?? 0) + 1);
    }
  }
  console.log(`\n${r.x0},${r.y0}-${r.x1},${r.y1} land=${r.bag.length} borders:`);
  for (const [o, n] of [...touch.entries()].sort((a, b) => b[1] - a[1])) {
    const d = plan.districts[o];
    console.log(`   ${String(n).padStart(5)} tiles of seam with ${d.name} (${d.rural ? 'rural' : 'urban'}, pitch ${d.street.pitchX}x${d.street.pitchY})`);
  }
  // ground available if it were treated like a rural / urban block
  let open = 0;
  for (const i of r.bag) {
    const t = tiles[i];
    if (t === T_BUILDING || t === T_FLOOR || isRoad(t) || t === T_WATER) continue;
    open++;
  }
  console.log(`   non-road, non-built ground: ${open} tiles`);
  console.log(`     smallholding treatment (rural-block density ${(100 * rb / rl).toFixed(1)}%): ~${Math.round(open * rb / rl)} built tiles, ~${Math.round(open * rb / rl / foot)} buildings`);
  console.log(`     urban fringe treatment  (urban-block density ${(100 * ub / ul).toFixed(1)}%): ~${Math.round(open * ub / ul)} built tiles, ~${Math.round(open * ub / ul / foot)} buildings, plus ~${Math.round(open * up / ul)} tiles of pavement/lot`);
}
