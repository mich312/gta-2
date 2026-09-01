/* Does the wildness field's own contour explain the woodland outline?
 *
 * The deck fix (iter 8) worked because `carveCourse` recorded the swept disc
 * it cut the deck from, so the tile mask was that curve point-sampled. This
 * asks the same question of woodland: `bake.ts:609` plants T_TREES where
 * `fbm(WILD_SEED, tx/22, ty/22) >= 0.52`, so the wood's outline should be the
 * level set of that field and the tile mask its point sample.
 *
 * CONTROL: the same census against a DIFFERENT seed. If a wrong field scores
 * as well as the right one, this probe measures nothing.
 */
import { readFileSync } from 'node:fs';
import { decodeBakedCity, T_TREES, T_FIELD, T_PARK, T_SAND } from '../../shared/dist/index.js';
import { fbm } from '../../shared/dist/world/fields.js';

const WILD_SEED = 0x7009d5;
const s = readFileSync('shared/src/world/city.data.ts', 'utf8');
const a = s.indexOf('"'), b = s.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(s.slice(a, b + 1))));
const W = city.widthTiles, H = city.heightTiles, t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : t[y * W + x];

const inside = (v) => v === T_TREES;
const outside = (v) => v === T_FIELD || v === T_PARK || v === T_SAND;

function census(seed, scale, thr, label) {
  const wild = (x, y) => fbm(seed, x / scale, y / scale) >= thr;
  let faces = 0, agree = 0, treeAgree = 0, treeN = 0, openAgree = 0, openN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = at(x, y);
      if (!inside(v) && !outside(v)) continue;
      let onFace = false;
      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
        const n = at(x + dx, y + dy);
        if (inside(v) && outside(n)) onFace = true;
        if (outside(v) && inside(n)) onFace = true;
      }
      if (!onFace) continue;
      faces++;
      const w = wild(x, y);
      const ok = inside(v) ? w : !w;
      if (ok) agree++;
      if (inside(v)) { treeN++; if (ok) treeAgree++; }
      else { openN++; if (ok) openAgree++; }
    }
  }
  console.log(`${label.padEnd(30)} boundary tiles ${String(faces).padStart(6)}   field agrees ${String(agree).padStart(6)} = ${(100*agree/faces).toFixed(1)}%   (trees ${(100*treeAgree/treeN).toFixed(1)}%  open ${(100*openAgree/openN).toFixed(1)}%)`);
  return agree / faces;
}

console.log('\nWoodland boundary tiles vs the wildness field, shipped bake\n');
const real = census(WILD_SEED, 22, 0.52, 'bake.ts:609 field (real)');
const c1 = census(WILD_SEED ^ 0x5bd1, 22, 0.52, 'CONTROL wrong seed');
const c2 = census(WILD_SEED, 7, 0.52, 'CONTROL wrong scale');
const c3 = census(WILD_SEED, 22, 0.40, 'CONTROL wrong threshold');
console.log(`\nreal ${(100*real).toFixed(1)}%  vs best control ${(100*Math.max(c1,c2,c3)).toFixed(1)}%\n`);
