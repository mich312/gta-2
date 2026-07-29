import { describe, expect, it } from 'vitest';
import {
  BRIDGE_DECK_Z,
  EARTH,
  Z_PER_STOREY,
  blockedAt,
  buildVolumeGrid,
  ceilingAbove,
  spansAt,
  supportUnder,
} from '../src/world/volume.js';
import { move3, supportForBox, type Body3 } from '../src/world/collide3.js';
import {
  T_BRIDGE,
  T_BUILDING,
  T_ROAD,
  T_WATER,
  TILE_SIZE,
  type Building,
  type CityMap,
} from '../src/world/types.js';

/** A tiny hand-built map, so the geometry under test is the geometry written. */
function makeMap(
  W: number,
  H: number,
  paint: (tx: number, ty: number) => number,
  buildings: Building[] = [],
): CityMap {
  const tiles = new Uint8Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) tiles[ty * W + tx] = paint(tx, ty);
  }
  return {
    seed: 1,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles,
    district: new Uint8Array(W * H),
    blocks: [],
    buildings,
    shops: [],
    vehicleSpawns: [],
    parkingSpots: [],
  } as unknown as CityMap;
}

const FLAT = (): CityMap => makeMap(16, 16, () => T_ROAD);

const WALKER = {
  half: 4,
  height: 12,
  stepUp: 6,
  gravity: 1.2,
  snapDown: 2,
};

const body = (x: number, y: number, z: number): Body3 => ({
  x,
  y,
  z,
  vx: 0,
  vy: 0,
  vz: 0,
});

describe('volume columns', () => {
  it('gives every tile at least one span, so no query falls through a hole', () => {
    const map = makeMap(8, 8, (tx, ty) => ((tx + ty) % 5) as number);
    const vg = buildVolumeGrid(map);
    for (let ty = 0; ty < 8; ty++) {
      for (let tx = 0; tx < 8; tx++) {
        expect(spansAt(vg, tx, ty).length).toBeGreaterThan(0);
      }
    }
  });

  it('treats outside the map as solid to any height', () => {
    const vg = buildVolumeGrid(FLAT());
    expect(blockedAt(vg, -1, 0, 0, 10)).toBe(true);
    expect(blockedAt(vg, 999, 0, 0, 10)).toBe(true);
  });

  it('stands a mover on the street at z=0', () => {
    const vg = buildVolumeGrid(FLAT());
    expect(supportUnder(vg, 4, 4, 0)).toBe(0);
    expect(blockedAt(vg, 4, 4, 0, 12)).toBe(false);
  });

  it('makes a building solid from the street to its roof', () => {
    const b = { x: 2, y: 2, w: 2, h: 2, district: 'downtown' } as Building;
    const map = makeMap(16, 16, (tx, ty) => (tx >= 2 && tx < 4 && ty >= 2 && ty < 4 ? T_BUILDING : T_ROAD), [b]);
    const vg = buildVolumeGrid(map);
    // Blocked at street level...
    expect(blockedAt(vg, 2, 2, 0, 12)).toBe(true);
    // ...and standable on top, at a height that is a whole number of storeys.
    const roof = supportUnder(vg, 2, 2, Infinity);
    expect(roof).toBeGreaterThan(0);
    expect(roof % Z_PER_STOREY).toBe(0);
  });
});

