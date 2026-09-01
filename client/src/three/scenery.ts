import * as THREE from 'three';
import { T_PARK, T_TREES, TILE_SIZE, TREE_Z, buildWoodCut, chainSide, type CityMap } from 'shared';
import type { PropState } from 'shared';
import { Z_SCALE } from '../render/config.js';
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

/**
 * Height per plant. Trees and bushes are not one family.
 *
 * At a shared 1.9 a tree came out 13.3 world px against a 17 px canopy width —
 * a mound, wider than it was tall — and a bush came out at 64% of it, which is
 * a sapling rather than a shrub. Splitting them is what makes a bush read as
 * ground cover and a tree as something you stand under.
 *
 * The tree stops well short of the 3-4x a real street tree would want, and the
 * binding reason is shape rather than the occlusion ceiling. The canopy is a
 * disc extruded from the ground, so there is no trunk under it: past about here
 * raising the number stops making a taller tree and starts making a taller
 * drum, and at 2.85 a park reads as a field of green oil barrels. 2.2 is enough
 * to lift it off the mound it was without reaching that. A tree that is
 * actually a tree needs a trunk, which needs a per-shape floor -- see the note
 * in spriteMesh.ts.
 */
const TREE_ZSCALE = 2.2;
const BUSH_ZSCALE = 1.2;
/**
 * Fallback height for a prop with no entry below.
 *
 * 1.0, not 1.5: an unknown prop should default to something ankle-to-knee high,
 * not to a person's height.
 */
const PROP_Z = 1.0;

/**
 * Per-prop height, where one multiplier for all of them is wrong.
 *
 * The authored `z` in `sprites.json` is a relighting hint for flat art, not a
 * height, and the props are where treating it as one shows worst. At a flat
 * 1.5 a street lamp came out 9.0 world px against a pedestrian's 9.75 — every
 * lamp in the city stopping at shoulder height — while the things you can walk
 * straight through (the sim gives props no collision at all) were drawn as
 * chest-high walls and the player ended up standing inside them.
 *
 * **The occlusion ceiling.** Seen straight down, an object of height `h` hides
 * a strip of ground behind it `r*(h - h_t)/(H - h)` deep, pointing radially
 * outward from the screen centre. Past 20 world px that strip is wider than a
 * pedestrian at the frame corner, so people and pickups genuinely vanish behind
 * street furniture. Nothing here may exceed it.
 *
 * **And a slenderness limit**, which binds harder for exactly these objects: a
 * thing whose top leans further than about twice its own plan width stops
 * reading as tall and starts reading as fallen over. A lamp is 4.5 px wide in
 * plan, so it may be about 14 px tall and no more.
 *
 * That last one is why the lamp comes *down* from the 30 px it was given when
 * the fix was "lamps are shorter than pedestrians". At 30 it was the tallest
 * object in the game, taller than any vehicle, and it swept the same screen
 * area as a pedestrian with more contrast — so a prop with no gameplay meaning
 * was outranking the people you are supposed to be watching, and reading as a
 * plank lying in the road rather than a post standing in it. Its light pool
 * carries it at night, which is the one channel this camera renders well.
 */
const PROP_Z_BY_KIND: Readonly<Record<string, number>> = Object.freeze({
  lamp: 2.33,
  bin: 1.0,
  bench: 0.9,
  fence: 0.9,
  hydrant: 0.75,
  barrel: 1.1,
  crate: 1.15,
});

function propZ(name: string): number {
  return PROP_Z_BY_KIND[name.replace(/_broken$/, '')] ?? PROP_Z;
}

/** How far outside the view to keep planting resident, in tiles. */
const PLANT_MARGIN = 40;

