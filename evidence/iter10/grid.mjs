// ASCII tile grid around a point, so a picture is never read by guesswork.
//   node evidence/iter10/grid.mjs <x> <y> [halfwidth]
import { S, loadBake, NEW } from './lib.mjs';
const city = loadBake(NEW);
const W = city.widthTiles;
const CH = { T_FIELD: '.', T_ROAD: '#', T_SIDEWALK: ':', T_BUILDING: 'B', T_WATER: '~', T_PARK: 'p', T_TREES: 'T', T_SAND: 's', T_BRIDGE: '=', T_RAMP: '/', T_LOT: 'L', T_BANK: 'b', T_RUNWAY: 'R', T_FLOOR: 'f' };
const map = {};
for (const [k, v] of Object.entries(S)) if (k.startsWith('T_') && typeof v === 'number') map[v] = CH[k] ?? '?';
const [cx, cy, hw] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] ?? 14)];
process.stdout.write('     ');
for (let x = cx - hw; x <= cx + hw; x++) process.stdout.write(x === cx ? '|' : String(Math.abs(x) % 10));
console.log();
for (let y = cy - hw; y <= cy + hw; y++) {
  let row = String(y).padStart(4) + ' ';
  for (let x = cx - hw; x <= cx + hw; x++) row += (x === cx && y === cy) ? '@' : map[city.tiles[y * W + x]] ?? '?';
  console.log(row + (y === cy ? '  <-- y=' + cy : ''));
}
console.log(`\n# = ROAD  = BRIDGE  / RAMP  : SIDEWALK  . FIELD  B BUILDING  p PARK  T TREES  s SAND  ~ WATER  b BANK  L LOT`);
