/* What is LEFT, and why the wood curve declines to claim it.
 *
 * `woodCut` only draws a face the wildness field explains on BOTH squares.
 * This counts the woodland boundary faces still on no smoothing layer after
 * the fix and attributes each to the reason the field could not claim it, so
 * the residue is a named population rather than "the rest".
 *
 *   node evidence/iter12/uncovered-why.mjs
 */
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity, shoreChains, buildDeckCut, deriveBevels, BEV_NONE,
  buildWoodCut, wildAt,
  T_TREES, T_FIELD, T_PARK, T_SAND, T_WATER, T_BANK, T_ROAD, T_BRIDGE,
} from '../../shared/dist/index.js';

const src = readFileSync('shared/src/world/city.data.ts', 'utf8');
const q0 = src.indexOf('"'), q1 = src.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(src.slice(q0, q1 + 1))));
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);

const coast = shoreChains(city.shores, W, H);
const band = shoreChains(city.banks, W, H);
const deck = buildDeckCut(tiles, W, H, city.courses);
const bev = deriveBevels(tiles, W, H);
const wood = buildWoodCut(tiles, W, H);
const smoothed = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const i = y * W + x;
  return coast.has(i) || band.has(i) || deck.has(i) || bev[i] !== BEV_NONE || wood.has(i);
};

const isOpen = (t) => t === T_FIELD || t === T_PARK || t === T_SAND;
const NAME = { [T_FIELD]: 'meadow', [T_PARK]: 'park', [T_SAND]: 'sand' };

const why = new Map();
const bump = (k) => why.set(k, (why.get(k) ?? 0) + 1);
let faces = 0, left = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (at(x, y) !== T_TREES) continue;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const n = at(x + dx, y + dy);
      if (!isOpen(n)) continue;
      faces++;
      if (smoothed(x, y) || smoothed(x + dx, y + dy)) continue;
      left++;
      const inWood = wildAt(x, y);
      const outOpen = !wildAt(x + dx, y + dy);
      const nearWater = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
        .some(([ex, ey]) => at(x + ex, y + ey) === T_WATER || at(x + ex, y + ey) === T_BANK);
      // `hedgerowAt`/`orchardRowAt` cannot be asked here: both require the
      // tile to still be T_FIELD, and by now it is T_TREES. Both plant one
      // verge back from a lane, so proximity to carriageway stands in for
      // them, and it is reported as the proxy it is.
      let nearRoad = false;
      for (let ey = -3; ey <= 3 && !nearRoad; ey++) {
        for (let ex = -3; ex <= 3; ex++) {
          const t = at(x + ex, y + ey);
          if (t === T_ROAD || t === T_BRIDGE) { nearRoad = true; break; }
        }
      }
      const planted = nearRoad;
      if (!inWood && !outOpen) bump(`field says MEADOW under the trees and WOOD under the ${NAME[n]}`);
      else if (!inWood) {
        if (planted) bump('field says MEADOW under the trees, and a lane is within 3 tiles: a HEDGEROW or ORCHARD ROW, a planted LINE whose outline IS the tile');
        else if (nearWater) bump('field says MEADOW under the trees: the SHEER SHORE CLIFF the shore pass stands at the waterline');
        else bump('field says MEADOW under the trees: some other later pass');
      }
      else if (!outOpen) bump(`field says WOOD under the ${NAME[n]} (a cleared lane verge, a park, a block edge)`);
      else bump('field explains both — the tile declined a chord (saddle, or a nick under 0.02 tile)');
    }
  }
}

console.log(`\n  woodland/open faces: ${faces}`);
console.log(`  still on no smoothing layer: ${left} (${(100 * left / faces).toFixed(1)}%)\n`);
for (const [k, v] of [...why].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${(100 * v / left).toFixed(1).padStart(5)}%  ${k}`);
}
console.log('');
