// How many 45-degree bevel wedges did the deck chord take over?
//
//   node evidence/iter8/bevel-overlap.mjs
//
// §31 gave the deck/water pair a one-directional bevel: the WATER yields, so
// a water tile beside a deck carries a 45-degree chamfer that reads as deck.
// That was the best a half-tile chamfer could do before the deck had a curve.
// Now that it has one, a wedge left in place lays a triangle over a chord at
// a different angle — the sawtooth `buildBandPatches` already records learning
// not to draw. `buildShoreWedges` and the 2D `paintBevel` now both stand down
// on a tile the deck chord owns; this is how many tiles that is, and it is
// also the count that says the overlap was real rather than theoretical.
import { loadBake, NEW, S } from '../iter7/lib.mjs';

const { T_WATER, T_BRIDGE, buildDeckCut, bevelOther, deriveBevels } = S;
const city = loadBake(NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  t = city.tiles;
const cut = buildDeckCut(t, W, H, city.courses);
// The bake does not carry the bevel plane — it is derived at load, so derive
// it the same way `generateCity` does rather than reading a field that is not
// there. (First draft of this script read `city.bevel`, got `undefined`, and
// printed a clean 0 for every column. That is the shape of a lie this
// exercise has caught seven of; the control below is why it did not survive.)
const bevel = deriveBevels(t, W, H);

let bevels = 0;
let deckBevels = 0;
let overlap = 0;
for (let i = 0; i < t.length; i++) {
  if (!bevel || bevel[i] === 0) continue;
  bevels++;
  const x = i % W,
    y = (i - x) / W;
  const tile = t[i];
  const other = bevelOther(t, bevel, W, x, y);
  const deckPair =
    (tile === T_WATER && other === T_BRIDGE) || (tile === T_BRIDGE && other === T_WATER);
  if (deckPair) deckBevels++;
  // `buildShoreWedges` builds geometry for `tile === T_WATER && other !== T_WATER`.
  if (tile === T_WATER && other !== T_WATER && cut.has(i)) overlap++;
}
console.log(`bevelled tiles on the map              ${bevels}`);
console.log(`  of the deck/water pair (S31)         ${deckBevels}`);
console.log(`  water tiles that would have got BOTH ${overlap}`);
console.log(`    a 45-degree wedge and a deck prism, at different angles`);
console.log('');
console.log(
  overlap > 0
    ? 'So the stand-down is load-bearing, not a precaution.'
    : 'No overlap on this map — the stand-down costs nothing here.',
);
console.log('');
console.log(
  bevels > 0
    ? `CONTROL: the bevel plane is populated (${bevels} tiles), so a 0 in the`
    : 'CONTROL FAILED: the bevel plane is empty. Every 0 above is that, not a',
);
console.log(
  bevels > 0 ? '  columns above is an answer and not an empty input.' : '  measurement.',
);
