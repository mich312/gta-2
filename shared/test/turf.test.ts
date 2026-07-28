import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import gangsJson from '../data/gangs.json';
import worldgenJson from '../data/worldgen.json';
import { MAX_GANGS } from '../src/constants.js';
import { newRespect } from '../src/sim/respect.js';
import { getTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { gangAt, gangName, rivalsOf } from '../src/world/turf.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { TILE_SIZE } from '../src/world/types.js';

const worldgen = parseWorldgenParams(worldgenJson);

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    pickups: pickupsJson,
    gangs: gangsJson,
  });
});

describe('turf (H1)', () => {
  it('every gang holds ground, and all of the map belongs to somebody', () => {
    for (const seed of [1, 42, 777, 6006, 90210]) {
      const map = generateCity(seed, worldgen);
      const held = new Map<number, number>();
      for (const cell of map.turfCells) held.set(cell, (held.get(cell) ?? 0) + 1);
      expect(held.get(0) ?? 0, `seed ${seed} has unclaimed ground`).toBe(0);
      for (const g of getTuning().gangs.gangs) {
        expect(held.get(g.id) ?? 0, `seed ${seed}: ${g.name} holds nothing`).toBeGreaterThan(0);
      }
    }
  });

  it('territory is contiguous, not confetti', () => {
    // The test that matters: a gang's cells must form (mostly) one blob. If
    // turf were rolled per cell it would pass every other check here and
    // still be unreadable on the ground.
    const map = generateCity(777, worldgen);
    const w = map.turfCellsWide;
    const h = Math.ceil(map.turfCells.length / w);
    let sameNeighbour = 0;
    let total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const me = map.turfCells[y * w + x];
        for (const [ox, oy] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx >= w || ny >= h) continue;
          total++;
          if (map.turfCells[ny * w + nx] === me) sameNeighbour++;
        }
      }
    }
    // Four gangs rolled per cell would agree with a neighbour ~25% of the
    // time. Real territory agrees almost always.
    expect(sameNeighbour / total).toBeGreaterThan(0.85);
  });

  it('the same seed always draws the same map', () => {
    const a = generateCity(4242, worldgen);
    const b = generateCity(4242, worldgen);
    expect(Array.from(a.turfCells)).toEqual(Array.from(b.turfCells));
  });

  it('gangAt agrees with the cell grid, and is safe off the edges', () => {
    const map = generateCity(777, worldgen);
    const cell = getTuning().gangs.cellTiles;
    expect(gangAt(map, cell * TILE_SIZE * 0.5, cell * TILE_SIZE * 0.5)).toBe(map.turfCells[0]);
    expect(gangAt(map, -50, -50)).toBe(0);
    expect(gangAt(map, map.widthPx * 4, map.heightPx * 4)).toBe(0);
  });

  it('rivalry is mutual', () => {
    for (const g of getTuning().gangs.gangs) {
      for (const r of rivalsOf(g.id)) {
        expect(rivalsOf(r), `${gangName(g.id)} vs ${gangName(r)}`).toContain(g.id);
      }
    }
  });

  it('some pedestrians belong to the gang whose ground they stand on', () => {
    const map = generateCity(777, worldgen);
    let state = createGameState(777);
    const cmds = map.pedSpawns.slice(0, 120).map((s, i) => ({
      type: 'spawnPed' as const,
      pedId: 100 + i,
      x: s.x,
      y: s.y,
    }));
    state = step(state, {}, cmds, map);
    const members = state.peds.ids
      .map((id) => state.peds.byId[id]!)
      .filter((p) => p.gangId !== 0);
    expect(members.length).toBeGreaterThan(0);
    // ...and every one of them belongs to the gang holding that ground.
    for (const m of members) expect(m.gangId).toBe(gangAt(map, m.pos.x, m.pos.y));
    // Most of the street is still ordinary people.
    expect(members.length).toBeLessThan(state.peds.ids.length / 2);
  });
});

describe('seven gangs (M3)', () => {
  it('all seven hold ground, and the whole map still belongs to somebody', () => {
    const map = generateCity(777, worldgen);
    const gangs = getTuning().gangs.gangs;
    expect(gangs.length).toBe(7);
    const held = new Set<number>();
    for (const cell of map.turfCells) if (cell !== 0) held.add(cell as number);
    for (const g of gangs) expect(held, g.name).toContain(g.id);
    // No unclaimed ground.
    for (const cell of map.turfCells) expect(cell).toBeGreaterThan(0);
  });

  it('rivalry is still mutual, all the way round', () => {
    // Asymmetric rivalry means a gang that shoots at you while you are
    // welcome on their doorstep. The data file is hand-written, so this is
    // the assertion that keeps it honest as it grows.
    const gangs = getTuning().gangs.gangs;
    for (const g of gangs) {
      for (const rivalId of g.rivals) {
        const rival = gangs.find((x) => x.id === rivalId);
        expect(rival, `gang ${g.id} names ${rivalId}`).toBeDefined();
        expect(rival!.rivals, `${rival!.name} vs ${g.name}`).toContain(g.id);
      }
    }
  });

  it('everybody has somebody to fall out with', () => {
    for (const g of getTuning().gangs.gangs) {
      expect(g.rivals.length, g.name).toBeGreaterThan(0);
      expect(g.rivals, g.name).not.toContain(g.id);
    }
  });

  it('respect is as wide as the roster, so nobody is unrepresentable', () => {
    // The respect array is fixed-width on the wire. A gang with no slot is a
    // gang whose opinion of you cannot be stored.
    expect(MAX_GANGS).toBeGreaterThanOrEqual(getTuning().gangs.gangs.length);
    const p = newRespect();
    expect(p.length).toBe(MAX_GANGS);
  });

  it('colours are distinct, because the turf map is how you read the city', () => {
    const colors = getTuning().gangs.gangs.map((g) => g.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
