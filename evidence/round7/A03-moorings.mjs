// Round 7 — R5-A03. A crop of a park pond with every mooring in it marked,
// because `pnpm mapgen` draws ground and a boat spawn is not ground.
//
//   node evidence/round7/A03-moorings.mjs <x> <y> <size> <out.png>
//
// A mooring whose water reaches the open sea is drawn white; one that does
// not — the defect — is drawn magenta, over a red cross. The sea is the
// water-or-bridge component the map border touches, which is the same medium
// `isSolidForBoat` lets a boat occupy.
import { writeFileSync } from 'node:fs';
import { generateCity, TILE_SIZE, T_WATER, T_BRIDGE } from '../../shared/dist/index.js';
import { loadWorldgenParams } from '../../server/dist/tuning.js';
import { loadPalette, render } from '../../server/dist/tools/mapRender.js';
import { encodePng } from '../../server/dist/tools/png.js';

const [, , ax, ay, asize, aout] = process.argv;
const cx = Number(ax);
const cy = Number(ay);
const size = Number(asize);
const out = aout ?? 'moorings.png';

const map = generateCity(1, loadWorldgenParams());
const W = map.widthTiles;
const H = map.heightTiles;

const open = (i) => map.tiles[i] === T_WATER || map.tiles[i] === T_BRIDGE;
const sea = new Uint8Array(W * H);
const st = [];
const push = (i) => {
  if (sea[i] === 1 || !open(i)) return;
  sea[i] = 1;
  st.push(i);
};
for (let x = 0; x < W; x++) {
  push(x);
  push((H - 1) * W + x);
}
for (let y = 0; y < H; y++) {
  push(y * W);
  push(y * W + W - 1);
}
while (st.length) {
  const i = st.pop();
  const x = i % W;
  const y = (i - x) / W;
  if (x > 0) push(i - 1);
  if (x < W - 1) push(i + 1);
  if (y > 0) push(i - W);
  if (y < H - 1) push(i + W);
}

const SCALE = Math.max(4, Math.min(24, Math.round(720 / size)));
const pic = render(map, loadPalette(), cx, cy, size, size, SCALE);

const put = (px, py, r, g, b) => {
  if (px < 0 || py < 0 || px >= pic.w || py >= pic.h) return;
  const o = (py * pic.w + px) * 4;
  pic.rgba[o] = r;
  pic.rgba[o + 1] = g;
  pic.rgba[o + 2] = b;
  pic.rgba[o + 3] = 255;
};

let marked = 0;
let landlocked = 0;
for (const s of map.boatSpawns) {
  const tx = Math.floor(s.x / TILE_SIZE);
  const ty = Math.floor(s.y / TILE_SIZE);
  if (tx < cx || ty < cy || tx >= cx + size || ty >= cy + size) continue;
  marked++;
  const ok = sea[ty * W + tx] === 1;
  if (!ok) landlocked++;
  const px = Math.round((tx - cx + 0.5) * SCALE);
  const py = Math.round((ty - cy + 0.5) * SCALE);
  const r = Math.max(2, Math.round(SCALE * 0.6));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (ok) put(px + dx, py + dy, 250, 250, 250);
      else put(px + dx, py + dy, 255, 40, 200);
    }
  }
  if (!ok) {
    for (let d = -r * 2; d <= r * 2; d++) {
      put(px + d, py + d, 220, 0, 0);
      put(px + d, py - d, 220, 0, 0);
    }
  }
}

writeFileSync(out, encodePng(pic.w, pic.h, pic.rgba));
console.log(
  `${out}: crop ${cx},${cy} ${size}x${size} — ${marked} moorings drawn, ${landlocked} landlocked ` +
    `(city total ${map.boatSpawns.length})`,
);
