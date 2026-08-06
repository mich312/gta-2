import { deriveSeed, nextFloat01 } from '../rng/prng.js';
import { valueNoise } from './fields.js';
import { buildLayout, paintShore } from './layout.js';
import {
  MAX_CARRIAGEWAY,
  smoothPolyline,
  type CityPlan,
  type PlanDistrict,
  type PlanLandmark,
  type PlanPoint,
  type PlanPoly,
  type PlanRoad,
  type StreetGrid,
} from './plan.js';
import {
  DISTRICT_TYPES,
  T_BANK,
  T_BRIDGE,
  T_ROAD,
  T_SAND,
  T_WATER,
  type DistrictType,
  type LandmarkKind,
} from './types.js';

/**
 * A city PLAN, generated (WORLDGEN.md §17).
 *
 * The generator this repository deleted (§12.6) made tiles. It sampled noise
 * fields, scored districts off them, laid an infinite arterial lattice and
 * handed the result straight to a session — which meant every check that
 * matters (one road network, every borough reachable, no street ending in the
 * sea) had to be either hoped about at runtime or skipped. It was skipped.
 *
 * This one makes a DRAWING. Its whole output is a `CityPlan`: a few hundred
 * numbers — island outlines, borough polygons, road polylines, landmark rects
 * — in exactly the schema `shared/data/city-plan.json` holds by hand. Every
 * pass downstream of it is the authored pipeline, unchanged, including the
 * bake's exhaustive validator. A generated city that fails the checks is
 * rejected before it is committed, the same as a drawn one that fails them.
 *
 * That is the whole architectural argument: the expensive, fragile part of
 * procedural city generation — streets that fit the ground, blocks that fit
 * the streets, buildings that fit the blocks — is already built and already
 * validated. What was missing was upstream of it, and it is small.
 *
 * The pipeline, and the one idea in it worth stating twice:
 *
 *   1. Roll an archetype and draw the LAND: island outlines as warped radial
 *      loops, bays bitten out of them, a river or a strait.
 *   2. **Paint the coast and measure it.** `paintWater` runs the real coast
 *      pass, warp and all, and everything after this point is placed against
 *      the shore that will actually exist rather than the polygon that was
 *      drawn. Without this step a borough seeded on the outline lands in the
 *      sea forty tiles from shore and a road routed round the drawn bay runs
 *      straight through the real one.
 *   3. Seed boroughs, weight them by a distance-from-centre gradient, and cut
 *      the map into cells: downtown at the middle, commercial round it,
 *      residential beyond, industry on the water, countryside at the rim.
 *   4. Route the arterials by anisotropic shortest path over that land —
 *      cheap on ground, dear over water, so a road goes round a bay and
 *      bridges a strait, and which of the two it does is decided by the
 *      geometry rather than by a rule.
 *   5. Lay the streets out ONCE (`buildLayout`) to find out where the blocks
 *      came out, and put the landmarks in blocks that exist.
 *   6. Emit the plan. `bakeCity` and the checker take it from there.
 *
 * Determinism is the same promise the rest of the world code makes: one seed
 * in, the same numbers out, on every host, with no `Math.random` anywhere.
 */

export interface PlanGenOptions {
  seed: number;
  widthTiles?: number;
  heightTiles?: number;
}

/**
 * The smallest map worth generating, in tiles a side.
 *
 * Not a tuning knob: the coast warp is ~22 tiles deep, the sea margin is 8,
 * and a city needs a downtown, a ring of boroughs round it and enough country
 * left over to put an airfield in. Under this the arithmetic simply does not
 * close, and it is better to say so than to fail later about a runway.
 */
export const MIN_MAP_TILES = 384;

/* ------------------------------------------------------------------ */
/* Rolling                                                             */
/* ------------------------------------------------------------------ */

/**
 * A mutable handle on the pure PRNG. Every stage takes its own stream off
 * `deriveSeed`, so adding a draw to the road router cannot move a borough.
 */
class Roll {
  private s: number;

  constructor(seed: number) {
    this.s = seed | 0;
  }

  f(): number {
    const [v, n] = nextFloat01(this.s);
    this.s = n;
    return v;
  }

  range(a: number, b: number): number {
    return a + this.f() * (b - a);
  }

  int(a: number, b: number): number {
    return a + Math.floor(this.f() * (b - a));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.min(xs.length - 1, Math.floor(this.f() * xs.length))] as T;
  }
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Names, assembled rather than sampled from a list of finished ones.
 *
 * A city whose boroughs are "District 3" and whose roads are "Arterial 7"
 * reads as output no matter how good its geometry is, and the fix costs two
 * arrays. Every name in the finished plan is built from these and is stable
 * for a seed, so a landmark keeps its name between bakes.
 */
const NAME_HEAD = [
  'Kel', 'Rav', 'Sun', 'Mar', 'Vas', 'Bran', 'Hol', 'Grey', 'Iron', 'Pine',
  'Ash', 'Corve', 'Dun', 'Wester', 'Hal', 'Bram', 'Kess', 'Loch', 'Nor', 'Sax',
  'Thorn', 'Wyn', 'Cald', 'Ember', 'Fal', 'Garn', 'Hem', 'Kirk',
] as const;
const NAME_TAIL = [
  'vin', 'hill', 'ridge', 'ford', 'wick', 'mouth', 'gate', 'bury', 'ness', 'holm',
  'stead', 'combe', 'church', 'field', 'bourne', 'haven', 'moor', 'cross',
] as const;
const ROAD_TAIL = ['Road', 'Street', 'Avenue', 'Way', 'Row', 'Approach', 'Parade', 'Rise'] as const;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/**
 * A closed outline drawn as a radius that wanders with the angle.
 *
 * The noise is sampled on a CIRCLE in noise space rather than on the angle
 * itself, which is what makes the loop close without a seam: θ and θ+2π are
 * the same sample point, so the last point and the first agree exactly. Three
 * octaves — one for the island's lobes, two for the headlands between them.
 * Everything below that scale is the coast pass's business, not this one's.
 */
function blobOutline(
  cx: number,
  cy: number,
  radius: number,
  aspect: number,
  rough: number,
  seed: number,
  points: number,
): PlanPoly {
  const out: PlanPoly = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let k = 0;
    k += (valueNoise(seed, ca * 1.7 + 8.5, sa * 1.7 + 8.5) - 0.5) * 2 * 0.62;
    k += (valueNoise(seed ^ 0x9e3779b9, ca * 3.4 + 3.1, sa * 3.4 + 3.1) - 0.5) * 2 * 0.3;
    k += (valueNoise(seed ^ 0x51ab7d31, ca * 6.9 + 21.7, sa * 6.9 + 21.7) - 0.5) * 2 * 0.14;
    const r = radius * (1 + k * rough);
    out.push([cx + ca * r * aspect, cy + (sa * r) / aspect]);
  }
  return out;
}

/** Ramer–Douglas–Peucker. Turns a routed path back into a few corners. */
function simplify(points: PlanPoint[], eps: number): PlanPoint[] {
  if (points.length < 3) return points.slice();
  const first = points[0] as PlanPoint;
  const last = points[points.length - 1] as PlanPoint;
  let worst = 0;
  let at = -1;
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i] as PlanPoint;
    const d = pointToSegment(p[0], p[1], first[0], first[1], last[0], last[1]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps || at < 0) return [first, last];
  const head = simplify(points.slice(0, at + 1), eps);
  const tail = simplify(points.slice(at), eps);
  head.pop();
  return head.concat(tail);
}

