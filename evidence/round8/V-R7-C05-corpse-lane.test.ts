import { describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import policeJson from '../../shared/data/police.json';
import pedsJson from '../../shared/data/peds.json';
import propsJson from '../../shared/data/props.json';
import pickupsJson from '../../shared/data/pickups.json';
import trafficJson from '../../shared/data/traffic.json';
import worldgenJson from '../../shared/data/worldgen.json';
import { getTrafficTuning, initTuning } from '../../shared/src/tuning.js';
import { parseWorldgenParams } from '../../shared/src/world/params.js';
import { generateCity } from '../../shared/src/world/generate.js';
import { createCop, createGameState, createPed, type GameState } from '../../shared/src/sim/state.js';
import { insertEntity } from '../../shared/src/sim/entities.js';
import { step } from '../../shared/src/sim/step.js';
import { straightEastLane } from '../../shared/test/helpers.js';
import { TILE_SIZE } from '../../shared/src/world/types.js';

initTuning({
  player: playerTuning, vehicles: vehiclesJson, weapons: weaponsJson, police: policeJson,
  peds: pedsJson, props: propsJson, pickups: pickupsJson, traffic: trafficJson,
});
const map = generateCity(808, parseWorldgenParams(worldgenJson));

function ambientCar(state: GameState, id: number, at: { x: number; y: number }): GameState {
  const next = step(state, {}, [{ type: 'spawnVehicle', vehicleId: id, kind: 'car', x: at.x, y: at.y, heading: 0 }], map);
  const v = next.vehicles.byId[id]!;
  v.driverId = -1000 - id;
  v.speed = getTrafficTuning().cruiseSpeed;
  next.trafficDrivers[id] = { dir: 0, stuck: 0, panic: 0, mission: 'cruise', route: null, routeIdx: 0 };
  return next;
}

describe('natural: nothing pinned', () => {
  it('a downed cop in the lane vs a dead ped in the lane, over a full corpse window', () => {
    for (const off of [0, 200, 400]) {
    for (const kind of ['deadCop', 'deadPed'] as const) {
      const base = straightEastLane(map, 20);
      const lane = { x: base.x + off, y: base.y };
      let state = createGameState(101);
      state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'w' }], map);
      state = ambientCar(state, 900, lane);
      const ox = lane.x + 90;
      const oy = lane.y;
      if (kind === 'deadCop') insertEntity(state.cops, createCop(9001, { x: ox, y: oy }, 0));
      else {
        const ped = createPed(9001, { x: ox, y: oy }, 0);
        ped.mode = 'dead';
        ped.timer = Math.round(pedsJson.corpseSec * 30);
        insertEntity(state.peds, ped);
      }
      let passTick: number | null = null;
      let gone: number | null = null;
      let drift = 0;
      let horns = 0;
      let reversals = 0;
      let prevStuck = 0;
      for (let i = 0; i < 1500; i++) {
        const p = state.players.byId[1];
        if (p) p.pos = { x: lane.x + 90, y: lane.y - TILE_SIZE * 3 };
        const out: any[] = [];
        state = step(state, {}, [], map, out as never);
        for (const e of out) if (e.type === 'horn') horns++;
        const body = kind === 'deadCop' ? state.cops.byId[9001] : state.peds.byId[9001];
        if (body) drift = Math.max(drift, Math.hypot(body.pos.x - ox, body.pos.y - oy));
        else if (gone === null) gone = i;
        const v = state.vehicles.byId[900];
        if (!v) break;
        const s = state.trafficDrivers[900]?.stuck ?? 0;
        if (s < 0 && prevStuck >= 0) reversals++;
        prevStuck = s;
        if (passTick === null && v.pos.x > ox + 20) passTick = i;
      }
      const v = state.vehicles.byId[900];
      console.log('off=' + off, kind, JSON.stringify({
        passTick, bodyRemovedAtTick: gone, bodyDriftPx: Math.round(drift), horns, reversals,
        endX_minus_obstacle: v ? Math.round(v.pos.x - ox) : null,
        endSpeed: v ? Math.round(Math.abs(v.speed)) : null,
      }));
    }
    }
    expect(true).toBe(true);
  });
});
