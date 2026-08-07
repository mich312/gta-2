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

  it('agrees everywhere except a deck over water and a pond inland', () => {
    const sea = openSea();
    let decks = 0;
    let ponds = 0;
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
        // An enclosed pond, carved into a park block by `fillBlock` long after
        // `paintCoast` produced the rings (WORLDGEN.md §27.2). A boundary with
        // no curve — the defect this plan exists to remove, at a smaller
        // scale. Pinned, not accepted: it may not grow.
        ponds++;
      } else {
        unexplained++;
      }
    }
    // Nothing may disagree for a reason nobody has written down. The seven
    // that do are the pier prune (§23.1) drowning abutment tiles that were
    // land before a deck was put on them.
    expect(unexplained).toBeLessThanOrEqual(7);
    expect(decks).toBeGreaterThan(0);
    // The ponds are the open defect. If this number rises, something new has
    // started carving water behind the curve's back.
    expect(ponds).toBeLessThanOrEqual(486);
  });

  it('describes every island it ships as a closed ring', () => {
    expect(city.shores.length).toBeGreaterThan(4);
    for (const r of city.shores) {
      expect(r.points.length).toBeGreaterThanOrEqual(4);
      expect(r.area).toBeGreaterThan(0);
    }
  });
});
