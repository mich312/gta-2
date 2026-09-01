import * as THREE from 'three';
import {
  BRIDGE_DECK_THICKNESS,
  RAMP_Z,
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FIELD,
  T_FLOOR,
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
  type Building,
  type CityMap,
  buildingMass,
  buildingStoreys,
  Z_PER_STOREY,
  type Span,
  EARTH,
  districtAt,
  buildVolumeGrid,
  spansAt,
  diagonalMark,
  laneCentreInTile,
  BEV_NE,
  BEV_SE,
  BEV_SW,
  TREE_Z,
  bevelOther,
  chainSide,
  shoreHalf,
  shoreChains,
  buildDeckCut,
  oppositeHalf,
} from 'shared';
import palette from 'shared/data/palette.json';
import { hash2 } from '../render/noise.js';
import { Z_SCALE } from '../render/config.js';
import { ARTERIAL_WIDTH, RUN_ROAD, runwayCentreRow } from '../render/tiles.js';
import { addOutline, outlineMaterial, toonGradient, toonMaterial } from './toon.js';
import { facadeMaterial, groundMaterial, roadMaterial } from './facade.js';

/**
 * The city, as instanced geometry, from a map.
 *
 * Its own module, and a plain function rather than a method, because the city
 * is **rebuilt** and not only built: with ROAM on, the session recentres its
 * window whenever a player nears the edge and the whole map is regenerated
 * underneath the game. Something that happens more than once needs a seam it
 * can be torn off at, and a function that takes a map and returns a group is
 * that seam. It also means the thing can be tested in node, which a method on
 * a class that owns a `WebGLRenderer` cannot be.
 *
 * Built from the **volume grid**, so the thing the collision will one day
 * resolve against and the thing you look at come from one description of the
 * world — with the one reservation `drawnSpans` exists to record. See there.
 *
 * Everything is instanced. A 240×240 city is ~57,600 columns and rather more
 * spans; as individual meshes that is a five-figure draw count and a dead
 * frame. As a handful of `InstancedMesh`es it is single digits.
 */

/**
 * How much wider than its tile each box is drawn, in world px.
 *
 * Small enough to be invisible — a sixteenth of a world pixel, well under one
 * device pixel at any camera height the game uses — and enough to stop two
 * neighbours sharing an edge exactly.
 */
const SEAM_OVERLAP = 0.06;

/**
 * Tiles per side of a culling chunk.
 *
 * The number trades draw calls against wasted geometry. Smaller chunks reject
 * more of the map but submit more meshes to reject; at 32 the game's own view
 * touches a small fraction of them and the drawn count stays close to what one
 * mesh per material cost, while the geometry that reaches the GPU drops by
 * more than an order of magnitude.
 */
const CHUNK_TILES = 32;

/**
 * Outline weight for building mass, in world px.
 *
 * The hull fattens in world units, so what a weight is worth on screen is
 * `thickness * deviceH / viewHeight` — about one device pixel at 0.5, against
 * 2.8 for a car and 2.0 for a tree. Buildings therefore had no black rim at all
 * while everything standing in front of them was heavily drawn, which is the
 * assets-from-another-game symptom. This puts them nearer the rest of the world.
 *
 * The proper fix is one target weight in device pixels with every thickness
 * derived from it and updated when the view height changes, which wants the
 * outline materials to carry a live uniform. They do not yet.
 */
const BUILDING_OUTLINE = 0.9;

/**
 * Is this tile part of a carriageway, for the purpose of markings?
 *
 * A bridge is: it is the same street, and the 2D `paintBridge` starts by
 * calling `paintRoad` for exactly that reason. A **runway** is not, and used
 * to be — it was in this test, so the centre-line rule painted a dashed road
 * marking down the one surface an aeroplane can take off from. A runway has
 * its own line, its own colour and its own cadence; see `runwayMark`.
 */
export function isCarriageway(tile: number): boolean {
  return tile === T_ROAD || tile === T_BRIDGE;
}

/**
 * What to DRAW for a column, which is not always what `volume.ts` models.
 *
 * `volume.ts` and `collide3.ts` describe the city the 3D collision will
 * resolve against once the simulation adopts them: a bridge deck 40 px up
 * with a river underneath, a ramp you climb. **Nothing in the simulation uses
 * either of them yet.** `step()` still collides on the flat tile grid, and
 * `integrateVehicle` pins every land vehicle to `z = 0` — so a car crossing a
 * bridge is at street level, and a car crossing a ramp is at street level with
 * a `vz` kick from `frenzy.ts` rather than a climb.
 *
 * Drawing the volume grid literally therefore built a city the game was not
 * being played in: the deck stood 46 px above the road that fed it, with no
 * approach and no ramp tile anywhere beside it, and traffic drove straight
 * underneath its own bridge and disappeared for the length of the span.
 *
 * So every surface the simulation walks on at zero is drawn at zero.
 * Everything else — buildings, canopy, the water — is solid or unreachable,
 * and its volume is exactly what you should see.
 *
 * This function is the whole of the reconciliation, deliberately: when the sim
 * does adopt `collide3`, deleting it is the change.
 */
export function drawnSpans(tile: number, spans: readonly Span[]): readonly Span[] {
  switch (tile) {
    case T_BRIDGE:
      // A deck at road level. It runs down to EARTH like any other ground
      // column rather than being a 6 px slab: the caller clamps the bottom to
      // -16, and a slab left the band between -16 and -6 empty while the
      // river beside it topped out at -8. That 2 px slot ran the length of
      // every span and you could see the sky through it from the parapet.
      //
      // `BRIDGE_DECK_THICKNESS` still means what it says in `volume.ts`,
      // where the collision will read it. It is the drawing that has no use
      // for it while the deck is at street level.
      return [{ bottom: EARTH, top: 0 }];
    case T_SIDEWALK:
      // The pavement is walked on at zero exactly like the road: `peds.ts`
      // paths pedestrians along these tiles, `isSolidTile` does not block
      // them, and every body and prop is placed at z = 0. `volume.ts` gives
      // it a KERB_Z of 3 for the collision that will one day read it, and
      // drawing that literally buried every ped, officer and player to the
      // hips — legs gone, and the outline hull of the sunk half smeared a
      // black halo across the slabs around them.
      return [{ bottom: EARTH, top: 0 }];
    case T_RAMP:
      // Stepped ramps are the same story one twelfth the size. The launch is
      // `frenzy.ts` reading the tile type, not a climb, so the surface a car
      // crosses is the street.
      return [{ bottom: -RAMP_Z, top: 0 }];
    default:
      return spans;
  }
}

export interface CityBuild {
  /** Everything the city is made of, in world coordinates. */
  group: THREE.Group;
  /** How many instances it came to, for the debug overlay. */
  instances: number;
}

/**
 * A growable list of box transforms, six floats each.
 *
 * Every box in the city is a scale and a translation — no rotation anywhere,
 * because a tile is axis-aligned and so is what stands on it. So the transform
 * needs six numbers, not a matrix, and the ten zeroes in between do not need
 * to be stored while the city is being collected.
 *
 * This used to be a `THREE.Matrix4[]` per bucket, which reads better and cost
 * far too much. Each `Matrix4` is a JS object wrapping its own 16-element
 * array; on the 240×240 city that was ~60,000 of them and unremarkable, but
 * this city is 768×768 and comes to 639,193 instances — around 128 MB of
 * short-lived objects, allocated and then thrown away inside the single
 * synchronous task that joins a session. The measured heap peak was 164 MB,
 * which is a tab a phone kills. Six floats in a `Float32Array` is 15 MB, and
 * it goes straight into `instanceMatrix` without a `clone()` per span.
 */
class Boxes {
  /**
   * sx, sy, sz, x, y, z, yaw per instance.
   *
   * The seventh float arrived with §20's rotated building masses. It is zero
   * for everything else in the city and costs a sixth more of a buffer that
   * was fifteen megabytes, which is the cheap end of the trade — the
   * alternative was a second mesh and a second material for the one kind of
   * instance that turns.
   */
  private data = new Float32Array(7 * 256);
  /** How many instances are in it. */
  count = 0;

