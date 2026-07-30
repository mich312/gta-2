import * as THREE from 'three';
import { TILE_SIZE, type CityMap, buildVolumeGrid, spansAt } from 'shared';
import palette from 'shared/data/palette.json';
import { hash2 } from '../render/noise.js';
import { addOutline, toonMaterial } from './toon.js';
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
 * Built from the **volume grid**, not from the tile grid — which is the whole
 * point of the exercise. A span is a box: bottom, top, one tile square. So the
 * thing the collision resolves against and the thing you look at are the same
 * description of the world, and a bridge you can sail under is a bridge you
 * can *see* under, because both come from the same two numbers.
 *
 * Everything is instanced. A 240×240 city is ~57,600 columns and rather more
 * spans; as individual meshes that is a five-figure draw count and a dead
 * frame. As a handful of `InstancedMesh`es it is single digits.
 */

/** Vertical exaggeration, so a 3-storey street reads at a shallow angle. */
const Z_SCALE = 1;

interface Layer {
  /** Which spans go in this layer. */
  match: (tileType: number) => boolean;
  color: number;
}

export interface CityBuild {
  /** Everything the city is made of, in world coordinates. */
  group: THREE.Group;
  /** How many instances it came to, for the debug overlay. */
  instances: number;
}

function hex(s: string): number {
  return parseInt(s.replace('#', ''), 16);
}

/**
 * A building's colour: the same hash and the same palette variants
 * `TileLayer.roofColor` and `ExtrudeLayer` use, so a block is the colour here
 * that it is in the 2D renderer and switching views does not repaint the city.
 */
function roofColor(index: number, district: string): number {
  const variants =
    (palette.buildingVariants as Record<string, string[]>)[district] ??
    palette.buildingVariants.downtown;
  const id = index + 1;
  // `hash2` from the 2D renderer, inlined — it is the only thing three.js
  // needs out of a module full of canvas helpers.
  const h = Math.sin(id * 127.1 + (id * 7 + 3) * 311.7) * 43758.5453;
  const pick = h - Math.floor(h);
  return hex(variants[Math.floor(pick * variants.length) % variants.length] as string);
}

/**
 * Turn every span into a box, batched by what it is.
 *
 * The `ground` layer is one flat plane per tile rather than a deep box — the
 * earth below is `EARTH`-deep and drawing that would waste most of the depth
 * buffer on dirt nobody sees.
 */
