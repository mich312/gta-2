import {
  parseCityPlan,
  roadCourses,
  T_BRIDGE,
  T_BUILDING,
  T_FLOOR,
  T_ROAD,
  T_RUNWAY,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  LANDMARK_KINDS,
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

  // 5. A road that may bridge has to actually be there, end to end.
  //
  //    `bridges: true` is a promise: this road crosses that water. Nothing
  //    checked that the bake kept it. Kelvin Bridge's course stopped fifteen
  //    tiles short of the far bank, so the no-piers pass (`layout.ts`, "no
  //    causeways and no piers") correctly reverted the whole deck to sea —
  //    and the plan still said there was a bridge there, the parser still
  //    accepted it, and this checker still returned zero problems. Three
  //    named crossings of the Kelvin were missing from the shipped city with
  //    nothing anywhere reporting it (R1-A01).
  //
  //    It is here and not in `parseCityPlan` for the reason that file already
  //    gives about `bandShore`: the geography has not been rasterised at
  //    parse time, so "is there land at the end of this line" is not a
  //    question the schema can ask. It is a question about a finished map,
  //    which is what this function is for — and asking it here holds a
  //    generated plan to it as well as a drawn one.
  //
  //    A warning, not an error, and deliberately: the rule reports a
  //    DISAGREEMENT between the plan and the map, and which of the two is
  //    wrong is a design decision each time. A crossing wider than
  //    `maxBridgeSpan` means the bake was right and the plan is asking for a
  //    ferry; a course that stops in the water usually means the polyline is
  //    short. The shipped city's surviving disagreements are pinned by name
  //    in `server/test/shippedCity.test.ts`, so a NEW one is a red test.
  for (const road of plan.roads) {
    if (!road.bridges) continue;
    const half = road.width / 2;
    for (const course of roadCourses(road)) {
      // Is any tile of the carriageway's cross-section built here? The
      // centreline alone is not the question: a road laid within half a
      // width of a shore keeps the landward half of its tiles, and that is a
      // narrow road, not a missing one.
      const built = (x: number, y: number, nx: number, ny: number): boolean => {
        for (let s = -half; s <= half; s += 0.5) {
          const tx = Math.round(x + nx * s);
          const ty = Math.round(y + ny * s);
          const t = at(tx, ty);
          if (t === T_ROAD || t === T_BRIDGE) return true;
        }
        return false;
      };
      interface Gap {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        len: number;
        fromStart: boolean;
      }
      let gap: Gap | null = null;
      const gaps: Gap[] = [];
      let sampled = 0;
      for (let k = 0; k + 1 < course.length; k++) {
        const [ax, ay] = course[k] as [number, number];
        const [bx, by] = course[k + 1] as [number, number];
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        const steps = Math.max(1, Math.ceil(len * 2));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          sampled++;
          if (built(x, y, nx, ny)) {
            gap = null;
            continue;
          }
          if (gap === null) {
            gap = {
              x0: Math.round(x),
              y0: Math.round(y),
              x1: 0,
              y1: 0,
              len: 0,
              fromStart: sampled === 1,
            };
            gaps.push(gap);
          }
          gap.x1 = Math.round(x);
          gap.y1 = Math.round(y);
          gap.len += len / steps;
        }
      }
      const openEnd = gap;
      for (const g of gaps) {
        // Shorter than the road is wide is the rasteriser rounding, not a
        // hole: a four-tile carriageway on a bend can miss its own centreline
        // by a tile without anything being absent.
        if (g.len <= road.width) continue;
        // Why the road is missing, in the terms the bake decided it: a course
        // that runs off its own end never had a far bank to land on, and a
        // crossing longer than the plan allows was refused on purpose.
        const why =
          g.fromStart || g === openEnd
            ? 'the course begins or ends out in the water, so the deck has land on one side only'
            : g.len > plan.maxBridgeSpan
              ? `a crossing longer than the plan's maxBridgeSpan of ${plan.maxBridgeSpan}`
              : 'no bridge was laid over it';
        problems.push({
          severity: 'warning',
          message:
            `${road.name} may bridge but ${g.len.toFixed(0)} tiles of its course carry no ` +
            `carriageway at all, from ${g.x0},${g.y0} to ${g.x1},${g.y1} — ${why}`,
        });
      }
    }
  }

  return problems;
}
