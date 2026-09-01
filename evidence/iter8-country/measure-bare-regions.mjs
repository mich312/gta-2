// How much blockless rural country is BARE, city-wide — the population
// question behind a signature that fires once.
//
//   node evidence/iter8-country/measure-bare-regions.mjs [city.data.ts]
//
// The audit reports one region because its ratio gate and its two neighbour
// gates are strict, not because there is one. This counts every region and
// says how many of them are bald, so "one hit" can be read against the whole
// population rather than taken as the whole population.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const F = await import(`file://${R}/shared/dist/world/fields.js`);
const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
const { T_FIELD, T_TREES, T_WATER, pointInPoly } = S;
const WILD_SEED = 0x7009d5;
const wildAt = (x, y) => F.fbm(WILD_SEED, x / 22, y / 22) >= 0.52;
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
const t = city.tiles;

const owner = new Int16Array(W * H).fill(-1);
for (const [di, d] of plan.districts.entries()) {
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      // Last district wins, exactly as `mapAudit`'s `ownerPlane` does, so
      // the regions split the same way the audit's do and the two counts can
      // be quoted side by side.
      if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
    }
  }
}
{
  const bag = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && t[i] !== T_WATER) bag.push(i);
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (t[j] === T_WATER || owner[j] >= 0) continue;
      owner[j] = owner[i];
      bag.push(j);
    }
  }
}
const covered = new Uint8Array(W * H);
for (const b of city.blocks) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) covered[y * W + x] = 1;
  }
}
const open = (i) =>
  covered[i] === 0 &&
  (t[i] === T_FIELD || t[i] === T_TREES) &&
  owner[i] >= 0 &&
  plan.districts[owner[i]].rural === true;

const seen = new Uint8Array(W * H);
const regions = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] || !open(s)) continue;
  const bag = [s];
  seen[s] = 1;
  let wood = 0;
  let wild = 0;
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    if (t[i] === T_TREES) wood++;
    if (wildAt(x, y)) wild++;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] || !open(j)) continue;
      seen[j] = 1;
      bag.push(j);
    }
  }
  regions.push({ n: bag.length, wood, wild });
}
const sum = (f, rs) => rs.reduce((a, r) => a + f(r), 0);
const big = regions.filter((r) => r.n >= 40);
const bald = big.filter((r) => r.wood === 0);
console.log(p);
console.log(
  `  ${regions.length} regions, ${sum((r) => r.n, regions)} tiles, ` +
    `${sum((r) => r.wood, regions)} wood (${((100 * sum((r) => r.wood, regions)) / sum((r) => r.n, regions)).toFixed(1)}%), ` +
    `${sum((r) => r.n, regions) - sum((r) => r.wood, regions)} bare`,
);
console.log(
  `  of 40 tiles or more: ${big.length} regions, ${sum((r) => r.n, big)} tiles, ` +
    `${sum((r) => r.wood, big)} wood`,
);
console.log(
  `  BALD (not one tree) among those: ${bald.length} regions, ${sum((r) => r.n, bald)} tiles — ` +
    `the wildness field calls ${sum((r) => r.wild, bald)} of those tiles wood`,
);
