import * as THREE from 'three';
import { getVehicleTuning } from 'shared';
import type { RenderWorld } from '../net/interpolation.js';
import { addOutline, toonMaterial } from './toon.js';
import { carGeometry, personGeometry } from './models.js';
import { hasSprite, spriteGeometry, variantCount } from './spriteMesh.js';

/**
 * Everything that moves, as instanced 3D bodies.
 *
 * One `InstancedMesh` per kind of thing rather than per thing: a street holds
 * dozens of cars and a couple of hundred pedestrians, and at one draw call
 * each that is a dead frame before any of them has done anything interesting.
 * Instanced, the whole population is a handful of draws and the per-frame
 * work is writing matrices into a buffer.
 *
 * Bodies are boxes for now. That is not the shipping art — it is the shape
 * the *simulation* already agrees on, since vehicles collide as oriented
 * boxes and always have. Drawing exactly the collider is worth a stage of its
 * own: anything that looks wrong here is wrong in the sim too, which stops
 * being true the moment a modelled car hides its own hitbox. Meshes arrive
 * with 3D.md W3c, and the sprite-to-mesh generator is how.
 */

/** The local player and their vehicle, from the predictor rather than the wire. */
export interface LocalBodies {
  player?: { x: number; y: number; z: number; heading: number };
  vehicle?: { id: number; kind: string; x: number; y: number; z: number; heading: number };
}

/** Reused so the hot path allocates nothing. */
const UP = new THREE.Vector3(0, 0, 1);

/**
 * How much to exaggerate the authored sprite heights.
 *
 * Those heights were tuned to look right under a relighting pass on flat art,
 * where they only ever had to *imply* depth. Under a camera that can see them
 * a faithful 1.0 reads a little squashed, and this is the smallest knob that
 * fixes it without touching the art.
 */
const Z_EXAGGERATION = 1.5;

/** How high off the road a body of this kind sits, and how big it is. */
interface Body {
  /** Half-extents in world px: along, across, up. */
  size: [number, number, number];
  color: number;
  outline: number;
}

const PED: Body = { size: [3, 3, 9], color: 0xc98f6a, outline: 1.1 };
const COP: Body = { size: [3.2, 3.2, 9.5], color: 0x3f5c9a, outline: 1.1 };
const PLAYER: Body = { size: [3.4, 3.4, 10], color: 0xd94b3a, outline: 1.3 };

/** Body paint per vehicle kind. Civilian cars get a spread; services do not. */
const PAINT: Record<string, number> = {
  copcar: 0x2c4f9e,
  copbike: 0x2c4f9e,
  ambulance: 0xe4e7ea,
  firetruck: 0xb8322a,
  taxi: 0xe0b53a,
  bus: 0x3f7f5a,
  truck: 0x8a8f98,
  garbage: 0x4b5540,
  tank: 0x5c6349,
  plane: 0xdfe3e8,
  chopper: 0x37424f,
  boat: 0xdadfe4,
  limo: 0x1c1f24,
  sports: 0xc4392c,
  muscle: 0x8a3fa0,
  van: 0xb9b3a4,
  digger: 0xd8a12a,
  icecream: 0xefd9c0,
};

/** Sprite art for a name, or the hand-built fallback if the sheet lacks it. */
function body(name: string, fallback: THREE.BufferGeometry): THREE.BufferGeometry {
  return hasSprite(name)
    ? (spriteGeometry(name, { zScale: Z_EXAGGERATION }) ?? fallback)
    : fallback;
}

/** A pool of instances of one body kind, grown on demand. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly outline: THREE.Mesh | THREE.InstancedMesh;
  private used = 0;

  constructor(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    body: Body,
    capacity: number,
  ) {
    // Vertex colours: the model carries its own paint (dark cabin, glass,
    // black tyres) so the whole thing is one instanced draw.
    const mat = toonMaterial(0xffffff);
    mat.vertexColors = true;
    this.mesh = new THREE.InstancedMesh(geometry, mat, capacity);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Instances are placed every frame; without this three.js culls against a
    // bounding sphere computed once, at the origin, and the whole population
    // vanishes the moment the camera moves away from it.
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    this.outline = addOutline(this.mesh, parent, body.outline);
    this.outline.frustumCulled = false;
  }

  begin(): void {
    this.used = 0;
  }

  /** Place one instance. Silently drops past capacity rather than throwing. */
  put(m: THREE.Matrix4): void {
    if (this.used >= this.mesh.count) return;
    this.mesh.setMatrixAt(this.used, m);
    this.used++;
  }

  /**
   * Park the unused tail somewhere harmless and flush.
   *
   * An instance that is not written keeps last frame's matrix, so a crowd
   * that shrinks leaves corpses standing in the street. Scaling the tail to
   * zero is cheaper than rebuilding the mesh.
   */
  end(zero: THREE.Matrix4): void {
    for (let i = this.used; i < this.mesh.count; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.outline as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }
}

