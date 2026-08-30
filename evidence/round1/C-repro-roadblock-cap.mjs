/**
 * Lens C, finding 4: `maybeRoadblock`'s per-kind budget check is a no-op.
 *
 *   node evidence/round1/C-repro-roadblock-cap.mjs
 *
 * police.ts:772   if (cars + 2 > (t.vehicleCaps[kind] ?? t.maxCopCars) + 2) return;
 *
 * The `+ 2` that is supposed to ask "will these two still fit?" appears on both
 * sides and cancels, so the test is `cars > cap` and a roadblock is allowed
 * whenever the budget is merely FULL. The world ends up with `cap + 2`.
 */
import { createGameState, generateCity, NULL_INPUT, step, getTuning } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const t = getTuning().police;
console.log(`vehicleCaps = ${JSON.stringify(t.vehicleCaps)}  maxCopCars = ${t.maxCopCars}`);

let worst = 0;
let worstSeed = null;
for (const seed of [3, 11, 29, 47, 61, 73, 89, 101]) {
  let state = createGameState(seed);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
  const me0 = state.players.byId[1];
  me0.heat = 410; // four stars: roadblocksFromStar = 4
  state = step(state, {}, [
    { type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: me0.pos.x, y: me0.pos.y, heading: 0 },
  ], map);
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
  let peak = 0;
  for (let i = 0; i < 240 * 30; i++) {
    const me = state.players.byId[1];
    me.health = 1e6; me.armour = 1e6;
    me.heat = Math.max(me.heat, 410);
    if (me.mode === 'dead') me.mode = 'foot';
    const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
    let steer = 0;
    if (car) {
      let near = null, bd = Infinity;
      for (const cid of state.cops.ids) {
        const c = state.cops.byId[cid];
        if (!c || c.health <= 0) continue;
        const d = Math.hypot(c.pos.x - me.pos.x, c.pos.y - me.pos.y);
        if (d < bd) { bd = d; near = c.pos; }
      }
      if (near) {
        const a = Math.atan2(me.pos.y - near.y, me.pos.x - near.x);
        const e = Math.atan2(Math.sin(a - car.heading), Math.cos(a - car.heading));
        steer = e > 0.2 ? 1 : e < -0.2 ? -1 : 0;
      }
    }
    state = step(state, {
      1: { ...NULL_INPUT, seq: i + 2, tick: i, up: true, left: steer < 0, right: steer > 0 },
    }, [], map);
    let n = 0;
    for (const id of state.vehicles.ids) if (state.vehicles.byId[id]?.kind === 'copcar') n++;
    if (n > peak) peak = n;
  }
  console.log(`seed ${String(seed).padStart(3)}: peak copcars in the world = ${peak}` +
    (peak > (t.vehicleCaps['copcar'] ?? t.maxCopCars) ? '   <-- over budget' : ''));
  if (peak > worst) { worst = peak; worstSeed = seed; }
}
console.log(`\nworst: ${worst} copcars against a stated per-kind budget of ${t.vehicleCaps['copcar']} (seed ${worstSeed})`);
