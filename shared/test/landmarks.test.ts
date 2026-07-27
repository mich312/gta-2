import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { boxInSolid } from '../src/world/collide.js';
import { T_WATER, TILE_SIZE } from '../src/world/types.js';
import { PLAYER_RADIUS } from '../src/constants.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  police: policeJson,
  peds: pedsJson,
  props: propsJson,
  pickups: pickupsJson,
  traffic: { ...trafficJson, count: 0 },
});

const params = parseWorldgenParams(worldgenJson);
const SEEDS = [1, 7, 42, 1234, 90210];

describe('landmarks', () => {
  it('every city gets named landmarks, including hospitals', () => {
    for (const seed of SEEDS) {
      const m = generateCity(seed, params);
      expect(m.landmarks.length).toBeGreaterThan(2);
      expect(m.hospitals.length).toBeGreaterThan(0);
      for (const l of m.landmarks) {
        expect(l.name.length).toBeGreaterThan(0);
        expect(l.w).toBeGreaterThanOrEqual(3);
        expect(l.h).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('they are bigger than ordinary buildings', () => {
    const m = generateCity(7, params);
    const areas = m.buildings.map((b) => b.w * b.h).sort((a, b) => a - b);
    const median = areas[Math.floor(areas.length / 2)] as number;
    for (const l of m.landmarks) {
      expect(l.w * l.h).toBeGreaterThan(median);
    }
  });

  it('none of them stands in the river', () => {
    for (const seed of SEEDS) {
      const m = generateCity(seed, params);
      for (const l of m.landmarks) {
        for (let ty = l.y; ty < l.y + l.h; ty++) {
          for (let tx = l.x; tx < l.x + l.w; tx++) {
            expect(m.tiles[ty * m.widthTiles + tx]).not.toBe(T_WATER);
          }
        }
      }
    }
  });

  it('hospital doors are somewhere a player can actually stand', () => {
    for (const seed of SEEDS) {
      const m = generateCity(seed, params);
      for (const h of m.hospitals) {
        expect(boxInSolid(m, h, PLAYER_RADIUS)).toBe(false);
      }
    }
  });

  it('are a pure function of the seed', () => {
    expect(generateCity(42, params).landmarks).toEqual(generateCity(42, params).landmarks);
  });
});

describe('respawning at a hospital', () => {
  const map = generateCity(7, params);

  it('wakes the dead at the NEAREST hospital, not a random kerb', () => {
    let state = createGameState(3);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);

    // Die next to a chosen hospital and check you come back to that one.
    const target = map.hospitals[map.hospitals.length - 1]!;
    const p = state.players.byId[1]!;
    p.pos = { x: target.x + 40, y: target.y + 40 };
    p.mode = 'dead';
    p.health = 0;

    state = step(state, {}, [{ type: 'respawnPlayer', playerId: 1, loadout: [] }], map);
    const back = state.players.byId[1]!;
    expect(back.mode).toBe('foot');

    let nearest = Infinity;
    let chosen = Infinity;
    for (const h of map.hospitals) {
      const d = Math.hypot(h.x - back.pos.x, h.y - back.pos.y);
      nearest = Math.min(nearest, d);
      if (h === target) chosen = d;
    }
    expect(chosen).toBeLessThan(1);
    expect(nearest).toBeLessThan(1);
  });

  it('dying far from one still puts you at a hospital, not in the void', () => {
    let state = createGameState(4);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const p = state.players.byId[1]!;
    p.pos = { x: TILE_SIZE * 2, y: TILE_SIZE * 2 };
    p.mode = 'dead';
    state = step(state, {}, [{ type: 'respawnPlayer', playerId: 1, loadout: [] }], map);
    const back = state.players.byId[1]!;
    const onAHospital = map.hospitals.some(
      (h) => Math.hypot(h.x - back.pos.x, h.y - back.pos.y) < 1,
    );
    expect(onAHospital).toBe(true);
    expect(boxInSolid(map, back.pos, PLAYER_RADIUS)).toBe(false);
  });
});
