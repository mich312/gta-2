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
import { WORLD_TO_SCENE, cameraPose } from '../src/three/cityView.js';

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

/**
 * Instances inside the frustum, and instances in the city, by chunk sphere.
 *
 * The group is hung under a parent carrying `WORLD_TO_SCENE`, exactly as
 * `CityView` hangs it under `view.world`. Without that the geometry sits at
 * +y and the camera — which `cameraPose` puts on the far side of the flip —
 * looks at −y, so the frustum contains none of the city and the measurement
 * is of an empty room. It still reported a plausible-looking ratio, because
 * the meshes whose bounding sphere covered the whole map intersected anyway.
 */
function submitted(city: THREE.Group, frustum: THREE.Frustum): { drawn: number; total: number } {
  let drawn = 0;
  let total = 0;
  const group = new THREE.Group();
  group.scale.set(WORLD_TO_SCENE.x, WORLD_TO_SCENE.y, WORLD_TO_SCENE.z);
  group.add(city);
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
    //
    // Measured at 0.091 on seed 7. It was 0.184 while the parapets and the
    // rooftop clutter still went in as two city-wide batches.
    expect(drawn / total).toBeLessThan(0.13);
  });

  it('gives nothing but the skirt a bounding sphere bigger than a chunk', () => {
    // The invariant the ratio above is only a symptom of, and the one that
    // actually breaks: a single batch spanning the map is invisible in a
    // draw-call count — it is one draw — and is submitted in full from every
    // camera in the game. Two of them, holding the roof detail, were doing
    // exactly that and were *all* of the geometry surviving the frustum test.
    const map = cityOf(240);
    const { group } = buildCity(map);
    group.updateMatrixWorld(true);
    const wide: string[] = [];
    group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      if ((mesh.material as THREE.Material).type === 'ShaderMaterial') return;
      if (!mesh.boundingSphere) mesh.computeBoundingSphere();
      const r = mesh.boundingSphere!.radius;
      // A chunk is 8 tiles across and a tower is tall, so a legitimate chunk
      // sphere runs to a few hundred px. A quarter of the map is 960.
      if (r > 960) wide.push(`${mesh.count} instances, r=${r | 0}`);
    });
    // The edge skirt is the one honest exception: four slabs of countryside
    // reaching 4096 px past the map on every side, so that the world does not
    // end in sky. It is four instances and it is always on screen anyway.
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatch(/^4 instances/);
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
