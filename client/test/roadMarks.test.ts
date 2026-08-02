import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from 'shared';
import { laneCentreInTile, laneDashOffset } from '../src/render/tiles.js';

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

describe('laneDashOffset', () => {
  const TD = TILE_SIZE * 2; // device px per tile at RENDER_SCALE 2
  const t = 2; // dash thickness, 1 world px

  it('keeps the whole dash inside the tile that draws it', () => {
    // The bug this pins down: an even-width carriageway centres on the tile
    // BOUNDARY (`laneCentreInTile` = 1.0), and the unclamped offset put the
    // dash's far half into the neighbouring tile, where the neighbour's base
    // fill erased it — arterial centre lines drawn at half thickness.
    for (let width = 2; width <= 6; width++) {
      for (let index = 0; index < width; index++) {
        const centre = laneCentreInTile(width, index);
        if (centre === null) continue;
        const at = laneDashOffset(centre, TD, t);
        expect(at, `${width}-tile road`).toBeGreaterThanOrEqual(0);
        expect(at + t, `${width}-tile road`).toBeLessThanOrEqual(TD);
      }
    }
  });

  it('still centres an odd-width road exactly', () => {
    // The clamp must be a no-op where nothing needs clamping: a three-tile
    // road's centre is mid-tile, and the dash straddles it symmetrically.
    expect(laneDashOffset(0.5, TD, t)).toBe(TD / 2 - t / 2);
  });
});
