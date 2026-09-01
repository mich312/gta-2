// Where the 51 s in "tops pedestrians back up to target after a massacre" goes.
// Run from the repo root: node evidence/iter5-instr/probe-massacre.mjs
import playerTuning from '../../shared/data/player.json' with { type: 'json' };
import vehiclesJson from '../../shared/data/vehicles.json' with { type: 'json' };
import worldgenJson from '../../shared/data/worldgen.json' with { type: 'json' };
import { areaScale, initTuning, parseWorldgenParams } from '../../shared/dist/index.js';
import { Session } from '../../server/dist/session.js';

initTuning({ player: playerTuning, vehicles: vehiclesJson });
const worldgen = parseWorldgenParams(worldgenJson);

let t0 = performance.now();
const session = new Session(4242, worldgen, null, { pedCount: 40 });
console.log(`construct           ${(performance.now() - t0).toFixed(0)} ms`);

t0 = performance.now();
for (let i = 0; i < 5; i++) session.tick();
console.log(`first 5 ticks       ${(performance.now() - t0).toFixed(0)} ms`);

const scale = areaScale(session.map);
const want = Math.round(40 * scale);
const target = Math.min(want, session.map.pedSpawns.length);
console.log(
  `areaScale ${scale}  target ${target}  peds now ${session.state.peds.ids.length}  spawns ${session.map.pedSpawns.length}`,
);
console.log(`vehicles ${session.state.vehicles.ids.length}`);

const doomed = session.state.peds.ids.slice(0, Math.floor(target / 2));
for (const id of doomed) {
  delete session.state.peds.byId[id];
  session.state.peds.ids.splice(session.state.peds.ids.indexOf(id), 1);
}
console.log(`after massacre      ${session.state.peds.ids.length}`);

const TOTAL = 30 * 60 * Math.ceil(scale);
let refilledAt = -1;
t0 = performance.now();
for (let i = 0; i < TOTAL; i++) {
  session.tick();
  if (refilledAt < 0 && session.state.peds.ids.length >= Math.floor(target * 0.85)) {
    refilledAt = i + 1;
  }
  if ((i + 1) % 600 === 0) {
    console.log(
      `tick ${String(i + 1).padStart(5)}  peds ${String(session.state.peds.ids.length).padStart(4)}  ` +
        `elapsed ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
  }
}
console.log(`loop of ${TOTAL} ticks  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(
  `crowd back to >= 85% of target at tick ${refilledAt} (${(refilledAt / 30).toFixed(1)} sim-seconds)`,
);
console.log(`final peds ${session.state.peds.ids.length} / target ${target}`);
