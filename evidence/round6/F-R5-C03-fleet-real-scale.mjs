/**
 * R5-C03's before/after, at the scale a real session runs at, with the leak
 * split by the path that caused it.
 *
 * Three things the filing's own repro (round5/C-repro-parked-car-leak.mjs)
 * gets wrong, and this one fixes:
 *
 *  1. **Scale.** That script lays 192 cars and 200 peds. `session.ts` lays
 *     `VEHICLES_PER_CITY (48) * areaScale (4)` ranked kerbside spots, plus
 *     every vehicle home, plus every mooring, and a crowd of
 *     `PEDS_PER_CITY (200) * areaScale` — 655 vehicles and 799 peds on this
 *     map. The whole question is what the leak costs against the 33 ms tick
 *     budget, and 655 vehicles already costs most of it.
 *
 *  2. **The wedge.** That script drives with `up: true` and steers only when
 *     the car is slow, so the player wedges against something at t=240s and
 *     spends sixteen of its twenty minutes parked. The count then plateaus —
 *     the stationary spawn ring fills until `aiSpawnPlacement`'s 30 px
 *     occupancy test rejects everything — and the plateau reads as a
 *     refutation of the leak when it is an artefact of the driving. This one
 *     reverses out when the car stops, so the player keeps moving.
 *
 *  3. **The path.** The filing blames the population cull
 *     (`traffic.ts` `v.driverId = null`). Instrument the transitions and the
 *     cull is the minority: `stepBoarding`'s ALIGHTING strands about five
 *     times as many cars, close to the player, where the cull never fires. A
 *     fix aimed at the cull alone verifies clean while the leak keeps
 *     running.
 *
 * Usage: node evidence/round6/F-R5-C03-fleet-real-scale.mjs [ticks] [seed]
 */
import {
  areaScale,
  createGameState,
  generateCity,
  isAiDriver,
  NULL_INPUT,
  step,
  TILE_SIZE,
} from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const TICKS = Number(process.argv[2] ?? 18000);
const SEED = Number(process.argv[3] ?? 3);

const VEHICLES_PER_CITY = 48;
const PEDS_PER_CITY = 200;
const DESPAWN_DIST = 1100;

