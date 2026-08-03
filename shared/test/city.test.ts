import { describe, expect, it } from 'vitest';
import cityPlanJson from '../data/city-plan.json';
import worldgenJson from '../data/worldgen.json';
import { parseCityPlan, pointInPoly } from '../src/world/plan.js';
import { buildLayout } from '../src/world/layout.js';
import { bakeCity, decodeBakedCity, encodeBakedCity } from '../src/world/bake.js';
import { generateCity } from '../src/world/generate.js';
import { parseWorldgenParams } from '../src/world/params.js';
import {
  LANDMARK_KINDS,
  T_BRIDGE,
  T_BUILDING,
  T_ROAD,
  T_RUNWAY,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  type CityMap,
} from '../src/world/types.js';

/**
 * The city is an ASSET now, not an algorithm, so this is the file that says
 * what the asset has to be: one road network, every borough reachable, every
 * landmark on it and approachable, no street ending in the sea, and the thing
 * the game loads identical to the thing the plan bakes to.
 *
 * That last one is the load-bearing test. `city.data.ts` is generated and
 * committed, which means it can drift from the plan it claims to come from —
 * somebody edits the plan, forgets to run `pnpm citybake`, and the map in the
 * repository is the old one with a new description beside it. Baking the plan
 * here and comparing tile-for-tile is what makes that impossible to miss.
 */

const plan = parseCityPlan(cityPlanJson);
const params = parseWorldgenParams(worldgenJson);
const map: CityMap = generateCity(4242, params);

/** Ground a car can occupy: the sim's own rule (`collide.isSolidTile`). */
function drivable(t: number): boolean {
  return t !== T_BUILDING && t !== T_WATER && t !== T_TREES;
}

/**
 * Sizes of the connected pieces of `passable` ground, biggest first.
 * Four-connected, which is how everything in the sim moves between tiles.
 */
