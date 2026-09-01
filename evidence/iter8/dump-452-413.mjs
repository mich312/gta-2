// What is at 450..454, 413 — the two joints the parapet still turns sharply at?
//   node evidence/iter8/dump-452-413.mjs
import { loadBake, NEW, S } from '../iter7/lib.mjs';

const city = loadBake(NEW);
const W = city.widthTiles;
const CH = {
  [S.T_WATER]: '~',
  [S.T_BRIDGE]: 'B',
  [S.T_ROAD]: '#',
  [S.T_SIDEWALK]: ':',
  [S.T_FIELD]: '.',
  [S.T_PARK]: ',',
  [S.T_SAND]: 's',
  [S.T_BANK]: 'q',
  [S.T_TREES]: 'T',
  [S.T_LOT]: 'L',
  [S.T_BUILDING]: '#',
  [S.T_RAMP]: 'R',
};
for (let y = 405; y <= 421; y++) {
  let row = String(y).padStart(4) + ' ';
  for (let x = 440; x <= 466; x++) row += CH[city.tiles[y * W + x]] ?? '?';
  console.log(row);
}
console.log('     ' + '         450       460      '.slice(0, 27));

// Which courses reach here, and how wide.
const near = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax,
    dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const hits = [];
for (const c of city.courses ?? []) {
  let best = Infinity;
  for (let k = 0; k + 1 < c.points.length; k++) {
    const d = near(452, 413, c.points[k][0], c.points[k][1], c.points[k + 1][0], c.points[k + 1][1]);
    if (d < best) best = d;
  }
  if (best < 8) hits.push(`${c.kind} w=${c.width} at ${best.toFixed(2)} tiles`);
}
console.log('');
console.log('courses within 8 tiles of 452,413:');
for (const h of hits) console.log('  ' + h);
