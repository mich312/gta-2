// Do the four stepped bridge decks have an authored centreline the renderer
// could follow instead of the tile outline?
//   node evidence/iter7/courses.mjs
import { loadBake, NEW, S } from './lib.mjs';

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const kinds = {};
for (const c of city.courses ?? []) {
  kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
}
console.log(`courses: ${(city.courses ?? []).length}`);
console.log('by kind:', kinds);
console.log('');

// The four bridge-deck findings, by their reported midpoint.
const sites = [[274, 361], [200, 226], [178, 478], [274, 305]];
const near = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
};
for (const [sx, sy] of sites) {
  let best = Infinity, bestC = null;
  for (const c of city.courses ?? []) {
    for (let i = 0; i + 1 < c.points.length; i++) {
      const d = near(sx, sy, c.points[i][0], c.points[i][1], c.points[i + 1][0], c.points[i + 1][1]);
      if (d < best) { best = d; bestC = c; }
    }
  }
  console.log(`deck ${sx},${sy}: nearest course ${best.toFixed(2)} tiles away` +
    (bestC ? ` kind=${bestC.kind} width=${bestC.width} pts=${bestC.points.length}` : ' (none)'));
}

// How many T_BRIDGE tiles are within half a width of some course?
const T_BRIDGE = S.T_BRIDGE;
let deck = 0, covered = 0;
for (let i = 0; i < city.tiles.length; i++) {
  if (city.tiles[i] !== T_BRIDGE) continue;
  deck++;
  const x = (i % W) + 0.5, y = ((i / W) | 0) + 0.5;
  let d = Infinity;
  for (const c of city.courses ?? []) {
    for (let k = 0; k + 1 < c.points.length; k++) {
      const dd = near(x, y, c.points[k][0], c.points[k][1], c.points[k + 1][0], c.points[k + 1][1]);
      if (dd < d) d = dd;
      if (d < 0.5) break;
    }
  }
  if (d <= 6) covered++;
}
console.log(`\nT_BRIDGE tiles: ${deck}, within 6 tiles of a course: ${covered} (${(100 * covered / deck).toFixed(1)}%)`);
