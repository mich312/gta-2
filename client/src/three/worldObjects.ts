import * as THREE from 'three';
import {
  CARDINALS,
  type CityMap,
  getTrafficTuning,
  signalColour,
} from 'shared';
import {
  PACKAGE_COLOR,
  PACKAGE_TAKEN,
  PICKUP_COLORS,
  SIGNAL_COLORS,
  type Scene,
} from '../render/renderer.js';
import { addOutline, toonMaterial } from './toon.js';

/**
 * The things the city puts on the ground that are neither terrain nor a body:
 * pickups, hidden packages, traffic signals and projectiles.
 *
 * All four were 2D-only. Missing pickups is the one you notice first — a health
 * crate you cannot see is a health crate you do not take — but the signals are
 * the one that changes how the game plays, because the traffic obeys them and
 * until now only the 2D player could see what the traffic was obeying.
 *
 * Colours come from the 2D renderer's own tables rather than a second set here.
 * A health crate that is green in one view and blue in the other is not the same
 * city, and the way to guarantee it is one definition, not two that match today.
 *
 * Everything is instanced and rebuilt per frame. The counts are small (a few
 * dozen pickups, a few hundred signal heads in view) and the *state* changes
 * every frame — a signal's colour, a package's glint, a pickup's bob — so a
 * baked mesh would have to be rewritten anyway.
 */

/** Culling margin in world px, matching the 2D renderer's. */
const MARGIN = 24;

/** How high things sit off the road, in world px. */
const PICKUP_Z = 5;
const PACKAGE_Z = 4;
const SIGNAL_HEAD_Z = 26;
const PROJECTILE_Z = 6;

/**
 * Paint a geometry white, so `instanceColor` has something to multiply.
 *
 * `vertexColors` is what makes three.js apply a per-instance colour at all, and
 * it compiles `vColor *= color` into the shader whether or not the geometry
 * carries a `color` attribute. An unbound attribute reads as (0, 0, 0), so
 * without this every instance came out **black** — which is how a city full of
 * traffic signals ended up with heads you could not read the phase off.
 */
function whitened(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geometry.getAttribute('position').count;
  const white = new Float32Array(n * 3).fill(1);
  geometry.setAttribute('color', new THREE.BufferAttribute(white, 3));
  return geometry;
}

/**
 * A pool of instanced solids, coloured per instance.
 *
 * One colour per instance is the whole point: a signal head is red, amber or
 * green, and a pool that could only be one colour would rather defeat the
 * object of a signal.
 */
