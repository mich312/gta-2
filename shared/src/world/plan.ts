import { DISTRICT_TYPES, LANDMARK_KINDS, type DistrictType, type LandmarkKind } from './types.js';

/**
 * The authored city (WORLDGEN.md §12).
 *
 * There is one city and it was drawn, not rolled. This file is the schema for
 * the drawing: `shared/data/city-plan.json` holds the islands as outlines, the
 * rivers as courses, the boroughs as polygons with a street pitch each, the
 * roads as named polylines, and every landmark at the spot somebody chose for
 * it. `layout.ts` expands it into tiles and blocks and `bake.ts` freezes the
 * result into `city.data.ts`, which is what the game actually loads.
 *
 * The first version of this schema drew the coast as a grid of characters and
 * the roads as horizontal and vertical lines. It read as what it was: convex
 * blobs with chamfered corners, and a plaid laid over them. Outlines and
 * polylines replaced both, because the thing that makes a map look like a
 * place is that nothing in it is parallel to the screen.
 *
 * Nothing here is sampled per session and nothing depends on a seed. Two
 * things follow, and they are the whole reason for the change: the map can be
 * looked at and judged as a map, and it can be validated ONCE, offline,
 * exhaustively, instead of hoped about at runtime.
 */

/** A point in tiles. */
export type PlanPoint = [number, number];

/** A closed outline, in tiles. */
export type PlanPoly = PlanPoint[];

/**
 * A stroke: a course down which something is carved, tapering from `w0` at
 * the first point to `w1` at the last. Rivers, spits, coast roads.
 */
export interface PlanStroke {
  name: string;
  points: PlanPoint[];
  w0: number;
  w1: number;
  /**
   * Wander the course before carving it, by recursive midpoint displacement
   * perpendicular to each run. A river that runs from A to B in five straight
   * lines is a canal; this is what makes it a river.
   */
  meander: number;
}

export interface PlanIslet {
  name: string;
  at: PlanPoint;
  radius: number;
}

/** The land, before any street is carved into it. */
export interface PlanGeography {
  /** Main landmasses, as outlines. */
  islands: PlanPoly[];
  /** Bites taken out of them: bays, harbours, drowned valleys. */
  bays: PlanPoly[];
  /** Water enclosed by land. */
  lagoons: PlanPoly[];
  /** Land added back: spits growing downdrift from a headland. */
  spits: PlanStroke[];
  /** Watercourses, cut through the land, widening toward the mouth. */
  rivers: PlanStroke[];
  /** Rocks, stacks and barrier islands. */
  islets: PlanIslet[];
  /**
   * Landmasses that are cliff-bound: rock and scrub straight down to the
   * water, with no quay and no beach anywhere on them. Given as a point on
   * each one — the whole landmass containing it is sheer.
   *
   * A point rather than an outline because the coastline is warped after it
   * is drawn (§12.7) and an outline drawn round the intended shore is forty
   * tiles adrift of the real one by the time the bake is finished. "The
   * island under this point" survives the warp exactly.
   *
   * Geographically it is the windward half of the story the swell already
   * tells: headlands take the weather and get rock, bays are where the sand
   * collects. Mechanically it is a wall. A cliff tile is solid to anything on
   * land, so it cannot be stepped onto from a boat — and an island that is
   * cliff the whole way round is one you can only arrive at by air.
   */
  cliffIslands: PlanPoint[];
  /**
   * Where the swell comes from, as a unit vector. Shore facing into it is
   * planed straight and gets rock; shore in its lee keeps its inlets and gets
   * sand. One number's worth of asymmetry does more for believability than
   * another octave of noise.
   */
  swell: PlanPoint;
  /**
   * Coastline detail. `warp` is the amplitude of the longest octave in tiles
   * and `wave` its wavelength; three shorter octaves follow at half each. The
   * ratio warp/wave is the whole trick — around 0.15 gives a coast, below
   * 0.08 a blob, above 0.3 confetti.
   */
  warp: number;
  wave: number;
  /** Open water kept clear all the way round: the map's edge is the sea. */
  margin: number;
}

