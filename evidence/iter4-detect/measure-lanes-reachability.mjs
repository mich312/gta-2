import { readFileSync } from 'node:fs';
import { loadBake, plan, NEW, ROOT, S } from './lib.mjs';

const raw = JSON.parse(readFileSync(`${ROOT}/shared/data/city-plan.json`, 'utf8'));
const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR, T_FIELD, T_LOT, T_PARK, T_TREES, T_SIDEWALK, pointInPoly } = S;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;

const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of d.area) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (!inPoly[i] && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[i] = 1;
    }
}
function distToPoly(pts, x, y) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
}
const arterial = (x, y) => raw.roads.some((r) => distToPoly(r.points, x + 0.5, y + 0.5) <= 6);

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
    if (bag.length >= 1000 && road / bag.length >= 0.1 && built / bag.length < 0.01) {
      const mask = new Uint8Array(W * H);
      for (const i of bag) mask[i] = 1;
      out.push({ bag, mask, x0, y0, x1, y1, road, built });
    }
  }
  return out;
}
const regions = findRegions();

function comps(skip) {
  const lab = new Int32Array(W * H).fill(-1);
  const sizes = [];
  let id = 0;
  for (let s = 0; s < W * H; s++) {
    if (lab[s] >= 0 || !isRoad(tiles[s]) || (skip && skip[s])) continue;
    const bag = [s]; lab[s] = id; let n = 0;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q], x = i % W, y = (i - x) / W;
      n++;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (lab[j] >= 0 || !isRoad(tiles[j]) || (skip && skip[j])) continue;
        lab[j] = id; bag.push(j);
      }
    }
    sizes.push(n); id++;
  }
  sizes.sort((a, b) => b - a);
  return { lab, sizes };
}

// BFS travel distance over carriageway
function bfs(fromIdx, skip) {
  const d = new Int32Array(W * H).fill(-1);
  const q = [fromIdx]; d[fromIdx] = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (d[j] >= 0 || !isRoad(tiles[j]) || (skip && skip[j])) continue;
      d[j] = d[i] + 1; q.push(j);
    }
  }
  return d;
}
const nearestRoad = (x, y) => {
  for (let r = 0; r < 60; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (isRoad(tiles[ny * W + nx])) return ny * W + nx;
      }
  return -1;
};

// district built density, over LAND tiles owned by each district polygon
const owner = new Int16Array(W * H).fill(-1);
for (const [di, d] of plan.districts.entries()) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of d.area) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
}
console.log('district built share over its own land (buildings/floor):');
const dens = [];
for (const [di, d] of plan.districts.entries()) {
  let land = 0, built = 0;
  for (let i = 0; i < W * H; i++) {
    if (owner[i] !== di || tiles[i] === T_WATER) continue;
    land++;
    if (tiles[i] === T_BUILDING || tiles[i] === T_FLOOR) built++;
  }
  if (land < 200) continue;
  dens.push([d.name, land, built, built / land, !!d.rural]);
}
for (const [n, l, b, s, r] of dens) console.log(`   ${n.padEnd(16)} ${r ? 'rural ' : 'urban '} land ${String(l).padStart(6)}  built ${String(b).padStart(6)}  ${(100 * s).toFixed(1)}%`);
const ruralShare = dens.filter((x) => x[4]).reduce((a, x) => a + x[2], 0) / dens.filter((x) => x[4]).reduce((a, x) => a + x[1], 0);
console.log(`   rural districts as a whole: ${(100 * ruralShare).toFixed(1)}% built`);
console.log(`   city buildings ${city.buildings.length}; mean building footprint ${(city.buildings.reduce((a, b) => a + b.w * b.h, 0) / city.buildings.length).toFixed(1)} tiles`);

const base = comps(null);
console.log(`\nbaseline carriageway: ${base.sizes.length} comp, ${base.sizes[0]} tiles`);

// travel probes: two landmarks on either side of the city
const probes = [];
for (const l of city.landmarks.slice(0, 40)) probes.push([l.name, Math.round(l.x + l.w / 2), Math.round(l.y + l.h / 2)]);

