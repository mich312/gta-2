// ASCII dump of the baked tile plane around a point, with the baked course
// centrelines overlaid, so a verdict can be read off the ground itself rather
// than off a summary statistic.
//
//   node evidence/iter12-streets/dump.mjs <cx> <cy> [radius]
//
// Legend: # road  = bridge  r ramp  : sidewalk  . field  P park  T trees
//         s sand  ~ water  B building  L lot  Q bank/quay  f shop floor
//         R runway  ? an unlisted tile id.  A digit/letter over a road tile is
//         the index of a baked course whose centreline passes within 0.7 of it
//         (0-9 then a-z, keyed in the footer) — that is what "belongs to a
//         course" means here. EVERY tile id in `shared/src/world/types.ts` has
//         a glyph: an earlier draft mapped a `T_PAVEMENT` that does not exist
//         and silently drew sidewalk, lot, quay and floor as one "other".
import { S, loadBake, NEW } from '../iter10/lib.mjs';
const T = S;
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const cx = Number(process.argv[2]), cy = Number(process.argv[3]);
const R = Number(process.argv[4] ?? 18);
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const GLYPH = new Map([
  [T.T_FIELD, '.'], [T.T_ROAD, '#'], [T.T_SIDEWALK, ':'], [T.T_BUILDING, 'B'],
  [T.T_PARK, 'P'], [T.T_LOT, 'L'], [T.T_WATER, '~'], [T.T_BRIDGE, '='],
  [T.T_RAMP, 'r'], [T.T_FLOOR, 'f'], [T.T_BANK, 'Q'], [T.T_TREES, 'T'],
  [T.T_SAND, 's'], [T.T_RUNWAY, 'R'],
]);
for (const [k, v] of GLYPH) if (k === undefined) throw new Error(`legend names a tile constant that does not exist (glyph ${v})`);
const ch = (t) => (t === -1 ? ' ' : (GLYPH.get(t) ?? '?'));
const clen = (p) => { let l = 0; for (let k = 1; k < p.length; k++) l += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]); return l; };
function distTo(pts, x, y) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) best = d;
  }
  return best;
}
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');
const near = roads.filter((c) => c.points.some(([x, y]) => Math.abs(x - cx) <= R + 6 && Math.abs(y - cy) <= R + 6));
const SYM = '0123456789abcdefghijklmnopqrstuvwxyz';
console.log(`# tiles around ${cx},${cy} radius ${R}`);
let head = '     ';
for (let x = cx - R; x <= cx + R; x++) head += x % 10 === 0 ? '|' : ' ';
console.log(head);
for (let y = cy - R; y <= cy + R; y++) {
  let row = String(y).padStart(4) + ' ';
  for (let x = cx - R; x <= cx + R; x++) {
    const t = at(x, y);
    let c = ch(t);
    if (c === '#' || c === '=' || c === 'r') {
      const k = near.findIndex((o) => distTo(o.points, x + 0.5, y + 0.5) <= 0.7);
      if (k >= 0) c = SYM[k];
    }
    row += c;
  }
  console.log(row);
}
console.log('\ncourses in view:');
near.forEach((c, k) => {
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  console.log(`  ${SYM[k]} = #${c.i} ${c.kind} w=${c.width} len=${clen(c.points).toFixed(1)}  ${p0[0].toFixed(0)},${p0[1].toFixed(0)} -> ${q1[0].toFixed(0)},${q1[1].toFixed(0)}`);
});
