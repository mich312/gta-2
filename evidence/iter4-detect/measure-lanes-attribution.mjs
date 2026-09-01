import { readFileSync } from 'node:fs';
import { loadBake, plan, NEW, ROOT, S } from './lib.mjs';

const raw = JSON.parse(readFileSync(`${ROOT}/shared/data/city-plan.json`, 'utf8'));
const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR, pointInPoly } = S;
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

function region(seedX, seedY) {
  const s = seedY * W + seedX;
  const seen = new Uint8Array(W * H);
  const bag = [s]; seen[s] = 1;
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q], x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] || inPoly[j] || tiles[j] === T_WATER) continue;
      seen[j] = 1; bag.push(j);
    }
  }
  return { bag, mask: seen };
}

// find seeds by scanning for the two known regions
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

const regions = findRegions();

// distance from a course polyline
function distToPoly(pts, x, y) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - x, py = ay + dy * t - y;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}

for (const r of regions) {
  const tag = `${r.x0},${r.y0}-${r.x1},${r.y1}`;
  console.log(`\n##### ${tag}  land=${r.bag.length} road=${r.road} built=${r.built}`);
  // which AUTHORED road (by plan name) covers each carriageway tile
  const tally = new Map();
  let uncovered = 0;
  for (const i of r.bag) {
    if (!isRoad(tiles[i])) continue;
    const x = i % W + 0.5, y = (i - (i % W)) / W + 0.5;
    let bestName = null, bestD = Infinity;
    for (const road of raw.roads) {
      const d = distToPoly(road.points, x, y);
      if (d < bestD) { bestD = d; bestName = road.name; }
    }
    if (bestD <= 6) tally.set(bestName, (tally.get(bestName) ?? 0) + 1);
    else uncovered++;
  }
  console.log('  carriageway by nearest authored road (<=6 tiles):');
  for (const [n, c] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(c).padStart(5)}  ${n}`);
  console.log(`     ${String(uncovered).padStart(5)}  (no authored road within 6 tiles — lattice/fringe lanes)`);
}
