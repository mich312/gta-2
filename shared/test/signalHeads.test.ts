import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { CARDINALS, RIGHT_STEP, drivableTile } from '../src/sim/roadgrid.js';
import { TILE_SIZE, type CityMap } from '../src/world/types.js';

const map: CityMap = generateCity(4242, parseWorldgenParams(worldgenJson));
const junctions = map.junctions!;

/** The tile a head sits on, back out of its world position. */
function tileOf(head: { x: number; y: number }): [number, number] {
  return [Math.floor(head.x / TILE_SIZE), Math.floor(head.y / TILE_SIZE)];
}

/** Junction this tile approaches travelling `dirIdx`, or -1. */
function approaches(tx: number, ty: number, dirIdx: number): number {
  const w = map.widthTiles;
  const h = map.heightTiles;
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return -1;
  if (!drivableTile(map, tx, ty) || junctions.idOf[ty * w + tx] !== -1) return -1;
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  const nx = tx + dx;
  const ny = ty + dy;
  if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1;
  return junctions.idOf[ny * w + nx] as number;
}

describe('signal heads', () => {
  it('puts one head on each arm, not one per tile of tarmac', () => {
    // The bug this replaces: a head per approach tile, so a four-tile arterial
    // arm carried four lights strung across the carriageway and a crossroads
    // read as a string of fairy lights.
    const perArm = new Map<string, number>();
    for (const head of junctions.heads) {
      const key = `${head.junctionId}:${head.dirIdx}`;
      perArm.set(key, (perArm.get(key) ?? 0) + 1);
    }
    expect(junctions.heads.length).toBeGreaterThan(0);
    expect(Math.max(...perArm.values())).toBe(1);
  });

  it('stands each head on an approach tile of the junction it shows', () => {
    for (const head of junctions.heads) {
      const [tx, ty] = tileOf(head);
      expect(approaches(tx, ty, head.dirIdx), `head at ${tx},${ty}`).toBe(head.junctionId);
    }
  });

  it('stands them on the kerb of the lanes going in, not the ones coming out', () => {
    // Driving on the right, the light you obey is on the near right of your
    // approach. Half the old heads stood over the outbound lanes, governing
    // traffic that had already left the junction.
    for (const head of junctions.heads) {
      const [tx, ty] = tileOf(head);
      const [rx, ry] = RIGHT_STEP[head.dirIdx] as readonly [number, number];
      // Nothing further right belongs to this approach: this is the kerb tile.
      expect(approaches(tx + rx, ty + ry, head.dirIdx), `head at ${tx},${ty}`).not.toBe(
        head.junctionId,
      );
    }
  });

  it('leaves no arm of any junction dark', () => {
    // Every approach tile in the city must be covered by exactly one head, or
    // fewer lights has quietly become fewer *governed* junctions.
    const armsWithTraffic = new Set<string>();
    for (let ty = 0; ty < map.heightTiles; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
          const id = approaches(tx, ty, dirIdx);
          if (id !== -1) armsWithTraffic.add(`${id}:${dirIdx}`);
        }
      }
    }
    const armsWithHeads = new Set(junctions.heads.map((h) => `${h.junctionId}:${h.dirIdx}`));
    expect(armsWithHeads.size).toBe(armsWithTraffic.size);
    for (const arm of armsWithTraffic) expect(armsWithHeads.has(arm)).toBe(true);
  });

  it('gives a crossroads four lights and a T-junction three', () => {
    const perJunction = new Map<number, number>();
    for (const head of junctions.heads) {
      perJunction.set(head.junctionId, (perJunction.get(head.junctionId) ?? 0) + 1);
    }
    const counts = [...perJunction.values()];
    // A junction has four arms at most, and the head is the arm. Before this,
    // one crossroads on an arterial carried fourteen.
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
    // Recursive subdivision makes far more T-junctions than crossroads, but
    // both have to be there — all-threes would mean an arm was being dropped.
    expect(counts.filter((c) => c === 4).length).toBeGreaterThan(20);
    expect(counts.filter((c) => c === 3).length).toBeGreaterThan(20);
  });
});
