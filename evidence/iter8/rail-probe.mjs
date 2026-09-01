// Why is the new parapet gapped?
//
//   node evidence/iter8/rail-probe.mjs
//
// `buildBridgeRails` keeps the old "is that the river" test and asks it of a
// point off the chord. This counts how many chords the test accepts at each
// probe distance, so the gap is attributed rather than guessed at.
import { loadBake, NEW, S } from '../iter7/lib.mjs';

const { T_BRIDGE, T_WATER, buildDeckCut } = S;
const city = loadBake(NEW);
const W = city.widthTiles,
  H = city.heightTiles,
  t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : t[y * W + x]);
const cut = buildDeckCut(t, W, H, city.courses);

for (const PROBE of [1 / 3, 0.5, 0.75, 1.0, 1.25]) {
  let ok = 0,
    hitDeck = 0,
    hitLand = 0;
  for (const [idx, seg] of cut) {
    const tx = idx % W,
      ty = (idx - tx) / W;
    const vx = seg[2] - seg[0],
      vy = seg[3] - seg[1];
    const len = Math.hypot(vx, vy);
    if (len === 0) continue;
    const wx = -vy / len,
      wy = vx / len;
    const mx = tx + (seg[0] + seg[2]) / 2,
      my = ty + (seg[1] + seg[3]) / 2;
    const v = at(Math.floor(mx + wx * PROBE), Math.floor(my + wy * PROBE));
    if (v === T_WATER) ok++;
    else if (v === T_BRIDGE) hitDeck++;
    else hitLand++;
  }
  console.log(
    `probe ${PROBE.toFixed(2)} tiles:  water ${String(ok).padStart(4)}   ` +
      `still on the deck ${String(hitDeck).padStart(4)}   land ${String(hitLand).padStart(3)}   ` +
      `of ${cut.size}`,
  );
}
console.log('');
console.log('A probe that lands back on the deck tile is the gap: the chord can');
console.log('sit anywhere in its square, so a third of a tile past it is often');
console.log('still the same square, and that square is T_BRIDGE.');
