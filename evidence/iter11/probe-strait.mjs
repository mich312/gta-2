// For each column x, the north-south water gap that separates the north
// island from the south island: how long a causeway a road at that x needs.
//   node evidence/iter11/probe-strait.mjs <x0> <x1> <step>
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan } from '../../shared/dist/index.js';

const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const L = buildLayout(plan);
const { widthTiles: W, heightTiles: H, water } = L;

const comp = new Int32Array(W * H).fill(-1);
const sizes = [];
for (let i = 0; i < comp.length; i++) {
  if (comp[i] >= 0 || water[i] === 1) continue;
  const id = sizes.length;
  const bag = [i];
  comp[i] = id;
  for (let q = 0; q < bag.length; q++) {
    const j = bag[q];
    const x = j % W;
    const y = (j - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (comp[k] >= 0 || water[k] === 1) continue;
      comp[k] = id;
      bag.push(k);
    }
  }
  sizes.push(bag.length);
}
const rank = [...sizes.keys()].sort((a, b) => sizes[b] - sizes[a]);
const rankOf = new Map(rank.map((id, r) => [id, r]));
const NORTH = rank[1]; // #1 = the north island
const SOUTH = rank[0]; // #0 = the south island

const [x0, x1, step] = process.argv.slice(2).map(Number);
for (let x = x0; x <= x1; x += step) {
  // walk down from the top: last tile of NORTH, first tile of SOUTH
  let lastN = -1;
  let firstS = -1;
  for (let y = 0; y < H; y++) {
    const c = comp[y * W + x];
    if (c === NORTH) lastN = y;
    if (c === SOUTH && firstS < 0 && lastN >= 0) firstS = y;
  }
  console.log(
    `x=${String(x).padStart(3)}  north island ends y=${lastN}  south island starts y=${firstS}  ` +
      `gap ${firstS >= 0 && lastN >= 0 ? firstS - lastN - 1 : '-'}`,
  );
}
console.log(`(north=#${rankOf.get(NORTH)} size ${sizes[NORTH]}, south=#${rankOf.get(SOUTH)} size ${sizes[SOUTH]})`);