for (const r of regions) {
  const tag = `${r.x0},${r.y0}-${r.x1},${r.y1}`;
  let art = 0, lat = 0;
  const skipLat = new Uint8Array(W * H);
  const skipAll = new Uint8Array(W * H);
  for (const i of r.bag) {
    if (!isRoad(tiles[i])) continue;
    const x = i % W, y = (i - x) / W;
    skipAll[i] = 1;
    if (arterial(x, y)) art++;
    else { lat++; skipLat[i] = 1; }
  }
  console.log(`\n##### ${tag} land=${r.bag.length} road=${r.road}: arterial ${art}, lattice ${lat}`);
  const cA = comps(skipAll), cL = comps(skipLat);
  console.log(`   remove ALL its lanes:     ${cA.sizes.length} comp, sizes ${cA.sizes.slice(0, 5).join(', ')}`);
  console.log(`   remove only the LATTICE:  ${cL.sizes.length} comp, sizes ${cL.sizes.slice(0, 5).join(', ')}`);

  // what else lives on those lanes
  const inR = (x, y) => r.mask[Math.round(y) * W + Math.round(x)] === 1;
  const sh = city.shops.filter((v) => inR(v.x, v.y)).length;
  const lm = city.landmarks.filter((l) => inR(l.x + l.w / 2, l.y + l.h / 2)).length;
  const bd = city.buildings.filter((b) => inR(b.x + b.w / 2, b.y + b.h / 2)).length;
  const bl = city.blocks.filter((b) => inR(b.x + b.w / 2, b.y + b.h / 2)).length;
  let pave = 0;
  for (const i of r.bag) if (tiles[i] === T_SIDEWALK) pave++;
  console.log(`   on this ground: ${sh} shops, ${lm} landmarks, ${bd} buildings, ${bl} block rects, ${pave} pavement tiles (kerbside spawning and the crowd live on pavement)`);

  // detour: worst travel-distance blow-up between landmark pairs
  let worst = null;
  const from = probes.filter((p) => !inR(p[1], p[2]));
  const src = nearestRoad(from[0][1], from[0][2]);
  const dBase = bfs(src, null);
  const dLat = bfs(src, skipLat);
  const dAll = bfs(src, skipAll);
  let sumB = 0, sumL = 0, sumA = 0, n = 0, unreachL = 0, unreachA = 0;
  for (const p of from.slice(1)) {
    const t = nearestRoad(p[1], p[2]);
    if (t < 0 || dBase[t] < 0) continue;
    n++; sumB += dBase[t];
    if (dLat[t] < 0) unreachL++; else sumL += dLat[t];
    if (dAll[t] < 0) unreachA++; else sumA += dAll[t];
  }
  console.log(`   travel from ${from[0][0]} to ${n} other landmarks, mean carriageway distance:`);
  console.log(`      baseline ${(sumB / n).toFixed(1)}  |  lattice removed ${(sumL / (n - unreachL)).toFixed(1)} (${unreachL} unreachable)  |  all removed ${(sumA / (n - unreachA)).toFixed(1)} (${unreachA} unreachable)`);

  // how much open ground it has for a smallholding treatment
  let open = 0, nearLane = 0;
  for (const i of r.bag) {
    const t = tiles[i];
    if (t === T_FIELD || t === T_LOT || t === T_PARK || t === T_TREES) {
      open++;
      const x = i % W, y = (i - x) / W;
      let near = false;
      for (let dy = -8; dy <= 8 && !near; dy++) for (let dx = -8; dx <= 8 && !near; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && isRoad(tiles[ny * W + nx])) near = true;
      }
      if (near) nearLane++;
    }
  }
  console.log(`   open ground ${open} tiles, ${nearLane} within 8 of a lane`);
  console.log(`   at the rural districts' ${(100 * ruralShare).toFixed(1)}% built share that is ~${Math.round(open * ruralShare)} built tiles, ~${Math.round(open * ruralShare / (city.buildings.reduce((a, b) => a + b.w * b.h, 0) / city.buildings.length))} buildings`);
}
