import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { makeFields } from '../src/world/fields.js';
import { generateCity } from '../src/world/generate.js';
import { isSolidTile } from '../src/world/collide.js';
import {
  T_BANK,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
} from '../src/world/types.js';

const params = parseWorldgenParams(worldgenJson);
const SEEDS = [7, 42, 1234];

describe('the countryside (WORLDGEN.md §11.1 A1)', () => {
  it('exists, is de-gridded, and has forest', () => {
    for (const seed of SEEDS) {
      const m = generateCity(seed, params);
      const rural = m.blocks.filter((b) => b.rural);
      expect(rural.length, `seed ${seed} has no countryside`).toBeGreaterThan(0);
      let trees = 0;
      for (const t of m.tiles) if (t === T_TREES) trees++;
      expect(trees, `seed ${seed} has no forest`).toBeGreaterThan(50);
      // No kerbs in the country: a rural block contains no sidewalk tile.
      for (const b of rural) {
        for (let ty = Math.max(0, b.y); ty < Math.min(m.heightTiles, b.y + b.h); ty++) {
          for (let tx = Math.max(0, b.x); tx < Math.min(m.widthTiles, b.x + b.w); tx++) {
            expect(
              m.tiles[ty * m.widthTiles + tx],
              `seed ${seed}: sidewalk in rural block at (${tx}, ${ty})`,
            ).not.toBe(T_SIDEWALK);
          }
        }
      }
    }
  });

  it('forest never crowds a lane: trees keep one tile of clearance from roads', () => {
    for (const seed of SEEDS) {
      const m = generateCity(seed, params);
      for (let ty = 1; ty < m.heightTiles - 1; ty++) {
        for (let tx = 1; tx < m.widthTiles - 1; tx++) {
          if (m.tiles[ty * m.widthTiles + tx] !== T_TREES) continue;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            expect(
              m.tiles[(ty + dy) * m.widthTiles + (tx + dx)],
              `seed ${seed}: tree against road at (${tx}, ${ty})`,
            ).not.toBe(T_ROAD);
          }
        }
      }
    }
  });

  it('woods are solid on land and to hulls; sand is open ground', () => {
    const m = generateCity(7, params);
    let checkedTrees = 0;
    let checkedSand = 0;
    for (let ty = 0; ty < m.heightTiles; ty++) {
      for (let tx = 0; tx < m.widthTiles; tx++) {
        const t = m.tiles[ty * m.widthTiles + tx];
        if (t === T_TREES && checkedTrees < 200) {
          checkedTrees++;
          expect(isSolidTile(m, tx, ty, 'land')).toBe(true);
          expect(isSolidTile(m, tx, ty, 'water')).toBe(true);
        }
        if (t === T_SAND && checkedSand < 200) {
          checkedSand++;
          expect(isSolidTile(m, tx, ty, 'land')).toBe(false);
          expect(isSolidTile(m, tx, ty, 'water')).toBe(true);
        }
      }
    }
    expect(checkedTrees).toBeGreaterThan(0);
  });
});

describe('shores by density (WORLDGEN.md §11.1 A2)', () => {
  it('the city gets the quay, the country gets the beach', () => {
    for (const seed of SEEDS) {
      const m = generateCity(seed, params);
      const fields = makeFields(seed, params);
      let banks = 0;
      let sands = 0;
      for (let ty = 0; ty < m.heightTiles; ty++) {
        for (let tx = 0; tx < m.widthTiles; tx++) {
          const t = m.tiles[ty * m.widthTiles + tx];
          const d = fields.density(params.windowX + tx, params.windowY + ty);
          if (t === T_BANK) {
            banks++;
            expect(d, `seed ${seed}: quay outside the city at (${tx}, ${ty})`).toBeGreaterThanOrEqual(
              params.fields.commercial,
            );
          } else if (t === T_SAND) {
            sands++;
            expect(d, `seed ${seed}: beach in the city core at (${tx}, ${ty})`).toBeLessThan(
              params.fields.commercial,
            );
          }
        }
      }
      expect(sands, `seed ${seed} has no beach`).toBeGreaterThan(20);
    }
  });
});
