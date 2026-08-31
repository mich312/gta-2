/**
 * Lens C, finding 5: the car bomb sets `condition = 'burning'` by hand
 * (fittings.ts:54-56) instead of going through `damageVehicle`, so it never
 * calls `chargeForArson` and never sets `igniterId`.
 *
 *   node evidence/round1/C-repro-carbomb.mjs
 *
 * Two ways of setting the same parked car alight, measured on the tick it
 * catches light.
 */
import { createGameState, generateCity, NULL_INPUT, step, getTuning } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const t = getTuning().police;
console.log(`heatPerVehicleKill = ${t.heatPerVehicleKill}, heatPerOccupiedVehicleKill = ${t.heatPerOccupiedVehicleKill}\n`);

function ignite(how) {
  let state = createGameState(5);
  state = step(state, {}, [
    { type: 'spawnPlayer', playerId: 1, name: 'p' },
    { type: 'grantWeapon', playerId: 1, weaponId: 'smg', ammo: 900 },
  ], map);
  const p = state.players.byId[1];
  const vx = how === 'bomb' ? p.pos.x : p.pos.x + 60;
  state = step(state, {}, [
    { type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: vx, y: p.pos.y, heading: 0 },
  ], map);
  if (how === 'bomb') {
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map); // get in
    state = step(state, {}, [{ type: 'fitVehicle', playerId: 1, fitting: 'bomb', ammo: 1 }], map);
    state = step(state, { 1: { ...NULL_INPUT, seq: 2, tick: 2, fitting: true } }, [], map); // arm
  } else {
    for (let i = 0; i < 400; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, fire: true, aimAngle: 0 } }, [], map);
      if (state.vehicles.byId[90001]?.condition !== 'ok') break;
    }
  }
  const v = state.vehicles.byId[90001];
  const me = state.players.byId[1];
  console.log(
    `${how.padEnd(5)}: condition=${v.condition} health=${String(v.health).padStart(3)} ` +
    `igniterId=${v.igniterId}  |  arsonist's heat at ignition = ${me.heat.toFixed(2)}`,
  );
}
ignite('bomb');
ignite('gun');

// ...and what the blast is credited to once the arsonist has stepped out.
{
  let state = createGameState(5);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'p' }], map);
  const p = state.players.byId[1];
  state = step(state, {}, [
    { type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 },
  ], map);
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
  state = step(state, {}, [{ type: 'fitVehicle', playerId: 1, fitting: 'bomb', ammo: 1 }], map);
  state = step(state, { 1: { ...NULL_INPUT, seq: 2, tick: 2, fitting: true } }, [], map);
  state = step(state, { 1: { ...NULL_INPUT, seq: 3, tick: 3, action: true } }, [], map); // get out
  for (let i = 0; i < 200; i++) {
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 4, tick: i + 4, left: true } }, [], map);
  }
  const v = state.vehicles.byId[90001];
  const me = state.players.byId[1];
  console.log(
    `\nafter the fuse: car condition=${v.condition}; the blast's attackerId was ` +
    `igniterId(${v.igniterId}) ?? driverId(${v.driverId}) ?? -1 = ${v.igniterId ?? v.driverId ?? -1}` +
    `${(v.igniterId ?? v.driverId ?? -1) < 0 ? ' — nobody.' : ' — the planter.'}` +
    `\nplanter's heat = ${me.heat.toFixed(2)}, wanted level = ${me.wantedLevel}`,
  );
}
