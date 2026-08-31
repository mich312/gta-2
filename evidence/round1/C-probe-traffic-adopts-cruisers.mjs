import { createGameState, generateCity, NULL_INPUT, step } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';
loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
let state = createGameState(3);
state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
state.players.byId[1].heat = 410;
for (let i = 0; i < 1200; i++) {
  const me = state.players.byId[1];
  me.heat = 410; me.health = 1e6;
  if (me.mode === 'dead') me.mode = 'foot';
  state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i } }, [], map);
  const adopted = [];
  for (const cid of state.cops.ids) {
    const c = state.cops.byId[cid];
    if (c && c.vehicleId !== null && state.trafficDrivers[c.vehicleId]) adopted.push(c.vehicleId);
  }
  if (adopted.length) {
    console.log('tick', i, 'cop cruisers with an ambient-traffic driver record:', adopted.join(','));
    break;
  }
}
