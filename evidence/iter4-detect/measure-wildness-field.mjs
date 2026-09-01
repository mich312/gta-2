import { loadBake, NEW, ROOT, S } from './lib.mjs';
const R = ROOT;
const F = await import(`file://${R}/shared/dist/world/fields.js`);
const WILD_SEED = 0x7009d5;
const wildAt = (x, y) => F.fbm(WILD_SEED, x / 22, y / 22) >= 0.52;
const c = loadBake(NEW);
const W = c.widthTiles;
for (const [name, x0, y0, x1, y1] of [
  ['islet 322,740', 322, 740, 355, 756],
  ['headland 549,656', 549, 656, 573, 669],
  ['gannet N', 65, 566, 164, 600],
]) {
  let n = 0, wild = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = c.tiles[y * W + x];
    if (t !== S.T_FIELD && t !== S.T_TREES) continue;
    n++; if (wildAt(x, y)) wild++;
  }
  console.log(name, 'country tiles', n, 'wildAt says wood on', wild, `(${(100 * wild / n).toFixed(1)}%)`);
}