  push(sx: number, sy: number, sz: number, x: number, y: number, z: number, yaw = 0): void {
    if ((this.count + 1) * 7 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.count++ * 7;
    const d = this.data;
    d[o] = sx;
    d[o + 1] = sy;
    d[o + 2] = sz;
    d[o + 3] = x;
    d[o + 4] = y;
    d[o + 5] = z;
    d[o + 6] = yaw;
  }

  /**
   * Expand into an `InstancedMesh`'s transform buffer.
   *
   * Column-major, and only the cells a scale-rotate-translate about Z
   * touches: three.js hands out a zero-filled `Float32Array` and everything
   * else in an affine transform of this shape is a zero. The unrotated case
   * still writes seven cells and skips the trigonometry, which is every
   * instance in the city bar the buildings that face a street.
   */
  writeTo(mesh: THREE.InstancedMesh): void {
    const a = mesh.instanceMatrix.array as Float32Array;
    const d = this.data;
    for (let i = 0; i < this.count; i++) {
      const o = i * 7;
      const m = i * 16;
      const yaw = d[o + 6] as number;
      if (yaw === 0) {
        a[m] = d[o] as number;
        a[m + 5] = d[o + 1] as number;
      } else {
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        a[m] = (d[o] as number) * c;
        a[m + 1] = (d[o] as number) * s;
        a[m + 4] = -(d[o + 1] as number) * s;
        a[m + 5] = (d[o + 1] as number) * c;
      }
      a[m + 10] = d[o + 2] as number;
      a[m + 12] = d[o + 3] as number;
      a[m + 13] = d[o + 4] as number;
      a[m + 14] = d[o + 5] as number;
      a[m + 15] = 1;
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

function hex(s: string | undefined, fallback: number): number {
  return s === undefined ? fallback : parseInt(s.replace('#', ''), 16);
}

const PAL = palette as unknown as Record<string, string | undefined>;
const col = (name: string, fallback: number): number => hex(PAL[name], fallback);
/** Five per-district pavement colours the 2D painter has always used. */
const PAL_TINT = (palette as unknown as { sidewalkTint?: Record<string, string> }).sidewalkTint ?? {};

/**
 * How a terrain type is surfaced.
 *
 * One entry per tile type, against the palette entries the 2D tile layer
 * already paints with. This used to be six buckets for fourteen types, and
 * the collapse was visible from the pavement: field, parkland and woodland
 * all shared one green, and beach, quay, ramp, shop floor and industrial lot
 * all shared one olive — so a beach rendered as a scrapyard. `palette.json`
 * has had `field`, `park`, `trees`, `sand`, `bank` and `runway` in it the
 * whole time.
 *
 * `road` gets the carriageway marking rules; `runway` gets its own centreline
 * cadence; everything else is a ground surface with a grain and, where the 2D
 * layer slabs it, an edge.
 */
interface Surface {
  key: string;
  color: number;
  /** Carriageway markings and crossings. */
  road?: boolean;
  /** Speckle strength and per-tile edge darkening for `groundMaterial`. */
  grain?: number;
  edge?: number;
  /** Line colour for a marked surface. */
  line?: number;
  /** Outlined and shadow-casting: something that stands up. */
  solid?: boolean;
}

/**
 * Carriageway markings, from the palette the 2D layer paints from.
 *
 * This was `0xd8cf94` where `palette.roadLane` is `#b9b183` — brighter and
 * yellower than the game's own line, on every road in the city, which is a
 * large part of why the 3D street read as a motorway.
 */
const ROAD_LINE = col('roadLane', 0xb9b183);
/** The proving ground's green, matching `DEPOT_ACCENT` in the 2D tile layer. */
const DEPOT_ACCENT = 0x5aa84e;

const SURFACES: Record<number, Surface> = {
  [T_FIELD]: { key: 'field', color: col('field', 0x2b3630), grain: 0.2 },
  [T_ROAD]: { key: 'road', color: col('road', 0x33383f), road: true, line: ROAD_LINE },
  [T_SIDEWALK]: { key: 'pavement', color: col('sidewalk', 0x5f646c), grain: 0.09, edge: 0.1 },
  [T_PARK]: { key: 'park', color: col('park', 0x2f4c33), grain: 0.2 },
  [T_LOT]: { key: 'lot', color: col('lot', 0x45463f), grain: 0.14, edge: 0.06 },
  [T_WATER]: { key: 'water', color: col('water', 0x22384a) },
  // Road-coloured and road-marked: a bridge is the carriageway continuing, and
  // the 2D `paintBridge` starts by calling `paintRoad` for exactly that reason.
  // The rails that tell you it is a bridge are geometry — see `buildKerbs`.
  [T_BRIDGE]: { key: 'road', color: col('road', 0x33383f), road: true, line: ROAD_LINE },
  // Chevrons on concrete, as the 2D painter draws it: `road: true` routes it
  // through `roadMaterial`, and mark 5 is the chevron branch.
  // Chevrons on concrete, as the 2D painter draws it. Not `road: true` — that
  // routes a tile through the junction crossing and centre-line rules, and a
  // ramp is not a carriageway. It only needs the marking material.
  [T_RAMP]: { key: 'ramp', color: col('lot', 0x45463f), line: col('uiAccent', 0xf0c040) },
  [T_FLOOR]: { key: 'floor', color: col('shopFloor', 0x6a6259), grain: 0.06, edge: 0.18 },
  [T_BANK]: { key: 'bank', color: col('bank', 0x77705f), grain: 0.1, edge: 0.1 },
  // Canopy, not lawn. It stands 36 px proud because `volume.ts` makes woodland
  // solid to anything on the ground — which `isSolidTile` agrees with — so the
  // height is right and only the colour was wrong. `SceneryLayer` plants its
  // trees on top of it; before that they were sunk inside it.
  [T_TREES]: { key: 'trees', color: col('trees', 0x22391f), grain: 0.22 },
  [T_SAND]: { key: 'sand', color: col('sand', 0xb0a074), grain: 0.16 },
  [T_RUNWAY]: { key: 'runway', color: col('runway', 0x3a3d42), grain: 0.08 },
};

const DEFAULT_SURFACE: Surface = { key: 'lot', color: col('lot', 0x45463f), grain: 0.14 };

/**
 * A building's colour: the same hash and the same palette variants
 * `TileLayer.roofColor` and `ExtrudeLayer` use, so a block is the colour here
 * that it is in the 2D renderer and switching views does not repaint the city.
 */
function roofColor(map: CityMap, tx: number, ty: number, index: number): number {
  // The district comes off the per-tile grid, as `TileLayer.districtOf` reads
  // it. Taking it from `map.buildings[i].district` instead put 12% of blocks
  // in a different district family altogether — a residential brown block
  // coming out commercial pink.
  const district = districtAt(map, tx, ty) as string;
  const variants =
    (palette.buildingVariants as Record<string, string[]>)[district] ??
    palette.buildingVariants.downtown;
  const id = index + 1;
  // The real `hash2`, not a lookalike.
  //
  // What used to be here claimed to be `hash2` inlined and was a GLSL-style
  // `fract(sin(dot(...)) * 43758.5453)` — a different function entirely, which
  // is why only 16.7% of building tiles agreed with the 2D view of the same
  // seed, against 20% for pure chance. Switching renderers repainted the city
  // and moved the landmarks you navigate by.
  const pick = id > 0 ? hash2(id, id * 7 + 3) : hash2(tx, ty, 91);
  return hex(variants[Math.floor(pick * variants.length) % variants.length] as string, 0x6b6f7a);
}

/**
 * Turn every span into a box, batched by what it is.
 *
 * The ground layers are one shallow slab per tile rather than a deep box —
 * the earth below is `EARTH`-deep and drawing that would waste most of the
 * depth buffer on dirt nobody sees.
 */
export function buildCity(map: CityMap): CityBuild {
  const group = new THREE.Group();
  const __v0 = performance.now();
  const vg = buildVolumeGrid(map);
  (globalThis as never as { __jt: string[] }).__jt?.push(
    `  buildVolumeGrid ${Math.round(performance.now() - __v0)}`,
  );
  const W = map.widthTiles;
  const H = map.heightTiles;
  let instances = 0;

  const tileAt = (tx: number, ty: number): number =>
    tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : (map.tiles[ty * W + tx] as number);

  // Road runs, so a marking can be painted down the middle of a carriageway
  // rather than on every tile edge.
  //
  // A road tile does not know it is a road tile in the middle of a four-lane
  // street; it only knows it is road. The 2D tile layer solves this by
  // measuring the contiguous run through each tile on both axes — on a
  // horizontal road the VERTICAL run is the carriageway width, so its midpoint
  // is the centre line. Same measurement here, so the markings land in the same
  // places in both renderers.
  //
  // A bridge counts, because it is the same street; a runway does not. See
  // `isCarriageway`.
  const isRoad = (tx: number, ty: number): boolean => isCarriageway(tileAt(tx, ty));
  /** Carriageway width and length through a tile, both axes. */
  const runs = (tx: number, ty: number): [number, number] => {
    let up = 0;
    let down = 0;
    let left = 0;
    let right = 0;
    while (isRoad(tx, ty - up - 1) && up < 12) up++;
    while (isRoad(tx, ty + down + 1) && down < 12) down++;
    while (isRoad(tx - left - 1, ty) && left < 12) left++;
    while (isRoad(tx + right + 1, ty) && right < 12) right++;
    return [up + down + 1, left + right + 1];
  };
  /**
   * Wide both ways: where two streets actually meet.
   *
   * `RUN_ROAD` is the 2D painter's own threshold, imported rather than
   * approximated. The two renderers using different numbers here is how the
   * 3D city grew crossings the 2D one never painted.
   */
  const isJunction = (tx: number, ty: number): boolean => {
    if (!isRoad(tx, ty)) return false;
    const [runV, runH] = runs(tx, ty);
    return runV >= RUN_ROAD && runH >= RUN_ROAD;
  };
  /**
   * Crossings, on the road tiles that approach a junction.
   *
   * Returns 1 for stripes across an east-west street, 2 across a north-south
   * one. Anchored to junctions rather than to kerbs: every kerbside tile
   * touches a pavement, so a kerb test would stripe the whole length of every
   * street instead of its mouth.
   */
  const crossing = (tx: number, ty: number): number => {
    if (!isRoad(tx, ty) || isJunction(tx, ty)) return 0;
    // A deck is not a crossroads: `isCarriageway` counts T_BRIDGE (it must,
    // for the centre line to carry over), which brought the crossing rule
    // onto the deck and stamped a zebra at the strait bridge's mouth
    // (REVIEW-WORLDGEN.md §2.3). Pedestrians cross streets, not spans. Same
    // guard as the 2D painter's, kept in step by cityTerrain.test.ts.
    if (tileAt(tx, ty) === T_BRIDGE) return 0;
    // Only where a MAIN road meets the junction.
    //
    // Marking every arm was the default, and at this city's block density it
    // covered the place — 2,239 of 15,249 road tiles carried a crossing, so on
    // a short block the striping ran from one junction straight into the next
    // and the streets read as painted rather than paved. The 2D painter came
    // to the same conclusion and gates on `ARTERIAL_WIDTH`; this did not, so
    // the loudest texture in the 3D frame was a divergence rather than a
    // decision.
    //
    // The width that matters is the one ACROSS the direction of travel: for a
    // crossing whose junction lies east or west the street runs horizontally,
    // so its carriageway width is the vertical run.
    //
    // A crossing belongs on an AXIS carriageway only — long one way, narrow
    // the other, the same `RUN_ROAD` test the 2D painter uses. The city's
    // curved arterials rasterise to stair-stepped diagonal bands whose tiles
    // are moderately wide both ways; each stair corner passed the old
    // junction test and stamped a zebra, so the whole ring road came out
    // striped with phantom crossings at every step of the stairs.
    // ...and only where the street CONTINUES on the far side. Where a street
    // merges into the ring road's diagonal band, the tarmac widens into a
    // pocket that passes the junction test, but there is no crossing street —
    // walking on across the pocket finds more band, not the same street
    // resuming. A zebra belongs at a crossroads, and a crossroads is a
    // junction with your own street on both sides of it.
    const continues = (sx: number, sy: number, horiz: boolean): boolean => {
      let x = tx + sx;
      let y = ty + sy;
      for (let step = 0; step < 8 && isJunction(x, y); step++) {
        x += sx;
        y += sy;
      }
      if (!isRoad(x, y) || isJunction(x, y)) return false;
      const [rv, rh] = runs(x, y);
      return horiz ? rh >= RUN_ROAD && rv < RUN_ROAD : rv >= RUN_ROAD && rh < RUN_ROAD;
    };
    const [runV, runH] = runs(tx, ty);
    const horizontal = runH >= RUN_ROAD;
    const vertical = runV >= RUN_ROAD;
    if (horizontal === vertical) return 0; // junction interior, or a diagonal band
    if (horizontal && (isJunction(tx - 1, ty) || isJunction(tx + 1, ty))) {
      const side = isJunction(tx + 1, ty) ? 1 : -1;
      return runV >= ARTERIAL_WIDTH && continues(side, 0, true) ? 1 : 0;
    }
    if (vertical && (isJunction(tx, ty - 1) || isJunction(tx, ty + 1))) {
      const side = isJunction(tx, ty + 1) ? 1 : -1;
      return runH >= ARTERIAL_WIDTH && continues(0, side, false) ? 2 : 0;
    }
    return 0;
  };
  /**
   * 0 plain; 1 centre line along x, 2 along y (mid-tile); 6 along x, 7 along
   * y at the tile's FAR edge; 8 diagonal up-right, 9 diagonal down-right.
   *
   * The which-tile and where-in-tile answers both come from the shared rule
   * (`laneCentreInTile`, `diagonalMark`) rather than a local rewrite. The
   * local rewrite is exactly how the two renderers came to disagree: its
   * even-width case marked the same tile but drew mid-tile, half a lane from
   * where the 2D painter (and the sim's `laneOptions`) put the centre — on
   * every four-tile arterial in the city, jumping sideways whenever a painted
   * ground chunk replaced this shader's fallback.
   */
  const roadMark = (tx: number, ty: number): number => {
    if (!isRoad(tx, ty)) return 0;
    let up = 0;
    let down = 0;
    let left = 0;
    let right = 0;
    while (isRoad(tx, ty - up - 1) && up < 12) up++;
    while (isRoad(tx, ty + down + 1) && down < 12) down++;
    while (isRoad(tx - left - 1, ty) && left < 12) left++;
    while (isRoad(tx + right + 1, ty) && right < 12) right++;
    const runV = up + down + 1;
    const runH = left + right + 1;
    const horizontal = runH >= RUN_ROAD;
    const vertical = runV >= RUN_ROAD;
    // Long both ways is a junction: bare, as the 2D painter leaves it.
    if (horizontal && vertical) return 0;
    // Short both ways is a stair step of a carved diagonal band — the shared
    // direction field says which way it runs and which tiles carry the line.
    if (!horizontal && !vertical) {
      const dir = diagonalMark(isRoad, tx, ty);
      return dir === 'ne' ? 8 : dir === 'se' ? 9 : 0;
    }
    if (horizontal) {
      // Only on a true carriageway: nothing the plan draws is wider than
      // ARTERIAL_WIDTH, so a wider cross-run is a shallow stretch of a
      // diagonal band's stair.
      if (runV > ARTERIAL_WIDTH) return 0;
      const centre = laneCentreInTile(runV, up);
      if (centre === null) return 0;
      return centre === 1 ? 6 : 1;
    }
    if (runH > ARTERIAL_WIDTH) return 0;
    const centre = laneCentreInTile(runH, left);
    if (centre === null) return 0;
    return centre === 1 ? 7 : 2;
  };
  /**
   * Runway centreline: dashed, along the strip, on the ONE row of each column
   * `runwayCentreRow` names — the 2D painter's own rule, imported rather than
   * approximated, so the strip is marked out the same way in both renderers.
   * (The old local test here was "runway both sides", which is every interior
   * row: five dashed lines on a seven-tile strip, in both views at once.)
   */
  const runwayMark = (tx: number, ty: number): boolean =>
    runwayCentreRow(tileAt, tx, ty) && tx % 2 === 0;

  // Which building covers each tile, so a block of them shares one colour
  // instead of every tile rolling its own — the same reason the 2D renderer
  // keys roof colour off the building rather than the tile.
  const buildingOf = new Int32Array(W * H);
  map.buildings.forEach((bd, i) => {
    for (let ty = bd.y; ty < bd.y + bd.h; ty++) {
      for (let tx = bd.x; tx < bd.x + bd.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        buildingOf[ty * W + tx] = i + 1;
      }
    }
  });

  // Which shop's floor each `T_FLOOR` tile belongs to, and whether it is the
  // room or the threshold. A shop is identified from the street by its colour
  // in the 2D view; without this the 3D one drew every shop interior in the
  // industrial-lot grey and there was no telling a gun shop from a garage.
  const shopAccent = new Int32Array(W * H);
  const ACCENTS: Record<string, number> = {
    gun: col('shopGun', 0xc8583c),
    clothing: col('shopClothing', 0x3ca0c8),
    spray: col('shopSpray', 0xc8a13c),
    // The proving ground is not a shop and should not look like one.
    depot: DEPOT_ACCENT,
  };
  for (const shop of map.shops) {
    const accent = (ACCENTS[shop.kind] ?? col('shopSpray', 0xc8a13c)) + 1;
    const r = shop.interior;
    for (let ty = r.y - 1; ty <= r.y + r.h; ty++) {
      for (let tx = r.x - 1; tx <= r.x + r.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        // The threshold tile only — the room keeps its chequered floor.
        const inRoom = tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;
        if (!inRoom && tileAt(tx, ty) === T_FLOOR) shopAccent[ty * W + tx] = accent;
      }
    }
  }

  // Collect one transform per span, bucketed by the colour it resolves to
  // AND by where in the city it is.
  //
  // Buildings get a bucket per palette variant rather than one for all of
  // them: a city where every block is the same grey reads as a model of a
  // city, and the variants already exist for exactly this.
  //
  // The chunk half of the key is what makes culling work at all. three.js
  // culls an `InstancedMesh` against the bounding sphere of all its instances,
  // so one mesh per material spanning a 240×240 map has a bounding sphere
  // covering the entire city and is never culled from anywhere — the whole map
  // was submitted every frame from every camera. Measured at the game's own
  // view size, 4.2% of instances actually intersect the frustum.
  //
  // Chunking trades a larger number of meshes for the ability to reject most
  // of them with one sphere test each. `TileLayer` makes the same trade with
  // `CHUNK_TILES`.
  const chunksX = Math.ceil(W / CHUNK_TILES);
  const buckets = new Map<string, Boxes>();
  const surfaceOf = new Map<string, Surface>();
  const bucket = (tx: number, ty: number, surface: Surface): Boxes => {
    const chunk = Math.floor(ty / CHUNK_TILES) * chunksX + Math.floor(tx / CHUNK_TILES);
    const key = `${chunk}|${surface.key}`;
    let list = buckets.get(key);
    if (!list) {
      list = new Boxes();
      buckets.set(key, list);
      surfaceOf.set(key, surface);
    }
    return list;
  };

  /** Roof height per tile, filled as the grid is walked. */
  const heightAt = new Float64Array(W * H);

  // The coast as curves (§18): which segment cuts each shore tile, computed
  // once for both the sinking below and the prisms that replace what is sunk.
  const shoreCut = map.shores && map.shores.length > 0 ? shoreChains(map.shores, W, H) : null;

  // The deck's OWN edge as a curve (§45), in the same per-tile form and the
  // same "water on the right" convention. The coast chain above says nothing
  // about it — a river runs under a span — so before this the deck was the
  // one built edge over open water with no curve of any kind on it, and it
  // was drawn one square tile at a time with a parapet standing on the steps.
  const deckCut = buildDeckCut(map.tiles, W, H, map.courses);

  /**
   * Which building tiles are drawn as one rotated mass instead of a column of
   * boxes (§20), and how tall that mass is — the walk below needs both, and
   * the walk runs first.
   *
   * A building only qualifies if it FACES something and its footprint is
   * solid. The second test is not fussiness: a shop is a room punched out of
   * a building and open to the sky, and one mass over the whole rect would
   * put a lid on it. Those keep their per-tile columns, which is exactly what
   * `roofCanvasFor` does in the 2D painter for the same reason.
   */
  const massTiles = new Uint8Array(W * H);
  const massTop = new Float32Array(W * H);
  const masses: Array<{ b: Building; top: number }> = [];
  for (const b of map.buildings) {
    if ((b.angle ?? 0) === 0) continue;
    // A building CUT at an angle (§36) records its BOUNDING BOX, whose
    // corners are yard by construction — so "every tile is wall" refuses
    // every one of them and the walk falls back to per-tile boxes, drawing a
    // stepped outline round a rectangle. The question either way is whether a
    // room has been punched out of it.
    let solid = true;
    for (let ty = b.y; ty < b.y + b.h && solid; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) {
          solid = false;
          break;
        }
        const t = map.tiles[ty * W + tx];
        if (t === T_FLOOR || (b.mw === undefined && t !== T_BUILDING)) {
          solid = false;
          break;
        }
      }
    }
    if (!solid) continue;
    const top = buildingStoreys(b) * Z_PER_STOREY * Z_SCALE;
    masses.push({ b, top });
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        massTiles[ty * W + tx] = 1;
        massTop[ty * W + tx] = top;
      }
    }
  }

  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const idx = ty * W + tx;
      const tile = map.tiles[idx] as number;
      let surface: Surface;
      if (tile === T_BUILDING) {
        const bi = (buildingOf[idx] as number) - 1;
        const color = roofColor(map, tx, ty, bi);
        surface = { key: `b${color.toString(16)}`, color, solid: true };
      } else if (tile === T_SIDEWALK) {
        // Pavement takes its district's tint, which `palette.sidewalkTint`
        // has carried all along and only the 2D painter ever read. Every
        // pavement in the 3D city was one neutral grey — and pavement is the
        // largest bright mass in the frame, so a single flat value across all
        // of it is a good part of why the city reads as a model.
        const district = districtAt(map, tx, ty) as string;
        const tint = (PAL_TINT[district] ?? PAL.sidewalk) as string;
        surface = { key: `pavement:${district}`, color: hex(tint, 0x5f646c), grain: 0.09, edge: 0.1 };
      } else {
        surface = SURFACES[tile] ?? DEFAULT_SURFACE;
        if (surface.road) {
          // A road tile at the mouth of a junction is where a crossing goes.
          const cross = crossing(tx, ty);
          if (cross) surface = { ...surface, key: cross === 1 ? 'crossX' : 'crossY' };
          else {
            const mark = roadMark(tx, ty);
            if (mark) surface = { ...surface, key: `roadMark${mark}` };
          }
        } else if (tile === T_RUNWAY && runwayMark(tx, ty)) {
          surface = { ...surface, key: 'runwayMark' };
        } else if (tile === T_FLOOR) {
          const accent = shopAccent[idx] as number;
          if (accent > 0) surface = { ...surface, key: `shop${accent}`, color: accent - 1 };
          // Chequered, exactly as `paintShopFloor` lays it out.
          else if (((tx + ty) & 1) === 1) {
            surface = { ...surface, key: 'floorAlt', color: col('shopFloorAlt', 0x7a7168) };
          }
        }
      }
      // A headland tile bevelled toward water is half sea, and the painted
      // ground plane's cutout opens onto whatever slab is underneath — so
      // the slab has to BE the sea: water colour, water depth. The dry half
      // gets its ground back as a shore wedge (`buildShoreWedges`), whose
      // diagonal face is the new waterline.
      const bevCode = map.bevel ? (map.bevel[idx] as number) : 0;
      // A tile the coast course crosses loses its box entirely: the box is
      // square and the coast is not, and `buildShorePrisms` puts the dry
      // part back as a prism cut by the curve. Only ground-level tiles —
      // a building never stands at the waterline, and sinking one would
      // drop a tower into the sea.
      const crossed = shoreCut !== null && shoreCut.has(idx) && GROUND_AT_SEA.has(tile);
      // And a DECK tile the deck curve crosses loses its box for the same
      // reason (§45): the box is square, the deck's edge is not, and
      // `buildDeckPrisms` puts the deck part back cut by the curve. Sunk to
      // the river, because what is left of the square where the deck is not
      // is river — the span is over open water by construction, this being
      // the deck/water boundary and nowhere else.
      const deckCrossed = tile === T_BRIDGE && deckCut.has(idx);
      const sunk =
        crossed ||
        deckCrossed ||
        (bevCode !== 0 &&
          tile !== T_WATER &&
          bevelOther(map.tiles, map.bevel as Uint8Array, W, tx, ty) === T_WATER);
      if (sunk) surface = SURFACES[T_WATER] as Surface;
      // A building that faces a street is drawn once, rotated, by
      // `buildBuildingMasses` — not as a column of square boxes per tile
      // (§20). Its tiles are skipped here, and only its tiles: everything
      // else on the map is still one box per tile per span.
      if (tile === T_BUILDING && massTiles[idx] === 1) {
        heightAt[idx] = massTop[idx] as number;
        continue;
      }
      const list = bucket(tx, ty, surface);

