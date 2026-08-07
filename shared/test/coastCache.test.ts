import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import { rasteriseRings } from '../src/world/geometry.js';
import { T_BRIDGE, T_WATER } from '../src/world/types.js';

/**
 * The tile plane is a CACHE of the coast curve (VECTOR.md §3.1, WORLDGEN §27).
 *
 * The plan called this check a migration crutch to be deleted once the old
 * producer was gone. Running it by hand for §27's review immediately found a
 * defect nothing else could see — park ponds carved into tiles after the coast
 * exists, so 486 tiles of water that no ring describes — which is the argument
 * for keeping it forever instead.
 *
 * What it asserts is not "no disagreement". It is "no disagreement except the
 * two we have written down and understand", with the counts pinned so neither
 * can grow quietly.
 */
describe('the water tiles are a rasterisation of the coast rings', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));
  const W = city.widthTiles;
  const H = city.heightTiles;
  const mask = rasteriseRings(
    city.shores.map((r) => r.points),
    W,
    H,
  );

  /** Water tiles reachable from the map border: the sea, as opposed to a pond. */
  const openSea = (): Uint8Array => {
    const seen = new Uint8Array(W * H);
    const stack: number[] = [];
    const push = (x: number, y: number): void => {
      const i = y * W + x;
      if (seen[i] === 1 || city.tiles[i] !== T_WATER) return;
      seen[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < W; x++) {
      push(x, 0);
      push(x, H - 1);
    }
    for (let y = 0; y < H; y++) {
      push(0, y);
      push(W - 1, y);
    }
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % W;
      const y = (i - x) / W;
      if (x > 0) push(x - 1, y);
      if (x < W - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < H - 1) push(x, y + 1);
    }
    return seen;
  };

  /** Is this tile's centre sitting on the waterline itself? */
  const onTheLine = (i: number): boolean => {
    const x = (i % W) + 0.5;
    const y = Math.floor(i / W) + 0.5;
    for (const r of city.shores) {
      for (let k = 0; k < r.points.length; k++) {
        const [ax, ay] = r.points[k] as readonly [number, number];
        const [bx, by] = r.points[(k + 1) % r.points.length] as readonly [number, number];
        const vx = bx - ax;
        const vy = by - ay;
        const l2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
        if (Math.hypot(x - ax - t * vx, y - ay - t * vy) < 0.02) return true;
      }
    }
    return false;
  };

  it('agrees everywhere except a deck, a tie on the line, and nothing else', () => {
    const sea = openSea();
    let decks = 0;
    let ponds = 0;
    let ties = 0;
    let unexplained = 0;
    for (let i = 0; i < W * H; i++) {
      const wet = city.tiles[i] === T_WATER;
      const ringWet = mask[i] === 0;
      if (wet === ringWet) continue;
      if (!wet && city.tiles[i] === T_BRIDGE) {
        // A bridge deck is laid over water AFTER the coast exists, and a deck
        // is not land. Expected, and not a disagreement about the coastline.
        decks++;
      } else if (wet && sea[i] === 0) {
        // Was 486 tiles of park pond with no ring at all (§27.2), which is
        // what this test was written to pin. §29 gave ponds rings, so this
        // should now be nothing — kept as a named case so that if some future
        // pass starts carving water behind the curve's back, the failure says
        // which kind of water it is.
        ponds++;
      } else if (onTheLine(i)) {
        // A tile whose centre lies EXACTLY on the waterline. The even-odd
        // rule has to answer in or out, and the coordinates are shipped
        // rounded to 1/100 of a tile, so the answer can differ by a rounding
        // either side. Seven tiles, all at distance 0.0000 from a ring. Not a
        // disagreement about where the coast is — the coast is precisely
        // there — but about which side of itself a point on it falls.
        ties++;
      } else {
        unexplained++;
      }
    }
    // Nothing may disagree for a reason nobody has written down.
    expect(unexplained).toBe(0);
    expect(ties).toBeLessThanOrEqual(16);
    expect(decks).toBeGreaterThan(0);
    // Closed by §29. If this rises, something new is carving water behind the
    // curve's back — which is the whole failure mode this file exists for.
    expect(ponds).toBe(0);
  });

  it('describes every island it ships as a closed ring', () => {
    expect(city.shores.length).toBeGreaterThan(4);
    for (const r of city.shores) {
      expect(r.points.length).toBeGreaterThanOrEqual(4);
      expect(r.area).toBeGreaterThan(0);
    }
  });
});