function pointToSegment(
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

/* ------------------------------------------------------------------ */
/* Stage 1 — the land                                                  */
/* ------------------------------------------------------------------ */

/**
 * What kind of place this is, rolled once at the top.
 *
 * §4's last item, and the cheapest macro variety there is: without it every
 * seed produces the same city re-shuffled, because every later decision is
 * made at the same scale for the same reasons. The three differ in the ONE
 * thing a player reads from the minimap in a second — how the water divides
 * the land — and everything downstream follows from that on its own.
 */
export type Archetype = 'estuary' | 'strait' | 'archipelago';

interface Geo {
  archetype: Archetype;
  plan: CityPlan;
  /** 1 where the coast pass says water, measured not guessed. */
  water: Uint8Array;
  /** Shore normal dotted with the swell: +1 fully exposed, -1 sheltered. */
  exposure: Float32Array;
}

function drawLand(opts: Required<PlanGenOptions>, name: string): Geo {
  const W = opts.widthTiles;
  const H = opts.heightTiles;
  const r = new Roll(deriveSeed(opts.seed, 'plangen.land'));
  const noiseSeed = deriveSeed(opts.seed, 'plangen.outline');
  const archetype = r.pick(['estuary', 'strait', 'archipelago'] as const);

  const margin = 8;
  const cx = W / 2 + r.range(-0.03, 0.03) * W;
  const cy = H / 2 + r.range(-0.03, 0.03) * H;
  // Big enough that the city is a place rather than a village, small enough
  // that the outline plus the warp cannot reach the map edge — the sea is the
  // world bound (§12.6) and a landmass touching the border loses it.
  const span = Math.min(W, H) / 2 - margin - 26;
  const radius = span * r.range(0.78, 0.9);
  const aspect = r.range(0.82, 1.18);

  const islands: PlanPoly[] = [
    blobOutline(cx, cy, radius, aspect, r.range(0.16, 0.26), noiseSeed, 64),
  ];

  // Bays: bites taken out of the rim, each centred ON the coast so half of it
  // lands inland. Two or three is a harbour and an inlet; more is lace.
  const bays: PlanPoly[] = [];
  const bayCount = r.int(2, 4);
  for (let i = 0; i < bayCount; i++) {
    const a = r.range(0, 2 * Math.PI);
    const br = radius * r.range(0.16, 0.26);
    bays.push(
      blobOutline(
        cx + Math.cos(a) * radius * aspect * r.range(0.86, 1.0),
        cy + (Math.sin(a) * radius * r.range(0.86, 1.0)) / aspect,
        br,
        1,
        0.3,
        noiseSeed ^ (0x2f01 + i * 977),
        24,
      ),
    );
  }

  // The water that divides the land. An estuary gets a river widening to its
  // mouth; a strait gets a tideway clean across, which is the shape the genre
  // is actually about — the interesting question on a split city is which
  // bridge, and you cannot ask it without the split.
  const rivers: CityPlan['geography']['rivers'] = [];
  const cut = r.range(0, 2 * Math.PI);
  const reach = radius * 1.35;
  if (archetype === 'strait') {
    rivers.push({
      name: 'The Tideway',
      points: [
        [cx - Math.cos(cut) * reach * aspect, cy - (Math.sin(cut) * reach) / aspect],
        [cx + r.range(-0.1, 0.1) * radius, cy + r.range(-0.1, 0.1) * radius],
        [cx + Math.cos(cut) * reach * aspect, cy + (Math.sin(cut) * reach) / aspect],
      ],
      w0: r.range(26, 34),
      w1: r.range(26, 34),
      meander: 16,
    });
  } else {
    rivers.push({
      name: `${pickName(r)} River`,
      points: [
        [cx + Math.cos(cut + 2.4) * radius * 0.35 * aspect, cy + (Math.sin(cut + 2.4) * radius * 0.35) / aspect],
        [cx + Math.cos(cut + 1.0) * radius * 0.6 * aspect, cy + (Math.sin(cut + 1.0) * radius * 0.6) / aspect],
        [cx + Math.cos(cut) * reach * aspect, cy + (Math.sin(cut) * reach) / aspect],
      ],
      w0: r.range(9, 13),
      w1: r.range(22, 30),
      meander: 22,
    });
  }

  // Offshore land. The gap is drawn at a bridgeable width, but nothing here
  // insists it stays one: the warp moves both shores, and whether the bridge
  // gets built is settled later by measuring the water the road would cross.
  // An island the arterials cannot reach becomes countryside instead, which
  // is a real kind of place rather than a failure.
  if (archetype === 'archipelago' || archetype === 'strait') {
    const extras = archetype === 'archipelago' ? 2 : 1;
    for (let i = 0; i < extras; i++) {
      const a = cut + r.range(1.9, 4.4);
      const rr = radius * r.range(0.22, 0.34);
      const gap = r.range(34, 52);
      const d = radius * r.range(0.9, 1.02) + gap + rr;
      const ix = cx + Math.cos(a) * d * aspect;
      const iy = cy + (Math.sin(a) * d) / aspect;
      // Only if it fits in the sea we have: an island half over the border is
      // a coastline the margin then eats.
      if (ix - rr < margin + 20 || iy - rr < margin + 20) continue;
      if (ix + rr > W - margin - 20 || iy + rr > H - margin - 20) continue;
      islands.push(blobOutline(ix, iy, rr, 1 / aspect, r.range(0.18, 0.3), noiseSeed ^ (0x77 + i * 613), 40));
    }
  }

  const swellA = r.range(0, 2 * Math.PI);
  const plan: CityPlan = {
    name,
    widthTiles: W,
    heightTiles: H,
    // Long enough to reach an offshore island across the sound it was drawn
    // with, short enough that the open sea still has no far bank.
    maxBridgeSpan: 96,
    geography: {
      islands,
      bays,
      lagoons: [],
      spits: [],
      rivers,
      // Islets are left out on purpose. A rock in the water is a lovely
      // thing and a stranded street network waiting to happen: the borough
      // whose polygon covers it gives it a fabric, the esplanade pass runs
      // a quay round it, and the checker rightly calls that a second road
      // network. Putting them back means owning them with countryside, and
      // that is a plan edit rather than a generator one.
      islets: [],
      cliffIslands: [],
      swell: [Math.cos(swellA), Math.sin(swellA)],
      warp: r.range(18, 26),
      wave: r.range(180, 250),
      margin,
    },
    districts: [],
    roads: [],
    landmarks: [],
    shopQuota: { gun: 0, clothing: 0, spray: 0 },
    shopSpacingTiles: 30,
  };

  const coast = paintShore(plan);
  return { archetype, plan, water: coast.water, exposure: coast.exposure };
}

function pickName(r: Roll): string {
  return `${r.pick(NAME_HEAD)}${r.pick(NAME_TAIL)}`;
}

/* ------------------------------------------------------------------ */
/* Stage 3 — the boroughs                                              */
/* ------------------------------------------------------------------ */

interface Site {
  x: number;
  y: number;
  district: DistrictType;
  rural: boolean;
  /** Multiplicative Voronoi weight: under 1 shrinks the cell it wins. */
  weight: number;
  name: string;
  /** Which landmass it stands on, from the flood fill over the real land. */
  land: number;
  /** Distance to the nearest water, in tiles. */
  fromSea: number;
  /** Component of the arterial network it ended up in. -1 until routed. */
  net: number;
}

/** Label every connected run of dry land. Sites need to know what they stand on. */
function landmasses(water: Uint8Array, W: number, H: number): { id: Int32Array; sizes: number[] } {
  const id = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  for (let s0 = 0; s0 < water.length; s0++) {
    if (water[s0] === 1 || (id[s0] as number) >= 0) continue;
    const me = sizes.length;
    let n = 0;
    const bag = [s0];
    id[s0] = me;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q] as number;
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
        if (water[j] === 1 || (id[j] as number) >= 0) continue;
        id[j] = me;
        bag.push(j);
      }
    }
    sizes.push(n);
  }
  return { id, sizes };
}

