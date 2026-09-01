// Does the countryside agree with the wildness field, inside blocks and out?
//
//   node evidence/iter8-country/measure-field-agreement.mjs [city.data.ts ...]
//
// The rural fill's ONE rule is `fbm(WILD_SEED, x/22, y/22) >= 0.52`: wood
// where the field says wood, meadow where it says meadow. `fillBlock` applies
// it inside a block; the orphan pass (bake.ts, iteration 3) applies it to
// rural country no block covers. If both do, then "the ground outside the
// blocks was never asked what it is" is false, and a bald patch outside a
// block is the field's answer rather than a missing question.
//
// So this asks the field directly, and reports agreement on each side of the
// block boundary. Tiles the fill deliberately declines are excluded and
// counted separately: within one tile of a road or a bridge (the verge that
// keeps a lane drivable at full width) and within one tile of water (the
// shore pass's cliff, which is not the fill's to move).
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const F = await import(`file://${R}/shared/dist/world/fields.js`);
const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
const WILD_SEED = 0x7009d5;
const wildAt = (x, y) => F.fbm(WILD_SEED, x / 22, y / 22) >= 0.52;
const { T_FIELD, T_TREES, T_WATER, T_ROAD, T_BRIDGE, pointInPoly } = S;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function load(p) {
  const src = readFileSync(p, 'utf8');
  return S.decodeBakedCity(
    JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
  );
}

function ownerPlane(city) {
  const { widthTiles: W, heightTiles: H, tiles } = city;
  const owner = new Int16Array(W * H).fill(-1);
  for (const [di, d] of plan.districts.entries()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of d.area) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
      for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
        if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
      }
    }
  }
  const bag = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && tiles[i] !== T_WATER) bag.push(i);
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q];
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (tiles[j] === T_WATER || owner[j] >= 0) continue;
      owner[j] = owner[i];
      bag.push(j);
    }
  }
  return owner;
}

export function report(p) {
  const city = load(p);
  const { widthTiles: W, heightTiles: H, tiles } = city;
  const owner = ownerPlane(city);
  const covered = new Uint8Array(W * H);
  for (const b of city.blocks) {
    for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
      for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) covered[y * W + x] = 1;
    }
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
  const near = (x, y, t) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === t) return true;
    }
    return false;
  };
  const side = [
    { name: 'inside a rural block', land: 0, wood: 0, wild: 0, agree: 0, held: 0 },
    { name: 'outside every block ', land: 0, wood: 0, wild: 0, agree: 0, held: 0 },
  ];
  for (let i = 0; i < W * H; i++) {
    const t = tiles[i];
    if (t !== T_FIELD && t !== T_TREES) continue;
    const d = owner[i];
    if (d < 0 || plan.districts[d].rural !== true) continue;
    const x = i % W;
    const y = (i - x) / W;
    const s = side[covered[i] === 1 ? 0 : 1];
    // The fill declines these on purpose; they are not evidence either way.
    if (near(x, y, T_ROAD) || near(x, y, T_BRIDGE) || near(x, y, T_WATER)) {
      s.held++;
      continue;
    }
    s.land++;
    if (t === T_TREES) s.wood++;
    if (wildAt(x, y)) s.wild++;
    if ((t === T_TREES) === wildAt(x, y)) s.agree++;
  }
  console.log(p);
  for (const s of side) {
    console.log(
      `  ${s.name}: ${String(s.land).padStart(6)} country tiles, ` +
        `wood ${((100 * s.wood) / s.land).toFixed(1)}%, ` +
        `field says wood ${((100 * s.wild) / s.land).toFixed(1)}%, ` +
        `AGREE ${((100 * s.agree) / s.land).toFixed(1)}% (${s.agree}/${s.land}), ` +
        `${s.held} held back at a verge`,
    );
  }
  return side;
}

if (process.argv.length > 2) for (const p of process.argv.slice(2)) report(p);
else report(`${R}/shared/src/world/city.data.ts`);
