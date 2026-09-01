// Open ground, on foot: `T_TREES` is collidable, so planting is a wall.
//
//   node evidence/iter8-country/measure-walkable.mjs OLD.city.data.ts NEW.city.data.ts
//
// The carriageway measurement (`evidence/iter5/measure-reachability.mjs`)
// cannot see this: a wood across a meadow severs ground a pedestrian uses and
// leaves every road tile exactly where it was. Four-connected pieces of
// everything that is not building, water or canopy — the rule `cityCheck`
// walks, and the same rule the bake's own ride-through guard is measured on.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const S = await import(`file://${R}/shared/dist/index.js`);
const { T_BUILDING, T_WATER, T_TREES } = S;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function pieces(p) {
  const src = readFileSync(p, 'utf8');
  const city = S.decodeBakedCity(
    JSON.parse(JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1))),
  );
  const W = city.widthTiles;
  const H = city.heightTiles;
  const t = city.tiles;
  const open = (i) => t[i] !== T_BUILDING && t[i] !== T_WATER && t[i] !== T_TREES;
  const lab = new Int32Array(W * H).fill(-1);
  const sizes = [];
  let id = 0;
  for (let s = 0; s < W * H; s++) {
    if (lab[s] >= 0 || !open(s)) continue;
    const bag = [s];
    lab[s] = id;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q];
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (lab[j] >= 0 || !open(j)) continue;
        lab[j] = id;
        bag.push(j);
      }
    }
    sizes.push(bag.length);
    id++;
  }
  sizes.sort((a, b) => b - a);
  const total = sizes.reduce((a, b) => a + b, 0);
  console.log(
    `${p}\n  ${total} open tiles in ${sizes.length} piece(s); largest ${sizes
      .slice(0, 6)
      .join(', ')}${sizes.length > 6 ? ', ...' : ''}`,
  );
  console.log(`  pieces of 20 tiles or more: ${sizes.filter((n) => n >= 20).length}`);
  return sizes;
}

const a = pieces(process.argv[2]);
const b = pieces(process.argv[3]);
console.log(
  a.length === b.length && a[0] === b[0]
    ? 'SAME number of pieces and same largest piece: nothing was walled off.'
    : `PIECES MOVED ${a.length} -> ${b.length}, largest ${a[0]} -> ${b[0]}`,
);
