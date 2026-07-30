import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TILE_SIZE,
  type CityMap,
  type WorldgenParams,
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
 * The city gets built more than once.
 *
 * With ROAM on, the session recentres its window whenever a player nears the
 * edge and regenerates the whole map at the new origin. The tile layer and the
 * radar were told; the 3D world was not — it was built lazily on the first
 * frame and never again — so from the first rebase onwards it drew the region
 * the player had left. Terrain that did not match the radar, buildings from the
 * old window standing in the middle of the new one's streets, and the whole
 * disagreement arriving at once, the moment a new region was generated.
 *
 * Testable in node because the geometry is a function of a map rather than a
 * method on the class that owns the `WebGLRenderer`. Which is most of why it is
 * a function of a map.
 */

const SMALL: Partial<WorldgenParams> = { widthTiles: 64, heightTiles: 64 };

/** Two windows onto the same world: what a rebase moves between. */
function windowAt(x: number, y: number): CityMap {
  const base = parseWorldgenParams(worldgenJson);
  return generateCity(7, { ...base, ...SMALL, windowX: x, windowY: y } as WorldgenParams);
}

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

describe('rebuilding the city when the window moves', () => {
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