      const spans: readonly Span[] = sunk
        ? [{ bottom: EARTH, top: -8 }]
        : drawnSpans(tile, spansAt(vg, tx, ty));
      for (const span of spans) {
        // Clamp the earth to something shallow: a ground span runs from
        // EARTH (-4096) and nobody is looking at the bottom of it.
        //
        // Clamp to a fixed FLOOR, not to `top - depth`. Clamping relative
        // to the top capped every building at the same height whatever its
        // storeys said, because a building span also starts at EARTH — a
        // twelve-storey tower drew exactly as tall as a bungalow, which is
        // the whole point of having heights at all.
        //
        // `Z_SCALE` applies to the part that STANDS UP and to nothing else.
        // Scaling the whole span would lift the river bed from -8 to -2 and
        // the earth slab from -16 to -4, which is not a shorter city, it is a
        // shallower one — the shoreline, the bridge underside and the map
        // border all read off those. Only a top above street level moves.
        const bottom = Math.max(span.bottom, -16);
        const top = span.top > 0 ? span.top * Z_SCALE : span.top;
        const h = Math.max(1, top - bottom);
        // A hair wider than the tile so neighbours overlap rather than meet.
        // Boxes that share an edge exactly leave the rasteriser to break the
        // tie, and it breaks it in favour of the darker side wall — scoring
        // every roof, road and stretch of water with a dark 1 px line on a
        // 16 px grid. That regular scratching is the first thing in the frame
        // that reads as an engine artefact rather than as art.
        list.push(
          TILE_SIZE + SEAM_OVERLAP,
          TILE_SIZE + SEAM_OVERLAP,
          h,
          (tx + 0.5) * TILE_SIZE,
          (ty + 0.5) * TILE_SIZE,
          top - h / 2,
        );
        if (tile === T_BUILDING) heightAt[idx] = top;
      }
    }
  }

  // The rotated masses, filed under the same chunk buckets and the same
  // per-surface materials the square ones use — a rotated building is the
  // same building, drawn once.
  for (const { b, top } of masses) {
    const m = buildingMass(b);
    const bi = buildingOf[(b.y + (b.h >> 1)) * W + b.x + (b.w >> 1)] as number;
    const color = roofColor(map, b.x, b.y, bi - 1);
    const bottom = -16;
    const h = Math.max(1, top - bottom);
    bucket(Math.floor(m.cx), Math.floor(m.cy), {
      key: `b${color.toString(16)}`,
      color,
      solid: true,
    }).push(
      m.w * TILE_SIZE + SEAM_OVERLAP,
      m.h * TILE_SIZE + SEAM_OVERLAP,
      h,
      m.cx * TILE_SIZE,
      m.cy * TILE_SIZE,
      top - h / 2,
      m.rad,
    );
  }

  instances += buildRoofDetail(map, group, heightAt, masses, massTiles);
  instances += buildBridgeRails(map, group, deckCut);
  // Before the shore prisms: a deck tile is never a shore tile (a deck is not
  // in `GROUND_AT_SEA`), so the two never touch the same square, and keeping
  // them adjacent keeps the two halves of "what replaces a sunk box" together.
  instances += buildDeckPrisms(map, group, deckCut, (tx, ty) => {
    const cross = crossing(tx, ty);
    return cross ? 0 : roadMark(tx, ty);
  });
  instances += buildEdgeSkirt(map, group);
  instances += buildBandPatches(map, group, shoreCut);
  instances += buildShorePrisms(map, group, shoreCut);
  instances += buildShoreWedges(map, group, shoreCut, deckCut);

  const box = new THREE.BoxGeometry(1, 1, 1);
  // One material per surface, shared by every chunk that has any of it.
  //
  // Chunking multiplies the number of meshes, and building a material each
  // time would multiply the materials with them — which would cost a shader
  // program per copy and defeat the batching that makes the city cheap. The
  // material is a property of the surface; only the transforms are per chunk.
  const materials = new Map<string, THREE.Material>();
  const materialFor = (surface: Surface): THREE.Material => {
    const key = surface.key;
    const hit = materials.get(key);
    if (hit) return hit;
    const { color } = surface;
    // Buildings get a facade — storey lines, window columns, a shopfront on
    // the ground floor — computed in the shader from world position, so one
    // material serves every height. Ground surfaces stay flat toon.
    const material = surface.solid
      ? facadeMaterial({ color })
      : key === 'ramp'
        ? roadMaterial(color, 5, surface.line ?? ROAD_LINE)
        : key === 'road'
          ? roadMaterial(color, 0, surface.line)
        : key.startsWith('roadMark')
          ? roadMaterial(color, Number(key.slice(8)), surface.line)
          : key === 'crossX'
            ? roadMaterial(color, 3, surface.line)
            : key === 'crossY'
              ? roadMaterial(color, 4, surface.line)
              : key === 'runway'
                ? roadMaterial(color, 0, col('runwayLine', 0xc9c3a8))
                : key === 'runwayMark'
                  ? roadMaterial(color, 1, col('runwayLine', 0xc9c3a8))
                  : key === 'water'
                    ? toonMaterial(color)
                    : groundMaterial(color, surface.grain ?? 0.1, surface.edge ?? 0);
    materials.set(key, material);
    return material;
  };
  // And one outline material for the whole city, for the same reason.
  const cityOutline = outlineMaterial(BUILDING_OUTLINE);

  for (const [key, boxes] of buckets) {
    if (boxes.count === 0) continue;
    const surface = surfaceOf.get(key) ?? DEFAULT_SURFACE;
    const mesh = new THREE.InstancedMesh(box, materialFor(surface), boxes.count);
    mesh.castShadow = surface.solid === true;
    mesh.receiveShadow = true;
    instances += boxes.count;
    boxes.writeTo(mesh);
    group.add(mesh);
    // Outline the things that stand up. Outlining every ground tile would
    // draw a black grid over the whole city — the streets read as one
    // surface, and a surface has no silhouette worth tracing.
    // Thin: at this camera a fat hull rounds off box corners into wedges.
    if (surface.solid) addOutline(mesh, group, BUILDING_OUTLINE, cityOutline);
  }

  (globalThis as never as { __jt: string[] }).__jt?.push(`  instances ${instances}`);
  return { group, instances };
}

