// Does `drivableLane` return a lane the car was ever ON? Print, per candidate,
// where the spawn actually put the car versus where the candidate says.
import { readFileSync } from 'node:fs';
const R = process.cwd();
const S = await import(`file://${R}/shared/dist/index.js`);
const worldgen = JSON.parse(readFileSync(`${R}/shared/data/worldgen.json`, 'utf8'));
const player = JSON.parse(readFileSync(`${R}/shared/data/player.json`, 'utf8'));
const vehicles = JSON.parse(readFileSync(`${R}/shared/data/vehicles.json`, 'utf8'));
S.initTuning({ player, vehicles });
const { generateCity, parseWorldgenParams, createGameState, step, NULL_INPUT, Predictor } = S;
const map = generateCity(6006, parseWorldgenParams(worldgen));
const home = map.playerSpawns[0] ?? { x: 0, y: 0 };
const near = [...map.vehicleSpawns].sort(
  (a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y),
);
let probeState = createGameState(1);
probeState = step(probeState, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'probe' }], map);
let id = 100;
let n = 0;
for (const cand of near.slice(0, 60)) {
  const vid = id++;
  n++;
  probeState = step(
    probeState,
    {},
    [{ type: 'spawnVehicle', vehicleId: vid, kind: 'car', x: cand.x, y: cand.y, heading: cand.heading }],
    map,
  );
  const veh = probeState.vehicles.byId[vid];
  if (!veh) {
    console.log(`cand#${n} at ${cand.x},${cand.y}: NOT SPAWNED`);
    continue;
  }
  const off = Math.hypot(veh.pos.x - cand.x, veh.pos.y - cand.y);
  const p = probeState.players.byId[1];
  p.pos = { x: cand.x, y: cand.y };
  p.mode = 'driving';
  p.vehicleId = vid;
  const probe = new Predictor();
  probe.reconcile(p, veh, 0, map);
  let d40 = 0;
  for (let i = 0; i < 40; i++) {
    probe.applyLocalInput({ ...NULL_INPUT, seq: i + 1, tick: i, up: true }, map);
  }
  const v = probe.predictedVehicle;
  d40 = Math.hypot(v.pos.x - cand.x, v.pos.y - cand.y);
  console.log(
    `cand#${n} at ${cand.x},${cand.y}: car actually spawned ${off.toFixed(1)} px away; d40-from-cand ${d40.toFixed(1)}${d40 > 180 ? '  <-- PICKED' : ''}`,
  );
  if (d40 > 180) break;
}
