import { readFileSync } from 'node:fs';
import * as S from 'shared';
const { generateCity, parseWorldgenParams, T_ROAD, T_BRIDGE, T_SIDEWALK } = S;
const params = parseWorldgenParams(JSON.parse(readFileSync(new URL(import.meta.resolve('shared/data/worldgen.json')), 'utf8')));
const m = generateCity(1, params);
const W = m.widthTiles, H = m.heightTiles, t = m.tiles;
const names = {}; for (const [k, v] of Object.entries(S)) if (/^T_/.test(k) && typeof v === 'number') names[v] = k.slice(2);
// one street network?
const lab = new Int32Array(W * H).fill(-1);
let n = 0; const sz = [];
for (let s = 0; s < W * H; s++) {
  const v = t[s];
  if (lab[s] >= 0 || (v !== T_ROAD && v !== T_BRIDGE)) continue;
  const q = [s]; lab[s] = n; let c = 0;
  while (q.length) { const i = q.pop(); c++; const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = x+dx, ny = y+dy; if (nx<0||ny<0||nx>=W||ny>=H) continue; const j = ny*W+nx;
      const u = t[j]; if (lab[j] < 0 && (u === T_ROAD || u === T_BRIDGE)) { lab[j] = n; q.push(j); } } }
  sz.push(c); n++;
}
sz.sort((a, b) => b - a);
console.log(`street network: ${n} piece(s); biggest ${sz[0]}, others ${sz.slice(1, 8).join(',') || 'none'}`);
// a downtown row, tile by tile
console.log('\ndowntown x470-529 at y=170..178:');
for (let y = 170; y <= 178; y++)
  console.log(`  y=${y}: ` + Array.from({ length: 30 }, (_, i) => (names[t[y * W + 470 + i * 2]] ?? '?').slice(0, 3)).join(' '));
