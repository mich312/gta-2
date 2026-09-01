// Ground truth, not inference: run the layout and read `cleared` — the mask
// `unlay` sets on every tile a removal pass took carriageway out of, and the
// exact mask `cutMissedJunctions` consults when it decides whether a gap is a
// junction nobody cut or a removal somebody meant.
//
// For each of the 13 `road-stops-short` mouths, ask of every gap tile:
//   - was it ever carriageway (`cleared`)?
//   - would `cutMissedJunctions`'s own `cuttable` have let it through?
//
// CONTROL: the same question asked of ground away from the ring, where the
// pass DID cut — if `cleared` reads 1 everywhere the probe is not measuring
// anything.
//
// Run: node evidence/iter9/cleared.mjs
import { plan } from './lib.mjs';
import { buildLayout, T_FIELD, T_ROAD, T_BRIDGE, T_RAMP, T_WATER, T_SIDEWALK } from '../../shared/dist/index.js';

const L = buildLayout(plan);
const W = L.widthTiles, H = L.heightTiles, tiles = L.tiles, cleared = L.cleared;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : tiles[y * W + x]);

let clearedN = 0;
for (let i = 0; i < W * H; i++) if (cleared[i] === 1) clearedN++;
console.log(`layout: ${W}x${H}   cleared mask: ${clearedN} tiles of carriageway a removal pass took out`);
console.log(`(if this were the whole map the probe would be measuring nothing: it is ${(100 * clearedN / (W * H)).toFixed(2)}% of it)`);

// The 13 mouths, as mapaudit names them: centre, cap width, heading, gap depth.
const MOUTHS = [
  [264, 385, 3, 1, 0, 3], [264, 390, 3, 1, 0, 3], [264, 407, 3, 1, 0, 3],
  [641, 437, 3, 1, 0, 3], [265, 552, 3, 1, 0, 3], [268, 567, 3, 1, 0, 3],
  [282, 407, 3, -1, 0, 3], [285, 424, 3, -1, 0, 3], [289, 475, 3, -1, 0, 3],
  [410, 103, 3, 0, 1, 3], [427, 120, 3, 0, -1, 3], [457, 649, 2, 0, 1, 3],
  [503, 640, 2, 0, 1, 4],
];

console.log('\n# at          w gap  gap tiles: cleared? / field-at-layout-time? / cuttable?');
let allCleared = 0;
for (const [cx, cy, len, dx, dy, short] of MOUTHS) {
  const px = dy, py = -dx;
  const half = (len - 1) / 2;
  const notes = [];
  let anyCleared = false, allCut = true;
  for (let d = 1; d < short; d++)
    for (let k = -half; k <= half; k += 1) {
      const gx = Math.round(cx + px * k + dx * d), gy = Math.round(cy + py * k + dy * d);
      const i = gy * W + gx;
      const c = cleared[i] === 1, f = tiles[i] === T_FIELD;
      if (c) anyCleared = true;
      if (c || !f) allCut = false;
      notes.push(`${gx},${gy}:${c ? 'CLEARED' : 'never-road'}${f ? '' : '/not-field'}`);
    }
  if (anyCleared) allCleared++;
  console.log(`${`${cx},${cy}`.padEnd(12)}${String(len).padEnd(2)}${String(short - 1).padEnd(5)}${anyCleared ? 'REMOVAL — cutMissedJunctions must not undo it' : 'NEVER CARVED — the pass should have cut this'}`);
  console.log(`             ${notes.join('  ')}`);
}
console.log(`\n${allCleared} of ${MOUTHS.length} mouths have a gap a removal pass cleared.`);

/* ---- CONTROL: can this probe read a NOT-cleared gap? -------------- */
// cutMissedJunctions runs last and lays road over gaps that were never carved.
// Those tiles are now T_ROAD with cleared=0 — invisible after the fact. So the
// control is the opposite: sample ordinary bare ground beside a street and
// confirm the probe reads `never-road` there. If every tile in the city reads
// CLEARED the probe is stuck high and its verdict above is worthless.
let sampled = 0, clr = 0;
for (let y = 8; y < H - 8 && sampled < 4000; y += 3)
  for (let x = 8; x < W - 8 && sampled < 4000; x += 3) {
    if (tiles[y * W + x] !== T_FIELD) continue;
    let beside = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isRoad(at(x + dx, y + dy))) beside = true;
    if (!beside) continue;
    sampled++;
    if (cleared[y * W + x] === 1) clr++;
  }
console.log(`\nCONTROL — bare ground beside a carriageway, sampled ${sampled} tiles: ${clr} CLEARED, ${sampled - clr} never-road.`);
console.log('The probe reads both values, so "CLEARED" above is a measurement and not a stuck bit.');
