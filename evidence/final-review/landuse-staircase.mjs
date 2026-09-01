/* Count axis-aligned tile staircase on LAND-USE boundaries — the ones no
 * mapAudit signature scans. built-staircase scans built edges (quay, deck,
 * building frontage). This asks the same question of TREES/PARK vs open
 * ground, which is what an islet or a wood shows the player.
 *
 * A "tread" is a run of >=3 tiles of boundary that is perfectly axis-aligned.
 * A curve drawn on a tile grid produces treads of 1-2; a raw tile-plane
 * boundary produces long ones. Control below asks the same of the COASTLINE,
 * which IS curve-drawn, so the two numbers are directly comparable.
 */
import { readFileSync } from 'node:fs';
import { decodeBakedCity, T_TREES, T_PARK, T_WATER, T_SAND } from 'shared';
const s = readFileSync('shared/src/world/city.data.ts','utf8');
const a = s.indexOf('"'), b = s.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(s.slice(a,b+1))));
const W = city.widthTiles, H = city.heightTiles, t = city.tiles;
const at = (x,y) => (x<0||y<0||x>=W||y>=H) ? -1 : t[y*W+x];

function treads(isIn, isOut, label) {
  // horizontal boundary runs: tile is `in`, tile below is `out`
  const runs = [];
  for (let y=0;y<H-1;y++){
    let run=0;
    for (let x=0;x<W;x++){
      const on = isIn(at(x,y)) && isOut(at(x,y+1));
      if (on) run++; else { if (run>=3) runs.push(run); run=0; }
    }
    if (run>=3) runs.push(run);
  }
  for (let x=0;x<W-1;x++){
    let run=0;
    for (let y=0;y<H;y++){
      const on = isIn(at(x,y)) && isOut(at(x+1,y));
      if (on) run++; else { if (run>=3) runs.push(run); run=0; }
    }
    if (run>=3) runs.push(run);
  }
  const tiles = runs.reduce((s,r)=>s+r,0);
  const longest = runs.length ? Math.max(...runs) : 0;
  console.log(`  ${label.padEnd(34)} runs>=3: ${String(runs.length).padStart(5)}   tiles: ${String(tiles).padStart(6)}   longest: ${longest}`);
  return {runs:runs.length, tiles, longest};
}

const wood = v => v===T_TREES || v===T_PARK;
const openGround = v => v>=0 && !wood(v) && v!==T_WATER && v!==T_SAND;
const water = v => v===T_WATER;
const land = v => v>=0 && v!==T_WATER;

console.log('\n  axis-aligned boundary runs of 3+ tiles\n');
const lu = treads(wood, openGround, 'woodland vs open ground');
const co = treads(land, water, 'CONTROL: coastline (curve-drawn)');
console.log(`\n  ratio, land-use tiles per coastline tile: ${(lu.tiles/co.tiles).toFixed(2)}x`);
console.log('  The coastline is drawn from a vector chain, so its number is the');
console.log('  floor a curve-drawn boundary produces on this grid. Land use has no');
console.log('  such chain, and no mapAudit signature scans it.\n');
