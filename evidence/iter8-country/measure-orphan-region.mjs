// Cross the audit's `country-outside-blocks` regions against the bake's own
// orphan-pass decisions.
//
//   pnpm build
//   node evidence/iter8-country/probe-attribute.mjs /tmp/orphan-probe.txt
//   node evidence/iter8-country/measure-orphan-region.mjs /tmp/orphan-probe.txt
//
// The audit and the bake do NOT use the same definitions:
//   - "covered by a block": the audit uses each block's bounding BOX, the
//     bake uses the block's MASK.
//   - "rural ground": the audit floods district ownership over all dry land
//     (`ownerPlane`), the bake uses `layout.owner`.
// So a tile can be orphan country to one and not to the other. This prints,
// for every tile in every audit region, what the bake actually decided there.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
const src = readFileSync(`${R}/shared/src/world/city.data.ts`, 'utf8');
const city = S.decodeBakedCity(
  JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const { T_FIELD, T_TREES, T_WATER, pointInPoly } = S;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// --- the audit's ownerPlane, verbatim ---
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

const isCountry = (t) => t === T_FIELD || t === T_TREES;
const ruralTile = (i) => owner[i] >= 0 && plan.districts[owner[i]].rural === true;
const coveredBox = new Uint8Array(W * H);
for (const b of city.blocks) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) coveredBox[y * W + x] = 1;
  }
}
const open = (i) => coveredBox[i] === 0 && isCountry(tiles[i]) && ruralTile(i);

// --- the probe rows from the live bake ---
const probe = new Map();
for (const line of readFileSync(process.argv[2] ?? '/tmp/orphan-probe.txt', 'utf8').split('\n')) {
  if (!line) continue;
  const parts = line.split(' ');
  probe.set(Number(parts[1]) * W + Number(parts[0]), parts.slice(2).join(' '));
}

// --- flood the audit's regions and attribute every tile ---
const seen = new Uint8Array(W * H);
let cityLand = 0;
let cityWood = 0;
const regions = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] || !open(s)) continue;
  const bag = [s];
  seen[s] = 1;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let wood = 0;
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    if (tiles[i] === T_TREES) wood++;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
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
  cityLand += bag.length;
  cityWood += wood;
  regions.push({ bag, x0, y0, x1, y1, wood, name: plan.districts[owner[s]].name });
}
regions.sort((a, b) => b.bag.length - a.bag.length);
console.log(
  `CITY-WIDE blockless rural country: ${regions.length} regions, ${cityLand} tiles, ${cityWood} wood (${(
    (100 * cityWood) / cityLand
  ).toFixed(1)}%)`,
);
const big = regions.filter((r) => r.bag.length >= 40);
console.log(
  `  regions >= 40 tiles: ${big.length}, ${big.reduce((a, r) => a + r.bag.length, 0)} tiles, ${big.reduce(
    (a, r) => a + r.wood,
    0,
  )} wood`,
);
console.log('');
const MIN = Number(process.env.MIN ?? 40);
for (const r of regions) {
  if (r.bag.length < MIN) continue;
  const roll = new Map();
  for (const i of r.bag) {
    const w = probe.get(i) ?? 'ABSENT';
    const key = w.startsWith('skip') ? `skip ${w.slice(5)}` : w;
    roll.set(key, (roll.get(key) ?? 0) + 1);
  }
  console.log(
    `${r.name} ${r.x0},${r.y0}-${r.x1},${r.y1}  ${r.bag.length} tiles  ${r.wood} wood (${(
      (100 * r.wood) / r.bag.length
    ).toFixed(1)}%)`,
  );
  for (const [k, v] of [...roll].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
}
