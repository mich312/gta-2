// Round 5, lens A. Run from the repo root after `pnpm build`:
//   node evidence/round5/A-repro-shops-in-landmarks.mjs
//
// Prints every shop the bake carved into a LANDMARK's own stamped mass,
// straight off the shipped bytes (`shared/src/world/city.data.ts`).
import { decodeBakedCity } from '../../shared/dist/world/bake.js';
import { CITY_DATA } from '../../shared/dist/world/city.data.js';

const city = decodeBakedCity(JSON.parse(CITY_DATA));
const W = city.widthTiles;
const ch = { 0: '.', 1: '#', 2: ':', 3: 'B', 4: 'p', 5: 'l', 6: '~', 7: '=', 8: 'r', 9: 'F', 10: 'q', 11: 'T', 12: 's', 13: 'R' };

let n = 0;
for (const s of city.shops) {
  const b = city.buildings[s.buildingIndex];
  if (!b) continue;
  const lm = city.landmarks.find(
    (l) => b.x < l.x + l.w && b.x + b.w > l.x && b.y < l.y + l.h && b.y + b.h > l.y,
  );
  if (!lm) continue;
  n++;
  console.log(
    `${s.kind} shop, door ${s.doorX},${s.doorY} -> inside ${lm.kind} "${lm.name}" ` +
      `(rect ${lm.x},${lm.y} ${lm.w}x${lm.h}, its own door tile ${Math.floor(lm.doorX / 16)},${Math.floor(lm.doorY / 16)})`,
  );
}
console.log(`\n${n} of ${city.shops.length} shops are carved into a landmark.\n`);

for (const name of ['Kelvin Road Station', 'The Spire', 'Marsh Post']) {
  const l = city.landmarks.find((k) => k.name === name);
  console.log(`--- ${name} (${l.kind}) ${l.x},${l.y} ${l.w}x${l.h} ---`);
  for (let y = l.y - 1; y < l.y + l.h + 1; y++) {
    let row = '';
    for (let x = l.x - 1; x < l.x + l.w + 1; x++) row += ch[city.tiles[y * W + x]];
    console.log(String(y).padStart(4), row);
  }
}
console.log('\nlegend  . field  # road  : pavement  B building  p park  l lot  F floor');
