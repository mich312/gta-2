import { describe, expect, it } from 'vitest';
import {
  diagonalCentreTile,
  diagonalMark,
  diagonalRoadDir,
  laneCentreInTile,
  type IsRoad,
} from '../src/world/marks.js';

/** A band of road around the line x = y: the shape a carved 45° arterial
 *  rasterises to, minus the stair jitter. `halfWidth` in tiles. */
const seBand =
  (halfWidth: number): IsRoad =>
  (tx, ty) =>
    Math.abs(tx - ty) <= halfWidth;

/** The other diagonal: road around x + y = 40. */
const neBand =
  (halfWidth: number): IsRoad =>
  (tx, ty) =>
    Math.abs(tx + ty - 40) <= halfWidth;

/** A shallower diagonal — y ≈ 0.8x — the way a CURVED arterial actually
 *  crosses a neighbourhood: not exactly 45°, stair steps of uneven length. */
const shallowBand: IsRoad = (tx, ty) => Math.abs(ty - 0.8 * tx) <= 2;

/** An ordinary horizontal street, for the negative case. */
const horizontalRoad: IsRoad = (_tx, ty) => ty >= 10 && ty <= 12;

describe('diagonalRoadDir', () => {
  it('reads a down-right band as se and an up-right band as ne', () => {
    expect(diagonalRoadDir(seBand(2), 20, 20)).toBe('se');
    expect(diagonalRoadDir(neBand(2), 20, 20)).toBe('ne');
  });

  it('answers null on an axis-aligned street', () => {
    // The cardinal path owns these; a diagonal verdict here would double-mark.
    expect(diagonalRoadDir(horizontalRoad, 20, 11)).toBeNull();
  });

  it('quantises a shallow diagonal to the nearer 45°', () => {
    expect(diagonalRoadDir(shallowBand, 20, 16)).toBe('se');
  });
});

describe('diagonalCentreTile', () => {
  it('names exactly one tile per row of a 45° band', () => {
    const road = seBand(2); // 5 tiles wide per row
    for (let ty = 15; ty <= 25; ty++) {
      const named: number[] = [];
      for (let tx = ty - 4; tx <= ty + 4; tx++) {
        if (road(tx, ty) && diagonalCentreTile(road, tx, ty)) named.push(tx);
      }
      expect(named, `row ${ty}`).toEqual([ty]); // dead centre of an odd row
    }
  });

  it('steps the named tiles along the band as a single chain', () => {
    // Two parallel chains half a diagonal apart is the failure mode this
    // module replaced (a normal-walk only ever sees its own parity lattice);
    // the named tiles must advance with the band, one per row.
    const road = seBand(2);
    const chain: Array<[number, number]> = [];
    for (let ty = 15; ty <= 25; ty++) {
      for (let tx = ty - 4; tx <= ty + 4; tx++) {
        if (road(tx, ty) && diagonalCentreTile(road, tx, ty)) chain.push([tx, ty]);
      }
    }
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]![0] - chain[i - 1]![0], `step ${i}`).toBe(1);
      expect(chain[i]![1] - chain[i - 1]![1], `step ${i}`).toBe(1);
    }
  });
});

describe('diagonalMark', () => {
  it('marks only centre tiles, with the band direction', () => {
    const road = seBand(2);
    expect(diagonalMark(road, 20, 20)).toBe('se');
    expect(diagonalMark(road, 21, 20)).toBeNull(); // off-centre: bare
    expect(diagonalMark(neBand(2), 20, 20)).toBe('ne');
  });
});

describe('laneCentreInTile (shared home)', () => {
  it('keeps the client rule: one tile per run, centre in (0, 1]', () => {
    // The full behaviour is pinned in client/test/roadMarks.test.ts against
    // the re-export; this is the smoke test that the shared move kept it.
    expect(laneCentreInTile(3, 1)).toBe(0.5);
    expect(laneCentreInTile(4, 1)).toBe(1);
    expect(laneCentreInTile(1, 0)).toBeNull();
  });
});
