// How far out from the town it belongs to does each road-laying pass reach?
//
// Every out-of-polygon carriageway tile, attributed to the pass that laid it
// (the temporary `__LAYOUT_PROBE__` hook) and bucketed by how far it stands,
// walked over dry land, from the nearest tile INSIDE ITS OWN owner's authored
// polygon. That is the number a reach cut would be keyed on: the warp fringe a
// borough really does hang off, against a landform the plan never drew.
import { plan, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, pointInPoly, buildLayout } = S;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const W = plan.widthTiles,
  H = plan.heightTiles;

const LETTER = {
  carveAuthoredRoads: 'authored',
  layEsplanade: 'esplanade',
  laySeamStreets: 'seam',
  weaveFabrics: 'lattice',
  stitchBoroughs: 'stitch',
  guardRingAccess: 'ringguard',
  trimBridges: 'trimBridges',
  mapCliffIslands: 'cliffIslands',
  finishShores: 'finishShores',
  cutMissedJunctions: 'junctions',
};
const names = Object.values(LETTER);
const by = new Int8Array(W * H).fill(-1);
let prevRoad = null;
globalThis.__LAYOUT_PROBE__ = (name, tiles) => {
  const k = names.indexOf(LETTER[name] ?? '?');
  for (let i = 0; i < W * H; i++) {
    const now = isRoad(tiles[i]);
    const was = prevRoad === null ? false : prevRoad[i] === 1;
    if (now && !was) by[i] = k;
    else if (!now && was) by[i] = -1;
  }
  const snap = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) snap[i] = isRoad(tiles[i]) ? 1 : 0;
  prevRoad = snap;
};
const layout = buildLayout(plan);
const owner = layout.owner,
  water = layout.water,
  tiles = layout.tiles;

// Per district: distance over dry land from that district's own polygon.
const reach = new Int32Array(W * H).fill(-1);
const inOwn = new Uint8Array(W * H);
for (const [di, d] of plan.districts.entries()) {
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
  const dist = new Int32Array(W * H).fill(-1);
  const q = [];
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (water[i] === 1) continue;
      if (!pointInPoly(d.area, tx + 0.5, ty + 0.5)) continue;
      dist[i] = 0;
      q.push(i);
      if (owner[i] === di) inOwn[i] = 1;
    }
  for (let h = 0; h < q.length; h++) {
    const i = q[h],
      x = i % W,
      y = (i - x) / W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (dist[j] >= 0 || water[j] === 1) continue;
      dist[j] = dist[i] + 1;
      q.push(j);
    }
  }
  for (let i = 0; i < W * H; i++) if (owner[i] === di && !inOwn[i]) reach[i] = dist[i];
}

const BANDS = [
  ['00-08', 8],
  ['09-16', 16],
  ['17-24', 24],
  ['25-32', 32],
  ['33-48', 48],
  ['49-80', 80],
  ['81+', 1e9],
  ['unreached', Infinity],
];
const table = new Map();
for (let i = 0; i < W * H; i++) {
  if (water[i] === 1 || !isRoad(tiles[i])) continue;
  if (inOwn[i] || owner[i] < 0) continue; // inside its own polygon, or ownerless
  const k = by[i];
  if (k < 0) continue;
  const r = reach[i];
  const band = r < 0 ? 'unreached' : (BANDS.find(([, hi]) => r <= hi) ?? ['81+'])[0];
  const key = names[k];
  const row = table.get(key) ?? new Map();
  row.set(band, (row.get(band) ?? 0) + 1);
  table.set(key, row);
}
const bandNames = BANDS.map(([n]) => n);
console.log('carriageway outside its own borough’s authored polygon, by the pass that laid it');
console.log('and by how far over land it stands from that polygon:\n');
console.log(`  ${'pass'.padEnd(13)} ${bandNames.map((b) => b.padStart(9)).join('')} ${'total'.padStart(9)}`);
for (const [k, row] of table) {
  let tot = 0;
  for (const v of row.values()) tot += v;
  console.log(
    `  ${k.padEnd(13)} ${bandNames.map((b) => String(row.get(b) ?? 0).padStart(9)).join('')} ${String(tot).padStart(9)}`,
  );
}
