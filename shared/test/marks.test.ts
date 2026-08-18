import { describe, expect, it } from 'vitest';
import {
  diagonalCentreTile,
  diagonalMark,
  diagonalRoadDir,
  laneCentreInTile,
  isSignalCrossing,
  junctionPaint,
  type IsRoad,
  type MarkQuad,
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

/**
 * Junction furniture (WORLDGEN.md §50).
 *
 * The paint is pure geometry, so these are arithmetic claims about quads —
 * which is the point of moving it out of the two painters: before §50 the
 * only way to find out whether a crossing was in the right place was to
 * render a PNG and look at it, and looking at it is how a city with 21
 * crossings in it passed two reviews.
 */
const crossroads = {
  x: 100,
  y: 100,
  r: 2,
  arms: [
    { dx: 1, dy: 0, width: 4 },
    { dx: -1, dy: 0, width: 4 },
    { dx: 0, dy: 1, width: 4 },
    { dx: 0, dy: -1, width: 4 },
  ],
};

/** The centre of a quad, which is all these claims need from one. */
function mid(q: MarkQuad): [number, number] {
  return [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
}

describe('junctionPaint', () => {
  it('furnishes every arm of a crossroads, and only outside the box', () => {
    const p = junctionPaint(crossroads);
    expect(p.stops.length).toBe(4);
    expect(p.zebras.length).toBe(4 * 4);
    for (const q of [...p.stops, ...p.zebras]) {
      const [x, y] = mid(q);
      // Chebyshev, because the box is square and the arms are cardinal: no
      // paint inside the junction, which is bare asphalt by a rule older
      // than this one.
      expect(Math.max(Math.abs(x - 100), Math.abs(y - 100))).toBeGreaterThan(crossroads.r);
    }
  });

  it('puts the stop line behind the crossing, not on it', () => {
    // The order a driver meets them in, from the box outwards: zebra, then
    // the line they stop at. Backwards, the queue stands on the crossing.
    const p = junctionPaint(crossroads);
    // The north arm's own paint: the east and west arms' stripes straddle
    // y = 100 too, so "above the centre" is not the same question.
    const onNorth = ([x, y]: [number, number]): boolean => Math.abs(x - 100) < 2 && y < 100;
    const north = p.zebras.map(mid).filter(onNorth).map(([, y]) => y);
    const line = p.stops.map(mid).find(onNorth) as [number, number];
    expect(north.length).toBe(4);
    expect(line[1]).toBeLessThan(Math.min(...north));
  });

  it('holds only the traffic going in', () => {
    // Driving on the right: coming south down the north arm, you keep to the
    // west half, so that is the half the line covers. Painted across the
    // full width it tells the traffic coming out to stop at a junction it is
    // leaving — which is what the tile painter did before §35.
    const p = junctionPaint(crossroads);
    const [x, y] = p.stops.map(mid).find(([xx, yy]) => Math.abs(xx - 100) < 2 && yy < 100) as [
      number,
      number,
    ];
    expect(y).toBeLessThan(100);
    // Centred on the middle of the western half: a quarter of the four-tile
    // carriageway west of the centre line.
    expect(x).toBeCloseTo(99);
  });

  it('gives a T-junction three arms of paint and no fourth', () => {
    const tee = {
      x: 50,
      y: 50,
      r: 2,
      arms: [
        { dx: 1, dy: 0, width: 4 },
        { dx: -1, dy: 0, width: 4 },
        { dx: 0, dy: 1, width: 4 },
      ],
    };
    expect(junctionPaint(tee).stops.length).toBe(3);
    // And nothing north, where there is no road.
    expect(junctionPaint(tee).stops.map(mid).every(([, y]) => y > 47)).toBe(true);
  });

  it('leaves an arm bare when the next junction is too close', () => {
    // Two crossings five tiles apart: the paint is longer than the block, and
    // laid anyway it ends up in the other junction's mouth. Where the
    // arterials fan out above the old town this had a dozen zebras stacked
    // across one sheet of tarmac.
    const near = { x: 105, y: 100, r: 2 };
    const p = junctionPaint(crossroads, [near]);
    expect(p.stops.length).toBe(3);
    expect(p.stops.map(mid).every(([x]) => x < 103)).toBe(true);
  });

  it('says nothing at all about a place with five ways out', () => {
    const apron = {
      x: 50,
      y: 50,
      r: 2,
      arms: [
        { dx: 1, dy: 0, width: 4 },
        { dx: -1, dy: 0, width: 4 },
        { dx: 0, dy: 1, width: 4 },
        { dx: 0, dy: -1, width: 4 },
        { dx: 0.7, dy: 0.7, width: 4 },
      ],
    };
    const p = junctionPaint(apron);
    expect(p.stops.length).toBe(0);
    expect(p.zebras.length).toBe(0);
    expect(p.arrows.length).toBe(0);
  });

  it('hooks the kerb lane right and the median lane left', () => {
    const p = junctionPaint(crossroads);
    // The north arm: two lanes, both pointing south into the box.
    const north = p.arrows.filter((a) => a.y < 100 && Math.abs(a.x - 100) < 2);
    expect(north.length).toBe(2);
    for (const a of north) expect(a.dy).toBe(1);
    // Driving south, the driver's right is west, so the kerb lane is the
    // western one and it is the one that may turn right.
    const kerb = north.reduce((m, a) => (a.x < m.x ? a : m));
    const median = north.reduce((m, a) => (a.x > m.x ? a : m));
    expect(kerb.right).toBe(true);
    expect(kerb.left).toBe(false);
    expect(median.left).toBe(true);
    expect(median.right).toBe(false);
  });

  it('gives a three-tile street no arrows at all', () => {
    // One lane each way can only be told "you may do anything", which is what
    // an unmarked lane already says. Painted anyway it put a symbol every few
    // tiles down every side street in the city.
    const minor = {
      x: 50,
      y: 50,
      r: 2,
      arms: [
        { dx: 1, dy: 0, width: 4 },
        { dx: -1, dy: 0, width: 4 },
        { dx: 0, dy: 1, width: 3 },
        { dx: 0, dy: -1, width: 3 },
      ],
    };
    const p = junctionPaint(minor);
    expect(p.stops.length).toBe(4);
    expect(p.arrows.length).toBe(4);
    expect(p.arrows.every((a) => a.dx !== 0)).toBe(true);
  });

  it('only calls a crossing signalled when an arterial is in it', () => {
    expect(isSignalCrossing(crossroads)).toBe(true);
    expect(
      isSignalCrossing({
        arms: [
          { dx: 1, dy: 0, width: 3 },
          { dx: 0, dy: 1, width: 3 },
        ],
      }),
    ).toBe(false);
  });
});
