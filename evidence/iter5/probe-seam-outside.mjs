// What would a polygon-anchored seam rule suppress, city-wide?
//
// Reproduces `laySeamStreets`'s marking step from the layout's own `owner`
// plane and the tile plane as it stood after `layEsplanade` (captured with the
// temporary `__LAYOUT_PROBE__` hook), then splits the marked seam into the
// tiles where at least one side is inside its own district's AUTHORED polygon
// and the tiles where neither is. For every dropped run it reports how much
// town stands beside it in the shipped bake — the test of whether the rule
// silences a seam that should be there.
import { loadBake, plan, NEW, S } from './lib.mjs';

const { T_WATER, T_ROAD, T_BRIDGE, pointInPoly, buildLayout } = S;
const W = plan.widthTiles,
  H = plan.heightTiles;

const inOwnPoly = new Int8Array(W * H); // 1 where the tile is inside ITS owner's polygon
const inAnyPoly = new Uint8Array(W * H);
const polyOf = [];
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
  polyOf.push([di, d, x0, y0, x1, y1]);
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++)
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      const i = ty * W + tx;
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) inAnyPoly[i] = 1;
    }
}

let afterEsplanade = null;
globalThis.__LAYOUT_PROBE__ = (name, tiles) => {
  if (name === 'layEsplanade') afterEsplanade = tiles.slice();
};
const layout = buildLayout(plan);
const owner = layout.owner,
  water = layout.water;
for (let i = 0; i < W * H; i++) {
  const own = owner[i];
  if (own < 0) continue;
  const tx = i % W,
    ty = (i - tx) / W;
  inOwnPoly[i] = pointInPoly(plan.districts[own].area, tx + 0.5, ty + 0.5) ? 1 : 0;
}

const preSeam = afterEsplanade;
const seamRoadNear = (tx, ty, nx, ny) => {
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const px = tx + nx * k,
      py = ty + ny * k;
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const t = preSeam[py * W + px];
    if (t === T_ROAD || t === T_BRIDGE) return true;
  }
  return false;
};

const VARIANT = process.argv[2] ?? 'poly';
const THRESH = Number(process.argv[3] ?? 24);

// Per district: distance over dry land from that district's OWN authored
// polygon, for the ground that district owns after the D1 flood. 0 inside it.
const reach = new Int32Array(W * H).fill(-1);
for (const [di, d] of plan.districts.entries()) {
  const dist = new Int32Array(W * H).fill(-1);
  const q = [];
  const [, , bx0, by0, bx1, by1] = polyOf[di];
  for (let ty = Math.max(0, Math.floor(by0)); ty <= Math.min(H - 1, Math.ceil(by1)); ty++)
    for (let tx = Math.max(0, Math.floor(bx0)); tx <= Math.min(W - 1, Math.ceil(bx1)); tx++) {
      const i = ty * W + tx;
      if (water[i] === 1 || !pointInPoly(d.area, tx + 0.5, ty + 0.5)) continue;
      dist[i] = 0;
      q.push(i);
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
  for (let i = 0; i < W * H; i++) if (owner[i] === di) reach[i] = dist[i];
}

const boxes = polyOf.map(([, , x0, y0, x1, y1]) => [x0, y0, x1, y1]);
const inBox = (di, tx, ty) => {
  const b = boxes[di];
  return tx >= b[0] && ty >= b[1] && tx <= b[2] && ty <= b[3];
};

const marked = [];
const anchored = new Uint8Array(W * H);
for (let ty = 0; ty < H; ty++) {
  for (let tx = 0; tx < W; tx++) {
    const i = ty * W + tx;
    if (water[i] === 1) continue;
    const a = owner[i];
    if (a < 0 || plan.districts[a].rural) continue;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ]) {
      const qx = tx + dx,
        qy = ty + dy;
      if (qx >= W || qy >= H) continue;
      const j = qy * W + qx;
      if (water[j] === 1) continue;
      const b = owner[j];
      if (b < 0 || b === a || plan.districts[b].rural) continue;
      if (seamRoadNear(tx, ty, dx, dy)) continue;
      marked.push(i);
      if (VARIANT === 'reach') {
        const ra = reach[i] < 0 ? 1e9 : reach[i];
        const rb = reach[j] < 0 ? 1e9 : reach[j];
        if (Math.min(ra, rb) <= THRESH) anchored[i] = 1;
      } else if (VARIANT === 'poly') {
        if (inOwnPoly[i] === 1 || inOwnPoly[j] === 1) anchored[i] = 1;
      } else {
        // bbox variant: can EITHER borough's lattice reach this tile at all?
        // `weaveFabrics` carves each borough's lines only inside its own
        // polygon's bounding box, so outside both boxes no lattice line can
        // ever arrive at this seam and there is nothing for it to catch.
        if (inBox(a, tx, ty) || inBox(b, tx, ty) || inBox(a, qx, qy) || inBox(b, qx, qy)) anchored[i] = 1;
      }
      break;
    }
  }
}

