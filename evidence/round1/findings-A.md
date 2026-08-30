# Lens A — worldgen and the map — round 1

Ground truth taken as given at `1469611` (build clean, 943 tests green,
`citybake --check` 0 errors). Nothing below is a failing test: every one of
these passes the whole suite and the checker today, which is the point.

Tile probes run from `/home/user/gta-2/server` after `pnpm build`, so that
`shared` resolves. Renders were written to `evidence/round1/`.

---

## Kelvin Bridge and Marsh Causeway bake to nothing — two of the three named strait crossings do not exist, and no gate refuses the plan
severity: blocking
lens: A
where: `shared/data/city-plan.json` (roads "Kelvin Bridge", "Marsh Causeway"); `shared/src/world/layout.ts:2298-2356` (the no-piers pass in `trimBridges`); `server/src/tools/cityCheck.ts:42` (no rule for it); `evidence/round1/A-kelvin-bridge-missing.png`, `evidence/round1/A-marsh-causeway-missing.png`
evidence:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { generateCity, T_BRIDGE, T_WATER } from 'shared';
import { loadWorldgenParams } from './dist/tuning.js';
const m=generateCity(1,loadWorldgenParams()), W=m.widthTiles, t=m.tiles;
const box=(x0,y0,x1,y1)=>{let n=0;for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(t[y*W+x]===T_BRIDGE)n++;return n;};
const col=x=>{const r=[];let c=null;for(let y=260;y<768;y++){const w=t[y*W+x]===T_WATER;if(!c||c.w!==w){c={w,a:y,b:y};r.push(c);}else c.b=y;}return r.filter(v=>v.w).map(v=>v.a+'-'+v.b).join(' ');};
console.log('bridge tiles around Kelvin Bridge:', box(420,340,490,420), '| water down x=452:', col(452));
console.log('bridge tiles around Marsh Causeway:', box(530,260,610,400), '| water down x=566:', col(566));
"
```
printed
```
bridge tiles around Kelvin Bridge: 0 | water down x=452: 363-414 686-767
bridge tiles around Marsh Causeway: 0 | water down x=566: 276-370 664-767
```
Zero deck tiles at either crossing. Two different authoring slips, both
swallowed silently:

- **Kelvin Bridge** — polyline `[[452,288],[452,400]]`, `bridges:true`, noted
  in the plan as *"The signature span … the shortest way between the two
  halves of the city."* The strait at x=452 is water y=363..414; the far bank
  is **y=415**. The line stops at **y=400, fifteen tiles short**. `lay()`
  decks it (land is within `maxBridgeSpan` ahead); the no-causeway pass keeps
  it (widest shortest-span on the centreline is 52 against a limit of 72);
  the no-piers pass then finds a deck with **one** landfall and reverts the
  whole deck to sea. Fifteen tiles of polyline is the entire defect.
- **Marsh Causeway** — polyline `[[566,292],[572,396]]`, `bridges:true`. Its
  north end is **already 16 tiles out in open water** (land at x=566 ends at
  y=275), and the bay is 95-100 tiles wide against `maxBridgeSpan: 72`, so as
  drawn it can never be built at all.

`parseCityPlan` accepts both, `bakeCity` bakes both, `checkCity` reports zero
errors *and* zero warnings, `shippedCity.test.ts` is green, and
`city.test.ts`'s bridge test only asks that the bridges which *do* exist are
short enough. Nothing anywhere asks whether a `bridges:true` road landed.
repro:
```
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --crop=436,336,44 --scale=16 --out=evidence/round1/A-kelvin-bridge-missing.png
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --crop=520,260,140 --out=evidence/round1/A-marsh-causeway-missing.png
```
why it matters: `A-kelvin-bridge-missing.png` shows what the player gets — a
four-lane avenue with a centre line running south out of the city, ending in
a rounded cap on bare ground at the water's edge, with a disconnected stub on
a spit across the channel. WORLDGEN.md §12.3 promises eight crossings and
says that on an archipelago *"which bridge"* is the interesting question; the
city ships with six, and crossing the Kelvin from the east means driving 115
tiles west to Old Bridge.
prior art: WORLDGEN.md §23.1 records the no-piers pass removing this exact
deck ("Kelvin Bridge … left the north bank, ran 47 tiles out and stopped 14
tiles short") and files it as a **fix**. Promote: the safety fix was right,
but the plan behind it was never corrected, §12.3 still claims the crossing,
and the gate that would have caught both roads — *a `bridges:true` road must
reach land on both sides* — does not exist.

---

## Hollis Creek is crossed nowhere along its length: both east-west arterials of the southern city dead-end at its banks
severity: significant
lens: A
where: `shared/data/city-plan.json` — `geography.rivers[1]` "Hollis Creek", and roads "The Esplanade" and "Longacre Road", both carrying `bridges: false`; `shared/src/world/layout.ts:641-651` (`lay()` returns without decking when `along` is null); `evidence/round1/A-hollis-creek-uncrossed.png`
evidence:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { generateCity, T_BRIDGE, T_ROAD } from 'shared';
import { loadWorldgenParams } from './dist/tuning.js';
const m=generateCity(1,loadWorldgenParams()),W=m.widthTiles,H=m.heightTiles,t=m.tiles;
let b=0; for(let y=410;y<=600;y++)for(let x=290;x<=410;x++) if(t[y*W+x]===T_BRIDGE) b++;
const ok=i=>t[i]===T_ROAD||t[i]===T_BRIDGE;
const bfs=(sx,sy)=>{const d=new Int32Array(W*H).fill(-1);const s=sy*W+sx;d[s]=0;const q=[s];
 for(let h=0;h<q.length;h++){const i=q[h],x=i%W,y=(i-x)/W;
  for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H)continue;const j=ny*W+nx;if(d[j]>=0||!ok(j))continue;d[j]=d[i]+1;q.push(j);}}return d;};
console.log('bridge tiles anywhere on Hollis Creek:', b);
console.log('Esplanade banks 15 tiles apart -> road distance', bfs(391,428)[428*W+406]);
console.log('Longacre banks 6 tiles apart  -> road distance', bfs(330,531)[531*W+336]);
"
```
printed
```
bridge tiles anywhere on Hollis Creek: 0
Esplanade banks 15 tiles apart -> road distance 453
Longacre banks 6 tiles apart  -> road distance 124
```
Hollis Creek is a 130-tile tidal inlet, 3-10 tiles wide, running from the
Kelvin strait into the southern island. Both of the plan's east-west
arterials cross it on paper and both carry `bridges: false`, so the carve
simply stops on each bank. `A-hollis-creek-uncrossed.png` shows five streets
on the west bank and three on the east, all ending in rounded caps facing
each other across the water, with no deck anywhere in the frame.
repro:
```
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --crop=372,408,44 --scale=16 --out=evidence/round1/A-hollis-creek-uncrossed.png
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --crop=280,470,140 --out=evidence/round1/A-creek-wide.png
```
why it matters: a player on The Esplanade, watching the road continue fifteen
tiles away across the water, has to drive 453 tiles to reach it. Every chase,
ambulance run and route plan in Sunridge inherits the detour, and no checker
can see it because the street network is still one piece round the creek head.
prior art: none found — "Hollis" and "Longacre" appear nowhere in `GAPS.md`,
`BUGS.md`, WORLDGEN.md §23.3 or `REVIEW-WORLDGEN.md`; the only doc mention of
the creek is the plan's own geography entry.

