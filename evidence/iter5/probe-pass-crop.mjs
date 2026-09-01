// Which pass laid WHICH tile, drawn. Same temporary `__LAYOUT_PROBE__` hook as
// probe-which-pass.mjs. Letters: A carveAuthoredRoads, E layEsplanade,
// M laySeamStreets, F weaveFabrics, S stitchBoroughs, J cutMissedJunctions,
// '.' not carriageway. Lower case = the tile is inside a district polygon.
import { plan, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, pointInPoly, buildLayout } = S;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const W = plan.widthTiles,
  H = plan.heightTiles;

const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [px, py] of d.area) {
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (!inPoly[i] && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[i] = 1;
    }
}

const LETTER = {
  carveAuthoredRoads: 'A',
  layEsplanade: 'E',
  laySeamStreets: 'M',
  weaveFabrics: 'F',
  stitchBoroughs: 'S',
  guardRingAccess: 'G',
  trimBridges: 'T',
  mapCliffIslands: 'C',
  finishShores: 'H',
  cutMissedJunctions: 'J',
};
const by = new Uint8Array(W * H); // char code of the pass that made it road
let prevRoad = null;
globalThis.__LAYOUT_PROBE__ = (name, tiles) => {
  const ch = (LETTER[name] ?? '?').charCodeAt(0);
  for (let i = 0; i < W * H; i++) {
    const now = isRoad(tiles[i]);
    const was = prevRoad === null ? false : prevRoad[i] === 1;
    if (now && !was) by[i] = ch;
    else if (!now && was) by[i] = 0;
  }
  const snap = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) snap[i] = isRoad(tiles[i]) ? 1 : 0;
  prevRoad = snap;
};
const layout = buildLayout(plan);

const [x0, y0, x1, y1] = (process.argv[2] ?? '430,300,539,378').split(',').map(Number);
const tally = new Map();
console.log(`# ${x0},${y0}-${x1},${y1}  A authored  E esplanade  M seam  F lattice  S stitch  J junction`);
console.log('# lower case = tile is inside a district polygon; "." = not carriageway; "~" = water');
for (let ty = y0; ty <= y1; ty++) {
  let row = '';
  for (let tx = x0; tx <= x1; tx++) {
    const i = ty * W + tx;
    if (layout.water[i] === 1 && !isRoad(layout.tiles[i])) {
      row += '~';
      continue;
    }
    if (!by[i]) {
      row += '.';
      continue;
    }
    const c = String.fromCharCode(by[i]);
    row += inPoly[i] ? c.toLowerCase() : c;
    if (!inPoly[i]) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  console.log(String(ty).padStart(4) + ' ' + row);
}
console.log('\ncarriageway on out-of-polygon ground in this crop, by pass:');
for (const [c, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${c}  ${n}`);
