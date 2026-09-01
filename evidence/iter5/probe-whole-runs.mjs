// Whole-run reach, for the two passes that carve on the FLOODED owner plane.
//
//   node evidence/iter5/probe-whole-runs.mjs 24
//
// A per-tile reach cut chops a road in half and leaves a new dead end in a
// field. So the unit has to be the whole connected run: a run is removable
// only if NONE of it lies within N tiles of the authored ground of the borough
// that claims it. This lists every run of each pass with its reach range and
// the town within 20 tiles of it in the shipped bake.
// Needs the temporary `__LAYOUT_PROBE__` hook in layout.ts's pass loop.
import { loadBake, plan, NEW, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR, T_SIDEWALK, pointInPoly, buildLayout } = S;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const W = plan.widthTiles,
  H = plan.heightTiles;
const THRESH = Number(process.argv[2] ?? 24);

const PASSES = ['authored', 'esplanade', 'seam', 'lattice', 'stitch', 'ringguard', 'trimBridges', 'cliffIslands', 'finishShores', 'junctions'];
const LETTER = {
  carveAuthoredRoads: 'authored', layEsplanade: 'esplanade', laySeamStreets: 'seam',
  weaveFabrics: 'lattice', stitchBoroughs: 'stitch', guardRingAccess: 'ringguard',
  trimBridges: 'trimBridges', mapCliffIslands: 'cliffIslands', finishShores: 'finishShores',
  cutMissedJunctions: 'junctions',
};
const by = new Int8Array(W * H).fill(-1);
let prevRoad = null;
globalThis.__LAYOUT_PROBE__ = (name, tiles) => {
  const k = PASSES.indexOf(LETTER[name]);
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
const owner = layout.owner, water = layout.water;

const reach = new Int32Array(W * H).fill(-1);
for (const [di, d] of plan.districts.entries()) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of d.area) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  const dist = new Int32Array(W * H).fill(-1);
  const q = [];
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (water[i] === 1 || !pointInPoly(d.area, tx + 0.5, ty + 0.5)) continue;
      dist[i] = 0; q.push(i);
    }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % W, y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (dist[j] >= 0 || water[j] === 1) continue;
      dist[j] = dist[i] + 1; q.push(j);
    }
  }
  for (let i = 0; i < W * H; i++) if (owner[i] === di) reach[i] = dist[i];
}

// Alternative, threshold-free predicate: is any of the run inside SOME
// borough's polygon bounding box? Blocks are cut only inside a bbox and
// buildings only inside blocks, so outside every bbox no town can ever
// appear beside the run.
const inSomeBox = new Uint8Array(W * H);
for (const d of plan.districts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of d.area) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) inSomeBox[ty * W + tx] = 1;
}

const city = loadBake(NEW);
const tiles = city.tiles;

for (const pass of ['esplanade', 'seam']) {
  const k = PASSES.indexOf(pass);
  const mine = new Set();
  for (let i = 0; i < W * H; i++) if (by[i] === k) mine.add(i);
  const seen = new Set();
  const runs = [];
  for (const s of mine) {
    if (seen.has(s)) continue;
    const bag = [s]; seen.add(s);
    let x0 = W, y0 = H, x1 = -1, y1 = -1, rlo = Infinity, rhi = -Infinity, boxed = false;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q], x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      const rr = reach[i] < 0 ? 9999 : reach[i];
      if (rr < rlo) rlo = rr; if (rr > rhi) rhi = rr;
      if (inSomeBox[i]) boxed = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W + x + dx;
          if (!mine.has(j) || seen.has(j)) continue;
          seen.add(j); bag.push(j);
        }
    }
    runs.push({ n: bag.length, bag, x0, y0, x1, y1, rlo, rhi, boxed });
  }
  runs.sort((a, b) => b.n - a.n);
  const removable = runs.filter((r) => r.rlo > THRESH);
  const unboxed = runs.filter((r) => !r.boxed);
  console.log(`    (bbox rule: ${unboxed.length} runs, ${unboxed.reduce((a, r) => a + r.n, 0)} tiles lie wholly outside every borough's polygon bounding box)`);
  console.log(`\n=== ${pass}: ${runs.length} runs, ${mine.size} tiles.`);
  console.log(`    wholly beyond reach ${THRESH}: ${removable.length} runs, ${removable.reduce((a, r) => a + r.n, 0)} tiles`);
  console.log(`  ${'tiles'.padStart(6)}  ${'bbox'.padEnd(20)} ${'reach'.padStart(10)} ${'built<20'.padStart(9)} ${'pave<20'.padStart(8)}  drop?  owners`);
  for (const r of runs) {
    if (r.n < 20) continue;
    let built = 0, pave = 0;
    const near = new Set(); const owners = new Set();
    for (const i of r.bag) {
      const x = i % W, y = (i - x) / W;
      if (owner[i] >= 0) owners.add(plan.districts[owner[i]].name);
      for (let dy = -20; dy <= 20; dy++)
        for (let dx = -20; dx <= 20; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (near.has(j)) continue;
          near.add(j);
          if (tiles[j] === T_BUILDING || tiles[j] === T_FLOOR) built++;
          else if (tiles[j] === T_SIDEWALK) pave++;
        }
    }
    console.log(`  ${String(r.n).padStart(6)}  ${`${r.x0},${r.y0}-${r.x1},${r.y1}`.padEnd(20)} ${`${r.rlo}-${r.rhi}`.padStart(10)} ${String(built).padStart(9)} ${String(pave).padStart(8)}  ${r.rlo > THRESH ? 'DROP ' : 'keep '}${r.boxed ? '' : ' UNBOXED'}  ${[...owners].join(' / ')}`);
  }
}
