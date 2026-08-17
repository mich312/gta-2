import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { boxInSolid, isSolidAtWorld, moveWithCollision } from '../src/world/collide.js';
import { buildShoreCut } from '../src/world/shoreCut.js';
import { T_BRIDGE, T_WATER, TILE_SIZE, type CityMap } from '../src/world/types.js';

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
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
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
    const W = map.widthTiles;
    /** Is this tile within three of a bridge deck? */
    const atAnAbutment = (tile: number): boolean => {
      const x = tile % W;
      const y = (tile - x) / W;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= map.heightTiles) continue;
          if (map.tiles[ny * W + nx] === T_BRIDGE) return true;
        }
      }
      return false;
    };
    let agree = 0;
    let total = 0;
    let abutment = 0;
    let abutmentDisagree = 0;
    for (const [tile, slot] of cut.slot) {
      const wet =
        (cut.nx[slot] as number) * (TILE_SIZE / 2) + (cut.ny[slot] as number) * (TILE_SIZE / 2) >
        (cut.c[slot] as number);
      const same = wet === (map.tiles[tile] === T_WATER);
      // Where a deck lands, the tiles are the abutment's and not the coast's:
      // the bank is cut back for the ramp, the bevels hold water the rings
      // never reach, and the curve is still describing the shoreline that was
      // there first. Counted apart rather than excused — restoring the three
      // missing crossings took the whole-map figure from 98.4% to 97.7%, and
      // 90 of the 154 disagreeing tiles are within three of a deck.
      if (atAnAbutment(tile)) {
        abutment++;
        if (!same) abutmentDisagree++;
        continue;
      }
      total++;
      if (same) agree++;
    }
    // A tile rasterises by its CENTRE, so the curve and the byte are the same
    // question asked of the same point: away from a deck they may differ only
    // where the bevels hold water the rings never reach.
    expect(total).toBeGreaterThan(1000);
    expect(agree / total).toBeGreaterThan(0.98);
    // And the abutments do not get to be a hiding place. Measured: 450 tiles
    // near a deck, 90 of them disagreeing — one in five, which is what a
    // landfall costs. Four in five still agree, and if that stops being true
    // something is wrong with how decks meet the shore.
    expect(abutment).toBeGreaterThan(100);
    expect(abutmentDisagree / abutment).toBeLessThan(0.25);
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
