import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { boxInSolid, isSolidAtWorld, moveWithCollision } from '../src/world/collide.js';
import { buildShoreCut } from '../src/world/shoreCut.js';
import { T_BRIDGE, T_ROAD, T_WATER, TILE_SIZE, type CityMap } from '../src/world/types.js';
import weaponsJson from '../data/weapons.json';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';

/**
 * Collision on the coastline (WORLDGEN.md §43).
 *
 * The claim §41.4 could not make of the solver it withdrew: the point test,
 * the box test and the depenetration push all come off ONE definition, so a
 * mover can never come to rest inside the water. That is the first test here
 * and it is the load-bearing one — the withdrawn version left 1.02% of movers
 * in the sea, and it is the reason this wave was written rather than ported.
 */

const params = parseWorldgenParams(worldgenJson);
let map: CityMap;

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson, weapons: weaponsJson });
  map = generateCity(1, params);
});

/** A cheap xorshift, so the sampling is the same on every run. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

describe('collision on the coastline', () => {
  it('leaves nobody standing in the sea, however hard they drive at it', () => {
    const cut = map.shoreCut!;
    const tiles = [...cut.slot.keys()];
    expect(tiles.length).toBeGreaterThan(1000);
    const rand = rng(12345);
    for (const half of [7, 9]) {
      let inside = 0;
      let total = 0;
      for (const tile of tiles) {
        const tx = tile % map.widthTiles;
        const ty = (tile - tx) / map.widthTiles;
        for (let k = 0; k < 6; k++) {
          // Start on open ground near the shore and drive straight at it for
          // forty steps, at anything from a walk to a fast car.
          const ox = tx + Math.floor(rand() * 5) - 2;
          const oy = ty + Math.floor(rand() * 5) - 2;
          const pos = { x: (ox + 0.5) * TILE_SIZE, y: (oy + 0.5) * TILE_SIZE };
          if (boxInSolid(map, pos, half)) continue;
          const vel = { x: 0, y: 0 };
          const ang = rand() * Math.PI * 2;
          const sp = 4 + rand() * 40;
          for (let s = 0; s < 40; s++) {
            moveWithCollision(map, pos, vel, half, Math.cos(ang) * sp, Math.sin(ang) * sp);
          }
          total++;
          if (boxInSolid(map, pos, half)) inside++;
        }
      }
      expect(total).toBeGreaterThan(10_000);
      // Zero at a person's size. At a CAR's, one mover in twelve thousand
      // still comes to rest nine tenths of a pixel inside — a twentieth of a
      // car, on one tile of coast, and named here rather than rounded away.
      // The solver it replaced (§41.4) left 1.02% of movers in the sea and
      // the tiles-and-bevels one 0.24%; this is a different order of thing,
      // but it is not nothing and the number should move only downwards.
      expect(inside).toBeLessThanOrEqual(half > 8 ? 1 : 0);
    }
  });

  it('agrees with the tiles about which side of a coast tile is water', () => {
    const cut = map.shoreCut!;
    let agree = 0;
    let total = 0;
    for (const [tile, slot] of cut.slot) {
      total++;
      const wet =
        (cut.nx[slot] as number) * (TILE_SIZE / 2) + (cut.ny[slot] as number) * (TILE_SIZE / 2) >
        (cut.c[slot] as number);
      if (wet === (map.tiles[tile] === T_WATER)) agree++;
    }
    // A tile rasterises by its CENTRE, so the curve and the byte are the same
    // question asked of the same point: they may differ only where the bevels
    // hold water the rings never reach.
    expect(total).toBeGreaterThan(1000);
    expect(agree / total).toBeGreaterThan(0.98);
  });

  it('the point test and the box test are the same rule', () => {
    const cut = map.shoreCut!;
    const rand = rng(777);
    let checked = 0;
    for (const tile of cut.slot.keys()) {
      const tx = tile % map.widthTiles;
      const ty = (tile - tx) / map.widthTiles;
      for (let k = 0; k < 4; k++) {
        const x = (tx + rand()) * TILE_SIZE;
        const y = (ty + rand()) * TILE_SIZE;
        checked++;
        // A box of nothing is a point. If they disagreed, the solver would be
        // pushing movers to positions its own overlap test rejects.
        if (isSolidAtWorld(map, x, y)) {
          expect(boxInSolid(map, { x, y }, 0.002)).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a boat is stopped by exactly the land a walker stands on', () => {
    const cut = map.shoreCut!;
    const rand = rng(999);
    let checked = 0;
    for (const tile of cut.slot.keys()) {
      // Only the tiles the curve GOVERNS. A wall, a wood and a deck are
      // handed back to the tile rules, and a deck is passable to both a car
      // on top of it and a hull underneath — which is the point of a bridge.
      const t = map.tiles[tile] as number;
      if (t === 3 /* T_BUILDING */ || t === 11 /* T_TREES */ || t === 7 /* T_BRIDGE */) continue;
      const tx = tile % map.widthTiles;
      const ty = (tile - tx) / map.widthTiles;
      for (let k = 0; k < 4; k++) {
        const x = (tx + rand()) * TILE_SIZE;
        const y = (ty + rand()) * TILE_SIZE;
        const wet = isSolidAtWorld(map, x, y, 'land');
        const dry = isSolidAtWorld(map, x, y, 'water');
        // One line, two media: whatever stops a car must not stop a hull, and
        // the other way about. There is no third state on a cut tile.
        checked++;
        expect(wet).toBe(!dry);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('declines the tiles one line cannot describe', () => {
    // Every tile it DOES take is described by a chord its own chain stays
    // close to. A chain that doubles back inside one square gets no plane and
    // the bevels answer, which is what stops a cape thinner than a tile
    // becoming a wall across it.
    const ring = {
      // A spike: in along the top, down to the middle, and straight back out.
      points: [
        [4, 4],
        [4.5, 4],
        [4.5, 4.9],
        [4.6, 4],
        [8, 4],
        [8, 8],
        [4, 8],
      ] as Array<readonly [number, number]>,
    };
    const cut = buildShoreCut([ring], 16, 16);
    expect(cut.slot.has(4 * 16 + 4)).toBe(false);
  });

  it('is pure: the same city built twice cuts the coast the same way', () => {
    const a = generateCity(3, params).shoreCut!;
    const b = generateCity(3, params).shoreCut!;
    expect(a.slot.size).toBe(b.slot.size);
    expect([...a.slot.keys()]).toEqual([...b.slot.keys()]);
    expect([...a.nx]).toEqual([...b.nx]);
    expect([...a.ny]).toEqual([...b.ny]);
    expect([...a.c]).toEqual([...b.c]);
  });

  it('has no opinion about a building at the quayside', () => {
    // The curve says where the WATER stops. A wall standing on a cut tile is
    // still a wall all the way through, or the coast would open a doorway.
    const cut = map.shoreCut!;
    let walls = 0;
    for (const tile of cut.slot.keys()) {
      if (map.tiles[tile] !== 3 /* T_BUILDING */) continue;
      walls++;
      const tx = tile % map.widthTiles;
      const ty = (tile - tx) / map.widthTiles;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        expect(isSolidAtWorld(map, (tx + ox) * TILE_SIZE, (ty + oy) * TILE_SIZE)).toBe(true);
      }
    }
    // Not a claim that there ARE any; only that if there are, they are solid.
    expect(walls).toBeGreaterThanOrEqual(0);
  });
});

