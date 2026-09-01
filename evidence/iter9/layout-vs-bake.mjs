// Where the seven unauthored ring mouths come from: the layout plane against
// the baked plane, at the seven sites and city-wide.
//
// Run: node evidence/iter9/layout-vs-bake.mjs
import { loadBake, NEW, plan } from './lib.mjs';
import { buildLayout, T_ROAD, T_BRIDGE, T_RAMP, T_FIELD } from '../../shared/dist/index.js';

const L = buildLayout(plan);
const city = loadBake(NEW);
const W = L.widthTiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

const SITES = [[499, 107], [570, 612], [461, 118], [510, 122], [513, 123], [641, 307], [456, 664]];
console.log('# site        layout      bake');
for (const [x, y] of SITES) {
  const i = y * W + x;
  console.log(`${`${x},${y}`.padEnd(12)}${String(L.tiles[i]).padEnd(12)}${city.tiles[i]}   ${isRoad(L.tiles[i]) ? 'road in the layout' : 'BARE in the layout, road in the BAKE — a bake pass laid it'}`);
}

let bakeAdded = 0, bakeRemoved = 0;
for (let i = 0; i < L.tiles.length; i++) {
  const a = isRoad(L.tiles[i]), b = isRoad(city.tiles[i]);
  if (!a && b) bakeAdded++;
  if (a && !b) bakeRemoved++;
}
console.log(`\ncity-wide, the bake adds ${bakeAdded} carriageway tiles the layout did not have and removes ${bakeRemoved}.`);
console.log('CONTROL: if both were 0 the comparison would be measuring nothing.');
