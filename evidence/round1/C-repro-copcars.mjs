/**
 * Lens C, finding 1: abandoned cruisers permanently exhaust `maxCopCars`.
 *
 *   node evidence/round1/C-repro-copcars.mjs [stars] [seconds] [mortal]
 *
 * Drives the chase-bench autopilot at a pinned wanted level and prints, every
 * 15 s, how many `copcar`s exist, how many still have a driver, and how many
 * live officers are motorised. `motorised` reaches 0 and never recovers.
 */
import { createGameState, generateCity, NULL_INPUT, step } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const stars = Number(process.argv[2] ?? 4);
const secs = Number(process.argv[3] ?? 240);
// `mortal` lets the fugitive die and be re-heated, which is what a real server
// sees over many short chases: the abandoned cruisers accumulate to the cap.
const mortal = process.argv[4] === 'mortal';

const everMotorised = new Set();
const seenCops = new Set();
let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'runner' }], map);
const me0 = state.players.byId[1];
me0.heat = stars * 100 + 10;
state = step(state, {}, [
  { type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: me0.pos.x, y: me0.pos.y, heading: 0 },
], map);
state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);

for (let i = 0; i < secs * 30; i++) {
  const me = state.players.byId[1];
  if (!me) break;
  // Kept alive and kept wanted: this measures the police response, not lethality.
  if (!mortal) { me.health = 1e6; me.armour = 1e6; }
  me.heat = Math.max(me.heat, stars * 100 + 10);
  if (me.mode === 'dead') { me.mode = 'foot'; if (mortal) me.health = 100; }
  const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
  let steer = 0;
  if (car) {
    let near = null;
    let bestD = Infinity;
    for (const cid of state.cops.ids) {
      const c = state.cops.byId[cid];
      if (!c || c.health <= 0) continue;
      const d = Math.hypot(c.pos.x - me.pos.x, c.pos.y - me.pos.y);
      if (d < bestD) { bestD = d; near = c.pos; }
    }
    if (near) {
      const away = Math.atan2(me.pos.y - near.y, me.pos.x - near.x);
      const err = Math.atan2(Math.sin(away - car.heading), Math.cos(away - car.heading));
      steer = err > 0.2 ? 1 : err < -0.2 ? -1 : 0;
    }
  }
  state = step(state, {
    1: { ...NULL_INPUT, seq: i + 2, tick: i, up: true, left: steer < 0, right: steer > 0 },
  }, [], map);
  for (const cid of state.cops.ids) {
    const c = state.cops.byId[cid];
    if (!c) continue;
    seenCops.add(cid);
    if (c.vehicleId !== null) everMotorised.add(cid);
  }
  if (i % (30 * 15) !== 0) continue;
  let copcar = 0, driven = 0, tank = 0;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v) continue;
    if (v.kind === 'copcar') { copcar++; if (v.driverId !== null) driven++; }
    if (v.kind === 'tank') tank++;
  }
  let live = 0, motorised = 0;
  for (const cid of state.cops.ids) {
    const c = state.cops.byId[cid];
    if (c && c.health > 0) { live++; if (c.vehicleId !== null) motorised++; }
  }
  console.log(
    `t=${String(Math.round(i / 30)).padStart(3)}s  copcars=${copcar} (driven ${driven}, abandoned ${copcar - driven})` +
    `  tanks=${tank}  live officers=${live}  motorised=${motorised}`,
  );
}
let stillMotorised = 0;
for (const cid of state.cops.ids) if (state.cops.byId[cid]?.vehicleId !== null) stillMotorised++;
console.log(
  `\nofficers dispatched: ${seenCops.size}; ever had a car: ${everMotorised.size}; ` +
  `still in one at the end: ${stillMotorised}`,
);