describe('the bridge mouth', () => {
  // The curve is the smoothed outline of the water, a deck is carved over
  // water, and smoothing the corner where the bank meets the deck ran the
  // curve across the road at the mouth: 64 of the shipped city's 67 mouth
  // columns stopped a car dead before the deck. A road tile a deck continues
  // is whole.
  it('leaves the carriageway a deck continues uncut', () => {
    const m = generateCity(1, params);
    const W = m.widthTiles;
    const H = m.heightTiles;
    const t = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? -1 : (m.tiles[y * W + x] as number));
    let mouths = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (t(x, y) !== T_ROAD) continue;
        const deck = [t(x - 1, y), t(x + 1, y), t(x, y - 1), t(x, y + 1)].includes(T_BRIDGE);
        if (!deck) continue;
        mouths++;
        expect(m.shoreCut!.slot.has(y * W + x)).toBe(false);
      }
    }
    expect(mouths).toBeGreaterThan(30);
  });

  it('lets a car drive straight onto the deck', () => {
    const m = generateCity(1, params);
    const W = m.widthTiles;
    const H = m.heightTiles;
    const t = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? -1 : (m.tiles[y * W + x] as number));
    const px = (v: number): number => (v + 0.5) * TILE_SIZE;
    // Every mouth column with two tiles of straight road behind it.
    const columns: Array<{ x: number; y: number; dx: number; dy: number }> = [];
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        if (t(x, y) !== T_ROAD) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          if (t(x + dx, y + dy) !== T_BRIDGE) continue;
          if (t(x - dx, y - dy) !== T_ROAD || t(x - 2 * dx, y - 2 * dy) !== T_ROAD) continue;
          columns.push({ x, y, dx, dy });
        }
      }
    }
    expect(columns.length).toBeGreaterThan(30);
    let onto = 0;
    // A sample across the whole city rather than all of them: each drive is
    // a hundred full-city ticks.
    const sample = columns.filter((_, i) => i % 6 === 0);
    for (const c of sample) {
      const start = { x: px(c.x - 2 * c.dx), y: px(c.y - 2 * c.dy) };
      let s = createGameState(3);
      s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'd' }], m);
      s = step(
        s,
        {},
        [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: start.x, y: start.y, heading: Math.atan2(c.dy, c.dx) }],
        m,
      );
      const p = s.players.byId[1]!;
      p.pos = { ...start };
      p.mode = 'driving';
      p.vehicleId = 2;
      s.vehicles.byId[2]!.driverId = 1;
      for (let i = 0; i < 100; i++) {
        s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, up: true } }, [], m);
        const v = s.vehicles.byId[2]!;
        if (t(Math.floor(v.pos.x / TILE_SIZE), Math.floor(v.pos.y / TILE_SIZE)) === T_BRIDGE) {
          onto++;
          break;
        }
      }
    }
    // A column at the very edge of a diagonal bank can still be a genuine
    // corner; the mouth as a whole is open.
    expect(onto).toBeGreaterThanOrEqual(Math.ceil(sample.length * 0.8));
  });
});