/**
 * Parapets and rooftop clutter.
 *
 * From a camera hanging straight over the city, roofs are most of what you see
 * of a building — and a flat coloured rectangle is where a city stops looking
 * built. The 2D tile layer already knows this: it draws a bright lip along the
 * sun-facing roof edges, a dark one along the others, and scatters units, vents
 * and hatches across the interior. Same idea here, as real geometry, from the
 * same hash and the same thresholds.
 *
 * A parapet goes on every roof tile with a non-building neighbour, on that side
 * only, so a block of buildings is rimmed at its outline rather than gridded
 * tile by tile. Clutter goes only on interior tiles, which is what stops an
 * air-conditioning unit hanging over the street.
 */
function buildRoofDetail(
  map: CityMap,
  group: THREE.Group,
  heightAt: Float64Array,
  masses: ReadonlyArray<{ b: Building; top: number }>,
  massTiles: Uint8Array,
): number {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const isBuilding = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < W && ty < H && map.tiles[ty * W + tx] === T_BUILDING;

  const parapets = new Map<number, Boxes>();
  const clutter = new Map<number, Boxes>();
  const LIP_H = 3.2;
  const LIP_W = 2.4;

  // A rotated mass gets a rotated parapet: four lips round the mass itself,
  // turned with it. Run first, and its tiles are skipped by the per-tile walk
  // below — a square ring of lips floating over a turned roof was the first
  // thing §20 got wrong, and it read as a picture frame hanging in the air.
  for (const { b, top } of masses) {
    if (top <= 0) continue;
    const m = buildingMass(b);
    const cx = m.cx * T;
    const cy = m.cy * T;
    const w = m.w * T;
    const h = m.h * T;
    const c = Math.cos(m.rad);
    const s = Math.sin(m.rad);
    const lip = (ox: number, oy: number, lw: number, ld: number): void => {
      intoChunk(
        parapets,
        Math.floor(m.cx),
        Math.floor(m.cy),
        lw,
        ld,
        LIP_H,
        cx + ox * c - oy * s,
        cy + ox * s + oy * c,
        top + LIP_H / 2,
        m.rad,
      );
    };
    lip(0, -h / 2 + LIP_W / 2, w, LIP_W);
    lip(0, h / 2 - LIP_W / 2, w, LIP_W);
    lip(-w / 2 + LIP_W / 2, 0, LIP_W, h);
    lip(w / 2 - LIP_W / 2, 0, LIP_W, h);
  }

  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const idx = ty * W + tx;
      if (map.tiles[idx] !== T_BUILDING || massTiles[idx] === 1) continue;
      const top = heightAt[idx] as number;
      if (top <= 0) continue;
      const cx = (tx + 0.5) * T;
      const cy = (ty + 0.5) * T;

      const openN = !isBuilding(tx, ty - 1);
      const openS = !isBuilding(tx, ty + 1);
      const openW = !isBuilding(tx - 1, ty);
      const openE = !isBuilding(tx + 1, ty);

      const lip = (x: number, y: number, w: number, d: number): void => {
        intoChunk(parapets, tx, ty, w, d, LIP_H, x, y, top + LIP_H / 2);
      };
      if (openN) lip(cx, cy - T / 2 + LIP_W / 2, T, LIP_W);
      if (openS) lip(cx, cy + T / 2 - LIP_W / 2, T, LIP_W);
      if (openW) lip(cx - T / 2 + LIP_W / 2, cy, LIP_W, T);
      if (openE) lip(cx + T / 2 - LIP_W / 2, cy, LIP_W, T);

      // Interior only — same rule and same salt the 2D roof painter uses.
      if (openN || openS || openE || openW) continue;
      const roll = hash2(tx, ty, 61);
      if (roll > 0.86) {
        intoChunk(clutter, tx, ty, T * 0.5, T * 0.38, 6, cx, cy, top + 3);
      } else if (roll > 0.74) {
        intoChunk(clutter, tx, ty, T * 0.25, T * 0.25, 4, cx, cy, top + 2);
      } else if (roll > 0.68) {
        intoChunk(clutter, tx, ty, T * 0.36, T * 0.3, 2, cx, cy, top + 1);
      }
    }
  }

  let instances = 0;
  instances += addChunkedBoxes(group, parapets, col('roofEdgeLight', 0x8f97a6), 0.4);
  instances += addChunkedBoxes(group, clutter, col('roofUnit', 0x6b7079), 0.5);
  return instances;
}