/** Chebyshev-ish distance from every land tile to the sea, by breadth-first sweep. */
function seaDistance(water: Uint8Array, W: number, H: number): Int32Array {
  const d = new Int32Array(W * H).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < water.length; i++) {
    if (water[i] === 1) {
      d[i] = 0;
      q.push(i);
    }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head] as number;
    const x = i % W;
    const y = (i - x) / W;
    const dv = (d[i] as number) + 1;
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
      if ((d[j] as number) >= 0) continue;
      d[j] = dv;
      q.push(j);
    }
  }
  return d;
}

/**
 * Seed the boroughs, and decide what each one is.
 *
 * Dart-throwing with a minimum separation rather than a lattice, because a
 * lattice of boroughs makes a lattice of arterials, and then the diagonal
 * avenue §3.3 recommends stealing has nothing to be diagonal to.
 *
 * The land use is §3.2's concentric-zone gradient, stated as a sort: rank
 * every site by its distance from the chosen downtown and hand out the types
 * in bands. It is the one thing every real city has and the old scored
 * generator never produced — a centre you can orient by from anywhere on the
 * minimap — and it falls out of ranking a list.
 */
function seedBoroughs(
  geo: Geo,
  seed: number,
  water: Uint8Array,
  W: number,
  H: number,
): Site[] {
  const r = new Roll(deriveSeed(seed, 'plangen.boroughs'));
  const { id: mass, sizes } = landmasses(water, W, H);
  const fromSea = seaDistance(water, W, H);
  let mainland = 0;
  for (const [i, n] of sizes.entries()) if (n > (sizes[mainland] as number)) mainland = i;

  // Where the middle of the mainland is. The centroid, not the map centre: a
  // crescent island's map centre is in the bay.
  let sx = 0;
  let sy = 0;
  let sn = 0;
  for (let i = 0; i < mass.length; i++) {
    if (mass[i] !== mainland) continue;
    sx += i % W;
    sy += (i - (i % W)) / W;
    sn++;
  }
  const midX = sx / Math.max(1, sn);
  const midY = sy / Math.max(1, sn);

  // Dart-throwing. The separation is set from the area so a small map gets
  // few boroughs and a big one gets many, rather than the same dozen smeared.
  const sep = Math.max(64, Math.sqrt((sn || 1) / 13));
  const sites: Site[] = [];
  for (let attempt = 0; attempt < 6000 && sites.length < 16; attempt++) {
    const x = Math.floor(r.range(0, W));
    const y = Math.floor(r.range(0, H));
    const i = y * W + x;
    if (water[i] === 1) continue;
    // Off the very edge of the land: a borough centred three tiles from the
    // sea is a cell that is nine tenths water.
    if ((fromSea[i] as number) < 14) continue;
    if ((sizes[mass[i] as number] as number) < 4000) continue;
    let ok = true;
    for (const s of sites) {
      if (Math.hypot(s.x - x, s.y - y) < sep) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    sites.push({
      x,
      y,
      district: 'residential',
      rural: false,
      weight: 1,
      name: '',
      land: mass[i] as number,
      fromSea: fromSea[i] as number,
      net: -1,
    });
  }

  // Downtown: the site nearest the mainland's middle that still has water
  // within reach. Every city in the genre grew round a harbour, and a
  // downtown three hundred tiles from the sea has no reason to be where it is.
  let downtown = 0;
  let best = Infinity;
  for (const [i, s] of sites.entries()) {
    if (s.land !== mainland) continue;
    const score = Math.hypot(s.x - midX, s.y - midY) + Math.max(0, s.fromSea - 90) * 1.5;
    if (score < best) {
      best = score;
      downtown = i;
    }
  }
  const anchor = sites[downtown] as Site;

  const ranked = sites
    .map((s, i) => ({ i, d: Math.hypot(s.x - anchor.x, s.y - anchor.y), s }))
    .sort((a, b) => a.d - b.d);

  const names: string[] = [];
  while (names.length < sites.length + 2) {
    const n = pickName(r);
    if (!names.includes(n)) names.push(n);
  }

  for (const [rank, entry] of ranked.entries()) {
    const s = entry.s;
    const frac = rank / Math.max(1, ranked.length - 1);
    const offshore = s.land !== mainland;
    let type: DistrictType;
    if (rank === 0) type = 'downtown';
    else if (rank === 1 && ranked.length > 7) type = 'downtown';
    else if (frac < 0.42) type = 'commercial';
    else if (frac < 0.8) type = 'residential';
    else type = 'residential';
    // Industry takes the water, and takes it far from the middle: the docks
    // are where the deep water and the cheap land are, which is never the
    // financial quarter. Offshore land is industrial before it is anything
    // else for the same reason.
    if (frac > 0.45 && (s.fromSea < 60 || offshore)) type = 'industrial';
    // One park in the middle third — the thing a chase needs and a grid
    // cannot give it — and countryside at the rim.
    if (rank > 1 && rank % 5 === 3) type = 'park';
    if (frac >= 0.88) type = 'park';
    s.district = type;
    s.rural = type === 'park' && frac >= 0.7;
    // §3.2's weights: downtown's cell shrinks so it reads as a core rather
    // than a quarter of the map, the outskirts' cells grow.
    s.weight = type === 'downtown' ? 0.74 : type === 'commercial' ? 0.92 : s.rural ? 1.3 : 1.12;
    s.name = names[rank] as string;
  }
  return sites;
}

/**
 * The cell each site wins, as a polygon.
 *
 * Multiplicatively weighted Voronoi, evaluated by marching outward from the
 * site along 72 rays until the ground stops belonging to it. Cells come out
 * star-shaped about their own site, which is what the layout's
 * point-in-polygon test wants, and 72 points is fine enough that the seam
 * between two boroughs reads as a street rather than a facet.
 *
 * Deliberately NOT clipped to the land: a borough has to own its own
 * waterfront or the esplanade pass (§13.4) will not run a street along it,
 * and the dead fringe between the last block and the sea comes back.
 */
function cellPolygon(sites: Site[], me: number, W: number, H: number): PlanPoly {
  const self = sites[me] as Site;
  const owns = (x: number, y: number): boolean => {
    const mine = Math.hypot(x - self.x, y - self.y) / self.weight;
    for (const [i, s] of sites.entries()) {
      if (i === me) continue;
      if (Math.hypot(x - s.x, y - s.y) / s.weight < mine) return false;
    }
    return true;
  };
  const RAYS = 72;
  const reach = Math.hypot(W, H);
  const out: PlanPoly = [];
  for (let k = 0; k < RAYS; k++) {
    const a = (2 * Math.PI * k) / RAYS;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let lo = 0;
    let hi = reach;
    // Binary search on the ray: the cell boundary is a single crossing for a
    // star-shaped cell, and 18 halvings put it inside a hundredth of a tile.
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      if (owns(self.x + ca * mid, self.y + sa * mid)) lo = mid;
      else hi = mid;
    }
    out.push([
      Math.max(-40, Math.min(W + 40, self.x + ca * lo)),
      Math.max(-40, Math.min(H + 40, self.y + sa * lo)),
    ]);
  }
  return simplify([...out, out[0] as PlanPoint], 2.5).slice(0, -1);
}

