/**
 * `police.json`'s `hard` preset raises nothing: `carsFromStar: 2` does not put
 * officers in cars at two stars, because `maybeSpawnCop` motorises from the
 * `waves` table (`unit.vehicle`) and the preset does not override `waves`.
 * `carsFromStar` is read only by `waveUnits`' no-waves fallback and by
 * `remount`'s gate.
 *
 * Usage: node evidence/round5/C-repro-hard-carsfromstar.mjs [hard|normal|relaxed]
 */
import { createGameState, generateCity, NULL_INPUT, step, getTuning } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

const diff = process.argv[2] ?? 'hard';
loadSharedTuning(diff);
const map = generateCity(6006, loadWorldgenParams());
const t = getTuning().police;
console.log(`${diff}: carsFromStar=${t.carsFromStar}  waves["2"]=${JSON.stringify(t.waves['2'])}`);

for (const heat of [210, 310]) {
  let state = createGameState(3);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
  let anyCar = false;
  let motorised = 0;
  for (let i = 0; i < 3000; i++) {
    const me = state.players.byId[1];
    me.heat = heat;
    me.health = 1e6;
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i } }, [], map);
    for (const id of state.vehicles.ids) if (state.vehicles.byId[id].kind === 'copcar') anyCar = true;
    let m = 0;
    for (const cid of state.cops.ids) if (state.cops.byId[cid].vehicleId !== null) m++;
    motorised = Math.max(motorised, m);
  }
  const stars = state.players.byId[1].wantedLevel;
  console.log(`  heat ${heat} (=${stars} stars): any copcar in the world? ${anyCar ? 'yes' : 'NO'}   peak motorised officers=${motorised}`);
}
