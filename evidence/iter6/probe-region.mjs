// Region map: one character per tile, showing what is there and who owns it.
//   node evidence/iter6/probe-region.mjs x0,y0,x1,y1 [mode]
// modes: tiles (default) | owner | depth | poly
import { loadBake, NEW, S, plan } from './lib.mjs';
const { buildLayout, polyBounds, pointInPoly } = S;

const [x0, y0, x1, y1] = process.argv[2].split(',').map(Number);
const mode = process.argv[3] ?? 'tiles';
const city = loadBake(NEW);
const W = city.widthTiles,
  H = city.heightTiles;
const layout = buildLayout(plan);
const { owner, water } = layout;
const tiles = city.tiles;

const inAnyPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) inAnyPoly[ty * W + tx] = 1;
}

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
const A36 = (n) => (n < 0 ? '-' : n < 10 ? String(n) : String.fromCharCode(87 + n));
let head = '     ';
for (let tx = x0; tx <= x1; tx++) head += tx % 10 === 0 ? '|' : ' ';
console.log(`# ${x0},${y0}-${x1},${y1} mode=${mode}`);
if (mode === 'owner') console.log('# ' + plan.districts.map((d, i) => `${A36(i)}=${d.name}`).join(' '));
console.log(head);
for (let ty = Math.max(0, y0); ty <= Math.min(H - 1, y1); ty++) {
  let row = '';
  for (let tx = Math.max(0, x0); tx <= Math.min(W - 1, x1); tx++) {
    const i = ty * W + tx;
    if (mode === 'tiles') row += CH[tiles[i]] ?? '?';
    else if (mode === 'owner') row += water[i] === 1 ? ' ' : A36(owner[i]);
    else if (mode === 'poly')
      row += water[i] === 1 ? ' ' : inAnyPoly[i] ? '#' : tiles[i] === S.T_ROAD || tiles[i] === S.T_BRIDGE ? 'R' : '.';
  }
  console.log(String(ty).padStart(4) + ' ' + row);
}