export class EntityLayer {
  private readonly group = new THREE.Group();
  private readonly peds: Pool;
  private readonly cops: Pool;
  private readonly players: Pool;
  /** One pool per vehicle kind, so each keeps its own size and colour. */
  private readonly vehicles = new Map<string, Pool>();
  private readonly vehicleParent: THREE.Object3D;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Last facing per officer, so a stopped one does not snap east. */
  private readonly copFacing = new Map<number, number>();

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    // The figures come out of the same sprite definitions the 2D renderer
    // draws, extruded. `models.ts` survives only as the fallback for a name
    // the sheet has no art for.
    this.peds = new Pool(this.group, body('ped', personGeometry(0xc98f6a, 0x7d6a52, 0x33383f)), PED, 400);
    this.cops = new Pool(this.group, body('cop', personGeometry(0xd0a184, 0x27407a, 0x1b2436)), COP, 96);
    this.players = new Pool(this.group, body('player', personGeometry(0xd8a184, 0xc4392c, 0x2b3038)), PLAYER, 16);
    this.vehicleParent = this.group;
  }

  /**
   * The pool for one (kind, paint) pair.
   *
   * Keyed by variant as well as kind because a car's colourway is baked into
   * its vertex colours — which is what keeps a painted car a single instanced
   * draw. Ten paint jobs is ten pools of the same geometry, and ten draws for
   * every car in the city is still cheaper than one draw per car.
   */
  private vehiclePool(kind: string, variant: number): Pool {
    const key = `${kind}#${variant}`;
    let pool = this.vehicles.get(key);
    if (!pool) {
      const t = getVehicleTuning(kind);
      // The collider, drawn. `t.halfLength`/`t.halfWidth` are the numbers the
      // sim resolves against, so the box on screen is the box you hit things
      // with — see the note at the top of this file.
      const along = t?.halfLength ?? 8;
      const across = t?.halfWidth ?? 4;
      // Sprite art first; the hand-built car is only reached for a kind the
      // sheet has no entry for, which today is none of them.
      const geom =
        spriteGeometry(kind, { variant, zScale: Z_EXAGGERATION }) ??
        carGeometry(along, across, 0x9aa4b2);
      pool = new Pool(
        this.vehicleParent,
        geom,
        { size: [along, across, 8], color: 0xffffff, outline: 1.4 },
        kind === 'plane' || kind === 'chopper' ? 12 : 48,
      );
      this.vehicles.set(key, pool);
    }
    return pool;
  }

  /** A stable paint job per vehicle id, so a car does not change colour. */
  private variantFor(kind: string, id: number): number {
    const n = variantCount(kind);
    return n <= 1 ? 0 : Math.abs(Math.imul(id, 2654435761)) % n;
  }

  /**
   * Place every body for this frame.
   *
   * `world` is the interpolated snapshot the 2D renderer draws from, so the
   * two views are looking at exactly the same state — which is what makes
   * the 3D path checkable against the one that already works.
   */
  update(world: RenderWorld, localPlayerId: number, local?: LocalBodies): void {
    this.peds.begin();
    this.cops.begin();
    this.players.begin();
    for (const pool of this.vehicles.values()) pool.begin();

    // Models are authored at world scale with their feet at z=0, so an
    // instance is placed unscaled — scaling them here would stretch the
    // outline hull along whichever axis was longer.
    const place = (pool: Pool, x: number, y: number, z: number, heading: number): void => {
      this.pos.set(x, y, z);
      this.q.setFromAxisAngle(UP, heading);
      this.scl.set(1, 1, 1);
      this.m.compose(this.pos, this.q, this.scl);
      pool.put(this.m);
    };

    // Neither peds nor cops carry a heading: a ped has the unit direction it
    // walks along, and an officer only has velocity. Both are derived here
    // rather than added to the wire, because a facing that can be computed
    // from something already sent is not worth a byte per entity per tick.
    for (const p of world.peds) {
      place(this.peds, p.x, p.y, 0, Math.atan2(p.ped.dirY, p.ped.dirX));
    }
    for (const c of world.cops) {
      const { x: vx, y: vy } = c.cop.vel;
      // A stationary officer keeps whatever way they last faced rather than
      // snapping to east, which is what atan2(0, 0) would give.
      const heading = vx === 0 && vy === 0 ? (this.copFacing.get(c.cop.id) ?? 0) : Math.atan2(vy, vx);
      this.copFacing.set(c.cop.id, heading);
      place(this.cops, c.x, c.y, 0, heading);
    }
    for (const pl of world.players) {
      if (pl.player.id === localPlayerId) continue;
      place(this.players, pl.x, pl.y, pl.player.z ?? 0, pl.player.aimAngle ?? 0);
    }
    for (const v of world.vehicles) {
      const kind = v.vehicle.kind;
      const pool = this.vehiclePool(kind, this.variantFor(kind, v.vehicle.id));
      // Vehicle boxes carry their own geometry size, so the instance is
      // placed unscaled: composing with a unit scale keeps the outline hull's
      // thickness even instead of stretching it along the longer axis.
      this.pos.set(v.x, v.y, v.vehicle.z ?? 0);
      this.q.setFromAxisAngle(UP, v.heading);
      this.scl.set(1, 1, 1);
      this.m.compose(this.pos, this.q, this.scl);
      pool.put(this.m);
    }

    // The local player and their car come from PREDICTION, not from the
    // interpolated snapshot — the same split `main.ts` makes for the 2D
    // renderer. Drawing them off the snapshot instead would put the thing the
    // player is steering three ticks behind their own input.
    if (local?.player) {
      const p = local.player;
      place(this.players, p.x, p.y, p.z, p.heading);
    }
    if (local?.vehicle) {
      const v = local.vehicle;
      const pool = this.vehiclePool(v.kind, this.variantFor(v.kind, v.id));
      this.m.compose(
        this.pos.set(v.x, v.y, v.z),
        this.q.setFromAxisAngle(UP, v.heading),
        this.scl.set(1, 1, 1),
      );
      pool.put(this.m);
    }

    this.peds.end(this.zero);
    this.cops.end(this.zero);
    this.players.end(this.zero);
    for (const pool of this.vehicles.values()) pool.end(this.zero);
  }

}