describe('the bridge — the case a flat grid cannot express', () => {
  // One column: river at the bottom, deck in the air, clear space between.
  const bridgeMap = (): CityMap => makeMap(16, 16, (tx) => (tx === 8 ? T_BRIDGE : tx === 7 || tx === 9 ? T_WATER : T_ROAD));

  it('has open air between the water and the deck', () => {
    const vg = buildVolumeGrid(bridgeMap());
    // A boat's-eye slice just above the water is clear...
    expect(blockedAt(vg, 8, 4, 0, 20)).toBe(false);
    // ...and the deck is solid where it should be.
    expect(blockedAt(vg, 8, 4, BRIDGE_DECK_Z, BRIDGE_DECK_Z + 2)).toBe(true);
  });

  it('lets a boat pass UNDER while a car drives OVER the same tile', () => {
    const vg = buildVolumeGrid(bridgeMap());

    // The car, on the deck, driving across the bridge.
    const car = body(7.5 * TILE_SIZE, 4 * TILE_SIZE, BRIDGE_DECK_Z + 6);
    const carOpts = { ...WALKER, half: 6, height: 10, gravity: 0 };
    for (let i = 0; i < 40; i++) move3(vg, car, 3, 0, carOpts);
    expect(car.x).toBeGreaterThan(9 * TILE_SIZE);
    expect(car.z).toBeGreaterThan(BRIDGE_DECK_Z);

    // The boat, on the water, sailing along the river beneath it. A mast of
    // 20 px clears the deck at 40.
    const boat = body(8.5 * TILE_SIZE, 1 * TILE_SIZE, -8);
    const boatOpts = { ...WALKER, half: 5, height: 20, gravity: 0 };
    for (let i = 0; i < 40; i++) move3(vg, boat, 0, 3, boatOpts);
    expect(boat.y).toBeGreaterThan(6 * TILE_SIZE);
    expect(boat.z).toBeLessThan(0);

    // They crossed the same tile at different heights and neither noticed.
    expect(Math.floor(car.x / TILE_SIZE)).not.toBe(8);
    expect(Math.floor(boat.x / TILE_SIZE)).toBe(8);
  });

  it('stops a boat whose mast is too tall for the deck', () => {
    const vg = buildVolumeGrid(bridgeMap());
    const tall = body(8.5 * TILE_SIZE, 1 * TILE_SIZE, -8);
    // 60 px of mast against a deck at 40: this one does not fit.
    const r = move3(vg, tall, 0, 3, { ...WALKER, half: 5, height: 60, gravity: 0 });
    expect(r.hitY).toBe(true);
  });
});

describe('walls, steps and falling', () => {
  it('stops a mover at a building wall and clamps it flush', () => {
    const b = { x: 6, y: 0, w: 2, h: 16, district: 'downtown' } as Building;
    const map = makeMap(16, 16, (tx) => (tx >= 6 && tx < 8 ? T_BUILDING : T_ROAD), [b]);
    const vg = buildVolumeGrid(map);
    const m = body(4 * TILE_SIZE, 4 * TILE_SIZE, 0);
    for (let i = 0; i < 30; i++) move3(vg, m, 4, 0, WALKER);
    expect(m.x).toBeLessThanOrEqual(6 * TILE_SIZE - WALKER.half);
    // Flush, not merely stopped somewhere short of the wall.
    expect(6 * TILE_SIZE - (m.x + WALKER.half)).toBeLessThan(0.01);
  });

  it('climbs a lip inside the step-up allowance instead of stopping', () => {
    // A 12 px ramp tile against a 6 px step allowance is too tall; against a
    // 16 px allowance it is a step. Same geometry, different mover.
    const map = makeMap(16, 16, (tx) => (tx === 8 ? 8 /* T_RAMP */ : T_ROAD));
    const vg = buildVolumeGrid(map);

    const shortLegs = body(6 * TILE_SIZE, 4 * TILE_SIZE, 0);
    for (let i = 0; i < 30; i++) move3(vg, shortLegs, 3, 0, { ...WALKER, stepUp: 6 });
    expect(shortLegs.z).toBe(0);
    expect(shortLegs.x).toBeLessThan(8 * TILE_SIZE);

    const longLegs = body(6 * TILE_SIZE, 4 * TILE_SIZE, 0);
    let stepped = false;
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      const r = move3(vg, longLegs, 3, 0, { ...WALKER, stepUp: 16 });
      if (r.steppedUp) stepped = true;
      if (longLegs.z > peak) peak = longLegs.z;
    }
    expect(stepped).toBe(true);
    // It rose onto the ramp on the way past...
    expect(peak).toBe(12);
    // ...and stepped back down off the far side, which is the same mechanism
    // working in reverse rather than a mover stuck on a one-tile plateau.
    expect(longLegs.x).toBeGreaterThan(9 * TILE_SIZE);
    expect(longLegs.z).toBe(0);
  });

  it('will not let a mover step up into a ceiling it cannot stand under', () => {
    // A ledge with a deck directly above it: climbable height, no headroom.
    const map = makeMap(16, 16, (tx) => (tx === 8 ? T_BRIDGE : T_ROAD));
    const vg = buildVolumeGrid(map);
    // Standing on the river bed, a deck 40 up. A mover 12 tall fits under it,
    // so it should pass through rather than be launched onto the deck.
    const m = body(6 * TILE_SIZE, 4 * TILE_SIZE, -8);
    for (let i = 0; i < 30; i++) move3(vg, m, 3, 0, { ...WALKER, gravity: 0 });
    expect(m.z).toBeLessThan(BRIDGE_DECK_Z);
  });

  it('falls off the end of a bridge and lands in the water below', () => {
    const map = makeMap(16, 16, (tx, ty) => (ty === 4 ? T_BRIDGE : T_WATER));
    const vg = buildVolumeGrid(map);
    const m = body(4 * TILE_SIZE, 4.5 * TILE_SIZE, BRIDGE_DECK_Z + 6);
    // Walk off the side of the deck.
    let landed = false;
    for (let i = 0; i < 120; i++) {
      const r = move3(vg, m, 0, 3, WALKER);
      if (r.grounded && m.z < 0) landed = true;
    }
    expect(landed).toBe(true);
    expect(m.z).toBeLessThan(0);
  });

  it('does not tunnel through a wall at high speed', () => {
    const b = { x: 8, y: 0, w: 1, h: 16, district: 'downtown' } as Building;
    const map = makeMap(24, 16, (tx) => (tx === 8 ? T_BUILDING : T_ROAD), [b]);
    const vg = buildVolumeGrid(map);
    const bullet = body(2 * TILE_SIZE, 4 * TILE_SIZE, 0);
    // 400 px in one tick, six tiles past the wall.
    move3(vg, bullet, 400, 0, WALKER);
    expect(bullet.x).toBeLessThan(8 * TILE_SIZE);
  });
});