/** One kind of prop: a pool of instances, the outline twin, and this frame's fill. */
interface PropPool {
  mesh: THREE.InstancedMesh;
  /** Shares `mesh.instanceMatrix`, so its `count` has to be shortened too. */
  outline: THREE.InstancedMesh;
  /** What the buffers hold. `mesh.count` is this frame's draw length. */
  capacity: number;
  used: number;
}

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
  private readonly propPools = new Map<string, PropPool>();
  private readonly m = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
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
    // meshes and their materials are ours to throw away — plus the instance
    // matrices, which belong to the mesh rather than to either of those and
    // are freed only by `InstancedMesh.dispose()`.
    for (const child of [...this.plants.children]) {
      const mesh = child as THREE.Mesh;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const mm of mat) mm.dispose();
      else mat?.dispose();
    }
    this.plants.clear();

    const tree = spriteGeometry('tree', { zScale: TREE_ZSCALE });
    const bush = spriteGeometry('bush', { zScale: BUSH_ZSCALE });
    if (!tree || !bush) return;

    const trees: THREE.Matrix4[] = [];
    const bushes: THREE.Matrix4[] = [];
    const W = map.widthTiles;
    const H = map.heightTiles;
    // The woodland edge as a curve (§46). `cityGeometry` cuts the canopy
    // PLATEAU on this chord; the planting has to follow it or the canopy ends
    // in a chord with trees standing off the end of it, in mid-air over the
    // meadow — which is the same mistake as drawing the plateau square, one
    // layer up. `woodCut` puts open country on the RIGHT of travel and
    // `chainSide` returns -1 there, so a plant survives where it comes back
    // positive — the same side `buildWoodPrisms` lays the canopy over.
    const woodCut = buildWoodCut(map.tiles, W, H);
    /** Is this jittered plant still inside the wood the curve describes? */
    const inWood = (tx: number, ty: number, jx: number, jy: number): boolean => {
      const seg = woodCut.get(ty * W + tx);
      if (seg === undefined) return true;
      return chainSide(seg, jx - tx, jy - ty) > 0;
    };
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const tile = map.tiles[ty * W + tx] as number;
        // Park and woodland only — the same two the 2D layer treats as lush.
        if (tile !== T_PARK && tile !== T_TREES) continue;
        // Woodland stands proud: `volume.ts` makes canopy solid to anything on
        // the ground, and `cityGeometry` draws that volume. A tree planted at 0
        // on top of it was buried inside its own wood — 2350 woodland tiles in
        // seed 7 and not one visible tree, which is what made a forest read as
        // a raised lawn.
        //
        // At `Z_SCALE`, because that is what the canopy underneath is drawn at.
        // These two numbers are the same number: the day one of them is scaled
        // and the other is not, every tree in the city is planted in mid-air.
        const z = tile === T_TREES ? TREE_Z * Z_SCALE : 0;
        const roll = hash2(tx, ty, 71);
        // Woodland is CANOPY, not lawn-with-trees (PLAN-WORLDGEN.md wave
        // 3.3): at the park's 8% planting rate the wood's raised box read
        // as a flat dark plateau with a few clones stood on it — "a stain
        // on the grass" from the flyover. The box has to stay (it IS the
        // collision volume `volume.ts` promises), so the fix is its top:
        // woodland plants at ~45%, jittered and size-varied like every
        // §34 tree, and the plateau becomes a lumpy continuous canopy.
        // Parks keep their sparse ornamental planting.
        const treeAt = tile === T_TREES ? 0.55 : 0.92;
        if (roll > treeAt) {
          // Jittered off the tile centre and scaled per tree (§34). Rotation
          // alone was not enough: a trunk is round, so turning it changes
          // nothing you can see, and a wood came out as a square lattice of
          // identical clones — the tile grid showing through the one thing in
          // the city that has no business admitting it exists. The bushes
          // beside this branch have had the jitter since they were written;
          // the trees simply never got it.
          const jx = tx + 0.2 + hash2(tx, ty, 76) * 0.6;
          const jy = ty + 0.2 + hash2(tx, ty, 77) * 0.6;
          if (!inWood(tx, ty, jx, jy)) continue;
          const grow = 0.8 + hash2(tx, ty, 78) * 0.45;
          this.one.set(grow, grow, grow);
          this.m.compose(
            this.pos.set(jx * TILE_SIZE, jy * TILE_SIZE, z),
            // Turn each one differently so a wood is not a grid of clones.
            this.q.setFromAxisAngle(this.up, hash2(tx, ty, 74) * Math.PI * 2),
            this.one,
          );
          this.one.set(1, 1, 1);
          trees.push(this.m.clone());
        } else if (roll > 0.87) {
          const grow = 0.75 + hash2(tx, ty, 79) * 0.5;
          this.one.set(grow, grow, grow);
          this.m.compose(
            this.pos.set(
              (tx + 0.3 + hash2(tx, ty, 72) * 0.4) * TILE_SIZE,
              (ty + 0.3 + hash2(tx, ty, 73) * 0.4) * TILE_SIZE,
              z,
            ),
            this.q.setFromAxisAngle(this.up, hash2(tx, ty, 75) * Math.PI * 2),
            this.one,
          );
          this.one.set(1, 1, 1);
          bushes.push(this.m.clone());
        }
      }
    }
    this.bake(tree, trees, 0.9);
    this.bake(bush, bushes, 0.55);
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
      // `capacity`, not `mesh.count`: the count is this frame's draw length
      // and was shortened to last frame's population at the end of the last
      // one, so testing against it would stop a pool ever growing again.
      if (pool.used >= pool.capacity) continue;
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

    // Draw only what was placed this frame, the way `Pool.end` and
    // `SolidPool.end` do it. Zero-scaling the tail collapses it on screen but
    // still transforms it, still counts it and still walks it in the shadow
    // pass — and the outline twin, which shares this `instanceMatrix`, pays
    // for it a second time. Pools are 192 and the fullest one on the shipped
    // city holds 55, so the tail was most of the cost.
    for (const pool of this.propPools.values()) {
      pool.mesh.count = pool.used;
      pool.outline.count = pool.used;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private propPool(name: string): PropPool | null {
    const hit = this.propPools.get(name);
    if (hit) return hit;
    const geom = spriteGeometry(name, { zScale: propZ(name) });
    if (!geom) return null;
    const mat = toonMaterial(0xffffff);
    mat.vertexColors = true;
    const mesh = new THREE.InstancedMesh(geom, mat, 192);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    // Thinner than it looks like it should be. The hull fattens in world
    // units, so one weight for every prop adds the same 1.8 px to a lamp post
    // and to a fence rail that is 1.0 px thick — which swallows the rail and
    // renders a fence as a dark lattice. The lamp is the one that needs weight
    // at distance, and it is tall enough to carry it.
    const twin = addOutline(mesh, this.group, name.startsWith('lamp') ? 0.8 : 0.55);
    twin.frustumCulled = false;
    const pool = { mesh, outline: twin as THREE.InstancedMesh, capacity: mesh.count, used: 0 };
    this.propPools.set(name, pool);
    return pool;
  }
}