function components(m: CityMap, passable: (t: number) => boolean): number[] {
  const W = m.widthTiles;
  const H = m.heightTiles;
  const seen = new Uint8Array(W * H);
  const sizes: number[] = [];
  for (let start = 0; start < m.tiles.length; start++) {
    if (seen[start] === 1 || !passable(m.tiles[start] as number)) continue;
    let n = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      n++;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] === 1 || !passable(m.tiles[j] as number)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

describe('the city, as an asset', () => {
  it('is the city the plan bakes to, tile for tile', { timeout: 60_000 }, () => {
    // The freshness gate. If this fails, the plan was edited and `pnpm
    // citybake` was not run — the fix is to run it, not to change this test.
    const baked = bakeCity(plan);
    const loaded = generateCity(1, params);
    expect(baked.widthTiles).toBe(loaded.widthTiles);
    expect(baked.heightTiles).toBe(loaded.heightTiles);
    expect(baked.name).toBe(loaded.name);
    expect(baked.blocks).toEqual(loaded.blocks);
    expect(baked.buildings).toEqual(loaded.buildings);
    expect(baked.landmarks).toEqual(loaded.landmarks);
    // Clinics are not baked: they are registered onto the hospital doors when
    // a session dresses the map, so the loaded city has three more shops.
    expect(baked.shops).toEqual(loaded.shops.filter((s) => s.kind !== 'clinic'));
    // Ramps are carved from the SEED, after the bake — the one part of the
    // ground a session is allowed to move — so compare everything else.
    let differing = 0;
    for (let i = 0; i < baked.tiles.length; i++) {
      if (baked.tiles[i] !== loaded.tiles[i]) differing++;
    }
    expect(differing).toBeLessThan(baked.tiles.length / 1000);
  });

  it('survives the round trip through its encoded form', { timeout: 60_000 }, () => {
    const baked = bakeCity(plan);
    const again = decodeBakedCity(JSON.parse(encodeBakedCity(baked)));
    expect(Buffer.from(again.tiles).equals(Buffer.from(baked.tiles))).toBe(true);
    expect(Buffer.from(again.district).equals(Buffer.from(baked.district))).toBe(true);
    expect(again.buildings).toEqual(baked.buildings);
    expect(again.landmarks).toEqual(baked.landmarks);
  });

  it('is one island group in one sea, with edges', () => {
    // The sea is the map's edge, and it is a real one: every tile of the
    // border is water, so there is no street that simply stops at a coordinate
    // limit. This is the whole reason the world stopped being unbounded.
    const W = map.widthTiles;
    const H = map.heightTiles;
    for (let x = 0; x < W; x++) {
      expect(map.tiles[x]).toBe(T_WATER);
      expect(map.tiles[(H - 1) * W + x]).toBe(T_WATER);
    }
    for (let y = 0; y < H; y++) {
      expect(map.tiles[y * W]).toBe(T_WATER);
      expect(map.tiles[y * W + W - 1]).toBe(T_WATER);
    }
  });

  it('is one road network: no borough is cut off from the rest', () => {
    const streets = components(map, (t) => t === T_ROAD || t === T_BRIDGE);
    expect(streets.length).toBe(1);
    // ...and it is a city's worth of street, not a lane.
    expect(streets[0]).toBeGreaterThan(80_000);
  });

  it('can be driven end to end: the ground is connected too', () => {
    const open = components(map, drivable);
    const total = open.reduce((a, b) => a + b, 0);
    // Courtyards inside blocks, barrier islands and the rock offshore are all
    // legitimately cut off; what must not happen is a whole district behind a
    // wall. The main component holds the city.
    expect((open[0] as number) / total).toBeGreaterThan(0.95);
  });

  it('carries every kind of landmark, each with a way in', () => {
    for (const kind of LANDMARK_KINDS) {
      expect(map.landmarks.filter((l) => l.kind === kind).length).toBeGreaterThan(0);
    }
    // Except the ones you fly to, whose whole point is that there is no road.
    // They have their own test below.
    const byAir = new Set(plan.landmarks.filter((l) => l.byAir).map((l) => l.name));
    for (const l of map.landmarks) {
      if (byAir.has(l.name)) continue;
      const dx = Math.floor(l.doorX / TILE_SIZE);
      const dy = Math.floor(l.doorY / TILE_SIZE);
      let road = false;
      for (let oy = -6; oy <= 6 && !road; oy++) {
        for (let ox = -6; ox <= 6; ox++) {
          const t = map.tiles[(dy + oy) * map.widthTiles + (dx + ox)] as number;
          if (t === T_ROAD || t === T_BRIDGE) {
            road = true;
            break;
          }
        }
      }
      expect(road, `${l.name} (${l.kind}) has no road within six tiles of its door`).toBe(true);
    }
  });

  it('spreads its landmarks over all three boroughs', () => {
    // Navigation is the point of a landmark: one borough holding all of them
    // is a map you can only orient yourself in from one place. The three
    // boroughs are the north-west island, the north-east island and the
    // southern mainland, split on the channels between them.
    const north = map.landmarks.filter((l) => l.y * TILE_SIZE < map.heightPx * 0.42);
    const south = map.landmarks.filter((l) => l.y * TILE_SIZE >= map.heightPx * 0.42);
    const west = north.filter((l) => l.x * TILE_SIZE < map.widthPx * 0.45);
    const east = north.filter((l) => l.x * TILE_SIZE >= map.widthPx * 0.45);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    expect(south.length).toBeGreaterThan(0);
  });

  it('names its streets and its boroughs', () => {
    expect(plan.roads.length).toBeGreaterThan(10);
    for (const a of plan.roads) expect(a.name.length).toBeGreaterThan(2);
    expect(new Set(plan.districts.map((d) => d.borough)).size).toBeGreaterThanOrEqual(5);
    expect(map.name).toBe(plan.name);
  });

  it('has more than one island, and rocks off the coast', () => {
    // A city on one round island is a city with one shape. What makes an
    // archipelago legible is that its pieces are different sizes and you
    // cross water to get between them.
    expect(plan.geography.islands.length).toBeGreaterThanOrEqual(2);
    expect(plan.geography.islets.length).toBeGreaterThanOrEqual(3);
    const land = components(map, (t) => t !== T_WATER);
    // The main island, the second island, and the rocks — but the two big
    // ones are joined by bridges, so drivable ground is checked elsewhere.
    expect(land.length).toBeGreaterThanOrEqual(4);
  });

  it('meets its own waterfront: urban shore is never far from a street', () => {
    // The §13.5 waterfront invariant, and the whole point of the esplanade
    // (WORLDGEN.md §13.6 step 4). The first drawn city kept a dead fringe of
    // bare field between the last street and the sea — measured at 25 tiles
    // (p95) on the Beachfront, 109 in Marsh End — because the lattice
    // stopped where a block stopped being mostly dry and nobody built to the
    // shore. Every shore tile a NON-RURAL borough owns must now be within a
    // few tiles of carriageway: the esplanade where nothing else runs, a
    // contour street where the fabric supplies one. Shore with no land path
    // to any road at all — an enclosed islet inside a borough polygon — is
    // excused: it is unreachable by car by design, not unmet.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const dist = new Int32Array(W * H).fill(-1);
    const queue: number[] = [];
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i] as number;
      if (t === T_ROAD || t === T_BRIDGE) {
        dist[i] = 0;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head] as number;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if ((dist[j] as number) >= 0 || map.tiles[j] === T_WATER) continue;
        dist[j] = (dist[i] as number) + 1;
        queue.push(j);
      }
    }
    // The SEA, not every water tile: park ponds (§13.6 step 8) are water a
    // borough deliberately keeps in its own interior, and "the waterfront"
    // this invariant guards is the one boats arrive at. Flooded from the
    // map corner, which is always open sea (the margin guarantees it).
    const sea = new Uint8Array(W * H);
    {
      const bag = [0];
      sea[0] = 1;
      for (let q = 0; q < bag.length; q++) {
        const i = bag[q] as number;
        const x = i % W;
        const y = (i - x) / W;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (sea[j] === 1 || map.tiles[j] !== T_WATER) continue;
          sea[j] = 1;
          bag.push(j);
        }
      }
    }
    const wet = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < W && y < H && sea[y * W + x] === 1;
    // Ownership resolves the way the layout resolves it: LAST polygon
    // containing the point wins (`buildLayout`'s borough pass — an overlap
    // is an edit, not an error). The lagoon rim sits inside the New Suburbs
    // polygon AND inside rural Marsh End drawn over it; the rim is Marsh
    // End's, country shore by intent, and no esplanade belongs there.
    const ownerOf = (tx: number, ty: number): (typeof plan.districts)[number] | null => {
      for (let i = plan.districts.length - 1; i >= 0; i--) {
        const d = plan.districts[i]!;
        if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) return d;
      }
      return null;
    };
    let checked = 0;
    let far = 0;
    for (let ty = 1; ty < H - 1; ty++) {
      for (let tx = 1; tx < W - 1; tx++) {
        const i = ty * W + tx;
        if (map.tiles[i] === T_WATER) continue;
        if (!(wet(tx + 1, ty) || wet(tx - 1, ty) || wet(tx, ty + 1) || wet(tx, ty - 1))) continue;
        const own = ownerOf(tx, ty);
        if (!own || own.rural) continue;
        const d = dist[i] as number;
        if (d < 0) continue; // enclosed islet: no land path to any road
        checked++;
        if (d > 5) far++;
      }
    }
    // A city's worth of urban shoreline was actually measured...
    expect(checked).toBeGreaterThan(1000);
    // ...and effectively all of it is met. The allowance covers the odd
    // cliff-pinched corner where a street cannot fit between rock and water.
    expect(far).toBeLessThan(checked / 50);
  });

  it('keeps its dead ends where they were ordered: the crescent budget', () => {
    // §13.5's dead-end budget. The crescent fabric (§13.6 step 6) drops
    // stretches of cross street ON PURPOSE — a suburb of loops and
    // lollipops, dead ends as chase decisions — and this is the assertion
    // that the feature exists AND stays a feature: enough culs-de-sac to
    // matter, few enough that the borough still drives. Measured tips, not
    // vibes: a road tile with at most one road neighbour is the end of
    // something.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const road = (x: number, y: number): boolean => {
      const t = map.tiles[y * W + x] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    const crescents = plan.districts.filter((d) => d.street.fabric === 'crescent');
    expect(crescents.length).toBeGreaterThan(0);
    let tips = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (!road(x, y)) continue;
        let n = 0;
        if (road(x + 1, y)) n++;
        if (road(x - 1, y)) n++;
        if (road(x, y + 1)) n++;
        if (road(x, y - 1)) n++;
        if (n > 1) continue;
        if (crescents.some((d) => pointInPoly(d.area, x + 0.5, y + 0.5))) tips++;
      }
    }
    expect(tips).toBeGreaterThanOrEqual(5);
    expect(tips).toBeLessThanOrEqual(80);
  });

  it('has an island you can only reach by air', () => {
    // Gannet Rock. The claim is exact and worth pinning tile by tile, because
    // every way of getting somewhere in this game is a different question:
    // a car needs road, a boat needs somewhere to step ashore, and an
    // aircraft needs somewhere to put down and somewhere to take off from.
    const flown = plan.landmarks.filter((l) => l.byAir);
    expect(flown.length).toBeGreaterThan(0);

    const W = map.widthTiles;
    const H = map.heightTiles;
    // The piece of ground the strip is on, walked over everything a person or
    // a car can occupy.
    const seed = plan.landmarks.find((l) => l.kind === 'airstrip' && l.byAir);
    expect(seed).toBeDefined();
    // The middle of the strip, not its corner: the corner is the hangar.
    const start =
      (seed!.rect[1] + Math.floor(seed!.rect[3] / 2)) * W +
      seed!.rect[0] +
      Math.floor(seed!.rect[2] / 2);
    const bag = [start];
    const seen = new Set([start]);
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q] as number;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen.has(j) || !drivable(map.tiles[j] as number)) continue;
        seen.add(j);
        bag.push(j);
      }
    }
    // Big enough to be an island, not a courtyard.
    expect(seen.size).toBeGreaterThan(500);

    let road = 0;
    let steppable = 0;
    let runway = 0;
    for (const i of seen) {
      const t = map.tiles[i] as number;
      if (t === T_ROAD || t === T_BRIDGE) road++;
      if (t === T_RUNWAY) runway++;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (map.tiles[ny * W + nx] === T_WATER) steppable++;
      }
    }
    // No road on to it and no road off it: nothing drives there.
    expect(road).toBe(0);
    // Nowhere on it to step ashore from a boat: it is cliff the whole way
    // round, and cliff is solid.
    expect(steppable).toBe(0);
    // And tarmac to land on — and, just as important, to leave from. An
    // airfield you can only arrive at is a trap, not a destination.
    expect(runway).toBeGreaterThan(100);
  });

  it('gives the city alleys to run down', () => {
    // Measured because it is easy to add the field and not the tiles: a block
    // interior with no way through is a wall, and a foot chase in a city of
    // walls is a straight line.
    expect(plan.districts.some((d) => d.street.alleyOver > 0)).toBe(true);
  });

  it('bridges the channels and nothing else', () => {
    // Every bridge tile is a crossing: land within the plan's maximum span in
    // both directions along one axis. A causeway laid down the length of the
    // harbour, or a span thrown at the open sea, fails this on both axes.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const wet = (tx: number, ty: number): boolean => {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
      const t = map.tiles[ty * W + tx] as number;
      return t === T_WATER || t === T_BRIDGE;
    };
    const span = (tx: number, ty: number, dx: number, dy: number): number => {
      let n = 1;
      for (let s = 1; wet(tx + dx * s, ty + dy * s); s++) n++;
      for (let s = 1; wet(tx - dx * s, ty - dy * s); s++) n++;
      return n;
    };
    // Diagonals count. Roads are polylines now, so a crossing can be taken at
    // any angle, and the shortest way over a channel is not necessarily along
    // an axis — measuring only x and y calls a perfectly ordinary diagonal
    // bridge a causeway.
    const shortestSpan = (tx: number, ty: number): number =>
      Math.min(
        span(tx, ty, 0, 1),
        span(tx, ty, 1, 0),
        Math.round(span(tx, ty, 1, 1) * 1.414),
        Math.round(span(tx, ty, 1, -1) * 1.414),
      );
    let bridges = 0;
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        if (map.tiles[ty * W + tx] !== T_BRIDGE) continue;
        bridges++;
        const ok = shortestSpan(tx, ty) <= plan.maxBridgeSpan;
        expect(ok, `causeway or sea bridge at (${tx}, ${ty})`).toBe(true);
      }
    }
    // Four crossings' worth: the boroughs are joined, and joining them is
    // what the bridges are for.
    expect(bridges).toBeGreaterThan(400);
  });

  it('refuses a plan that puts a landmark in the water', { timeout: 60_000 }, () => {
    const drowned = {
      ...cityPlanJson,
      landmarks: [{ kind: 'lighthouse', name: 'Sunk Light', rect: [20, 20, 3, 3] }],
    };
    expect(() => bakeCity(parseCityPlan(drowned))).toThrow(/stands in the water/);
  });

  it('refuses a carriageway too wide for the traffic model to read', () => {
    // See PlanRoad.median. A single road wider than a carriageway makes every
    // tile of it a junction, which is a whole-city failure from one number.
    const fat = {
      ...cityPlanJson,
      roads: [{ name: 'Too Wide', points: [[10, 10], [20, 20]], width: 9 }],
    };
    expect(() => parseCityPlan(fat)).toThrow(/use median/);
  });

  it('draws the same ground every time it is asked', { timeout: 60_000 }, () => {
    const a = buildLayout(plan);
    const b = buildLayout(plan);
    expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(true);
    expect(Buffer.from(a.district).equals(Buffer.from(b.district))).toBe(true);
    expect(a.blocks).toEqual(b.blocks);
  });
});
