// Round 7 — R5-A03: what the seagoing flood costs at map scale.
//
//   node evidence/round7/probe-flood.mjs
//
// The alternative considered was a flood PER mooring candidate; the scan
// passes its two local guards 13,391 times, so that is 13,391 floods. This
// is the one that ships: a single border-seeded flood over the whole plane.
import { generateCity, T_WATER, T_BRIDGE } from '../../shared/dist/index.js';
import { loadWorldgenParams } from '../../server/dist/tuning.js';

const map = generateCity(1, loadWorldgenParams());
const W = map.widthTiles;
const H = map.heightTiles;

function flood() {
  const open = (i) => map.tiles[i] === T_WATER || map.tiles[i] === T_BRIDGE;
  const reach = new Uint8Array(W * H);
  const st = [];
  const push = (i) => {
    if (reach[i] === 1 || !open(i)) return;
    reach[i] = 1;
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
  let n = 0;
  for (let i = 0; i < reach.length; i++) n += reach[i];
  return n;
}

flood();
const ts = [];
let n = 0;
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  n = flood();
  ts.push(performance.now() - t0);
}
console.log(`sea tiles ${n} of ${W * H} — flood ms: ${ts.map((x) => x.toFixed(1)).join(' ')}`);