/**
 * The rails along a bridge deck.
 *
 * `paintBridge` draws these in 2D, and they are what says "bridge" rather than
 * "a stretch of road that happens to have water beside it" — which is all the
 * deck reads as now that it sits at the height the game drives at.
 *
 * Along the deck's own edge CURVE, one box per chord (§45). It used to be one
 * axis-aligned box per tile side with open water across it — "is there river
 * on this side", which is the right question and was asked of the wrong
 * shape. The tile mask is the deck's outline point-sampled at tile centres,
 * so on a span running fifteen degrees off the axis that answer changes a
 * whole tile at a time, and a 5-unit parapet standing on the answer jogged a
 * whole tile with it. Measured on the shipped city: 872 rail boxes, 418 of
 * them at the end of a tread. That zig-zag ribbon is what
 * `evidence/iter7/A-bridge-178-478-eye.png` photographs.
 *
 * `buildDeckCut` supplies the curve the deck was cut FROM, so the box is
 * placed on the chord through the tile, turned to the chord's own bearing and
 * set half its width inboard — standing on deck, as a parapet does, rather
 * than half over the drop. Chords meet exactly on a shared tile border (their
 * crossing is bisected from the same field), and the box is lengthened by one
 * `SEAM_OVERLAP` so the joint closes rather than showing daylight.
 *
 * The deck/water test is kept and moved onto the curve: a sample is taken off
 * the chord on its wet side, and only a genuine `T_WATER` tile there earns a
 * parapet. An abutment, where the deck runs onto land, still gets none.
 *
 * `PROBE` is 0.75 tiles and that number is derived, not tuned. The sample has
 * to leave the chord's OWN square — which is `T_BRIDGE` on every deck tile,
 * so a short probe answers "deck" and refuses a parapet that belongs. A chord
 * midpoint lies inside the unit square, so along any direction its own border
 * is at most sqrt(2)/2 ~ 0.707 away; and the probe must not reach past the
 * square next door, so it must stay under 1. Measured over the shipped city's
 * 877 chords (`evidence/iter8/rail-probe.mjs`), a third of a tile lands back
 * on the deck 104 times — the gapped parapet that shows in the first draft of
 * `A-bridge-178-478-eye-AFTER.png` — 0.75 lands there never, and 1.0 starts
 * overshooting onto the far bank and refusing 10 rails that belong.
 */