/** `session.ts`'s own ranking key, so the fleet is the fleet. */
function kerbRank(gx, gy) {
  let h = 0x5f3a71c9 ^ Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

let nid = 500000;
function seedCommands() {
  const ranked = map.parkingSpots.map((spot) => ({
    spot,
    key: kerbRank(Math.floor(spot.x / TILE_SIZE), Math.floor(spot.y / TILE_SIZE)),
  }));
  ranked.sort((a, b) => a.key - b.key);
  const spawns = ranked
    .slice(0, Math.round(VEHICLES_PER_CITY * areaScale(map)))
    .map((r) => r.spot)
    .filter((s) => s.crosswise !== true)
    .filter((s) => !map.vehicleHomes.some((h) => Math.abs(h.x - s.x) < 48 && Math.abs(h.y - s.y) < 48));
  spawns.push(...map.vehicleHomes);

  const out = [];
  for (const s of spawns) {
    out.push({
      type: 'spawnVehicle', vehicleId: nid++, kind: s.kind,
      x: s.x, y: s.y, heading: s.heading, gangId: s.gangId ?? 0,
    });
  }
  for (const s of map.boatSpawns) {
    out.push({ type: 'spawnVehicle', vehicleId: nid++, kind: 'boat', x: s.x, y: s.y, heading: s.heading });
  }
  const count = Math.min(Math.round(PEDS_PER_CITY * areaScale(map)), map.pedSpawns.length);
  const stride = count > 0 ? Math.max(1, Math.floor(map.pedSpawns.length / count)) : 1;
  for (let i = 0; i < count; i++) {
    const spot = map.pedSpawns[(i * stride) % map.pedSpawns.length];
    if (spot) out.push({ type: 'spawnPed', pedId: nid++, x: spot.x, y: spot.y });
  }
  return out;
}

let state = createGameState(SEED);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
state = step(state, {}, seedCommands(), map);
const start = state.vehicles.ids.length;
// Every id at or above this one was handed out by `state.nextEntityId` AFTER
// the city was laid down, so it belongs to something the sim minted while it
// ran — which, with nobody wanted and no ambulance called, is the traffic
// spawner. That counts the leak directly instead of inferring it from a
// total. (The seed commands carry explicit ids of their own and drag
// `nextEntityId` up past them, so the boundary has to be read here, after
// they have landed, rather than guessed from the 500000 the loop above uses.)
const mintedFrom = state.nextEntityId;
console.log(`start: vehicles=${start} peds=${state.peds.ids.length} areaScale=${areaScale(map).toFixed(2)}`);

// A car that STOPPED being ai-driven this tick was stranded by one of the two
// paths, and which one is decided by where it happened: the cull only ever
// fires past `despawnDist`, alighting only ever near a parking spot the
// player is beside. A car that is GONE from the table this tick was removed.
const wasAi = new Map();
let prevIds = new Set(state.vehicles.ids);
const culled = new Set();
const alighted = new Set();
let cullEvents = 0;
let alightEvents = 0;
let minted = 0;
let removed = 0;

let lastT = Date.now();
for (let i = 0; i < TICKS; i++) {
  const me = state.players.byId[1];
  me.health = 1e6; // this is about the traffic system, not about surviving
  const cmds = [];
  if (i % 15 === 0 && state.peds.ids.length < Math.round(PEDS_PER_CITY * areaScale(map))) {
    const spot = map.pedSpawns[(i * 7) % map.pedSpawns.length];
    if (spot && Math.hypot(spot.x - me.pos.x, spot.y - me.pos.y) > 700) {
      cmds.push({ type: 'spawnPed', pedId: nid++, x: spot.x, y: spot.y });
    }
  }
  const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
  const slow = car ? Math.abs(car.speed) < 12 : false;
  const wedged = car ? Math.abs(car.speed) < 3 : false;
  state = step(state, { 1: {
    ...NULL_INPUT, seq: i + 2, tick: i,
    up: !wedged, down: wedged, // back out instead of sitting there for a quarter of an hour
    right: slow || Math.floor(i / 450) % 3 === 1,
    left: Math.floor(i / 450) % 3 === 2,
    action: i === 0, // get in the nearest car and drive
  } }, cmds, map);

  const nowIds = new Set(state.vehicles.ids);
  for (const id of nowIds) if (!prevIds.has(id)) minted++;
  for (const id of prevIds) if (!nowIds.has(id)) removed++;
  const p = state.players.byId[1];
  for (const id of nowIds) {
    const v = state.vehicles.byId[id];
    const nowAi = isAiDriver(v.driverId);
    if (wasAi.get(id) === true && !nowAi && v.driverId === null && v.condition === 'ok') {
      if (Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y) > DESPAWN_DIST) {
        cullEvents++;
        culled.add(id);
      } else {
        alightEvents++;
        alighted.add(id);
      }
    }
    wasAi.set(id, nowAi);
  }
  prevIds = nowIds;

  if ((i + 1) % 3600 === 0) {
    let ai = 0;
    let driverless = 0;
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
const end = state.vehicles.ids.length;
console.log(`end of drive: vehicles=${end}  growth=${end - start} (+${(((end - start) / start) * 100).toFixed(1)}%)`);
console.log(`cull events (>${DESPAWN_DIST}px)  = ${cullEvents} over ${culled.size} distinct cars`);
console.log(`alight events (<${DESPAWN_DIST}px) = ${alightEvents} over ${alighted.size} distinct cars`);
console.log(`minted = ${minted}   removed = ${removed}`);

// --- and then the player leaves the district ----------------------------
//
// The sharper question, and the one the plateau above hides: does the surplus
// EVER go away? Both trees plateau while the player stays put — the leak
// throttles itself once the parked litter fills the spawn ring and
// `aiSpawnPlacement`'s 30 px occupancy test starts rejecting everything — so
// the level a run settles at is not by itself the answer. Park the player on
// the far side of the city and every car it left behind is outside the
// despawn ring at once.
let far = map.vehicleSpawns[0];
const me = state.players.byId[1];
for (const s of map.vehicleSpawns) {
  if (Math.hypot(s.x - me.pos.x, s.y - me.pos.y) > Math.hypot(far.x - me.pos.x, far.y - me.pos.y)) far = s;
}
for (let i = 0; i < 900; i++) {
  const p = state.players.byId[1];
  p.pos = { x: far.x, y: far.y };
  p.mode = 'foot';
  p.health = 1e6;
  state = step(state, { 1: { ...NULL_INPUT, seq: TICKS + i + 2, tick: TICKS + i } }, [], map);
}
const trafficMinted = () => state.vehicles.ids.filter((id) => id >= mintedFrom).length;
const left = state.vehicles.ids.length;
console.log(
  `after the player leaves: vehicles=${left}  surplus over the designed ${start} = ${left - start}  ` +
  `(cars the traffic spawner minted and still on the map: ${trafficMinted()}, against a traffic target of 14)`,
);
