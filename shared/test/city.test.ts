import { describe, expect, it } from 'vitest';
import cityPlanJson from '../data/city-plan.json';
import worldgenJson from '../data/worldgen.json';
import { parseCityPlan, pointInPoly, roadCourses, segmentDistance } from '../src/world/plan.js';
import { buildLayout, riverCourses } from '../src/world/layout.js';
import { bakeCity, decodeBakedCity, encodeBakedCity, landmarkParts } from '../src/world/bake.js';
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

  it(
    'cuts every contour borough across its bands, at whatever angle its shore runs',
    { timeout: 60_000 },
    () => {
      // R1-A03. The `contour` fabric takes the frame for its straight cross
      // streets from the principal axis of the borough's own waterline. That
      // sample used to be "tiles within two band units of water" — an
      // absolute threshold, which finds NOTHING in a borough whose banding
      // shore is a quay it does not own. The Docks' nearest owned dry tile is
      // nine units out, so the sample was empty, and the miss was silent: the
      // frame fell back to the authored `angle: 0` and the cross streets were
      // carved parallel to the bands they exist to cross. Twelve blocks in a
      // borough pitched at 28x24, the biggest of them 27x158.
      //
      // Asserted for EVERY contour borough and not for The Docks, because The
      // Terraces took the same empty sample and got away with it — its shore
      // happens to run at the authored 0 degrees. A borough that is right by
      // luck is the bug still being there.
      const layout = buildLayout(plan);
      const contours = plan.districts.filter((d) => d.street.fabric === 'contour');
      expect(contours.length).toBeGreaterThan(0);
      for (const d of contours) {
        const cell = d.street.pitchX * d.street.pitchY;
        const mine = layout.blocks.filter((b) => pointInPoly(d.area, b.x + b.w / 2, b.y + b.h / 2));
        expect(mine.length, `${d.name} is barely subdivided at all`).toBeGreaterThan(20);
        const areas = mine.map((b) => b.w * b.h).sort((a, z) => a - z);
        const median = areas[areas.length >> 1] as number;
        // A block is roughly the cell the borough was pitched at. Loose —
        // shore, arterials and landmarks all cut blocks smaller — but a
        // fabric carved along its own bands instead of across them lands
        // nowhere near it: The Docks' median was 1691 against a 672 cell.
        expect(
          median / cell,
          `${d.name}: median block ${median} tiles against a ${cell}-tile cell`,
        ).toBeLessThan(1.5);
      }
    },
  );

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

  it('crosses every named waterway an arterial is drawn over', () => {
    // R1-A02. The test above asks whether the decks that exist are honest
    // crossings; it cannot see a crossing that was never laid. Nor can the
    // connectivity test, which is satisfied by any way round however long.
    // So Hollis Creek — a named river with two arterials drawn straight
    // across it, The Esplanade and Longacre Road — shipped with no crossing
    // anywhere along its length and nothing red: both roads carried
    // `bridges: false`, the bake stopped them at the bank, and the drive from
    // one bank to the other was 458 road tiles for a gap of eight.
    //
    // The property is about the artifact, not the flag: a road course that
    // goes land, named water, land is a crossing the drawing asks for, and
    // the map has to carry one somewhere on that waterway.
    const W = map.widthTiles;
    const H = map.heightTiles;
    // The CARVED courses, not the drawn ones. Asked of the polylines in the
    // plan, "which river is this water" answers Hollis Creek for the middle
    // of Old Bridge's deck, a hundred tiles from the creek and squarely over
    // the Kelvin: the Kelvin's meander is 44 and its drawn line is nowhere
    // near its channel. That misattribution is exactly strong enough to hide
    // the bug this test is for.
    const rivers = riverCourses(plan);

    // Which named river a stretch of water belongs to: the nearest carved
    // centreline within reach. Reach only has to clear the widest channel's
    // half-width (17, the Kelvin at its mouth); the answer is the same for
    // anything from 12 to 64, because it is the nearest-centreline split that
    // separates the two rivers, not the radius. Water out of reach of every
    // river — the strait's bays, the sound, the open sea — belongs to none of
    // them and is not this test's business.
    const REACH = 24;
    const owner = (x: number, y: number): number => {
      let best = -1;
      let bestD = REACH;
      for (let i = 0; i < rivers.length; i++) {
        const pts = (rivers[i] as (typeof rivers)[number]).points;
        for (let k = 0; k + 1 < pts.length; k++) {
          const [ax, ay] = pts[k] as [number, number];
          const [bx, by] = pts[k + 1] as [number, number];
          const d = segmentDistance(x, y, ax, ay, bx, by);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      return best;
    };

    // Bridge tiles standing on each named river.
    const decked = rivers.map(() => 0);
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        if (map.tiles[ty * W + tx] !== T_BRIDGE) continue;
        const r = owner(tx, ty);
        if (r >= 0) decked[r] = (decked[r] as number) + 1;
      }
    }

    // Roads drawn across each named river: sampled along the carved course,
    // dry ground, then that river's water, then dry ground again.
    const crossers = rivers.map(() => [] as string[]);
    for (const road of plan.roads) {
      for (const course of roadCourses(road)) {
        const state = rivers.map(() => 0); // 0 before, 1 in the water, 2 through
        for (let k = 0; k + 1 < course.length; k++) {
          const [ax, ay] = course[k] as [number, number];
          const [bx, by] = course[k + 1] as [number, number];
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
          for (let s = 0; s <= steps; s++) {
            const x = Math.round(ax + ((bx - ax) * s) / steps);
            const y = Math.round(ay + ((by - ay) * s) / steps);
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const t = map.tiles[y * W + x] as number;
            // A bridge tile reads as the water it stands over: the course
            // that is now decked is exactly the one that crosses.
            const wet = t === T_WATER || t === T_BRIDGE;
            const r = wet ? owner(x, y) : -1;
            for (let i = 0; i < rivers.length; i++) {
              if (r === i) {
                if (state[i] === 0) state[i] = 1;
              } else if (!wet && state[i] === 1) {
                state[i] = 2;
              }
            }
          }
        }
        rivers.forEach((_, i) => {
          if (state[i] === 2 && !(crossers[i] as string[]).includes(road.name)) {
            (crossers[i] as string[]).push(road.name);
          }
        });
      }
    }

    for (let i = 0; i < rivers.length; i++) {
      const river = rivers[i] as (typeof rivers)[number];
      const across = crossers[i] as string[];
      if (across.length === 0) continue;
      expect(
        decked[i],
        `${river.name} is crossed by no bridge, though the plan draws ${across.join(', ')} across it`,
      ).toBeGreaterThan(0);
    }
    // And the drawing does put arterials over both named waterways, so
    // neither river is passing this test by having nothing to cross it.
    expect(rivers.map((r, i) => [r.name, (crossers[i] as string[]).length > 0])).toEqual([
      ['The Kelvin', true],
      ['Hollis Creek', true],
    ]);
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

  it('refuses a carriageway with no width at all', () => {
    // R1-A06, and the other end of the same domain. The parser checked only
    // the top of the range, so a width of 0 (or -3) was read, laid as nothing,
    // and became a course `decodeBakedCity` refuses outright — "a course with
    // no line or no width" — one pipeline stage and fifteen seconds later.
    // The drawing is where a malformed number should be caught.
    const thin = {
      ...cityPlanJson,
      roads: [{ name: 'No Width', points: [[10, 10], [20, 20]], width: 0 }],
    };
    expect(() => parseCityPlan(thin)).toThrow(/at least one tile/);
    const backwards = {
      ...cityPlanJson,
      roads: [{ name: 'Inside Out', points: [[10, 10], [20, 20]], width: -3 }],
    };
    expect(() => parseCityPlan(backwards)).toThrow(/at least one tile/);
  });

  it('refuses geometry drawn entirely off the map, and keeps the overhang legal', () => {
    // R1-A06. Only the landmark rect was bounds-checked; a river, a borough
    // or a road could be drawn at -900 and every stage downstream would clip
    // it to nothing without a word. The refusal is deliberately weak — off
    // the map ALTOGETHER, not merely over the edge — because running off the
    // frame is how both the drawn coast and every generated borough are made.
    const nowhere = {
      ...cityPlanJson,
      geography: {
        ...cityPlanJson.geography,
        rivers: [{ name: 'The Nowhere', points: [[-900, -900], [-800, -800]], w0: 8, w1: 8 }],
      },
    };
    expect(() => parseCityPlan(nowhere)).toThrow(/entirely off the map/);

    const first = cityPlanJson.districts[0] as { area: number[][] };
    const overhanging = {
      ...cityPlanJson,
      districts: cityPlanJson.districts.map((d, i) =>
        i === 0 ? { ...d, area: first.area.map(([x, y]) => [(x as number) - 200, y as number]) } : d,
      ),
    };
    expect(() => parseCityPlan(overhanging)).not.toThrow();
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

  it('keeps the huts off the slabs, so every strip is marked down one line', () => {
    // Wave 2.3's other promise, unkept until R1-A08: the hangar was stamped
    // at the rect's corner, notching nine tiles out of the runway. The
    // centreline rule (`client/render/tiles.ts`, `runwayCentreRow`) walks
    // each COLUMN to that column's own runway edges and marks the middle
    // row, so the three shortened columns put their dash a row south of the
    // rest and both strips were marked with a kink — at Marsh End x=507, at
    // Gannet x=79. The hut stands on a bay of apron now, and this is the
    // property that was actually wanted: one strip, one line.
    const W = map.widthTiles;
    for (const l of plan.landmarks.filter((m) => m.kind === 'airstrip')) {
      const [rx, ry, rw, rh] = l.rect;
      const rows = new Map<number, number>();
      for (let x = rx; x < rx + rw; x++) {
        for (let y = ry; y < ry + rh; y++) {
          if (map.tiles[y * W + x] !== T_RUNWAY) continue;
          let y0 = y;
          while (map.tiles[(y0 - 1) * W + x] === T_RUNWAY) y0--;
          let y1 = y;
          while (map.tiles[(y1 + 1) * W + x] === T_RUNWAY) y1++;
          if (y1 - y0 >= 2) rows.set(x, y0 + ((y1 - y0) >> 1));
          break;
        }
      }
      // Every column that carries runway carries it whole, and every one of
      // them agrees where the middle is.
      expect(rows.size, `${l.name} has no marked runway columns`).toBeGreaterThan(20);
      expect(new Set(rows.values()).size, `${l.name} centreline jogs: ${JSON.stringify([...rows])}`).toBe(1);
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

  it('puts no shop inside a landmark', () => {
    // The inverse of the test above, and the one nobody wrote. Where a
    // stadium and a power station must have an inside, every other landmark
    // must NOT have one carved for it by somebody else: `placeShopsFixed`
    // chooses its candidates out of `city.buildings`, which is the array the
    // landmark stamps push their own masses into, and those records carry the
    // inherited district of the block underneath. So the pass read eight
    // landmarks as ordinary shopfronts and `carveInterior` hollowed each into
    // a wall ring, a `T_FLOOR` room and a two-tile garage door — a respray in
    // The Spire and the Halloran Building, one in each of three infirmaries
    // whose ward the clinic code declares solid, and one in each of Kelvin
    // Road Station, Sunridge Station and Marsh Post. That last is the reason
    // this is a shipped-map test and not only a `checkCity` rule: a spray is
    // a drive-through with twice the doorway reach, so the buy lands from the
    // road tile outside the police station's front door and takes the wanted
    // level to zero without the player leaving the car.
    //
    // `checkCity` gates what `pnpm citybake` is allowed to WRITE. This gates
    // what the game LOADS — `map` is the shipped `city.data.ts` — which is
    // the thing that was actually broken, and which a hand-edit or a stale
    // commit can break again without the bake ever running.
    for (const s of map.shops) {
      // Clinics are registered onto the hospital doors by the session, not
      // carved: a clinic ON a hospital is the feature (`registerClinics`).
      if (s.kind === 'clinic') continue;
      const b = map.buildings[s.buildingIndex];
      if (!b) continue;
      const lm = map.landmarks.find(
        (l) => b.x < l.x + l.w && b.x + b.w > l.x && b.y < l.y + l.h && b.y + b.h > l.y,
      );
      expect(
        lm,
        `${s.kind} shop at ${s.doorX},${s.doorY} is carved into ${lm?.name} (${lm?.kind})`,
      ).toBeUndefined();
    }
  });

  it('keeps every landmark standing: the mass it stamped is still there', () => {
    // R5-A04. The bake stamps a landmark's walls from `RECIPES[kind].parts`
    // and then keeps painting: later passes lay ground over the map and
    // `ground()` guards only on `paintable()`, which explicitly permits
    // `T_BUILDING`. Chapel Green [544,539,12,12] claims its block twelve
    // landmarks after Marsh Post [536,549,7,7] and paints a four-tile reclaim
    // apron round itself; that apron reaches x540..559 y535..554, which
    // clipped to the police station is three columns by six rows. Eighteen
    // tiles of a named police station were repainted `T_PARK` while its
    // `Building` record went on claiming all forty-nine — a station drawn
    // four tiles wide inside a seven-tile rect.
    //
    // Nothing downstream caught it because nothing downstream reads the
    // record for solidity: collision, volume, the geometry builder and the
    // extruder all follow the tile plane, so there was no wall to walk
    // through and no test to go red. Which is exactly why the assertion has
    // to be made here, against the recipe rather than against the records —
    // the recipe is what the landmark was supposed to be.
    for (const l of map.landmarks) {
      const missing: string[] = [];
      for (const [dx, dy, pw, ph] of landmarkParts(l.kind, l.w, l.h)) {
        for (let ty = l.y + dy; ty < l.y + dy + ph; ty++) {
          for (let tx = l.x + dx; tx < l.x + dx + pw; tx++) {
            if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
            if (map.tiles[ty * map.widthTiles + tx] !== T_BUILDING) missing.push(`${tx},${ty}`);
          }
        }
      }
      expect(
        missing,
        `${l.name} (${l.kind}) has ${missing.length} tiles of its stamped mass painted away`,
      ).toEqual([]);
    }
  });

  it('leaves no landmark wall standing on the carriageway', () => {
    // R2 iteration 2, `kerb-missing`. Three landmarks shipped with a building
    // face flush against tarmac and pavement on their block's other sides —
    // Sunridge Station and Seaview Infirmary because the author's rect abuts
    // a lattice street and the kerb ring drawn round a landmark can only
    // paint ground, so a ring tile that is already road stays road; Vantage
    // Tower because the bake's own driveway pass cut its access track along
    // the tower's flank, which happens AFTER that ring is drawn and so could
    // never be caught by it.
    //
    // Stated over the whole city rather than over those three: the property
    // is that road meets wall through pavement, which is what the other 100%
    // of the city's road-to-wall contact does.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const solid = new Set([T_ROAD, T_BRIDGE]);
    // ...except the plazas. A square, a green and a circus WANT carriageway
    // through their footprint (`OPEN_TO_ROAD`) — King's Circus is a monument
    // standing in the ring's median, and a kerb round it would be a traffic
    // island where the design asks for a roundabout.
    const OPEN = new Set(['square', 'green', 'circus']);
    const flush: string[] = [];
    for (const l of map.landmarks) {
      if (OPEN.has(l.kind)) continue;
      for (let ty = l.y; ty < l.y + l.h; ty++) {
        for (let tx = l.x; tx < l.x + l.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          if (map.tiles[ty * W + tx] !== T_BUILDING) continue;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (solid.has(map.tiles[ny * W + nx] as number)) flush.push(`${l.name} ${tx},${ty}`);
          }
        }
      }
    }
    expect(flush.slice(0, 8), `${flush.length} landmark wall tiles abut carriageway`).toEqual([]);
  });

  it('cuts the junction where a street stops short of the street it runs at', { timeout: 60_000 }, () => {
    // R2 iteration 2, `road-stops-short`. Seventeen mouths in the shipped
    // city stopped two to four tiles short of the carriageway they ran at,
    // with grass or a tree across the gap. Fourteen are the ring being
    // limited-access (WORLDGEN.md §14.3 D6: a lattice line that would T into
    // its carriageways IS held a block short) and they belong here as much as
    // the crossings do — so the rule is not "no gaps" but "no gap over ground
    // nothing ever carved". `layout.cleared` is what tells the two apart: a
    // removal pass marks what it took out, and what it took out stays out.
    const layout = buildLayout(plan);
    const W = layout.widthTiles;
    const H = layout.heightTiles;
    const isRoad = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const t = layout.tiles[y * W + x] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    const uncut: string[] = [];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const px = dy;
      const py = dx;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // The square end of a mouth: road here, none ahead, none beside.
          if (!isRoad(x, y) || isRoad(x + dx, y + dy)) continue;
          if (isRoad(x - px, y - py)) continue;
          let len = 1;
          while (len < 7 && isRoad(x + px * len, y + py * len) && !isRoad(x + px * len + dx, y + py * len + dy)) {
            len++;
          }
          if (len < 2 || len > 6 || isRoad(x + px * len, y + py * len)) continue;
          // Square, and the same width three tiles back: a corner or a
          // junction mouth tapering out is not a street that stopped.
          let straight = true;
          for (let e = 1; e <= 3 && straight; e++) {
            for (let k = -1; k <= len && straight; k++) {
              const want = k >= 0 && k < len;
              if (isRoad(x + px * k - dx * e, y + py * k - dy * e) !== want) straight = false;
            }
          }
          if (!straight) continue;
          for (let d = 2; d <= 4; d++) {
            let across = 0;
            for (let k = 0; k < len; k++) {
              if (isRoad(x + px * k + dx * d, y + py * k + dy * d)) across++;
            }
            if (across === 0) continue;
            if (across * 2 < len) break;
            let virgin = true;
            for (let e = 1; e < d && virgin; e++) {
              for (let k = 0; k < len && virgin; k++) {
                const gx = x + px * k + dx * e;
                const gy = y + py * k + dy * e;
                const i = gy * W + gx;
                if (layout.cleared[i] !== 0 || layout.water[i] === 1) virgin = false;
                else if (layout.tiles[i] !== T_FIELD) virgin = false;
              }
            }
            if (virgin) uncut.push(`${x},${y} heading ${dx},${dy} ${d} short`);
            break;
          }
        }
      }
    }
    expect(uncut.slice(0, 8), `${uncut.length} mouths short of a road over untouched ground`).toEqual([]);
  });

  it('keeps the ring limited-access: the lattice joins it only at the authored junctions', () => {
    // The other half of the test above, and the half nothing asserted for
    // nine rounds. That one says a gap over VIRGIN ground is a junction
    // nobody cut; this one says a gap over ground the ring shave CLEARED
    // stays a gap. Without it, `road-stops-short`'s thirteen findings — every
    // one of which is a street held two tiles short of the ring, measured in
    // `evidence/iter9/` — read as thirteen defects, and closing them would
    // quietly reverse §14.3 D6: "a motorway with four hundred driveways is a
    // wide street, not a motorway", benched on the chase harness and shipped.
    //
    // Measured on the shipped map rather than the layout on purpose: three of
    // the seven mouths below are laid by the BAKE, after the shave has run and
    // where it cannot see them, and the player drives the bake.
    //
    // 150 mouths two tiles or more wide point at the ring's carriageways.
    // Outside a nine-tile dilation of the authored crossings, none of them
    // reaches it — except these seven, which is the budget this pins.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const courses = map.courses ?? [];
    expect(courses.filter((c) => c.kind === 'ring').length, 'no ring courses in the bake').toBeGreaterThan(0);
    const swept = (kind: string): Uint8Array => {
      const m = new Uint8Array(W * H);
      for (const c of courses) {
        if (c.kind !== kind) continue;
        const half = c.width / 2;
        for (let k = 0; k + 1 < c.points.length; k++) {
          const [ax, ay] = c.points[k] as readonly [number, number];
          const [bx, by] = c.points[k + 1] as readonly [number, number];
          const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
          const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
          const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
          const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1));
          for (let ty = y0; ty <= y1; ty++) {
            for (let tx = x0; tx <= x1; tx++) {
              if (segmentDistance(tx + 0.5, ty + 0.5, ax, ay, bx, by) <= half) m[ty * W + tx] = 1;
            }
          }
        }
      }
      return m;
    };
    const onRing = swept('ring');
    const onAvenue = swept('avenue');
    const carriageway = (i: number): boolean => {
      const t = map.tiles[i] as number;
      return t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
    };
    const ringRoad = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (onRing[i] === 1 && carriageway(i)) ringRoad[i] = 1;
    // An authored junction, dilated as `guardRingAccess` dilates it: ground
    // the ring and a named avenue both carved, flooded nine tiles.
    const JUNCTION_REACH = 9;
    const junction = new Uint8Array(W * H);
    const bag: number[] = [];
    const depth = new Int32Array(W * H).fill(-1);
    for (let i = 0; i < W * H; i++) {
      if (onRing[i] === 1 && onAvenue[i] === 1) {
        junction[i] = 1;
        depth[i] = 0;
        bag.push(i);
      }
    }
    expect(bag.length, 'the ring crosses no authored avenue').toBeGreaterThan(0);
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q] as number;
      if ((depth[i] as number) >= JUNCTION_REACH) continue;
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
        if (junction[j] === 1) continue;
        junction[j] = 1;
        depth[j] = (depth[i] as number) + 1;
        bag.push(j);
      }
    }
    // Every mouth two tiles or more across whose next tile IS the ring.
    const joined: string[] = [];
    let held = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const px = dy;
      const py = -dx;
      const meets = new Uint8Array(W * H);
      const short = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (ringRoad[i] === 1 || !carriageway(i)) continue;
          const fx = x + dx;
          const fy = y + dy;
          if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
          const f = fy * W + fx;
          // Joining the ring: the very next tile ahead is its carriageway.
          if (junction[i] !== 1 && ringRoad[f] === 1) meets[i] = 1;
          // Held short: the next tile ahead is not carriageway at all, and
          // the ring is within four.
          if (carriageway(f)) continue;
          for (let d = 1; d <= 4; d++) {
            const nx = x + dx * d;
            const ny = y + dy * d;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
            const j = ny * W + nx;
            if (!carriageway(j)) continue;
            if (ringRoad[j] === 1 && d > 1) short[i] = 1;
            break;
          }
        }
      }
      for (const [flag, sink] of [
        [meets, joined],
        [short, null],
      ] as const) {
        const used = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (flag[y * W + x] !== 1 || used[y * W + x] === 1) continue;
            let a0 = 0;
            let a1 = 0;
            while (
              x + px * (a0 - 1) >= 0 &&
              y + py * (a0 - 1) >= 0 &&
              flag[(y + py * (a0 - 1)) * W + (x + px * (a0 - 1))] === 1
            ) {
              a0--;
            }
            while (
              x + px * (a1 + 1) < W &&
              y + py * (a1 + 1) < H &&
              flag[(y + py * (a1 + 1)) * W + (x + px * (a1 + 1))] === 1
            ) {
              a1++;
            }
            for (let k = a0; k <= a1; k++) used[(y + py * k) * W + (x + px * k)] = 1;
            if (a1 - a0 + 1 < 2) continue;
            const cx = Math.round(x + px * ((a0 + a1) / 2));
            const cy = Math.round(y + py * ((a0 + a1) / 2));
            if (sink) sink.push(`${cx},${cy}`);
            else held++;
          }
        }
      }
    }
    // The six the shave does not reach: 456,664 was shaved and put back by the
    // orphan repair in `finishShores`, with 510,122 and 513,123 laid there
    // too; 461,118, 499,107 and 570,612 are laid by the bake, downstream of
    // the layout entirely. Named so that a seventh has to be looked at rather
    // than absorbed. `evidence/iter9/leaks.txt` has the pictures.
    //
    // There were SEVEN. The one that went is 641,307, and it went by being
    // fixed rather than by being excused: it was described here as "the
    // ring's own authored plumbing", and it was the tile where the ring's
    // eastern carriageway stopped dead at the water because the bay is 73
    // tiles wide and `maxBridgeSpan` was 72. Iteration 11 raised the span and
    // the deck was built, so that mouth is no longer a street meeting the
    // ring — it is the ring, continuous. `evidence/iter11/probe-ringjoins.mjs`
    // prints this list from a bake and reproduces all seven on the pre-fix
    // asset.
    expect(joined.sort(), 'a street now joins the ring outside an authored junction').toEqual(
      ['456,664', '461,118', '499,107', '510,122', '513,123', '570,612'],
    );
    // And the shave is still doing its work: opening the held mouths is how
    // a future round would "fix" `road-stops-short`, and this is the floor
    // that refuses it. 150 as shipped when this was written, 151 since the
    // ring's eastern crossing was built.
    expect(held, 'mouths held short of the ring').toBeGreaterThanOrEqual(140);
  });

  it('plants the country the block grid does not cover', () => {
    // R2 iteration 3. The rural fill runs over BLOCKS, and the blocks are cut
    // round the lattice inside the district's own polygon — so country that
    // no block covers is never asked what it is and keeps the bare meadow the
    // ground pass wrote. Two things leave country outside a block: a removal
    // pass deleting road after the blocks are cut (the corridor scar), and a
    // coastline the polygon does not reach. Gannet Rock's polygon begins at
    // y=598 and the island runs up to y=566, so its northern third shipped as
    // one unbroken meadow with the canopy starting on a dead straight line at
    // y=600; and Marsh End shipped 3,881 tiles of country outside its blocks
    // with NOT ONE TREE in them, against 41.5% wood in the country inside.
    //
    // The property is that both are the same country. It is thinner outside a
    // block — woodland is held a tile off every lane, off the waterline and
    // out of the mouth of any street — so the bar is half, not parity, and it
    // is asked only of a district with real ground outside its blocks.
    const layout = buildLayout(plan);
    const W = layout.widthTiles;
    const H = layout.heightTiles;
    const covered = new Uint8Array(W * H);
    for (const b of layout.blocks) {
      for (let ty = Math.max(0, b.y); ty < Math.min(H, b.y + b.h); ty++) {
        for (let tx = Math.max(0, b.x); tx < Math.min(W, b.x + b.w); tx++) {
          if (b.mask[(ty - b.y) * b.w + (tx - b.x)] === 1) covered[ty * W + tx] = 1;
        }
      }
    }
    const tally = new Map<string, { inAll: number; inWood: number; outAll: number; outWood: number }>();
    for (let i = 0; i < W * H; i++) {
      const own = layout.owner[i] as number;
      if (own < 0) continue;
      const d = plan.districts[own] as { name: string; rural?: boolean };
      if (d.rural !== true) continue;
      const t = map.tiles[i] as number;
      if (t !== T_FIELD && t !== T_TREES) continue;
      let row = tally.get(d.name);
      if (row === undefined) {
        row = { inAll: 0, inWood: 0, outAll: 0, outWood: 0 };
        tally.set(d.name, row);
      }
      if (covered[i] === 1) {
        row.inAll++;
        if (t === T_TREES) row.inWood++;
      } else {
        row.outAll++;
        if (t === T_TREES) row.outWood++;
      }
    }
    const bald: string[] = [];
    for (const [name, r] of tally) {
      if (r.outAll < 500 || r.inAll < 500) continue;
      const inside = r.inWood / r.inAll;
      const outside = r.outWood / r.outAll;
      if (outside < inside / 2) {
        bald.push(`${name}: ${(inside * 100).toFixed(1)}% wood in blocks, ${(outside * 100).toFixed(1)}% outside`);
      }
    }
    expect(bald).toEqual([]);
  });

  it('never plants a wood across the mouth of a street', () => {
    // R2 iteration 3, and it is the thing the fix above nearly broke. The
    // rural fill's rule for woodland beside a lane is one tile of verge,
    // which is a rule about the SIDE of a carriageway and says nothing about
    // the gap between the end of one and the start of the next. The ring's
    // held-short mouths (§14.3 D6) are three and four tiles deep, so the tile
    // in the middle of one stands clear of both carriageways and the first
    // draft of the country fill planted it: one tree at 502,642, and a street
    // that `mapaudit` rates `high` — "a street that cannot be driven at all"
    // — because a wood is solid to a car exactly like a wall.
    //
    // Asked of the ground OUTSIDE the blocks, which is the ground that pass
    // owns. A hedgerow standing between two lanes of a block is the rural
    // fill's own trick (§14.3 D5) and answers to its own rule.
    const layout = buildLayout(plan);
    const W = map.widthTiles;
    const H = map.heightTiles;
    const covered = new Uint8Array(W * H);
    for (const b of layout.blocks) {
      for (let ty = Math.max(0, b.y); ty < Math.min(H, b.y + b.h); ty++) {
        for (let tx = Math.max(0, b.x); tx < Math.min(W, b.x + b.w); tx++) {
          if (b.mask[(ty - b.y) * b.w + (tx - b.x)] === 1) covered[ty * W + tx] = 1;
        }
      }
    }
    const isRoad = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const t = map.tiles[y * W + x] as number;
      return t === T_ROAD || t === T_BRIDGE;
    };
    const walled: string[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (map.tiles[y * W + x] !== T_TREES || covered[y * W + x] === 1) continue;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as const) {
          let ahead = false;
          let behind = false;
          for (let k = 1; k <= 3; k++) {
            if (isRoad(x + dx * k, y + dy * k)) ahead = true;
            if (isRoad(x - dx * k, y - dy * k)) behind = true;
          }
          if (ahead && behind) walled.push(`${x},${y}`);
        }
      }
    }
    expect(walled.slice(0, 8), `${walled.length} trees standing in the gap between two carriageways`).toEqual([]);
  });

  it('moors no boat in water it cannot leave', () => {
    // R5-A03. `placeBoatSpawns` asked two local questions — a 3x3 of open
    // water, a bank within three tiles — and never asked whether the water
    // went anywhere. An ornamental park pond answers both: five of the
    // shipped city's moorings were motorboats in Ravenhill Park's pond (86
    // tiles) and Sunridge Park's (107), each ringed by a wholly dry
    // perimeter of sand and grass, each boat a live entity the session
    // spawns and a player can board from the path and then not drive.
    //
    // The medium is water OR bridge, which is exactly what `collide.ts`
    // lets a boat occupy — so this also keeps BUGS.md §9.2's older
    // guarantee, that no mooring is shut in by a BRIDGE, in the same
    // assertion instead of a second one that could drift from it.
    const W = map.widthTiles;
    const H = map.heightTiles;
    const open = (i: number): boolean => map.tiles[i] === T_WATER || map.tiles[i] === T_BRIDGE;
    const sea = new Uint8Array(W * H);
    const stack: number[] = [];
    const push = (i: number): void => {
      if (sea[i] === 1 || !open(i)) return;
      sea[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < W; x++) {
      push(x);
      push((H - 1) * W + x);
    }
    for (let y = 0; y < H; y++) {
      push(y * W);
      push(y * W + W - 1);
    }
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % W;
      const y = (i - x) / W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
    expect(map.boatSpawns.length).toBeGreaterThan(0);
    const landlocked = map.boatSpawns
      .map((b) => [Math.floor(b.x / TILE_SIZE), Math.floor(b.y / TILE_SIZE)] as const)
      .filter(([tx, ty]) => sea[ty * W + tx] !== 1)
      .map(([tx, ty]) => `${tx},${ty}`);
    expect(landlocked, 'moorings in water with no way out to sea').toEqual([]);
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
