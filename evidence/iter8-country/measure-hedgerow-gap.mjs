// How much of the rural fill's rule does the blockless-country pass ask?
//
//   node evidence/iter8-country/measure-hedgerow-gap.mjs [city.data.ts]
//
// `fillBlock`'s rural branch has FOUR rules, not one:
//   1. woodland where the wildness field says wood            (all rural blocks)
//   2. HEDGEROWS — a tree-line one verge back from every lane (all rural blocks)
//   3. orchard rows on a planted grid                         (fringe band only)
//   4. smallholdings, a house and its yard by a lane          (fringe band only)
// Iteration 3's blockless-country pass in `bake.ts` asks rule 1 and stops.
// This counts the tiles of rural country outside every block that rules 2
// and 3 would have claimed, so the size of the gap is a number rather than
// an impression. Rule 4 places BUILDINGS and is counted but not proposed.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const F = await import(`file://${R}/shared/dist/world/fields.js`);
const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
const { T_FIELD, T_TREES, T_WATER, T_ROAD, T_BUILDING, pointInPoly } = S;
const HEDGE_SEED = 0x5eed9e;
const ORCHARD_SEED = 0x0bc4a2d;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const p = process.argv[2] ?? `${R}/shared/src/world/city.data.ts`;
const src = readFileSync(p, 'utf8');
const city = S.decodeBakedCity(
  JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;

// district ownership, the audit's flood
const owner = new Int16Array(W * H).fill(-1);
for (const [di, d] of plan.districts.entries()) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of d.area) {
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
    for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
    }
  }
}
{
  const bag = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && tiles[i] !== T_WATER) bag.push(i);
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (tiles[j] === T_WATER || owner[j] >= 0) continue;
      owner[j] = owner[i];
      bag.push(j);
    }
  }
}

// town distance, over dry land from all urban-owned ground (bake.ts)
const townDist = new Int32Array(W * H).fill(-1);
{
  const bag = [];
  for (let i = 0; i < W * H; i++) {
    const d = owner[i];
    if (d >= 0 && plan.districts[d].rural !== true && tiles[i] !== T_WATER) {
      townDist[i] = 0;
      bag.push(i);
    }
  }
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (townDist[j] >= 0 || tiles[j] === T_WATER) continue;
      townDist[j] = townDist[i] + 1;
      bag.push(j);
    }
  }
}
const fringeAt = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const d = owner[y * W + x];
  if (d < 0 || plan.districts[d].rural !== true) return false;
  const td = townDist[y * W + x];
  const st = plan.districts[d].street;
  return td >= 0 && td <= Math.min(st.pitchX, st.pitchY);
};

const covered = new Uint8Array(W * H);
for (const b of city.blocks) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) covered[y * W + x] = 1;
  }
}

const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const isRoad = (x, y) => at(x, y) === T_ROAD;
const nearRoad4 = (x, y) => isRoad(x - 1, y) || isRoad(x + 1, y) || isRoad(x, y - 1) || isRoad(x, y + 1);
const onShore4 = (x, y) =>
  at(x - 1, y) === T_WATER || at(x + 1, y) === T_WATER || at(x, y - 1) === T_WATER || at(x, y + 1) === T_WATER;
const besideBuilding = (x, y) => {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === T_BUILDING) return true;
  }
  return false;
};

