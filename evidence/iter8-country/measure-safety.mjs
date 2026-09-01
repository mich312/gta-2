// What the new planting is allowed to touch, checked on the bytes.
//
//   node evidence/iter8-country/measure-safety.mjs OLD.city.data.ts NEW.city.data.ts
//
// `T_TREES` is collidable, so a hedge is a wall. Three things must hold of
// every tile this change planted, and none of them is taken on trust:
//   * not 4-adjacent to a carriageway  — a lane keeps its full width;
//   * not within one tile of water     — a shore tree is the cliff the shore
//                                        pass put there, and moving one moves
//                                        a landing;
//   * not on a block's own ground      — this pass answers for the ground no
//                                        block covers and nothing else.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const { T_TREES, T_WATER, T_ROAD, T_BRIDGE, T_RAMP } = S;
const load = (p) => {
  const src = readFileSync(p, 'utf8');
  return S.decodeBakedCity(
    JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
  );
};
const a = load(process.argv[2]);
const b = load(process.argv[3]);
const W = b.widthTiles;
const H = b.heightTiles;
const t = b.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : t[y * W + x]);
const isRoad = (v) => v === T_ROAD || v === T_BRIDGE || v === T_RAMP;

const inBlockMaskUnknown = new Uint8Array(W * H);
for (const bl of b.blocks) {
  for (let y = Math.max(0, bl.y); y < Math.min(H, bl.y + bl.h); y++) {
    for (let x = Math.max(0, bl.x); x < Math.min(W, bl.x + bl.w); x++) inBlockMaskUnknown[y * W + x] = 1;
  }
}

let planted = 0;
let felled = 0;
let touchRoad = 0;
let nearWater = 0;
let inBox = 0;
for (let i = 0; i < t.length; i++) {
  if (a.tiles[i] === t[i]) continue;
  const x = i % W;
  const y = (i - x) / W;
  if (t[i] !== T_TREES) {
    felled++;
    continue;
  }
  planted++;
  if (isRoad(at(x - 1, y)) || isRoad(at(x + 1, y)) || isRoad(at(x, y - 1)) || isRoad(at(x, y + 1))) touchRoad++;
  let water = false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === T_WATER) water = true;
  }
  if (water) nearWater++;
  if (inBlockMaskUnknown[i] === 1) inBox++;
}
console.log(`planted ${planted}, taken back out ${felled}`);
console.log(`  4-adjacent to a carriageway : ${touchRoad}   (must be 0)`);
console.log(`  within one tile of water    : ${nearWater}   (must be 0)`);
console.log(`  inside a block's bounding box: ${inBox}   (a box is not a mask; these sit outside the mask)`);
