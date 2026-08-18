import { readFileSync } from 'node:fs';
import { generateCity, parseWorldgenParams, T_ROAD, T_SIDEWALK, T_BUILDING, T_LOT } from 'shared';
const params = parseWorldgenParams(JSON.parse(readFileSync(new URL(import.meta.resolve('shared/data/worldgen.json')), 'utf8')));
const m = generateCity(1, params);
const W = m.widthTiles, t = m.tiles;
// In The Spine's rectangle: how much of the kerb line is pavement vs a wall?
let kerbPave = 0, kerbWall = 0, kerbOther = 0, road = 0;
for (let y = 121; y <= 311; y++) for (let x = 425; x <= 557; x++) {
  if (t[y * W + x] !== T_ROAD) continue;
  road++;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const n = t[(y+dy) * W + x + dx];
    if (n === T_ROAD) continue;
    if (n === T_SIDEWALK) kerbPave++;
    else if (n === T_BUILDING) kerbWall++;
    else kerbOther++;
  }
}
const tot = kerbPave + kerbWall + kerbOther;
console.log(`The Spine: ${road} road tiles; roadside neighbours ${tot}: pavement ${(100*kerbPave/tot).toFixed(1)}%  wall ${(100*kerbWall/tot).toFixed(1)}%  other ${(100*kerbOther/tot).toFixed(1)}%`);
