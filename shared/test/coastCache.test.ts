import { describe, expect, it } from 'vitest';
import { CITY_DATA } from '../src/world/city.data.js';
import { decodeBakedCity } from '../src/world/bake.js';
import { rasteriseRings, shoreChains } from '../src/world/geometry.js';
import { T_BANK, T_BRIDGE, T_SAND, T_WATER } from '../src/world/types.js';

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

  /**
   * Water tiles reachable from the map border: the sea, as opposed to a pond.
   *
   * The flood runs UNDER bridge decks, because a deck is a thing over water
   * and not a piece of coast. While the strait had an undecked mouth this
   * made no difference and the rule was "water tiles only"; the moment the
   * ring road's east crossing was restored, both mouths were decked, and a
   * water-only flood declared the entire 39,000-tile basin a pond — with the
   * three coast tiles inside it that disagree with the rings reported as
   * water nobody had drawn. Which strait a tile is in is not evidence about
   * the coastline.
   */
  const openSea = (): Uint8Array => {
    const seen = new Uint8Array(W * H);
    const stack: number[] = [];
    const push = (x: number, y: number): void => {
      const i = y * W + x;
      if (seen[i] === 1 || (city.tiles[i] !== T_WATER && city.tiles[i] !== T_BRIDGE)) return;
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

/**
 * The shore band's inner edge, as a curve (WORLDGEN.md §39).
 *
 * §38 measured the band from the waterline instead of from its neighbours,
 * which made its width even; it did not make its drawn edge a curve, because
 * no painter had a curve to draw. This is that curve, and these are the three
 * things that have to hold for it to be worth shipping: it is smooth, it is
 * where the sand actually stops, and it never wanders into the sea.
 */
describe('the shore band ends on a curve', () => {
  const city = decodeBakedCity(JSON.parse(CITY_DATA));
  const W = city.widthTiles;
  const H = city.heightTiles;
  /** Sand and quay: the materials the band lays down. */
  const BAND = new Set<number>([T_SAND, T_BANK]);

  it('is no more a lattice than the waterline in front of it', () => {
    const axial = (rings: typeof city.banks): number => {
      let ax = 0;
      let n = 0;
      for (const r of rings) {
        for (let i = 0; i < r.points.length; i++) {
          const [ax0, ay0] = r.points[i] as readonly [number, number];
          const [bx, by] = r.points[(i + 1) % r.points.length] as readonly [number, number];
          const dx = bx - ax0;
          const dy = by - ay0;
          if (dx === 0 && dy === 0) continue;
          n++;
          const t = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 90;
          if (Math.min(t, 90 - t) < 7.5) ax++;
        }
      }
      return n === 0 ? 1 : ax / n;
    };
    // The number this replaces is 100%: the drawn sand-against-grass line was
    // every one of 2,609 tile edges, against a waterline a tile and a half in
    // front of it running at any angle it liked. A curve beside a staircase
    // draws the eye to the staircase.
    expect(axial(city.banks)).toBeLessThan(0.25);
    // And it is the same KIND of line as the coast, not a smoothed copy of a
    // lattice that happens to score well.
    expect(Math.abs(axial(city.banks) - axial(city.shores))).toBeLessThan(0.1);
  });

  it('never leaves dry land', () => {
    // The band runs from the waterline INLAND, so its far edge is at least
    // `QUAY_REACH` from the water. A vertex over the sea would mean the two
    // curves had crossed, and a painter would be cutting a wet tile with a
    // line that says the sand ends there.
    for (const r of city.banks) {
      for (const [x, y] of r.points) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        expect(city.tiles[ty * W + tx], `${x},${y}`).not.toBe(T_WATER);
      }
    }
  });

  it('runs where the sand actually stops', () => {
    // The claim that makes it a CACHE relationship rather than a decoration:
    // wherever the tile plane has a band material against something that is
    // not one, the curve is passing through one of those two tiles — so the
    // painters repaint that edge against the line instead of leaving the
    // staircase showing.
    const chains = shoreChains(city.banks, W, H);
    let edges = 0;
    let covered = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = city.tiles[y * W + x] as number;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= W || ny >= H) continue;
          const b = city.tiles[ny * W + nx] as number;
          if (BAND.has(a) === BAND.has(b)) continue;
          // The waterline's own edge is the OTHER curve's business.
          if (a === T_WATER || b === T_WATER || a === T_BRIDGE || b === T_BRIDGE) continue;
          edges++;
          if (chains.has(y * W + x) || chains.has(ny * W + nx)) covered++;
        }
      }
    }
    expect(edges).toBeGreaterThan(1000);
    // 98.4%. The remainder is band material a LATER pass put down — a street
    // that ran into the sea and was turned to quay, a landmark's apron — none
    // of which the band curve was cut from and none of which it claims to
    // describe.
    expect(covered / edges).toBeGreaterThan(0.95);
  });

  it('gives every park pond a beach with the same kind of edge', () => {
    // A pond's sand was the last four-neighbour band left in the city (§29
    // gave the pond its waterline and left its beach a lattice). It is the
    // same field contoured one reach further out, so the pond gets the same
    // treatment the sea does for the price of one more contour.
    expect(city.banks.length).toBeGreaterThan(city.shores.filter((r) => r.land).length);
    for (const r of city.banks) {
      expect(r.points.length).toBeGreaterThanOrEqual(4);
      expect(r.area).toBeGreaterThan(0);
    }
  });
});
