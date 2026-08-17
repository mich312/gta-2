import {
  parseCityPlan,
  T_BRIDGE,
  T_BUILDING,
  T_FLOOR,
  T_ROAD,
  T_RUNWAY,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  LANDMARK_KINDS,
  smoothPolyline,
  type BakedCity,
} from 'shared';

/**
 * The city checker: everything a finished map has to be true of, asked once,
 * offline, exhaustively (WORLDGEN.md §12.4).
 *
 * It lives apart from `citybake.ts` because it stopped being one tool's
 * private business the moment a second thing produced a plan. A generated
 * city (`plangen.ts`) is held to exactly the checks a drawn one is — the same
 * function, not an equivalent one — which is the entire reason generating
 * plans instead of tiles is worth doing.
 */

export interface Problem {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Ground a car can occupy — the same rule the simulation uses (`isSolidTile`):
 * everything except walls, water and woodland. Connectivity is measured over
 * this rather than over roads alone, because a courtyard you can only reach
 * by mounting the kerb is still reachable, and the question being asked is
 * whether a player can get there.
 */
function drivable(t: number): boolean {
  return t !== T_BUILDING && t !== T_WATER && t !== T_TREES;
}

export function checkCity(city: BakedCity, plan: ReturnType<typeof parseCityPlan>): Problem[] {
  const problems: Problem[] = [];
  const W = city.widthTiles;
  const H = city.heightTiles;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (city.tiles[y * W + x] as number);

  // 1. One road network. A borough you cannot drive to is the failure mode
  //    the old generator shipped constantly — an island of streets with the
  //    river through the only crossing — and it is the one thing a map has
  //    to get right.
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  let total = 0;
  for (let s0 = 0; s0 < city.tiles.length; s0++) {
    if (!drivable(city.tiles[s0] as number) || (label[s0] as number) >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [s0];
    label[s0] = id;
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
        if ((label[j] as number) >= 0 || !drivable(city.tiles[j] as number)) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    sizes.push(n);
    total += n;
  }
  let main = 0;
  for (const [id, n] of sizes.entries()) if (n > (sizes[main] as number)) main = id;
  const reached = sizes[main] ?? 0;
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < label.length; i++) if (label[i] === main) seen[i] = 1;

  // A piece of ground with a runway on it is not orphaned, it is an airfield.
  // The plane-only island is the whole point of `byAir`, and counting its
  // ground as unreachable would make the checker complain about the feature.
  const airfield = new Set<number>();
  for (let i = 0; i < city.tiles.length; i++) {
    if (city.tiles[i] === T_RUNWAY && (label[i] as number) >= 0) airfield.add(label[i] as number);
  }
  // Nor is ground you can moor at. A barrier island, a spit or a beach with
  // no road on it is reached by boat, which is a way of getting somewhere.
  // What the check is actually for is ground with NO way in at all.
  const shored = new Set<number>();
  for (let i = 0; i < city.tiles.length; i++) {
    const id = label[i] as number;
    if (id < 0 || shored.has(id)) continue;
    const x = i % W;
    const y = (i - x) / W;
    if (
      at(x + 1, y) === T_WATER ||
      at(x - 1, y) === T_WATER ||
      at(x, y + 1) === T_WATER ||
      at(x, y - 1) === T_WATER
    ) {
      shored.add(id);
    }
  }
  let flown = 0;
  for (const id of airfield) if (id !== main) flown += sizes[id] as number;
  let sailed = 0;
  for (const id of shored) {
    if (id === main || airfield.has(id)) continue;
    sailed += sizes[id] as number;
  }
  const orphan = total - reached - flown - sailed;
  if (orphan > 0) {
    problems.push({
      severity: orphan > total * 0.02 ? 'error' : 'warning',
      message:
        `${orphan} of ${total} tiles of open ground have no way in at all — ` +
        `no road, no runway, no shore (${sizes.length} pieces in total, ` +
        `${airfield.size - 1} airfields, ${sailed} tiles reachable only by boat)`,
    });
  }

  // 1b. And one STREET network on top of it. Connectivity over open ground
  //     is what a player experiences; connectivity over carriageway is what
  //     the traffic model and the route planner see, and a stranded street is
  //     a car that can never get anywhere.
  {
    const roadLabel = new Int32Array(W * H).fill(-1);
    let pieces = 0;
    let stranded = 0;
    for (let s0 = 0; s0 < city.tiles.length; s0++) {
      const t0 = city.tiles[s0] as number;
      if ((t0 !== T_ROAD && t0 !== T_BRIDGE) || (roadLabel[s0] as number) >= 0) continue;
      const id = pieces++;
      let n = 0;
      const stack = [s0];
      roadLabel[s0] = id;
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
          const t = city.tiles[j] as number;
          if ((roadLabel[j] as number) >= 0 || (t !== T_ROAD && t !== T_BRIDGE)) continue;
          roadLabel[j] = id;
          stack.push(j);
        }
      }
      if (id > 0) stranded += n;
    }
    if (pieces > 1) {
      problems.push({
        severity: 'error',
        message: `the street network is in ${pieces} pieces (${stranded} tiles off the main one)`,
      });
    }
  }

  // 2. Every landmark on the map, and every landmark reachable.
  for (const kind of LANDMARK_KINDS) {
    if (!city.landmarks.some((l) => l.kind === kind)) {
      problems.push({ severity: 'error', message: `no ${kind} in the city` });
    }
  }
  // Matched by NAME, not by index: the bake stamps the country landmarks
  // before the ones that claim a city block, so the two lists are in
  // different orders and pairing them off by position quietly checks the
  // wrong building.
  const byAirNames = new Set(plan.landmarks.filter((l) => l.byAir).map((l) => l.name));
  for (const l of city.landmarks) {
    const dx = Math.floor(l.doorX / 16);
    const dy = Math.floor(l.doorY / 16);
    if (byAirNames.has(l.name)) {
      // Reached by air. What it needs is not a road but a runway on the same
      // piece of ground — you have to be able to leave again — and a shore
      // nobody can step onto, or it is merely a remote island.
      const piece = label[dy * W + dx] as number;
      const strip = piece >= 0 && airfield.has(piece);
      if (!strip) {
        problems.push({
          severity: 'error',
          message: `${l.name} is marked byAir but has no runway on its own ground`,
        });
      }
      let landable = 0;
      for (let i = 0; i < city.tiles.length; i++) {
        if ((label[i] as number) !== piece) continue;
        const x = i % W;
        const y = (i - x) / W;
        if (
          at(x + 1, y) === T_WATER ||
          at(x - 1, y) === T_WATER ||
          at(x, y + 1) === T_WATER ||
          at(x, y - 1) === T_WATER
        ) {
          landable++;
        }
      }
      if (landable > 0) {
        problems.push({
          severity: 'error',
          message:
            `${l.name} is marked byAir but ${landable} tiles of its shore can be ` +
            `stepped onto from a boat — the coast wants a cliff round it`,
        });
      }
      continue;
    }
    let near = false;
    for (let r = 0; r <= 6 && !near; r++) {
      for (let oy = -r; oy <= r && !near; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const j = (dy + oy) * W + (dx + ox);
          if (dy + oy >= 0 && dy + oy < H && dx + ox >= 0 && dx + ox < W && seen[j] === 1) {
            near = true;
            break;
          }
        }
      }
    }
    if (!near) {
      problems.push({ severity: 'error', message: `${l.name} (${l.kind}) has no road to it` });
    }
    if (at(l.x, l.y) === T_WATER) {
      problems.push({ severity: 'error', message: `${l.name} (${l.kind}) is in the water` });
    }
  }

  // 3. Shops: every kind present, every door on a pavement, every interior
  //    walkable. A shop you cannot get into is a shop that is not there.
  for (const kind of ['gun', 'clothing', 'spray'] as const) {
    const n = city.shops.filter((s) => s.kind === kind).length;
    if (n === 0) problems.push({ severity: 'error', message: `no ${kind} shop in the city` });
  }
  for (const s of city.shops) {
    if (at(s.doorX, s.doorY) !== T_SIDEWALK) {
      problems.push({
        severity: 'error',
        message: `${s.kind} shop door at ${s.doorX},${s.doorY} is not on a pavement`,
      });
    }
    if (at(s.entryX, s.entryY) !== T_FLOOR) {
      problems.push({
        severity: 'error',
        message: `${s.kind} shop doorway at ${s.entryX},${s.entryY} is walled up`,
      });
    }
  }

  // 3b. The road you drew is the road you got.
  //
  //     Every check above this one passed while two of the three named
  //     crossings of the strait were missing from the city. Kelvin Bridge and
  //     Marsh Causeway were drawn ending in open water, so their decks landed
  //     on one bank and §23.1's whole-deck rule deleted them — correctly, and
  //     silently. The Ring's east leg went the same way for being wider than
  //     `maxBridgeSpan`. Nothing noticed, because "one street network" is
  //     still true when a crossing vanishes: the two banks stay joined the
  //     long way round, and only a person flying over the map can see that
  //     56% of its width has no way across.
  //
  //     So: walk each authored road and ask whether carriageway is actually
  //     under it. A named road is a promise; this is the check that the bake
  //     kept it.
  {
    // A road's endpoints belong on land. Water is the drawing error that
    // deletes a bridge; a bridge tile means the road stops in mid-air over
    // the sea, which is the §23.1 pier by another route.
    for (const r of plan.roads) {
      const ends: Array<['start' | 'end', readonly [number, number]]> = [
        ['start', r.points[0] as readonly [number, number]],
        ['end', r.points[r.points.length - 1] as readonly [number, number]],
      ];
      for (const [which, [px, py]] of ends) {
        const t = at(Math.round(px), Math.round(py));
        if (t === T_WATER || t === T_BRIDGE) {
          problems.push({
            severity: 'error',
            message:
              `${r.name} ${which}s at ${Math.round(px)},${Math.round(py)}, which is ` +
              `${t === T_WATER ? 'open water' : 'a bridge deck'} — a road has to begin and end on land`,
          });
        }
      }
    }

    // And no gaps along the way. Sampled every half tile, a point counts as
    // carried if any tile within half the road's width plus one is
    // carriageway; the tolerance below is for the rounding at that edge, not
    // for missing road. GAP_TILES is deliberately small — the failure this
    // exists to catch is measured in tens of tiles, not ones.
    const GAP_TILES = 4;
    for (const r of plan.roads) {
      // The same curve the carve walks (`layout.ts:834`), not the polyline the
      // plan holds: a smoothed road leaves its own corners by several tiles,
      // and measuring the gap against the unsmoothed line reports the
      // smoothing as missing road.
      const line = r.curve ? smoothPolyline(r.points, 3) : r.points;
      const reach = Math.ceil(r.width / 2) + 1;
      const carried = (px: number, py: number): boolean => {
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const t = at(Math.round(px) + dx, Math.round(py) + dy);
            if (t === T_ROAD || t === T_BRIDGE) return true;
          }
        }
        return false;
      };
      let worst = 0;
      let worstAt: [number, number] = [0, 0];
      let run = 0;
      let runAt: [number, number] = [0, 0];
      for (let k = 0; k + 1 < line.length; k++) {
        const [ax, ay] = line[k] as readonly [number, number];
        const [bx, by] = line[k + 1] as readonly [number, number];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
        for (let s = 0; s <= steps; s++) {
          const px = ax + ((bx - ax) * s) / steps;
          const py = ay + ((by - ay) * s) / steps;
          if (carried(px, py)) {
            run = 0;
            continue;
          }
          if (run === 0) runAt = [Math.round(px), Math.round(py)];
          run += 0.5;
          if (run > worst) {
            worst = run;
            worstAt = runAt;
          }
        }
      }
      if (worst > GAP_TILES) {
        problems.push({
          severity: 'error',
          message:
            `${r.name} has ${worst.toFixed(0)} tiles of itself missing from the city, ` +
            `starting at ${worstAt[0]},${worstAt[1]} — the bake deleted a stretch of an authored road`,
        });
      }
    }
  }

  // 4. No road that simply stops in the sea without a quay to stop at.
  let drowned = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (at(x, y) !== T_ROAD) continue;
      if (at(x + 1, y) === T_WATER || at(x - 1, y) === T_WATER) drowned++;
      else if (at(x, y + 1) === T_WATER || at(x, y - 1) === T_WATER) drowned++;
    }
  }
  if (drowned > 0) {
    // An error since wave 2.4: the bake now quays every wet road edge it can
    // without severing the network, so any tile left is either a new
    // regression or a genuine severance case that needs a person. §23.1's
    // failure mode — a deck you can drive off into the sea — must not be a
    // log line.
    problems.push({ severity: 'error', message: `${drowned} road tiles run straight into water` });
  }

  return problems;
}
