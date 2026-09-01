// The 418 in "418 rail boxes at a step", after.
//
//   node evidence/iter8/parapet-census.mjs
//
// Iteration 7 sized the drawn defect as 872 rail boxes of which 418 stand at
// the end of a tread — a visible jog. That metric is defined over
// AXIS-ALIGNED PER-FACE boxes and there are none left, so quoting "0 of 872"
// would be quoting a metric that no longer has a subject. This reports the
// two quantities that replace it, city-wide and not on the four findings:
//
//   * how many parapet boxes stand on an axis at all;
//   * the TURN at each joint — 90 degrees is the jog the old parapet made at
//     every step, and a curve's own bend is a fraction of a degree.
//
// The rule is `buildBridgeRails`'s, transcribed: a chord earns a parapet when
// the tile 0.75 off it on the wet side is open water.
import { loadBake, NEW, S } from '../iter7/lib.mjs';

const { T_WATER, buildDeckCut } = S;
const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : t[y * W + x]);
const cut = buildDeckCut(t, W, H, city.courses);

const rails = [];
for (const [idx, seg] of cut) {
  const tx = idx % W,
    ty = (idx - tx) / W;
  const ax = tx + seg[0],
    ay = ty + seg[1],
    bx = tx + seg[2],
    by = ty + seg[3];
  const vx = bx - ax,
    vy = by - ay;
  const len = Math.hypot(vx, vy);
  if (len === 0) continue;
  const wx = -vy / len,
    wy = vx / len;
  const mx = (ax + bx) / 2,
    my = (ay + by) / 2;
  if (at(Math.floor(mx + wx * 0.75), Math.floor(my + wy * 0.75)) !== T_WATER) continue;
  rails.push({ ax, ay, bx, by, bearing: Math.atan2(vy, vx), len });
}

const offAxis = (r) => {
  const d = ((((r.bearing * 180) / Math.PI) % 180) + 180) % 180;
  return Math.min(d, Math.abs(d - 90), Math.abs(d - 180));
};
const axial = rails.filter((r) => offAxis(r) < 5).length;
console.log(`parapet boxes                       ${rails.length}`);
console.log(`  standing on an axis (<5 deg)      ${axial}`);
console.log(`  total length, tiles               ${rails.reduce((s, r) => s + r.len, 0).toFixed(1)}`);

// Joints: two boxes whose ends meet. The TURN between them is what a step is.
const key = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
const byEnd = new Map();
for (let i = 0; i < rails.length; i++) {
  for (const [x, y] of [
    [rails[i].ax, rails[i].ay],
    [rails[i].bx, rails[i].by],
  ]) {
    const k = key(x, y);
    if (!byEnd.has(k)) byEnd.set(k, []);
    byEnd.get(k).push(i);
  }
}
const turns = [];
const sharp = [];
for (const [, list] of byEnd) {
  if (list.length !== 2) continue;
  let d = Math.abs(rails[list[0]].bearing - rails[list[1]].bearing);
  d = ((d % (2 * Math.PI)) * 180) / Math.PI;
  if (d > 180) d = 360 - d;
  if (d > 90) d = 180 - d; // direction of travel is not signed here
  turns.push(d);
  if (d > 30) sharp.push(`${d.toFixed(1)}deg at ${rails[list[0]].ax.toFixed(1)},${rails[list[0]].ay.toFixed(1)}`);
}
turns.sort((a, b) => a - b);
const q = (f) => (turns.length ? turns[Math.min(turns.length - 1, Math.floor(f * turns.length))] : NaN);
console.log('');
console.log(`joints where two boxes meet         ${turns.length}`);
console.log(`  turn: median ${q(0.5).toFixed(2)} deg   p90 ${q(0.9).toFixed(2)} deg   worst ${q(1).toFixed(2)} deg`);
console.log(`  joints turning more than 30 deg   ${turns.filter((d) => d > 30).length}`);
if (sharp.length) console.log(`    ${sharp.join('   ')}`);
console.log('');
console.log('Before, every joint at the end of a tread turned 90 degrees, and');
console.log('there were 418 of them (evidence/iter7/deck-census.txt).');