export interface StreetGrid {
  /** Street pitch in tiles along x (0 = no streets: the area is one block). */
  pitchX: number;
  pitchY: number;
  /** Carve width of a secondary street. */
  width: number;
  /**
   * Cut a service alley through the middle of any block bigger than this, in
   * tiles. 0 for none. Alleys are what turn a block from a wall into a maze
   * you can take a shortcut through, and the city had none.
   */
  alleyOver: number;
  /**
   * Rotate the whole lattice, in degrees clockwise on screen. 0 keeps the
   * borough on the screen axes and on the exact carve it always had.
   *
   * This is the `grid` fabric of WORLDGEN.md §13.4: a borough that grew
   * around its own harbour or its own island's long axis has streets that
   * run with THAT, not with the map edges — and the seam where two grids
   * meet at an angle is what makes neighbouring boroughs read as different
   * places instead of one plaid in two colours. Streets are carved in the
   * rotated frame, blocks become masked regions (§13.6 step 2 built that),
   * and the fill follows the street frontage rather than the box.
   */
  angle: number;
  /**
   * The §13.4 `contour` fabric: streets that follow the SHORE instead of
   * any straight frame. Long streets are iso-distance bands of the water
   * field — the innermost is the esplanade, `pitchX` apart as they climb
   * inland — and the cross streets are straight connectors perpendicular
   * to the shore's mean tangent, `pitchY` apart along it. A seafront
   * borough that grew along its beach has streets that curve with it,
   * which no rotation of a lattice can say. `angle` is ignored; the shore
   * supplies the frame.
   *
   * `spine` is the same idea with an AVENUE for a coastline: long streets
   * are offsets of the named plan road, `pitchX` apart on both sides, and
   * the cross streets run square to its mean course. A borough that grew
   * along its high street has streets that bend where it bends — and the
   * avenue itself finally gets frontage instead of slicing through
   * somebody else's lattice.
   *
   * `crescent` is the postwar suburb: the lattice's lines wander
   * sinusoidally instead of running straight, and every so often a stretch
   * of cross street simply is not there — loops and lollipops, dead ends
   * as a feature. The §13.5 dead-end budget belongs to these boroughs.
   */
  fabric: 'grid' | 'contour' | 'spine' | 'crescent';
  /** For `fabric: 'spine'`: the name of the plan road the borough hangs off. */
  spine: string;
  /**
   * For `fabric: 'contour'`: the BANDING SHORE, as a tile-space box drawn
   * over the water the borough fronts (wave 4.6, the approved design note).
   *
   * The contour bands used to trace iso-lines of distance to the NEAREST
   * water, so a borough with water on two sides laid two contour families
   * that met mid-borough — and where they met, streets landed on streets:
   * the merged tarmac sheets no suppression could finish, because neither
   * family was wrong. One borough, one shore: the field the bands trace is
   * seeded only from the water inside this box, the far waterfront gets
   * the ordinary esplanade street instead of a second family, and the box
   * is authored like everything else in the plan. Required on every
   * contour borough; must contain water.
   */
  bandShore?: [number, number, number, number];
}

export interface PlanDistrict {
  name: string;
  borough: string;
  district: DistrictType;
  /** The ground it covers. A polygon, so a borough can follow a shoreline. */
  area: PlanPoly;
  street: StreetGrid;
  /**
   * Open country: lane-scale subdivision, no kerbs, meadow and woodland
   * instead of a block interior.
   */
  rural: boolean;
  /** How solidly the blocks are built up, 0..1. Downtown is dense. */
  density: number;
}

/** A named road, carved along a course. Widths give the network a hierarchy. */
export interface PlanRoad {
  name: string;
  points: PlanPoint[];
  width: number;
  /**
   * A road of this class may be carried over water on a bridge. Streets may
   * not: a bridge is a piece of infrastructure and the plan says where they
   * are by saying which roads are big enough to have them.
   */
  bridges: boolean;
  /** Smooth the course into a curve rather than carving straight runs. */
  curve: boolean;
  /**
   * Tiles of central reservation. Non-zero makes this a DUAL carriageway:
   * two courses of `width`, this far apart, with unbuilt ground between them.
   *
   * It is how a motorway actually looks from above, and it is also the only
   * way to have one. `signals.isJunctionTile` calls tarmac that is over-wide
   * across both axes a junction — which is right, because a plaza is a
   * junction — so a single eight-lane carriageway makes the entire ring road
   * one junction with four hundred arms. Two four-lane carriageways with a
   * gap read as two roads to the traffic model and as a motorway to the eye.
   */
  median: number;
}

export interface PlanLandmark {
  kind: LandmarkKind;
  name: string;
  rect: [number, number, number, number];
  /**
   * Reached by air, and only by air. The bake will not cut it a driveway and
   * the checker will not ask for a road to it — but it does ask for tarmac
   * you can leave the ground from, because an airfield you can land at and
   * not take off from is a trap rather than a destination.
   */
  byAir: boolean;
}