export function buildCity(map: CityMap): CityBuild {
  const group = new THREE.Group();
  const vg = buildVolumeGrid(map);
  const W = map.widthTiles;
  const H = map.heightTiles;
  let instances = 0;

  const LAYERS: Record<string, Layer> = {
    road: { match: (t) => t === 1 || t === 13, color: hex(palette.road ?? '#2c3038') },
    pavement: { match: (t) => t === 2, color: hex(palette.sidewalk ?? '#575d68') },
    grass: { match: (t) => t === 4 || t === 0 || t === 11, color: hex(palette.grassDark ?? '#2f4a2a') },
    water: { match: (t) => t === 6, color: hex(palette.water ?? '#25506b') },
    deck: { match: (t) => t === 7, color: hex(palette.road ?? '#2c3038') },
    other: { match: () => true, color: hex(palette.lot ?? '#4a4a44') },
  };

  // Road runs, so a marking can be painted down the middle of a carriageway
  // rather than on every tile edge.
  //
  // A road tile does not know it is a road tile in the middle of a four-lane
  // street; it only knows it is road. The 2D tile layer solves this by
  // measuring the contiguous run through each tile on both axes — on a
  // horizontal road the VERTICAL run is the carriageway width, so its midpoint
  // is the centre line. Same measurement here, so the markings land in the same
  // places in both renderers.
  const isRoad = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const t = map.tiles[ty * W + tx] as number;
    return t === 1 || t === 7 || t === 13;
  };
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
    if (isJunction(tx - 1, ty) || isJunction(tx + 1, ty)) return 1;
    if (isJunction(tx, ty - 1) || isJunction(tx, ty + 1)) return 2;
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

  // Collect one transform per span, bucketed by the colour it resolves to.
  // Buildings get a bucket per palette variant rather than one for all of
  // them: a city where every block is the same grey reads as a model of a
  // city, and the variants already exist for exactly this.
  const buckets = new Map<string, THREE.Matrix4[]>();
  const colorOf = new Map<string, number>();
  const solidKeys = new Set<string>();
  const bucket = (key: string, color: number, solid: boolean): THREE.Matrix4[] => {
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
      colorOf.set(key, color);
      if (solid) solidKeys.add(key);
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
      let key: string;
      let color: number;
      let solid = false;
      if (tile === 3) {
        const bi = (buildingOf[idx] as number) - 1;
        const bd = bi >= 0 ? map.buildings[bi] : undefined;
        color = roofColor(bi, bd?.district ?? 'downtown');
        key = `b${color.toString(16)}`;
        solid = true;
      } else {
        const k = Object.keys(LAYERS).find((n) => (LAYERS[n] as Layer).match(tile)) ?? 'other';
        key = k;
        color = (LAYERS[k] as Layer).color;
        solid = k === 'deck';
        if (k === 'road') {
          // A road tile touching a pavement across its short axis is the
          // mouth of a junction — where a crossing goes.
          const cross = crossing(tx, ty);
          if (cross) key = cross === 1 ? 'crossX' : 'crossY';
          else {
            const mark = roadMark(tx, ty);
            if (mark) key = mark === 1 ? 'roadMarkX' : 'roadMarkY';
          }
        }
      }
      const list = bucket(key, color, solid);

      for (const span of spansAt(vg, tx, ty)) {
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
        m.makeScale(TILE_SIZE, TILE_SIZE, h);
        m.setPosition(
          (tx + 0.5) * TILE_SIZE,
          (ty + 0.5) * TILE_SIZE,
          (span.top * Z_SCALE) - h / 2,
        );
        list.push(m.clone());
        if (tile === 3) heightAt[idx] = span.top * Z_SCALE;
      }
    }
  }

  instances += buildRoofDetail(map, group, heightAt);

  const box = new THREE.BoxGeometry(1, 1, 1);
  for (const [key, mats] of buckets) {
    if (mats.length === 0) continue;
    const color = colorOf.get(key) ?? 0x6b6f7a;
    const solid = solidKeys.has(key);
    // Buildings get a facade — storey lines, window columns, a shopfront on
    // the ground floor — computed in the shader from world position, so one
    // material serves every height. Ground surfaces stay flat toon.
    const material =
      solid && key.startsWith('b')
        ? facadeMaterial({ color })
        : key === 'road'
          ? roadMaterial(color, 0)
          : key === 'roadMarkX'
            ? roadMaterial(color, 1)
            : key === 'roadMarkY'
              ? roadMaterial(color, 2)
              : key === 'crossX'
                ? roadMaterial(color, 3)
                : key === 'crossY'
                  ? roadMaterial(color, 4)
              : key === 'grass'
                ? groundMaterial(color, 0.20)
                : key === 'pavement'
                  ? groundMaterial(color, 0.09, 0.10)
                  : key === 'water'
                    ? toonMaterial(color)
                    : groundMaterial(color, 0.10, 0.05);
    const mesh = new THREE.InstancedMesh(box, material, mats.length);
    mesh.castShadow = solid;
    mesh.receiveShadow = true;
    instances += mats.length;
    mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    // Outline the things that stand up. Outlining every ground tile would
    // draw a black grid over the whole city — the streets read as one
    // surface, and a surface has no silhouette worth tracing.
    // Thin: at this camera a fat hull rounds off box corners into wedges.
    if (solid) addOutline(mesh, group, 0.5);
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
    tx >= 0 && ty >= 0 && tx < W && ty < H && map.tiles[ty * W + tx] === 3;

  const parapets: THREE.Matrix4[] = [];
  const clutter: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const LIP_H = 3.2;
  const LIP_W = 2.4;

  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const idx = ty * W + tx;
      if (map.tiles[idx] !== 3) continue;
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

  const box = new THREE.BoxGeometry(1, 1, 1);
  let instances = 0;
  const add = (mats: THREE.Matrix4[], color: number, outline: number): void => {
    if (mats.length === 0) return;
    const mesh = new THREE.InstancedMesh(box, toonMaterial(color), mats.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    mesh.instanceMatrix.needsUpdate = true;
    instances += mats.length;
    group.add(mesh);
    addOutline(mesh, group, outline);
  };
  add(parapets, hex(palette.roofEdgeLight ?? '#9aa0aa'), 0.4);
  add(clutter, hex(palette.roofUnit ?? '#6b7079'), 0.5);
  return instances;
}

/**
 * Throw a built group away, GPU memory and all.
 *
 * `Object3D.remove` unhooks it from the scene graph and nothing else: the
 * buffers and the compiled programs stay resident, and a session that rebases
 * across a few regions would leak a whole city each time. three.js has no
 * cascading dispose, so this is the whole of it.
 *
 * Outline twins share their source mesh's geometry (see `addOutline`), so
 * geometries are collected before being disposed rather than disposed as they
 * are met — disposing the same buffer twice is not an error, but walking a set
 * says what is meant.
 */
export function disposeCity(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
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
