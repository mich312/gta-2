// ASCII of a baked tile plane: '#' carriageway, '.' water, '-' anything else.
//   node evidence/iter11/probe-tiles.mjs <city.data.ts> <x0> <y0> <x1> <y1>
import { readFileSync } from 'node:fs';
import { decodeBakedCity, T_ROAD, T_BRIDGE, T_RAMP, T_WATER } from '../../shared/dist/index.js';

const s = readFileSync(process.argv[2], 'utf8');
const map = decodeBakedCity(JSON.parse(JSON.parse(s.slice(s.indexOf('"'), s.lastIndexOf('"') + 1))));
const W = map.widthTiles;
const [x0, y0, x1, y1] = process.argv.slice(3).map(Number);
let head = '     ';
for (let x = x0; x <= x1; x++) head += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ';
console.log(head);
for (let y = y0; y <= y1; y++) {
  let line = String(y).padStart(4) + ' ';
  for (let x = x0; x <= x1; x++) {
    const t = map.tiles[y * W + x];
    line += t === T_ROAD || t === T_BRIDGE || t === T_RAMP ? '#' : t === T_WATER ? '.' : '-';
  }
  console.log(line);
}