const drop = marked.filter((i) => !anchored[i]);
console.log(`seam tiles marked: ${marked.length}`);
console.log(`  anchored (one side inside its own district's polygon): ${marked.length - drop.length}`);
console.log(`  neither side drawn there: ${drop.length}  -> the tiles a polygon-anchored rule stops`);
console.log(`  dilated 3x3, that is at most ${drop.length * 9} tiles of carriageway, before overlap`);

// Group the dropped tiles into runs and report the town beside each.
const city = loadBake(NEW);
const tiles = city.tiles;
const T_BUILDING = S.T_BUILDING,
  T_FLOOR = S.T_FLOOR,
  T_SIDEWALK = S.T_SIDEWALK;
const dropSet = new Set(drop);
const seen = new Set();
const runs = [];
for (const s of drop) {
  if (seen.has(s)) continue;
  const bag = [s];
  seen.add(s);
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q],
      x = i % W,
      y = (i - x) / W;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const j = (y + dy) * W + x + dx;
        if (!dropSet.has(j) || seen.has(j)) continue;
        seen.add(j);
        bag.push(j);
      }
  }
  runs.push({ n: bag.length, bag, x0, y0, x1, y1 });
}
runs.sort((a, b) => b.n - a.n);
console.log(`\n${runs.length} runs. For each: how much town stands within 20 tiles of it in the shipped bake.`);
console.log(`  ${'run'.padStart(4)} ${'tiles'.padStart(6)}  ${'bbox'.padEnd(20)} ${'built'.padStart(7)} ${'pavement'.padStart(9)} ${'reach'.padStart(10)}  owners`);
for (const [k, r] of runs.entries()) {
  if (r.n < 3) continue;
  let built = 0,
    pave = 0;
  const near = new Set();
  const owners = new Set();
  let rlo = Infinity,
    rhi = -Infinity;
  for (const i of r.bag) {
    const x = i % W,
      y = (i - x) / W;
    const rr = reach[i] < 0 ? 9999 : reach[i];
    if (rr < rlo) rlo = rr;
    if (rr > rhi) rhi = rr;
    owners.add(plan.districts[owner[i]].name);
    const j2 = y * W + x + 1;
    if (owner[j2] >= 0) owners.add(plan.districts[owner[j2]].name);
    for (let dy = -20; dy <= 20; dy += 1)
      for (let dx = -20; dx <= 20; dx += 1) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (near.has(j)) continue;
        near.add(j);
        if (tiles[j] === T_BUILDING || tiles[j] === T_FLOOR) built++;
        else if (tiles[j] === T_SIDEWALK) pave++;
      }
  }
  console.log(
    `  ${String(k).padStart(4)} ${String(r.n).padStart(6)}  ${`${r.x0},${r.y0}-${r.x1},${r.y1}`.padEnd(20)} ${String(built).padStart(7)} ${String(pave).padStart(9)} ${`${rlo}-${rhi}`.padStart(10)}  ${[...owners].join(' / ')}`,
  );
}
