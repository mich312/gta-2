// The exact figures the regression test in `server/test/shippedCity.test.ts`
// asserts, on whichever asset is named — so the test's controls are quoted
// from a run rather than remembered.
//
//   node evidence/iter8-country/measure-test-figures.mjs /tmp/baseline.city.data.ts
//   node evidence/iter8-country/measure-test-figures.mjs shared/src/world/city.data.ts
//
// Same shape as the test: rural by the district POLYGON (not the flood), a
// block's bounding BOX for "covered", `hedgerowAt` for the rule, and the
// bake's own mouth guard for the tiles it refuses on purpose.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const B = await import(`file://${R}/shared/dist/world/buildings.js`);
const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
const { T_FIELD, T_TREES, T_ROAD, T_BRIDGE, pointInPoly } = S;

const p = process.argv[2] ?? `${R}/shared/src/world/city.data.ts`;
const src = readFileSync(p, 'utf8');
const city = S.decodeBakedCity(
  JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
);
const W = city.widthTiles;
const H = city.heightTiles;
const t = city.tiles;

const rural = new Uint8Array(W * H);
for (const d of plan.districts) {
  if (d.rural !== true) continue;
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (rural[ty * W + tx] === 0 && pointInPoly(d.area, tx + 0.5, ty + 0.5)) rural[ty * W + tx] = 1;
    }
  }
}
const covered = new Uint8Array(W * H);
for (const b of city.blocks) {
  for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) covered[y * W + x] = 1;
  }
}
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : t[y * W + x]);
const roadWithin3 = (x, y, dx, dy) => {
  for (let k = 1; k <= 3; k++) {
    const v = at(x + dx * k, y + dy * k);
    if (v === T_ROAD || v === T_BRIDGE) return true;
  }
  return false;
};
const acrossAMouth = (x, y) =>
  (roadWithin3(x, y, 1, 0) && roadWithin3(x, y, -1, 0)) ||
  (roadWithin3(x, y, 0, 1) && roadWithin3(x, y, 0, -1));

let missing = 0;
let mouth = 0;
let planted = 0;
for (let i = 0; i < W * H; i++) {
  if (rural[i] === 0 || covered[i] === 1) continue;
  const x = i % W;
  const y = (i - x) / W;
  if (t[i] === T_TREES) {
    // A tree standing where the hedgerow rule would put one if the ground
    // were still bare: the run this pass planted. Counted so a rule that
    // silently stopped firing cannot pass the test by finding nothing to
    // miss.
    const bare = t.slice(i, i + 1);
    t[i] = T_FIELD;
    if (B.hedgerowAt(t, W, H, x, y)) planted++;
    t[i] = bare[0];
    continue;
  }
  if (t[i] !== T_FIELD) continue;
  if (!B.hedgerowAt(t, W, H, x, y)) continue;
  missing++;
  if (acrossAMouth(x, y)) mouth++;
}
console.log(
  `${p}\n  hedgerow positions on rural country outside every block:` +
    `\n    planted   ${planted}` +
    `\n    missing   ${missing}, of which ${mouth} are refused across a held-short mouth` +
    `\n    UNEXPLAINED ${missing - mouth}`,
);
