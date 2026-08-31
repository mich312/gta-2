// Round 5, lens A. Run from the repo root after `pnpm build`:
//   node evidence/round5/A-repro-pond-boats.mjs
//
// Floods water-or-bridge from the map border (a deck is passable in the water
// medium: collide.ts:45) and reports every boat mooring that is not on the
// sea.
import { generateCity, TILE_SIZE, T_WATER, T_BRIDGE } from '../../shared/dist/index.js';
import { loadWorldgenParams } from '../../server/dist/tuning.js';

const map = generateCity(1, loadWorldgenParams());
const W = map.widthTiles;
const H = map.heightTiles;
const nav = (i) => map.tiles[i] === T_WATER || map.tiles[i] === T_BRIDGE;
const lab = new Int32Array(W * H).fill(-1);
const info = [];
for (let s = 0; s < W * H; s++) {
  if (!nav(s) || lab[s] >= 0) continue;
  const id = info.length;
  let n = 0;
  const st = [s];
  lab[s] = id;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  while (st.length) {
    const i = st.pop();
    n++;
    const x = i % W;
    const y = (i - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (lab[j] >= 0 || !nav(j)) continue;
      lab[j] = id;
      st.push(j);
    }
  }
  info.push({ n, box: [x0, y0, x1, y1] });
}
const sea = lab[0];
let off = 0;
for (const b of map.boatSpawns) {
  const tx = Math.floor(b.x / TILE_SIZE);
  const ty = Math.floor(b.y / TILE_SIZE);
  const id = lab[ty * W + tx];
  if (id === sea) continue;
  off++;
  console.log(`boat at tile ${tx},${ty} — landlocked water, ${info[id].n} tiles, bbox ${info[id].box.join(',')}`);
}
console.log(`\n${off} of ${map.boatSpawns.length} moorings are not on the sea.`);
