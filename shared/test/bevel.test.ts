import { describe, expect, it } from 'vitest';
import {
  BEV_NE,
  BEV_NONE,
  BEV_NW,
  BEV_SE,
  BEV_SW,
  bevelOther,
  boxInSolid,
  deriveBevels,
  inCutHalf,
  isSolidAtWorld,
  isSolidTile,
  moveWithCollision,
  oppositeHalf,
  T_BANK,
  T_FIELD,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  type CityMap,
} from 'shared';

/**
 * Grids drawn as strings, because every interesting case here is a shape:
 * `~` water, `.` sand, `,` field, `q` quay. The pass only reads the tile
 * plane, so nothing else needs to exist.
 */
const GLYPH: Record<string, number> = {
  '~': T_WATER,
  '.': T_SAND,
  ',': T_FIELD,
  q: T_BANK,
  t: T_TREES,
};

function grid(rows: string[]): { tiles: Uint8Array; W: number; H: number } {
  const H = rows.length;
  const W = (rows[0] as string).length;
  const tiles = new Uint8Array(W * H);
  rows.forEach((row, y) => {
    for (let x = 0; x < W; x++) tiles[y * W + x] = GLYPH[row[x] as string] as number;
  });
  return { tiles, W, H };
}

describe('deriveBevels', () => {
  it('turns a 45° coast staircase into one continuous diagonal, cut from the water side', () => {
    // Sand below-left, water above-right, boundary running down-right.
    const { tiles, W, H } = grid([
      '.~~~~~~~',
      '..~~~~~~',
      '...~~~~~',
      '....~~~~',
      '.....~~~',
      '......~~',
      '.......~',
      '........',
    ]);
    const bevel = deriveBevels(tiles, W, H);
    // Every interior water tile touching the step gets its SW half cut to
    // sand; the sand side is suppressed, so no sand tile is cut at all.
    let waterCuts = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (tiles[i] === T_SAND) expect(bevel[i]).toBe(BEV_NONE);
        if (bevel[i] !== BEV_NONE) {
          expect(tiles[i]).toBe(T_WATER);
          expect(bevel[i]).toBe(BEV_SW);
          expect(bevelOther(tiles, bevel, W, x, y)).toBe(T_SAND);
          waterCuts++;
        }
      }
    }
    // One cut per interior step of the staircase.
    expect(waterCuts).toBe(5);
  });

  it('chamfers a square headland from the land side', () => {
    const { tiles, W, H } = grid([
      '~~~~~~',
      '~~~~~~',
      '..~~~~',
      '..~~~~',
      '......',
      '......',
    ]);
    const bevel = deriveBevels(tiles, W, H);
    // The sand tile at 1,2 pokes NE into open water with water N and E and
    // sand S and W: a true convex corner, so neither of its water
    // neighbours has two land sides and the chamfer must come off the land.
    expect(bevel[2 * W + 1]).toBe(BEV_NE);
    expect(bevelOther(tiles, bevel, W, 1, 2)).toBe(T_WATER);
  });

  it('rounds a pond and leaves a one-tile pond alone', () => {
    const pond = grid([
      ',,,,,,',
      ',~~~~,',
      ',~~~~,',
      ',~~~~,',
      ',,,,,,',
    ]);
    const bevel = deriveBevels(pond.tiles, pond.W, pond.H);
    // All four water corner tiles yield to the grass around them.
    expect(bevel[1 * pond.W + 1]).toBe(BEV_NW);
    expect(bevel[1 * pond.W + 4]).toBe(BEV_NE);
    expect(bevel[3 * pond.W + 1]).toBe(BEV_SW);
    expect(bevel[3 * pond.W + 4]).toBe(BEV_SE);

    const puddle = grid(['~,,,,', ',,~,,', ',,,,,'].map((r) => r.padEnd(5, ',')));
    const b2 = deriveBevels(puddle.tiles, puddle.W, puddle.H);
    // A lone water tile has grass on three or four sides: every corner is a
    // tip, and tips stay square.
    expect(b2[1 * puddle.W + 2]).toBe(BEV_NONE);
  });

  it('never touches a quay: built edges stay square', () => {
    const { tiles, W, H } = grid([
      'qqqqqq',
      'q~~~~q',
      'q~~~~q',
      'qqqqqq',
      ',,,,,,',
    ]);
    const bevel = deriveBevels(tiles, W, H);
    expect(bevel.every((b) => b === BEV_NONE)).toBe(true);
  });

  it('smooths the beach backline from the sand side and chamfers grass corners', () => {
    const { tiles, W, H } = grid([
      ',.......',
      ',,......',
      ',,,.....',
      ',,,,....',
      ',,,,,...',
      ',,,,,,..',
      ',,,,,,,.',
      ',,,,,,,,',
    ]);
    const bevel = deriveBevels(tiles, W, H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (bevel[i] === BEV_NONE) continue;
        // The staircase is cut from the sand side only.
        expect(tiles[i]).toBe(T_SAND);
        expect(bevel[i]).toBe(BEV_SW);
      }
    }
  });

  it('gives the wooded shore its diagonal — for the boats, and only the boats', () => {
    // A sheer cliff coast: canopy-painted rock below-left, sea above-right.
    const rows = [
      't~~~~~~~',
      'tt~~~~~~',
      'ttt~~~~~',
      'tttt~~~~',
      'ttttt~~~',
      'tttttt~~',
      'ttttttt~',
      'tttttttt',
    ];
    const { tiles, W, H } = grid(rows);
    const map = {
      widthTiles: W,
      heightTiles: H,
      widthPx: W * TILE_SIZE,
      heightPx: H * TILE_SIZE,
      tiles,
    } as unknown as CityMap;
    map.bevel = deriveBevels(tiles, W, H);
    // The water yields its stair corners to the canopy, as on a beach...
    expect(map.bevel[1 * W + 2]).toBe(BEV_SW);
    expect(bevelOther(tiles, map.bevel, W, 2, 1)).toBe(T_TREES);
    // ...but a walker still meets a wall on BOTH halves: trees and water
    // are both solid on land, so the bevel collapses to a full tile.
    expect(isSolidAtWorld(map, 34, 30, 'land')).toBe(true);
    expect(isSolidAtWorld(map, 46, 18, 'land')).toBe(true);
    // A boat feels the diagonal: cliff wedge solid, open sea open.
    expect(isSolidAtWorld(map, 34, 30, 'water')).toBe(true);
    expect(isSolidAtWorld(map, 46, 18, 'water')).toBe(false);
    // And the hull slides along the 45° face: nosing west from open water,
    // it is stopped further in the higher up the diagonal it sits.
    const low = { x: 56, y: 24 };
    const lowVel = { x: 0, y: 0 };
    moveWithCollision(map, low, lowVel, 4, -20, 0, 'water');
    const high = { x: 56, y: 18 };
    moveWithCollision(map, high, { x: 0, y: 0 }, 4, -20, 0, 'water');
    expect(low.x).toBeGreaterThan(47.5); // clamped at the wedge's deep end
    expect(high.x).toBeLessThan(low.x - 4); // a row north, the sea runs deeper
    expect(lowVel.x).toBe(0);
  });

  it('cuts the sidewalk stair along a diagonal band, hypotenuses running with it', () => {
    // A 45° carriageway around x = y, sidewalk banding it, field beyond —
    // the shape a carved diagonal avenue rasterises to (marks.test.ts uses
    // the same fixture for the centre line).
    const N = 24;
    const tiles = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.abs(x - y);
        tiles[y * N + x] = d <= 1 ? T_ROAD : d <= 3 ? T_SIDEWALK : T_FIELD;
      }
    }
    const bevel = deriveBevels(tiles, N, N);
    let kerbCuts = 0;
    for (let i = 0; i < bevel.length; i++) {
      if (bevel[i] === BEV_NONE) continue;
      // Every cut on this map is a sidewalk corner yielding to the road,
      // and its hypotenuse runs NW–SE, the way the band does.
      expect(tiles[i]).toBe(T_SIDEWALK);
      expect(bevel[i] === BEV_NE || bevel[i] === BEV_SW).toBe(true);
      expect(bevelOther(tiles, bevel, N, i % N, Math.floor(i / N))).toBe(T_ROAD);
      kerbCuts++;
    }
    // One cut per stair step on each side of the band's interior.
    expect(kerbCuts).toBeGreaterThan(10);
  });

  it('leaves every corner of a square junction square', () => {
    // A plain orthogonal crossroads with its sidewalk ring: the ungated
    // corner rule would chamfer all four block corners, and the whole city
    // is made of these.
    const N = 24;
    const tiles = new Uint8Array(N * N).fill(T_FIELD);
    const road = (x: number, y: number): boolean =>
      (y >= 10 && y <= 12) || (x >= 10 && x <= 12);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (road(x, y)) tiles[y * N + x] = T_ROAD;
        else if (
          road(x - 1, y) || road(x + 1, y) || road(x, y - 1) || road(x, y + 1) ||
          road(x - 1, y - 1) || road(x + 1, y - 1) || road(x - 1, y + 1) || road(x + 1, y + 1)
        ) {
          tiles[y * N + x] = T_SIDEWALK;
        }
      }
    }
    const bevel = deriveBevels(tiles, N, N);
    expect(bevel.every((b) => b === BEV_NONE)).toBe(true);
  });

  it('is a pure function of the tiles: two runs agree byte for byte', () => {
    const { tiles, W, H } = grid([
      '..~~~~..',
      '...~~...',
      '....~...',
      '........',
      '..,,....',
      '.,,,,...',
      '.,,,,,..',
      '........',
    ]);
    const a = deriveBevels(tiles, W, H);
    const b = deriveBevels(tiles, W, H);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

/** A staircase coast as a movement fixture: sand SW, water NE. */
function coastMap(): CityMap {
  const rows = [
    '.~~~~~~~',
    '..~~~~~~',
    '...~~~~~',
    '....~~~~',
    '.....~~~',
    '......~~',
    '.......~',
    '........',
  ];
  const { tiles, W, H } = grid(rows);
  const map = {
    seed: 0,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles,
    district: new Uint8Array(W * H),
    blocks: [],
    buildings: [],
    shops: [],
  } as unknown as CityMap;
  map.bevel = deriveBevels(tiles, W, H);
  return map;
}

describe('diagonal collision', () => {
  it('lets a walker onto the open half of a bevelled water tile, up to the hypotenuse', () => {
    const map = coastMap();
    // Tile 2,1 is water bevelled SW-to-sand: its NE half is the solid sea.
    expect(map.bevel?.[1 * 8 + 2]).toBe(BEV_SW);
    const pos = { x: 24, y: 24 }; // centre of sand tile 1,1
    const vel = { x: 40, y: 0 };
    moveWithCollision(map, pos, vel, 4, 20, 0);
    // A square water tile would have stopped the box at x = 28 (leading edge
    // flush to the tile face at 32). The diagonal lets it into the wedge:
    // at y 24 the box spans rows down to 28, the hypotenuse there is at
    // x = 36, so the box centre reaches ~32.
    expect(pos.x).toBeGreaterThan(30);
    expect(pos.x).toBeLessThan(33);
    expect(vel.x).toBe(0);
  });

  it('slides along the shore: drop a tile south, gain a tile east', () => {
    const map = coastMap();
    const pos = { x: 24, y: 24 };
    const vel = { x: 0, y: 0 };
    moveWithCollision(map, pos, vel, 4, 20, 0); // pressed against the diagonal
    const before = pos.x;
    moveWithCollision(map, pos, vel, 4, 0, 16); // step down the coast...
    moveWithCollision(map, pos, vel, 4, 16, 0); // ...and the sea lets you east
    expect(pos.x).toBeGreaterThan(before + 8);
  });

  it('answers point and box queries on both sides of the hypotenuse', () => {
    const map = coastMap();
    // Tile 2,1 spans world 32..48 × 16..32; sand below the diagonal.
    expect(isSolidAtWorld(map, 34, 30)).toBe(false); // SW wedge: beach
    expect(isSolidAtWorld(map, 46, 18)).toBe(true); // NE half: sea
    expect(boxInSolid(map, { x: 35, y: 29 }, 2)).toBe(false);
    expect(boxInSolid(map, { x: 44, y: 20 }, 2)).toBe(true);
    // For a boat the same wedge flips: beach solid, sea open.
    expect(isSolidAtWorld(map, 34, 30, 'water')).toBe(true);
    expect(isSolidAtWorld(map, 46, 18, 'water')).toBe(false);
  });

  it('keeps the coarse tile answer conservative for both media', () => {
    const map = coastMap();
    // The bevelled water tile is still "solid" to anything placing or
    // steering by whole tiles — for land because half of it is sea, and
    // for boats because half of it is beach.
    expect(isSolidTile(map, 2, 1, 'land')).toBe(true);
    expect(isSolidTile(map, 2, 1, 'water')).toBe(true);
    // Plain water and plain sand keep their old answers.
    expect(isSolidTile(map, 6, 1, 'land')).toBe(true);
    expect(isSolidTile(map, 6, 1, 'water')).toBe(false);
    expect(isSolidTile(map, 1, 6, 'land')).toBe(false);
  });
});

describe('inCutHalf / oppositeHalf', () => {
  const T = TILE_SIZE;
  it('splits the tile along the right diagonal for each code', () => {
    // NE half: above the NW–SE diagonal.
    expect(inCutHalf(BEV_NE, T - 1, 1)).toBe(true);
    expect(inCutHalf(BEV_NE, 1, T - 1)).toBe(false);
    // SW is its complement...
    expect(inCutHalf(BEV_SW, 1, T - 1)).toBe(true);
    expect(inCutHalf(BEV_SW, T - 1, 1)).toBe(false);
    // ...and the diagonal itself belongs to the base material on both.
    expect(inCutHalf(BEV_NE, 8, 8)).toBe(false);
    expect(inCutHalf(BEV_SW, 8, 8)).toBe(false);
    // The other diagonal pair.
    expect(inCutHalf(BEV_SE, T - 1, T - 1)).toBe(true);
    expect(inCutHalf(BEV_SE, 1, 1)).toBe(false);
    expect(inCutHalf(BEV_NW, 1, 1)).toBe(true);
    expect(inCutHalf(BEV_NW, T - 1, T - 1)).toBe(false);
  });

  it('pairs each half with its complement', () => {
    expect(oppositeHalf(BEV_NE)).toBe(BEV_SW);
    expect(oppositeHalf(BEV_SW)).toBe(BEV_NE);
    expect(oppositeHalf(BEV_SE)).toBe(BEV_NW);
    expect(oppositeHalf(BEV_NW)).toBe(BEV_SE);
    expect(oppositeHalf(BEV_NONE)).toBe(BEV_NONE);
  });
});