---

## The Docks' contour fabric lays no cross streets: five blocks run 147-161 tiles unbroken against an authored pitch of 24
severity: significant
lens: A
where: `shared/data/city-plan.json` district "The Docks" (`street.pitchX 28, pitchY 24, fabric contour`); the contour weave in `shared/src/world/layout.ts` (`weaveFabrics`); `evidence/round1/A-docks.png`
evidence:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { generateCity, pointInPoly } from 'shared';
import { loadWorldgenParams } from './dist/tuning.js';
import { readFileSync } from 'node:fs';
const plan=JSON.parse(readFileSync('../shared/data/city-plan.json','utf8'));
const m=generateCity(1,loadWorldgenParams());
const own=(x,y)=>{for(let i=plan.districts.length-1;i>=0;i--) if(pointInPoly(plan.districts[i].area,x+0.5,y+0.5)) return plan.districts[i].name; return null;};
for(const n of ['The Docks','Beachfront','The Terraces']){
 const bs=m.blocks.filter(b=>own(b.x+b.w/2,b.y+b.h/2)===n).sort((a,b)=>b.w*b.h-a.w*a.h);
 console.log(n+': '+bs.length+' blocks; biggest '+bs.slice(0,5).map(b=>b.w+'x'+b.h).join(', '));
}
"
```
printed
```
The Docks: 12 blocks; biggest 27x158, 26x152, 21x161, 21x147, 15x156
Beachfront: 120 blocks; biggest 10x29, 11x20, 11x19, 10x20, 10x19
The Terraces: 144 blocks; biggest 21x35, 20x34, 11x54, 11x31, 19x14
```
The contour fabric is specified (WORLDGEN.md §13.4) as *"streets along
iso-distances of the water field at the borough pitch, **connectors along the
gradient**"*. In the other two contour boroughs the connectors are there. In
The Docks they are absent: 18,184 tiles of land carved into **twelve** blocks,
median area 1,760, against a 28x24 pitch whose cell is about 437. The
transect confirms it — each of the four longitudinal streets has an 83-93
tile stretch with no turning at all:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { generateCity, T_ROAD, T_BRIDGE } from 'shared';
import { loadWorldgenParams } from './dist/tuning.js';
const m=generateCity(1,loadWorldgenParams()),W=m.widthTiles,t=m.tiles;
const road=(x,y)=>{const v=t[y*W+x];return v===T_ROAD||v===T_BRIDGE;};
for(const [x,lo,hi] of [[74,252,414],[99,270,415],[124,250,414],[148,250,410]]){
 let l=x; while(road(l-1,(lo+hi)>>1)) l--; let r=x; while(road(r+1,(lo+hi)>>1)) r++;
 const ys=[]; for(let y=lo;y<=hi;y++) if(road(l-2,y)||road(r+2,y)) ys.push(y);
 const g=[]; for(const y of ys){ if(g.length&&y-g[g.length-1][1]<=4) g[g.length-1][1]=y; else g.push([y,y]); }
 let mx=0,p=lo; for(const q of g){mx=Math.max(mx,q[0]-p);p=q[1];} mx=Math.max(mx,hi-p);
 console.log('street x='+l+'-'+r+': '+g.length+' turnings, longest stretch with none = '+mx+' tiles');
}
"
```
printed `5 turnings / 86`, `3 / 93`, `3 / 85`, `3 / 83`.
repro:
```
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --crop=20,240,180 --out=evidence/round1/A-docks.png
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --stats --out=evidence/round1/A-city.png   # "The Docks … 12 blocks  medblk 1760"
```
why it matters: the whole industrial island reads as one khaki field with
four parallel roads through it and nothing to turn into for 1,400 world
units. A chase there is a straight line, and the borough looks nothing like
the grid of yards the plan draws.
prior art: none found. WORLDGEN.md §13.6 step 4 records The Docks becoming a
`contour` borough and pins only the shore-to-street distance it was chosen
for (p50 3, p95 3 — met); no doc measures block size or connector spacing,
and `city.test.ts` carries no block-size invariant.

