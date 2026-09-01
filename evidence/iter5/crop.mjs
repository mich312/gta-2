// ASCII crop of the SHIPPED bake (shared/src/world/city.data.ts).
//   node evidence/iter5/crop.mjs x0,y0,x1,y1
import { loadBake, NEW, S } from './lib.mjs';

const city = loadBake(process.env.CITY_DATA ?? NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  tiles = city.tiles;
const CH = {
  [S.T_FIELD]: '.',
  [S.T_ROAD]: 'R',
  [S.T_SIDEWALK]: 'S',
  [S.T_BUILDING]: 'B',
  [S.T_PARK]: 'P',
  [S.T_LOT]: 'L',
  [S.T_WATER]: 'w',
  [S.T_BRIDGE]: 'b',
  [S.T_RAMP]: 'r',
  [S.T_FLOOR]: 'f',
  [S.T_BANK]: 'q',
  [S.T_TREES]: 'T',
  [S.T_SAND]: 's',
  [S.T_RUNWAY]: 'Y',
};
const [x0, y0, x1, y1] = process.argv[2].split(',').map(Number);
console.log(`# ${x0},${y0}-${x1},${y1}  . field  R road  S sidewalk  B building  P park  L lot`);
console.log('#                w water  b bridge  r ramp  f floor  q quay/bank  T trees  s sand  Y runway');
let head = '     ';
for (let tx = x0; tx <= x1; tx++) head += tx % 10 === 0 ? '|' : ' ';
console.log(head);
for (let ty = Math.max(0, y0); ty <= Math.min(H - 1, y1); ty++) {
  let row = '';
  for (let tx = Math.max(0, x0); tx <= Math.min(W - 1, x1); tx++) row += CH[tiles[ty * W + tx]] ?? '?';
  console.log(String(ty).padStart(4) + ' ' + row);
}
