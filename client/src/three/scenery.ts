import * as THREE from 'three';
import { T_PARK, T_TREES, TILE_SIZE, TREE_Z, type CityMap } from 'shared';
import type { PropState } from 'shared';
import { hash2 } from '../render/noise.js';
import { addOutline, toonMaterial } from './toon.js';
import { spriteGeometry } from './spriteMesh.js';

/**
 * Everything the city is dressed with: planting, and the props the sim owns.
 *
 * The planting is placed with the **same hash and the same thresholds** the
 * 2D tile layer uses (`hash2(tx, ty, 71) > 0.92` for a tree, `> 0.87` for a
 * bush). That is not a coincidence to be tidied away later — it means a park
 * has its trees in the same places in both renderers, so switching views does
 * not rearrange the world, and a landmark you navigate by stays where it was.
 *
 * Props come from the simulation and can be destroyed, so they are placed per
 * frame from the interpolated snapshot rather than baked. Planting cannot, so
 * it is baked once into static instanced meshes.
 *
 * Both are `InstancedMesh`, and both use the same extruded sprite art as
 * everything else — a lamp post in 3D is the `lamp` sprite with its heights
 * taken seriously.
 */

/** Height exaggeration for planting, as `Z_EXAGGERATION` is for bodies. */
const PLANT_ZSCALE = 1.9;
const PROP_Z = 1.5;

/** How far outside the view to keep planting resident, in tiles. */
const PLANT_MARGIN = 40;

interface PlantPool {
  mesh: THREE.InstancedMesh;
  outline: THREE.Mesh | THREE.InstancedMesh;
}

export class SceneryLayer {
  private readonly group = new THREE.Group();
  /**
   * The baked planting, in a group of its own so a new map can replace it.
   *
   * The props share `group` and are placed per frame, so they look after
   * themselves; the planting is baked once per map and would otherwise pile up
   * — a rebase would leave the old region's trees standing in the new one's
   * streets on top of the new region's own.
   */
  private readonly plants = new THREE.Group();
  private map: CityMap | null = null;
  private readonly propPools = new Map<string, { mesh: THREE.InstancedMesh; used: number }>();
  private readonly m = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly up = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    this.group.add(this.plants);
  }

  /**
   * Bake the planting for the whole map.
   *
   * Done once rather than per frame: 57,600 tiles is a lot to walk every
   * frame for something that never moves, and at ~8% coverage the two
   * instanced meshes hold a few thousand plants between them.
   */
  setMap(map: CityMap): void {
    this.map = map;
    // Whatever was planted for the last region goes first. Sprite geometries
    // are cached and shared by every plant of a kind, so only the instanced
    // meshes and their materials are ours to throw away.
    for (const child of [...this.plants.children]) {
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const mm of mat) mm.dispose();
      else mat?.dispose();
    }
    this.plants.clear();

    const tree = spriteGeometry('tree', { zScale: PLANT_ZSCALE });
    const bush = spriteGeometry('bush', { zScale: PLANT_ZSCALE });
    if (!tree || !bush) return;

    const trees: THREE.Matrix4[] = [];
    const bushes: THREE.Matrix4[] = [];
    const W = map.widthTiles;
    const H = map.heightTiles;
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const tile = map.tiles[ty * W + tx] as number;
        // Park and woodland only — the same two the 2D layer treats as lush.
        if (tile !== T_PARK && tile !== T_TREES) continue;
        // Woodland stands 36 px proud: `volume.ts` makes canopy solid to
        // anything on the ground, and `cityGeometry` draws that volume. A tree
        // planted at 0 on top of it was buried inside its own wood — 2350
        // woodland tiles in seed 7 and not one visible tree, which is what
        // made a forest read as a raised lawn.
        const z = tile === T_TREES ? TREE_Z : 0;
        const roll = hash2(tx, ty, 71);
        if (roll > 0.92) {
          this.m.compose(
            this.pos.set((tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE, z),
            // Turn each one differently so a wood is not a grid of clones.
            this.q.setFromAxisAngle(this.up, hash2(tx, ty, 74) * Math.PI * 2),
            this.one,
          );
          trees.push(this.m.clone());
        } else if (roll > 0.87) {
          this.m.compose(
            this.pos.set(
              (tx + 0.3 + hash2(tx, ty, 72) * 0.4) * TILE_SIZE,
              (ty + 0.3 + hash2(tx, ty, 73) * 0.4) * TILE_SIZE,
              z,
            ),
            this.q.setFromAxisAngle(this.up, hash2(tx, ty, 75) * Math.PI * 2),
            this.one,
          );
          bushes.push(this.m.clone());
        }
      }
    }
    this.bake(tree, trees, 1.0);
    this.bake(bush, bushes, 0.8);
  }

  private bake(geom: THREE.BufferGeometry, mats: THREE.Matrix4[], outline: number): PlantPool | null {
    if (mats.length === 0) return null;
    const mat = toonMaterial(0xffffff);
    mat.vertexColors = true;
    const mesh = new THREE.InstancedMesh(geom, mat, mats.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    this.plants.add(mesh);
    const twin = addOutline(mesh, this.plants, outline);
    return { mesh, outline: twin };
  }

  /**
   * Place this frame's props.
   *
   * A broken prop swaps to its `_broken` sprite, which the sheet already
   * carries for every destructible kind — so a bin somebody has driven
   * through looks driven through, from the same art the 2D view uses.
   */
  updateProps(props: readonly PropState[]): void {
    for (const pool of this.propPools.values()) pool.used = 0;

    for (const p of props) {
      const name = p.intact ? p.kind : `${p.kind}_broken`;
      const pool = this.propPool(name) ?? this.propPool(p.kind);
      if (!pool) continue;
      if (pool.used >= pool.mesh.count) continue;
      this.m.compose(
        this.pos.set(p.pos.x, p.pos.y, 0),
        // `orient` is the fence's axis; everything else faces one way and a
        // little hash-driven turn stops a row of bins looking stamped.
        this.q.setFromAxisAngle(
          this.up,
          p.orient === 1 ? Math.PI / 2 : hash2(p.id, p.id * 3, 77) * 0.6 - 0.3,
        ),
        this.one,
      );
      pool.mesh.setMatrixAt(pool.used, this.m);
      pool.used++;
    }

    for (const pool of this.propPools.values()) {
      for (let i = pool.used; i < pool.mesh.count; i++) pool.mesh.setMatrixAt(i, this.zero);
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private propPool(name: string): { mesh: THREE.InstancedMesh; used: number } | null {
    const hit = this.propPools.get(name);
    if (hit) return hit;
    const geom = spriteGeometry(name, { zScale: PROP_Z });
    if (!geom) return null;
    const mat = toonMaterial(0xffffff);
    mat.vertexColors = true;
    const mesh = new THREE.InstancedMesh(geom, mat, 192);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const twin = addOutline(mesh, this.group, 0.9);
    twin.frustumCulled = false;
    const pool = { mesh, used: 0 };
    this.propPools.set(name, pool);
    return pool;
  }
}
