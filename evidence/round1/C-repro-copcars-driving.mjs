/**
 * R1-C01, companion instrument: the same measurement as `C-repro-copcars.mjs`
 * over a fugitive who actually keeps DRIVING.
 *
 *   node evidence/round1/C-repro-copcars-driving.mjs [stars] [seconds]
 *
 * Why this exists. The round-1 script's autopilot steers directly away from
 * the nearest officer, which drives the car into the first building it meets:
 * on seed 6006 the fugitive wedges at (4471, 8707) about fifteen seconds in
 * and never moves again, so everything it prints after t=15s is a stationary
 * suspect with the force standing round them — not a chase. That still shows
 * the defect (nothing ever removes the parked cruisers, no officer ever gets
 * back in one) but it cannot show the fix, because a force that has arrived
 * and got out at a suspect who is not going anywhere is behaving correctly.
 *
 * This one keeps the car moving: it steers along the road grid, and when the
 * car stops making progress it reverses and turns, the same recovery the
 * pursuit AI uses on itself. Prints the same columns.
 */
import { TILE_SIZE, T_ROAD, createGameState, generateCity, isSolidAtWorld, NULL_INPUT, step } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const stars = Number(process.argv[2] ?? 4);
const secs = Number(process.argv[3] ?? 240);

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

const TILE = TILE_SIZE;
const CARDINAL = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** Is there road, not scenery, one street-length down this cardinal? */
function open(x, y, dir) {
  const a = CARDINAL[dir];
  for (const reach of [TILE, TILE * 2, TILE * 3]) {
    const px = x + Math.cos(a) * reach;
    const py = y + Math.sin(a) * reach;
    if (isSolidAtWorld(map, px, py)) return false;
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
    if (map.tiles[ty * map.widthTiles + tx] !== T_ROAD) return false;
  }
  return true;
}

let reverseFor = 0;
let stalled = 0;
let travelled = 0;
let last = { x: me0.pos.x, y: me0.pos.y };

for (let i = 0; i < secs * 30; i++) {
  const me = state.players.byId[1];
  if (!me) break;
  me.health = 1e6;
  me.armour = 1e6;
  me.heat = Math.max(me.heat, stars * 100 + 10);
  if (me.mode === 'dead') me.mode = 'foot';
  const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
  let steer = 0;
  let back = false;
  if (car) {
    if (Math.abs(car.speed) < 8) stalled++;
    else stalled = 0;
    if (stalled > 12) {
      reverseFor = 18;
      stalled = 0;
    }
    if (reverseFor > 0) {
      reverseFor--;
      back = true;
      steer = 1;
    } else {
      // The open cardinal that points furthest from the nearest officer, with
      // a nudge in favour of carrying straight on — the fugitive's mirror of
      // the pursuit's own `detourDir`.
      let nx = me.pos.x + 1e6;
      let ny = me.pos.y;
      let bestD = Infinity;
      for (const cid of state.cops.ids) {
        const c = state.cops.byId[cid];
        if (!c || c.health <= 0) continue;
        const d = Math.hypot(c.pos.x - me.pos.x, c.pos.y - me.pos.y);
        if (d < bestD) { bestD = d; nx = c.pos.x; ny = c.pos.y; }
      }
      const away = Math.atan2(me.pos.y - ny, me.pos.x - nx);
      let pick = null;
      let bestErr = Infinity;
      for (let d = 0; d < 4; d++) {
        if (!open(me.pos.x, me.pos.y, d)) continue;
        const straight = Math.abs(Math.atan2(Math.sin(CARDINAL[d] - car.heading), Math.cos(CARDINAL[d] - car.heading))) < 0.5;
        const err = Math.abs(Math.atan2(Math.sin(CARDINAL[d] - away), Math.cos(CARDINAL[d] - away))) - (straight ? 0.6 : 0);
        if (err < bestErr) { bestErr = err; pick = d; }
      }
      if (pick !== null) {
        const err = Math.atan2(Math.sin(CARDINAL[pick] - car.heading), Math.cos(CARDINAL[pick] - car.heading));
        steer = err > 0.15 ? 1 : err < -0.15 ? -1 : 0;
      }
    }
  }
  state = step(state, {
    1: {
      ...NULL_INPUT, seq: i + 2, tick: i,
      up: !back, down: back, left: steer < 0, right: steer > 0,
    },
  }, [], map);
  const now = state.players.byId[1];
  if (now) {
    travelled += Math.hypot(now.pos.x - last.x, now.pos.y - last.y);
    last = { x: now.pos.x, y: now.pos.y };
  }
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
    `  tanks=${tank}  live officers=${live}  motorised=${motorised}  fugitive travelled=${Math.round(travelled)}px`,
  );
}
let stillMotorised = 0;
for (const cid of state.cops.ids) if (state.cops.byId[cid]?.vehicleId !== null) stillMotorised++;
console.log(
  `\nofficers dispatched: ${seenCops.size}; ever had a car: ${everMotorised.size}; ` +
  `still in one at the end: ${stillMotorised}; fugitive travelled ${Math.round(travelled)}px`,
);
