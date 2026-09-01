// The suite's own causeway test, run against a bake outside vitest:
// every T_BRIDGE tile of the shipped city must have a water-or-bridge run no
// longer than maxBridgeSpan along SOME axis (shared/test/city.test.ts,
// "bridges cross water; they never run along it").
//   node evidence/iter11/probe-deckspan.mjs [path/to/city.data.ts]
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity,
  parseCityPlan,
  T_BRIDGE,
  T_WATER,
} from '../../shared/dist/index.js';

const path =
  process.argv[2] ?? new URL('../../shared/src/world/city.data.ts', import.meta.url).pathname;
const src = readFileSync(path, 'utf8');
const map = decodeBakedCity(JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))));
const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const W = map.widthTiles;
const H = map.heightTiles;
const wet = (tx, ty) => {
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
  const t = map.tiles[ty * W + tx];
  return t === T_WATER || t === T_BRIDGE;
};
const span = (tx, ty, dx, dy) => {
  let n = 1;
  for (let s = 1; wet(tx + dx * s, ty + dy * s); s++) n++;
  for (let s = 1; wet(tx - dx * s, ty - dy * s); s++) n++;
  return n;
};
const shortest = (tx, ty) =>
  Math.min(
    span(tx, ty, 0, 1),
    span(tx, ty, 1, 0),
    Math.round(span(tx, ty, 1, 1) * 1.414),
    Math.round(span(tx, ty, 1, -1) * 1.414),
  );

let bridges = 0;
let worst = 0;
let worstAt = null;
let over = 0;
for (let ty = 0; ty < H; ty++) {
  for (let tx = 0; tx < W; tx++) {
    if (map.tiles[ty * W + tx] !== T_BRIDGE) continue;
    bridges++;
    const s = shortest(tx, ty);
    if (s > worst) {
      worst = s;
      worstAt = [tx, ty];
    }
    if (s > plan.maxBridgeSpan) over++;
  }
}
console.log(
  `${bridges} bridge tiles; widest crossing ${worst} at ${worstAt}; ` +
    `${over} over maxBridgeSpan ${plan.maxBridgeSpan}`,
);
