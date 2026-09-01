// For every control point of every bridging road: is it dry, which landmass
// is it on, and how far is the nearest dry tile.
import { readFileSync } from 'node:fs';
import { buildLayout, parseCityPlan } from '../../shared/dist/index.js';

const plan = parseCityPlan(
  JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8')),
);
const L = buildLayout(plan);
const { widthTiles: W, heightTiles: H, water } = L;

// Label 4-connected land components, biggest first.
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

const near = (x, y) => {
  for (let r = 0; r < 60; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (water[ny * W + nx] !== 1) return [r, rankOf.get(comp[ny * W + nx])];
      }
    }
  }
  return [Infinity, null];
};

console.log(`landmasses: ${sizes.length}; largest ${rank.slice(0, 8).map((id) => sizes[id]).join(', ')}`);
const want = process.argv.slice(2);
for (const road of plan.roads) {
  if (!road.bridges) continue;
  if (want.length && !want.includes(road.name)) continue;
  console.log(`\n=== ${road.name}`);
  for (const [x, y] of road.points) {
    const dry = water[Math.round(y) * W + Math.round(x)] !== 1;
    const [d, c] = near(Math.round(x), Math.round(y));
    console.log(
      `  [${x},${y}] ${dry ? `DRY on landmass #${c}` : `WET — nearest land ${d} tiles away, landmass #${c}`}`,
    );
  }
}
