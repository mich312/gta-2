/**
 * The same experiment as evidence/round5/C-repro-parked-car-leak.mjs, but with
 * the world session.ts actually lays down: 166 kerbside cars + 29 vehicle
 * homes + 460 moored boats = 655 vehicles, and a crowd topped up to
 * PEDS_PER_CITY * areaScale (=800) * crowdScale, seeded in FULL at t=0 the way
 * seedWorldFromMap does, at PED_RESPAWN_PER_SEC=2 with PED_RESPAWN_MIN_DIST=700.
 */
import { createGameState, generateCity, NULL_INPUT, step, isAiDriver, areaScale, TILE_SIZE, crowdScale, timeOfDay } from '/home/user/gta-2/shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '/home/user/gta-2/server/dist/tuning.js';

loadSharedTuning('normal');
const worldgen = loadWorldgenParams();
const map = generateCity(6006, worldgen);
const TICKS = Number(process.argv[2] ?? 36000);
const SMALL = process.argv[3] === 'small'; // fleet-baseline-only comparison

function kerbRank(gx, gy) {
  let h = 0x5f3a71c9 ^ Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);

// --- the fleet session.ts lays down -------------------------------------
const ranked = map.parkingSpots.map((spot) => ({
  spot, key: kerbRank(Math.floor(spot.x / TILE_SIZE), Math.floor(spot.y / TILE_SIZE)),
}));
ranked.sort((a, b) => a.key - b.key);
const parked = ranked.slice(0, Math.round(48 * areaScale(map))).map((r) => r.spot)
  .filter((s) => s.crosswise !== true)
  .filter((s) => !map.vehicleHomes.some((h) => Math.abs(h.x - s.x) < 48 && Math.abs(h.y - s.y) < 48));
const seedCmds = [];
let nid = 500000;
for (const s of parked) seedCmds.push({ type: 'spawnVehicle', vehicleId: nid++, kind: s.kind, x: s.x, y: s.y, heading: s.heading });
for (const h of map.vehicleHomes) seedCmds.push({ type: 'spawnVehicle', vehicleId: nid++, kind: h.kind, x: h.x, y: h.y, heading: h.heading });
if (!SMALL) for (const b of map.boatSpawns) seedCmds.push({ type: 'spawnVehicle', vehicleId: nid++, kind: 'boat', x: b.x, y: b.y, heading: b.heading });

// --- the crowd, seeded in full the way seedWorldFromMap does -------------
const pedTarget0 = Math.min(Math.round(200 * areaScale(map)), map.pedSpawns.length);
const stride = Math.max(1, Math.floor(map.pedSpawns.length / pedTarget0));
let placed = 0;
for (let i = 0; i < map.pedSpawns.length && placed < pedTarget0; i += stride) {
  const s = map.pedSpawns[i];
  seedCmds.push({ type: 'spawnPed', pedId: nid++, x: s.x, y: s.y });
  placed++;
}
state = step(state, {}, seedCmds, map);

const me0 = state.players.byId[1];
state = step(state, {}, [{ type: 'spawnVehicle', vehicleId: 990001, kind: 'car', x: me0.pos.x, y: me0.pos.y, heading: 0 }], map);
state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);

function census() {
  let ai = 0, driverless = 0, boats = 0;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (v.kind === 'boat') boats++;
    if (isAiDriver(v.driverId)) ai++;
    else if (v.driverId === null) driverless++;
  }
  return { ai, driverless, boats };
}
const c0 = census();
console.log(`start: vehicles=${state.vehicles.ids.length} (boats ${c0.boats}) peds=${state.peds.ids.length}`);

let cursor = 0;
let lastT = Date.now();
for (let i = 0; i < TICKS; i++) {
  const me = state.players.byId[1];
  me.health = 1e6;
  const cmds = [];
  // topUpPeds(), verbatim: every 15 ticks, one arrival, target scaled by the clock.
  if (i % 15 === 0) {
    const target = Math.min(
      Math.round(200 * areaScale(map) * crowdScale(timeOfDay(state.tick, worldgen.dayLengthSec), worldgen.nightCrowdScale)),
      map.pedSpawns.length,
    );
    if (target - state.peds.ids.length > 0) {
      for (let k = 0; k < map.pedSpawns.length; k++) {
        cursor = (cursor + 1) % map.pedSpawns.length;
        const spot = map.pedSpawns[cursor];
        if (!spot) continue;
        if (Math.hypot(me.pos.x - spot.x, me.pos.y - spot.y) < 700) continue;
        cmds.push({ type: 'spawnPed', pedId: 900000 + i, x: spot.x, y: spot.y });
        break;
      }
    }
  }
  const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
  const stuck = car && Math.abs(car.speed) < 12;
  state = step(state, { 1: {
    ...NULL_INPUT, seq: i + 2, tick: i, up: true,
    right: stuck || Math.floor(i / 900) % 4 === 1,
  } }, cmds, map);

  if ((i + 1) % 3600 === 0) {
    const c = census();
    const now = Date.now();
    console.log(
      `t=${((i + 1) / 30).toFixed(0)}s  vehicles=${state.vehicles.ids.length} ` +
      `(ai ${c.ai}, driverless ${c.driverless})  peds=${state.peds.ids.length}  ` +
      `nextEntityId=${state.nextEntityId}  sim cost ${((now - lastT) / 3.6).toFixed(0)} ms/1000 ticks`,
    );
    lastT = now;
  }
}
