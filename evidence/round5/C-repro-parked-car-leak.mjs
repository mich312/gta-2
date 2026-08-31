/**
 * Ambient traffic's cull leaks a permanent driverless car every time it fires.
 *
 * `stepTrafficPopulation` (traffic.ts:1189) despawns an ambient car by writing
 *     v.driverId = null; // becomes an ordinary parked car, then is reused
 * and `putAiVehicle` (traffic.ts:1314) then mints a BRAND NEW entity
 * (`state.nextEntityId++`) for every replacement. Nothing in `shared/src`
 * removes an intact, driverless, non-police vehicle: `retireAbandoned` takes
 * only `copFleet` cars, the wreck clearer takes only wrecks, and the cull
 * itself only nulls the driver. The one reuse channel is a pedestrian
 * boarding it in `stepBoarding`, which needs a ped within `boardRadius` (40px)
 * — and a culled car is by construction `despawnDist` (1100px) from every
 * player, which is where no ped is.
 *
 * Measured with the crowd topped up exactly as `session.ts` does, so the
 * reuse channel is live: it does not keep up.
 *
 * Usage: node evidence/round5/C-repro-parked-car-leak.mjs [ticks]
 */
import { createGameState, generateCity, NULL_INPUT, step, isAiDriver } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const TICKS = Number(process.argv[2] ?? 36000);

let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);

// A starting parked fleet of the size session.ts lays down for this map
// (VEHICLES_PER_CITY * areaScale), so the baseline is the real one.
const seedCmds = [];
let nid = 500000;
for (const s of map.parkingSpots.filter((_, i) => i % 5 === 0).slice(0, 192)) {
  seedCmds.push({ type: 'spawnVehicle', vehicleId: nid++, kind: 'car', x: s.x, y: s.y, heading: 0 });
}
state = step(state, {}, seedCmds, map);
const me0 = state.players.byId[1];
state = step(state, {}, [{ type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: me0.pos.x, y: me0.pos.y, heading: 0 }], map);
state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
console.log(`start: vehicles=${state.vehicles.ids.length}`);

let lastT = Date.now();
for (let i = 0; i < TICKS; i++) {
  const me = state.players.byId[1];
  me.health = 1e6; // this is about the traffic system, not about surviving
  const cmds = [];
  // The crowd, topped up the way session.ts tops it up (never in view).
  if (i % 15 === 0 && state.peds.ids.length < 200) {
    const spot = map.pedSpawns[(i * 7) % map.pedSpawns.length];
    if (spot && Math.hypot(spot.x - me.pos.x, spot.y - me.pos.y) > 700) {
      cmds.push({ type: 'spawnPed', pedId: 300000 + i, x: spot.x, y: spot.y });
    }
  }
  const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
  const stuck = car && Math.abs(car.speed) < 12;
  state = step(state, { 1: {
    ...NULL_INPUT, seq: i + 2, tick: i, up: true,
    right: stuck || Math.floor(i / 900) % 4 === 1,
  } }, cmds, map);

  if ((i + 1) % 3600 === 0) {
    let ai = 0, driverless = 0;
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id];
      if (isAiDriver(v.driverId)) ai++;
      else if (v.driverId === null) driverless++;
    }
    const now = Date.now();
    console.log(
      `t=${((i + 1) / 30).toFixed(0)}s  vehicles=${state.vehicles.ids.length} ` +
      `(ai ${ai}, driverless ${driverless})  peds=${state.peds.ids.length}  ` +
      `sim cost ${((now - lastT) / 3.6).toFixed(0)} ms/1000 ticks`,
    );
    lastT = now;
  }
}
