// Same gate, but the dismount happens on its own: drivePursuit's pull-up.
import { createGameState, generateCity, NULL_INPUT, step, getTuning } from '/home/user/gta-2/shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '/home/user/gta-2/server/dist/tuning.js';
const diff = process.argv[2] ?? 'hard';
loadSharedTuning(diff);
const map = generateCity(6006, loadWorldgenParams());
const t = getTuning().police;
let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
let seq = 2;
const tick = (heat) => {
  const me = state.players.byId[1];
  me.heat = heat; me.health = 1e6; me.armour = 1e6;
  if (me.mode !== 'foot' && me.mode !== 'driving') me.mode = 'foot';
  state = step(state, { 1: { ...NULL_INPUT, seq: seq++, tick: seq } }, [], map);
};
const mounted = new Set();
let victim = null;
for (let i = 0; i < 1500 && victim === null; i++) {
  tick(310);
  for (const cid of state.cops.ids) {
    const c = state.cops.byId[cid];
    if (c.vehicleId !== null) { mounted.add(cid); continue; }
    if (mounted.has(cid)) {                       // stepped out of a car on its own
      const car = state.vehicles.ids.find((v) => state.copFleet[v] !== undefined
        && state.vehicles.byId[v].driverId === null
        && Math.hypot(state.vehicles.byId[v].pos.x - c.pos.x, state.vehicles.byId[v].pos.y - c.pos.y) < 180);
      if (car !== undefined) { victim = { cid, car, t: i }; break; }
    }
  }
}
if (!victim) { console.log(`${diff}: no natural dismount observed`); process.exit(0); }
const c0 = state.cops.byId[victim.cid];
const car = state.vehicles.byId[victim.car];
console.log(`${diff}: carsFromStar=${t.carsFromStar}  natural dismount at tick ${victim.t}: cop ${victim.cid}, cruiser ${victim.car} ${Math.hypot(car.pos.x-c0.pos.x, car.pos.y-c0.pos.y).toFixed(1)} px away`);
// heat decays to two stars, fugitive drives off
let boarded = -1;
for (let i = 0; i < 300; i++) {
  const c = state.cops.byId[victim.cid];
  if (!c) { console.log(`  cop gone at t=${i}`); break; }
  const m = state.players.byId[1];
  m.pos.x = c.pos.x + 400; m.pos.y = c.pos.y;
  tick(210);
  const c2 = state.cops.byId[victim.cid];
  if (c2 && c2.vehicleId !== null) { boarded = i; break; }
}
console.log(`  at ${state.players.byId[1].wantedLevel} stars: back in the cruiser? ${boarded >= 0 ? `YES at tick ${boarded}` : 'no (300 ticks)'}`);