describe('determinism', () => {
  it('is a pure function of the map — two grids agree span for span', () => {
    const b = { x: 3, y: 3, w: 4, h: 3, district: 'downtown' } as Building;
    const paint = (tx: number, ty: number): number =>
      tx >= 3 && tx < 7 && ty >= 3 && ty < 6 ? T_BUILDING : tx === 10 ? T_BRIDGE : T_ROAD;
    const a = buildVolumeGrid(makeMap(16, 16, paint, [b]));
    const c = buildVolumeGrid(makeMap(16, 16, paint, [b]));
    expect(Array.from(a.bottoms)).toEqual(Array.from(c.bottoms));
    expect(Array.from(a.tops)).toEqual(Array.from(c.tops));
    expect(Array.from(a.offset)).toEqual(Array.from(c.offset));
  });

  it('produces identical motion from identical input', () => {
    const vg = buildVolumeGrid(makeMap(16, 16, (tx) => (tx === 9 ? T_BUILDING : T_ROAD)));
    const run = (): Body3 => {
      const m = body(2 * TILE_SIZE, 4 * TILE_SIZE, 30);
      for (let i = 0; i < 200; i++) move3(vg, m, 2.7, 1.3, WALKER);
      return m;
    };
    const a = run();
    const c = run();
    expect(a).toEqual(c);
  });

  it('keeps a resting mover exactly still, tick after tick', () => {
    // Drift under gravity while grounded is the classic source of a hash that
    // diverges after ten minutes of nobody doing anything.
    const vg = buildVolumeGrid(FLAT());
    const m = body(4 * TILE_SIZE, 4 * TILE_SIZE, 0);
    for (let i = 0; i < 500; i++) move3(vg, m, 0, 0, WALKER);
    expect(m.z).toBe(0);
    expect(m.vz).toBe(0);
  });
});

describe('support queries', () => {
  it('reports the highest surface under a footprint spanning two heights', () => {
    const b = { x: 5, y: 0, w: 3, h: 16, district: 'downtown' } as Building;
    const map = makeMap(16, 16, (tx) => (tx >= 5 && tx < 8 ? T_BUILDING : T_ROAD), [b]);
    const vg = buildVolumeGrid(map);
    // Straddling the kerb of the building: the roof wins.
    const s = supportForBox(vg, 5 * TILE_SIZE, 4 * TILE_SIZE, 6, Infinity);
    expect(s).toBeGreaterThan(0);
  });

  it('reports open sky as an infinite ceiling', () => {
    const vg = buildVolumeGrid(FLAT());
    expect(ceilingAbove(vg, 4, 4, 0)).toBe(Infinity);
  });
});
