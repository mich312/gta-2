// The seven mouths that DO join the ring outside the 9-tile authored-junction
// dilation. Either the shave leaks, or these are ground it never claimed to
// hold — an avenue running beside the ring, a ramp (the shave only reads
// T_ROAD and T_BRIDGE), or a pothole the relay put back.
//
// Run: node evidence/iter9/leaks.mjs
import { loadBake, NEW } from './lib.mjs';
import { T_ROAD, T_BRIDGE, T_RAMP, T_WATER, T_SIDEWALK, T_FIELD, T_PARK, T_BUILDING, T_LOT, T_BANK, T_SAND, T_TREES, T_FLOOR, T_RUNWAY } from '../../shared/dist/index.js';

const NAME = { [T_WATER]: 'water', [T_SAND]: 'sand', [T_BANK]: 'bank', [T_FIELD]: 'field', [T_PARK]: 'park', [T_TREES]: 'trees', [T_ROAD]: 'ROAD', [T_SIDEWALK]: 'sidewalk', [T_BUILDING]: 'building', [T_FLOOR]: 'floor', [T_LOT]: 'lot', [T_BRIDGE]: 'BRIDGE', [T_RAMP]: 'RAMP', [T_RUNWAY]: 'runway' };
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
function courseMask(kind) {
  const m = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind !== kind) continue;
    const half = c.width / 2;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k], [bx, by] = c.points[k + 1];
      for (let ty = Math.max(0, Math.floor(Math.min(ay, by) - half - 1)); ty <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1)); ty++)
        for (let tx = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1)); tx <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1)); tx++)
          if (segDist(tx + 0.5, ty + 0.5, ax, ay, bx, by) <= half) m[ty * W + tx] = 1;
    }
  }
  return m;
}
const ring = courseMask('ring'), avenue = courseMask('avenue'), street = courseMask('street');

const SITES = [[499, 107], [570, 612], [461, 118], [510, 122], [513, 123], [641, 307], [456, 664]];
for (const [x, y] of SITES) {
  const i = y * W + x;
  console.log(`\n=== ${x},${y}  tile=${NAME[tiles[i]]}  ringMask=${ring[i]} avenueMask=${avenue[i]} streetMask=${street[i]}`);
  // which named road runs nearest
  let best = null, bd = 1e9;
  for (const r of city.courses) {
    for (let k = 0; k + 1 < r.points.length; k++) {
      const d = segDist(x + 0.5, y + 0.5, ...r.points[k], ...r.points[k + 1]);
      if (d < bd) { bd = d; best = r; }
    }
  }
  console.log(`  nearest course: kind=${best.kind} width=${best.width} at ${bd.toFixed(2)} tiles`);
  let row = '  ';
  for (let dy = -3; dy <= 3; dy++) {
    row = '  ';
    for (let dx = -3; dx <= 3; dx++) {
      const j = (y + dy) * W + (x + dx);
      const t = tiles[j];
      const c = ring[j] === 1 ? 'R' : avenue[j] === 1 ? 'A' : isRoad(t) ? '#' : t === T_SIDEWALK ? ':' : t === T_FIELD || t === T_PARK ? '.' : t === T_BUILDING ? 'B' : '?';
      row += c;
    }
    console.log(row + (dy === 0 ? '   <- row of the site' : ''));
  }
}
