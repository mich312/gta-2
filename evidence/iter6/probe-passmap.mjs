// One letter per carriageway tile: the pass that laid it.
//   node evidence/iter6/probe-passmap.mjs x0,y0,x1,y1
// Needs the pass hook in `shared/src/world/layout.ts` (see
// evidence/iter5/README.md and probe-attribute.mjs).
import { S, plan } from './lib.mjs';
const { buildLayout, polyBounds, pointInPoly, T_ROAD, T_BRIDGE } = S;

const W = plan.widthTiles;
const H = plan.heightTiles;
const KEY = {
  carveAuthoredRoads: 'A',
  layEsplanade: 'E',
  laySeamStreets: 'M',
  weaveFabrics: 'L',
  stitchBoroughs: 'T',
  guardRingAccess: 'G',
  trimBridges: 'D',
  mapCliffIslands: 'C',
  finishShores: 'F',
  cutMissedJunctions: 'J',
};
const laidBy = new Array(W * H).fill(null);
globalThis.__LAYOUT_PROBE__ = (name, t) => {
  for (let i = 0; i < W * H; i++) {
    const r = t[i] === T_ROAD || t[i] === T_BRIDGE;
    if (r && laidBy[i] === null) laidBy[i] = name;
    else if (!r) laidBy[i] = null;
  }
};
const layout = buildLayout(plan);
delete globalThis.__LAYOUT_PROBE__;
const { water } = layout;

const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}

const [x0, y0, x1, y1] = process.argv[2].split(',').map(Number);
console.log(`# ${x0},${y0}-${x1},${y1}  ` + Object.entries(KEY).map(([k, v]) => `${v}=${k}`).join(' '));
console.log('#  #=inside a district polygon (any tile)   .=land, no road   blank=water');
let head = '     ';
for (let tx = x0; tx <= x1; tx++) head += tx % 10 === 0 ? '|' : ' ';
console.log(head);
for (let ty = Math.max(0, y0); ty <= Math.min(H - 1, y1); ty++) {
  let row = '';
  for (let tx = Math.max(0, x0); tx <= Math.min(W - 1, x1); tx++) {
    const i = ty * W + tx;
    if (water[i] === 1) row += ' ';
    else if (laidBy[i] !== null) row += KEY[laidBy[i]] ?? '?';
    else row += inPoly[i] === 1 ? '#' : '.';
  }
  console.log(String(ty).padStart(4) + ' ' + row);
}
