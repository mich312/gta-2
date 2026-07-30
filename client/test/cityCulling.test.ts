import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  TILE_SIZE,
  type CityMap,
  type WorldgenParams,
  generateCity,
  parseWorldgenParams,
} from 'shared';
import worldgenJson from 'shared/data/worldgen.json';
import { buildCity } from '../src/three/cityGeometry.js';
import { cameraPose } from '../src/three/cityView.js';

/**
 * Does the city reject the parts of itself nobody is looking at?
 *
 * three.js culls an `InstancedMesh` against the bounding sphere of all its
 * instances. One mesh per material spanning a 240×240 map therefore has a
 * bounding sphere covering the entire city, intersects every frustum there is,
 * and is submitted whole from every camera — which is what was happening, and
 * is invisible in a profile that only counts draw calls.
 *
 * So this measures the thing that actually costs: how much geometry survives
 * the frustum test at the camera the game really uses.
 */

/** A full-size city, as the session generates one. */
function cityOf(size: number): CityMap {
  const base = parseWorldgenParams(worldgenJson);
  return generateCity(7, { ...base, widthTiles: size, heightTiles: size } as WorldgenParams);
}

/** The game's own camera: straight down (`main.ts` builds `CityView` at pitch 0). */
function gameFrustum(map: CityMap, viewHeight: number): THREE.Frustum {
  const cx = (map.widthTiles * TILE_SIZE) / 2;
  const cy = (map.heightTiles * TILE_SIZE) / 2;
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 4000);
  // Same construction `CityView.lookAt` uses, so the frustum is the one the
  // player is behind rather than one invented for the test.
  const pose = cameraPose(cx, cy, 0, viewHeight);
  camera.position.copy(pose.position);
  camera.up.copy(pose.up);
  camera.lookAt(pose.target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

/** Instances inside the frustum, and instances in the city, by chunk sphere. */
function submitted(group: THREE.Group, frustum: THREE.Frustum): { drawn: number; total: number } {
  let drawn = 0;
  let total = 0;
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    // Outline twins share their source's instances; counting both would double
    // everything and say nothing extra.
    if ((mesh.material as THREE.Material).type === 'ShaderMaterial') return;
    total += mesh.count;
    if (!mesh.boundingSphere) mesh.computeBoundingSphere();
    const sphere = mesh.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
    if (frustum.intersectsSphere(sphere)) drawn += mesh.count;
  });
  return { drawn, total };
}

describe('the 3D city, culled', () => {
  it('submits a fraction of the map at the camera the game uses', () => {
    const map = cityOf(240);
    const { group } = buildCity(map);
    // 420 world px of height is `viewport.h`'s working figure.
    const { drawn, total } = submitted(group, gameFrustum(map, 420));

    expect(total).toBeGreaterThan(10_000);
    // The whole point. Unchunked this ratio is 1.0 by construction — every
    // mesh's bounding sphere covers the city, so every mesh intersects every
    // frustum — and no profile that counts draw calls would show it.
    expect(drawn / total).toBeLessThan(0.35);
  });

  it('keeps one material per surface however many chunks there are', () => {
    const map = cityOf(240);
    const { group } = buildCity(map);
    const meshes: THREE.InstancedMesh[] = [];
    const materials = new Set<THREE.Material>();
    group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      meshes.push(mesh);
      materials.add(mesh.material as THREE.Material);
    });
    // Chunking multiplies meshes; it must not multiply materials with them, or
    // every chunk costs a shader program and the batching that makes the city
    // affordable is gone.
    expect(meshes.length).toBeGreaterThan(materials.size * 4);
    expect(materials.size).toBeLessThan(80);
  });
});