/**
 * The street fabric each kind of ground gets (§13.4).
 *
 * This is the "depending on the biome" half of the idea, and the reason it is
 * one lookup rather than a system: the fabrics already exist, and choosing
 * between them is the whole of what a land-use type has to say about how its
 * streets run. A downtown is a tight rotated grid; a seafront borough follows
 * its shore; a suburb wanders and dead-ends; the country gets lanes.
 */
function fabricFor(type: DistrictType, rural: boolean, coastal: boolean, r: Roll): StreetGrid {
  if (type === 'park' && !rural) {
    return { pitchX: 0, pitchY: 0, width: 3, alleyOver: 0, angle: 0, fabric: 'grid', spine: '' };
  }
  if (rural) {
    return {
      pitchX: r.int(36, 46),
      pitchY: r.int(30, 40),
      width: 2,
      alleyOver: 0,
      angle: 0,
      fabric: 'grid',
      spine: '',
    };
  }
  if (type === 'downtown') {
    const p = r.int(11, 16);
    return {
      pitchX: p,
      pitchY: p - r.int(2, 4),
      width: 3,
      alleyOver: p + 3,
      angle: r.int(0, 45),
      fabric: 'grid',
      spine: '',
    };
  }
  if (type === 'industrial') {
    return {
      pitchX: r.int(24, 30),
      pitchY: r.int(20, 26),
      width: 3,
      alleyOver: 0,
      angle: coastal ? 0 : r.int(0, 30),
      fabric: coastal ? 'contour' : 'grid',
      spine: '',
    };
  }
  if (type === 'commercial') {
    const p = r.int(15, 19);
    return {
      pitchX: p,
      pitchY: p - r.int(2, 4),
      width: 3,
      alleyOver: p + 4,
      angle: r.int(0, 45),
      fabric: coastal ? 'contour' : 'grid',
      spine: '',
    };
  }
  // Residential. The postwar suburb wanders; the older terraces climb from
  // the water on the contour; the rest is a lattice at its own bearing.
  const p = r.int(17, 24);
  const roll = r.f();
  return {
    pitchX: p,
    pitchY: p - r.int(2, 5),
    width: 3,
    alleyOver: 0,
    angle: r.int(0, 45),
    fabric: coastal && roll < 0.5 ? 'contour' : roll < 0.75 ? 'crescent' : 'grid',
    spine: '',
  };
}

/* ------------------------------------------------------------------ */
/* Stage 4 — the arterials                                             */
/* ------------------------------------------------------------------ */

/**
 * A minimal binary heap. A* over a 200×200 lattice a few dozen times does not
 * need anything cleverer, and a sorted array does need something cleverer.
 */
class Heap {
  private cost: number[] = [];
  private item: number[] = [];

  get size(): number {
    return this.item.length;
  }

  push(c: number, v: number): void {
    this.cost.push(c);
    this.item.push(v);
    let i = this.item.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.cost[p] as number) <= (this.cost[i] as number)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.item[0] as number;
    const c = this.cost.pop() as number;
    const v = this.item.pop() as number;
    if (this.item.length > 0) {
      this.cost[0] = c;
      this.item[0] = v;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const rr = l + 1;
        let m = i;
        if (l < this.item.length && (this.cost[l] as number) < (this.cost[m] as number)) m = l;
        if (rr < this.item.length && (this.cost[rr] as number) < (this.cost[m] as number)) m = rr;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const c = this.cost[a] as number;
    const v = this.item[a] as number;
    this.cost[a] = this.cost[b] as number;
    this.item[a] = this.item[b] as number;
    this.cost[b] = c;
    this.item[b] = v;
  }
}

const ROAD_STEP = 4;

/**
 * Route a road from A to B by anisotropic shortest path over the land.
 *
 * Galin et al.'s method, with the terrain reduced to the one distinction this
 * world has: ground is cheap, water is dear. That single ratio is enough to
 * make the interesting decision by itself — a road goes the long way round a
 * bay when the detour is shorter than the crossing is expensive, and bridges
 * the strait when it is not — so nothing here has a rule that says "bridge
 * here". The plan's `maxBridgeSpan` then has the last word: a course that
 * ends up wading further than a bridge can span is thrown away, and whatever
 * it was going to connect is reached another way or not at all.
 *
 * Cost is also nudged UP within a few tiles of the shore. Not for looks: a
 * road that grazes the coastline for two hundred tiles gets the esplanade
 * pass carving a second street beside it, and the pair read as a mistake.
 */
function routeRoad(
  water: Uint8Array,
  fromSea: Int32Array,
  W: number,
  H: number,
  a: PlanPoint,
  b: PlanPoint,
): PlanPoint[] | null {
  const gw = Math.ceil(W / ROAD_STEP);
  const gh = Math.ceil(H / ROAD_STEP);
  const tile = (gx: number, gy: number): number => {
    const tx = Math.min(W - 1, gx * ROAD_STEP + (ROAD_STEP >> 1));
    const ty = Math.min(H - 1, gy * ROAD_STEP + (ROAD_STEP >> 1));
    return ty * W + tx;
  };
  const cellCost = (gx: number, gy: number): number => {
    const i = tile(gx, gy);
    if (water[i] === 1) return 15;
    const d = fromSea[i] as number;
    return d < 5 ? 2.2 : d < 9 ? 1.4 : 1;
  };

  const start = Math.floor(a[1] / ROAD_STEP) * gw + Math.floor(a[0] / ROAD_STEP);
  const goal = Math.floor(b[1] / ROAD_STEP) * gw + Math.floor(b[0] / ROAD_STEP);
  const g = new Float64Array(gw * gh).fill(Infinity);
  const from = new Int32Array(gw * gh).fill(-1);
  const done = new Uint8Array(gw * gh);
  const gx1 = goal % gw;
  const gy1 = (goal - gx1) / gw;
  const heap = new Heap();
  g[start] = 0;
  heap.push(0, start);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (done[cur] === 1) continue;
    done[cur] = 1;
    if (cur === goal) break;
    const cx = cur % gw;
    const cy = (cur - cx) / gw;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (done[j] === 1) continue;
      const step = dx !== 0 && dy !== 0 ? 1.414 : 1;
      const cost = (g[cur] as number) + step * (cellCost(cx, cy) + cellCost(nx, ny)) * 0.5;
      if (cost >= (g[j] as number)) continue;
      g[j] = cost;
      from[j] = cur;
      heap.push(cost + Math.hypot(nx - gx1, ny - gy1), j);
    }
  }
  if (!Number.isFinite(g[goal] as number)) return null;

  const path: PlanPoint[] = [];
  for (let i = goal; i !== -1; i = from[i] as number) {
    const x = i % gw;
    const y = (i - x) / gw;
    path.push([x * ROAD_STEP + (ROAD_STEP >> 1), y * ROAD_STEP + (ROAD_STEP >> 1)]);
    if (i === start) break;
  }
  path.reverse();
  path[0] = [a[0], a[1]];
  path[path.length - 1] = [b[0], b[1]];
  return simplify(path, 6);
}

/**
 * The longest unbroken run of water the finished course crosses, in tiles.
 *
 * Measured on the SMOOTHED polyline, because smoothing is what the layout
 * will carve: Chaikin pulls a curve to the inside of its corners, and a
 * course that cleared a headland as drawn can cut the corner off it once
 * rounded. Measuring the drawing rather than the carve is how you ship a
 * causeway nobody meant.
 */
