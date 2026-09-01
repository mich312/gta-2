// Which pass laid every carriageway tile in the regions `lanes-serving-nothing`
// actually flags — the regions being mapAudit's own connected components of
// land outside every district polygon, taken off the SHIPPED BAKE (which is
// what mapaudit reads), with the attribution coming from a probe of the layout
// pass loop.
//
// Needs the pass hook (see evidence/iter5/README.md): the loop in
// `shared/src/world/layout.ts` must call
//   globalThis.__LAYOUT_PROBE__?.(pass.name, tiles)
// after each pass. Copy the file aside, patch, build, measure, copy back —
// never `git stash` (.claude/review/FIXER.md).
//
//   node evidence/iter6/probe-attribute.mjs
import { loadBake, NEW, S, plan } from './lib.mjs';
const { buildLayout, polyBounds, pointInPoly, T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR } = S;

const city = loadBake(process.env.CITY_DATA ?? NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
// mapAudit's `isRoad`.
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const layRoad = (t) => t === T_ROAD || t === T_BRIDGE;

// Attribute each road tile to the FIRST pass that laid it.
const laidBy = new Array(W * H).fill(null);
globalThis.__LAYOUT_PROBE__ = (name, t) => {
  for (let i = 0; i < W * H; i++) if (layRoad(t[i]) && laidBy[i] === null) laidBy[i] = name;
};
buildLayout(plan);
delete globalThis.__LAYOUT_PROBE__;

// mapAudit's polyMask + fringeRegions.
const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (inPoly[ty * W + tx] === 0 && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const seen = new Uint8Array(W * H);
const regions = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] === 1 || inPoly[s] === 1 || tiles[s] === T_WATER) continue;
  const bag = [s];
  seen[s] = 1;
  const f = { land: 0, road: 0, built: 0, x0: W, y0: H, x1: -1, y1: -1, cells: [] };
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    f.land++;
    f.cells.push(i);
    if (x < f.x0) f.x0 = x;
    if (y < f.y0) f.y0 = y;
    if (x > f.x1) f.x1 = x;
    if (y > f.y1) f.y1 = y;
    if (isRoad(tiles[i])) f.road++;
    if (tiles[i] === T_BUILDING || tiles[i] === T_FLOOR) f.built++;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] === 1 || inPoly[j] === 1 || tiles[j] === T_WATER) continue;
      seen[j] = 1;
      bag.push(j);
    }
  }
  regions.push(f);
}

const MIN_LAND = 1000; // GATES.fringeLand
const MIN_ROAD = 0.1; // GATES.fringeRoad
const BUILT = 0.01; // BUILT_SHARE
regions.sort((a, b) => b.road - a.road);
console.log('# land regions outside every district polygon, largest road first');
console.log(`# flagged = land >= ${MIN_LAND}, road share >= ${100 * MIN_ROAD}%, built share < ${100 * BUILT}%`);
for (const f of regions.slice(0, 6)) {
  const flag = f.land >= MIN_LAND && f.road / f.land >= MIN_ROAD && f.built / f.land < BUILT;
  console.log(
    `\n${flag ? 'FLAGGED' : 'ok     '} ${f.x0},${f.y0}-${f.x1},${f.y1}: land ${f.land}, road ${f.road} (${(
      (100 * f.road) /
      f.land
    ).toFixed(1)}%), built ${f.built} (${((100 * f.built) / f.land).toFixed(2)}%)`,
  );
  if (f.land < MIN_LAND) continue;
  const by = new Map();
  for (const i of f.cells) {
    if (!isRoad(tiles[i])) continue;
    const k = laidBy[i] ?? '(after layout)';
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rows) {
    const left = f.road - n;
    console.log(
      `    ${k.padEnd(20)} ${String(n).padStart(5)}   drop it and ${left} road is left = ${((100 * left) / f.land).toFixed(1)}%${left / f.land < MIN_ROAD ? '  <10%, CLEARS' : ''}`,
    );
  }
  const floor = Math.ceil(f.land * BUILT);
  console.log(`    or clear it on built tiles: needs ${floor}, has ${f.built} (+${floor - f.built})`);
}