---

## known: a public street still crosses Marsh End Airfield's runway, and both huts still stand on their slabs
severity: significant
lens: A
where: `shared/data/city-plan.json` landmarks "Marsh End Airfield" `[504,599,30,7]` and "Gannet Rock Strip" `[76,640,30,7]`; `server/src/tools/cityCheck.ts:42` (no runway rule); `evidence/round1/A-runway-crossed.png`
evidence:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { generateCity, T_ROAD, T_BRIDGE, T_BUILDING, T_RUNWAY } from 'shared';
import { loadWorldgenParams } from './dist/tuning.js';
import { readFileSync } from 'node:fs';
const plan=JSON.parse(readFileSync('../shared/data/city-plan.json','utf8'));
const m=generateCity(1,loadWorldgenParams()),W=m.widthTiles,t=m.tiles;
for(const l of plan.landmarks.filter(l=>l.kind==='airstrip')){
 const [x,y,w,h]=l.rect; let road=0,bld=0,run=0; const cols=new Set();
 for(let ty=y;ty<y+h;ty++)for(let tx=x;tx<x+w;tx++){const v=t[ty*W+tx];
  if(v===T_ROAD||v===T_BRIDGE){road++;cols.add(tx);} if(v===T_BUILDING)bld++; if(v===T_RUNWAY)run++;}
 console.log(l.name,'road',road,'in columns',[...cols].join(','),'| building',bld,'| runway',run);
}
"
```
printed
```
Marsh End Airfield road 14 in columns 519,520 | building 9 | runway 187
Gannet Rock Strip road 0 in columns  | building 9 | runway 201
```
Fourteen `T_ROAD` tiles — a two-tile street, the full seven-tile depth of the
rect — cut the Marsh End strip in half at x=519/520, and nine tiles of hut
stand on each slab. These are `T_ROAD` inside the drawn rect, not the apron,
after wave 2.3's apron fix. Side effect of the hut: `runwayCentreRow`
(`client/src/render/tiles.ts:160`) walks to the strip's edges per column, so
the four columns the hut shortens get a different centre row and the painted
centreline jogs a tile at x=507.
repro:
```
cd /home/user/gta-2 && node server/dist/tools/mapgen.js --crop=506,592,32,20 --scale=22 --out=evidence/round1/A-runway-crossed.png
```
why it matters: an aircraft landing at Marsh End touches down across a public
street, and from the air the city's only drivable airfield reads as two
tarmac slabs with a road between them.
prior art: `PLAN-WORLDGEN.md` wave **2.3** ("Marsh End's hut stands on the
runway slab and two streets cross the strip mid-length … reroute the two
crossing streets … and teach the checker a new warning: *no street tile
inside a runway rect*") and the closing line of `REVIEW-WORLDGEN.md` §2.1.
Promote: the wave's delivery note closes it with *"2.3's 'streets across the
runway' was the `T_RUNWAY` apron the whole time"*, and the census above shows
that diagnosis was wrong — the apron was one cause, the street is another and
is still there. The promised checker rule was never added, so nothing catches
it next time either.

---

## `checkCity`'s "has no road to it" does not look for a road
severity: nit
lens: A
where: `server/src/tools/cityCheck.ts:51-84` (the `label`/`seen` flood is built over `drivable` — everything but building, water and trees) and `server/src/tools/cityCheck.ts:225-243` (the landmark test reads `seen`, then reports "has no road to it")
evidence:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { CITY_DATA, decodeBakedCity, parseCityPlan, T_ROAD, T_BRIDGE, T_FIELD, TILE_SIZE } from 'shared';
import { checkCity } from './dist/tools/cityCheck.js';
import { readFileSync } from 'node:fs';
const plan=parseCityPlan(JSON.parse(readFileSync('../shared/data/city-plan.json','utf8')));
const city=decodeBakedCity(JSON.parse(CITY_DATA)), W=city.widthTiles;
const l=city.landmarks.find(l=>l.name==='Mercy General');
const dx=Math.floor(l.doorX/TILE_SIZE), dy=Math.floor(l.doorY/TILE_SIZE); let n=0;
for(let y=dy-12;y<=dy+12;y++)for(let x=dx-12;x<=dx+12;x++){const i=y*W+x,v=city.tiles[i];
 if(v===T_ROAD||v===T_BRIDGE){city.tiles[i]=T_FIELD;n++;}}
console.log('erased',n,'carriageway tiles around Mercy General; checkCity says:',
  JSON.stringify(checkCity(city,plan).map(p=>p.severity+': '+p.message)));
"
```
printed
```
erased 285 carriageway tiles around Mercy General; checkCity says: []
```
Every road within twelve tiles of the hospital door is gone and the checker
is silent, because the flood it consults is over open *ground*, not
carriageway. `shared/test/city.test.ts:170` does the honest version (searches
a 13x13 window for `T_ROAD`/`T_BRIDGE`), so the test suite is stricter than
the checker whose message claims the stronger property.
repro: the command above.
why it matters: `checkCity` is the one gate `citybake` and `plangen` share
and the thing `shippedCity.test.ts` pins the asset against. A plan edit that
walls a hospital off from the street network — an ambulance that can never
reach it — would bake, commit and ship with a green check.
prior art: none found. `REVIEW-WORLDGEN.md` §1.2's complaints about the
checker are about where it runs, not what it measures.

