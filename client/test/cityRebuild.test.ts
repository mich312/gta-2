import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TILE_SIZE,
  type CityMap,
  generateCity,
  initTuning,
  parseWorldgenParams,
} from 'shared';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import trafficJson from 'shared/data/traffic.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
import worldgenJson from 'shared/data/worldgen.json';
import { buildCity, disposeCity } from '../src/three/cityGeometry.js';
import { SceneryLayer } from '../src/three/scenery.js';

/**
 * The city gets built more than once, and the second build has to REPLACE the
 * first rather than land on top of it.
 *
 * The bug this pins was a roaming one: the session used to recentre its window
 * and regenerate the map under the view, and the 3D world — built lazily on
 * the first frame and never again — went on drawing the region the player had
 * left. There is one city now and it never moves, so the fault can no longer
 * be reached that way; the machinery it broke is still here and still worth
 * holding, because `setMap` is called whenever the client adopts a map at all
 * and "replaces" versus "adds to" is the difference between a city and two
 * cities in the same place.
 *
 * The two maps below are therefore made rather than generated: the real one,
 * and the real one with its ground rolled a few tiles. Any two DIFFERENT maps
 * would do — the claim is about the renderer, not about worldgen.
 *
 * Testable in node because the geometry is a function of a map rather than a
 * method on the class that owns the `WebGLRenderer`. Which is most of why it is
 * a function of a map.
 */

const CITY: CityMap = generateCity(7, parseWorldgenParams(worldgenJson));

/**
 * The city with its ground rolled by a few tiles, wrapping at the edges: a
 * different map, built the same way, with every list moved to match.
 */
function rolled(dx: number, dy: number): CityMap {
  const W = CITY.widthTiles;
  const H = CITY.heightTiles;
  const roll = (plane: Uint8Array): Uint8Array => {
    const out = new Uint8Array(plane.length);
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        out[((ty + dy + H) % H) * W + ((tx + dx + W) % W)] = plane[ty * W + tx] as number;
      }
    }
    return out;
  };
  const movedTile = <T extends { x: number; y: number }>(v: T): T => ({
    ...v,
    x: ((v.x + dx) % W + W) % W,
    y: ((v.y + dy) % H + H) % H,
  });
  const movedPx = <T extends { x: number; y: number }>(v: T): T => ({
    ...v,
    x: ((v.x + dx * TILE_SIZE) % CITY.widthPx + CITY.widthPx) % CITY.widthPx,
    y: ((v.y + dy * TILE_SIZE) % CITY.heightPx + CITY.heightPx) % CITY.heightPx,
  });
  return {
    ...CITY,
    tiles: roll(CITY.tiles),
    district: roll(CITY.district),
    blocks: CITY.blocks.map(movedTile),
    buildings: CITY.buildings.map(movedTile),
    landmarks: CITY.landmarks.map(movedTile),
    shops: [],
    propSpawns: CITY.propSpawns.map(movedPx),
    pedSpawns: CITY.pedSpawns.map(movedPx),
    pickupSpawns: CITY.pickupSpawns.map(movedPx),
    vehicleSpawns: CITY.vehicleSpawns.map(movedPx),
    parkingSpots: CITY.parkingSpots.map(movedPx),
  };
}

/** The two maps every test here builds and rebuilds between. */
const windowAt = (x: number, y: number): CityMap =>
  x === 0 && y === 0 ? CITY : rolled(Math.round(x / 8), Math.round(y / 8));

/** Every instance transform in a built group, as a flat list of positions. */
function positions(group: THREE.Group): string[] {
  const out: string[] = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  group.traverse((o) => {
    const inst = o as THREE.InstancedMesh;
    if (!inst.isInstancedMesh) return;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m);
      v.setFromMatrixPosition(m);
      out.push(`${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`);
    }
  });
  return out;
}

