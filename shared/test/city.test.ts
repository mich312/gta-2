import { describe, expect, it } from 'vitest';
import cityPlanJson from '../data/city-plan.json';
import worldgenJson from '../data/worldgen.json';
import { parseCityPlan, pointInPoly } from '../src/world/plan.js';
import { buildLayout } from '../src/world/layout.js';
import { bakeCity, decodeBakedCity, encodeBakedCity } from '../src/world/bake.js';
import { bevelOther } from '../src/world/bevel.js';
import { generateCity } from '../src/world/generate.js';
import { parseWorldgenParams } from '../src/world/params.js';
import {
  LANDMARK_KINDS,
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_RAMP,
  T_ROAD,
  T_RUNWAY,
  T_SAND,
  T_SIDEWALK,
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
    // ground a session is allowed to move — so skip exactly the tiles the
    // session turned into ramps and demand the rest IDENTICAL. The old gate
    // allowed `tiles.length / 1000` (589) differing tiles to cover ~230 ramp
    // tiles, which left ~360 tiles of real plan/asset drift passing silently
    // (PLAN-WORLDGEN.md wave 0.3).
    let differing = 0;
    for (let i = 0; i < baked.tiles.length; i++) {
      if (loaded.tiles[i] === T_RAMP) continue;
      if (baked.tiles[i] !== loaded.tiles[i]) differing++;
    }
    expect(differing).toBe(0);
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

  // Two whole layouts, which is 45 seconds of work on its own against a
  // 60-second budget — and it loses that race whenever the rest of the suite
  // is running beside it. The others here build one layout and finish in 25.
  it('draws the same ground every time it is asked', { timeout: 150_000 }, () => {
    const a = buildLayout(plan);
    const b = buildLayout(plan);
    expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(true);
    expect(Buffer.from(a.district).equals(Buffer.from(b.district))).toBe(true);
    expect(a.blocks).toEqual(b.blocks);
  });

  it('leaves no ground to nobody, and no borough walled off from its neighbours', { timeout: 60_000 }, () => {
    // The §14.4 seam invariants, together because they read the same plane.
    //
    // No orphan ground: every dry tile has an owner (§14.3 D1) — ground
    // that belongs to nobody gets no fabric, no esplanade and no invariants,
    // so a transition to it is a transition to an accident.
    //
    // Permeability: for every pair of boroughs that share a land edge, the
    // seam is crossable — a working share of its length for urban siblings
    // (the D2 seam street), deliberate gates for the countryside (the D3
    // stitch). The §14.1 review measured 5-12% between urban siblings;
    // these floors are what "made, not found" means as a number.
    const layout = buildLayout(plan);
    const { tiles, owner, water } = layout;
    const W = map.widthTiles;
    const H = map.heightTiles;

    let orphans = 0;
    for (let i = 0; i < owner.length; i++) {
      if (water[i] !== 1 && (owner[i] as number) < 0) orphans++;
    }
    expect(orphans).toBe(0);

    // Roads per borough, to exempt the trackless: a nature island with no
    // carriageway at all (Gannet Rock) has nothing for a gate to join.
    const roadsOf = new Array<number>(plan.districts.length).fill(0);
    const isRoad = (i: number): boolean => tiles[i] === T_ROAD || tiles[i] === T_BRIDGE;
    for (let i = 0; i < owner.length; i++) {
      if ((owner[i] as number) >= 0 && isRoad(i)) roadsOf[owner[i] as number]++;
    }

    type Seam = { len: number; cross: number; gates: Array<[number, number]> };
    const seams = new Map<string, Seam>();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (water[i] === 1) continue;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (water[j] === 1) continue;
          const a = owner[i] as number;
          const b = owner[j] as number;
          if (a < 0 || b < 0 || a === b) continue;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          let s = seams.get(key);
          if (!s) {
            s = { len: 0, cross: 0, gates: [] };
            seams.set(key, s);
          }
          s.len++;
          if (isRoad(i) && isRoad(j)) {
            s.cross++;
            if (!s.gates.some(([gx, gy]) => Math.max(Math.abs(gx - x), Math.abs(gy - y)) < 4)) {
              s.gates.push([x, y]);
            }
          }
        }
      }
    }

    // The sliver rule (§13.5, re-asserted over the seam bands per §14.4):
    // the seams are where two lattices tear, so it is where scrap blocks
    // concentrate. A block region within a few tiles of an owner change
    // must be at least twelve tiles of ground and at least three across —
    // anything smaller is the verge it looks like, and `componentsOf`
    // (layout.ts) is supposed to have dropped it.
    {
      const seamTile = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W - 1; x++) {
          const i = y * W + x;
          const a = owner[i] as number;
          const b = owner[i + 1] as number;
          const c = y + 1 < H ? (owner[i + W] as number) : a;
          if (a >= 0 && ((b >= 0 && b !== a) || (c >= 0 && c !== a))) seamTile[i] = 1;
        }
      }
      const nearSeam = (bx: number, by: number, bw: number, bh: number): boolean => {
        for (let y = Math.max(0, by - 4); y < Math.min(H, by + bh + 4); y++) {
          for (let x = Math.max(0, bx - 4); x < Math.min(W, bx + bw + 4); x++) {
            if (seamTile[y * W + x] === 1) return true;
          }
        }
        return false;
      };
      for (const b of layout.blocks) {
        if (!nearSeam(b.x, b.y, b.w, b.h)) continue;
        let area = 0;
        for (const v of b.mask) area += v;
        expect(area, `sliver block at ${b.x},${b.y}`).toBeGreaterThanOrEqual(12);
        if (b.w !== b.h) {
          expect(Math.min(b.w, b.h), `strip block at ${b.x},${b.y}`).toBeGreaterThanOrEqual(3);
        }
      }
    }

    for (const [key, s] of seams) {
      const [a, b] = key.split('|').map(Number) as [number, number];
      // A sliver of shared edge is a corner, not a seam; and a borough with
      // no roads at all cannot be gated into.
      if (s.len < 30) continue;
      if (roadsOf[a] === 0 || roadsOf[b] === 0) continue;
      const da = plan.districts[a];
      const db = plan.districts[b];
      const names = `${da?.name} | ${db?.name}`;
      if (!da?.rural && !db?.rural) {
        // Urban siblings: the seam street. 12% of the edge crossable and
        // at least two distinct crossings per hundred tiles.
        expect(s.cross / s.len, `crossable share of ${names}`).toBeGreaterThanOrEqual(0.12);
        expect(s.gates.length, `distinct crossings of ${names}`).toBeGreaterThanOrEqual(
          Math.ceil(s.len / 50),
        );
      } else {
        // The countryside: gates, not walls — one per 120 tiles of seam.
        expect(s.gates.length, `gates through ${names}`).toBeGreaterThanOrEqual(
          Math.ceil(s.len / 120),
        );
      }
    }
  });

  it('never jumps the land-use ladder without a mediating band', () => {
    // §9.4's red test, twelve months late, adopted as §14.4's ladder
    // invariant: land use may step one rank at a seam — downtown to
    // commercial, commercial to residential — and where the plan draws a
    // bigger jump, something must MEDIATE it: a street, a quay, a beach,
    // a hedge, the bare verge of a fringe. What may never happen is a
    // downtown pavement's building standing grass-to-wall against a park:
    // two built uses two ranks apart on adjacent tiles with nothing
    // between them.
    const W = map.widthTiles;
    const H = map.heightTiles;
    // District plane indices: downtown, residential, industrial,
    // commercial, park — ranked along §9.4's ladder.
    const RANK = [0, 2, 1, 1, 3] as const;
    // Ground that IS mediation: carriageway and pavement (a front
    // street), water's own ladder (quay, beach), woodland (a hedge), open
    // ground (a verge), and the working lot.
    const mediates = new Set([
      T_ROAD,
      T_BRIDGE,
      T_SIDEWALK,
      T_WATER,
      T_SAND,
      T_BANK,
      T_LOT,
      T_FIELD,
      T_TREES,
    ]);
    let violations = 0;
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = y * W + x;
        if (mediates.has(map.tiles[i] as number)) continue;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const j = (y + dy) * W + x + dx;
          if (mediates.has(map.tiles[j] as number)) continue;
          const a = RANK[map.district[i] as number] as number;
          const b = RANK[map.district[j] as number] as number;
          if (Math.abs(a - b) > 1) violations++;
        }
      }
    }
    expect(violations).toBe(0);
  });

  it('keeps every course centreline sample on its own ground', () => {
    // Wave 2.1's gate, measured before it was pinned: `trimCourses` already
    // splits and samples every course against the FINISHED tiles, and on
    // this bake the answer is exactly 100% — so the invariant is exact, not
    // a threshold. A sample off its ground means a pass moved road after
    // the trim ran, which is the ordering bug this test exists to catch.
    // Per kind since 3.2: carriageway for a road course, pavement for a
    // park walk.
    const W = map.widthTiles;
    const H = map.heightTiles;
    let off = 0;
    for (const c of map.courses ?? []) {
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [x0, y0] = c.points[k] as [number, number];
        const [x1, y1] = c.points[k + 1] as [number, number];
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
        for (let s = 0; s <= steps; s++) {
          const tx = Math.floor(x0 + ((x1 - x0) * s) / steps);
          const ty = Math.floor(y0 + ((y1 - y0) * s) / steps);
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) {
            off++;
            continue;
          }
          const t = map.tiles[ty * W + tx] as number;
          if (c.kind === 'path' ? t !== T_SIDEWALK : t !== T_ROAD && t !== T_BRIDGE) off++;
        }
      }
    }
    expect(off).toBe(0);
  });

  it('builds on the blocks the arterials cross', () => {
    // Wave 2.2. Blocks the ring crossed near an edge kept interior rows of
    // carriageway, so every frontage unit spanned the band and was refused —
    // fifteen whole blocks of Sunridge baked as bare field with nothing on
    // them (was down as "110 along the ring" in BUGS.md §7.6; measured with
    // a buildable-ground filter it was 15). The interior trim and the
    // slide-past-blocked-ground fix take it to 2; this holds the ceiling.
    const W = map.widthTiles;
    let empty = 0;
    for (const b of map.blocks) {
      if (b.district === 'park') continue;
      let road = 0;
      let buildable = 0;
      for (let y = b.y + 1; y < b.y + b.h - 1; y++) {
        for (let x = b.x + 1; x < b.x + b.w - 1; x++) {
          const t = map.tiles[y * W + x] as number;
          if (t === T_ROAD || t === T_BRIDGE) road++;
          if (t === T_LOT || t === T_PARK || t === T_FIELD) buildable++;
        }
      }
      if (road === 0 || buildable < 20) continue;
      const built = map.buildings.some(
        (bd) => bd.x < b.x + b.w && bd.x + bd.w > b.x && bd.y < b.y + b.h && bd.y + bd.h > b.y,
      );
      if (!built) empty++;
    }
    expect(empty).toBeLessThanOrEqual(3);
  });

  it('keeps runway ground inside the airstrips the plan drew', () => {
    // Wave 2.3. The airstrip recipe's apron was T_RUNWAY too, so the strip
    // ground spread four tiles past the drawn rect under the borough's
    // streets — from the air, roads crossed "the runway" and the runway was
    // three times the slab anybody drew. The apron is hardstanding now, and
    // this pins the slab to the drawing.
    const strips = plan.landmarks.filter((l) => l.kind === 'airstrip').map((l) => l.rect);
    const W = map.widthTiles;
    for (let y = 0; y < map.heightTiles; y++) {
      for (let x = 0; x < W; x++) {
        if (map.tiles[y * W + x] !== T_RUNWAY) continue;
        const inside = strips.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
        expect(inside, `runway tile at ${x},${y} outside every airstrip rect`).toBe(true);
      }
    }
  });

  it('lets no road run straight into open water', () => {
    // Wave 2.4. §23.1 drowned the decks that stopped mid-strait; the eight
    // corner slivers it left at bridge mouths are quayed by the bake now,
    // and the checker calls any survivor an error. This is the same claim
    // from the tile side: a carriageway edge is never bare against the sea.
    const W = map.widthTiles;
    const H = map.heightTiles;
    let wet = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (map.tiles[y * W + x] !== T_ROAD) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          if (map.tiles[(y + dy) * W + x + dx] === T_WATER) {
            wet++;
            break;
          }
        }
      }
    }
    expect(wet).toBe(0);
  });

  it('keeps merged tarmac sheets rare, and shrinking', () => {
    // Wave 4.6's gate, on the metric this repo can re-run: tiles at the
    // centre of a 7×7 all-carriageway window. One-shore banding took it
    // from 276 to 211 by ending the §28.3 two-family merges in the contour
    // boroughs; what remains is the avenue-crossing class §28 measured as
    // the suppression ceiling. The pin holds the ceiling: a change that
    // grows a new sheet — a fabric regression, a probe that stopped
    // probing — fails here before anyone has to see it from the air.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const cw = (x: number, y: number): boolean => {
      const t = map.tiles[y * W + x] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    let merged = 0;
    for (let y = 3; y < H - 3; y++) {
      for (let x = 3; x < W - 3; x++) {
        if (!cw(x, y)) continue;
        let all = true;
        for (let dy = -3; dy <= 3 && all; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (!cw(x + dx, y + dy)) {
              all = false;
              break;
            }
          }
        }
        if (all) merged++;
      }
    }
    expect(merged).toBeLessThanOrEqual(230);
  });

  it('gives stadiums and power stations an inside, not a slab', () => {
    // Wave 3.1, the slab test inverted: the flyover found the city's two
    // biggest named buildings rendering as featureless warehouse roofs
    // (`evidence/topdown-stadium-slab.png`). A stadium is a ring of stands
    // round an infield; a power station is halls and stacks over a yard. So:
    // several parts, an open interior, and at least two distinct authored
    // heights — a hash cannot know a chimney is a chimney.
    const W = map.widthTiles;
    for (const l of map.landmarks) {
      if (l.kind !== 'stadium' && l.kind !== 'power') continue;
      const parts = map.buildings.filter(
        (b) => b.x >= l.x && b.y >= l.y && b.x + b.w <= l.x + l.w && b.y + b.h <= l.y + l.h,
      );
      expect(parts.length, `${l.name} has too few parts`).toBeGreaterThanOrEqual(3);
      const heights = new Set(parts.map((b) => b.storeys));
      expect(heights.size, `${l.name} is one flat mass`).toBeGreaterThanOrEqual(2);
      let open = 0;
      for (let y = l.y; y < l.y + l.h; y++) {
        for (let x = l.x; x < l.x + l.w; x++) {
          if (map.tiles[y * W + x] !== T_BUILDING) open++;
        }
      }
      expect(open / (l.w * l.h), `${l.name} has no inside`).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('only bevels materials the painters know by name', () => {
    // The canary for the §31 class of bug: the deck pair was added to the
    // bevel yield tables without a case in the 2D painter's wedge switch,
    // so every parapet step's cut half fell through to the grass default —
    // green triangles over open sea on all three crossings
    // (REVIEW-WORLDGEN.md §2.3). This pins the set of materials a bevelled
    // corner can answer (`bevelOther`) to the set the painters handle
    // explicitly; a new yield pair fails here until `paintBevel`'s switch
    // learns its material.
    const painted = new Set([
      T_WATER,
      T_SAND,
      T_FIELD,
      T_PARK,
      T_TREES,
      T_ROAD,
      T_BRIDGE,
      T_SIDEWALK,
    ]);
    const bevel = map.bevel as Uint8Array;
    const seen = new Set<number>();
    for (let y = 0; y < map.heightTiles; y++) {
      for (let x = 0; x < map.widthTiles; x++) {
        if (bevel[y * map.widthTiles + x] === 0) continue;
        seen.add(bevelOther(map.tiles, bevel, map.widthTiles, x, y));
      }
    }
    for (const t of seen) {
      expect(painted.has(t), `bevelOther answers tile ${t}, which no painter names`).toBe(true);
    }
    // And the bridge pair is genuinely exercised — the wedges §2.3 was
    // about exist on this map, so the painter case above them is live.
    expect(seen.has(T_BRIDGE)).toBe(true);
  });
});
