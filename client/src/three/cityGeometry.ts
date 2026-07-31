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
  type CityMap,
  type Span,
  EARTH,
  districtAt,
  buildVolumeGrid,
  spansAt,
} from 'shared';
import palette from 'shared/data/palette.json';
import { hash2 } from '../render/noise.js';
import { ARTERIAL_WIDTH } from '../render/tiles.js';
import { addOutline, outlineMaterial, toonMaterial } from './toon.js';
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

/** Vertical exaggeration, so a 3-storey street reads at a shallow angle. */
const Z_SCALE = 1;

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
  const vg = buildVolumeGrid(map);
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
  /** Wide both ways: where two streets actually meet. */
  const isJunction = (tx: number, ty: number): boolean => {
    if (!isRoad(tx, ty)) return false;
    const [runV, runH] = runs(tx, ty);
    return runV > 6 && runH > 6;
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
    const [runV, runH] = runs(tx, ty);
    if (isJunction(tx - 1, ty) || isJunction(tx + 1, ty)) {
      return runV >= ARTERIAL_WIDTH ? 1 : 0;
    }
    if (isJunction(tx, ty - 1) || isJunction(tx, ty + 1)) {
      return runH >= ARTERIAL_WIDTH ? 2 : 0;
    }
    return 0;
  };
  /** 0 plain, 1 centre line along x, 2 centre line along y. */
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
    // A junction is wide both ways; leave it unmarked rather than crossing two
    // centre lines through it.
    if (runV > 6 && runH > 6) return 0;
    if (runH >= runV) {
      // Horizontal street: centre line where the vertical run's midpoint is.
      return up === Math.floor((runV - 1) / 2) ? 1 : 0;
    }
    return left === Math.floor((runH - 1) / 2) ? 2 : 0;
  };
  /**
   * Runway centreline: dashed, along the strip, on the tiles with runway both
   * sides of them. The same rule and the same cadence `paintRunway` uses, so
   * the strip is marked out the same way in both renderers — and marked out as
   * a runway rather than as a B-road.
   */
  const runwayMark = (tx: number, ty: number): boolean =>
    tileAt(tx, ty - 1) === T_RUNWAY && tileAt(tx, ty + 1) === T_RUNWAY && tx % 2 === 0;

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
  const buckets = new Map<string, THREE.Matrix4[]>();
  const surfaceOf = new Map<string, Surface>();
  const bucket = (tx: number, ty: number, surface: Surface): THREE.Matrix4[] => {
    const chunk = Math.floor(ty / CHUNK_TILES) * chunksX + Math.floor(tx / CHUNK_TILES);
    const key = `${chunk}|${surface.key}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
      surfaceOf.set(key, surface);
    }
    return list;
  };

  /** Roof height per tile, filled as the grid is walked. */
  const heightAt = new Float64Array(W * H);

  const m = new THREE.Matrix4();
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
            if (mark) surface = { ...surface, key: mark === 1 ? 'roadMarkX' : 'roadMarkY' };
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
      const list = bucket(tx, ty, surface);

      for (const span of drawnSpans(tile, spansAt(vg, tx, ty))) {
        // Clamp the earth to something shallow: a ground span runs from
        // EARTH (-4096) and nobody is looking at the bottom of it.
        //
        // Clamp to a fixed FLOOR, not to `top - depth`. Clamping relative
        // to the top capped every building at the same height whatever its
        // storeys said, because a building span also starts at EARTH — a
        // twelve-storey tower drew exactly as tall as a bungalow, which is
        // the whole point of having heights at all.
        const bottom = Math.max(span.bottom, -16);
        const h = Math.max(1, (span.top - bottom) * Z_SCALE);
        // A hair wider than the tile so neighbours overlap rather than meet.
        // Boxes that share an edge exactly leave the rasteriser to break the
        // tie, and it breaks it in favour of the darker side wall — scoring
        // every roof, road and stretch of water with a dark 1 px line on a
        // 16 px grid. That regular scratching is the first thing in the frame
        // that reads as an engine artefact rather than as art.
        m.makeScale(TILE_SIZE + SEAM_OVERLAP, TILE_SIZE + SEAM_OVERLAP, h);
        m.setPosition(
          (tx + 0.5) * TILE_SIZE,
          (ty + 0.5) * TILE_SIZE,
          (span.top * Z_SCALE) - h / 2,
        );
        list.push(m.clone());
        if (tile === T_BUILDING) heightAt[idx] = span.top * Z_SCALE;
      }
    }
  }

  instances += buildRoofDetail(map, group, heightAt);
  instances += buildBridgeRails(map, group);
  instances += buildEdgeSkirt(map, group);

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
        : key === 'roadMarkX'
          ? roadMaterial(color, 1, surface.line)
          : key === 'roadMarkY'
            ? roadMaterial(color, 2, surface.line)
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

  for (const [key, mats] of buckets) {
    if (mats.length === 0) continue;
    const surface = surfaceOf.get(key) ?? DEFAULT_SURFACE;
    const mesh = new THREE.InstancedMesh(box, materialFor(surface), mats.length);
    mesh.castShadow = surface.solid === true;
    mesh.receiveShadow = true;
    instances += mats.length;
    mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    // Outline the things that stand up. Outlining every ground tile would
    // draw a black grid over the whole city — the streets read as one
    // surface, and a surface has no silhouette worth tracing.
    // Thin: at this camera a fat hull rounds off box corners into wedges.
    if (surface.solid) addOutline(mesh, group, BUILDING_OUTLINE, cityOutline);
  }

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
function buildRoofDetail(map: CityMap, group: THREE.Group, heightAt: Float64Array): number {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const isBuilding = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < W && ty < H && map.tiles[ty * W + tx] === T_BUILDING;

  const parapets: THREE.Matrix4[] = [];
  const clutter: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const LIP_H = 3.2;
  const LIP_W = 2.4;

  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const idx = ty * W + tx;
      if (map.tiles[idx] !== T_BUILDING) continue;
      const top = heightAt[idx] as number;
      if (top <= 0) continue;
      const cx = (tx + 0.5) * T;
      const cy = (ty + 0.5) * T;

      const openN = !isBuilding(tx, ty - 1);
      const openS = !isBuilding(tx, ty + 1);
      const openW = !isBuilding(tx - 1, ty);
      const openE = !isBuilding(tx + 1, ty);

      const lip = (x: number, y: number, w: number, d: number): void => {
        m.makeScale(w, d, LIP_H);
        m.setPosition(x, y, top + LIP_H / 2);
        parapets.push(m.clone());
      };
      if (openN) lip(cx, cy - T / 2 + LIP_W / 2, T, LIP_W);
      if (openS) lip(cx, cy + T / 2 - LIP_W / 2, T, LIP_W);
      if (openW) lip(cx - T / 2 + LIP_W / 2, cy, LIP_W, T);
      if (openE) lip(cx + T / 2 - LIP_W / 2, cy, LIP_W, T);

      // Interior only — same rule and same salt the 2D roof painter uses.
      if (openN || openS || openE || openW) continue;
      const roll = hash2(tx, ty, 61);
      if (roll > 0.86) {
        m.makeScale(T * 0.5, T * 0.38, 6);
        m.setPosition(cx, cy, top + 3);
        clutter.push(m.clone());
      } else if (roll > 0.74) {
        m.makeScale(T * 0.25, T * 0.25, 4);
        m.setPosition(cx, cy, top + 2);
        clutter.push(m.clone());
      } else if (roll > 0.68) {
        m.makeScale(T * 0.36, T * 0.3, 2);
        m.setPosition(cx, cy, top + 1);
        clutter.push(m.clone());
      }
    }
  }

  let instances = 0;
  instances += addBoxes(group, parapets, col('roofEdgeLight', 0x8f97a6), 0.4);
  instances += addBoxes(group, clutter, col('roofUnit', 0x6b7079), 0.5);
  return instances;
}

/**
 * The rails along a bridge deck.
 *
 * `paintBridge` draws these in 2D, and they are what says "bridge" rather than
 * "a stretch of road that happens to have water beside it" — which is all the
 * deck reads as now that it sits at the height the game drives at.
 *
 * On the sides that face open water, and only those. The 2D painter rails
 * whichever axis the deck runs along and lets consecutive tiles overlap into
 * one line; in 3D that would stand a parapet down the middle of the
 * carriageway, and picking the axis per tile leaves stray posts on the deck
 * wherever the shoreline crosses it at an angle. "Is there river on this side"
 * is the question a parapet actually answers, so it is the one asked.
 */
function buildBridgeRails(map: CityMap, group: THREE.Group): number {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const T = TILE_SIZE;
  const RAIL_H = 5;
  const RAIL_W = 2;
  const at = (tx: number, ty: number): number =>
    tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : (map.tiles[ty * W + tx] as number);

  const rails: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (at(tx, ty) !== T_BRIDGE) continue;
      const cx = (tx + 0.5) * T;
      const cy = (ty + 0.5) * T;
      const rail = (x: number, y: number, w: number, d: number): void => {
        m.makeScale(w, d, RAIL_H);
        m.setPosition(x, y, RAIL_H / 2);
        rails.push(m.clone());
      };
      if (at(tx, ty - 1) === T_WATER) rail(cx, cy - T / 2 + RAIL_W / 2, T, RAIL_W);
      if (at(tx, ty + 1) === T_WATER) rail(cx, cy + T / 2 - RAIL_W / 2, T, RAIL_W);
      if (at(tx - 1, ty) === T_WATER) rail(cx - T / 2 + RAIL_W / 2, cy, RAIL_W, T);
      if (at(tx + 1, ty) === T_WATER) rail(cx + T / 2 - RAIL_W / 2, cy, RAIL_W, T);
    }
  }
  return addBoxes(group, rails, col('kerb', 0x787d86), 0.4);
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
  const m = new THREE.Matrix4();
  const slabs: THREE.Matrix4[] = [];
  const slab = (x: number, y: number, sx: number, sy: number): void => {
    m.makeScale(sx, sy, 8);
    m.setPosition(x, y, -4);
    slabs.push(m.clone());
  };
  slab(w / 2, -OUT / 2, w + OUT * 2, OUT);
  slab(w / 2, h + OUT / 2, w + OUT * 2, OUT);
  slab(-OUT / 2, h / 2, OUT, h);
  slab(w + OUT / 2, h / 2, OUT, h);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    groundMaterial(col('field', 0x2b3630), 0.2),
    slabs.length,
  );
  mesh.receiveShadow = true;
  slabs.forEach((mm, i) => mesh.setMatrixAt(i, mm));
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return slabs.length;
}

/** One instanced batch of boxes, outlined. */
function addBoxes(
  group: THREE.Group,
  mats: THREE.Matrix4[],
  color: number,
  outline: number,
): number {
  if (mats.length === 0) return 0;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), toonMaterial(color), mats.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  addOutline(mesh, group, outline);
  return mats.length;
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