---

## `parseCityPlan` bounds-checks landmarks but not roads, rivers or district polygons, and accepts a zero-width road
severity: nit
lens: A
where: `shared/src/world/plan.ts:369-388` — roads reject only `width > MAX_CARRIAGEWAY`; there is no lower bound and no map-bounds test on `points`, while the landmark branch a few lines below does refuse `landmark … is outside the map`
evidence:
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { parseCityPlan } from 'shared';
import { readFileSync } from 'node:fs';
const raw=JSON.parse(readFileSync('../shared/data/city-plan.json','utf8'));
for(const [k,v] of Object.entries({
 'road width 0':  {...raw, roads:[...raw.roads,{name:'Zero',points:[[300,200],[400,200]],width:0}]},
 'road off map':  {...raw, roads:[...raw.roads,{name:'Off',points:[[300,200],[9000,-500]],width:4}]},
 'river off map': {...raw, geography:{...raw.geography, rivers:[...raw.geography.rivers,{name:'Styx',points:[[-500,-500],[9000,9000]],w0:4,w1:4,meander:0}]}},
 'district off map': {...raw, districts:[...raw.districts,{...raw.districts[0],name:'Ghost',area:[[-900,-900],[-800,-900],[-800,-800]]}]},
 'landmark off map': {...raw, landmarks:[...raw.landmarks,{kind:'lighthouse',name:'Way Out',rect:[5000,5000,3,3]}]},
})){ try{ parseCityPlan(v); console.log(k.padEnd(18),'ACCEPTED'); } catch(e){ console.log(k.padEnd(18),'refused:',e.message); } }
"
```
printed
```
road width 0       ACCEPTED
road off map       ACCEPTED
river off map      ACCEPTED
district off map   ACCEPTED
landmark off map   refused: city plan: landmark Way Out is outside the map
```
and `buildLayout` then completes normally on the first two (14.7 s and 16.2 s,
no throw, no message).
repro: the command above, then
```
cd /home/user/gta-2/server && node --input-type=module -e "
import { parseCityPlan, buildLayout } from 'shared'; import { readFileSync } from 'node:fs';
const raw=JSON.parse(readFileSync('../shared/data/city-plan.json','utf8'));
buildLayout(parseCityPlan({...raw, roads:[...raw.roads,{name:'Zero',points:[[300,200],[400,200]],width:0}]}));
console.log('baked a zero-width road without a word');
"
```
why it matters: `plan.ts`'s stated doctrine is that a bad plan fails at
authoring time with a message naming the fix. Four of the five slips above
cost the author a sixteen-second bake and a render to notice, and the road
cases are the same family as the two dead crossings in the first finding —
the plan holds geometry that cannot become a road and nothing says so.
prior art: none found.
