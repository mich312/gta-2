// How much room is there for a SECOND road between the ring road and the
// south waterline? Per column: the southern edge of the ring's carriageway,
// the first wet tile below it, and the clear gap between them.
//
// A 4-wide road needs its centreline 2 clear of the water and 2 clear of the
// ring; the suite's "merged tarmac" pin (a 7x7 all-carriageway window) needs
// 3 more than that on the ring side, so a gap under about 11 cannot take a
// second carriageway without the two reading as one sheet of tarmac.
//   node evidence/iter11/probe-room.mjs <city.data.ts> <x0> <x1> <step>
import { readFileSync } from 'node:fs';
import { decodeBakedCity, T_ROAD, T_BRIDGE, T_WATER } from '../../shared/dist/index.js';

const s = readFileSync(process.argv[2], 'utf8');
const map = decodeBakedCity(JSON.parse(JSON.parse(s.slice(s.indexOf('"'), s.lastIndexOf('"') + 1))));
const W = map.widthTiles;
const H = map.heightTiles;
const [x0, x1, step] = process.argv.slice(3).map(Number);

for (let x = x0; x <= x1; x += step) {
  // walk up from the bottom of the map: first land, then the lowest road.
  let wet = -1;
  for (let y = H - 1; y >= 0; y--) {
    if (map.tiles[y * W + x] === T_WATER) wet = y;
    else if (wet > 0 && y < 720) break;
  }
  let road = -1;
  for (let y = wet - 1; y >= 0; y--) {
    const t = map.tiles[y * W + x];
    if (t === T_ROAD || t === T_BRIDGE) {
      road = y;
      break;
    }
  }
  const gap = wet - road - 1;
  console.log(
    `x=${String(x).padStart(3)}  lowest carriageway y=${String(road).padStart(3)}  ` +
      `waterline y=${String(wet).padStart(3)}  clear gap ${String(gap).padStart(3)}` +
      `${gap < 11 ? '   <- no room for a second carriageway' : ''}`,
  );
}