function buildBridgeRails(
  map: CityMap,
  group: THREE.Group,
  deckCut: Map<number, Float32Array>,
): number {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const RAIL_H = 5;
  const RAIL_W = 2;
  /** How far off the chord to ask "is that the river". See above. */
  const PROBE = 0.75;
  const at = (tx: number, ty: number): number =>
    tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : (map.tiles[ty * W + tx] as number);

  const rails = new Map<number, Boxes>();
  for (const [idx, seg] of deckCut) {
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const ax = seg[0] as number;
    const ay = seg[1] as number;
    const bx = seg[2] as number;
    const by = seg[3] as number;
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len === 0) continue;
    // Water is on the RIGHT of travel, so the unit normal into the water is
    // the run turned a quarter turn clockwise on screen — the same rotation
    // `buildShoreCut` derives its wet half-plane from.
    const wx = -vy / len;
    const wy = vx / len;
    const mx = tx + (ax + bx) / 2;
    const my = ty + (ay + by) / 2;
    if (at(Math.floor(mx + wx * PROBE), Math.floor(my + wy * PROBE)) !== T_WATER) continue;
    // Inboard by half the rail's width, so the parapet stands on the deck.
    const inset = RAIL_W / 2;
    intoChunk(
      rails,
      tx,
      ty,
      len * T + SEAM_OVERLAP,
      RAIL_W,
      RAIL_H,
      mx * T - wx * inset,
      my * T - wy * inset,
      RAIL_H / 2,
      Math.atan2(vy, vx),
    );
  }
  return addChunkedBoxes(group, rails, col('kerb', 0x787d86), 0.4);
}

/**
 * Ground beyond the window, so the world does not end in sky.
 *
 * The session's window is 240×240 tiles of a world that is notionally
 * infinite; at the frame's edge the tiles simply stopped and the background
 * colour showed through, which reads as the map having fallen off rather than
 * as countryside carrying on. Four slabs of field around the outside, at the
 * height the field is at, cost one draw between them.
 *
 * A ring rather than one big plane under everything: a plane would have to sit
 * above the water surface at −8 to avoid z-fighting the grass at 0, and would
 * then have paved over every river in the city.
 */
function buildEdgeSkirt(map: CityMap, group: THREE.Group): number {
  const w = map.widthTiles * TILE_SIZE;
  const h = map.heightTiles * TILE_SIZE;
  const OUT = 4096;
  const slabs = new Boxes();
  const slab = (x: number, y: number, sx: number, sy: number): void => {
    slabs.push(sx, sy, 8, x, y, -4);
  };
  slab(w / 2, -OUT / 2, w + OUT * 2, OUT);
  slab(w / 2, h + OUT / 2, w + OUT * 2, OUT);
  slab(-OUT / 2, h / 2, OUT, h);
  slab(w + OUT / 2, h / 2, OUT, h);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    groundMaterial(col('field', 0x2b3630), 0.2),
    slabs.count,
  );
  mesh.receiveShadow = true;
  slabs.writeTo(mesh);
  group.add(mesh);
  return slabs.count;
}

/**
 * The surfaces a coastline is allowed to cut through.
 *
 * Everything the sea can lap against and nothing that stands up. A shore
 * tile's box is sunk and replaced by a prism, and sinking a tile with height
 * on it — a building, a wall — would drop the whole mass to the riverbed.
 */
const GROUND_AT_SEA = new Set<number>([
  T_WATER,
  T_SAND,
  T_BANK,
  T_FIELD,
  T_PARK,
  T_LOT,
  T_ROAD,
  T_SIDEWALK,
  T_TREES,
  T_RUNWAY,
]);

/**
 * The shore band's inner edge, laid over the ground as flat patches (§39).
 *
 * The 2D painter cuts a band tile in two and paints each half as what that
 * side is made of; the 3D city cannot do that as cheaply, because its ground
 * is one box per tile and splitting the box would mean re-meshing every
 * shore tile in the map. What it does instead is leave the box and lay the
 * OTHER half over it as a flat patch, a hair above street level so it wins
 * the depth test. Same line, same two materials, one draw call.
 *
 * Tiles topped at canopy height are skipped, both as the box and as the
 * patch: a wooded cliff foot's box stands at `TREE_Z`, so a patch at street
 * level would be under it and a patch at canopy height would be a green
 * shelf hanging over the beach. That is the woodland-as-a-box defect §15.4
 * already records, and it wants the canopy, not a second patch.
 */
