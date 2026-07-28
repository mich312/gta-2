import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from 'shared';
import { laneCentreInTile } from '../src/render/tiles.js';

/**
 * Where the painted centre line ends up, in world px from the low edge of the
 * carriageway — the number the sim's lane model is expressed in.
 */
function paintedCentre(width: number): number {
  for (let index = 0; index < width; index++) {
    const at = laneCentreInTile(width, index);
    if (at !== null) return (index + at) * TILE_SIZE;
  }
  throw new Error(`no centre line drawn for a ${width}-tile road`);
}

describe('laneCentreInTile', () => {
  it('splits every carriageway down the middle', () => {
    // The bug this replaces: a three-tile road — every secondary in the city —
    // had its line on the first tile boundary, so one side was a lane and a
    // half and the other was half of one.
    for (let width = 2; width <= 6; width++) {
      expect(paintedCentre(width), `${width}-tile road`).toBe((width / 2) * TILE_SIZE);
    }
  });

  it('draws the line on exactly one tile of the run', () => {
    for (let width = 2; width <= 6; width++) {
      let drawn = 0;
      for (let index = 0; index < width; index++) {
        if (laneCentreInTile(width, index) !== null) drawn++;
      }
      expect(drawn, `${width}-tile road`).toBe(1);
    }
  });

  it('keeps the mark inside the tile that owns it', () => {
    for (let width = 2; width <= 6; width++) {
      for (let index = 0; index < width; index++) {
        const at = laneCentreInTile(width, index);
        if (at === null) continue;
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThanOrEqual(1);
      }
    }
  });

  it('leaves a single-tile lane unmarked', () => {
    // Nothing to divide: an alley one tile across is shared, and the lane
    // model says the same thing — `laneOptions` returns one lane down the
    // middle for a one-tile road.
    expect(laneCentreInTile(1, 0)).toBeNull();
  });
});
