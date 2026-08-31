// Does a culled car ever get reused? Track every id the cull nulls out, and
// watch for it regaining an AI driver, or leaving the table at all.
import { createGameState, generateCity, NULL_INPUT, step, isAiDriver } from '/home/user/gta-2/shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '/home/user/gta-2/server/dist/tuning.js';
loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const TICKS = Number(process.argv[2] ?? 18000);
const PEDCAP = Number(process.argv[3] ?? 200);

let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
const seed = []; let nid = 500000;
for (const s of map.parkingSpots.filter((_, i) => i % 5 === 0).slice(0, Number(process.argv[4] ?? 192)))
  seed.push({ type: 'spawnVehicle', vehicleId: nid++, kind: 'car', x: s.x, y: s.y, heading: 0 });
state = step(state, {}, seed, map);
const me0 = state.players.byId[1];
state = step(state, {}, [{ type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: me0.pos.x, y: me0.pos.y, heading: 0 }], map);
state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);

const seededIds = new Set(state.vehicles.ids);
let prevAi = new Set(state.vehicles.ids.filter((id) => isAiDriver(state.vehicles.byId[id].driverId)));
const everMinted = new Set();      // ids that appeared after t0
const culled = new Set();          // ids the cull nulled
const alighted = new Set();
let alightEvents = 0, reuseOfAlighted = 0;
let cullEvents = 0, reuseOfCulled = 0, reuseOfSeeded = 0, mints = 0, removed = 0;
let prevIds = new Set(state.vehicles.ids);

for (let i = 0; i < TICKS; i++) {
  const me = state.players.byId[1];
  me.health = 1e6;
  const cmds = [];
  if (i % 15 === 0 && state.peds.ids.length < PEDCAP) {
    const spot = map.pedSpawns[(i * 7) % map.pedSpawns.length];
    if (spot && Math.hypot(spot.x - me.pos.x, spot.y - me.pos.y) > 700)
      cmds.push({ type: 'spawnPed', pedId: 300000 + i, x: spot.x, y: spot.y });
  }
  const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
  const stuck = car && Math.abs(car.speed) < 12;
  state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i, up: true, right: stuck || Math.floor(i / 900) % 4 === 1 } }, cmds, map);

  const nowIds = new Set(state.vehicles.ids);
  for (const id of nowIds) if (!prevIds.has(id)) { mints++; everMinted.add(id); }
  for (const id of prevIds) if (!nowIds.has(id)) removed++;
  const nowAi = new Set(state.vehicles.ids.filter((id) => isAiDriver(state.vehicles.byId[id].driverId)));
  // lost an AI driver while still present and still intact => the cull (or alighting)
  for (const id of prevAi) {
    if (nowIds.has(id) && !nowAi.has(id) && state.vehicles.byId[id].driverId === null) {
      const v = state.vehicles.byId[id];
      const d = Math.hypot(v.pos.x - me.pos.x, v.pos.y - me.pos.y);
      if (d > 1100) { culled.add(id); cullEvents++; } else { alighted.add(id); alightEvents++; }
    }
  }
  // gained an AI driver without being newly minted => reuse
  for (const id of nowAi) {
    if (!prevAi.has(id) && !(mints && !prevIds.has(id))) {
      if (prevIds.has(id)) {
        if (culled.has(id)) reuseOfCulled++;
        else if (alighted.has(id)) reuseOfAlighted++;
        else if (seededIds.has(id)) reuseOfSeeded++;
      }
    }
  }
  prevIds = nowIds; prevAi = nowAi;
}
process.stdout.write('');console.log(`ticks=${TICKS} pedcap=${PEDCAP}`);
console.log(`  vehicles now      = ${state.vehicles.ids.length} (start ${seededIds.size})`);
console.log(`  new entities minted = ${mints}`);
console.log(`  vehicles removed    = ${removed}`);
console.log(`  driver-loss events  = ${cullEvents} over ${culled.size} distinct cars`);
console.log(`  REUSE of a culled car   = ${reuseOfCulled}`);
console.log(`  alight events (>0 <1100px) = ${alightEvents} over ${alighted.size} distinct cars`);
console.log(`  REUSE of an alighted car = ${reuseOfAlighted}`);
console.log(`  REUSE of a seeded car   = ${reuseOfSeeded}`);
