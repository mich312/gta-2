// ASCII plate of a region: tile class, block coverage, and what the wildness
// field says there.
//
//   node evidence/iter8-country/map-region.mjs x0 y0 x1 y1
//
// Three panes, same footprint:
//   TILES  . field  T trees  ~ water  # road  = bridge  s sidewalk  b bank
//          , sand   P park   B building  L lot  o other
//   BLOCK  r inside a rural block's box   u urban block   . no block
//   FIELD  W wildAt says wood   . wildAt says meadow      (a `+` marks a tile
//          within 0.02 of the 0.52 threshold, i.e. where the answer is close)
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const F = await import(`file://${R}/shared/dist/world/fields.js`);
const WILD_SEED = 0x7009d5;
const wild = (x, y) => F.fbm(WILD_SEED, x / 22, y / 22);
const src = readFileSync(`${R}/shared/src/world/city.data.ts`, 'utf8');
const city = S.decodeBakedCity(
  JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
);
const W = city.widthTiles;
const H = city.heightTiles;
const t = city.tiles;
const [x0, y0, x1, y1] = process.argv.slice(2, 6).map(Number);

const glyph = (v) =>
  ({
    [S.T_FIELD]: '.',
    [S.T_TREES]: 'T',
    [S.T_WATER]: '~',
    [S.T_ROAD]: '#',
    [S.T_BRIDGE]: '=',
    [S.T_SIDEWALK]: 's',
    [S.T_BANK]: 'b',
    [S.T_SAND]: ',',
    [S.T_PARK]: 'P',
    [S.T_BUILDING]: 'B',
    [S.T_LOT]: 'L',
  })[v] ?? 'o';

const blockAt = new Int8Array(W * H);
for (const b of city.blocks) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) {
      blockAt[y * W + x] = b.rural === true ? 1 : 2;
    }
  }
}

const head = () => {
  let s = '     ';
  for (let x = x0; x <= x1; x++) s += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ';
  return s;
};
for (const [name, f] of [
  ['TILES', (x, y) => glyph(t[y * W + x])],
  ['BLOCK', (x, y) => ['.', 'r', 'u'][blockAt[y * W + x]]],
  [
    'FIELD',
    (x, y) => {
      const v = wild(x, y);
      return v >= 0.52 ? 'W' : Math.abs(v - 0.52) < 0.02 ? '+' : '.';
    },
  ],
]) {
  console.log(`--- ${name}  ${x0},${y0}-${x1},${y1}`);
  console.log(head());
  for (let y = y0; y <= y1; y++) {
    let row = '';
    for (let x = x0; x <= x1; x++) row += f(x, y);
    console.log(String(y).padStart(4) + ' ' + row);
  }
  console.log('');
}

// Where does the field sit, numerically, over the region?
let n = 0;
let lo = 1;
let hi = 0;
let sum = 0;
for (let y = y0; y <= y1; y++) {
  for (let x = x0; x <= x1; x++) {
    const v = wild(x, y);
    n++;
    sum += v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
}
console.log(`wildness over the box: n=${n} min=${lo.toFixed(3)} mean=${(sum / n).toFixed(3)} max=${hi.toFixed(3)} (gate 0.52)`);
