import {
  type Building,
  type CityMap,
  type Vec2,
  DISTRICT_TYPES,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SIDEWALK,
  T_WATER,
  T_BRIDGE,
  T_BANK,
  T_TREES,
  T_SAND,
  T_RUNWAY,
  T_RAMP,
  T_FLOOR,
  TILE_SIZE,
  RIGHT_SIGN,
  type DiagonalDir,
  diagonalMark,
  laneCentreInTile,
  BEV_NE,
  BEV_NONE,
  BEV_SE,
  BEV_SW,
  bevelOther,
  inCutHalf,
  chainSide,
  shoreHalf,
  shoreChains,
  courseJunctions,
  buildingCorners,
  buildingMass,
} from 'shared';
import palette from 'shared/data/palette.json';
import {
  CHUNK_BUILDS_PER_FRAME,
  CHUNK_CACHE_LIMIT,
  ROOF_CACHE_LIMIT,
  CHUNK_TILES,
  RENDER_SCALE,
  SHADOW_DEPTH,
  SUN_X,
  SUN_Y,
  WALL_DEPTH,
} from './config.js';
import { hash2 } from './noise.js';
import type { SpriteSheet } from './sprites.js';
import { viewport } from './viewport.js';
import { ExtrudeLayer } from './extrude.js';

/** The proving ground's colour: deliberately unlike any shop's. */
const DEPOT_ACCENT = '#5aa84e';

/** The four tile neighbours, north first. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/** What `groundChunk` hands the 3D ground layer. */
export interface GroundChunk {
  /** The painting: one device pixel per texture pixel, fully opaque. */
  canvas: HTMLCanvasElement;
  /** Whether any tile is water, so the layer knows to alpha-test the cutout. */
  holes: boolean;
  /** One texel per tile, red channel = `SHEEN`. */
  surface: HTMLCanvasElement;
  /**
   * Eight texels per tile edge, green channel 255 for ground and 0 for water —
   * the cutout, as its own nearest-filtered mask rather than the painting's
   * alpha. Sub-tile because the shoreline is no longer tile-square: a
   * bevelled coast tile is half land, and the hole has to follow the
   * hypotenuse or the 3D water gets a square lid over every diagonal.
   *
   * A canvas cannot hold colour at zero alpha (the backing store is
   * premultiplied), so cutting on the painting's own alpha channel meant every
   * shoreline texel filtered towards transparent BLACK: a dark fringe on the
   * waterline, eroded differently at every mip level. The painting is opaque
   * water colour there instead, and this mask is what the alpha test reads.
   */
  cut: HTMLCanvasElement;
}

/**
 * How much of a sheen each terrain takes when it is wet, 0 to 1.
 *
 * Rain does not land on a city evenly — it lands evenly and then the city
 * decides what to do with it. Tarmac and concrete are sealed, so the water
 * stays on top as a film and the surface turns into a mirror. A lawn drinks
 * it; sand drinks it faster; a wood floor under a canopy barely gets any. The
 * gloss is the whole effect, so this table is the whole difference between a
 * rained-on city and a rained-on flat plane.
 *
 * Anything absent is 0 — water, and the inside of a building, neither of
 * which has a wet state worth drawing.
 */
const SHEEN: Record<number, number> = {
  [T_ROAD]: 1,
  [T_BRIDGE]: 1,
  [T_RUNWAY]: 1,
  [T_LOT]: 0.9,
  [T_SIDEWALK]: 0.85,
  [T_RAMP]: 0.85,
  [T_BANK]: 0.55,
  // Under a roof for most of its area, and boards rather than concrete.
  [T_FLOOR]: 0.4,
  [T_SAND]: 0.14,
  [T_FIELD]: 0.12,
  [T_PARK]: 0.12,
  // A canopy. Almost none of the rain reaches the ground and none of it sits.
  [T_TREES]: 0.05,
};

/**
 * How much of a sheen a terrain takes when it is wet — see `SHEEN`.
 *
 * Exported so the table can be held to its own contract without a canvas: it
 * is one number per terrain and every one of them is an art decision that a
 * new tile type will silently default out of.
 */
export function sheenOf(tile: number): number {
  return SHEEN[tile] ?? 0;
}

const CHUNK_WORLD = CHUNK_TILES * TILE_SIZE;
const CHUNK_DEVICE = CHUNK_WORLD * RENDER_SCALE;
/** Device pixels per tile. */
const TD = TILE_SIZE * RENDER_SCALE;

/**
 * A road is a road, not a junction, once its cross-run is this long.
 *
 * Exported for the 3D renderer, which must call the same tiles junctions,
 * plazas and diagonals that this painter does — the two disagreeing is how
 * the ring road came to be striped with phantom crossings in one view and
 * bare in the other.
 */
export const RUN_ROAD = 8;

/**
 * Is (tx, ty) on the runway centreline — the ONE marked row of its column?
 *
 * The old rule was "runway above and below", which is true of every interior
 * row: a seven-tile strip carried five parallel dashed lines and both
 * airstrips read as dash carpets from the air (REVIEW-WORLDGEN.md §2.1,
 * `evidence/topdown-runway-grid.png`). This walks to the strip's edges and
 * marks only the row equidistant from them — on an even strip, the
 * northerly of the middle pair. Strips under three tiles tall get no line,
 * as before. Exported so the 3D renderer imports the rule rather than
 * approximating it, which is how `RUN_ROAD` above earned its keep
 * (BUGS.md §7.1); the every-other-column dash cadence stays at the call
 * sites — it is presentation, this is the rule.
 */
export function runwayCentreRow(
  tileAt: (tx: number, ty: number) => number,
  tx: number,
  ty: number,
): boolean {
  if (tileAt(tx, ty) !== T_RUNWAY) return false;
  let y0 = ty;
  while (tileAt(tx, y0 - 1) === T_RUNWAY) y0--;
  let y1 = ty;
  while (tileAt(tx, y1 + 1) === T_RUNWAY) y1++;
  if (y1 - y0 < 2) return false;
  return ty === y0 + ((y1 - y0) >> 1);
}

/**
 * Ground the course ribbons may paint on: the carriageway itself, its deck
 * over water, and the kerb band the casing is meant to reach — plus a shop's
 * threshold, which sits flush against the street it opens onto, and the quay,
 * which the esplanade's course runs along (§33). Everything else — lots,
 * sand, grass, park, woodland, runway, ramps, water, walls — is ground a
 * street's paint has no business on, however close the centreline passes.
 */
export function courseGround(t: number): boolean {
  return (
    t === T_ROAD || t === T_BRIDGE || t === T_SIDEWALK || t === T_BANK || t === T_FLOOR
  );
}

/** Carriageway width at which a street counts as a main road. */
/**
 * Carriageway width, in tiles, at which a street is a main road.
 *
 * Exported because the 3D renderer needs the same threshold: it was marking
 * every arm of every junction, which is the default this constant exists to
 * replace.
 */
export const ARTERIAL_WIDTH = 4;

/**
 * The centre-line rule lives in `shared/world/marks.ts` now, so the 3D
 * builder reads the SAME arithmetic instead of carrying its own (whose
 * even-width answer was half a lane off on every arterial). Re-exported here
 * because this painter is where the rule grew up and the tests know it by
 * this address.
 */
export { laneCentreInTile };

/**
 * Where the centre dash starts inside its tile, in device pixels — rounded to
 * a whole pixel and CLAMPED to keep the whole dash inside the tile.
 *
 * The clamp is for even carriageway widths, where `laneCentreInTile` answers
 * exactly 1.0: the centre is the tile boundary, and a dash drawn astride it
 * lost its outer half to the neighbouring tile's base fill, painted a moment
 * later — so every arterial's centre line came out half as thick as a side
 * street's, half a pixel off centre and half a pixel fainter. A whole dash
 * half a device pixel inside the true centre is invisible; half a dash is not.
 *
 * Pure, like `laneCentreInTile` above it, and for the same reason.
 */
export function laneDashOffset(centreInTile: number, tilePx: number, thickness: number): number {
  return Math.min(tilePx - thickness, Math.round(centreInTile * tilePx - thickness / 2));
}

interface Chunk {
  canvas: HTMLCanvasElement;
  /** Frame counter of last use, for eviction. */
  touched: number;
}

/** The eight neighbours, nearest first — for "what is this tile beside". */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Ground a building's plot can plausibly be surfaced with (§22.4).
 *
 * The plot fill and the turned forecourt both answer "what is this house
 * standing on?" by looking at the nearest tile that is not the house itself.
 * That question has wrong answers as well as right ones: a wall, the sea and
 * a bridge deck were always excluded, and so must the carriageway, a stunt
 * ramp's chevrons, a runway and the open floor of a shop be — none of them is
 * a surface a plot is ever made of, and a ramp picked as a plot's material
 * paints a rotated ring of hazard stripes round the house.
 */
/**
 * May this building be drawn as ONE mass rather than per tile?
 *
 * The rule has always been "its footprint is solid wall", because a shop is a
 * room punched out of one and a lid over the whole rect would close it. For a
 * building CUT at an angle (§36) the footprint record is a BOUNDING BOX, and
 * its corners are yard by construction — so the old test failed every one of
 * them and the renderers fell back to per-tile boxes, drawing a stepped
 * outline round a rectangle. What matters is the same thing either way: is
 * there a room punched out of it.
 */
function massDrawable(b: Building, at: (tx: number, ty: number) => number): boolean {
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      const t = at(tx, ty);
      if (t === T_FLOOR) return false;
      if (b.mw === undefined && t !== T_BUILDING) return false;
    }
  }
  return true;
}

function plottable(t: number): boolean {
  return (
    t !== T_BUILDING &&
    t !== T_WATER &&
    t !== T_BRIDGE &&
    t !== T_ROAD &&
    t !== T_RAMP &&
    t !== T_RUNWAY &&
    t !== T_FLOOR
  );
}

function shade(hex: string, amount: number, towards = '#0b111c'): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(towards.slice(1), 16);
  const mixc = (sa: number, sb: number): number => Math.round(sa + (sb - sa) * amount);
  const r = mixc((a >> 16) & 255, (b >> 16) & 255);
  const g = mixc((a >> 8) & 255, (b >> 8) & 255);
  const bl = mixc(a & 255, b & 255);
  return `rgb(${r},${g},${bl})`;
}

/**
 * The static city, rendered once per chunk into an offscreen canvas and blitted
 * thereafter.
 *
 * The old renderer repainted ~500 flat `fillRect`s every frame, which capped
 * both the frame rate and the amount of detail the ground could ever carry.
 * Caching inverts that: a chunk is painted once and reused for as long as it
 * stays on screen, so lane markings, kerbs, paving, roof clutter, extruded
 * building walls and cast shadows are all effectively free at runtime.
 */
export class TileLayer {
  /**
   * When true, walls and roofs are left out of the cached chunk because
   * `ExtrudeLayer` draws them per frame with real parallax (SHIP.md U2).
   * Ground, shadows and shop fronts stay baked either way.
   */
  extruded = false;
  /** Buildings the extrude pass drew last frame, surfaced for the overlay. */
  lastBuildingsDrawn = 0;

  private readonly extrude = new ExtrudeLayer((i) => this.roofCanvasFor(i));
  private readonly roofCache = new Map<number, HTMLCanvasElement>();
  private map: CityMap | null = null;
  private chunks = new Map<number, Chunk>();
  private frameCounter = 0;
  /** Building index per tile (1-based; 0 = not a building). */
  private buildingOf: Int32Array = new Int32Array(0);
  /** Shop index per tile of its building footprint (1-based; 0 = none). */
  private shopOf: Int32Array = new Int32Array(0);
  /** Contiguous road-run length and index within it, per axis. */
  private runH: Uint8Array = new Uint8Array(0);
  private runV: Uint8Array = new Uint8Array(0);
  private idxH: Uint8Array = new Uint8Array(0);
  private idxV: Uint8Array = new Uint8Array(0);
  /**
   * The authored road courses in world px, ready to stroke (§16): the curve
   * each tile band rasterises, drawn as one line. `cover` marks the tiles a
   * course runs over, so the per-tile painter keeps its marks off them —
   * ribbon paint and stair-step paint on the same tarmac is two centre
   * lines disagreeing about where the road is.
   */
  private ribbons: Array<{
    pts: Float64Array;
    widthPx: number;
    kind: string;
    /** The whole course's length in world px — the seniority of a road. */
    len: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }> = [];
  private courseCover: Uint8Array | null = null;
  /**
   * Tiles a `path` course runs over (3.2), kept apart from `courseCover`
   * because the two masks answer different questions: a road tile under a
   * ribbon keeps its asphalt and loses its MARKS, while a pavement tile
   * under a walk goes back to being lawn — the smooth stroke is the walk,
   * and the staircase it rasterised to must not show beside it.
   */
  private pathCover: Uint8Array | null = null;
  /**
   * Tiles within a road ribbon's PAINTED reach — the stroke plus its kerb
   * casing — a shade wider than `courseCover`. The clip consults it for the
   * soft-ground exception: where a diagonal road runs through open country
   * there is no kerb band to hide the rasterised staircase, and holding the
   * ribbon strictly to the band's tiles saw-toothed every rural carriageway
   * edge. Soft natural ground under the ribbon's own footprint may take the
   * paint; everything the clip exists to protect — water, walls, lots — is
   * still refused, so §2.2's sea-painted-as-tarmac stays fixed.
   */
  private courseApron: Uint8Array | null = null;
  /**
   * Where the courses cross, from the CURVES (§26). The centre dash is
   * punched out of these: a junction is bare asphalt, which is the rule the
   * per-tile painter has always followed and the ribbon painter never did.
   */
  private junctionDiscs: Array<{ x: number; y: number; r: number }> = [];
  /**
   * The coast running through each tile it crosses (§18), in tile-LOCAL
   * units as a flat polyline — the cut `paintShoreTile` divides that tile
   * with, sharing its ends with the neighbouring tiles' cuts.
   *
   * A map rather than a plane because a coast is a line through a plane: the
   * shipped city has three thousand segments touching maybe eight thousand
   * tiles out of half a million, and a Map of the ones that matter is smaller
   * than a Float32Array of the ones that do not.
   */
  private shoreSegs: Map<number, Float32Array> | null = null;
  /**
   * The shore band's INNER edge through each tile it crosses (§39), indexed
   * exactly as `shoreSegs` is and cut with the same two functions.
   *
   * The waterline was made a curve first, and that made the line a tile and a
   * half behind it — sand against grass, 100% axis-aligned against a
   * waterline at 19.7% — the most obviously stepped thing on the map. It is
   * the same kind of line and it gets the same treatment.
   */
  private bandSegs: Map<number, Float32Array> | null = null;