function longestWade(points: PlanPoint[], water: Uint8Array, W: number, H: number): number {
  let worst = 0;
  let run = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const [ax, ay] = points[k] as PlanPoint;
    const [bx, by] = points[k + 1] as PlanPoint;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(ax + ((bx - ax) * s) / steps);
      const y = Math.round(ay + ((by - ay) * s) / steps);
      const wet = x < 0 || y < 0 || x >= W || y >= H || water[y * W + x] === 1;
      if (wet) {
        run += len / steps;
        worst = Math.max(worst, run);
      } else {
        run = 0;
      }
    }
  }
  return worst;
}

interface Edge {
  a: number;
  b: number;
  cost: number;
  points: PlanPoint[];
}

/**
 * The arterial network: a spanning tree over the boroughs, plus the short
 * extra links that turn it into a network you can make a decision in.
 *
 * A tree alone is the shape of a road system nobody enjoys — one route
 * between any two points, so a chase has no branches. The extra edges are
 * capped at a length, not a count: a second link between two boroughs already
 * near each other is a parallel route, and one across the map is a motorway
 * nobody asked for.
 */
function buildRoads(
  sites: Site[],
  water: Uint8Array,
  fromSea: Int32Array,
  W: number,
  H: number,
  maxSpan: number,
  seed: number,
): { roads: PlanRoad[]; net: number[] } {
  const r = new Roll(deriveSeed(seed, 'plangen.roads'));
  const candidates: Edge[] = [];
  const near = Math.hypot(W, H) * 0.34;
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i] as Site;
      const b = sites[j] as Site;
      if (Math.hypot(a.x - b.x, a.y - b.y) > near) continue;
      const pts = routeRoad(water, fromSea, W, H, [a.x, a.y], [b.x, b.y]);
      if (pts === null || pts.length < 2) continue;
      // What the layout will actually carve, measured before it carves it.
      if (longestWade(smoothPolyline(pts, 3), water, W, H) > maxSpan - 10) continue;
      let cost = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const p = pts[k] as PlanPoint;
        const q = pts[k + 1] as PlanPoint;
        cost += Math.hypot(q[0] - p[0], q[1] - p[1]);
      }
      candidates.push({ a: i, b: j, cost, points: pts });
    }
  }
  candidates.sort((x, y) => x.cost - y.cost);

  // Kruskal. The union-find is four lines and the alternative is a bug.
  const parent = sites.map((_, i) => i);
  const find = (i: number): number => {
    let k = i;
    while ((parent[k] as number) !== k) k = parent[k] as number;
    return k;
  };
  const chosen: Edge[] = [];
  for (const e of candidates) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    chosen.push(e);
  }
  const treeLength = chosen.reduce((s, e) => s + e.cost, 0) / Math.max(1, chosen.length);
  for (const e of candidates) {
    if (chosen.includes(e)) continue;
    if (e.cost > treeLength * 1.15) continue;
    if (r.f() < 0.45) continue;
    chosen.push(e);
  }

  const names: string[] = [];
  const roads: PlanRoad[] = chosen.map((e, i) => {
    const a = sites[e.a] as Site;
    const b = sites[e.b] as Site;
    let name = `${r.f() < 0.5 ? a.name : b.name} ${r.pick(ROAD_TAIL)}`;
    while (names.includes(name)) name = `${pickName(r)} ${r.pick(ROAD_TAIL)}`;
    names.push(name);
    return {
      name,
      points: e.points,
      // The trunk routes get the full carriageway, the links one less. A
      // hierarchy the eye can read at 240 px is most of what "this is an
      // arterial" means from above.
      width: i < chosen.length * 0.6 ? MAX_CARRIAGEWAY : MAX_CARRIAGEWAY - 1,
      bridges: true,
      curve: true,
      median: 0,
    };
  });

  // Which boroughs the finished network actually joins up. A site the router
  // could not reach is about to lose its streets, and it has to be told.
  const net = sites.map((_, i) => i);
  const find2 = (i: number): number => {
    let k = i;
    while ((net[k] as number) !== k) k = net[k] as number;
    return k;
  };
  for (const e of chosen) {
    const ra = find2(e.a);
    const rb = find2(e.b);
    if (ra !== rb) net[ra] = rb;
  }
  return { roads, net: sites.map((_, i) => find2(i)) };
}

/* ------------------------------------------------------------------ */
/* Stage 4b — the shore parishes                                       */
/* ------------------------------------------------------------------ */

/**
 * The leeward coast, handed back to the country.
 *
 * Without this the generated city has almost no beach, and the reason is a
 * decision made two stages ago: the borough cells are not clipped to the
 * land, so an urban borough owns its own waterfront — which is exactly what
 * makes the esplanade pass run a street along it (§13.4). The shore pass then
 * quays every urban waterline it finds (`layout.ts`: sand needs a `park`
 * district AND `exposure < -0.15`), and a quay is coursed masonry that stays
 * square on purpose (§15.2). Measured on the first draft: 2,207 tiles of quay
 * against 198 of sand, and a waterline 3.7% bevelled. The drawn city is 4.2%,
 * but it earns its beaches by hand — Sunridge Shore is a park borough somebody
 * put on the south coast because that is where the sand should be.
 *
 * So say it in the plan instead of hoping for it. Every stretch of shore that
 * (a) faces away from the swell and (b) belongs to a borough that has no
 * business quaying it becomes a parish of its own: park, rural, no streets.
 * Dune, meadow and a long unbroken beach — which is also what makes the
 * bevels work, because a bevel needs a rasterised 45° staircase to cut and a
 * three-tile scrap of sand has no staircase in it.
 *
 * Downtown and industry are exempt, and that is the whole rule stated
 * properly: a city's middle grew round a harbour and its docks need deep
 * water at a wall. Beaches belong in front of the houses.
 */
const PARISH_TAIL = ['Sands', 'Dunes', 'Shore', 'Strand', 'Links'] as const;

/** Offset a chain sideways by a per-point normal, for a ribbon polygon. */
function offsetChain(points: PlanPoint[], normals: PlanPoint[], d: number): PlanPoint[] {
  return points.map((p, i) => {
    const n = normals[i] as PlanPoint;
    return [p[0] + n[0] * d, p[1] + n[1] * d] as PlanPoint;
  });
}

