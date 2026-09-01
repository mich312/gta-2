// The three suite pins my change moved, measured on both assets so the delta
// is a location rather than a number:
//   * merged tarmac sheets   (shared/test/city.test.ts)
//   * bridge deck runs and their real ends (client/test/bridgeParapet.test.ts)
//   node evidence/iter11/probe-pins.mjs <before-city.data.ts>
import { readFileSync } from 'node:fs';
import { decodeBakedCity, T_ROAD, T_BRIDGE, T_RAMP } from '../../shared/dist/index.js';

const load = (p) => {
  const s = readFileSync(p, 'utf8');
  return decodeBakedCity(JSON.parse(JSON.parse(s.slice(s.indexOf('"'), s.lastIndexOf('"') + 1))));
};

const merged = (map) => {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const cw = (x, y) => {
    const t = map.tiles[y * W + x];
    return t === T_ROAD || t === T_BRIDGE;
  };
  const hits = [];
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      if (!cw(x, y)) continue;
      let all = true;
      for (let dy = -3; dy <= 3 && all; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (!cw(x + dx, y + dy)) {
            all = false;
            break;
          }
        }
      }
      if (all) hits.push(`${x},${y}`);
    }
  }
  return hits;
};

// Deck runs: 8-connected components of T_BRIDGE. Each is one span, and the
// parapet test's "loose ends" budget is sized per span.
const decks = (map) => {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] === 1 || map.tiles[s] !== T_BRIDGE) continue;
    const bag = [s];
    seen[s] = 1;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q];
      const x = i % W;
      const y = (i - x) / W;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j] === 1 || map.tiles[j] !== T_BRIDGE) continue;
          seen[j] = 1;
          bag.push(j);
        }
      }
    }
    if (bag.length >= 8) out.push({ n: bag.length, box: [x0, y0, x1, y1] });
  }
  return out.sort((a, b) => b.n - a.n);
};

const A = load(process.argv[2]);
const B = load(new URL('../../shared/src/world/city.data.ts', import.meta.url).pathname);

const ma = merged(A);
const mb = merged(B);
const sa = new Set(ma);
const sb = new Set(mb);
console.log(`merged tarmac sheet tiles: before ${ma.length}, after ${mb.length}`);
console.log(`  gained: ${mb.filter((h) => !sa.has(h)).join(' ') || '(none)'}`);
console.log(`  lost:   ${ma.filter((h) => !sb.has(h)).join(' ') || '(none)'}`);

for (const [label, map] of [['before', A], ['after', B]]) {
  const d = decks(map);
  let tiles = 0;
  for (const c of d) tiles += c.n;
  console.log(`\n${label}: ${d.length} deck run(s) of 8+ tiles, ${tiles} bridge tiles`);
  for (const c of d) console.log(`   ${String(c.n).padStart(5)} tiles  [${c.box.join(', ')}]`);
}
