/**
 * A civilian pedestrian boards a police vehicle that nobody will ever get out of.
 *
 * `stepBoarding`'s "who is getting in" scan (traffic.ts:1109-1113) tests only
 * `v.driverId !== null || v.condition !== 'ok'`. It never asks `isPoliceVehicle`,
 * the copFleet gate R1-C06 added to `stepTraffic` and to the population cull.
 *
 * So a parked police vehicle in `copFleet` — a roadblock car, or a cruiser an
 * officer dismounted from — is eligible. The ped is deleted, the car is given
 * a traffic driver id ... and `stepTraffic` then SKIPS it, because it is a
 * police vehicle. Nothing ever drives it, `driver.trip` never advances so it
 * never alights, `retireAbandoned` and `remount` both skip it (driverId is not
 * null), and the population cull counts it against the ambient budget and
 * refuses to despawn it.
 *
 * Usage: node evidence/round5/C-repro-ped-boards-cruiser.mjs [ticks]
 */
import { createGameState, generateCity, NULL_INPUT, step } from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());
const TICKS = Number(process.argv[2] ?? 1500);

function stage(policeCar) {
  let state = createGameState(11);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
  const me = state.players.byId[1];
  // The nearest kerbside spawn point to the player: a road tile by construction.
  let spot = null;
  let bestD = Infinity;
  for (const s of map.vehicleSpawns) {
    const d = Math.hypot(s.x - me.pos.x, s.y - me.pos.y);
    if (d > 120 && d < bestD) { bestD = d; spot = s; }
  }
  const VID = 90001;
  const cmds = [{
    type: 'spawnVehicle', vehicleId: VID,
    kind: policeCar ? 'copcar' : 'car',
    x: spot.x, y: spot.y, heading: spot.heading,
  }];
  // Twenty people on the pavement around it, the way session.ts tops the crowd up.
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    cmds.push({ type: 'spawnPed', pedId: 70000 + i, x: spot.x + Math.cos(a) * 14, y: spot.y + Math.sin(a) * 14 });
  }
  state = step(state, {}, cmds, map);
  // Exactly what `maybeRoadblock` writes for a car it parks across a street,
  // and what `motorise`/`remount` write for a cruiser: the force's own vehicle.
  if (policeCar) state.copFleet[VID] = -1;
  return { state, VID, spot };
}

function run(policeCar) {
  let { state, VID, spot } = stage(policeCar);
  let boardedAt = null;
  for (let i = 0; i < TICKS; i++) {
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i } }, [], map);
    const v = state.vehicles.byId[VID];
    if (!v) break;
    if (boardedAt === null && v.driverId !== null) boardedAt = i;
  }
  const v = state.vehicles.byId[VID];
  const drv = v ? state.trafficDrivers[VID] : undefined;
  const moved = v ? Math.hypot(v.pos.x - spot.x, v.pos.y - spot.y) : -1;
  let aiCount = 0;
  for (const id of state.vehicles.ids) {
    const d = state.vehicles.byId[id]?.driverId;
    if (d !== null && d !== undefined && d < -1) aiCount++;
  }
  return {
    label: policeCar ? 'copcar in copFleet' : 'CONTROL: ordinary car',
    boardedAt,
    stillThere: !!v,
    driverId: v ? v.driverId : null,
    trip: drv ? drv.trip : null,
    movedPx: moved.toFixed(1),
    peds: state.peds.ids.length,
    aiDrivenCars: aiCount,
  };
}

for (const police of [false, true]) {
  const r = run(police);
  console.log(
    `${r.label.padEnd(24)} boardedAt=${String(r.boardedAt).padEnd(6)} ` +
    `stillOnMap=${String(r.stillThere).padEnd(6)} driverId=${String(r.driverId).padEnd(8)} ` +
    `driver.trip=${String(r.trip).padEnd(6)} movedPx=${String(r.movedPx).padEnd(8)} ` +
    `pedsLeft=${r.peds} aiDrivenCars=${r.aiDrivenCars}`,
  );
}

/**
 * Part 2 — the budget. Every frozen cruiser permanently occupies one of
 * `traffic.count` (14) ambient slots, so the city runs that many cars short
 * for the rest of the session.
 */
function budget(nPolice, ticks) {
  let state = createGameState(11);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'r' }], map);
  const me = state.players.byId[1];
  const near = map.vehicleSpawns
    .map((s) => ({ s, d: Math.hypot(s.x - me.pos.x, s.y - me.pos.y) }))
    .filter((e) => e.d > 120 && e.d < 500)
    .sort((a, b) => a.d - b.d)
    .slice(0, nPolice)
    .map((e) => e.s);
  const cmds = [];
  const ids = [];
  near.forEach((spot, k) => {
    const vid = 90100 + k;
    ids.push(vid);
    cmds.push({ type: 'spawnVehicle', vehicleId: vid, kind: 'copcar', x: spot.x, y: spot.y, heading: spot.heading });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      cmds.push({ type: 'spawnPed', pedId: 70000 + k * 100 + i, x: spot.x + Math.cos(a) * 14, y: spot.y + Math.sin(a) * 14 });
    }
  });
  state = step(state, {}, cmds, map);
  for (const vid of ids) state.copFleet[vid] = -1;
  for (let i = 0; i < ticks; i++) {
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i } }, [], map);
  }
  let frozen = 0;
  let live = 0;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.driverId === null || v.driverId >= -1) continue;
    if (state.copFleet[id] !== undefined) frozen++;
    else live++;
  }
  return { frozen, live };
}

const ticks = Number(process.argv[3] ?? 9000);
for (const n of [0, 2, 4]) {
  const r = budget(n, ticks);
  console.log(`staged ${n} parked police cars, ${ticks} ticks: frozen=${r.frozen}  ambient traffic actually circulating=${r.live} (target 14)`);
}