class SolidPool {
  private readonly mesh: THREE.InstancedMesh;
  /** What the buffers hold. `mesh.count` is how many are drawn this frame. */
  private readonly capacity: number;
  private readonly outline: THREE.InstancedMesh;
  private used = 0;
  private readonly m = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 0, 1);
  private readonly color = new THREE.Color();

  constructor(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    capacity: number,
    outline: number,
  ) {
    const material = toonMaterial(0xffffff);
    material.vertexColors = true;
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(whitened(geometry), material, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Rebuilt every frame from wherever the camera is; a bounding sphere
    // computed once would cull the lot the moment it moved.
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    this.outline = addOutline(this.mesh, parent, outline) as THREE.InstancedMesh;
    this.outline.frustumCulled = false;
  }

  begin(): void {
    this.used = 0;
  }

  put(x: number, y: number, z: number, scale: number, angle: number, css: string): void {
    const i = this.used;
    if (i >= this.capacity) return;
    this.m.compose(
      this.pos.set(x, y, z),
      this.quat.setFromAxisAngle(this.up, angle),
      this.scl.set(scale, scale, scale),
    );
    this.mesh.setMatrixAt(i, this.m);
    this.color.set(cssRgb(css));
    this.mesh.setColorAt(i, this.color);
    this.used++;
  }

  /** As `put`, but with independent extents — a dropped gun is not a cube. */
  putBox(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    angle: number,
    css: string,
  ): void {
    const i = this.used;
    if (i >= this.capacity) return;
    this.m.compose(
      this.pos.set(x, y, z),
      this.quat.setFromAxisAngle(this.up, angle),
      this.scl.set(sx, sy, sz),
    );
    this.mesh.setMatrixAt(i, this.m);
    this.color.set(cssRgb(css));
    this.mesh.setColorAt(i, this.color);
    this.used++;
  }

  /**
   * Draw only what was placed this frame.
   *
   * Shortening `count` rather than zero-scaling the tail: a collapsed instance
   * still goes through the vertex shader and the shadow pass, and the outline
   * twin pays for it a second time.
   */
  end(): void {
    this.mesh.count = this.used;
    this.outline.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.outline.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Strip the alpha off a CSS colour so `THREE.Color` will take it.
 *
 * The 2D tables carry `rgba()` for the things it draws translucently — a taken
 * package, for one. Solid geometry has no use for the fourth channel, and
 * `THREE.Color` drops it silently, so this only makes the intent explicit.
 */
function cssRgb(css: string): string {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/.exec(css);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : css;
}

export class WorldObjectsLayer {
  private readonly group = new THREE.Group();
  private map: CityMap | null = null;

  /** Diamonds: health, armour, ammo, power-ups. Octahedra, as they read in 2D. */
  private readonly crates: SolidPool;
  /** Dropped weapons, packages and mines: small boxes. */
  private readonly boxes: SolidPool;
  /** Signal posts and their heads. */
  private readonly posts: SolidPool;
  private readonly heads: SolidPool;
  /** Rockets in flight. */
  private readonly rockets: SolidPool;

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    // An octahedron IS the 2D diamond, turned into a solid: same silhouette
    // from directly overhead, and it catches the light on its faces from any
    // other angle.
    this.crates = new SolidPool(this.group, new THREE.OctahedronGeometry(0.5), 96, 0.7);
    this.boxes = new SolidPool(this.group, new THREE.BoxGeometry(1, 1, 1), 512, 0.6);
    this.posts = new SolidPool(this.group, new THREE.BoxGeometry(1, 1, 1), 512, 0.5);
    this.heads = new SolidPool(this.group, new THREE.BoxGeometry(1, 1, 1), 512, 0.5);
    this.rockets = new SolidPool(this.group, new THREE.BoxGeometry(1, 1, 1), 48, 0.6);
  }

  setMap(map: CityMap): void {
    this.map = map;
  }

  /**
   * Place everything for this frame.
   *
   * `cam` is the top-left of the view in world px, used for the same cull the
   * 2D renderer does — there is no point writing an instance for a signal head
   * two districts away.
   */
  update(scene: Scene, cam: { x: number; y: number }, view: { w: number; h: number }): void {
    const map = this.map;
    this.crates.begin();
    this.boxes.begin();
    this.posts.begin();
    this.heads.begin();
    this.rockets.begin();

    const inView = (x: number, y: number): boolean =>
      x >= cam.x - MARGIN &&
      y >= cam.y - MARGIN &&
      x <= cam.x + view.w + MARGIN &&
      y <= cam.y + view.h + MARGIN;

    // Pickups. A crate bobs; a dropped gun lies where its owner fell and does
    // not, because it should read as litter rather than as something laid out
    // for you.
    for (const pu of scene.remotes.pickups) {
      if (!pu.active || !inView(pu.pos.x, pu.pos.y)) continue;
      const color = PICKUP_COLORS[pu.kind] ?? '#c0c0c0';
      if (pu.kind === 'weapon') {
        this.boxes.putBox(pu.pos.x, pu.pos.y, 1.2, 8, 2, 2, pu.id * 0.7, color);
        continue;
      }
      const bob = Math.sin(scene.nowMs * 0.004 + pu.id) * 1.5;
      // Drawn a hand's width off its sim position, deliberately: a drop
      // spawns exactly where its owner fell, and from straight overhead a
      // bobbing crate centred on a corpse hid almost all of the body it
      // came from (REVIEW-3D, PLAN-WORLDGEN.md wave 3.5). Five px reads as
      // "dropped beside them"; collection still reads the sim position.
      this.crates.put(pu.pos.x + 5, pu.pos.y + 5, PICKUP_Z + bob, 9, scene.nowMs * 0.0012, color);
    }

    // Hidden packages: a slow glint rather than a bob, so they read as
    // something left behind. Grey and inert once taken.
    if (map) {
      const found = scene.foundPackages;
      for (let i = 0; i < map.packages.length; i++) {
        const at = map.packages[i]!;
        if (!inView(at.x, at.y)) continue;
        const taken = found?.has(i) === true;
        const pulse = taken ? 0 : 0.5 + 0.5 * Math.sin(scene.nowMs * 0.002 + i);
        this.boxes.putBox(
          at.x,
          at.y,
          PACKAGE_Z,
          4 + pulse,
          4 + pulse,
          4 + pulse,
          0.6,
          taken ? PACKAGE_TAKEN : PACKAGE_COLOR,
        );
      }

      // Traffic signals. The phase comes from `signalColour` — the same
      // function the drivers consult, off the tick being rendered — so what the
      // player sees and what the traffic obeys cannot drift apart.
      const heads = map.junctions?.heads;
      if (heads) {
        const timing = getTrafficTuning().signals;
        for (const head of heads) {
          if (!inView(head.x, head.y)) continue;
          const colour = signalColour(
            map.junctions?.phase?.[head.junctionId] ?? head.junctionId,
            head.dirIdx,
            scene.tick,
            timing,
          );
          // At the kerb on the driver's right, facing back down the arm —
          // where a real one is, and out of the carriageway the car uses.
          const ax = CARDINALS[head.dirIdx]![0]!;
          const ay = CARDINALS[head.dirIdx]![1]!;
          const px = head.x + ax * 5 - ay * head.kerb;
          const py = head.y + ay * 5 + ax * head.kerb;
          // A post, which the 2D view cannot show and this one gets for free:
          // from overhead a signal is a dark square either way, but at the
          // frame's edge it now stands up like the street furniture it is.
          this.posts.putBox(px, py, SIGNAL_HEAD_Z / 2, 1.6, 1.6, SIGNAL_HEAD_Z, 0, '#1b2028');
          this.heads.putBox(px, py, SIGNAL_HEAD_Z, 3.4, 3.4, 4.2, 0, SIGNAL_COLORS[colour]);
        }
      }
    }

    // Projectiles. A rocket is small, bright and above everything on the
    // ground, so one coming at you is the most legible thing on screen; a mine
    // blinks so it reads as armed rather than as litter; a slick is a stain you
    // are meant to be able to miss.
    for (const pr of scene.remotes.projectiles) {
      const kind = pr.projectile.kind;
      if (kind === 'slick') {
        this.boxes.putBox(pr.x, pr.y, 0.5, 22, 16, 1, 0, 'rgb(20, 18, 26)');
      } else if (kind === 'mine') {
        const armed = Math.floor(scene.nowMs / 500) % 2 === 0;
        this.boxes.putBox(pr.x, pr.y, 2, 5, 5, 3, 0, armed ? '#ff785a' : '#c85a4a');
      } else {
        this.rockets.putBox(
          pr.x,
          pr.y,
          PROJECTILE_Z,
          7,
          2.5,
          2.5,
          Math.atan2(pr.projectile.vel.y, pr.projectile.vel.x),
          '#ffd27a',
        );
      }
    }

    this.crates.end();
    this.boxes.end();
    this.posts.end();
    this.heads.end();
    this.rockets.end();
  }
}
