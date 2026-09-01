// Does the baked course polyline REPRODUCE the deck's tile mask?
//
//   node evidence/iter8/deck-curve-probe.mjs
//
// `carveCourse` (layout.ts:770) rasterises a carriageway as a SWEPT DISC:
// a tile is laid when `segmentDistance(tx+0.5, ty+0.5, seg) <= width/2`.
// The baked `courses` array records the same polyline and the same width
// (layout.ts:938). So the deck's true outline is the offset curve at
// `width/2` and the tile mask should be exactly its point-sample.
//
// If that holds, cutting a boundary tile on that offset curve is not an
// approximation of the deck edge — it IS the deck edge, and the staircase
// is the rasterisation error we would be removing.
//
// The control: run the same test on a random non-deck sample. It must NOT
// come out clean, otherwise the test says yes to everything.
import { loadBake, NEW, S } from '../iter7/lib.mjs';

const { T_BRIDGE, T_WATER } = S;
const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : t[y * W + x]);

const segD = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax,
    dy = by - ay;
  const L = dx * dx + dy * dy;
  let u = L === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const qx = ax + u * dx - px,
    qy = ay + u * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
};

// signed "inside-ness": max over courses of (half - distance). >= 0 means the
// swept disc covers this point.
const inside = (px, py) => {
  let best = -Infinity;
  for (const c of city.courses ?? []) {
    const half = c.width / 2;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const d =
        half - segD(px, py, c.points[k][0], c.points[k][1], c.points[k + 1][0], c.points[k + 1][1]);
      if (d > best) best = d;
    }
  }
  return best;
};

let deck = 0,
  deckIn = 0;
let wetFace = 0,
  wetOut = 0;
const misses = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (at(x, y) !== T_BRIDGE) continue;
    deck++;
    if (inside(x + 0.5, y + 0.5) >= 0) deckIn++;
    else if (misses.length < 8) misses.push(['deck-not-covered', x, y]);
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      if (at(x + dx, y + dy) !== T_WATER) continue;
      wetFace++;
      if (inside(x + dx + 0.5, y + dy + 0.5) < 0) wetOut++;
      else if (misses.length < 8) misses.push(['water-inside-disc', x + dx, y + dy]);
    }
  }
}
console.log(`deck tiles                       ${deck}`);
console.log(`  covered by the swept disc      ${deckIn}  (${((100 * deckIn) / deck).toFixed(2)}%)`);
console.log(`deck/water faces                 ${wetFace}`);
console.log(
  `  water tile OUTSIDE the disc    ${wetOut}  (${((100 * wetOut) / wetFace).toFixed(2)}%)`,
);
if (misses.length) console.log('  first misses:', JSON.stringify(misses));

// CONTROL — the same question of ordinary open water well away from any deck.
// A test that says "covered" for everything proves nothing.
let ctl = 0,
  ctlIn = 0;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
while (ctl < 4000) {
  const x = (rnd() * W) | 0,
    y = (rnd() * H) | 0;
  if (at(x, y) !== T_WATER) continue;
  let nearDeck = false;
  for (let j = -3; j <= 3 && !nearDeck; j++)
    for (let i = -3; i <= 3; i++)
      if (at(x + i, y + j) === T_BRIDGE) {
        nearDeck = true;
        break;
      }
  if (nearDeck) continue;
  ctl++;
  if (inside(x + 0.5, y + 0.5) >= 0) ctlIn++;
}
console.log('');
console.log(`CONTROL open water away from any deck   ${ctl} samples`);
console.log(`  covered by the swept disc             ${ctlIn}  (${((100 * ctlIn) / ctl).toFixed(2)}%)`);
console.log(
  ctlIn / ctl < 0.02
    ? '  -> the test discriminates: it says no to open water and yes to deck.'
    : '  -> WARNING: the test says yes to open water too. It is not discriminating.',
);
