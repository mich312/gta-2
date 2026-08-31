import { generateCity, TILE_SIZE, T_WATER, T_BRIDGE } from '/home/user/gta-2/shared/dist/index.js';
import { loadWorldgenParams } from '/home/user/gta-2/server/dist/tuning.js';
const map = generateCity(1, loadWorldgenParams());
const W = map.widthTiles, H = map.heightTiles;
const nav = (i) => map.tiles[i] === T_WATER || map.tiles[i] === T_BRIDGE;
// 8-connected flood, to see whether a diagonal link joins pond to sea
const lab = new Int32Array(W*H).fill(-1);
const sizes = [];
const D8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
for (let s=0;s<W*H;s++){ if(!nav(s)||lab[s]>=0) continue; const id=sizes.length; let n=0; const st=[s]; lab[s]=id;
  while(st.length){ const i=st.pop(); n++; const x=i%W, y=(i-x)/W;
    for(const [dx,dy] of D8){ const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H) continue; const j=ny*W+nx; if(lab[j]>=0||!nav(j)) continue; lab[j]=id; st.push(j);} }
  sizes.push(n); }
const sea8 = lab[0];
console.log('8-connected components:', sizes.length, 'sea size', sizes[sea8]);
for (const [tx,ty] of [[502,56],[500,63],[298,646],[296,648],[297,649]]) {
  const id = lab[ty*W+tx];
  console.log(`boat ${tx},${ty}: 8-conn comp ${id} size ${sizes[id]} sameAsSea=${id===sea8}`);
}
// what tiles surround each pond component (unique tile ids on the 4-ring)
const names = {};
for (const k of Object.keys(await import('/home/user/gta-2/shared/dist/index.js'))) if (/^T_/.test(k)) names[(await import('/home/user/gta-2/shared/dist/index.js'))[k]] = k;
for (const seedId of new Set([lab[56*W+502], lab[646*W+298]])) {
  const border = new Map();
  let cnt=0;
  for (let i=0;i<W*H;i++) if (lab[i]===seedId){ cnt++; const x=i%W,y=(i-x)/W;
    for(const [dx,dy] of D8){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H)continue;const j=ny*W+nx; if(lab[j]===seedId)continue; const t=map.tiles[j]; border.set(t,(border.get(t)??0)+1);} }
  console.log(`comp ${seedId} size ${cnt} border:`, [...border].map(([t,c])=>`${names[t]??t}:${c}`).join(' '));
}
// district / park name at pond centres
const dn = map.districts ? map.districts : null;
console.log('has districts?', !!map.districts, Object.keys(map).filter(k=>/dist|park|land/i.test(k)));
