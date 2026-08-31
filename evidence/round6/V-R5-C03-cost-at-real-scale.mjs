// Clean, uncontended: hold peds at the real target, vary ONLY the extra parked cars.
import { createGameState, generateCity, NULL_INPUT, step, TILE_SIZE, areaScale } from '/home/user/gta-2/shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '/home/user/gta-2/server/dist/tuning.js';
loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const EXTRA = Number(process.argv[2]);        // leaked cars on top of the session fleet
const NPEDS = Number(process.argv[3]);
const TICKS = Number(process.argv[4] ?? 2400);
function kerbRank(gx, gy){let h=0x5f3a71c9^Math.imul(gx,374761393)^Math.imul(gy,668265263);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296;}
let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
const cmds = []; let nid = 500000;
const ranked = map.parkingSpots.map((s)=>({s,k:kerbRank(Math.floor(s.x/TILE_SIZE),Math.floor(s.y/TILE_SIZE))})).sort((a,b)=>a.k-b.k);
const parked = ranked.slice(0, Math.round(48*areaScale(map))).map(r=>r.s).filter(s=>s.crosswise!==true)
  .filter(s=>!map.vehicleHomes.some(h=>Math.abs(h.x-s.x)<48&&Math.abs(h.y-s.y)<48));
for (const s of parked) cmds.push({type:'spawnVehicle',vehicleId:nid++,kind:s.kind,x:s.x,y:s.y,heading:s.heading});
for (const h of map.vehicleHomes) cmds.push({type:'spawnVehicle',vehicleId:nid++,kind:h.kind,x:h.x,y:h.y,heading:h.heading});
for (const b of map.boatSpawns) cmds.push({type:'spawnVehicle',vehicleId:nid++,kind:'boat',x:b.x,y:b.y,heading:b.heading});
// the leaked stock: further kerbside spots, the places culled cars end up
const rest = ranked.slice(Math.round(48*areaScale(map))).map(r=>r.s);
for (let i=0;i<EXTRA;i++){const s=rest[i%rest.length];cmds.push({type:'spawnVehicle',vehicleId:nid++,kind:'car',x:s.x,y:s.y,heading:s.heading});}
const stride = Math.max(1, Math.floor(map.pedSpawns.length / NPEDS));
for (let i=0,n=0;i<map.pedSpawns.length&&n<NPEDS;i+=stride,n++){const s=map.pedSpawns[i];cmds.push({type:'spawnPed',pedId:nid++,x:s.x,y:s.y});}
state = step(state, {}, cmds, map);
const v0 = state.vehicles.ids.length, p0 = state.peds.ids.length;
for (let i=0;i<300;i++){state.players.byId[1].health=1e6;state = step(state,{1:{...NULL_INPUT,seq:i+2,tick:i}},[],map);}
const t0=Date.now();
for (let i=0;i<TICKS;i++){state.players.byId[1].health=1e6;state = step(state,{1:{...NULL_INPUT,seq:i+400,tick:i}},[],map);}
console.log(`seeded vehicles=${v0} peds=${p0} -> ${state.vehicles.ids.length}/${state.peds.ids.length}   ${((Date.now()-t0)/TICKS*1000).toFixed(0)} ms/1000 ticks`);
