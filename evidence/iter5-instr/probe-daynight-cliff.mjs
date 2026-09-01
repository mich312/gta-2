// The second thing wrong with the 7200-tick wait in "tops pedestrians back up
// to target after a massacre": the assertion floor is `floor(target * 0.85)`
// against the UNSCALED target, but `topUpPeds` aims at a target scaled by the
// day/night crowd curve. Tick 0 is midday; the longer the window, the further
// into dusk the check lands and the lower the crowd legitimately sits. This
// prints where the existing assertion would start failing.
//
// Run from the repo root: node evidence/iter5-instr/probe-daynight-cliff.mjs
import playerTuning from '../../shared/data/player.json' with { type: 'json' };
import vehiclesJson from '../../shared/data/vehicles.json' with { type: 'json' };
import worldgenJson from '../../shared/data/worldgen.json' with { type: 'json' };
import {
  areaScale,
  crowdScale,
  initTuning,
  parseWorldgenParams,
  timeOfDay,
} from '../../shared/dist/index.js';
import { Session } from '../../server/dist/session.js';

initTuning({ player: playerTuning, vehicles: vehiclesJson });
const worldgen = parseWorldgenParams(worldgenJson);

const session = new Session(4242, worldgen, null, { pedCount: 40 });
for (let i = 0; i < 5; i++) session.tick();
const scale = areaScale(session.map);
const target = Math.min(Math.round(40 * scale), session.map.pedSpawns.length);
const floor = Math.floor(target * 0.85);

const doomed = session.state.peds.ids.slice(0, Math.floor(target / 2));
for (const id of doomed) {
  delete session.state.peds.byId[id];
  session.state.peds.ids.splice(session.state.peds.ids.indexOf(id), 1);
}
console.log(`target ${target}  assertion floor ${floor}  after massacre ${session.state.peds.ids.length}`);
console.log('tick   peds  crowdScale  scaledTarget  passes(>=floor)');

let firstFail = -1;
for (let i = 1; i <= 14400; i++) {
  session.tick();
  if (i % 300 !== 0) continue;
  const cs = crowdScale(timeOfDay(session.state.tick, worldgen.dayLengthSec), worldgen.nightCrowdScale);
  const scaled = Math.round(target * cs);
  const peds = session.state.peds.ids.length;
  if (firstFail < 0 && peds < floor) firstFail = i;
  console.log(
    `${String(i).padStart(5)}  ${String(peds).padStart(4)}  ${cs.toFixed(3).padStart(10)}  ` +
      `${String(scaled).padStart(12)}  ${peds >= floor ? 'yes' : 'NO'}`,
  );
}
console.log(
  firstFail < 0
    ? 'never dropped below the floor within 14400 ticks'
    : `first tick at/after which the existing assertion fails: ~${firstFail}`,
);