const tally = { land: 0, hedge: 0, orchard: 0, fringe: 0, hedgeInBlock: 0, landInBlock: 0, heldWater: 0, heldMouth: 0, heldOther: 0 };
const byDistrict = new Map();
const hedgePos = [];
for (let i = 0; i < W * H; i++) {
  const t = tiles[i];
  if (t !== T_FIELD && t !== T_TREES) continue;
  const d = owner[i];
  if (d < 0 || plan.districts[d].rural !== true) continue;
  const x = i % W;
  const y = (i - x) / W;
  // The hedgerow rule, verbatim from `fillBlock`.
  const hedge =
    t === T_FIELD &&
    x >= 1 &&
    y >= 1 &&
    x < W - 1 &&
    y < H - 1 &&
    !nearRoad4(x, y) &&
    !onShore4(x, y) &&
    (nearRoad4(x - 1, y) || nearRoad4(x + 1, y) || nearRoad4(x, y - 1) || nearRoad4(x, y + 1)) &&
    !besideBuilding(x, y) &&
    !(
      (isRoad(x, y - 1) || isRoad(x, y - 2) || isRoad(x, y + 1) || isRoad(x, y + 2)) &&
      (isRoad(x - 1, y) || isRoad(x - 2, y) || isRoad(x + 1, y) || isRoad(x + 2, y))
    ) &&
    F.latticeHash(HEDGE_SEED, x >> 2, y >> 2) < 0.68;
  if (covered[i] === 1) {
    tally.landInBlock++;
    if (hedge) tally.hedgeInBlock++;
    continue;
  }
  tally.land++;
  if (fringeAt(x, y)) tally.fringe++;
  if (hedge) {
    tally.hedge++;
    // Why the blockless pass still refuses it: its own two rules, which are
    // stricter than the block's and stay that way.
    const nearWater1 = (() => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === T_WATER) return true;
      return false;
    })();
    const roadWithin3 = (dx, dy) => {
      for (let k = 1; k <= 3; k++) { const t2 = at(x + dx * k, y + dy * k); if (t2 === T_ROAD || t2 === S.T_BRIDGE) return true; }
      return false;
    };
    const mouth = (roadWithin3(1, 0) && roadWithin3(-1, 0)) || (roadWithin3(0, 1) && roadWithin3(0, -1));
    tally.heldWater += nearWater1 ? 1 : 0;
    tally.heldMouth += !nearWater1 && mouth ? 1 : 0;
    tally.heldOther += !nearWater1 && !mouth ? 1 : 0;
    hedgePos.push([x, y, plan.districts[d].name]);
    const k = plan.districts[d].name;
    byDistrict.set(k, (byDistrict.get(k) ?? 0) + 1);
  }
  if (
    t === T_FIELD &&
    fringeAt(x, y) &&
    !nearRoad4(x, y) &&
    !onShore4(x, y) &&
    F.latticeHash(ORCHARD_SEED, x >> 4, y >> 4) < 0.35 &&
    x % 3 === 0 &&
    y % 2 === 0
  ) {
    tally.orchard++;
  }
}
console.log(p);
console.log(`  rural country INSIDE a block : ${tally.landInBlock} tiles, ${tally.hedgeInBlock} of them hedgerow positions`);
console.log(`  rural country OUTSIDE every block: ${tally.land} tiles`);
console.log(`     in the fringe band (§14.3 D5) : ${tally.fringe}`);
console.log(`     hedgerow positions unplanted  : ${tally.hedge}`);
console.log(`     orchard-row positions unplanted: ${tally.orchard}`);
console.log(`       of the unplanted hedgerows: ${tally.heldWater} within one tile of water, ${tally.heldMouth} across a held-short mouth, ${tally.heldOther} neither`);
for (const [k, v] of [...byDistrict].sort((a, b) => b[1] - a[1])) console.log(`       hedgerow ${k}: ${v}`);
if (process.env.POS) {
  // Cluster the unplanted hedgerow positions, and say how many of each run
  // touch a tree that IS planted — a hedge run stopping dead at an invisible
  // block boundary is the visible form of this gap.
  const key = new Set(hedgePos.map(([x, y]) => y * W + x));
  const seen = new Set();
  const runs = [];
  for (const [x, y] of hedgePos) {
    const i = y * W + x;
    if (seen.has(i)) continue;
    const bag = [i];
    seen.add(i);
    let touchesPlanted = 0;
    for (let q = 0; q < bag.length; q++) {
      const j = bag[q];
      const jx = j % W;
      const jy = (j - jx) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (key.has(n)) { if (!seen.has(n)) { seen.add(n); bag.push(n); } }
          else if (tiles[n] === T_TREES && covered[n] === 1) touchesPlanted++;
        }
      }
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const j of bag) { const jx = j % W, jy = (j - jx) / W;
      if (jx < x0) x0 = jx; if (jy < y0) y0 = jy; if (jx > x1) x1 = jx; if (jy > y1) y1 = jy; }
    runs.push({ n: bag.length, x0, y0, x1, y1, touchesPlanted });
  }
  runs.sort((a, b) => b.n - a.n);
  console.log(`  ${runs.length} unplanted hedgerow runs; ${runs.filter((r) => r.touchesPlanted > 0).length} of them touch a hedge that IS planted inside a block`);
  for (const r of runs.slice(0, 20)) console.log(`     ${String(r.n).padStart(3)} tiles ${r.x0},${r.y0}-${r.x1},${r.y1}  touching planted: ${r.touchesPlanted}`);
}