function shoreParishes(
  sites: Site[],
  coastWater: Uint8Array,
  exposure: Float32Array,
  fromSea: Int32Array,
  W: number,
  H: number,
  seed: number,
): PlanDistrict[] {
  const r = new Roll(deriveSeed(seed, 'plangen.parishes'));

  /** Which cell owns a tile — the same weighted Voronoi the polygons come from. */
  const ownerAt = (x: number, y: number): number => {
    let best = -1;
    let bd = Infinity;
    for (const [i, s] of sites.entries()) {
      const d = Math.hypot(x - s.x, y - s.y) / s.weight;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  /** Which way the sea is, from the distance field's own slope. */
  const outwardAt = (x: number, y: number): PlanPoint => {
    const at = (px: number, py: number): number =>
      fromSea[Math.max(0, Math.min(H - 1, py)) * W + Math.max(0, Math.min(W - 1, px))] as number;
    const gx = at(x + 5, y) - at(x - 5, y);
    const gy = at(x, y + 5) - at(x, y - 5);
    const len = Math.hypot(gx, gy) || 1;
    return [-gx / len, -gy / len];
  };

  // Candidate shore, sampled on a lattice: leeward, on a borough that would
  // rather have a beach than a wharf, and enough of a shore to be one.
  const candidates: PlanPoint[] = [];
  const owners: number[] = [];
  for (let y = 4; y < H - 4; y += 3) {
    for (let x = 4; x < W - 4; x += 3) {
      const i = y * W + x;
      if (coastWater[i] === 1 || (fromSea[i] as number) > 3) continue;
      if ((exposure[i] as number) >= -0.2) continue;
      const own = ownerAt(x, y);
      if (own < 0) continue;
      const s = sites[own] as Site;
      if (s.district === 'downtown' || s.district === 'industrial') continue;
      candidates.push([x, y]);
      owners.push(own);
    }
  }

  // Chain them along the shore, greedy nearest-unvisited — the same walk §16
  // used to recover a contour band's centreline. A stretch of coast IS a
  // curve; what a raster of it lacks is the order.
  const used = new Uint8Array(candidates.length);
  const out: PlanDistrict[] = [];
  const named = new Set<string>();
  for (let start = 0; start < candidates.length; start++) {
    if (used[start] === 1) continue;
    const chain: PlanPoint[] = [];
    const chainOwners: number[] = [];
    let at = start;
    for (;;) {
      used[at] = 1;
      chain.push(candidates[at] as PlanPoint);
      chainOwners.push(owners[at] as number);
      const [cx, cy] = candidates[at] as PlanPoint;
      let next = -1;
      let bd = Infinity;
      for (let k = 0; k < candidates.length; k++) {
        if (used[k] === 1) continue;
        const [px, py] = candidates[k] as PlanPoint;
        const d = Math.hypot(px - cx, py - cy);
        // Six tiles: far enough to step over the lattice's diagonal gap,
        // near enough that the walk cannot jump a headland and stitch two
        // unrelated beaches into one ribbon across the bay between them.
        if (d < 6 && d < bd) {
          bd = d;
          next = k;
        }
      }
      if (next < 0) break;
      at = next;
    }
    // A parish is a stretch of coast, not a corner of one.
    if (chain.length < 14) continue;

    // Smooth before offsetting: the inland edge is the chain pushed back
    // fifteen-odd tiles, and an unsmoothed chain's kinks become crossings
    // that the even-odd fill then reads as holes in the beach.
    let smooth = chain;
    for (let pass = 0; pass < 3; pass++) {
      smooth = smooth.map((p, i) => {
        const a = smooth[Math.max(0, i - 1)] as PlanPoint;
        const b = smooth[Math.min(smooth.length - 1, i + 1)] as PlanPoint;
        return [(a[0] + p[0] * 2 + b[0]) / 4, (a[1] + p[1] * 2 + b[1]) / 4] as PlanPoint;
      });
    }
    const normals = smooth.map((p) => outwardAt(Math.round(p[0]), Math.round(p[1])));
    const depth = r.range(13, 20);
    const ribbon = [
      // Seaward edge out past the waterline, so the warp fringe and the
      // beach's own wet foot are inside the parish rather than left to the
      // borough behind it.
      ...offsetChain(smooth, normals, 6),
      ...offsetChain(smooth, normals, -depth).reverse(),
    ];

    let name = `${(sites[chainOwners[0] as number] as Site).name} ${r.pick(PARISH_TAIL)}`;
    while (named.has(name)) name = `${pickName(r)} ${r.pick(PARISH_TAIL)}`;
    named.add(name);
    out.push({
      name,
      borough: name,
      district: 'park',
      area: simplify([...ribbon, ribbon[0] as PlanPoint], 1.5).slice(0, -1),
      // No streets at all, and this is the load-bearing choice. A ribbon of
      // rural lanes fifteen tiles wide would be carved inside the parish and
      // touch no arterial, which is a second street network and exactly what
      // the checker refuses. The borough behind it keeps its streets and its
      // frontage; what is in front of them is the beach.
      street: { pitchX: 0, pitchY: 0, width: 2, alleyOver: 0, angle: 0, fabric: 'grid', spine: '' },
      rural: true,
      density: 0.2,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stage 5 — the landmarks                                             */
/* ------------------------------------------------------------------ */

/**
 * What each kind of landmark needs: how big, how many, what ground it wants
 * to stand on, and whether it belongs in a block or out in the country.
 *
 * The checker insists every kind exists somewhere in the city, which is the
 * right rule — a city with no hospital is a city where dying is permanent —
 * and it is also what makes this table the generator's contract rather than
 * its decoration.
 */
interface LandmarkWant {
  kind: LandmarkKind;
  w: number;
  h: number;
  count: number;
  where: DistrictType[];
  country: boolean;
  coastal?: boolean;
  /**
   * A plaza: streets are meant to run THROUGH it, so it is sited on the
   * street pattern rather than in the gap between streets. See `OPEN_TO_ROAD`
   * in `bake.ts` — a square with no road through it is a courtyard.
   */
  plaza?: boolean;
}

const LANDMARK_WANTS: LandmarkWant[] = [
  { kind: 'tower', w: 8, h: 8, count: 3, where: ['downtown', 'commercial'], country: false },
  { kind: 'hospital', w: 9, h: 7, count: 3, where: ['commercial', 'residential', 'downtown'], country: false },
  { kind: 'police', w: 7, h: 7, count: 4, where: ['commercial', 'residential', 'downtown', 'industrial'], country: false },
  { kind: 'power', w: 13, h: 11, count: 1, where: ['industrial', 'park'], country: false },
  { kind: 'stadium', w: 14, h: 11, count: 1, where: ['residential', 'commercial', 'park'], country: false },
  { kind: 'square', w: 11, h: 10, count: 2, where: ['downtown', 'commercial'], country: false, plaza: true },
  { kind: 'green', w: 12, h: 12, count: 2, where: ['residential', 'commercial'], country: false, plaza: true },
  { kind: 'circus', w: 13, h: 13, count: 1, where: ['commercial', 'downtown', 'residential'], country: false, plaza: true },
  { kind: 'farm', w: 11, h: 8, count: 2, where: ['park'], country: true },
  { kind: 'campground', w: 8, h: 7, count: 1, where: ['park'], country: true },
  { kind: 'quarry', w: 13, h: 10, count: 1, where: ['park'], country: true },
  { kind: 'lighthouse', w: 4, h: 4, count: 1, where: ['park'], country: true, coastal: true },
  { kind: 'airstrip', w: 30, h: 7, count: 1, where: ['park'], country: true },
];

const LANDMARK_NAMES: Record<LandmarkKind, (place: string, n: number) => string> = {
  tower: (p) => `${p} Tower`,
  hospital: (p) => `${p} General`,
  police: (p) => `${p} Precinct`,
  power: (p) => `${p} Power`,
  stadium: (p) => `${p} Stadium`,
  square: (p) => `${p} Square`,
  green: (p) => `${p} Green`,
  circus: (p) => `${p} Circus`,
  farm: (p) => `${p} Farm`,
  campground: (p) => `${p} Camp`,
  quarry: (p) => `${p} Quarry`,
  lighthouse: (p) => `${p} Light`,
  airstrip: (p) => `${p} Airfield`,
};

/**
 * Put the landmarks where there is room for them.
 *
 * The plan is laid out once, unfinished, purely to ask the question the
 * `--fit` flag exists to answer by hand: which blocks came out, and how big
 * are they? Placing a stadium by drawing a rectangle and hoping is what makes
 * `pnpm citybake --fit` necessary; asking the layout is what makes it
 * unnecessary. The country kinds skip the blocks entirely and take open
 * ground at a polite distance from the nearest road, which is where a farm
 * is.
 */
function placeLandmarks(plan: CityPlan, sites: Site[], water: Uint8Array, seed: number): PlanLandmark[] {
  const r = new Roll(deriveSeed(seed, 'plangen.landmarks'));
  const layout = buildLayout(plan);
  const W = layout.widthTiles;
  const H = layout.heightTiles;
  const out: PlanLandmark[] = [];
  const taken: Array<[number, number, number, number]> = [];

  const clear = (x: number, y: number, w: number, h: number): boolean => {
    for (let ty = y - 1; ty <= y + h; ty++) {
      for (let tx = x - 1; tx <= x + w; tx++) {
        if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
        const t = layout.tiles[ty * W + tx] as number;
        if (t === T_ROAD || t === T_BRIDGE || t === T_WATER || t === T_BANK || t === T_SAND) {
          return false;
        }
      }
    }
    for (const [tx, ty, tw, th] of taken) {
      if (x < tx + tw + 6 && tx < x + w + 6 && y < ty + th + 6 && ty < y + h + 6) return false;
    }
    return true;
  };
  /**
   * How far every tile stands from the street network, walked over the
   * ground a track could be cut through — the same question the bake's
   * `driveway` asks, asked once for the whole map instead of once per
   * landmark.
   *
   * A box scan for "is there a road within seventy tiles" is not the same
   * question and gets it wrong in exactly the case that matters: a farm on
   * a headland with a trunk road plainly visible across the water passes
   * the box scan, gets no driveway because there is no path to cut one
   * along, and fails the checker for having no road to it. Reachability is
   * the property, so reachability is what is measured.
   */
  const trackDist = new Int32Array(W * H).fill(-1);
  {
    const bag: number[] = [];
    for (let i = 0; i < trackDist.length; i++) {
      const t = layout.tiles[i] as number;
      if (t === T_ROAD || t === T_BRIDGE) {
        trackDist[i] = 0;
        bag.push(i);
      }
    }
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
        if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
        const j = ny * W + nx;
        if ((trackDist[j] as number) >= 0) continue;
        const t = layout.tiles[j] as number;
        if (t === T_WATER || t === T_BANK) continue;
        trackDist[j] = (trackDist[i] as number) + 1;
        bag.push(j);
      }
    }
  }
  const roadWithin = (x: number, y: number, w: number, h: number, reach: number): boolean => {
    const d = trackDist[(y + (h >> 1)) * W + x + (w >> 1)] as number;
    return d >= 0 && d <= reach;
  };

  const placeName = (x: number, y: number): string => {
    let best = sites[0] as Site;
    let bd = Infinity;
    for (const s of sites) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best.name;
  };

  /**
   * A plaza wants a junction, not a gap.
   *
   * The rect has to be dry, has to hold some carriageway (or it is a
   * courtyard), and — for a circus — has to have its middle clear, because
   * the monument goes there and one tile of it on the ring severs the ring.
   * The bake enforces that last one; this is the generator agreeing with it
   * in advance rather than finding out by throwing.
   */
  const plazaFits = (x: number, y: number, w: number, h: number, circus: boolean): boolean => {
    let road = 0;
    for (let ty = y - 1; ty <= y + h; ty++) {
      for (let tx = x - 1; tx <= x + w; tx++) {
        if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
        const t = layout.tiles[ty * W + tx] as number;
        if (t === T_WATER || t === T_BANK || t === T_SAND) return false;
        if (t === T_ROAD || t === T_BRIDGE) road++;
      }
    }
    if (road < w) return false;
    if (circus) {
      const mx = x + (w >> 1) - 1;
      const my = y + (h >> 1) - 1;
      for (let ty = my; ty < my + 3; ty++) {
        for (let tx = mx; tx < mx + 3; tx++) {
          const t = layout.tiles[ty * W + tx] as number;
          if (t === T_ROAD || t === T_BRIDGE) return false;
        }
      }
    }
    for (const [tx, ty, tw, th] of taken) {
      if (x < tx + tw + 10 && tx < x + w + 10 && y < ty + th + 10 && ty < y + h + 10) return false;
    }
    return true;
  };

  const keep = (kind: LandmarkKind, x: number, y: number, w: number, h: number, n: number): void => {
    taken.push([x, y, w, h]);
    out.push({
      kind,
      name: LANDMARK_NAMES[kind](placeName(x, y), n),
      rect: [x, y, w, h],
      byAir: false,
    });
  };

  for (const want of LANDMARK_WANTS) {
    let placed = 0;
    // Turn it, then shrink it, rather than fail to place it.
    //
    // The sizes above are what each kind WANTS, and a generated city is
    // under no obligation to have ground that shape. Two moves, in the order
    // that costs the least: a runway laid north–south is the same runway,
    // and a stadium two tiles narrower is still a stadium. A city with
    // NEITHER is refused by the checker, which is the right refusal and the
    // wrong outcome. The scan also tightens as the attempts go on — a coarse
    // lattice is cheap and spreads results out, and a fine one is what finds
    // the last field on a crowded island.
    const tries: Array<{ w: number; h: number; step: number }> = [];
    for (let shrink = 0; shrink < 4; shrink++) {
      const w = Math.max(want.kind === 'airstrip' ? 16 : 5, want.w - shrink * 2);
      const h = Math.max(4, want.h - shrink * 2);
      const step = shrink === 0 ? 7 : shrink === 1 ? 5 : 3;
      tries.push({ w, h, step });
      if (w !== h) tries.push({ w: h, h: w, step });
    }
    for (const attempt of tries) {
      if (placed >= want.count) break;
      const { w, h, step } = attempt;

      if (want.plaza === true) {
        for (let ty = 12; ty < H - 12 - h && placed < want.count; ty += 5) {
          for (let tx = 12; tx < W - 12 - w && placed < want.count; tx += 5) {
            const type = DISTRICT_TYPES[layout.district[(ty + (h >> 1)) * W + tx + (w >> 1)] as number];
            if (type === undefined || !want.where.includes(type as DistrictType)) continue;
            if ((layout.owner[ty * W + tx] as number) <= 0) continue;
            if (!plazaFits(tx, ty, w, h, want.kind === 'circus')) continue;
            keep(want.kind, tx, ty, w, h, placed++);
          }
        }
        continue;
      }

      if (!want.country) {
        // Blocks, biggest first: a stadium wants the one block on the map
        // that can hold it, and taking blocks in size order stops a police
        // station from having used it.
        const blocks = layout.blocks
          .filter((b) => b.w >= w + 2 && b.h >= h + 2)
          .sort((a, b) => b.w * b.h - a.w * a.h);
        for (const b of blocks) {
          if (placed >= want.count) break;
          const x = b.x + Math.floor((b.w - w) / 2);
          const y = b.y + Math.floor((b.h - h) / 2);
          const type = DISTRICT_TYPES[layout.district[(y + (h >> 1)) * W + x + (w >> 1)] as number];
          if (type === undefined || !want.where.includes(type as DistrictType)) continue;
          if (!clear(x, y, w, h)) continue;
          // A block in a park borough can be a hundred tiles of grass with
          // no street anywhere near it. The block fit says it goes there;
          // this says you can drive to it.
          if (!roadWithin(x, y, w, h, 40)) continue;
          keep(want.kind, x, y, w, h, placed++);
        }
      }

      // Open country. Anything the blocks could not hold falls through to
      // here too — a city with no room for a stadium in a block can still
      // find a field on the edge of town.
      for (let ty = 12; ty < H - 12 - h && placed < want.count; ty += step) {
        for (let tx = 12; tx < W - 12 - w && placed < want.count; tx += step) {
          const i = ty * W + tx;
          if (water[i] === 1) continue;
          const own = layout.owner[i] as number;
          const type = DISTRICT_TYPES[layout.district[i] as number];
          if (own < 0 || type === undefined) continue;
          if (want.country && !((plan.districts[own] as PlanDistrict).rural || type === 'park')) continue;
          if (!want.country && !want.where.includes(type as DistrictType) && type !== 'park') continue;
          if (want.coastal === true) {
            let sea = false;
            for (let k = 4; k <= 12 && !sea; k++) {
              sea =
                water[Math.min(H - 1, ty + k) * W + tx] === 1 ||
                water[Math.max(0, ty - k) * W + tx] === 1 ||
                water[ty * W + Math.min(W - 1, tx + k)] === 1 ||
                water[ty * W + Math.max(0, tx - k)] === 1;
            }
            if (!sea) continue;
          }
          if (!clear(tx, ty, w, h)) continue;
          // Near enough that the driveway the bake cuts is a track and not a
          // scar across the county.
          if (!roadWithin(tx, ty, w, h, 50)) continue;
          keep(want.kind, tx, ty, w, h, placed++);
        }
      }
    }
    if (placed === 0) {
      throw new Error(
        `plangen: nowhere on this map to put a ${want.kind} (${want.w}x${want.h}) — ` +
          `the checker will refuse a city without one`,
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The generator                                                       */
/* ------------------------------------------------------------------ */

export function generateCityPlan(opts: PlanGenOptions): CityPlan {
  const full: Required<PlanGenOptions> = {
    seed: opts.seed,
    widthTiles: opts.widthTiles ?? 640,
    heightTiles: opts.heightTiles ?? 640,
  };
  const W = full.widthTiles;
  const H = full.heightTiles;
  // Stated rather than discovered. Below this the coast warp, the margin and
  // one borough's worth of streets between them leave no countryside, and
  // what the generator throws instead is a puzzled message about having
  // nowhere to put a runway.
  if (W < MIN_MAP_TILES || H < MIN_MAP_TILES) {
    throw new Error(
      `plangen: ${W}x${H} is too small for a city — ${MIN_MAP_TILES} tiles a side is the floor`,
    );
  }
  const nameRoll = new Roll(deriveSeed(full.seed, 'plangen.name'));
  const cityName = `${pickName(nameRoll)} City`;

  const geo = drawLand(full, cityName);
  const plan = geo.plan;
  const water = geo.water;
  const fromSea = seaDistance(water, W, H);

  const sites = seedBoroughs(geo, full.seed, water, W, H);
  if (sites.length < 4) {
    throw new Error(`plangen: seed ${full.seed} drew a map with room for ${sites.length} boroughs`);
  }
  const { roads, net } = buildRoads(sites, water, fromSea, W, H, plan.maxBridgeSpan, full.seed);
  plan.roads = roads;

  // Whichever component of the network holds the most boroughs is the city;
  // a borough outside it has no way in by road and therefore gets no streets.
  // Making it countryside rather than deleting it is the honest repair: the
  // ground is still there, you can still get to it by boat, and what it has
  // stopped being is a lattice of streets nobody can drive to.
  const tally = new Map<number, number>();
  for (const c of net) tally.set(c, (tally.get(c) ?? 0) + 1);
  let mainNet = net[0] as number;
  for (const [c, n] of tally) if (n > (tally.get(mainNet) ?? 0)) mainNet = c;

  const fabricRoll = new Roll(deriveSeed(full.seed, 'plangen.fabric'));
  const districts: PlanDistrict[] = [
    // The floor under everything (§14.3 D1's problem, taken from the other
    // end): one countryside polygon over the whole map, drawn FIRST so every
    // later cell wins its own ground. What it catches is the fringe the warp
    // raised outside every cell — the spits, the raised bars, the far side of
    // a headland — and gives it meadow rather than an accident.
    {
      name: 'The Approaches',
      borough: 'The Approaches',
      district: 'park',
      area: [
        [-20, -20],
        [W + 20, -20],
        [W + 20, H + 20],
        [-20, H + 20],
      ],
      street: { pitchX: 0, pitchY: 0, width: 2, alleyOver: 0, angle: 0, fabric: 'grid', spine: '' },
      rural: true,
      density: 0.2,
    },
  ];

  const cells: PlanDistrict[] = [];
  for (const [i, s] of sites.entries()) {
    const stranded = (net[i] as number) !== mainNet;
    const type: DistrictType = stranded ? 'park' : s.district;
    const rural = stranded ? true : s.rural;
    const coastal = s.fromSea < 45;
    const street = stranded
      ? { pitchX: 0, pitchY: 0, width: 2, alleyOver: 0, angle: 0, fabric: 'grid' as const, spine: '' }
      : fabricFor(type, rural, coastal, fabricRoll);
    cells.push({
      name: s.name,
      borough: s.name,
      district: type,
      area: cellPolygon(sites, i, W, H),
      street,
      rural,
      density:
        type === 'downtown'
          ? fabricRoll.range(0.88, 0.95)
          : type === 'commercial'
            ? fabricRoll.range(0.78, 0.88)
            : type === 'residential'
              ? fabricRoll.range(0.5, 0.72)
              : type === 'industrial'
                ? fabricRoll.range(0.5, 0.62)
                : 0.2,
    });
  }

  // A borough that grew along its high street says so: the spine fabric wants
  // a named road, and the one it wants is the arterial that actually runs
  // through it. Assigned here rather than in `fabricFor` because it is the
  // only fabric that cannot be chosen without knowing the roads — and over
  // the CELLS alone, which is why they are still a list of their own: a
  // parish has no site and no streets to give a spine to.
  const spineRoll = new Roll(deriveSeed(full.seed, 'plangen.spine'));
  for (const [i, d] of cells.entries()) {
    if (d.rural || d.street.pitchX === 0) continue;
    if (d.district !== 'commercial' && d.district !== 'residential') continue;
    if (spineRoll.f() > 0.4) continue;
    const s = sites[i] as Site;
    let best: PlanRoad | null = null;
    let bd = Infinity;
    for (const road of plan.roads) {
      for (const p of road.points) {
        const dd = Math.hypot(p[0] - s.x, p[1] - s.y);
        if (dd < bd) {
          bd = dd;
          best = road;
        }
      }
    }
    if (best !== null && bd < 60) {
      d.street.fabric = 'spine';
      d.street.spine = best.name;
    }
  }

  // The beaches, last, so they win the ground they cover: a parish is drawn
  // over the seaward lip of whichever borough it fronts, and the point is
  // that the borough stops owning it.
  const parishes = shoreParishes(sites, water, geo.exposure, fromSea, W, H, full.seed);
  plan.districts = [...districts, ...cells, ...parishes];

  // Shops, quota'd off the built area rather than fixed: a small map with the
  // big map's quota puts a gun shop on every corner, and the spacing rule
  // then quietly drops most of them anyway.
  const builtCells = cells.filter((d) => !d.rural && d.street.pitchX > 0).length;
  plan.shopQuota = {
    gun: Math.max(3, builtCells * 2),
    clothing: Math.max(3, builtCells * 2),
    spray: Math.max(4, Math.round(builtCells * 2.5)),
  };
  plan.shopSpacingTiles = 30;

  plan.landmarks = placeLandmarks(plan, sites, water, full.seed);
  return plan;
}
