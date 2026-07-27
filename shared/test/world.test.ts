import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { boxInSolid, isSolidTile, moveWithCollision } from '../src/world/collide.js';
import {
  T_BUILDING,
  T_FLOOR,
  T_ROAD,
  T_SIDEWALK,
  TILE_SIZE,
  type CityMap,
} from '../src/world/types.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { PLAYER_RADIUS } from '../src/constants.js';

const params = parseWorldgenParams(worldgenJson);

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

function tileCounts(map: CityMap): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of map.tiles) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

describe('world generation', () => {
  it('is a pure function of the seed (identical twice, different across seeds)', () => {
    const a = generateCity(1111, params);
    const b = generateCity(1111, params);
    expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(true);
    expect(a.shops).toEqual(b.shops);
    expect(a.playerSpawns).toEqual(b.playerSpawns);
    expect(a.vehicleSpawns).toEqual(b.vehicleSpawns);

    const c = generateCity(2222, params);
    expect(Buffer.from(a.tiles).equals(Buffer.from(c.tiles))).toBe(false);
  });

  it('produces a real city: roads, sidewalks, buildings, all districts in use', () => {
    for (const seed of [7, 8, 9]) {
      const map = generateCity(seed, params);
      const counts = tileCounts(map);
      const total = map.widthTiles * map.heightTiles;
      expect((counts.get(T_ROAD) ?? 0) / total).toBeGreaterThan(0.08);
      expect((counts.get(T_SIDEWALK) ?? 0) / total).toBeGreaterThan(0.03);
      expect((counts.get(T_BUILDING) ?? 0) / total).toBeGreaterThan(0.12);
      expect(map.buildings.length).toBeGreaterThan(100);
      const districtsUsed = new Set(map.blocks.map((b) => b.district));
      expect(districtsUsed.size).toBeGreaterThanOrEqual(4);
    }
  });

  it('meets shop quotas with walkable doorways', () => {
    const map = generateCity(31337, params);
    const guns = map.shops.filter((s) => s.kind === 'gun');
    const clothes = map.shops.filter((s) => s.kind === 'clothing');
    expect(guns.length).toBeGreaterThanOrEqual(params.shopQuota.gun);
    expect(clothes.length).toBeGreaterThanOrEqual(params.shopQuota.clothing);
    for (const s of map.shops) {
      expect(isSolidTile(map, s.doorX, s.doorY)).toBe(false);
    }
  });

  it('every shop has a room you can walk into from its door', () => {
    for (const seed of [31337, 808, 4, 99]) {
      const map = generateCity(seed, params);
      expect(map.shops.length).toBeGreaterThan(0);
      for (const s of map.shops) {
        const r = s.interior;
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);

        // The room is floor, and floor is walkable.
        for (let ty = r.y; ty < r.y + r.h; ty++) {
          for (let tx = r.x; tx < r.x + r.w; tx++) {
            expect(map.tiles[ty * map.widthTiles + tx]).toBe(T_FLOOR);
            expect(isSolidTile(map, tx, ty)).toBe(false);
          }
        }
        // The doorway is punched through the wall ring, not left as wall...
        expect(map.tiles[s.entryY * map.widthTiles + s.entryX]).toBe(T_FLOOR);
        // ...and it is genuinely a way in: the door tile outside, the doorway
        // and the room are one connected walkable region.
        const seen = new Set<number>();
        const queue = [[s.doorX, s.doorY] as [number, number]];
        let reachedRoom = false;
        while (queue.length > 0 && !reachedRoom) {
          const [tx, ty] = queue.shift() as [number, number];
          const key = ty * map.widthTiles + tx;
          if (seen.has(key) || isSolidTile(map, tx, ty)) continue;
          seen.add(key);
          if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) {
            reachedRoom = true;
            break;
          }
          // Stay inside the footprint plus its doorstep, so this is a test of
          // the doorway rather than of the pavement network.
          if (Math.abs(tx - s.doorX) > r.w + 2 || Math.abs(ty - s.doorY) > r.h + 2) continue;
          queue.push([tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]);
        }
        expect(reachedRoom).toBe(true);
      }
    }
  });

  it('a respray garage is wide enough to drive into', () => {
    // A car's collision box is 18 px across and a tile is 16, so a one-tile
    // doorway is not a doorway for a vehicle.
    const map = generateCity(808, params);
    const sprays = map.shops.filter((s) => s.kind === 'spray');
    expect(sprays.length).toBeGreaterThan(0);
    const drivable = sprays.filter((s) => {
      const along: Array<[number, number]> =
        s.entryY < s.interior.y || s.entryY >= s.interior.y + s.interior.h
          ? [
              [s.entryX - 1, s.entryY],
              [s.entryX + 1, s.entryY],
            ]
          : [
              [s.entryX, s.entryY - 1],
              [s.entryX, s.entryY + 1],
            ];
      return along.some(([tx, ty]) => map.tiles[ty * map.widthTiles + tx] === T_FLOOR);
    });
    expect(drivable.length).toBeGreaterThan(0);
  });

  it('player spawns are walkable, inside the map, and spread apart', () => {
    const map = generateCity(555, params);
    expect(map.playerSpawns.length).toBeGreaterThanOrEqual(8);
    for (const p of map.playerSpawns) {
      expect(boxInSolid(map, p, PLAYER_RADIUS)).toBe(false);
    }
    for (let i = 0; i < map.playerSpawns.length; i++) {
      for (let j = i + 1; j < map.playerSpawns.length; j++) {
        const a = map.playerSpawns[i]!;
        const b = map.playerSpawns[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d).toBeGreaterThanOrEqual((params.playerSpawnMinDist * TILE_SIZE) / 2);
      }
    }
  });
});

describe('collision', () => {
  it('a player can never end up inside a building, whatever they mash', () => {
    const map = generateCity(4040, params);
    let state = createGameState(4040);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    // Mash directions in a fixed pattern for 20 sim-seconds.
    for (let t = 0; t < 600; t++) {
      const phase = Math.floor(t / 7) % 8;
      state = step(
        state,
        {
          1: {
            ...NULL_INPUT,
            seq: t + 1,
            tick: t,
            up: phase < 3,
            right: phase % 3 === 0,
            down: phase >= 4,
            left: phase % 3 === 2,
          },
        },
        [],
        map,
      );
      expect(boxInSolid(map, state.players.byId[1]!.pos, PLAYER_RADIUS)).toBe(false);
    }
  });

  it('moveWithCollision clamps flush against a solid tile and zeroes velocity', () => {
    const map = generateCity(66, params);
    // Find a building tile with open space to its left.
    let found: { tx: number; ty: number } | null = null;
    for (let ty = 1; ty < map.heightTiles - 1 && !found; ty++) {
      for (let tx = 1; tx < map.widthTiles - 1 && !found; tx++) {
        if (isSolidTile(map, tx, ty) && !isSolidTile(map, tx - 1, ty)) found = { tx, ty };
      }
    }
    expect(found).not.toBeNull();
    const { tx, ty } = found!;
    const pos = { x: (tx - 1) * TILE_SIZE + 8, y: ty * TILE_SIZE + 8 };
    const vel = { x: 100, y: 0 };
    moveWithCollision(map, pos, vel, PLAYER_RADIUS, 50, 0); // ram right into the wall
    expect(vel.x).toBe(0);
    expect(pos.x).toBeLessThanOrEqual(tx * TILE_SIZE - PLAYER_RADIUS);
    expect(boxInSolid(map, pos, PLAYER_RADIUS)).toBe(false);
  });
});