function buildBandPatches(
  map: CityMap,
  group: THREE.Group,
  shoreCut: Map<number, Float32Array> | null,
): number {
  const banks = map.banks ?? [];
  if (banks.length === 0) return 0;
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const cuts = shoreChains(banks, W, H);
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  let patches = 0;

  /** Just clear of the ground plane, and far under anything you can see. */
  const LIFT = 0.05;

  for (const [idx, seg] of cuts) {
    // The waterline owns any tile it also runs through: that tile's box is
    // already sunk and rebuilt as a prism, and a patch would float over the
    // sea beside it.
    if (shoreCut !== null && shoreCut.has(idx)) continue;
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const own = map.tiles[idx] as number;
    if (!GROUND_AT_SEA.has(own) || own === T_WATER || own === T_TREES) continue;

    // What the far side of the line is made of: the nearest tile centre the
    // line puts over there. Asking the line and not the tile types, because
    // sand and the grass behind it are told apart by the curve alone.
    const want = -chainSide(seg, 0.5, 0.5);
    let best = Infinity;
    let other = -1;
    for (const [dx, dy] of [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const t = map.tiles[ny * W + nx] as number;
      if (!GROUND_AT_SEA.has(t) || t === T_WATER || t === T_TREES) continue;
      if (chainSide(seg, dx + 0.5, dy + 0.5) !== want) continue;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        other = t;
      }
    }
    if (other < 0 || other === own) continue;

    const half = shoreHalf(seg, want < 0);
    if (half.length < 3) continue;
    color.set((SURFACES[other] ?? DEFAULT_SURFACE).color);
    // Fanned from the first corner: `shoreHalf` returns a simple polygon,
    // and one that a chord through a square makes convex.
    for (let i = 1; i + 1 < half.length; i++) {
      for (const p of [half[0], half[i], half[i + 1]] as Array<[number, number]>) {
        positions.push((tx + p[0]) * T, (ty + p[1]) * T, LIFT);
        colors.push(color.r, color.g, color.b);
      }
    }
    patches++;
  }
  if (patches === 0) return 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: toonGradient(),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  group.add(mesh);
  return 1;
}

/**
 * The deck side of every tile the deck's own edge curve crosses (§45).
 *
 * `buildShorePrisms` for a bridge, and it exists separately for one reason
 * the shore version cannot serve: a deck is CARRIAGEWAY, and the carriageway
 * is drawn by `roadMaterial`, a shader that reads world position for its
 * asphalt grain and its lane markings. A vertex-coloured prism would have cut
 * the tile straight and painted flat tarmac over it, trading a stepped edge
 * for a missing lane line. Routing the prism through the very same material
 * the box used means the cut costs nothing at all: the shader does not know
 * or care that the triangles under it are no longer a square.
 *
 * (Measured before relying on it: of the 388 deck tiles the curve crosses on
 * the shipped city, `evidence/iter8/deck-cut-census.mjs` finds **zero**
 * carrying a road marking — the markings are on the centre lane and the curve
 * only ever reaches the outermost half tile. So the mark is 0 on every prism
 * in practice; it is asked for per tile anyway rather than assumed, because
 * a narrower span on some future plan would not have that luxury.)
 *
 * The tile's own box is gone by the time this runs (`deckCrossed` in the walk
 * above sinks it to the river), so this prism IS the deck there: a top face
 * at street level and a vertical fascia down the chord, which is the edge you
 * see from the water.
 */
function buildDeckPrisms(
  map: CityMap,
  group: THREE.Group,
  cuts: Map<number, Float32Array>,
  markOf: (tx: number, ty: number) => number,
): number {
  const W = map.widthTiles;
  const T = TILE_SIZE;
  const DEPTH = 16;
  const surface = SURFACES[T_BRIDGE] as Surface;
  // One buffer per marking, because the mark is a uniform on the material.
  const byMark = new Map<number, number[]>();
  let prisms = 0;

  for (const [idx, seg] of cuts) {
    const tx = idx % W;
    const ty = (idx - tx) / W;
    // Water tiles the curve clips are built too, and must be: the tile mask
    // is a point sample, so where the deck's true edge runs past a tile
    // centre the OVERHANG lives on a square the tiles call river. The painted
    // ground plane already draws deck there (its cutout follows the same
    // chain), and painted ground over a hole with no sides is water sliding
    // under the deck's edge from any angle but straight down — which is the
    // defect `buildShorePrisms` was written to stop happening on the coast.
    const own = map.tiles[idx] as number;
    if (own !== T_BRIDGE && own !== T_WATER) continue;
    const dry = shoreHalf(seg, false);
    if (dry.length < 3) continue;
    const mark = markOf(tx, ty);
    let out = byMark.get(mark);
    if (!out) byMark.set(mark, (out = []));
    const px = (p: [number, number]): number => (tx + p[0]) * T;
    const py = (p: [number, number]): number => (ty + p[1]) * T;
    const put = (x: number, y: number, z: number): void => {
      (out as number[]).push(x, y, z);
    };
    // Top face, fanned from the first corner: a chord through a square leaves
    // a convex half, always.
    for (let i = 1; i + 1 < dry.length; i++) {
      put(px(dry[0] as [number, number]), py(dry[0] as [number, number]), 0);
      put(px(dry[i] as [number, number]), py(dry[i] as [number, number]), 0);
      put(px(dry[i + 1] as [number, number]), py(dry[i + 1] as [number, number]), 0);
    }
    // A fascia down every edge of the half, tile borders included — the same
    // reasoning as `buildShorePrisms`: two neighbouring deck halves only
    // share the point where the curve crosses their common border, and above
    // that point one side is deck and the other is open river.
    for (let i = 0; i < dry.length; i++) {
      const p = dry[i] as [number, number];
      const q = dry[(i + 1) % dry.length] as [number, number];
      put(px(p), py(p), 0);
      put(px(q), py(q), 0);
      put(px(q), py(q), -DEPTH);
      put(px(p), py(p), 0);
      put(px(q), py(q), -DEPTH);
      put(px(p), py(p), -DEPTH);
    }
    prisms++;
  }
  if (prisms === 0) return 0;

  for (const [mark, positions] of byMark) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = roadMaterial(surface.color, mark, surface.line);
    // DoubleSide for the same reason `buildShorePrisms` needs it: the fascia
    // quads are emitted in the order the half's own boundary runs, which is
    // clockwise or anticlockwise depending on which way the curve crosses the
    // square, so half of them would be back-facing and the deck would have
    // holes in its side from one bank and not the other.
    material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return prisms;
}

/**
 * The dry side of every tile the coast course crosses, as real geometry.
 *
 * The generalisation of `buildShoreWedges` below, and the same three
 * triangles' worth of idea: the painted ground plane draws the coast and its
 * cutout opens the water beside it, but painted ground floating over a hole
 * has no sides — from anything but straight overhead you would see water
 * sliding under the beach's edge. This puts the ground back. What changed is
 * the shape: a bevel could only cut a tile corner to corner, so the coast in
 * 3D was a staircase with some of its steps chamfered, and a chord cuts it at
 * whatever angle the coast actually runs at.
 *
 * The tile's own box is gone by the time this runs (`crossed` in the walk
 * above sinks it to the riverbed), so this prism IS the land there: a top
 * face at street level, and a vertical face down the chord which is the
 * waterline.
 */
function buildShorePrisms(
  map: CityMap,
  group: THREE.Group,
  cuts: Map<number, Float32Array> | null,
): number {
  if (cuts === null) return 0;
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const DEPTH = 16;
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  let prisms = 0;

  const put = (x: number, y: number, z: number): void => {
    positions.push(x, y, z);
    colors.push(color.r, color.g, color.b);
  };

  for (const [idx, seg] of cuts) {
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const tile = map.tiles[idx] as number;
    if (!GROUND_AT_SEA.has(tile)) continue;
    const dry = shoreHalf(seg, false);
    if (dry.length < 3) continue;

    // What the dry side is made of: this tile if it is dry land, else the
    // nearest dry neighbour — a sea tile the curve has made half-dry belongs
    // to the beach or the quay beside it, not to some default.
    let mat = tile;
    if (mat === T_WATER || mat === T_BRIDGE) {
      let best = Infinity;
      for (const [dx, dy] of [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ] as const) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const t = map.tiles[ny * W + nx] as number;
        if (t === T_WATER || t === T_BRIDGE || t === T_BUILDING) continue;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          mat = t;
        }
      }
      if (mat === T_WATER || mat === T_BRIDGE) continue;
    }

    color.set((SURFACES[mat] ?? DEFAULT_SURFACE).color);
    // Street level, or canopy height on the wooded shore: a cliff's corner,
    // not a green skirt at its foot (§15.4 item 2).
    const top = mat === T_TREES ? TREE_Z * Z_SCALE : 0;
    const px = (p: [number, number]): number => (tx + p[0]) * T;
    const py = (p: [number, number]): number => (ty + p[1]) * T;
    // Top face, fanned from the first corner: the half is convex, always.
    for (let i = 1; i + 1 < dry.length; i++) {
      put(px(dry[0] as [number, number]), py(dry[0] as [number, number]), top);
      put(px(dry[i] as [number, number]), py(dry[i] as [number, number]), top);
      put(px(dry[i + 1] as [number, number]), py(dry[i + 1] as [number, number]), top);
    }
    // A wall down EVERY edge of the half, the tile borders included.
    //
    // Skipping the borders is the obvious saving and it leaves holes you can
    // see the sky through. Two neighbouring shore tiles share an edge, but
    // their dry halves only share the point where the coast crosses it: above
    // that point one is land and the other is sea, and that stretch of border
    // is a real cliff with nothing behind it. Where two dry halves DO cover
    // the same border in full, the pair of walls is interior and invisible,
    // which is a cheaper thing to be wrong about than a gap.
    for (let i = 0; i < dry.length; i++) {
      const p = dry[i] as [number, number];
      const q = dry[(i + 1) % dry.length] as [number, number];
      put(px(p), py(p), top);
      put(px(q), py(q), top);
      put(px(q), py(q), -DEPTH);
      put(px(p), py(p), top);
      put(px(q), py(q), -DEPTH);
      put(px(p), py(p), -DEPTH);
    }
    prisms++;
  }
  if (prisms === 0) return 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: toonGradient(),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  group.add(mesh);
  return prisms;
}