  /** Tile indices that host a parked vehicle — see `indexParking`. */
  private readonly parkingTiles = new Set<number>();

  constructor(private readonly sprites: SpriteSheet) {}

  setMap(map: CityMap): void {
    this.map = map;
    this.extrude.setMap(map);
    this.roofCache.clear();
    this.chunks.clear();
    this.indexBuildings(map);
    this.indexShops(map);
    this.indexRoadRuns(map);
    this.indexCourses(map);
    this.indexShores(map);
    this.indexParking(map);
  }

  /**
   * Lot tiles that actually host a parked vehicle, plus a tile around each,
   * so `paintLot` can mark bays where cars stand instead of striping every
   * third column of every lot in the city — quarries, factory yards and the
   * airfield apron were all coming out as car parks from the air
   * (REVIEW-WORLDGEN.md §2.6's dash columns, run to ground: they were never
   * course paint, they were this).
   */
  private indexParking(map: CityMap): void {
    this.parkingTiles.clear();
    const W = map.widthTiles;
    for (const s of [...map.parkingSpots, ...map.vehicleHomes]) {
      const tx = Math.floor(s.x / TILE_SIZE);
      const ty = Math.floor(s.y / TILE_SIZE);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          this.parkingTiles.add((ty + oy) * W + tx + ox);
        }
      }
    }
  }

  /** The coast and the band's inner edge, per tile (`shoreChains`, §18/§39). */
  private indexShores(map: CityMap): void {
    const loops = map.shores ?? [];
    this.shoreSegs = loops.length === 0 ? null : shoreChains(loops, map.widthTiles, map.heightTiles);
    const banks = map.banks ?? [];
    this.bandSegs = banks.length === 0 ? null : shoreChains(banks, map.widthTiles, map.heightTiles);
  }

  /** World-px ribbons and the tile cover mask, from the baked courses. */
  private indexCourses(map: CityMap): void {
    this.ribbons = [];
    this.courseCover = null;
    this.pathCover = null;
    this.courseApron = null;
    this.junctionDiscs = [];
    const courses = map.courses ?? [];
    if (courses.length === 0) return;
    // Crossings from the ROAD curves only (3.2): a walk crossing a walk is
    // not a junction, and a footpath must never punch the centre dash out
    // of an avenue it happens to end against.
    this.junctionDiscs = courseJunctions(courses.filter((c) => c.kind !== 'path'));
    const cover = new Uint8Array(map.widthTiles * map.heightTiles);
    const pathCover = new Uint8Array(map.widthTiles * map.heightTiles);
    const apron = new Uint8Array(map.widthTiles * map.heightTiles);
    for (const c of courses) {
      const pts = new Float64Array(c.points.length * 2);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      c.points.forEach(([px, py], i) => {
        const wx = px * TILE_SIZE;
        const wy = py * TILE_SIZE;
        pts[i * 2] = wx;
        pts[i * 2 + 1] = wy;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
      });
      let len = 0;
      for (let k = 2; k < pts.length; k += 2) {
        len += Math.hypot(
          (pts[k] as number) - (pts[k - 2] as number),
          (pts[k + 1] as number) - (pts[k - 1] as number),
        );
      }
      const pad = (c.width / 2) * TILE_SIZE + TILE_SIZE;
      this.ribbons.push({
        pts,
        widthPx: c.width * TILE_SIZE,
        kind: c.kind,
        len,
        minX: minX - pad,
        minY: minY - pad,
        maxX: maxX + pad,
        maxY: maxY + pad,
      });
      // The cover mask, swept exactly as the carve swept its disc. A walk's
      // sweep runs a shade wider than its stroke (3.2): the park carve
      // rounds outward from offset samples, and a carved pavement tile the
      // mask missed would keep its slab paint and stick out of the lawn
      // beside the smooth ribbon. Over-covering is harmless there — the
      // mask only ever speaks about pavement tiles. A road sweeps twice in
      // one pass: the tight radius into `cover` (marks suppression) and the
      // painted reach — stroke plus casing plus the quantisation slop — into
      // `apron`, for the clip's soft-ground exception.
      const path = c.kind === 'path';
      const half = c.width / 2 + (path ? 0.45 : 0.55);
      const inner = c.width / 2 + 0.05;
      for (let k = 0; k + 1 < c.points.length; k++) {
        const [ax, ay] = c.points[k] as readonly [number, number];
        const [bx, by] = c.points[k + 1] as readonly [number, number];
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
        const x1 = Math.min(map.widthTiles - 1, Math.ceil(Math.max(ax, bx) + half + 1));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
        const y1 = Math.min(map.heightTiles - 1, Math.ceil(Math.max(ay, by) + half + 1));
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const px = tx + 0.5 - ax;
            const py = ty + 0.5 - ay;
            const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
            const qx = px - t * dx;
            const qy = py - t * dy;
            const d2 = qx * qx + qy * qy;
            if (d2 > half * half) continue;
            const i = ty * map.widthTiles + tx;
            if (path) {
              pathCover[i] = 1;
            } else {
              apron[i] = 1;
              if (d2 <= inner * inner) cover[i] = 1;
            }
          }
        }
      }
    }
    this.courseCover = cover;
    this.pathCover = pathCover;
    this.courseApron = apron;
  }

  /** Soft natural ground inside a road ribbon's painted reach — see `courseApron`. */
  private softUnderApron(tx: number, ty: number): boolean {
    const map = this.map;
    if (map === null || this.courseApron === null) return false;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
    if (this.courseApron[ty * map.widthTiles + tx] !== 1) return false;
    const t = map.tiles[ty * map.widthTiles + tx] as number;
    return t === T_FIELD || t === T_PARK || t === T_SAND;
  }

  /**
   * Stroke the road courses through one chunk: the curve, drawn as a curve.
   *
   * Map-renderer order, all courses per pass: every casing first, then
   * every carriageway fill — so where two courses meet, the second fill
   * paints over the first one's casing and the junction opens itself — then
   * edge lines and the centre dash on top. The centre line is the course's
   * own polyline, midpoint-smoothed, which is the "one line" the §16 review
   * asked for: no stair steps, no per-tile quantisation, dashes flowing
   * unbroken through every curve.
   */
  private paintCourses(ctx: CanvasRenderingContext2D, tx0: number, ty0: number): void {
    if (this.ribbons.length === 0) return;
    const wx0 = tx0 * TILE_SIZE;
    const wy0 = ty0 * TILE_SIZE;
    const wx1 = wx0 + CHUNK_TILES * TILE_SIZE;
    const wy1 = wy0 + CHUNK_TILES * TILE_SIZE;
    const near = this.ribbons.filter((r) => r.maxX > wx0 && r.minX < wx1 && r.maxY > wy0 && r.minY < wy1);
    if (near.length === 0) return;

    const t = RENDER_SCALE;
    const build = (r: (typeof near)[number]): { path: Path2D; w: number; len: number } => {
      const path = new Path2D();
      const px = (i: number): number => ((r.pts[i * 2] as number) - wx0) * t;
      const py = (i: number): number => ((r.pts[i * 2 + 1] as number) - wy0) * t;
      const n = r.pts.length / 2;
      path.moveTo(px(0), py(0));
      if (n === 2) {
        path.lineTo(px(1), py(1));
      } else {
        for (let i = 1; i < n - 1; i++) {
          path.quadraticCurveTo(px(i), py(i), (px(i) + px(i + 1)) / 2, (py(i) + py(i + 1)) / 2);
        }
        path.lineTo(px(n - 1), py(n - 1));
      }
      return { path, w: r.widthPx * t, len: r.len };
    };
    const walks = near.filter((r) => r.kind === 'path').map(build);
    const paths = near.filter((r) => r.kind !== 'path').map(build);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';

    // The park walks first, under everything a street paints (3.2): one
    // smooth ribbon of pavement each, no casing hierarchy, no markings, no
    // junction rules. Clipped to the ground a walk may cross — pavement and
    // the lawn it was carved through — so the curve can round a corner the
    // staircase stepped without ever touching a lot, a road or the water.
    if (walks.length > 0) {
      ctx.save();
      ctx.beginPath();
      for (let ty = ty0 - 1; ty <= ty0 + CHUNK_TILES; ty++) {
        for (let tx = tx0 - 1; tx <= tx0 + CHUNK_TILES; tx++) {
          const g = this.tileAt(tx, ty);
          if (g !== T_PARK && g !== T_SIDEWALK) continue;
          ctx.rect((tx - tx0) * TD, (ty - ty0) * TD, TD, TD);
        }
      }
      ctx.clip();
      // The PATH palette, not the pavement's (the plan's own words): in
      // sidewalk grey a two-tile walk through a wood read as a pale road.
      // Packed stone like the quays — warm against the lawn, nothing like
      // carriageway — with a darker rim for the recessed edge.
      ctx.strokeStyle = shade(palette.path, 0.35);
      for (const p of walks) {
        ctx.lineWidth = p.w + 2 * t;
        ctx.stroke(p.path);
      }
      ctx.strokeStyle = palette.path;
      for (const p of walks) {
        ctx.lineWidth = p.w;
        ctx.stroke(p.path);
      }
      ctx.restore();
    }
    if (paths.length === 0) {
      ctx.restore();
      return;
    }

    // A course is a curve and the ground under it is not: where a road bends
    // near the water, the stroked ribbon overhangs the tiles the carve
    // actually took, and 385 tiles of sea and building wall were being
    // painted as tarmac and kerb — worst beside the bridges, where the deck
    // is narrow and the curve is not. Clip the whole pass to ground that
    // CARRIES a road (`courseGround`). The first cut of this clip excluded
    // only water and walls, and lots, beaches and grass all passed it — so
    // wherever the bake reverted a course's carriageway to ground (the quay
    // scraps, the stranded-carriageway repair) the full ribbon still went
    // down: dashed centre lines marching across the Kessler Power lot and
    // stray edge-line fragments on the sand at the strait bridgeheads
    // (REVIEW-WORLDGEN.md §2.2). The casing is MEANT to reach past the
    // carriageway onto the kerb band, so pavement stays in. Wave 2.1 trims
    // the courses themselves; this clip stays as defence in depth.
    //
    // One refinement (after 3.2's retakes): SOFT natural ground under the
    // ribbon's own footprint is let in too. In the city a road wears a kerb
    // band that absorbs the half-tile the stroke overhangs its staircase;
    // through open country there is no band, the clip cut the ribbon to the
    // raw diagonal staircase, and every rural carriageway edge came out
    // saw-toothed. Grass, field and sand within the apron take the paint —
    // ground a car could roll over anyway — while water, walls, lots and
    // woodland stay refused, so the 385 tiles of sea-painted-as-tarmac this
    // clip was built against stay impossible.
    ctx.beginPath();
    for (let ty = ty0 - 1; ty <= ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0 - 1; tx <= tx0 + CHUNK_TILES; tx++) {
        if (!courseGround(this.tileAt(tx, ty)) && !this.softUnderApron(tx, ty)) continue;
        ctx.rect((tx - tx0) * TD, (ty - ty0) * TD, TD, TD);
      }
    }
    ctx.clip();

    // Kerb casing, proud of the carriageway by the kerb band's width.
    ctx.strokeStyle = palette.kerb;
    for (const p of paths) {
      ctx.lineWidth = p.w + 4 * t;
      ctx.stroke(p.path);
    }
    // The carriageway itself.
    ctx.strokeStyle = palette.road;
    for (const p of paths) {
      ctx.lineWidth = p.w;
      ctx.stroke(p.path);
    }
    // Edge lines, held one world px off the kerb, as the straight streets
    // hold theirs: a pale ring left by two strokes, then the interior
    // repainted over it.
    for (const p of paths) {
      ctx.strokeStyle = palette.roadLane;
      ctx.lineWidth = p.w - 2 * t;
      ctx.stroke(p.path);
    }

    // Then the interior repaint and the centre dash, WIDEST LAST (§21).
    //
    // Drawn in one pass for every course, a street's lane lines and centre
    // dash survive on top of an avenue that swallows it — the repaint only
    // covers a course's own interior, and the dash is drawn last by design.
    // Where a lattice line runs alongside an avenue that is two sets of
    // markings on one sheet of tarmac, which is what "the streets are
    // layered on top of each other" looks like. Going up the widths, each
    // tier's repaint covers every thinner course's markings it crosses
    // before its own dash goes on: the avenue's line carries on, the
    // street's stops where the avenue takes over.
    //
    // The casing and the fill above stay in ONE pass each, because their
    // order is what opens a junction (§16) — grouping those by width would
    // draw an avenue's kerb across every street that meets it.
    // Widest last, and within one width, LONGEST last. The width tiers alone
    // left the commonest case untouched: two streets of the same width
    // running alongside each other land in the same tier, so both repaints
    // go down and then both dashes, and neither ever covers the other — up
    // to three dashed centre lines braiding across one sheet of tarmac. Since
    // equal widths cannot be ranked by width, they are ranked by how long the
    // road is, which is the same seniority a driver reads off the ground: the
    // through road's line carries on, the side road's stops where it joins.
    const order = [...paths].sort((a, b) => a.w - b.w || a.len - b.len);
    // A junction is bare asphalt. The per-tile painter has said so since the
    // beginning; the ribbon painter did not, and drew its dash straight
    // through every crossing — 5,780 junction tiles of it. The crossings are
    // a property of the CURVES, so they are computed from the curves and
    // punched out of the dash here: an outer rect plus counter-wound discs,
    // clipped even-odd, is "everywhere except the junctions".
    const bare = new Path2D();
    bare.rect(0, 0, CHUNK_DEVICE, CHUNK_DEVICE);
    let punched = 0;
    for (const j of this.junctionDiscs) {
      const jx = (j.x - tx0) * TD;
      const jy = (j.y - ty0) * TD;
      const jr = j.r * TD;
      if (jx + jr < 0 || jy + jr < 0 || jx - jr > CHUNK_DEVICE || jy - jr > CHUNK_DEVICE) continue;
      bare.moveTo(jx + jr, jy);
      bare.arc(jx, jy, jr, 0, Math.PI * 2);
      punched++;
    }
    for (const p of order) {
      ctx.setLineDash([]);
      ctx.strokeStyle = palette.road;
      ctx.lineWidth = p.w - 4 * t;
      ctx.stroke(p.path);
      ctx.save();
      if (punched > 0) ctx.clip(bare, 'evenodd');
      ctx.setLineDash([4 * t, 6 * t]);
      ctx.strokeStyle = palette.roadLane;
      ctx.lineWidth = t;
      ctx.stroke(p.path);
      ctx.restore();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Drop every cached chunk — used when the sprite sheet finishes loading. */
  invalidate(): void {
    this.chunks.clear();
    this.roofCache.clear();
  }

  /**
   * One building's roof, baked to its own canvas.
   *
   * The parallax pass moves roofs per frame, so they cannot live in the
   * chunk — but repainting the speckle, parapets and clutter per frame would
   * put the per-tile cost straight back that drawing per building just took
   * out. Baking each roof once and blitting it displaced keeps both: the art
   * is the identical `paintRoof` the cached path uses, and the per-frame cost
   * is one `drawImage` per building.
   *
   * Returns null while the map is missing or the index is stale, in which
   * case the caller falls back to a flat fill.
   */
  private roofCanvasFor(index: number): HTMLCanvasElement | null {
    const cached = this.roofCache.get(index);
    if (cached) return cached;
    const map = this.map;
    const b = map?.buildings[index];
    if (!map || !b) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, b.w * TD);
    canvas.height = Math.max(1, b.h * TD);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        // A footprint is a rect but its tiles are not all building — a shop
        // interior is punched out of one. Painting a roof over the hole would
        // put a lid on a room that is open to the sky.
        if (this.tileAt(tx, ty) !== T_BUILDING) continue;
        this.paintRoof(ctx, tx, ty, (tx - b.x) * TD, (ty - b.y) * TD);
      }
    }
    this.roofCache.set(index, canvas);
    if (this.roofCache.size > ROOF_CACHE_LIMIT) {
      const oldest = this.roofCache.keys().next().value;
      if (oldest !== undefined) this.roofCache.delete(oldest);
    }
    return canvas;
  }

  /**
   * Blit the visible chunks. `originX/originY` are the device-pixel position of
   * world origin, already snapped, so every chunk lands on the same grid and no
   * seams open up between them.
   */
  draw(ctx: CanvasRenderingContext2D, cam: Vec2, originX: number, originY: number): void {
    const map = this.map;
    if (!map) return;
    this.frameCounter++;

    const cx0 = Math.floor(cam.x / CHUNK_WORLD);
    const cy0 = Math.floor(cam.y / CHUNK_WORLD);
    const cx1 = Math.floor((cam.x + viewport.w) / CHUNK_WORLD);
    const cy1 = Math.floor((cam.y + viewport.h) / CHUNK_WORLD);

    let budget = CHUNK_BUILDS_PER_FRAME;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cy * 100000 + cx;
        let chunk = this.chunks.get(key);
        if (!chunk && budget > 0) {
          budget--;
          chunk = { canvas: this.buildChunk(cx, cy), touched: this.frameCounter };
          this.chunks.set(key, chunk);
        }
        const dx = originX + cx * CHUNK_DEVICE;
        const dy = originY + cy * CHUNK_DEVICE;
        if (!chunk) {
          // Not built yet: a flat wash beats a hole while the budget catches up.
          ctx.fillStyle = palette.field;
          ctx.fillRect(dx, dy, CHUNK_DEVICE, CHUNK_DEVICE);
          continue;
        }
        chunk.touched = this.frameCounter;
        ctx.drawImage(chunk.canvas, dx, dy);
      }
    }

    // Spend whatever budget is left on the ring just outside the viewport, so
    // driving into fresh ground finds it already painted. Standing still — or
    // any frame where nothing visible needs building — quietly pays down the
    // cost of the next few seconds of movement.
    if (budget > 0) this.prefetch(cx0 - 1, cy0 - 1, cx1 + 1, cy1 + 1, budget);

    if (this.chunks.size > CHUNK_CACHE_LIMIT) this.evict();

    // Buildings last: they stand on the ground the chunks just laid down, and
    // under everything the renderer draws after this.
    if (this.extruded) {
      this.extrude.draw(ctx, cam, originX, originY);
      this.lastBuildingsDrawn = this.extrude.lastCount;
    }
  }

  private prefetch(cx0: number, cy0: number, cx1: number, cy1: number, budget: number): void {
    let left = budget;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        // Interior is the viewport, already handled above.
        if (cx > cx0 && cx < cx1 && cy > cy0 && cy < cy1) continue;
        const key = cy * 100000 + cx;
        if (this.chunks.has(key)) continue;
        this.chunks.set(key, { canvas: this.buildChunk(cx, cy), touched: this.frameCounter });
        if (--left <= 0) return;
      }
    }
  }

  private evict(): void {
    const entries = [...this.chunks.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (let i = 0; i < entries.length - CHUNK_CACHE_LIMIT; i++) {
      this.chunks.delete((entries[i] as [number, Chunk])[0]);
    }
  }

  // ── indices built once per map ─────────────────────────────────────────────

  /**
   * Which building each tile belongs to, so a block of roof tiles can share one
   * colour and one silhouette instead of reading as a grid of identical squares.
   */
  private indexBuildings(map: CityMap): void {
    this.buildingOf = new Int32Array(map.widthTiles * map.heightTiles);
    map.buildings.forEach((b, i) => {
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
          this.buildingOf[ty * map.widthTiles + tx] = i + 1;
        }
      }
    });
  }

  /**
   * Which shop each interior tile belongs to, so a floor tile knows whose
   * shop it is standing in without searching the whole shop list per tile.
   */
  private indexShops(map: CityMap): void {
    this.shopOf = new Int32Array(map.widthTiles * map.heightTiles);
    map.shops.forEach((shop, i) => {
      const r = shop.interior;
      for (let ty = r.y - 1; ty <= r.y + r.h; ty++) {
        for (let tx = r.x - 1; tx <= r.x + r.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
          this.shopOf[ty * map.widthTiles + tx] = i + 1;
        }
      }
    });
  }

  /**
   * Length of the contiguous road run through every road tile, per axis, plus
   * the tile's index within it. Lane markings, kerb lines and junctions all
   * fall out of these two numbers: on a horizontal road the *vertical* run is
   * just the carriageway width, so its midpoint is the centre line.
   */
  private indexRoadRuns(map: CityMap): void {
    const n = map.widthTiles * map.heightTiles;
    this.runH = new Uint8Array(n);
    this.runV = new Uint8Array(n);
    this.idxH = new Uint8Array(n);
    this.idxV = new Uint8Array(n);

    for (let ty = 0; ty < map.heightTiles; ty++) {
      let start = -1;
      for (let tx = 0; tx <= map.widthTiles; tx++) {
        const road = tx < map.widthTiles && map.tiles[ty * map.widthTiles + tx] === T_ROAD;
        if (road && start < 0) start = tx;
        if (!road && start >= 0) {
          const len = Math.min(255, tx - start);
          for (let k = start; k < tx; k++) {
            this.runH[ty * map.widthTiles + k] = len;
            this.idxH[ty * map.widthTiles + k] = Math.min(255, k - start);
          }
          start = -1;
        }
      }
    }
    for (let tx = 0; tx < map.widthTiles; tx++) {
      let start = -1;
      for (let ty = 0; ty <= map.heightTiles; ty++) {
        const road = ty < map.heightTiles && map.tiles[ty * map.widthTiles + tx] === T_ROAD;
        if (road && start < 0) start = ty;
        if (!road && start >= 0) {
          const len = Math.min(255, ty - start);
          for (let k = start; k < ty; k++) {
            this.runV[k * map.widthTiles + tx] = len;
            this.idxV[k * map.widthTiles + tx] = Math.min(255, k - start);
          }
          start = -1;
        }
      }
    }
  }

  // ── chunk painting ─────────────────────────────────────────────────────────

  private tileAt(tx: number, ty: number): number {
    const map = this.map as CityMap;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return T_BUILDING;
    return map.tiles[ty * map.widthTiles + tx] as number;
  }

  private districtOf(tx: number, ty: number): string {
    const map = this.map as CityMap;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return 'downtown';
    return DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number] as string;
  }

  private roofColor(tx: number, ty: number): string {
    const map = this.map as CityMap;
    const district = this.districtOf(tx, ty);
    const variants =
      (palette.buildingVariants as Record<string, string[]>)[district] ??
      palette.buildingVariants.downtown;
    const id = this.buildingOf[ty * map.widthTiles + tx] as number;
    // Fall back to the tile's own coordinates for stray building tiles that no
    // rect claimed, so neighbours still differ rather than all going grey.
    const pick = id > 0 ? hash2(id, id * 7 + 3) : hash2(tx, ty, 91);
    return variants[Math.floor(pick * variants.length) % variants.length] as string;
  }

  /**
   * A chunk with ONLY the ground painted, for the 3D renderer to stand on.
   *
   * The 3D city is built from instanced boxes carrying one flat colour per
   * surface type — fourteen of them for the whole world — while this class has
   * always painted the same ground out of forty-odd palette entries with
   * grain, resurfacing patches, manholes, kerb shading, paving joints, lane
   * marks and a per-district pavement tint. Ground is around ninety per cent
   * of a top-down frame, so that difference is most of why the 3D city reads
   * as a model of a city rather than a city.
   *
   * Rather than re-implement any of it in a shader, the 3D ground layer takes
   * these canvases as textures. It is a divergence being removed, not an art
   * pipeline being forked.
   *
   * Ground only: no walls, no roofs, and none of the baked drop shadows
   * `buildChunk` adds — 3D has its own geometry and its own shadow map, and
   * baking a second set under them would double every one.
   *
   * **Water is cut out; buildings are not.** Both are real volumes in 3D, but
   * only one of them is a hole. A building stands well above this plane and
   * hides its own footprint, so the footprint can be filled with anything and
   * painting it costs nothing. Water sits *below* the plane, so leaving it in
   * would lay a flat lid over a surface that is supposed to have a depth and a
   * shoreline. The hole is punched by the `cut` mask rather than by leaving
   * the painting transparent — see `GroundChunk.cut` for why.
   *
   * That distinction is worth the extra flag it returns: a chunk with no water
   * in it needs no alpha test at all, and most chunks have none. `holes` says
   * which ones do, so the ground layer can draw the rest opaque and keep
   * early-z.
   *
   * It also returns `surface`, one texel per tile saying what that tile is
   * *made of* — see `SHEEN`. The painted canvas cannot answer that: tarmac
   * and a shop floor are both dark grey in it, and a shader deciding where
   * rain pools has to know which is which.
   */
  groundChunk(cx: number, cy: number): GroundChunk {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_DEVICE;
    canvas.height = CHUNK_DEVICE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    // One texel per tile. The surface a tile is made of does not vary inside
    // it, so anything finer would be storing the same byte sixteen times.
    const surface = document.createElement('canvas');
    surface.width = CHUNK_TILES;
    surface.height = CHUNK_TILES;
    const sctx = surface.getContext('2d') as CanvasRenderingContext2D;
    const mask = sctx.createImageData(CHUNK_TILES, CHUNK_TILES);

    // The cutout mask — no longer one texel per tile. The hole under a
    // bevelled shoreline tile is a TRIANGLE, and a mask that can only
    // punch whole tiles would put a square lid back on every diagonal the
    // painter just drew. CUT_SUB texels per tile edge keeps the mask tiny
    // (a 64×64 canvas per chunk) while letting the alpha test follow the
    // hypotenuse to within two world px. See `GroundChunk.cut`.
    const CUT_SUB = 8;
    const cutW = CHUNK_TILES * CUT_SUB;
    const cut = document.createElement('canvas');
    cut.width = cutW;
    cut.height = cutW;
    const cctx = cut.getContext('2d') as CanvasRenderingContext2D;
    const cutMask = cctx.createImageData(cutW, cutW);

    const tx0 = cx * CHUNK_TILES;
    const ty0 = cy * CHUNK_TILES;
    let holes = false;
    for (let ty = ty0; ty < ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0; tx < tx0 + CHUNK_TILES; tx++) {
        const tile = this.tileAt(tx, ty);
        const x = (tx - tx0) * TD;
        const y = (ty - ty0) * TD;
        const m = ((ty - ty0) * CHUNK_TILES + (tx - tx0)) * 4;
        mask.data[m] = Math.round(255 * sheenOf(tile));
        mask.data[m + 3] = 255;
        // Which sub-texels of this tile are open water. A bevelled water
        // tile keeps water only on its own half; a bevelled land tile whose
        // cut half is water — a chamfered headland — gives that half up.
        const code = this.bevelAt(tx, ty);
        const map = this.map as CityMap;
        const other =
          code === BEV_NONE
            ? tile
            : bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, tx, ty);
        const wetHalf = tile === T_WATER || (code !== BEV_NONE && other === T_WATER);
        // The coast course, where there is one, decides the cutout instead
        // of the bevel — the same substitution the 2D painter makes, and the
        // reason the mask is eight texels an edge rather than one: it was
        // always built to follow a line finer than the tile, and until now
        // the finest line it had was a 45° cut.
        const seg = this.shoreSegAt(tx, ty);
        for (let sy = 0; sy < CUT_SUB; sy++) {
          for (let sx = 0; sx < CUT_SUB; sx++) {
            let wet = false;
            if (seg !== undefined) {
              // Water on the right of every run of the chain; y down, so the
              // cross product is positive on the wet side. A texel is wet
              // when the LAST run that has an opinion says so, which is the
              // same rule `shoreHalf` clips by.
              const ux = (sx + 0.5) / CUT_SUB;
              const uy = (sy + 0.5) / CUT_SUB;
              for (let k = 0; k + 3 < seg.length; k += 2) {
                const cax = seg[k] as number;
                const cay = seg[k + 1] as number;
                const cvx = (seg[k + 2] as number) - cax;
                const cvy = (seg[k + 3] as number) - cay;
                wet = cvx * (uy - cay) - cvy * (ux - cax) > 0;
              }
            } else if (wetHalf) {
              if (code === BEV_NONE) {
                wet = true;
              } else {
                const inCut = inCutHalf(
                  code,
                  ((sx + 0.5) * TILE_SIZE) / CUT_SUB,
                  ((sy + 0.5) * TILE_SIZE) / CUT_SUB,
                );
                wet = tile === T_WATER ? !inCut : inCut;
              }
            }
            const c =
              (((ty - ty0) * CUT_SUB + sy) * cutW + ((tx - tx0) * CUT_SUB + sx)) * 4;
            cutMask.data[c + 1] = wet ? 0 : 255;
            cutMask.data[c + 3] = 255;
            if (wet) holes = true;
          }
        }
        if (tile === T_WATER) {
          // Flat water colour, opaque. Rarely SHOWN — the cutout removes the
          // wet part — but it is what the filter blends shoreline texels
          // towards, and blending towards water is invisible where blending
          // towards transparent black was a dark rim around every island.
          ctx.fillStyle = palette.water;
          ctx.fillRect(x, y, TD, TD);
          // A water tile the coast crosses is part beach (or bank, or quay):
          // paint the dry side so the ground plane has something to show
          // where the cutout has just decided not to remove it.
          const dry = this.shoreSegAt(tx, ty);
          if (dry !== undefined) this.paintShoreTile(ctx, tx, ty, x, y, dry, false);
          else this.paintBevel(ctx, tx, ty, x, y, false);
          continue;
        }
        if (tile === T_BUILDING) {
          // The plot the building stands on. This used to be a flat fill on
          // the grounds that a roof covered it; a turned mass does not, and
          // the fill showed through at its corners (§20).
          this.paintPlot(ctx, tx, ty, x, y, false);
          continue;
        }
        // No flat plants in the 3D ground: the scenery layer stands real
        // meshes on the same tiles. See `paintGround`.
        this.paintGround(ctx, tx, ty, x, y, tile, false);
      }
    }
    // The turned forecourts (§21), over the tile ground and under nothing:
    // in 3D the mass itself is geometry, so the texture only ever shows the
    // apron round it.
    for (const m of this.massesNear(tx0, ty0)) this.paintMassApron(ctx, m, tx0, ty0);
    this.paintCourses(ctx, tx0, ty0);
    sctx.putImageData(mask, 0, 0);
    cctx.putImageData(cutMask, 0, 0);
    return { canvas, holes, surface, cut };
  }

  private buildChunk(cx: number, cy: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_DEVICE;
    canvas.height = CHUNK_DEVICE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    const tx0 = cx * CHUNK_TILES;
    const ty0 = cy * CHUNK_TILES;
    /** Tile coords -> device pixels inside this chunk. */
    const ox = (tx: number): number => (tx - tx0) * TD;
    const oy = (ty: number): number => (ty - ty0) * TD;

    // 1. Ground, then the road courses stroked over it as curves (§16).
    for (let ty = ty0; ty < ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0; tx < tx0 + CHUNK_TILES; tx++) {
        const tile = this.tileAt(tx, ty);
        if (tile === T_BUILDING) this.paintPlot(ctx, tx, ty, ox(tx), oy(ty), true);
        else this.paintGround(ctx, tx, ty, ox(tx), oy(ty), tile);
      }
    }
    this.paintCourses(ctx, tx0, ty0);

    // 1b. The turned forecourt each facing building stands on (§21). Outside
    //     the `extruded` branch below, because the apron is GROUND: the
    //     parallax renderer redraws the masses per frame but not the paving
    //     under them, and baking square paving under a turned house was the
    //     same dark-corner tell the plot fill had. Before the shadows, too —
    //     a neighbour's shadow crosses a doorstep like any other pavement.
    const masses = this.massesNear(tx0, ty0);
    for (const m of masses) this.paintMassApron(ctx, m, tx0, ty0);

    // 2. Building shadows, built as one opaque mask so overlapping tiles do not
    //    double-darken, then laid down translucent in a single blit.
    this.paintBuildingShadows(ctx, tx0, ty0);

    // 3. Extruded walls, then 4. roofs on top of them. Both run over a one-tile
    //    border so buildings straddling a chunk edge extrude seamlessly.
    //
    //    Skipped entirely under `extruded`: the parallax pass draws the same
    //    masses per frame, and baking a second set underneath them would show
    //    through wherever the two disagree — which is everywhere, by design.
    if (!this.extruded) {
      // Buildings that face a street are drawn as one rotated mass (§20);
      // their tiles are skipped by the square walk. Walls for both first, so
      // a near mass's wall covers the one behind it.
      const W = (this.map as CityMap).widthTiles;
      const massed = new Set<number>();
      for (const m of masses) {
        for (let ty = m.b.y; ty < m.b.y + m.b.h; ty++) {
          for (let tx = m.b.x; tx < m.b.x + m.b.w; tx++) massed.add(ty * W + tx);
        }
      }
      const square = (tx: number, ty: number): boolean =>
        this.tileAt(tx, ty) === T_BUILDING && !massed.has(ty * W + tx);
      for (const m of masses) this.paintMassWall(ctx, m, tx0, ty0);
      for (let ty = ty0 - 1; ty <= ty0 + CHUNK_TILES; ty++) {
        for (let tx = tx0 - 1; tx <= tx0 + CHUNK_TILES; tx++) {
          if (!square(tx, ty)) continue;
          this.paintWall(ctx, tx, ty, ox(tx), oy(ty));
        }
      }
      for (const m of masses) this.paintMassRoof(ctx, m, tx0, ty0);
      for (let ty = ty0 - 1; ty <= ty0 + CHUNK_TILES; ty++) {
        for (let tx = tx0 - 1; tx <= tx0 + CHUNK_TILES; tx++) {
          if (!square(tx, ty)) continue;
          this.paintRoof(ctx, tx, ty, ox(tx), oy(ty));
        }
      }
    }

    // 5. Shop fronts, which sit on the sidewalk rather than the road.
    this.paintShops(ctx, tx0, ty0);
    return canvas;
  }

  // ── ground surfaces ────────────────────────────────────────────────────────

  private paintGround(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    tile: number,
    /**
     * Whether lush ground may bake its flat tree/bush sprites in. The 3D
     * ground texture says no: `SceneryLayer` plants a real mesh on the same
     * hash-chosen tiles, and it stands randomly yawed over a flat unrotated
     * twin baked underneath — every plant in a park showing its own
     * mismatched shadow-copy peeking out from under it.
     */
    plants = true,
  ): void {
    switch (tile) {
      case T_ROAD:
        this.paintRoad(ctx, tx, ty, x, y);
        break;
      case T_SIDEWALK:
        // A pavement tile under a walk ribbon is the walk's staircase
        // (3.2): the stroked curve is the path now, so the tile goes back
        // to being the lawn it was carved through, and the ribbon is the
        // only pavement in sight.
        if (
          this.pathCover !== null &&
          this.map !== null &&
          this.pathCover[ty * this.map.widthTiles + tx] === 1
        ) {
          this.paintGrass(ctx, tx, ty, x, y, palette.grassDark, palette.grassLight, true, plants);
          break;
        }
        this.paintSidewalk(ctx, tx, ty, x, y);
        break;
      case T_PARK:
        this.paintGrass(ctx, tx, ty, x, y, palette.grassDark, palette.grassLight, true, plants);
        break;
      case T_FIELD:
        this.paintGrass(ctx, tx, ty, x, y, palette.field, palette.grassDark, false);
        break;
      case T_LOT:
        this.paintLot(ctx, tx, ty, x, y);
        break;
      case T_WATER:
        this.paintWater(ctx, tx, ty, x, y);
        break;
      case T_BANK:
        this.paintBank(ctx, tx, ty, x, y);
        break;
      case T_TREES:
        // Canopy: the park grass painter with the forest palette does the
        // job — solid dark green with organic speckle, denser than lawn.
        this.paintGrass(ctx, tx, ty, x, y, palette.trees, palette.treesLight, true, plants);
        break;
      case T_SAND:
        this.paintGrass(ctx, tx, ty, x, y, palette.sand, palette.sandDark, false);
        break;
      case T_RUNWAY:
        this.paintRunway(ctx, tx, ty, x, y);
        break;
      case T_BRIDGE:
        this.paintBridge(ctx, tx, ty, x, y);
        break;
      case T_RAMP:
        this.paintRamp(ctx, tx, ty, x, y);
        break;
      case T_FLOOR:
        this.paintShopFloor(ctx, tx, ty, x, y);
        break;
      default:
        ctx.fillStyle = palette.field;
        ctx.fillRect(x, y, TD, TD);
    }
    // The shoreline. Two ways of drawing the same line, and the better one
    // wins where it exists: the coast course (§18) cuts this tile at whatever
    // angle the coast actually runs at, and the bevel plane (§15) cuts it at
    // 45° or not at all. A tile the curve passes through is repainted against
    // the curve and the bevel is skipped, because a half-tile triangle and a
    // chord disagreeing about where the sea starts is worse than either.
    const seg = this.shoreSegAt(tx, ty);
    //
    // The band's inner edge is the same choice one line further in: where it
    // cuts a tile, the bevel is skipped for the same reason. A 45° triangle
    // laid over a chord put a wedge of grass through the beach every few
    // tiles — a sawtooth along an otherwise smooth line, which is worse than
    // the staircase both of them were trying to replace.
    //
    // The waterline wins a tile that holds both. They are a tile and a half
    // apart by construction (`QUAY_REACH`), so that is a degenerate case at a
    // tight corner rather than the ordinary shape.
    if (seg !== undefined) this.paintShoreTile(ctx, tx, ty, x, y, seg, plants);
    else if (!this.paintBandTile(ctx, tx, ty, x, y, plants)) {
      this.paintBevel(ctx, tx, ty, x, y, plants);
    }
  }

  /**
   * One tile of the shore band's inner edge, cut against the CURVE (§39).
   *
   * `paintShoreTile` without the water: the same chain-and-two-halves, the
   * same `paintShoreMaterial` for each half, and no stroked lip because sand
   * meeting grass is not an edge you draw a line along. What it does not
   * share is how it decides what each half is made of. The waterline can say
   * "wet side is sea, dry side is the nearest dry tile"; here BOTH sides are
   * dry, and a wooded cliff foot and the wood behind it are the same tile
   * type — so each half takes the material of the nearest tile centre that
   * `chainSide` puts on that half, which asks the line itself.
   *
   * Returns whether it cut, so the caller knows to leave the bevel alone.
   */
  private paintBandTile(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    plants: boolean,
  ): boolean {
    const map = this.map;
    if (this.bandSegs === null || !map) return false;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
    const seg = this.bandSegs.get(ty * map.widthTiles + tx);
    if (seg === undefined || seg.length < 4) return false;
    // A wall is not shaded by the beach it stands behind, and a deck is not
    // ground at all.
    const own = this.tileAt(tx, ty);
    if (own === T_BUILDING || own === T_WATER || own === T_BRIDGE) return false;

    /** The nearest ground on one side of the line, as a tile type. */
    const materialOn = (want: number): number => {
      if (chainSide(seg, 0.5, 0.5) === want) return own;
      let best = Infinity;
      let mat = -1;
      for (const [dx, dy] of NEIGHBOURS) {
        const t = this.tileAt(tx + dx, ty + dy);
        if (t === T_WATER || t === T_BRIDGE || t === T_BUILDING) continue;
        if (chainSide(seg, dx + 0.5, dy + 0.5) !== want) continue;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          mat = t;
        }
      }
      return mat;
    };
    const shoreward = materialOn(-1);
    const inland = materialOn(1);
    // Nothing to PAINT if both halves are the same stuff, which is most of
    // the band's length wherever it runs behind a quay into more of the same.
    // Still `true`: the tile is uniform as far as the line is concerned, and
    // the 45° bevel that would otherwise land here is describing the very
    // boundary this curve owns (`YIELDS_P1` bevels sand against grass and
    // nothing else that could run through a band tile). Letting it draw put a
    // wedge back into an edge the curve had just said was straight.
    if (shoreward === inland || shoreward < 0 || inland < 0) return true;

    const local = (p: [number, number]): [number, number] => [x + p[0] * TD, y + p[1] * TD];
    const clipTo = (poly: Array<[number, number]>): boolean => {
      if (poly.length < 3) return false;
      ctx.beginPath();
      ctx.moveTo((poly[0] as [number, number])[0], (poly[0] as [number, number])[1]);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo((poly[i] as [number, number])[0], (poly[i] as [number, number])[1]);
      }
      ctx.closePath();
      ctx.clip();
      return true;
    };
    ctx.save();
    if (clipTo(shoreHalf(seg, true).map(local))) {
      this.paintShoreMaterial(ctx, tx, ty, x, y, shoreward, plants);
    }
    ctx.restore();
    ctx.save();
    if (clipTo(shoreHalf(seg, false).map(local))) {
      this.paintShoreMaterial(ctx, tx, ty, x, y, inland, plants);
    }
    ctx.restore();
    return true;
  }

  /** The nearest shore-course segment through a tile, if the coast runs here. */
  private shoreSegAt(tx: number, ty: number): Float32Array | undefined {
    const map = this.map;
    if (this.shoreSegs === null || !map) return undefined;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return undefined;
    return this.shoreSegs.get(ty * map.widthTiles + tx);
  }

  /**
   * One tile of coast, painted against the CURVE instead of its own edges.
   *
   * The generalisation of `paintBevel`, and it is one step: a bevel clips the
   * tile with a diagonal from corner to corner, this clips it with the chord
   * the coast course actually cuts through it. Land on one side in whatever
   * the land is made of here, sea on the other, and the pale lip stroked
   * along the chord — the same three things the square painter and the
   * bevelled painter both do, at the angle the coast runs rather than at one
   * of the five angles a tile grid can say.
   *
   * Per tile rather than by filling the whole loop as one path, deliberately.
   * A chunk is 32 tiles and a coast loop is a thousand points round an
   * island; filling it per chunk means clipping a path most of which is
   * somewhere else, and getting the parity right for a chunk that sits INSIDE
   * a loop with none of it crossing. Locally the curve through one tile is a
   * chord to well under a pixel, and a chord costs four corners of arithmetic.
   */
  private paintShoreTile(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    seg: Float32Array,
    plants: boolean,
  ): void {
    /** The chain, and each half of the square, in this tile's device pixels. */
    const local = (p: [number, number]): [number, number] => [x + p[0] * TD, y + p[1] * TD];
    const halfOf = (wantWet: boolean): Array<[number, number]> =>
      shoreHalf(seg, wantWet).map(local);
    const square: Array<[number, number]> = [
      [x, y],
      [x + TD, y],
      [x + TD, y + TD],
      [x, y + TD],
    ];
    const clipTo = (poly: Array<[number, number]>): boolean => {
      if (poly.length < 3) return false;
      ctx.beginPath();
      ctx.moveTo((poly[0] as [number, number])[0], (poly[0] as [number, number])[1]);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo((poly[i] as [number, number])[0], (poly[i] as [number, number])[1]);
      }
      ctx.closePath();
      ctx.clip();
      return true;
    };

    // What the land is made of here. The tile's own material if it is dry;
    // otherwise the nearest dry neighbour's, because a sea tile the curve has
    // just made half-dry belongs to the beach or the quay beside it and not
    // to some default. Buildings are skipped: a wall does not run into water,
    // and painting one under the waterline would show as a block in the surf.
    let landTile = this.tileAt(tx, ty);
    if (landTile === T_WATER || landTile === T_BRIDGE) {
      let bd = Infinity;
      for (const [dx, dy] of NEIGHBOURS) {
        const t = this.tileAt(tx + dx, ty + dy);
        if (t === T_WATER || t === T_BRIDGE || t === T_BUILDING) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          landTile = t;
        }
      }
      if (landTile === T_WATER || landTile === T_BRIDGE) landTile = T_FIELD;
    }

    ctx.save();
    if (clipTo(halfOf(false))) this.paintShoreMaterial(ctx, tx, ty, x, y, landTile, plants);
    ctx.restore();
    ctx.save();
    if (clipTo(halfOf(true))) {
      // A bridge deck keeps its own painter: the coast runs UNDER it, so the
      // wet side of a bridge tile is deck, not sea.
      if (this.tileAt(tx, ty) === T_BRIDGE) this.paintBridge(ctx, tx, ty, x, y);
      else this.paintWater(ctx, tx, ty, x, y, false);
    }
    ctx.restore();

    // The waterline itself, along the chain. Clipped to the tile so the
    // stroke's width cannot bleed into the neighbour, which paints its own —
    // and because the chains share their ends, the two strokes join.
    if (this.tileAt(tx, ty) !== T_BRIDGE && seg.length >= 4) {
      ctx.save();
      clipTo(square);
      ctx.strokeStyle = shade(palette.water, 0.3, '#bfe0ef');
      ctx.lineWidth = Math.max(1, (TD / 14) | 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + (seg[0] as number) * TD, y + (seg[1] as number) * TD);
      for (let k = 2; k + 1 < seg.length; k += 2) {
        ctx.lineTo(x + (seg[k] as number) * TD, y + (seg[k + 1] as number) * TD);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /** The ordinary ground painters, dispatched for a shore tile's dry half. */
  private paintShoreMaterial(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    tile: number,
    plants: boolean,
  ): void {
    switch (tile) {
      case T_SAND:
        this.paintGrass(ctx, tx, ty, x, y, palette.sand, palette.sandDark, false);
        break;
      case T_BANK:
        this.paintBank(ctx, tx, ty, x, y, false);
        break;
      case T_PARK:
        this.paintGrass(ctx, tx, ty, x, y, palette.grassDark, palette.grassLight, true, plants);
        break;
      case T_TREES:
        this.paintGrass(ctx, tx, ty, x, y, palette.trees, palette.treesLight, true, plants);
        break;
      case T_ROAD:
        // Bare asphalt, no marks: a slice of carriageway at the waterline is
        // a kerbside sliver and never a lane.
        ctx.fillStyle = palette.road;
        ctx.fillRect(x, y, TD, TD);
        this.speckle(ctx, tx, ty, x, y, palette.roadDark, 5, 2, 3);
        break;
      case T_SIDEWALK:
        this.paintSidewalk(ctx, tx, ty, x, y);
        break;
      case T_LOT:
        this.paintLot(ctx, tx, ty, x, y);
        break;
      case T_RUNWAY:
        this.paintRunway(ctx, tx, ty, x, y);
        break;
      default:
        this.paintGrass(ctx, tx, ty, x, y, palette.field, palette.grassDark, false);
    }
  }

  /** Bevel code at a tile, or BEV_NONE off-map / before the map arrives. */
  private bevelAt(tx: number, ty: number): number {
    const map = this.map;
    if (!map?.bevel) return BEV_NONE;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return BEV_NONE;
    return map.bevel[ty * map.widthTiles + tx] as number;
  }

  /**
   * The cut half of a bevelled tile, painted as what it is made of.
   *
   * The overlay reuses the ordinary painters clipped to the triangle, so a
   * sand wedge gets the same speckle as the beach beside it and a water
   * wedge the same bands as the sea it joins. Along the hypotenuse of any
   * water bevel goes the same pale lip `paintWater` puts on a straight
   * shore, so the waterline reads as one continuous line whether it is
   * running square or at 45°.
   */
  private paintBevel(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    plants = true,
  ): void {
    const code = this.bevelAt(tx, ty);
    if (code === BEV_NONE) return;
    const map = this.map as CityMap;
    const other = bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, tx, ty);

    ctx.save();
    ctx.beginPath();
    if (code === BEV_NE) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + TD, y);
      ctx.lineTo(x + TD, y + TD);
    } else if (code === BEV_SE) {
      ctx.moveTo(x + TD, y);
      ctx.lineTo(x + TD, y + TD);
      ctx.lineTo(x, y + TD);
    } else if (code === BEV_SW) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + TD);
      ctx.lineTo(x + TD, y + TD);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x + TD, y);
      ctx.lineTo(x, y + TD);
    }
    ctx.closePath();
    ctx.clip();
    switch (other) {
      case T_WATER:
        this.paintWater(ctx, tx, ty, x, y);
        break;
      case T_SAND:
        this.paintGrass(ctx, tx, ty, x, y, palette.sand, palette.sandDark, false);
        break;
      case T_PARK:
        this.paintGrass(ctx, tx, ty, x, y, palette.grassDark, palette.grassLight, true, plants);
        break;
      case T_TREES:
        // Canopy overhanging the waterline — same painter the full tile
        // uses, so the wedge continues the wood beside it.
        this.paintGrass(ctx, tx, ty, x, y, palette.trees, palette.treesLight, true, plants);
        break;
      case T_BRIDGE:
      case T_ROAD:
        // Bare asphalt with the carriageway's own grain — no marks and no
        // patches: a wedge is a kerbside sliver or a deck overhang, not a
        // lane. T_BRIDGE is here by name because §31 added the deck to the
        // yield tables without adding it to this switch, and every parapet
        // step's wedge fell through to the grass default — green triangles
        // over open sea on all three crossings (REVIEW-WORLDGEN.md §2.3).
        ctx.fillStyle = palette.road;
        ctx.fillRect(x, y, TD, TD);
        this.speckle(ctx, tx, ty, x, y, palette.roadDark, 5, 2, 3);
        this.speckle(ctx, tx, ty, x, y, palette.roadLight, 3, 1, 9);
        break;
      default:
        // T_FIELD's painter, and DELIBERATELY only T_FIELD's: any material
        // the yield tables learn to produce must be added above by name, or
        // it comes out as a grass wedge wherever it meets the water — the
        // §31 lesson. `city.test.ts` pins the set this switch must cover.
        this.paintGrass(ctx, tx, ty, x, y, palette.field, palette.grassDark, false);
    }
    ctx.restore();

    // The boundary line along the hypotenuse: the shore lip where the water
    // is involved, the kerb where the carriageway is — the same lines the
    // square painters draw on tile edges, following the cut.
    const line =
      other === T_WATER || this.tileAt(tx, ty) === T_WATER
        ? shade(palette.water, 0.3, '#bfe0ef')
        : other === T_ROAD
          ? palette.kerb
          : null;
    if (line !== null) {
      ctx.strokeStyle = line;
      ctx.lineWidth = Math.max(1, other === T_ROAD ? 2 * RENDER_SCALE : (TD / 14) | 0);
      ctx.beginPath();
      if (code === BEV_NE || code === BEV_SW) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + TD, y + TD);
      } else {
        ctx.moveTo(x + TD, y);
        ctx.lineTo(x, y + TD);
      }
      ctx.stroke();
    }
  }

  /**
   * River. Banded rather than flat so the surface reads as moving water at a
   * glance, with a lighter lip where it meets the bank.
   */
  private paintWater(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    /**
     * Draw the pale lip along this tile's own dry edges. Off for a tile the
     * coast course runs through: the curve strokes the waterline where the
     * water actually starts, and the tile-edge version of the same line
     * beside it is the staircase the curve exists to replace.
     */
    lip = true,
  ): void {
    ctx.fillStyle = palette.water;
    ctx.fillRect(x, y, TD, TD);
    const h = hash2(tx, ty, 91);
    ctx.fillStyle = shade(palette.water, 0.16, '#8fbcd6');
    for (let i = 0; i < 3; i++) {
      const band = (h >> (i * 5)) & 31;
      const by = y + ((band / 32) * TD) | 0;
      const bw = (TD * (0.35 + ((band & 7) / 20))) | 0;
      const bx = x + (((h >> (i * 3 + 2)) & 15) / 16) * (TD - bw);
      ctx.fillRect(bx | 0, by, bw, Math.max(1, (TD / 12) | 0));
    }
    // Shore lip against any non-water neighbour.
    if (!lip) return;
    ctx.fillStyle = shade(palette.water, 0.3, '#bfe0ef');
    if (this.tileAt(tx, ty - 1) !== T_WATER && this.tileAt(tx, ty - 1) !== T_BRIDGE) {
      ctx.fillRect(x, y, TD, Math.max(1, (TD / 14) | 0));
    }
    if (this.tileAt(tx - 1, ty) !== T_WATER && this.tileAt(tx - 1, ty) !== T_BRIDGE) {
      ctx.fillRect(x, y, Math.max(1, (TD / 14) | 0), TD);
    }
  }

  /**
   * Quay/embankment: flat waterfront stone with a lighter coping course
   * along the water's edge, so the drop into the river reads at a glance.
   */
  private paintBank(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    /** As `paintWater`: off where the coast course draws the edge instead. */
    coping = true,
  ): void {
    ctx.fillStyle = palette.bank;
    ctx.fillRect(x, y, TD, TD);
    if (!coping) return;
    ctx.fillStyle = palette.bankEdge;
    const lip = Math.max(1, (TD / 8) | 0);
    const wet = (nx: number, ny: number): boolean => {
      const t = this.tileAt(nx, ny);
      return t === T_WATER || t === T_BRIDGE;
    };
    if (wet(tx, ty - 1)) ctx.fillRect(x, y, TD, lip);
    if (wet(tx, ty + 1)) ctx.fillRect(x, y + TD - lip, TD, lip);
    if (wet(tx - 1, ty)) ctx.fillRect(x, y, lip, TD);
    if (wet(tx + 1, ty)) ctx.fillRect(x + TD - lip, y, lip, TD);
  }

  /** Bridge deck: road surface with a rail down each side. */
  private paintBridge(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    this.paintRoad(ctx, tx, ty, x, y);
    ctx.fillStyle = palette.kerb;
    const rail = Math.max(1, (TD / 10) | 0);
    // A parapet stands where the deck ends and the drop begins: on any edge
    // of this tile with open water across it. Nothing is inferred about which
    // way the bridge runs, which is what the old test got wrong — it asked
    // whether a bridge tile lay east or west, and on a four-wide north-south
    // deck that is true of every tile, so every tile drew its rails top and
    // bottom and the deck came out as a ladder of rungs across the road.
    // Edges onto land are abutments and get none.
    if (this.tileAt(tx, ty - 1) === T_WATER) ctx.fillRect(x, y, TD, rail);
    if (this.tileAt(tx, ty + 1) === T_WATER) ctx.fillRect(x, y + TD - rail, TD, rail);
    if (this.tileAt(tx - 1, ty) === T_WATER) ctx.fillRect(x, y, rail, TD);
    if (this.tileAt(tx + 1, ty) === T_WATER) ctx.fillRect(x + TD - rail, y, rail, TD);
  }

  /** Stunt ramp: chevrons on concrete, so it reads as "hit this fast". */
  private paintRamp(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    this.paintLot(ctx, tx, ty, x, y);
    ctx.fillStyle = palette.uiAccent;
    const band = Math.max(1, (TD / 8) | 0);
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(x + 2, y + 2 + i * band * 2, TD - 4, band);
    }
  }

  /**
   * The inside of a shop.
   *
   * Buying used to happen through a closed wall: the shop was a coloured
   * awning on the pavement and a menu that opened when you stood near it. The
   * generator now hollows the building out, so there is a room to walk into —
   * and because the roof simply is not drawn over floor tiles, it reads as a
   * cutaway from above without a second render pass.
   *
   * Fittings are derived per tile from the room rect and where its door is:
   * threshold on the doorway, counter along the back wall, shelves down the
   * sides, and a marked-out bay instead for a respray you drive into.
   */
  private paintShopFloor(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const map = this.map as CityMap;
    const shop = map.shops[(this.shopOf[ty * map.widthTiles + tx] as number) - 1];
    const s = RENDER_SCALE;

    // Chequered floor with a grout line along the north and west edges.
    const base = ((tx + ty) & 1) === 0 ? palette.shopFloor : palette.shopFloorAlt;
    ctx.fillStyle = base;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, shade(base, 0.12), 5, 1, 77);
    ctx.fillStyle = shade(base, 0.3);
    ctx.fillRect(x, y, TD, s);
    ctx.fillRect(x, y, s, TD);
    if (!shop) return;

    // The proving ground is not a shop and should not look like one: a
    // green you will not mistake for a gun shop from across a junction.
    const accent =
      shop.kind === 'gun'
        ? palette.shopGun
        : shop.kind === 'clothing'
          ? palette.shopClothing
          : shop.kind === 'depot'
            ? DEPOT_ACCENT
            : palette.shopSpray;
    const r = shop.interior;
    const inRoom = tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;
    if (!inRoom) {
      // The doorway itself: a threshold strip in the shop's colour.
      ctx.fillStyle = shade(accent, 0.35);
      ctx.fillRect(x + 2 * s, y + 2 * s, TD - 4 * s, TD - 4 * s);
      ctx.fillStyle = accent;
      ctx.fillRect(x + 4 * s, y + 4 * s, TD - 8 * s, TD - 8 * s);
      return;
    }

    // A respray is a garage: keep the floor clear so a car can be driven in,
    // and mark the bay out instead of furnishing it.
    if (shop.kind === 'spray' || shop.kind === 'depot') {
      ctx.fillStyle = shade(accent, 0.55);
      const stripe = Math.max(1, s);
      if (ty === r.y) ctx.fillRect(x, y + 3 * s, TD, stripe);
      if (ty === r.y + r.h - 1) ctx.fillRect(x, y + TD - 4 * s, TD, stripe);
      if (tx === r.x) ctx.fillRect(x + 3 * s, y, stripe, TD);
      if (tx === r.x + r.w - 1) ctx.fillRect(x + TD - 4 * s, y, stripe, TD);
      if (hash2(tx, ty, 78) > 0.55) {
        ctx.fillStyle = 'rgba(12, 14, 18, 0.35)';
        ctx.beginPath();
        ctx.arc(x + TD / 2, y + TD / 2, 4 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    // Which wall the door is in tells us where the back of the shop is.
    const doorTop = shop.entryY < r.y;
    const doorBottom = shop.entryY >= r.y + r.h;
    const doorLeft = shop.entryX < r.x;
    const vertical = doorTop || doorBottom;
    const depth = vertical ? r.h : r.w;
    const backRow = doorTop ? r.y + r.h - 1 : r.y;
    const backCol = doorLeft ? r.x + r.w - 1 : r.x;
    const atBack = vertical ? ty === backRow : tx === backCol;

    // A counter needs a shop deep enough to stand behind it.
    if (depth >= 2 && atBack) {
      ctx.fillStyle = palette.shopCounter;
      ctx.fillRect(x, y, TD, TD);
      ctx.fillStyle = palette.shopCounterTop;
      // Lip on the customer side.
      if (vertical) {
        ctx.fillRect(x, doorTop ? y : y + TD - 3 * s, TD, 3 * s);
      } else {
        ctx.fillRect(doorLeft ? x : x + TD - 3 * s, y, 3 * s, TD);
      }
      ctx.fillStyle = accent;
      ctx.fillRect(x + 3 * s, y + 3 * s, TD - 6 * s, 2 * s);
      return;
    }

    // Shelves against the side walls, stocked in the shop's colour.
    const sideWall = vertical
      ? tx === r.x || tx === r.x + r.w - 1
      : ty === r.y || ty === r.y + r.h - 1;
    if (sideWall && depth >= 3 && hash2(tx, ty, 79) > 0.35) {
      ctx.fillStyle = palette.shopShelf;
      const west = vertical ? tx === r.x : ty === r.y;
      if (vertical) ctx.fillRect(west ? x : x + TD - 5 * s, y + 2 * s, 5 * s, TD - 4 * s);
      else ctx.fillRect(x + 2 * s, west ? y : y + TD - 5 * s, TD - 4 * s, 5 * s);
      ctx.fillStyle = accent;
      for (let i = 0; i < 3; i++) {
        if (vertical) {
          ctx.fillRect(west ? x + s : x + TD - 4 * s, y + (3 + i * 4) * s, 2 * s, 2 * s);
        } else {
          ctx.fillRect(x + (3 + i * 4) * s, west ? y + s : y + TD - 4 * s, 2 * s, 2 * s);
        }
      }
    }
  }

  /** Speckle a surface with a handful of deterministic grains. */
  private speckle(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    color: string,
    count: number,
    size: number,
    salt: number,
  ): void {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const px = Math.floor(hash2(tx * 31 + i, ty * 17 + i, salt) * (TD - size));
      const py = Math.floor(hash2(tx * 13 + i, ty * 29 + i, salt + 1) * (TD - size));
      ctx.fillRect(x + px, y + py, size, size);
    }
  }

  private paintRoad(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const map = this.map as CityMap;
    const i = ty * map.widthTiles + tx;
    ctx.fillStyle = palette.road;
    ctx.fillRect(x, y, TD, TD);

    // Asphalt grain plus the occasional resurfacing patch.
    this.speckle(ctx, tx, ty, x, y, palette.roadDark, 5, 2, 3);
    this.speckle(ctx, tx, ty, x, y, palette.roadLight, 3, 1, 9);
    if (hash2(tx, ty, 41) > 0.9) {
      ctx.fillStyle = palette.roadPatch;
      const w = 6 + Math.floor(hash2(tx, ty, 42) * 12);
      const h = 5 + Math.floor(hash2(tx, ty, 43) * 10);
      ctx.fillRect(x + 4, y + 5, w, h);
    }
    if (hash2(tx, ty, 55) > 0.955) {
      ctx.fillStyle = palette.manhole;
      ctx.beginPath();
      ctx.arc(x + TD / 2, y + TD / 2, 4 * RENDER_SCALE, 0, Math.PI * 2);
      ctx.fill();
    }

    // A tile under a stroked course gets its marks from the ribbon: the
    // per-tile paint underneath is the staircase the ribbon exists to
    // replace, and two centre lines disagreeing about where the road runs
    // is worse than either alone. Base asphalt above still paints — the
    // rasterised band overhangs the stroke by up to half a tile.
    if (this.courseCover !== null && this.courseCover[i] === 1) return;

    const hLen = this.runH[i] as number;
    const vLen = this.runV[i] as number;
    const horizontal = hLen >= RUN_ROAD;
    const vertical = vLen >= RUN_ROAD;
    if (horizontal && vertical) return; // junction: bare asphalt

    if (horizontal) this.paintLaneMarks(ctx, tx, ty, x, y, vLen, this.idxV[i] as number, false);
    else if (vertical) this.paintLaneMarks(ctx, tx, ty, x, y, hLen, this.idxH[i] as number, true);
    else {
      // Short both ways: a stair step of a carved diagonal band — the ring
      // road, mostly. These used to fall through bare, so every curved
      // arterial read as unpainted tarmac beside fully-marked grid streets.
      // The shared direction field says which way the band runs and which
      // tiles carry its centre line; edge lines and zebras stay off here,
      // because paint following a stair-stepped kerb reads as debris.
      const dir = diagonalMark(this.isRoadAt, tx, ty);
      if (dir) this.paintDiagonalCentre(ctx, tx, ty, x, y, dir);
    }
  }

  /** `IsRoad` for the shared mark helpers, bound once so it can be passed. */
  private readonly isRoadAt = (tx: number, ty: number): boolean => this.tileAt(tx, ty) === T_ROAD;

  /**
   * The diagonal centre line: dashes along the band's 45° direction, through
   * the middle of the tile the shared rule named.
   *
   * Drawn as a run of `t`-square dots stepping one device pixel diagonally —
   * a 45° line one world pixel wide, on the pixel grid. The dash cadence is
   * measured along the band in WORLD coordinates (`(x ± y) / 2`), so dashes
   * continue seamlessly from tile to tile and the 3D shader can (and does)
   * compute the identical phase from its own world position.
   */
  private paintDiagonalCentre(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    dir: DiagonalDir,
  ): void {
    const t = RENDER_SCALE; // 1 world px
    ctx.fillStyle = palette.roadLane;
    const half = TILE_SIZE / 2; // dash period is half a tile, as on the grid
    for (let i = 0; i < TD; i++) {
      const py = dir === 'se' ? i : TD - 1 - i;
      // Along-band coordinate in world px, from the device pixel's world pos.
      const wx = tx * TILE_SIZE + i / RENDER_SCALE;
      const wy = ty * TILE_SIZE + py / RENDER_SCALE;
      const along = dir === 'se' ? (wx + wy) / 2 : (wx - wy) / 2;
      // Same phase as the cardinal dashes: on for [0.125, 0.375) of each
      // half-tile period, twice per tile.
      const phase = (((along / half - 0.25) % 1) + 1) % 1;
      if (phase >= 0.5) continue;
      ctx.fillRect(x + i - t / 2, y + py - t / 2, t, t);
    }
  }

  /**
   * Lane furniture for one carriageway tile: dashed centre line at the midpoint
   * of the run, solid edge lines at its outsides, and a stop line + zebra where
   * the road runs into a junction.
   */
  private paintLaneMarks(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    width: number,
    index: number,
    vertical: boolean,
  ): void {
    const t = RENDER_SCALE; // 1 world px

    // Nothing the plan can draw is wider than a carriageway
    // (`MAX_CARRIAGEWAY` = ARTERIAL_WIDTH), so a wider cross-run means this
    // "street" is really a shallow stretch of a curved arterial's diagonal
    // band. Lane furniture there is noise: fragments of centre line and edge
    // line strewn along the stair steps.
    if (width > ARTERIAL_WIDTH) return;

    // Centre line: dashes along the direction of travel, down the true middle
    // of the carriageway. See `laneCentreInTile`.
    const centreInTile = laneCentreInTile(width, index);
    if (centreInTile !== null) {
      ctx.fillStyle = palette.roadLane;
      // Whole device pixel, kept inside this tile — see `laneDashOffset`.
      const at = laneDashOffset(centreInTile, TD, t);
      const dashes = 2;
      const dashLen = TD / (dashes * 2);
      for (let d = 0; d < dashes; d++) {
        const off = d * dashLen * 2 + dashLen / 2;
        if (vertical) ctx.fillRect(x + at, y + off, t, dashLen);
        else ctx.fillRect(x + off, y + at, dashLen, t);
      }
    }
    // Edge lines, held one pixel off the kerb.
    if (index === 0 || index === width - 1) {
      ctx.fillStyle = palette.roadMark;
      const near = index === 0;
      if (vertical) ctx.fillRect(near ? x + t : x + TD - 2 * t, y, t, TD);
      else ctx.fillRect(x, near ? y + t : y + TD - 2 * t, TD, t);
    }

    // A deck is not a crossroads: `paintBridge` routes deck tiles through
    // these carriageway rules for the centre line, which brought the
    // stop-line and zebra along and painted a crossing onto the strait
    // bridge's mouth (REVIEW-WORLDGEN.md §2.3). Pedestrians cross streets,
    // not spans.
    if (this.tileAt(tx, ty) === T_BRIDGE) return;

    // Stop line + zebra on the last tile before a junction — but only where a
    // MAIN road meets it.
    //
    // Marking every arm of every junction was the default, and at this city's
    // block density it covered the place: 2589 of 16951 road tiles carried a
    // crossing, so on a short block the striping ran from one junction
    // straight into the next and the streets read as painted rather than
    // paved. Real cities put crossings on main roads. `width` is the
    // carriageway width, so four tiles or more is an arterial.
    const ahead = vertical ? this.junctionAt(tx, ty + 1) || this.junctionAt(tx, ty - 1) : this.junctionAt(tx + 1, ty) || this.junctionAt(tx - 1, ty);
    if (!ahead || width < ARTERIAL_WIDTH) return;
    const forward = vertical ? this.junctionAt(tx, ty + 1) : this.junctionAt(tx + 1, ty);
    // ...and only at a real crossroads: the same street resuming on the far
    // side of the junction. Where a street merges into a curved arterial's
    // diagonal band the tarmac widens into a pocket that passes the junction
    // test, and a zebra painted into the mouth of the ring road at every
    // stair step was a good part of why it read as broken.
    if (!this.streetResumesBeyond(tx, ty, vertical, forward ? 1 : -1)) return;
    // ...and only where two COURSES actually cross (§35).
    //
    // `junctionAt` reads the tile plane, so a merged sheet of carriageway is
    // "junction" across its whole area and every tile of it painted its own
    // crossing: four to seven zebras stacked back to back in open tarmac with
    // no kerb at either end. The filters above were added to stop exactly
    // that and could not, because they ask the same raster the same way. A
    // junction is where two centrelines meet, and §26 already computes that
    // from the curves — so ask it.
    if (!this.nearJunction(tx, ty, 2)) return;

    // A stop line holds the traffic going INTO the junction, so it covers that
    // half of the carriageway and stops at the centre line. Painted across the
    // full width — which is what it used to do — it told drivers coming the
    // other way to stop at a junction they were leaving.
    //
    // `index` counts from the low edge of the run, so the approaching half is
    // the one this direction's traffic keeps to: driving on the right, that is
    // the low side heading south or west and the high side heading north or
    // east. Only the direction with the junction in front of it is marked.
    const dirIdx = vertical ? (forward ? 1 : 3) : forward ? 0 : 2;
    const onHighSide = (RIGHT_SIGN[dirIdx] as number) > 0;
    const approaching = onHighSide ? index >= width / 2 : index < width / 2;
    if (approaching) {
      ctx.fillStyle = palette.roadStop;
      if (vertical) ctx.fillRect(x, forward ? y + TD - 3 * t : y + t, TD, 2 * t);
      else ctx.fillRect(forward ? x + TD - 3 * t : x + t, y, 2 * t, TD);
    }

    // Zebra: stripes spaced to fill exactly one tile, whatever TILE_SIZE is.
    ctx.fillStyle = palette.roadCrossing;
    const stripes = 3;
    const pitch = TD / stripes;
    const bar = Math.max(2, Math.round(pitch * 0.45));
    for (let s = 0; s < stripes; s++) {
      const off = Math.round(s * pitch + (pitch - bar) / 2);
      if (vertical) ctx.fillRect(x + off, forward ? y + TD - 9 * t : y + 4 * t, bar, 5 * t);
      else ctx.fillRect(forward ? x + TD - 9 * t : x + 4 * t, y + off, 5 * t, bar);
    }
  }

  /** Is this tile inside a course-crossing disc, plus `pad` tiles? */
  private nearJunction(tx: number, ty: number, pad: number): boolean {
    for (const j of this.junctionDiscs) {
      const r = j.r + pad;
      const dx = tx + 0.5 - j.x;
      const dy = ty + 0.5 - j.y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  /**
   * Does this street continue on the far side of the junction it runs into?
   *
   * Walks across the junction tiles (up to 8) and asks whether what is beyond
   * them is a carriageway of the same orientation. True at a crossroads;
   * false where the "junction" is really the mouth of a diagonal band, which
   * has no crossing street and deserves no zebra.
   */
  private streetResumesBeyond(tx: number, ty: number, vertical: boolean, side: number): boolean {
    const map = this.map as CityMap;
    let x = tx + (vertical ? 0 : side);
    let y = ty + (vertical ? side : 0);
    for (let step = 0; step < 8 && this.junctionAt(x, y); step++) {
      x += vertical ? 0 : side;
      y += vertical ? side : 0;
    }
    if (x < 0 || y < 0 || x >= map.widthTiles || y >= map.heightTiles) return false;
    const i = y * map.widthTiles + x;
    if (map.tiles[i] !== T_ROAD || this.junctionAt(x, y)) return false;
    const hLen = this.runH[i] as number;
    const vLen = this.runV[i] as number;
    return vertical ? vLen >= RUN_ROAD && hLen < RUN_ROAD : hLen >= RUN_ROAD && vLen < RUN_ROAD;
  }

  private junctionAt(tx: number, ty: number): boolean {
    const map = this.map as CityMap;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
    const i = ty * map.widthTiles + tx;
    if (map.tiles[i] !== T_ROAD) return false;
    return (this.runH[i] as number) >= RUN_ROAD && (this.runV[i] as number) >= RUN_ROAD;
  }

  private paintSidewalk(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const district = this.districtOf(tx, ty);
    const tint =
      (palette.sidewalkTint as Record<string, string>)[district] ?? palette.sidewalk;
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, TD, TD);

    // Paving slabs: two joints each way, with the joint colour reading as a
    // recess rather than a drawn line.
    ctx.fillStyle = shade(tint, 0.3);
    const half = TD / 2;
    ctx.fillRect(x, y + half - 1, TD, 1);
    ctx.fillRect(x + half - 1, y, 1, TD);
    ctx.fillStyle = shade(tint, 0.25, '#ffffff');
    ctx.fillRect(x, y + half, TD, 1);
    ctx.fillRect(x + half, y, 1, TD);
    this.speckle(ctx, tx, ty, x, y, shade(tint, 0.14), 4, 1, 7);

    // Grime along the wall. A pavement gets swept in the middle and never at
    // the edges, so the foot of a building is always the dirtiest strip of it.
    //
    // Cheap, and it does a job out of proportion to its cost in 3D: the wall
    // meets the ground on a perfectly clean line there, which is one of the
    // things that reads as a model rather than a street. A gradient of dirt
    // running up to it puts the two surfaces in the same world.
    const t = RENDER_SCALE;
    const grime = shade(tint, 0.22);
    const band = 3 * t;
    for (const [dx, dy] of DIRS) {
      if (this.tileAt(tx + dx, ty + dy) !== T_BUILDING) continue;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = grime;
      if (dy !== 0) ctx.fillRect(x, dy < 0 ? y : y + TD - band, TD, band);
      else ctx.fillRect(dx < 0 ? x : x + TD - band, y, band, TD);
      ctx.globalAlpha = 1;
    }

    // A service cover, now and then. The carriageway has had manholes all
    // along; the footway they actually run under had nothing.
    if (hash2(tx, ty, 83) > 0.955) {
      const s = 4 * t;
      const ox = x + Math.round(TD / 2 - s / 2);
      const oy = y + Math.round(TD / 2 - s / 2);
      ctx.fillStyle = palette.manhole;
      ctx.fillRect(ox, oy, s, s);
      ctx.fillStyle = shade(palette.manhole, 0.3, '#ffffff');
      ctx.fillRect(ox, oy, s, t);
    }

    // Kerb on every edge that meets the road.
    const edges: Array<[number, number, number, number, number, number]> = [
      [0, -1, x, y, TD, 2 * t],
      [0, 1, x, y + TD - 2 * t, TD, 2 * t],
      [-1, 0, x, y, 2 * t, TD],
      [1, 0, x + TD - 2 * t, y, 2 * t, TD],
    ];
    for (const [dx, dy, rx, ry, rw, rh] of edges) {
      if (this.tileAt(tx + dx, ty + dy) !== T_ROAD) continue;
      ctx.fillStyle = palette.kerb;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = palette.kerbShade;
      if (dy !== 0) ctx.fillRect(rx, dy < 0 ? ry : ry + rh - t, rw, t);
      else ctx.fillRect(dx < 0 ? rx : rx + rw - t, ry, t, rh);

      // A gully every so often, set into the footway against the kerb — which
      // is where one goes. Drawn ON the kerb instead, as the first cut did, it
      // reads as the kerb being broken into dashes rather than as a drain.
      //
      // Salted per edge so a corner tile does not get two at once by chance.
      if (hash2(tx * 2 + dx, ty * 2 + dy, 89) <= 0.86) continue;
      const len = 6 * t;
      const deep = 2 * t;
      // Step in off the kerb, on whichever side of the tile this edge is.
      const gx = dy !== 0 ? x + Math.round(TD / 2 - len / 2) : dx < 0 ? rx + rw : rx - deep;
      const gy = dy !== 0 ? (dy < 0 ? ry + rh : ry - deep) : y + Math.round(TD / 2 - len / 2);
      const gw = dy !== 0 ? len : deep;
      const gh = dy !== 0 ? deep : len;
      ctx.fillStyle = palette.manhole;
      ctx.fillRect(gx, gy, gw, gh);
      // Bars across it, so it reads as a grating rather than a smudge. Lighter
      // than the casting, because the metal catches the light and the gaps
      // between the bars do not — a grating that is dark bars on a light field
      // is a hole with a ladder over it.
      ctx.fillStyle = shade(palette.kerb, 0.25);
      for (let s = 1; s < 3; s++) {
        if (dy !== 0) ctx.fillRect(gx + Math.round((s * len) / 3), gy, t, gh);
        else ctx.fillRect(gx, gy + Math.round((s * len) / 3), gw, t);
      }
    }
  }

  private paintGrass(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    base: string,
    light: string,
    lush: boolean,
    plants = true,
  ): void {
    ctx.fillStyle = base;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, light, lush ? 14 : 7, 2, 11);
    this.speckle(ctx, tx, ty, x, y, shade(base, 0.25), lush ? 8 : 4, 2, 13);
    if (!lush || !plants) return;

    // Park planting. Bushes are low enough to walk past without reading wrong;
    // trees are kept sparse for the same reason.
    const roll = hash2(tx, ty, 71);
    if (roll > 0.92 && this.sprites.has('tree')) {
      this.sprites.draw(ctx, 'tree', x + TD / 2, y + TD / 2, 0);
    } else if (roll > 0.87 && this.sprites.has('bush')) {
      this.sprites.draw(
        ctx,
        'bush',
        x + TD * (0.3 + hash2(tx, ty, 72) * 0.4),
        y + TD * (0.3 + hash2(tx, ty, 73) * 0.4),
        0,
      );
    }
  }

  /**
   * Runway: darker than a lot, with a dashed centreline down its long axis.
   *
   * The markings are what say "you can take off from here" without a HUD
   * prompt, and they are cheap: the ground is baked into chunk canvases once,
   * so paint on it is free forever after.
   */
  private paintRunway(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    ctx.fillStyle = palette.runway;
    ctx.fillRect(x, y, TD, TD);
    // Speckle, so a long strip of it does not read as a printed rectangle.
    const n = hash2(tx, ty, 0x51f7);
    if (n > 0.72) {
      ctx.fillStyle = palette.runwayLight;
      // Whole world pixels. `n` is a fraction, so the old `n * 9 % 9` was a
      // no-op that left the rect at a fractional coordinate — the one place in
      // the painter off the pixel grid, and canvas antialiases a fractional
      // `fillRect` whatever `imageSmoothingEnabled` says, so every grain was a
      // smear instead of a speck.
      const gx = Math.floor(hash2(tx, ty, 0x51f8) * 9);
      const gy = Math.floor(hash2(tx, ty, 0x51f9) * 11);
      ctx.fillRect(x + gx * RENDER_SCALE, y + gy * RENDER_SCALE, 2 * RENDER_SCALE, 2 * RENDER_SCALE);
    }
    // The centreline runs east-west, matching how the strip is stamped: ONE
    // row per column (`runwayCentreRow` — the old interior-row test drew a
    // line on every row of the strip), every other column, so it dashes.
    const map = this.map;
    if (!map) return;
    if (runwayCentreRow((ax, ay) => this.tileAt(ax, ay), tx, ty) && tx % 2 === 0) {
      ctx.fillStyle = palette.runwayLine;
      ctx.fillRect(x, y + TD / 2 - RENDER_SCALE, TD, 2 * RENDER_SCALE);
    }
  }

  private paintLot(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    ctx.fillStyle = palette.lot;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, palette.gravel, 8, 2, 17);
    this.speckle(ctx, tx, ty, x, y, shade(palette.lot, 0.18, '#ffffff'), 4, 1, 19);
    // Parking bays — only where something actually parks (`indexParking`).
    // Striping every third column of every lot painted the whole city's
    // yards, aprons and quarry floors as car parks.
    const map = this.map;
    if (map && this.parkingTiles.has(ty * map.widthTiles + tx)) {
      ctx.fillStyle = palette.lotStripe;
      ctx.fillRect(x + 2 * RENDER_SCALE, y + 2 * RENDER_SCALE, RENDER_SCALE, TD - 4 * RENDER_SCALE);
    }
    // No barrels here any more. They used to be painted into the cached tile
    // layer as scenery, with nothing behind them; they are real props now
    // (K2), streamed like every other prop and drawn by the renderer, and
    // painting a second set here would put an undamageable twin beside every
    // one you can shoot.
    if (hash2(tx, ty, 24) > 0.95 && this.sprites.has('crate')) {
      this.sprites.draw(ctx, 'crate', x + TD * 0.4, y + TD * 0.6, 0);
    }
  }

  // ── buildings ──────────────────────────────────────────────────────────────

  /**
   * Cast shadows for every building overlapping this chunk. Painted opaque into
   * a scratch canvas first, with the buildings themselves punched back out, so
   * neighbouring tiles cannot stack alpha into a dark seam.
   */
  private paintBuildingShadows(
    ctx: CanvasRenderingContext2D,
    tx0: number,
    ty0: number,
  ): void {
    const scratch = document.createElement('canvas');
    scratch.width = CHUNK_DEVICE;
    scratch.height = CHUNK_DEVICE;
    const sctx = scratch.getContext('2d') as CanvasRenderingContext2D;
    const dx = SHADOW_DEPTH * SUN_X * RENDER_SCALE;
    const dy = SHADOW_DEPTH * SUN_Y * RENDER_SCALE;

    // A building that faces a street casts a shadow of the mass that is
    // DRAWN, not of the tiles it is bookkept as (§20). Without this the
    // rotated block stands on a square shadow, which reads as a second
    // building underneath it lying the old way round.
    const map = this.map;
    const massed = new Set<number>();
    const rotated: Array<Array<[number, number]>> = [];
    for (const b of map?.buildings ?? []) {
      if ((b.angle ?? 0) === 0) continue;
      if (b.x + b.w < tx0 - 2 || b.x > tx0 + CHUNK_TILES + 1) continue;
      if (b.y + b.h < ty0 - 2 || b.y > ty0 + CHUNK_TILES + 1) continue;
      let solid = true;
      for (let ty = b.y; ty < b.y + b.h && solid; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          if (this.tileAt(tx, ty) !== T_BUILDING) {
            solid = false;
            break;
          }
        }
      }
      if (!solid) continue;
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) massed.add(ty * (map as CityMap).widthTiles + tx);
      }
      rotated.push(
        buildingCorners(b).map(([cx, cy]) => [(cx - tx0) * TD, (cy - ty0) * TD] as [number, number]),
      );
    }
    const poly = (pts: Array<[number, number]>, ox: number, oy: number): void => {
      sctx.beginPath();
      sctx.moveTo((pts[0] as [number, number])[0] + ox, (pts[0] as [number, number])[1] + oy);
      for (let i = 1; i < pts.length; i++) {
        sctx.lineTo((pts[i] as [number, number])[0] + ox, (pts[i] as [number, number])[1] + oy);
      }
      sctx.closePath();
      sctx.fill();
    };
    const plain = (tx: number, ty: number): boolean =>
      this.tileAt(tx, ty) === T_BUILDING &&
      !massed.has(ty * ((map as CityMap).widthTiles ?? 1) + tx);

    sctx.fillStyle = palette.shadow;
    let any = rotated.length > 0;
    for (const pts of rotated) poly(pts, dx, dy);
    for (let ty = ty0 - 2; ty <= ty0 + CHUNK_TILES + 1; ty++) {
      for (let tx = tx0 - 2; tx <= tx0 + CHUNK_TILES + 1; tx++) {
        if (!plain(tx, ty)) continue;
        any = true;
        sctx.fillRect((tx - tx0) * TD + dx, (ty - ty0) * TD + dy, TD, TD);
      }
    }
    if (!any) return;

    sctx.globalCompositeOperation = 'destination-out';
    for (const pts of rotated) poly(pts, 0, 0);
    for (let ty = ty0 - 2; ty <= ty0 + CHUNK_TILES + 1; ty++) {
      for (let tx = tx0 - 2; tx <= tx0 + CHUNK_TILES + 1; tx++) {
        if (!plain(tx, ty)) continue;
        sctx.fillRect((tx - tx0) * TD, (ty - ty0) * TD, TD, TD);
      }
    }

    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  /**
   * The ground a building stands ON, painted under it.
   *
   * The square city never needed this: a roof covered its own footprint
   * exactly, so what was underneath was never seen and both chunk builders
   * left it as a flat fill. A rotated mass does not cover its footprint —
   * that is the whole point of it — and the corners it vacates showed the
   * flat fill as dark squares lying the old way round, which read as a second
   * building underneath the first.
   *
   * Painted for EVERY building tile rather than only the turned ones: the
   * square case is covered by its own roof a moment later, so it costs a fill
   * nobody sees and saves a branch that could disagree with the mass painter
   * about which buildings are turned.
   */
  private paintPlot(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    plants: boolean,
  ): void {
    this.paintGround(ctx, tx, ty, x, y, this.plotGround(tx, ty), plants);
  }

  /**
   * What a building's plot is surfaced with: the nearest tile round it that a
   * building could stand on. Pavement in town, grass in a garden suburb, dirt
   * on a lot — whatever the ground beside the house already is.
   *
   * Both the plot fill and the turned forecourt ask this, so a house cannot
   * end up standing on a square of grass with a rotated slab of pavement laid
   * over it.
   */
  private plotGround(tx: number, ty: number): number {
    let ground = T_SIDEWALK;
    let best = Infinity;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const t = this.tileAt(tx + ox, ty + oy);
        // Not everything a building stands NEAR is something it stands ON.
        // Carriageway, a stunt ramp's chevrons, a runway and the floor of a
        // shop are all surfaces in their own right, and a house whose plot
        // resolved to one of them got a rotated apron of hazard stripes.
        if (!plottable(t)) continue;
        const d = ox * ox + oy * oy;
        if (d < best) {
          best = d;
          ground = t;
        }
      }
    }
    return ground;
  }

  /**
   * The paving a turned building stands on, turned with it.
   *
   * A building's plot is laid in tiles, so its forecourt is a square ring of
   * pavement round a mass that is not square — and a turned house on square
   * paving reads as a house somebody rotated after the fact, which is what it
   * was. This lays the apron the building would actually have: the mass grown
   * by a tile, at the mass's own angle, in the pavement the plot is made of.
   *
   * Clipped to the building's own footprint and the ring of ground beside it,
   * and never over carriageway or water — a doorstep may take a tile of grass
   * and may not take a lane. The mass is drawn on top of this immediately
   * afterwards, so what shows is the margin between them.
   */
  private paintMassApron(
    ctx: CanvasRenderingContext2D,
    m: { b: Building; i: number },
    tx0: number,
    ty0: number,
  ): void {
    const b = m.b;
    const mass = buildingMass(b);
    ctx.save();
    // Only over ground the apron is allowed on: this building's own tiles,
    // and the pavement or garden immediately round them.
    ctx.beginPath();
    for (let ty = b.y - 1; ty <= b.y + b.h; ty++) {
      for (let tx = b.x - 1; tx <= b.x + b.w; tx++) {
        const t = this.tileAt(tx, ty);
        const own = tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h;
        const soft =
          t === T_SIDEWALK || t === T_PARK || t === T_FIELD || t === T_LOT || t === T_BUILDING;
        if (!own && !soft) continue;
        ctx.rect((tx - tx0) * TD, (ty - ty0) * TD, TD, TD);
      }
    }
    ctx.clip();
    ctx.translate((mass.cx - tx0) * TD, (mass.cy - ty0) * TD);
    ctx.rotate(mass.rad);
    // A tile of forecourt all round, and the paving the plot is made of.
    const w = (mass.w + 2) * TD;
    const h = (mass.h + 2) * TD;
    const cx = Math.floor(mass.cx);
    const cy = Math.floor(mass.cy);
    ctx.translate(-w / 2, -h / 2);
    this.paintApronGround(ctx, cx, cy, w, h, this.plotGround(cx, cy));
    ctx.restore();
  }

  /** The apron's surface, tiled across the turned rectangle. */
  private paintApronGround(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    w: number,
    h: number,
    ground: number,
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    // Painted tile by tile in the apron's OWN frame, so the paving slabs run
    // with the building rather than with the world. In the plot's own
    // material, not pavement: a farmhouse's forecourt is the field it stands
    // in, and a slab of city paving under it in the middle of the country was
    // the tell that this pass was guessing. Never with plants — a tree baked
    // into a doorstep is a tree the house is standing on.
    for (let y = 0; y < h; y += TD) {
      for (let x = 0; x < w; x += TD) {
        this.paintGround(ctx, tx + Math.round(x / TD), ty + Math.round(y / TD), x, y, ground, false);
      }
    }
    ctx.restore();
  }

  /**
   * The rotated masses touching a chunk: the buildings that face a street and
   * whose footprint is solid (a shop is a room punched out of one, and a mass
   * over the whole rect would put a lid on it — the same rule
   * `roofCanvasFor` has always applied per tile).
   */
  private massesNear(tx0: number, ty0: number): Array<{ b: Building; i: number }> {
    const map = this.map;
    if (!map) return [];
    const out: Array<{ b: Building; i: number }> = [];
    for (let i = 0; i < map.buildings.length; i++) {
      const b = map.buildings[i] as Building;
      if ((b.angle ?? 0) === 0) continue;
      if (b.x + b.w < tx0 - 2 || b.x > tx0 + CHUNK_TILES + 1) continue;
      if (b.y + b.h < ty0 - 2 || b.y > ty0 + CHUNK_TILES + 1) continue;
      if (massDrawable(b, (tx, ty) => this.tileAt(tx, ty))) out.push({ b, i });
    }
    return out;
  }

  /** The rotated mass's footprint in this chunk's device pixels. */
  private massPoly(b: Building, tx0: number, ty0: number): Array<[number, number]> {
    return buildingCorners(b).map(
      ([cx, cy]) => [(cx - tx0) * TD, (cy - ty0) * TD] as [number, number],
    );
  }

  /**
   * A rotated mass's side, swept sun-away — the hexagon the square painter
   * draws, at the angle the building faces. Built as the two end quads plus a
   * face per edge rather than as a hull, because a hull of eight points is
   * more arithmetic than four fills for the same picture.
   */
  private paintMassWall(
    ctx: CanvasRenderingContext2D,
    m: { b: Building; i: number },
    tx0: number,
    ty0: number,
  ): void {
    const dx = WALL_DEPTH * SUN_X * RENDER_SCALE;
    const dy = WALL_DEPTH * SUN_Y * RENDER_SCALE;
    const poly = this.massPoly(m.b, tx0, ty0);
    ctx.fillStyle = shade(this.roofColorOf(m.b), 0.55, palette.wallShade);
    const fill = (ox: number, oy: number): void => {
      ctx.beginPath();
      const p0 = poly[0] as [number, number];
      ctx.moveTo(p0[0] + ox, p0[1] + oy);
      for (let i = 1; i < poly.length; i++) {
        const p = poly[i] as [number, number];
        ctx.lineTo(p[0] + ox, p[1] + oy);
      }
      ctx.closePath();
      ctx.fill();
    };
    fill(0, 0);
    fill(dx, dy);
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as [number, number];
      const q = poly[(i + 1) % poly.length] as [number, number];
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.lineTo(q[0] + dx, q[1] + dy);
      ctx.lineTo(p[0] + dx, p[1] + dy);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * A rotated mass's roof: the SAME baked art the square painter makes,
   * turned. Reusing `roofCanvasFor` rather than re-authoring the speckle, the
   * parapets and the clutter against a polygon is what keeps a rotated roof
   * and a square one obviously the same city.
   */
  private paintMassRoof(
    ctx: CanvasRenderingContext2D,
    m: { b: Building; i: number },
    tx0: number,
    ty0: number,
  ): void {
    const canvas = this.roofCanvasFor(m.i);
    const mass = buildingMass(m.b);
    ctx.save();
    ctx.translate((mass.cx - tx0) * TD, (mass.cy - ty0) * TD);
    ctx.rotate(mass.rad);
    const w = mass.w * TD;
    const h = mass.h * TD;
    if (canvas) ctx.drawImage(canvas, -w / 2, -h / 2, w, h);
    else {
      ctx.fillStyle = this.roofColorOf(m.b);
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  /** A building's roof colour — the same one its own tiles are painted. */
  private roofColorOf(b: Building): string {
    return this.roofColor(b.x, b.y);
  }

  /**
   * The side of the building, swept from the roof tile towards the sun-away
   * direction. Drawn opaque for every building tile; interior walls are then
   * covered by neighbouring roofs, leaving only the exposed faces visible.
   */
  private paintWall(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const dx = WALL_DEPTH * SUN_X * RENDER_SCALE;
    const dy = WALL_DEPTH * SUN_Y * RENDER_SCALE;
    const roof = this.roofColor(tx, ty);

    ctx.fillStyle = shade(roof, 0.55, palette.wallShade);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + TD, y);
    ctx.lineTo(x + TD + dx, y + dy);
    ctx.lineTo(x + TD + dx, y + dy + TD);
    ctx.lineTo(x + dx, y + dy + TD);
    ctx.lineTo(x, y + TD);
    ctx.closePath();
    ctx.fill();
  }

  private paintRoof(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const roof = this.roofColor(tx, ty);
    ctx.fillStyle = roof;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, shade(roof, 0.12), 6, 2, 31);
    this.speckle(ctx, tx, ty, x, y, shade(roof, 0.1, '#ffffff'), 4, 1, 33);

    // Parapet: bright along the sun-facing edges, dark along the others. This
    // is what makes a block of roof tiles read as one solid mass.
    const t = 2 * RENDER_SCALE;
    const openN = this.tileAt(tx, ty - 1) !== T_BUILDING;
    const openW = this.tileAt(tx - 1, ty) !== T_BUILDING;
    const openS = this.tileAt(tx, ty + 1) !== T_BUILDING;
    const openE = this.tileAt(tx + 1, ty) !== T_BUILDING;
    ctx.fillStyle = shade(roof, 0.4, palette.roofEdgeLight);
    if (openN) ctx.fillRect(x, y, TD, t);
    if (openW) ctx.fillRect(x, y, t, TD);
    ctx.fillStyle = shade(roof, 0.3);
    if (openS) ctx.fillRect(x, y + TD - t, TD, t);
    if (openE) ctx.fillRect(x + TD - t, y, t, TD);

    // Rooftop clutter, only where there is room for it.
    if (openN || openS || openE || openW) return;
    const roll = hash2(tx, ty, 61);
    const s = RENDER_SCALE;
    if (roll > 0.86) {
      ctx.fillStyle = palette.roofUnit;
      ctx.fillRect(x + 4 * s, y + 4 * s, 8 * s, 6 * s);
      ctx.fillStyle = shade(palette.roofUnit, 0.35);
      ctx.fillRect(x + 4 * s, y + 9 * s, 8 * s, s);
    } else if (roll > 0.74) {
      ctx.fillStyle = palette.roofVent;
      ctx.fillRect(x + 6 * s, y + 6 * s, 4 * s, 4 * s);
    } else if (roll > 0.68) {
      ctx.fillStyle = palette.roofHatch;
      ctx.fillRect(x + 5 * s, y + 5 * s, 6 * s, 5 * s);
    }
  }

  /**
   * Shop fronts: awning over the doorway plus a lit sign board on the building
   * above it. Static, so it belongs in the chunk rather than the frame loop —
   * the old renderer walked every shop in the city on every frame.
   */
  private paintShops(ctx: CanvasRenderingContext2D, tx0: number, ty0: number): void {
    const map = this.map as CityMap;
    for (const shop of map.shops) {
      if (
        shop.doorX < tx0 - 2 ||
        shop.doorY < ty0 - 2 ||
        shop.doorX > tx0 + CHUNK_TILES + 1 ||
        shop.doorY > ty0 + CHUNK_TILES + 1
      ) {
        continue;
      }
      const x = (shop.doorX - tx0) * TD;
      const y = (shop.doorY - ty0) * TD;
      const accent =
        shop.kind === 'depot'
          ? DEPOT_ACCENT
          : shop.kind === 'gun'
            ? palette.shopGun
            : palette.shopClothing;
      const s = RENDER_SCALE;

      ctx.fillStyle = shade(accent, 0.45);
      ctx.fillRect(x + 2 * s, y + 2 * s, TD - 4 * s, TD - 4 * s);
      ctx.fillStyle = accent;
      ctx.fillRect(x + 2 * s, y + 2 * s, TD - 4 * s, 3 * s);
      ctx.fillStyle = shade(accent, 0.25, '#ffffff');
      ctx.fillRect(x + 3 * s, y + 3 * s, TD - 6 * s, s);

      // Doormat stripes, so the interaction zone is legible at a glance.
      ctx.fillStyle = shade(accent, 0.6, '#ffffff');
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(x + (5 + i * 3) * s, y + 8 * s, 2 * s, 5 * s);
      }
    }
  }
}
