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
  landmarkParts,
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
    // Two questions, and they are not the same one. This is the first: is the
    // door on the piece of ground the rest of the city is on? `drivable` is
    // deliberately generous — a car park counts, and a landmark you reach by
    // mounting the kerb is still reached — so the answer is about the MAP
    // being in one piece, and the message says so rather than claiming a
    // street the flood never looked for (R1-A05).
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
      problems.push({
        severity: 'error',
        message:
          `${l.name} (${l.kind}) is cut off: no ground within six tiles of its door ` +
          `is on the same piece as the rest of the city`,
      });
    }
    // And the second: is there a STREET to arrive on? This is the promise
    // WORLDGEN.md §12.4 makes for the bake — "every landmark with a road
    // within six tiles" — and until now only `shared/test/city.test.ts` kept
    // it, over the drawn city alone. `checkCity` is the only gate a GENERATED
    // city passes through, so the checker has to ask it too, in the terms the
    // driveway pass (`bake.ts`, "every landmark has a way in") answers: a
    // frontage of real carriageway, not merely ground you could drive over.
    let frontage = false;
    for (let oy = -6; oy <= 6 && !frontage; oy++) {
      for (let ox = -6; ox <= 6; ox++) {
        const t = at(dx + ox, dy + oy);
        if (t === T_ROAD || t === T_BRIDGE) {
          frontage = true;
          break;
        }
      }
    }
    if (!frontage) {
      problems.push({
        severity: 'error',
        message: `${l.name} (${l.kind}) has no road within six tiles of its door`,
      });
    }
    if (at(l.x, l.y) === T_WATER) {
      problems.push({ severity: 'error', message: `${l.name} (${l.kind}) is in the water` });
    }
  }

  // 2b. And every landmark's stamped mass still standing at the end of it.
  //
  //     The bake draws each landmark's walls from `RECIPES[kind].parts` and
  //     then keeps going: later passes paint ground over the map, and
  //     `ground()` guards only on `paintable()`, which explicitly permits
  //     `T_BUILDING`. Chapel Green's reclaim apron reaches four tiles past
  //     its own rect, found Marsh Post standing three columns inside that
  //     reach, and painted six rows of the police station to park — a named
  //     station drawn four tiles wide inside a seven-tile record, with the
  //     `Building` entry intact and claiming all forty-nine (R5-A04).
  //
  //     Nothing downstream noticed because nothing downstream reads the
  //     record for solidity; collision, volume and the extruder all follow
  //     the tile plane. That is exactly why it needs asserting here: the
  //     damage is invisible everywhere except in the picture, and the next
  //     landmark to stand within four tiles of a later one gets the same
  //     treatment. The recipe is the source of truth for what should be
  //     there, so the check re-derives it rather than trusting the records.
  for (const l of city.landmarks) {
    const missing: string[] = [];
    for (const [dx, dy, pw, ph] of landmarkParts(l.kind, l.w, l.h)) {
      for (let ty = l.y + dy; ty < l.y + dy + ph; ty++) {
        for (let tx = l.x + dx; tx < l.x + dx + pw; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          if (at(tx, ty) !== T_BUILDING) missing.push(`${tx},${ty}`);
        }
      }
    }
    if (missing.length > 0) {
      problems.push({
        severity: 'error',
        message:
          `${l.name} (${l.kind}) has ${missing.length} tiles of its stamped mass painted ` +
          `away by a later pass, at ${missing.slice(0, 8).join(' ')}` +
          (missing.length > 8 ? ' ...' : ''),
      });
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
    // ...and no shop is hosted by a LANDMARK's own mass. `placeShopsFixed`
    // picks candidates out of `city.buildings`, which is the same array the
    // landmark stamps push into, and a stamped mass carries the inherited
    // district of the block it stands on — so for eight of them the pass saw
    // an ordinary shopfront and `carveInterior` hollowed the landmark out
    // into a wall ring, a floor and a two-tile garage door. Three police
    // stations got a respray, which the drive-through buy reaches from the
    // road tile outside and which clears the player's wanted level; three
    // infirmaries got one behind a door byte-identical to a clinic's, whose
    // whole invariant is that the ward is SOLID. The bake now hands its
    // `landmarkBuilt` set to the shop pass; this is the assertion that says
    // so, checked on geometry because the set does not survive the encode.
    const host = city.buildings[s.buildingIndex];
    if (host) {
      const lm = city.landmarks.find(
        (l) =>
          host.x < l.x + l.w && host.x + host.w > l.x && host.y < l.y + l.h && host.y + host.h > l.y,
      );
      if (lm) {
        problems.push({
          severity: 'error',
          message: `${s.kind} shop at ${s.doorX},${s.doorY} is carved into ${lm.name} (${lm.kind})`,
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
  //
  //    That severity is now the LAST thing standing between this rule and
  //    `error`, and it should be read as a countdown rather than a policy.
  //    Six of these stood for eleven iterations: 508 tiles of authored course
  //    with no carriageway on them, which at 20 px/tile is two carriageways
  //    ending in mid-air with rounded caps over open water and a 169-tile
  //    reach of sea where a road is drawn. No `mapaudit` signature fires on
  //    any of it — `road-deadend` wants a cap facing open ground and these
  //    face water, which reads as a legitimate quay — so the ONLY instrument
  //    that ever saw them was this line, and every run of the loop read "six
  //    warnings" as the stable baseline it was passing against. A defect a
  //    tool prints on every run and nobody acts on is furniture.
  //
  //    Iteration 11 settled five of the six (`evidence/iter11/`). The sixth,
  //    Coast Road from 360,685 to 520,681, is the one case none of this
  //    rule's three cures fits: the map has no room for the crossing, the
  //    polyline has nowhere on land to move to — between x=348 and x=415
  //    there is 1 to 4 tiles of ground between the ring road and the
  //    waterline, so the ring IS the coast road there — and dropping
  //    `bridges` would hide the hole rather than fill it. It needs an
  //    authoring decision about which road owns that shore. When it is taken,
  //    change this to `error` and the pin in `shippedCity.test.ts` to `[]`.
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

  // 6. No public street across a runway.
  //
  //    Wave 2.3 promised this rule and never wrote it: the suite pinned only
  //    the converse — every `T_RUNWAY` tile is inside an airstrip rect
  //    (`shared/test/city.test.ts`) — which says nothing about what else is
  //    on the strip. A borough's grid laid over an airfield is a landing you
  //    cannot use and traffic driving through a take-off run, and it is
  //    invisible from the ground (R1-A08).
  //
  //    The line the rule has to draw is between a spur and a through route,
  //    because the bake CUTS carriageway into these rects on purpose: every
  //    non-`byAir` landmark gets a driveway from its door to the nearest
  //    street (`bake.ts`, "every landmark has a way in"), and Marsh End's
  //    runs fourteen tiles up the strip to the hangar. That is a taxiway with
  //    a job (PROGRESS.md, wave 2.3) and must not be reported.
  //
  //    A street CROSSES: you can drive onto the strip from the city and off
  //    it back into the city, so traffic has a reason to be there. A track
  //    DEAD-ENDS: whatever is at its far end is served by the track itself
  //    and by nothing else. Counting the openings alone does not say which —
  //    a generated airfield (plangen seed 512) has its door on the far side,
  //    so the bake's own driveway comes up from the south, crosses the strip
  //    and joins the street network in the north, touching carriageway on
  //    two sides while still being one track to one door.
  //
  //    What tells them apart is where each opening LEADS. Take the map's
  //    carriageway with the strip's own carriageway lifted out of it: the
  //    city's street network is the largest piece that remains, and the tail
  //    of an access track is a stub of a dozen tiles that reaches nothing.
  //    An opening onto the network is a way in; an opening onto the stub is
  //    the other end of the same driveway. Two ways in is a crossing.
  //
  //    Known blind spot, and deliberate: a strip that is the ONLY link
  //    between two halves of a city reads as a spur here, because lifting it
  //    out leaves two pieces and only the larger is called the network. That
  //    city has a worse problem than its runway, and rule 1's own
  //    orphaned-ground and one-street-network reports are where it shows.
  for (const l of plan.landmarks) {
    if (l.kind !== 'airstrip') continue;
    const [rx, ry, rw, rh] = l.rect;
    const inRect = (x: number, y: number): boolean =>
      x >= rx && x < rx + rw && y >= ry && y < ry + rh;
    const carriageway = (x: number, y: number): boolean => {
      const t = at(x, y);
      return t === T_ROAD || t === T_BRIDGE;
    };
    // The street network as it would be without this strip: components of
    // carriageway with everything inside the rect lifted out, biggest first.
    const outside = new Int32Array(W * H).fill(-1);
    const outSizes: number[] = [];
    for (let s0 = 0; s0 < city.tiles.length; s0++) {
      const sx = s0 % W;
      const sy = (s0 - sx) / W;
      if (!carriageway(sx, sy) || inRect(sx, sy) || (outside[s0] as number) >= 0) continue;
      const id = outSizes.length;
      let n = 0;
      const q = [s0];
      outside[s0] = id;
      while (q.length > 0) {
        const i = q.pop() as number;
        n++;
        const x = i % W;
        const y = (i - x) / W;
        for (const [ox, oy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + ox;
          const ny = y + oy;
          if (!carriageway(nx, ny) || inRect(nx, ny)) continue;
          const j = ny * W + nx;
          if ((outside[j] as number) >= 0) continue;
          outside[j] = id;
          q.push(j);
        }
      }
      outSizes.push(n);
    }
    let network = -1;
    for (const [id, n] of outSizes.entries()) {
      if (network < 0 || n > (outSizes[network] as number)) network = id;
    }
    const walked = new Set<number>();
    for (let y0 = ry; y0 < ry + rh; y0++) {
      for (let x0 = rx; x0 < rx + rw; x0++) {
        if (!carriageway(x0, y0) || walked.has(y0 * W + x0)) continue;
        const stack = [y0 * W + x0];
        walked.add(y0 * W + x0);
        let tiles = 0;
        const mouths: Array<[number, number]> = [];
        while (stack.length > 0) {
          const i = stack.pop() as number;
          tiles++;
          const x = i % W;
          const y = (i - x) / W;
          for (const [dx2, dy2] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx2;
            const ny = y + dy2;
            if (!carriageway(nx, ny)) continue;
            if (!inRect(nx, ny)) {
              // Only where it leads back to the city. The far end of a
              // driveway leads to the door it was cut for and nowhere else.
              if ((outside[ny * W + nx] as number) === network) mouths.push([nx, ny]);
              continue;
            }
            const j = ny * W + nx;
            if (walked.has(j)) continue;
            walked.add(j);
            stack.push(j);
          }
        }
        // One mouth per OPENING, not per tile: a track two tiles wide leaves
        // two neighbouring tiles of street behind it and is still one way in,
        // and a four-lane one leaves four. Touching tiles are the same
        // opening, transitively — take the run, not the pair.
        const openings: Array<Array<[number, number]>> = [];
        for (const m of mouths) {
          const touching = openings.filter((o) =>
            o.some(([wx, wy]) => Math.abs(wx - m[0]) <= 1 && Math.abs(wy - m[1]) <= 1),
          );
          if (touching.length === 0) {
            openings.push([m]);
            continue;
          }
          const merged = touching.flat();
          merged.push(m);
          for (const o of touching) openings.splice(openings.indexOf(o), 1);
          openings.push(merged);
        }
        if (openings.length < 2) continue;
        const ways = openings.map((o) => o[0] as [number, number]);
        problems.push({
          severity: 'error',
          message:
            `a street runs through ${l.name}: ${tiles} carriageway tiles inside the strip, ` +
            `open to the network at ${ways.map(([mx, my]) => `${mx},${my}`).join(' and ')}`,
        });
      }
    }
  }

  return problems;
}
