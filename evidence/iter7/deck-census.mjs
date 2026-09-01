// How big is the bridge-deck staircase CITY-WIDE, past the four findings the
// signature's gate (count>=4, span>=16) lets through?
//
//   node evidence/iter7/deck-census.mjs
//
// Two numbers the escalation needs:
//  * every deck/water boundary face, and how many a coast curve covers —
//    the detector's docstring claims 0 of 466 and it is worth checking;
//  * every rail box `buildBridgeRails` stands, and how many of those sit on
//    a STEP (the neighbouring deck tile on the same profile row/column is
//    offset), which is the count a course-following parapet would straighten.
import { loadBake, NEW, S } from './lib.mjs';

const { shoreChains, T_BRIDGE, T_WATER } = S;
const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : t[y * W + x]);
const coast = shoreChains(city.shores, W, H);
const band = shoreChains(city.banks, W, H);

let deck = 0;
let faces = 0;
let onCoast = 0;
let onBand = 0;
// Rails, exactly as buildBridgeRails enumerates them: one per deck tile side
// whose 4-neighbour is water.
const rail = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (at(x, y) !== T_BRIDGE) continue;
    deck++;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      if (at(x + dx, y + dy) !== T_WATER) continue;
      faces++;
      rail.push([x, y, dx, dy]);
      const i = y * W + x;
      const j = (y + dy) * W + (x + dx);
      if (coast.has(i) || coast.has(j)) onCoast++;
      else if (band.has(i) || band.has(j)) onBand++;
    }
  }
}
console.log(`T_BRIDGE tiles          ${deck}`);
console.log(`deck/water faces        ${faces}`);
console.log(`  covered by coast      ${onCoast}`);
console.log(`  covered by bank       ${onBand}`);
console.log(`  covered by NEITHER    ${faces - onCoast - onBand}`);
console.log('');
console.log('  (all three painters refuse a deck by name anyway — 2D');
console.log('   tiles.ts:1498 "the coast runs UNDER it", 3D cityGeometry.ts');
console.log('   GROUND_AT_SEA has no T_BRIDGE — so even a covered face is');
console.log('   drawn square. The coverage column is here to show the curve');
console.log('   layer is not quietly doing the job on decks.)');
console.log('');

// A rail box sits on a STEP when the deck edge moves between this profile
// position and the next: for a north/south-facing rail, when the deck tile
// one column over does NOT have the same rail.
const has = new Set(rail.map(([x, y, dx, dy]) => `${x},${y},${dx},${dy}`));
let steps = 0;
for (const [x, y, dx, dy] of rail) {
  // Walk along the rail's own direction: a horizontal rail (dy != 0) runs
  // east-west, so its neighbours are at x±1.
  const [ax, ay] = dy !== 0 ? [1, 0] : [0, 1];
  const before = has.has(`${x - ax},${y - ay},${dx},${dy}`);
  const after = has.has(`${x + ax},${y + ay},${dx},${dy}`);
  if (!before || !after) steps++;
}
console.log(`rail boxes              ${rail.length}`);
console.log(`  at a step (an end of a tread, so a visible jog)   ${steps}`);
console.log(`  mid-tread (collinear with both neighbours)        ${rail.length - steps}`);