/**
 * The dry halves of the bevelled shoreline, as real geometry.
 *
 * The painted ground plane draws the diagonal beach and its cutout opens the
 * water beside it, but a wedge of painted ground floating over a hole has no
 * sides — from anything but straight overhead you would see water sliding
 * under the sand's edge. This puts the ground back: a triangular slab at
 * street level filling the dry half, with a vertical face down the
 * hypotenuse — the 45° waterline the whole bevel system exists to draw.
 *
 * Plain BufferGeometry rather than instancing, deliberately: the instanced
 * city is scale+translate boxes only, and a wedge is the one shape in it
 * that is not a box. A few hundred shore tiles at three triangles each is
 * single-digit thousands of vertices — one mesh, one draw.
 */
function buildShoreWedges(
  map: CityMap,
  group: THREE.Group,
  cuts: Map<number, Float32Array> | null,
  deckCut: Map<number, Float32Array>,
): number {
  const bevel = map.bevel;
  if (!bevel) return 0;
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const DEPTH = 16;

  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  let wedges = 0;

  const put = (x: number, y: number, z: number): void => {
    positions.push(x, y, z);
    colors.push(color.r, color.g, color.b);
  };

  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const idx = ty * W + tx;
      const code = bevel[idx] as number;
      if (code === 0) continue;
      // The chord has already built this one, at a better angle.
      if (cuts !== null && cuts.has(idx)) continue;
      // And so has the DECK chord (§45). §31 gave the deck/water pair a
      // one-directional bevel — the water yields, so a diagonal crossing
      // reads as a ramp rather than a flight of stairs — and that 45 degree
      // wedge is the best a half-tile chamfer could do before the deck had a
      // curve. It now has one, and leaving the wedge in lays a triangle over
      // a chord at a different angle: the sawtooth the band pass already
      // learned not to draw over a curve it disagrees with.
      if (deckCut.has(idx)) continue;
      const tile = map.tiles[idx] as number;
      const other = bevelOther(map.tiles, bevel, W, tx, ty);
      // Only water bevels need geometry: a sand/grass bevel sits on the
      // full slab its tile already has.
      let dryHalf: number;
      let dryMat: number;
      if (tile === T_WATER && other !== T_WATER) {
        dryHalf = code;
        dryMat = other;
      } else if (other === T_WATER) {
        dryHalf = oppositeHalf(code);
        dryMat = tile;
      } else {
        continue;
      }

      const x0 = tx * T;
      const y0 = ty * T;
      const x1 = x0 + T;
      const y1 = y0 + T;
      // The half's three corners, hypotenuse first two — the diagonal face
      // hangs off hy[0]→hy[1].
      let a: [number, number];
      let b: [number, number];
      let c: [number, number];
      if (dryHalf === BEV_NE) {
        a = [x0, y0];
        b = [x1, y1];
        c = [x1, y0];
      } else if (dryHalf === BEV_SE) {
        a = [x1, y0];
        b = [x0, y1];
        c = [x1, y1];
      } else if (dryHalf === BEV_SW) {
        a = [x0, y0];
        b = [x1, y1];
        c = [x0, y1];
      } else {
        a = [x1, y0];
        b = [x0, y1];
        c = [x0, y0];
      }

      color.set((SURFACES[dryMat] ?? DEFAULT_SURFACE).color);
      // Top face at street level — or at canopy height for the wooded
      // shore, where the wedge is a corner of the cliff the canopy boxes
      // draw, and a street-level ledge would read as a green skirt at the
      // cliff's foot.
      const top = dryMat === T_TREES ? TREE_Z * Z_SCALE : 0;
      put(a[0], a[1], top);
      put(b[0], b[1], top);
      put(c[0], c[1], top);
      // The diagonal face, down past the water surface to the slab bottom.
      put(a[0], a[1], top);
      put(b[0], b[1], top);
      put(b[0], b[1], -DEPTH);
      put(a[0], a[1], top);
      put(b[0], b[1], -DEPTH);
      put(a[0], a[1], -DEPTH);
      wedges++;
    }
  }
  if (wedges === 0) return 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  // Double-sided: the wedges are authored in tile space, not wound to a
  // camera, and at three triangles a tile there is nothing to save.
  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: toonGradient(),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  group.add(mesh);
  return wedges;
}

/**
 * Which chunk a tile belongs to, as a key.
 *
 * The same split the main walk uses, so a detail box lands in a bucket whose
 * bounding sphere is the size of a chunk rather than the size of the city.
 */
function chunkKey(tx: number, ty: number): number {
  return Math.floor(ty / CHUNK_TILES) * 4096 + Math.floor(tx / CHUNK_TILES);
}

/** File a box under the chunk the tile that produced it sits in. */
function intoChunk(
  byChunk: Map<number, Boxes>,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): void {
  const key = chunkKey(tx, ty);
  let list = byChunk.get(key);
  if (!list) byChunk.set(key, (list = new Boxes()));
  list.push(sx, sy, sz, x, y, z, yaw);
}

/**
 * Instanced boxes, one batch per chunk, outlined — all sharing one material.
 *
 * Chunked for the reason the main walk is: three.js culls an `InstancedMesh`
 * against the bounding sphere of all its instances, so one mesh spanning the
 * map has a sphere covering the map, intersects every frustum, and is
 * submitted whole from every camera.
 *
 * This was measurable and large. The parapets and rooftop clutter went in as
 * two city-wide batches, and on a 240×240 city that is 6,125 instances — plus
 * their outline twins — submitted every frame from every camera. Everything
 * else in the city culled to nothing at the game's own camera, so those two
 * meshes were *all* of the geometry surviving the frustum test: 6,129 of 6,129
 * instances. Nothing in a draw-call count would ever have shown it, because it
 * is two draws.
 */
function addChunkedBoxes(
  group: THREE.Group,
  byChunk: Map<number, Boxes>,
  color: number,
  outline: number,
): number {
  let total = 0;
  // One geometry, one material and one outline material for every chunk of
  // this kind. Chunking multiplies meshes; it must not multiply either.
  const box = new THREE.BoxGeometry(1, 1, 1);
  const material = toonMaterial(color);
  const shared = outlineMaterial(outline);
  for (const boxes of byChunk.values()) {
    if (boxes.count === 0) continue;
    const mesh = new THREE.InstancedMesh(box, material, boxes.count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    boxes.writeTo(mesh);
    group.add(mesh);
    addOutline(mesh, group, outline, shared);
    total += boxes.count;
  }
  return total;
}

/**
 * Throw a built group away, GPU memory and all.
 *
 * `Object3D.remove` unhooks it from the scene graph and nothing else: the
 * buffers and the compiled programs stay resident, and a session that rebased
 * across a few regions would leak a whole city each time. three.js has no
 * cascading dispose, so this is the whole of it.
 *
 * Outline twins share their source mesh's geometry (see `addOutline`), so
 * geometries are collected before being disposed rather than disposed as they
 * are met — disposing the same buffer twice is not an error, but walking a set
 * says what is meant.
 *
 * The `InstancedMesh` itself has to be disposed as well as its geometry. The
 * per-instance transform buffer does not belong to the geometry — it hangs off
 * the object as `instanceMatrix`, and three.js only releases it (and the VAO
 * bound to it) from `InstancedMesh.dispose()`. A city is 74 instanced meshes
 * and ~3.9 MB of instance matrices, so leaving them out meant a rebase freed
 * the shapes and kept the transforms: invisible, unreclaimable, and fatal
 * after enough of them.
 */
export function disposeCity(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
    if (mesh.geometry) geometries.add(mesh.geometry);
    const mat = mesh.material;
    if (Array.isArray(mat)) for (const mm of mat) materials.add(mm);
    else if (mat) materials.add(mat);
  });
  for (const g of geometries) g.dispose();
  for (const mm of materials) mm.dispose();
  group.clear();
  group.removeFromParent();
}
