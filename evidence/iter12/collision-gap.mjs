/* Where the DRAWN wood and the COLLIDABLE wood now disagree, and by how much.
 *
 * `T_TREES` is a wall: `collide.ts` blocks on the tile, `volume.ts` gives the
 * canopy a solid span to `TREE_Z`, and neither has been touched. §46 changes
 * only what is painted, so the drawn edge is a chord and the wall is still the
 * square — the same class of gap iteration 8 left for the bridge deck and
 * filed as WORLDGEN.md §45.5 rather than hiding.
 *
 * This states the size of it and its DIRECTION, per side, in tiles of area.
 *
 *   node evidence/iter12/collision-gap.mjs
 */
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity, buildWoodCut, shoreHalf, T_TREES,
} from '../../shared/dist/index.js';

const src = readFileSync('shared/src/world/city.data.ts', 'utf8');
const q0 = src.indexOf('"'), q1 = src.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(src.slice(q0, q1 + 1))));
const W = city.widthTiles;
const cut = buildWoodCut(city.tiles, W, city.heightTiles);

const area = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
};

let solidNotDrawn = 0; // wall you cannot see: tree tile, half of it painted meadow
let drawnNotSolid = 0; // canopy you can walk through: open tile, half painted wood
let treeTiles = 0, openTiles = 0, worst = 0;
for (const [idx, seg] of cut) {
  const wood = area(shoreHalf(seg, false));
  if ((city.tiles[idx] ?? 0) === T_TREES) {
    treeTiles++;
    solidNotDrawn += 1 - wood;
    if (1 - wood > worst) worst = 1 - wood;
  } else {
    openTiles++;
    drawnNotSolid += wood;
    if (wood > worst) worst = wood;
  }
}

console.log(`\n  wood curve crosses ${cut.size} tiles: ${treeTiles} wooded, ${openTiles} open\n`);
console.log(`  SOLID BUT NOT DRAWN  ${solidNotDrawn.toFixed(1)} tiles of area`);
console.log(`    a wooded tile whose painted half is meadow. You are stopped by a wall`);
console.log(`    the picture does not show. This is the SAFE direction: the wood was`);
console.log(`    already a wall over the whole square and still is.\n`);
console.log(`  DRAWN BUT NOT SOLID  ${drawnNotSolid.toFixed(1)} tiles of area`);
console.log(`    an open tile whose painted half is canopy. You walk under an overhang.`);
console.log(`    The canopy already overhung: \`bevel.ts\`'s [T_WATER, T_TREES] pair is`);
console.log(`    one-directional for exactly this reason ("the canopy simply overhangs`);
console.log(`    the cut"), so this is the shape the map already had at the waterline.\n`);
console.log(`  worst single tile: ${(100 * worst).toFixed(1)}% of one square (0.5 tile = half a tile of error)`);
console.log(`  total wood area, for scale: ${city.tiles.reduce((s, t) => s + (t === T_TREES ? 1 : 0), 0)} tiles\n`);