export interface CityPlan {
  name: string;
  widthTiles: number;
  heightTiles: number;
  /**
   * The longest water crossing, in tiles, a road will carry a bridge over.
   * Wider than this and the water is sea: the road stops at the quay and the
   * boat is the way across.
   */
  maxBridgeSpan: number;
  geography: PlanGeography;
  districts: PlanDistrict[];
  roads: PlanRoad[];
  landmarks: PlanLandmark[];
  shopQuota: { gun: number; clothing: number; spray: number };
  /** Minimum distance between two shops of the same kind, in tiles. */
  shopSpacingTiles: number;
}

/**
 * The widest a single carriageway may be, in tiles. `sim/signals.ts` calls
 * road that is over-wide across BOTH axes a junction, with the same number as
 * its threshold; go past it and every tile of the road is a junction.
 */
export const MAX_CARRIAGEWAY = 4;

function fail(msg: string): never {
  throw new Error(`city plan: ${msg}`);
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`);
  return v as number;
}

function int(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${name} must be an integer`);
  return v as number;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} must be a non-empty string`);
  return v as string;
}

function point(v: unknown, name: string): PlanPoint {
  if (!Array.isArray(v) || v.length !== 2) fail(`${name} must be [x, y]`);
  return [num(v[0], `${name}[0]`), num(v[1], `${name}[1]`)];
}

function poly(v: unknown, name: string): PlanPoly {
  if (!Array.isArray(v) || v.length < 3) fail(`${name} must be at least three points`);
  return (v as unknown[]).map((p, i) => point(p, `${name}[${i}]`));
}

function stroke(v: unknown, name: string): PlanStroke {
  const o = (v ?? {}) as Record<string, unknown>;
  const pts = o['points'];
  if (!Array.isArray(pts) || pts.length < 2) fail(`${name}.points must be at least two points`);
  return {
    name: str(o['name'], `${name}.name`),
    points: (pts as unknown[]).map((p, i) => point(p, `${name}.points[${i}]`)),
    w0: num(o['w0'], `${name}.w0`),
    w1: num(o['w1'], `${name}.w1`),
    meander: typeof o['meander'] === 'number' ? o['meander'] : 0,
  };
}

function parseGeography(raw: unknown): PlanGeography {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = (key: string): unknown[] => (r[key] as unknown[] | undefined) ?? [];
  const islands = list('islands').map((p, i) => poly(p, `geography.islands[${i}]`));
  if (islands.length === 0) fail('geography.islands must contain at least one island');
  return {
    islands,
    bays: list('bays').map((p, i) => poly(p, `geography.bays[${i}]`)),
    lagoons: list('lagoons').map((p, i) => poly(p, `geography.lagoons[${i}]`)),
    spits: list('spits').map((s, i) => stroke(s, `geography.spits[${i}]`)),
    rivers: list('rivers').map((s, i) => stroke(s, `geography.rivers[${i}]`)),
    cliffIslands: list('cliffIslands').map((p, i) => point(p, `geography.cliffIslands[${i}]`)),
    islets: list('islets').map((v, i) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return {
        name: str(o['name'], `geography.islets[${i}].name`),
        at: point(o['at'], `geography.islets[${i}].at`),
        radius: num(o['radius'], `geography.islets[${i}].radius`),
      };
    }),
    swell: point(r['swell'] ?? [-1, 0], 'geography.swell'),
    warp: num(r['warp'] ?? 40, 'geography.warp'),
    wave: num(r['wave'] ?? 256, 'geography.wave'),
    margin: int(r['margin'] ?? 6, 'geography.margin'),
  };
}

export function parseCityPlan(raw: unknown): CityPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const widthTiles = int(r['widthTiles'], 'widthTiles');
  const heightTiles = int(r['heightTiles'], 'heightTiles');
  if (widthTiles <= 0 || heightTiles <= 0) fail('the map must have positive extent');

  const districts = ((r['districts'] as unknown[] | undefined) ?? []).map(
    (d, i): PlanDistrict => {
      const o = (d ?? {}) as Record<string, unknown>;
      const district = str(o['district'], `districts[${i}].district`) as DistrictType;
      if (!DISTRICT_TYPES.includes(district)) fail(`districts[${i}]: unknown district ${district}`);
      const s = (o['street'] ?? {}) as Record<string, unknown>;
      return {
        name: str(o['name'], `districts[${i}].name`),
        borough: str(o['borough'], `districts[${i}].borough`),
        district,
        area: poly(o['area'], `districts[${i}].area`),
        street: {
          pitchX: int(s['pitchX'], `districts[${i}].street.pitchX`),
          pitchY: int(s['pitchY'], `districts[${i}].street.pitchY`),
          width: int(s['width'], `districts[${i}].street.width`),
          alleyOver: typeof s['alleyOver'] === 'number' ? s['alleyOver'] : 0,
          angle: typeof s['angle'] === 'number' ? s['angle'] : 0,
          fabric:
            s['fabric'] === 'contour' || s['fabric'] === 'spine' || s['fabric'] === 'crescent'
              ? s['fabric']
              : 'grid',
          spine: typeof s['spine'] === 'string' ? s['spine'] : '',
          ...(Array.isArray(s['bandShore'])
            ? {
                bandShore: (() => {
                  const b = s['bandShore'] as unknown[];
                  if (b.length !== 4 || b.some((v) => typeof v !== 'number')) {
                    fail(`districts[${i}].street.bandShore must be [x, y, w, h]`);
                  }
                  return b as [number, number, number, number];
                })(),
              }
            : {}),
        },
        rural: o['rural'] === true,
        density: typeof o['density'] === 'number' ? o['density'] : 0.5,
      };
    },
  );
  if (districts.length === 0) fail('at least one district is required');

  const roads = ((r['roads'] as unknown[] | undefined) ?? []).map((a, i): PlanRoad => {
    const o = (a ?? {}) as Record<string, unknown>;
    const pts = o['points'];
    if (!Array.isArray(pts) || pts.length < 2) fail(`roads[${i}].points must be at least two`);
    const width = int(o['width'], `roads[${i}].width`);
    // See PlanRoad.median: anything wider than a carriageway has to be built
    // as two carriageways, or the traffic model calls the whole road a
    // junction. Caught here rather than in a render nobody looks at.
    if (width > MAX_CARRIAGEWAY) {
      fail(`roads[${i}] (${String(o['name'])}) is ${width} wide; use median for anything over ${MAX_CARRIAGEWAY}`);
    }
    return {
      name: str(o['name'], `roads[${i}].name`),
      points: (pts as unknown[]).map((p, k) => point(p, `roads[${i}].points[${k}]`)),
      width,
      bridges: o['bridges'] !== false,
      curve: o['curve'] === true,
      median: typeof o['median'] === 'number' ? o['median'] : 0,
    };
  });

  const landmarks = ((r['landmarks'] as unknown[] | undefined) ?? []).map(
    (l, i): PlanLandmark => {
      const o = (l ?? {}) as Record<string, unknown>;
      const kind = str(o['kind'], `landmarks[${i}].kind`) as LandmarkKind;
      if (!LANDMARK_KINDS.includes(kind)) fail(`landmarks[${i}]: unknown kind ${kind}`);
      const rect = o['rect'];
      if (!Array.isArray(rect) || rect.length !== 4) fail(`landmarks[${i}].rect must be [x,y,w,h]`);
      const rr = (rect as unknown[]).map((n, k) => int(n, `landmarks[${i}].rect[${k}]`));
      if ((rr[2] as number) <= 0 || (rr[3] as number) <= 0) {
        fail(`landmarks[${i}].rect must have positive extent`);
      }
      return {
        kind,
        name: str(o['name'], `landmarks[${i}].name`),
        rect: rr as [number, number, number, number],
        byAir: o['byAir'] === true,
      };
    },
  );

  const quota = (r['shopQuota'] ?? {}) as Record<string, unknown>;
  const plan: CityPlan = {
    name: str(r['name'], 'name'),
    widthTiles,
    heightTiles,
    maxBridgeSpan: int(r['maxBridgeSpan'], 'maxBridgeSpan'),
    geography: parseGeography(r['geography']),
    districts,
    roads,
    landmarks,
    shopQuota: {
      gun: int(quota['gun'], 'shopQuota.gun'),
      clothing: int(quota['clothing'], 'shopQuota.clothing'),
      spray: int(quota['spray'], 'shopQuota.spray'),
    },
    shopSpacingTiles: int(r['shopSpacingTiles'], 'shopSpacingTiles'),
  };

  for (const l of plan.landmarks) {
    const [x, y, w, h] = l.rect;
    if (x < 1 || y < 1 || x + w > plan.widthTiles - 1 || y + h > plan.heightTiles - 1) {
      fail(`landmark ${l.name} is outside the map`);
    }
  }
  for (const d of plan.districts) {
    if (d.street.fabric === 'spine' && !plan.roads.some((r) => r.name === d.street.spine)) {
      fail(`district ${d.name}: spine road "${d.street.spine}" is not in the plan`);
    }
    // One borough, one shore (wave 4.6): a contour borough that does not say
    // which water it fronts is a borough that bands against the NEAREST
    // water — which, with water on two sides, is the two-family merge the
    // bandShore exists to end. Whether the box actually contains water is
    // the layout's check; the geography has not been rasterised yet here.
    if (d.street.fabric === 'contour' && !d.street.bandShore) {
      fail(`district ${d.name} is contour but names no bandShore`);
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* Geometry the layout and the checker both need.                      */
/* ------------------------------------------------------------------ */

export function pointInPoly(poly: PlanPoly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as PlanPoint;
    const [xj, yj] = poly[j] as PlanPoint;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyBounds(poly: PlanPoly): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
}

export function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/**
 * Recursive midpoint displacement of a polyline, perpendicular to each run.
 *
 * Hashed off the midpoint's own coordinates, so the wander is the same every
 * bake and editing one end of a river does not move the other end's bends.
 */
export function meanderPolyline(
  points: PlanPoint[],
  seed: number,
  amplitude: number,
  depth: number,
  hash: (seed: number, xi: number, yi: number) => number,
): PlanPoint[] {
  let cur = points;
  for (let level = 0; level < depth; level++) {
    const next: PlanPoint[] = [cur[0] as PlanPoint];
    for (let i = 0; i + 1 < cur.length; i++) {
      const [ax, ay] = cur[i] as PlanPoint;
      const [bx, by] = cur[i + 1] as PlanPoint;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      const k = (hash(seed + level * 7919, Math.round(mx), Math.round(my)) - 0.5) * 2;
      const d = k * amplitude * Math.pow(0.55, level) * Math.min(1, len / 40);
      next.push([mx + nx * d, my + ny * d], cur[i + 1] as PlanPoint);
    }
    cur = next;
  }
  return cur;
}

/**
 * Ramer–Douglas–Peucker: drop every point a straight line already accounts
 * for, to within `eps` tiles.
 *
 * The counterpart to `smoothPolyline`, and the thing a RECOVERED course needs
 * that an authored one does not. A course chained out of tile centres carries
 * the lattice's own quantisation — a straight run of a hundred tiles arrives
 * as fifty points that alternate a quarter of a tile either side of the line
 * they are on — and a moving average lowers that noise without ever removing
 * it. Simplification does remove it: a straight run comes back as two points,
 * so the renderer's spline has nothing left to waver through.
 *
 * Iterative rather than recursive, for the same reason `shoreline.ts` is: a
 * traced coast or contour band can arrive with tens of thousands of points,
 * and the textbook recursion is one stack frame per split.
 */
export function simplifyPolyline(points: PlanPoint[], eps: number): PlanPoint[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = eps * eps;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi - lo < 2) continue;
    const [ax, ay] = points[lo] as PlanPoint;
    const [bx, by] = points[hi] as PlanPoint;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let worst = eps2;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = points[i] as PlanPoint;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
      const dx = px - (ax + vx * t);
      const dy = py - (ay + vy * t);
      const d = dx * dx + dy * dy;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at < 0) continue;
    keep[at] = 1;
    stack.push([lo, at], [at, hi]);
  }
  const out: PlanPoint[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(points[i] as PlanPoint);
  return out;
}

/**
 * Chaikin corner-cutting: turns a polyline of straight runs into a curve.
 *
 * Two rounds is enough to read as a curve at tile scale and cheap enough to
 * run on every road in the plan. This is what a coast road or a ring highway
 * needs — a road that turns in five straight segments reads as five roads.
 */
export function smoothPolyline(points: PlanPoint[], rounds = 2): PlanPoint[] {
  let cur = points;
  for (let r = 0; r < rounds; r++) {
    const next: PlanPoint[] = [cur[0] as PlanPoint];
    for (let i = 0; i + 1 < cur.length; i++) {
      const [ax, ay] = cur[i] as PlanPoint;
      const [bx, by] = cur[i + 1] as PlanPoint;
      next.push([ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25]);
      next.push([ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75]);
    }
    next.push(cur[cur.length - 1] as PlanPoint);
    cur = next;
  }
  return cur;
}
