// Attribution for `built-staircase`: re-derive the 24 edges exactly as
// mapAudit does, then characterise EVERY step face independently of the
// detector's own summary — which curve layer (if any) covers it, and what
// tile sits on the far side.
//
// Run: node evidence/iter7/attribute.mjs
import { loadBake, NEW, S } from './lib.mjs';
const { shoreChains,
  T_BANK, T_BRIDGE, T_BUILDING, T_FIELD, T_FLOOR, T_LOT, T_PARK, T_RAMP,
  T_ROAD, T_RUNWAY, T_SAND, T_SIDEWALK, T_TREES, T_WATER } = S;

const NAME = {
  [T_WATER]:'WATER',[T_SAND]:'SAND',[T_BANK]:'BANK',[T_FIELD]:'FIELD',[T_PARK]:'PARK',
  [T_TREES]:'TREES',[T_ROAD]:'ROAD',[T_SIDEWALK]:'SIDEWALK',[T_BUILDING]:'BUILDING',
  [T_FLOOR]:'FLOOR',[T_LOT]:'LOT',[T_BRIDGE]:'BRIDGE',[T_RAMP]:'RAMP',[T_RUNWAY]:'RUNWAY',
};

const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const at = (x,y) => (x<0||y<0||x>=W||y>=H) ? T_WATER : tiles[y*W+x];

const coast = shoreChains(city.shores, W, H);
const band  = shoreChains(city.banks,  W, H);

function components(mask) {
  const seen = new Uint8Array(W*H), out = [];
  const st = new Int32Array(W*H);
  for (let i=0;i<W*H;i++) {
    if (mask[i]!==1||seen[i]) continue;
    let n=0; st[n++]=i; seen[i]=1; const bag=[];
    while(n>0){ const j=st[--n]; bag.push(j);
      const x=j%W,y=(j/W)|0;
      const nb=[[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
      for(const [nx,ny] of nb){ if(nx<0||ny<0||nx>=W||ny>=H)continue;
        const k=ny*W+nx; if(mask[k]===1&&!seen[k]){seen[k]=1;st[n++]=k;} } }
    out.push(bag);
  }
  return out;
}
function bbox(bag){ let x0=1e9,y0=1e9,x1=-1,y1=-1;
  for(const i of bag){const x=i%W,y=(i/W)|0; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;}
  return {x0,y0,x1,y1}; }

const minSpan = 16; // GATES.minSpan — confirmed below against the audit output
const KINDS = [[T_BRIDGE,'bridge deck'],[T_BANK,'quay'],[T_LOT,'yard'],[T_RUNWAY,'runway']];
const found = [];
for (const [kind,label] of KINDS) {
  const mask = new Uint8Array(W*H);
  for (let i=0;i<tiles.length;i++) mask[i] = tiles[i]===kind?1:0;
  for (const bag of components(mask)) {
    if (bag.length<60) continue;
    const b = bbox(bag), inBag = new Set(bag);
    for (const byColumn of [true,false]) {
      const n = byColumn ? b.x1-b.x0+1 : b.y1-b.y0+1;
      const m = byColumn ? b.y1-b.y0+1 : b.x1-b.x0+1;
      if (n<minSpan) continue;
      for (const side of [0,1]) {
        const prof = new Int32Array(n).fill(-1);
        for (let p=0;p<n;p++) for (let q=0;q<m;q++) {
          const qq = side===0?q:m-1-q;
          const x = byColumn ? b.x0+p : b.x0+qq;
          const y = byColumn ? b.y0+qq : b.y0+p;
          if (inBag.has(y*W+x)) { prof[p] = byColumn?y:x; break; }
        }
        const treads=[]; let p=0;
        while(p<n){ if(prof[p]<0){p++;continue;} let e=p; while(e<n&&prof[e]===prof[p])e++;
          treads.push({at:p,len:e-p,v:prof[p]}); p=e; }
        let i=0;
        while(i<treads.length){ let j=i,dir=0;
          while(j+1<treads.length){ const t0=treads[j],t1=treads[j+1];
            if(t1.at!==t0.at+t0.len)break;
            if(t0.len<2||t0.len>10||t1.len<2||t1.len>10)break;
            const step=t1.v-t0.v; if(Math.abs(step)!==1)break;
            if(dir===0)dir=step; else if(step!==dir)break; j++; }
          const first=treads[i], last=treads[j];
          const span=last.at+last.len-first.at, count=j-i+1;
          if(count>=4&&span>=minSpan){
            // Every profile position's outward face, characterised.
            const tally = {};
            let faces=0, dissolvedAny=0, coastOnly=0, bandOnly=0, both=0;
            for(let q=first.at;q<first.at+span;q++){
              const v=prof[q]; if(v<0)continue;
              const st = side===0?-1:1;
              const x = byColumn ? b.x0+q : v;
              const y = byColumn ? v : b.y0+q;
              const ox = byColumn ? x : x+st;
              const oy = byColumn ? y+st : y;
              const ot = at(ox,oy);
              tally[NAME[ot]??ot] = (tally[NAME[ot]??ot]||0)+1;
              if(ot!==T_WATER) continue;
              faces++;
              const c = coast.has(y*W+x)||coast.has(oy*W+ox);
              const bd = band.has(y*W+x)||band.has(oy*W+ox);
              if(c&&bd) both++; else if(c) coastOnly++; else if(bd) bandOnly++;
              if(c||bd) dissolvedAny++;
            }
            const meanTread=span/count;
            const midP=first.at+span/2;
            const mx = byColumn ? b.x0+midP : (first.v+last.v)/2;
            const my = byColumn ? (first.v+last.v)/2 : b.y0+midP;
            found.push({label,mx,my,span,count,meanTread,rank:span*meanTread,
              mag:span-count,faces,dissolvedAny,coastOnly,bandOnly,both,tally,
              byColumn,side});
          }
          i=j+1;
        }
      }
    }
  }
}
found.sort((p,q)=>q.rank-p.rank);
const kept=[];
const cropW=(s)=>s;
for(const f of found){
  // dedup uses the CROP coords; approximate with midpoint, same 12-tile rule
  if(kept.some(k=>Math.abs(k.mx-f.mx)<=12&&Math.abs(k.my-f.my)<=12)) continue;
  kept.push(f);
}
console.log(`re-derived ${kept.length} findings (audit reports 24)`);
console.log('');
let i=0;
for(const f of kept){
  i++;
  const far = Object.entries(f.tally).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join(' ');
  console.log(
    `${String(i).padStart(2)} ${f.label.padEnd(12)} at ${Math.round(f.mx)},${Math.round(f.my)}`.padEnd(40) +
    ` m=${String(f.mag).padStart(3)} span=${String(f.span).padStart(3)} tread=${f.meanTread.toFixed(1)}` +
    ` | waterfaces=${String(f.faces).padStart(3)} coastOnly=${String(f.coastOnly).padStart(3)}` +
    ` bandOnly=${String(f.bandOnly).padStart(3)} both=${String(f.both).padStart(3)}` +
    ` undissolved=${String(f.faces-f.dissolvedAny).padStart(3)} | far side: ${far}`);
}
const sum=(k)=>kept.reduce((s,f)=>s+f[k],0);
console.log('');
console.log(`TOTALS  mag=${sum('mag')} waterfaces=${sum('faces')} coastOnly=${sum('coastOnly')} bandOnly=${sum('bandOnly')} both=${sum('both')} undissolved=${sum('faces')-sum('dissolvedAny')}`);