describe('rebuilding the city', () => {
  beforeAll(() => {
    initTuning({
      player: playerTuning,
      vehicles: vehiclesJson,
      traffic: trafficJson,
      peds: pedsJson,
      police: policeJson,
      props: propsJson,
      weapons: weaponsJson,
    });
  });

  it('builds a different city for a different window', () => {
    // The premise. If two windows onto the same seed gave the same geometry
    // there would be nothing to rebuild and nothing to get wrong.
    const here = positions(buildCity(windowAt(0, 0)).group);
    const there = positions(buildCity(windowAt(80, 80)).group);
    expect(here.length).toBeGreaterThan(0);
    expect(there).not.toEqual(here);
  });

  it('builds the same city for the same window', () => {
    // Worth pinning: the rebuild has to be a function of the map alone, or the
    // 3D world and the radar would disagree for reasons nobody can reproduce.
    expect(positions(buildCity(windowAt(40, 0)).group)).toEqual(
      positions(buildCity(windowAt(40, 0)).group),
    );
  });

  it('leaves nothing of the old city behind', () => {
    const world = new THREE.Group();
    const first = buildCity(windowAt(0, 0));
    world.add(first.group);
    const before = positions(world as THREE.Group);

    disposeCity(first.group);
    const second = buildCity(windowAt(80, 80));
    world.add(second.group);
    const after = positions(world as THREE.Group);

    // Not the old geometry plus the new — the new, on its own. Both halves
    // matter: `world.children` growing is the leak, and the old positions
    // surviving is what put walls in the new region's streets.
    expect(world.children).toHaveLength(1);
    expect(after).toEqual(positions(second.group));
    expect(after).not.toEqual(before);
  });

  it('gives back the GPU memory rather than only unhooking the group', () => {
    const built = buildCity(windowAt(0, 0));
    const disposed: string[] = [];
    let instanced = 0;
    let instancedDisposed = 0;
    built.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.addEventListener('dispose', () => disposed.push('geometry'));
      const mat = mesh.material as THREE.Material | undefined;
      if (mat && !Array.isArray(mat)) mat.addEventListener('dispose', () => disposed.push('material'));
      // The mesh itself, which is the one that was being missed. An
      // `InstancedMesh` owns its per-instance transform buffer — it is not
      // part of the geometry — and three.js frees that buffer and the VAO
      // bound to it only from `InstancedMesh.dispose()`. A city is ~74 of
      // them holding ~3.9 MB of matrices, so disposing the geometry and the
      // material while leaving the mesh alone freed the shapes and kept the
      // transforms, once per rebase, until the context was lost.
      //
      // This assertion is the point of the test: the two above it were both
      // passing while that was happening.
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        instanced++;
        mesh.addEventListener('dispose', () => instancedDisposed++);
      }
    });
    disposeCity(built.group);
    // A session that crosses a few regions would otherwise leave a whole
    // city's buffers resident for each one it has left.
    expect(disposed).toContain('geometry');
    expect(disposed).toContain('material');
    expect(instanced).toBeGreaterThan(0);
    expect(instancedDisposed).toBe(instanced);
  });

  it('replants rather than piling planting on planting', () => {
    // Same fault, one layer over: the trees are baked per map, so a second
    // `setMap` used to leave the old region's wood standing in the new one.
    // Both windows have to be planted ones, or "nothing there afterwards"
    // passes for "replaced" and the test proves nothing.
    const parent = new THREE.Group();
    const scenery = new SceneryLayer(parent);
    scenery.setMap(windowAt(0, 0));
    const first = positions(parent);
    scenery.setMap(windowAt(32, 96));
    const second = positions(parent);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
    // The giveaway for accumulation: every old tree still there, with the new
    // ones added after them.
    expect(second.slice(0, first.length)).not.toEqual(first);
  });

  it('plants where the new map says, not where the old one did', () => {
    const parent = new THREE.Group();
    const scenery = new SceneryLayer(parent);
    const map = windowAt(32, 96);
    scenery.setMap(windowAt(0, 0));
    scenery.setMap(map);
    expect(positions(parent).length).toBeGreaterThan(0);

    // Every plant has to stand on park or woodland in the map now in force.
    const lush = new Set([4, 11]);
    const off = positions(parent).filter((p) => {
      const [x, y] = p.split(',').map(Number) as [number, number];
      const tx = Math.floor(x / TILE_SIZE);
      const ty = Math.floor(y / TILE_SIZE);
      if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
      return !lush.has(map.tiles[ty * map.widthTiles + tx] as number);
    });
    expect(off).toEqual([]);
  });
});
