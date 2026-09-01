// What does the new deck curve actually cover, and does it hold together?
//
//   node evidence/iter8/deck-cut-census.mjs
//
// Iteration 7's population count is the target: 872 deck/water faces, 835
// covered by NEITHER chain, 418 rail boxes standing at a step. This asks the
// same questions of `buildDeckCut` and adds three the fix has to pass:
//
//  * every deck/water face now has a chain over one of its two tiles;
//  * the chain is CONTINUOUS — a chord's endpoint on a shared tile border is
//    the neighbour's endpoint too, so the parapet joins rather than gapping;
//  * no crossed tile carries a road marking, so cutting it cannot lose one.
//
// CONTROL at the bottom: the same coverage question asked of a deck curve
// built from NO courses. It must come out at zero, or "covered" means nothing.
import { loadBake, NEW, S } from '../iter7/lib.mjs';

const { T_BRIDGE, T_WATER, buildDeckCut, shoreChains } = S;
const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : t[y * W + x]);

const cut = buildDeckCut(t, W, H, city.courses);
const coast = shoreChains(city.shores, W, H);
const band = shoreChains(city.banks, W, H);

let faces = 0,
  onDeck = 0,
  onCoast = 0,
  bare = 0;
const bareAt = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (at(x, y) !== T_BRIDGE) continue;
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      if (at(x + dx, y + dy) !== T_WATER) continue;
      faces++;
      const i = y * W + x,
        j = (y + dy) * W + (x + dx);
      if (cut.has(i) || cut.has(j)) onDeck++;
      else if (coast.has(i) || coast.has(j) || band.has(i) || band.has(j)) onCoast++;
      else {
        bare++;
        if (bareAt.length < 12) bareAt.push(`${x},${y}->${x + dx},${y + dy}`);
      }
    }
  }
}
console.log(`chained tiles           ${cut.size}`);
console.log(`deck/water faces        ${faces}`);
console.log(`  covered by DECK curve ${onDeck}`);
console.log(`  covered by coast/bank ${onCoast}`);
console.log(`  covered by NEITHER    ${bare}`);
if (bareAt.length) console.log('  first bare faces:', bareAt.join(' '));

// --- continuity: does a chord end where its neighbour's chord begins? ------
// Endpoints on a shared border must agree, or the parapet gaps at the joint.
let ends = 0,
  matched = 0,
  worst = 0;
const EPS = 1e-3;
for (const [idx, seg] of cut) {
  const tx = idx % W,
    ty = (idx - tx) / W;
  for (const k of [0, 1]) {
    const lx = seg[k * 2],
      ly = seg[k * 2 + 1];
    // Which border is this endpoint on, and hence which neighbour shares it.
    let nx = tx,
      ny = ty,
      olx = lx,
      oly = ly;
    if (ly <= EPS) {
      ny = ty - 1;
      oly = 1;
    } else if (ly >= 1 - EPS) {
      ny = ty + 1;
      oly = 0;
    } else if (lx <= EPS) {
      nx = tx - 1;
      olx = 1;
    } else if (lx >= 1 - EPS) {
      nx = tx + 1;
      olx = 0;
    } else continue; // interior endpoint: cannot happen for a chord
    ends++;
    const other = cut.get(ny * W + nx);
    if (!other) continue;
    let best = Infinity;
    for (const m of [0, 1]) {
      const d = Math.hypot(other[m * 2] - olx, other[m * 2 + 1] - oly);
      if (d < best) best = d;
    }
    if (best < 1e-4) matched++;
    if (best < Infinity && best > worst) worst = best;
  }
}
console.log('');
console.log(`chord endpoints on a tile border          ${ends}`);
console.log(`  neighbour chord starts at the same point ${matched}`);
console.log(`  worst mismatch where a neighbour exists   ${worst.toExponential(2)} tiles`);
console.log(
  `  (the rest are the run's own two ends, where the deck meets land or the`,
);
console.log(`   neighbour is square because the curve does not enter it)`);

// --- does cutting a tile cost a road marking? -----------------------------
// The markings are on the CENTRE lane; the curve only crosses the outermost
// half tile. If that is true, no crossed tile carries one and the cut is free.
const isRoad = (x, y) => {
  const v = at(x, y);
  return v === S.T_ROAD || v === T_BRIDGE || v === S.T_RAMP;
};
let crossedDeck = 0,
  crossedMarked = 0;
for (const idx of cut.keys()) {
  const tx = idx % W,
    ty = (idx - tx) / W;
  if (at(tx, ty) !== T_BRIDGE) continue;
  crossedDeck++;
  let up = 0,
    down = 0,
    left = 0,
    right = 0;
  while (isRoad(tx, ty - up - 1) && up < 12) up++;
  while (isRoad(tx, ty + down + 1) && down < 12) down++;
  while (isRoad(tx - left - 1, ty) && left < 12) left++;
  while (isRoad(tx + right + 1, ty) && right < 12) right++;
  const runV = up + down + 1,
    runH = left + right + 1;
  // `laneCentreInTile`: the marked row/column of a run, mirrored from marks.ts.
  const centre = (run, before) =>
    run % 2 === 1 ? (before === (run - 1) / 2 ? 0 : null) : before === run / 2 - 1 || before === run / 2 ? 1 : null;
  const horizontal = runH >= 8,
    vertical = runV >= 8;
  let mark = 0;
  if (horizontal && vertical) mark = 0;
  else if (horizontal && runV <= 4) mark = centre(runV, up) === null ? 0 : 1;
  else if (vertical && runH <= 4) mark = centre(runH, left) === null ? 0 : 1;
  if (mark) crossedMarked++;
}
console.log('');
console.log(`deck tiles the curve crosses             ${crossedDeck}`);
console.log(`  of those, carrying a road marking      ${crossedMarked}`);

// --- CONTROL --------------------------------------------------------------
const none = buildDeckCut(t, W, H, []);
console.log('');
console.log(`CONTROL buildDeckCut with no courses     ${none.size} chained tiles`);
console.log(
  none.size === 0
    ? '  -> coverage above is the curve, not the counting.'
    : '  -> WARNING: chains appear with no curve to build them from.',
);
