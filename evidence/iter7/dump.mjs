// Tile dump for a crop, one char per tile.
//   node evidence/iter7/dump.mjs x y w h
import { loadBake, NEW, S } from './lib.mjs';

const city = loadBake(NEW);
const W = city.widthTiles;
const t = city.tiles;
const C = {
  [S.T_WATER]: '~', [S.T_SAND]: 's', [S.T_BANK]: 'B', [S.T_FIELD]: '.',
  [S.T_PARK]: 'p', [S.T_TREES]: 'T', [S.T_ROAD]: '#', [S.T_SIDEWALK]: '=',
  [S.T_BUILDING]: 'H', [S.T_FLOOR]: 'f', [S.T_LOT]: 'L', [S.T_BRIDGE]: 'D',
  [S.T_RAMP]: 'r', [S.T_RUNWAY]: 'R',
};
const [x0, y0, w, h] = process.argv.slice(2).map(Number);
process.stdout.write('     ' + Array.from({ length: w }, (_, i) => (x0 + i) % 10).join('') + '\n');
for (let y = y0; y < y0 + h; y++) {
  let s = String(y).padStart(4) + ' ';
  for (let x = x0; x < x0 + w; x++) s += C[t[y * W + x]] ?? '?';
  console.log(s);
}
