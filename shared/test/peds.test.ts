import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimCommand } from '../src/sim/commands.js';
import { hashState } from '../src/net/hash.js';
import { boxInSolid } from '../src/world/collide.js';

const map = generateCity(8080, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
  });
});

function spawnPeds(state: GameState, count: number): GameState {
  const cmds: SimCommand[] = [];
  for (let i = 0; i < count; i++) {
    const spot = map.pedSpawns[i * 3]!;
    cmds.push({ type: 'spawnPed', pedId: 1000 + i, x: spot.x, y: spot.y });
  }
  return step(state, {}, cmds, map);
}

describe('pedestrians', () => {
  it('the map generates plenty of ped spawn points', () => {
    expect(map.pedSpawns.length).toBeGreaterThan(400);
  });

  it('200 peds wander without ever clipping into buildings, deterministically', () => {
    const run = (): { state: GameState; hash: number } => {
      let state = createGameState(1);
      state = spawnPeds(state, 200);
      for (let t = 0; t < 300; t++) {
        state = step(state, {}, [], map);
      }
      return { state, hash: hashState(state) };
    };
    const a = run();
    expect(a.state.peds.ids.length).toBe(200);
    for (const id of a.state.peds.ids) {
      expect(boxInSolid(map, a.state.peds.byId[id]!.pos, 5)).toBe(false);
    }
    // Someone actually moved.
    const first = a.state.peds.byId[a.state.peds.ids[0]!]!;
    const spawn = map.pedSpawns[0]!;
    expect(Math.hypot(first.pos.x - spawn.x, first.pos.y - spawn.y)).toBeGreaterThan(0);
    expect(run().hash).toBe(a.hash);
  });

  it('gunfire scatters the crowd', () => {
    let state = createGameState(2);
    state = step(
      state,
      {},
      [{ type: 'spawnPlayer', playerId: 1, name: 'shooter', loadout: [{ weaponId: 'pistol', ammo: 90 }] }],
      map,
    );
    const p1 = state.players.byId[1]!;
    // Put a handful of peds right around the shooter.
    const cmds: SimCommand[] = [];
    for (let i = 0; i < 5; i++) {
      cmds.push({ type: 'spawnPed', pedId: 500 + i, x: p1.pos.x + 40 + i * 15, y: p1.pos.y + 30 });
    }
    state = step(state, {}, cmds, map);
    const fire: InputIntent = { ...NULL_INPUT, seq: 1, tick: 1, fire: true, aimAngle: -1.2 };
    state = step(state, { 1: fire }, [], map);
    const fleeing = state.peds.ids.filter((id) => state.peds.byId[id]!.mode === 'flee');
    expect(fleeing.length).toBeGreaterThan(0);
  });

  it('killing a pedestrian is a crime', () => {
    let state = createGameState(3);
    state = step(
      state,
      {},
      [{ type: 'spawnPlayer', playerId: 1, name: 'monster', loadout: [{ weaponId: 'shotgun', ammo: 40 }] }],
      map,
    );
    const p1 = state.players.byId[1]!;
    state = step(state, {}, [{ type: 'spawnPed', pedId: 900, x: p1.pos.x + 30, y: p1.pos.y }], map);
    let seq = 1;
    for (let i = 0; i < 120 && state.peds.ids.length > 0; i++) {
      const ped = state.peds.ids[0] !== undefined ? state.peds.byId[state.peds.ids[0]]! : null;
      const aim = ped ? Math.atan2(ped.pos.y - p1.pos.y, ped.pos.x - p1.pos.x) : 0;
      state = step(state, { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: aim } }, [], map);
    }
    expect(state.peds.ids.length).toBe(0);
    expect(state.players.byId[1]!.heat).toBeGreaterThanOrEqual(75); // 80 minus a few ticks of decay
  });
});
