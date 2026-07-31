import * as THREE from 'three';
import { getVehicleTuning } from 'shared';
import type { RenderWorld } from '../net/interpolation.js';
import {
  COP_SPRITE,
  PED_VARIANTS,
  PLAYER_VARIANTS,
  STRIDE,
  WALK_FRAMES,
  deadPose,
  playerPose,
  vehicleSpriteVariant,
} from '../render/renderer.js';
import { addOutline, toonMaterial } from './toon.js';
import { carGeometry, personGeometry } from './models.js';
import { frameCount, hasSprite, spriteGeometry } from './spriteMesh.js';

/**
 * Everything that moves, as instanced 3D bodies.
 *
 * One `InstancedMesh` per kind of thing rather than per thing: a street holds
 * dozens of cars and a couple of hundred pedestrians, and at one draw call
 * each that is a dead frame before any of them has done anything interesting.
 * Instanced, the whole population is a handful of draws and the per-frame
 * work is writing matrices into a buffer.
 *
 * Bodies come out of `shared/data/sprites.json`, extruded — the same art the
 * 2D renderer rasterises. That is what keeps the two views the same game and
 * not two games: a paint job, a walk frame, a gang livery or a turret exists
 * once, in the data, and both renderers read it. Everywhere this file used to
 * substitute its own answer for one the sim or the sheet already had — a
 * colour off the entity id, a single standing pose, no turret, no rider — the
 * two views disagreed about what the player was looking at.
 */

/** The local player and their vehicle, from the predictor rather than the wire. */
export interface LocalBodies {
  player?: {
    x: number;
    y: number;
    z: number;
    heading: number;
    /** Their id and mode, so a dead local player lies down like everyone else. */
    id: number;
    mode: string;
    /** Which of the four player colourways they wear. */
    cosmeticId?: number;
    /**
     * Standing pose, from `playerPose`. Handed in rather than derived, because
     * this carries no weapon state and the caller has it.
     */
    pose?: 'player' | 'playerFist' | 'playerPunch';
  };
  vehicle?: {
    id: number;
    kind: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    /** 0 undamaged, 1 about to burn. Darkens the paint, as the dents do in 2D. */
    wear: number;
    /** 'ok' | 'burning' | 'wreck', so a burnt-out shell reads as one. */
    condition?: string;
    /** Factory colour off the sim, or -1 to fall back to the id. */
    paint?: number;
    /** Whose car it is, for a gang livery. */
    gangId?: number;
    /**
     * Where the driver is aiming, for a turret. Your own comes off your own
     * smoothed aim rather than off the wire, so the barrel answers the mouse
     * on the frame you move it — the same split the 2D renderer makes.
     */
    aim?: number | null;
  };
}

/** Reused so the hot path allocates nothing. */
const UP = new THREE.Vector3(0, 0, 1);
/** For tipping the escort marker over so its point faces the ground. */
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * How much to exaggerate the authored sprite heights.
 *
 * Those heights were tuned to look right under a relighting pass on flat art,
 * where they only ever had to *imply* depth. Under a camera that can see them
 * a faithful 1.0 reads a little squashed, and this is the smallest knob that
 * fixes it without touching the art.
 */
const Z_EXAGGERATION = 1.5;

/**
 * How flat a body on the ground is drawn.
 *
 * The sprawl and curl poses are drawn from above, so their art is as wide as a
 * standing figure and the authored `z` values are the same relighting hints
 * every other sprite carries. Extruded at the standing exaggeration a corpse
 * came out 77–85% of the height of a person on their feet — a body-shaped
 * block, upright, at eye level with the living, which reads as a bug rather
 * than as a death.
 *
 * Low enough to lie down, not zero: a body still has to catch the light and
 * hold an outline, or it becomes a decal. At 0.3 the torso came out 1.05 px
 * thick, which is nearer a decal than a body; 0.45 gives it a 0.28 m chest and
 * still reads as unambiguously down at 23% of a standing figure.
 */
const DEAD_Z = 0.45;
/** The curl pose should be lumpier than the sprawl — it is still breathing. */
const DOWNED_Z = 0.5;

/**
 * Height per sprite, where one multiplier for all of them is wrong.
 *
 * `z` in `sprites.json` is a relighting hint for flat art, not a height — the
 * 2D generator reads it as a field to compute shading normals from, and that is
 * all it was ever for. So every sprite sits in the same 0–16 range whatever it
 * depicts, and extruded at one exaggeration a bus came out exactly as tall as
 * the person waiting for it.
 *
 * Two limits bound every number here, both measured at the shipped camera:
 *
 * **Ceiling, 20 world px.** Straight down, a tall object hides the ground
 * behind it in a strip `r·(h − h_t)/(H − h)` deep, pointing radially outward.
 * Past 20 px that strip exceeds a pedestrian's width at the frame corner, so
 * things genuinely disappear behind other things. 24 px — one storey — is the
 * never-exceed.
 *
 * **Resolution, ~8 world px.** Two heights closer than that are the same height
 * at this camera. These are therefore three bands wearing a table: ground
 * clutter, people and cars, big vehicles. Precision beyond that is invisible.
 *
 * The pedestrian is the ruler at 9.75 px and does not move. A car roof belongs
 * *below* head height, which is why the fix for "a car is as tall as a person"
 * is on this side rather than by inflating the ped.
 */
const Z_BY_SPRITE: Readonly<Record<string, number>> = Object.freeze({
  // Low-slung cars: the roofline is the whole difference between these.
  sports: 1.05,
  coupe: 1.15,
  muscle: 1.15,
  gangcar: 1.15,
  car: 1.2,
  limo: 1.2,
  hatch: 1.25,
  estate: 1.25,
  // Roof furniture — a taxi sign, a lightbar — carries these above the saloon.
  taxi: 1.25,
  copcar: 1.25,
  // Working vehicles, tall enough to read as bigger without reaching the cap.
  pickup: 1.55,
  van: 1.7,
  icecream: 1.75,
  ambulance: 2.05,
  garbage: 2.15,
  digger: 2.25,
  bus: 2.55,
  truck: 2.65,
  firetruck: 2.65,
  // A tank is squat, not tall: wide and tracked is what makes it read, and the
  // turret was the tallest object in the game, which was simply wrong.
  tank: 1.55,
  tank_turret: 1.25,
  boat: 1.4,
  // Two wheels: bar height, and the lowest things on the road.
  moto: 1.2,
  copbike: 1.2,
  bicycle: 1.25,
  // Aircraft stay where they were. Their rotor discs are authored with `alpha`
  // and `noOutline`, and `spriteMesh` honours neither, so each one renders as
  // an opaque outlined drum that swallows the fuselage. Raising these makes the
  // drum worse, not the aircraft better — see the note in `spriteMesh.ts`.
  heli: 1.5,
  gunship: 1.5,
  chopper: 1.5,
  plane: 1.5,
  // The only bulk lever a multiplier has for the police tiers. It is a weak
  // one — SWAT is not wider than a Fed in plan, and that is what would actually
  // read — but it costs nothing.
  copSwat: 1.6,
});

/** Bodies on the ground lie flat; everything else takes its authored height. */
function zScaleFor(name: string): number {
  if (/Downed/.test(name)) return DOWNED_Z;
  if (/Dead/.test(name)) return DEAD_Z;
  return Z_BY_SPRITE[name] ?? Z_EXAGGERATION;
}

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
/** A turret or a rider: pooled like a body, sized like the hull it rides on. */
const MOUNTED: Body = { size: [6, 6, 6], color: 0xffffff, outline: 1.2 };

/**
 * How much a car's paint darkens as it takes damage.
 *
 * The 2D renderer draws actual dents and missing panels. A merged sprite mesh
 * cannot lose a panel without being rebuilt, so this carries the same
 * information the cheap way: a car that has been through a wall is visibly
 * darker than one off the forecourt, and one about to catch fire is sooty.
 * Bottoming out at 0.55 rather than at black, because a wreck still has to read
 * as the colour of car it is.
 */
function wearShade(wear: number): number {
  const w = wear < 0 ? 0 : wear > 1 ? 1 : wear;
  return 1 - 0.45 * w;
}

/**
 * The shade of a burnt-out shell.
 *
 * The 2D renderer draws a wreck at 0.85 alpha under a 72% black wash, which
 * lands around a quarter of the original paint. The 3D view never read
 * `condition` at all, so an exploded car kept driving-school paint at worst
 * 45% darker — parked out of the sun rather than blown up. Same floor as the
 * 2D wash: charred, but still recognisably the colour of car it was.
 */
const WRECK_SHADE = 0.24;

/** Paint shade for a vehicle's condition and wear, both views' rules agreeing. */
export function vehicleShade(condition: string | undefined, wear: number): number {
  return condition === 'wreck' ? WRECK_SHADE : wearShade(wear);
}

/** Wear of a streamed vehicle, 0..1, from the two numbers a snapshot carries. */
function wearOf(v: { kind: string; health: number }): number {
  const max = getVehicleTuning(v.kind)?.health ?? 0;
  if (max <= 0) return 0;
  const wear = (max - v.health) / max;
  return wear < 0 ? 0 : wear > 1 ? 1 : wear;
}

/**
 * Which walk frame a body is on, from how far it has walked.
 *
 * The same rule and the same `STRIDE` the 2D renderer uses, so a pedestrian is
 * mid-stride at the same moment in both views. Keyed per entity, and a big
 * jump — a respawn, a resync, an interest-management pop — is not counted, or
 * the legs would spin on teleport.
 */
class WalkCycle {
  private readonly state = new Map<string, { x: number; y: number; dist: number }>();

  frame(key: string, x: number, y: number): number {
    let s = this.state.get(key);
    if (!s) {
      s = { x, y, dist: 0 };
      this.state.set(key, s);
    }
    const moved = Math.hypot(x - s.x, y - s.y);
    if (moved < 24) s.dist += moved;
    s.x = x;
    s.y = y;
    return Math.floor(s.dist / STRIDE) % WALK_FRAMES;
  }

  /** Forget anybody not seen this frame, so the map does not grow forever. */
  sweep(seen: Set<string>): void {
    if (this.state.size < 512) return;
    for (const key of this.state.keys()) if (!seen.has(key)) this.state.delete(key);
  }
}

/** A pool of instances of one body kind, grown on demand. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly outline: THREE.Mesh | THREE.InstancedMesh;
  private used = 0;
  /** How many instances the buffers hold. `mesh.count` is how many are drawn. */
  private readonly capacity: number;
  private readonly tint = new THREE.Color();

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
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, mat, capacity);
    // Per-instance tint, multiplied over the model's own paint. White leaves the
    // art alone; a damaged car is darkened towards soot, which is what the 2D
    // renderer's dents do to a battered one.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
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
  put(m: THREE.Matrix4, shade = 1): void {
    if (this.used >= this.capacity) return;
    this.mesh.setMatrixAt(this.used, m);
    this.tint.setScalar(shade);
    this.mesh.setColorAt(this.used, this.tint);
    this.used++;
  }

  /**
   * Draw only what was placed this frame, and flush.
   *
   * An instance that is not written keeps last frame's matrix, so a crowd that
   * shrinks would leave corpses standing in the street. Shortening `count` is
   * how that is avoided: a zero-scaled tail collapses to nothing on screen but
   * is still transformed, still counted and still walked by the shadow pass,
   * and pools are sized for the worst case — a pool of 200 holding 3 peds paid
   * for 197 invisible ones, twice over, because the outline twin pays it too.
   *
   * `count` is the draw length; `capacity` is what the buffers hold, so
   * growing back next frame costs nothing.
   */
  end(): void {
    this.mesh.count = this.used;
    (this.outline as THREE.InstancedMesh).count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    (this.outline as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
  }
}

export class EntityLayer {
  private readonly group = new THREE.Group();
  /**
   * One pool per (sprite, variant, frame).
   *
   * Keyed that widely because a pool is a geometry, and all three of those
   * change the geometry: a colourway is baked into the vertex colours, and a
   * walk frame moves the legs. It sounds expensive and is not — a pool is
   * created the first time it is asked for and then reused for the rest of the
   * session, and six shirts times four frames is twenty-four draws for the
   * entire crowd.
   */
  private readonly pools = new Map<string, Pool>();
  /** A marker over somebody you are meant to be protecting. */
  private escorts: Pool | null = null;
  private readonly walk = new WalkCycle();
  private readonly seen = new Set<string>();

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  /**
   * Last facing per officer, so a stopped one does not snap east.
   *
   * Pruned to who is actually on screen once it gets large, exactly as
   * `WalkCycle.state` is. Officer ids are not reused and a rebase mints fresh
   * ones, so without this a long session with a lot of police contact grows
   * an entry per officer ever seen and never gives one back.
   */
  private readonly copFacing = new Map<number, number>();

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
  }

  /**
   * The pool for one (sprite, variant, frame).
   *
   * `fallback` is only reached for a name the sheet has no art for, which
   * today is none of them — it exists so a body kind whose art has not landed
   * yet is a plain figure rather than an invisible one.
   */
  private pool(
    name: string,
    variant: number,
    frame: number,
    shape: Body,
    capacity: number,
    fallback?: () => THREE.BufferGeometry,
  ): Pool {
    const key = `${name}#${variant}#${frame}`;
    let pool = this.pools.get(key);
    if (!pool) {
      const geom =
        spriteGeometry(name, { variant, zScale: zScaleFor(name), frame }) ??
        fallback?.() ??
        personGeometry(shape.color, 0x7d6a52, 0x33383f);
      pool = new Pool(this.group, geom, shape, capacity);
      this.pools.set(key, pool);
    }
    return pool;
  }

  /** A body on its feet, walking: variant off the id, frame off the distance. */
  private walker(
    name: string,
    variants: number,
    id: number,
    x: number,
    y: number,
    shape: Body,
    capacity: number,
  ): Pool {
    const key = `${name}${id}`;
    this.seen.add(key);
    const frame = frameCount(name) > 1 ? this.walk.frame(key, x, y) : 0;
    return this.pool(name, variants > 1 ? Math.abs(id) % variants : 0, frame, shape, capacity);
  }

  /**
   * Place every body for this frame.
   *
   * `world` is the interpolated snapshot the 2D renderer draws from, so the
   * two views are looking at exactly the same state — which is what makes
   * the 3D path checkable against the one that already works.
   */
  update(world: RenderWorld, localPlayerId: number, local?: LocalBodies): void {
    for (const pool of this.pools.values()) pool.begin();
    this.escorts?.begin();
    this.seen.clear();

    // Models are authored at world scale with their feet at z=0, so an
    // instance is placed unscaled — scaling them here would stretch the
    // outline hull along whichever axis was longer.
    const place = (pool: Pool, x: number, y: number, z: number, heading: number): void => {
      this.pos.set(x, y, z);
      this.q.setFromAxisAngle(UP, heading);
      this.m.compose(this.pos, this.q, this.scl);
      pool.put(this.m);
    };

    // Neither peds nor cops carry a heading: a ped has the unit direction it
    // walks along, and an officer only has velocity. Both are derived here
    // rather than added to the wire, because a facing that can be computed
    // from something already sent is not worth a byte per entity per tick.
    for (const p of world.peds) {
      const facing = Math.atan2(p.ped.dirY, p.ped.dirX);
      // Somebody in your care, marked. An unmarked NPC you must protect is a
      // mission you fail without ever knowing which person mattered.
      if (p.ped.escortOf !== null) {
        this.escorts ??= new Pool(
          this.group,
          new THREE.ConeGeometry(3.2, 6, 4),
          { size: [3, 3, 6], color: 0xffd27a, outline: 0.8 },
          24,
        );
        this.m.compose(
          this.pos.set(p.x, p.y, 22),
          // Point down at them, and turn slowly so it reads as a marker rather
          // than as something standing on their head.
          this.q.setFromAxisAngle(RIGHT, Math.PI),
          this.scl,
        );
        this.escorts.put(this.m);
      }
      const dying = p.ped.mode === 'downed';
      if (dying || p.ped.mode === 'dead') {
        const name = dying ? 'pedDowned' : `pedDead${deadPose(p.ped.id)}`;
        place(this.pool(name, p.ped.id % PED_VARIANTS, 0, PED, 96), p.x, p.y, 0, facing);
        continue;
      }
      // Six shirts, off the id, exactly as `ped_v${id % PED_VARIANTS}` picks
      // them in 2D. One pool at variant 0 dressed the entire city alike.
      place(this.walker('ped', PED_VARIANTS, p.ped.id, p.x, p.y, PED, 200), p.x, p.y, 0, facing);
    }
    for (const c of world.cops) {
      const { x: vx, y: vy } = c.cop.vel;
      // A stationary officer keeps whatever way they last faced rather than
      // snapping to east, which is what atan2(0, 0) would give.
      const heading = vx === 0 && vy === 0 ? (this.copFacing.get(c.cop.id) ?? 0) : Math.atan2(vy, vx);
      this.copFacing.set(c.cop.id, heading);
      // An officer at zero health is a body, not a pursuer.
      if (c.cop.health <= 0) {
        place(this.pool('copDead', 0, 0, COP, 48), c.x, c.y, 0, heading);
        continue;
      }
      const sprite = COP_SPRITE[c.cop.kind] ?? 'cop';
      place(this.walker(sprite, 1, c.cop.id, c.x, c.y, COP, 96), c.x, c.y, 0, heading);
    }
    for (const pl of world.players) {
      if (pl.player.id === localPlayerId) continue;
      const variant = Math.abs(pl.player.cosmeticId) % PLAYER_VARIANTS;
      if (pl.player.mode === 'dead') {
        place(
          this.pool(`playerDead${deadPose(pl.player.id)}`, variant, 0, PLAYER, 16),
          pl.x,
          pl.y,
          0,
          pl.player.aimAngle ?? 0,
        );
        continue;
      }
      const key = `player${pl.player.id}`;
      this.seen.add(key);
      // The pose the 2D renderer would draw: armed, bare-fisted, or mid-swing.
      // This pooled `'player'` unconditionally, so an unarmed player still held
      // a pistol and a punch never played. `playerPunch` has a single frame.
      const pose = playerPose(pl.player);
      const frame = pose === 'playerPunch' ? 0 : this.walk.frame(key, pl.x, pl.y);
      place(
        this.pool(pose, variant, frame, PLAYER, 16),
        pl.x,
        pl.y,
        pl.player.z ?? 0,
        pl.player.aimAngle ?? 0,
      );
    }
    for (const v of world.vehicles) {
      const kind = v.vehicle.kind;
      // Paint off the SIM, not off the entity id. `VehicleState.paint` exists
      // because a rebase re-spawns every parked car with a fresh id, and a
      // colour hashed from the id repainted the whole street in front of the
      // player when the window moved — the exact bug that field was added to
      // fix. `gangId` is the other half: a gang car wears its gang's colours,
      // which is how you tell whose turf you are parked on.
      const pool = this.vehiclePool(kind, v.vehicle.id, v.vehicle.paint, v.vehicle.gangId);
      const shade = vehicleShade(v.vehicle.condition, wearOf(v.vehicle));
      // Vehicle boxes carry their own geometry size, so the instance is
      // placed unscaled: composing with a unit scale keeps the outline hull's
      // thickness even instead of stretching it along the longer axis.
      const z = v.vehicle.z ?? 0;
      this.pos.set(v.x, v.y, z);
      this.q.setFromAxisAngle(UP, v.heading);
      this.m.compose(this.pos, this.q, this.scl);
      pool.put(this.m, shade);
      this.mounted(
        kind,
        v.x,
        v.y,
        z,
        v.heading,
        shade,
        this.aimOf(world, localPlayerId, local, v.vehicle.driverId),
        this.riderOf(world, localPlayerId, local, v.vehicle.driverId),
      );
    }

    // The local player and their car come from PREDICTION, not from the
    // interpolated snapshot — the same split `main.ts` makes for the 2D
    // renderer. Drawing them off the snapshot instead would put the thing the
    // player is steering three ticks behind their own input.
    if (local?.player) {
      const p = local.player;
      const variant = Math.abs(p.cosmeticId ?? 0) % PLAYER_VARIANTS;
      if (p.mode === 'dead') {
        place(this.pool(`playerDead${deadPose(p.id)}`, variant, 0, PLAYER, 16), p.x, p.y, 0, p.heading);
      } else if (p.mode !== 'driving') {
        // Somebody at the wheel is INSIDE the car, and was being drawn standing
        // on its roof: the 2D renderer guards this at its call site and the 3D
        // one did not. A two-wheeler puts them back on top, deliberately, via
        // `mounted` below.
        const key = 'local';
        this.seen.add(key);
        const pose = p.pose ?? 'player';
        const frame = pose === 'playerPunch' ? 0 : this.walk.frame(key, p.x, p.y);
        place(this.pool(pose, variant, frame, PLAYER, 16), p.x, p.y, p.z, p.heading);
      }
    }
    if (local?.vehicle) {
      const v = local.vehicle;
      const pool = this.vehiclePool(v.kind, v.id, v.paint ?? -1, v.gangId ?? 0);
      const shade = vehicleShade(v.condition, v.wear);
      this.m.compose(
        this.pos.set(v.x, v.y, v.z),
        this.q.setFromAxisAngle(UP, v.heading),
        this.scl,
      );
      pool.put(this.m, shade);
      this.mounted(
        v.kind,
        v.x,
        v.y,
        v.z,
        v.heading,
        shade,
        v.aim ?? null,
        local.player ? `player#${Math.abs(local.player.cosmeticId ?? 0) % PLAYER_VARIANTS}` : 'ped#0',
      );
    }

    for (const pool of this.pools.values()) pool.end();
    this.escorts?.end();
    this.walk.sweep(this.seen);
    if (this.copFacing.size >= 256) {
      const live = new Set<number>();
      for (const c of world.cops) live.add(c.cop.id);
      for (const id of this.copFacing.keys()) if (!live.has(id)) this.copFacing.delete(id);
    }
  }

  /**
   * The pool for one vehicle's (kind, colourway).
   *
   * Keyed by variant as well as kind because a car's colourway is baked into
   * its vertex colours — which is what keeps a painted car a single instanced
   * draw. Ten paint jobs is ten pools of the same geometry, and ten draws for
   * every car in the city is still cheaper than one draw per car.
   */
  private vehiclePool(kind: string, id: number, paint: number, gangId: number): Pool {
    const { name, variant } = vehicleSpriteVariant(kind, id, gangId, paint);
    const t = getVehicleTuning(kind);
    // The collider, drawn. `t.halfLength`/`t.halfWidth` are the numbers the
    // sim resolves against, so the box on screen is the box you hit things
    // with.
    const along = t?.halfLength ?? 8;
    const across = t?.halfWidth ?? 4;
    return this.pool(
      name,
      variant,
      0,
      { size: [along, across, 8], color: 0xffffff, outline: 1.4 },
      kind === 'plane' || kind === 'chopper' ? 12 : 48,
      () => carGeometry(along, across, 0x9aa4b2),
    );
  }

  /**
   * The two things that ride ON a vehicle rather than inside it.
   *
   * A turret is the one part that does NOT turn with the body — it points
   * where its driver points — and a rider is the one part that must, because
   * somebody on a motorcycle faces where the motorcycle goes. `turretOffset`
   * and `riderOffset` in `vehicles.json` carry the pivot for each, and their
   * presence is what says the vehicle has one at all. Both were read by the 2D
   * renderer and by nothing here, so the tank had no gun and traffic ran
   * driverless motorcycles through the city at 60 px/s.
   */
  private mounted(
    kind: string,
    x: number,
    y: number,
    z: number,
    heading: number,
    shade: number,
    aim: number | null,
    rider: string | null,
  ): void {
    const t = getVehicleTuning(kind);
    const turret = t?.turretOffset ?? null;
    if (turret !== null && hasSprite(`${kind}_turret`)) {
      const pool = this.pool(`${kind}_turret`, 0, 0, MOUNTED, 16);
      this.pos.set(x + Math.cos(heading) * turret, y + Math.sin(heading) * turret, z);
      this.q.setFromAxisAngle(UP, aim ?? heading);
      this.m.compose(this.pos, this.q, this.scl);
      pool.put(this.m, shade);
    }
    const seat = t?.riderOffset ?? null;
    if (seat !== null && rider !== null) {
      const [name, variant] = rider.split('#');
      const pool = this.pool(name as string, Number(variant) || 0, 0, MOUNTED, 32);
      this.pos.set(x + Math.cos(heading) * seat, y + Math.sin(heading) * seat, z);
      this.q.setFromAxisAngle(UP, heading);
      this.m.compose(this.pos, this.q, this.scl);
      pool.put(this.m);
    }
  }

  /**
   * Where the driver of this vehicle is aiming, or null if nobody is at the
   * wheel. An empty tank rests its gun along the hull.
   */
  private aimOf(
    world: RenderWorld,
    localPlayerId: number,
    local: LocalBodies | undefined,
    driverId: number | null,
  ): number | null {
    if (driverId === null) return null;
    if (driverId === localPlayerId) return local?.vehicle?.aim ?? local?.player?.heading ?? null;
    for (const r of world.players) if (r.player.id === driverId) return r.aimAngle;
    return null;
  }

  /**
   * Who to sit on a two-wheeler, as `sprite#variant`.
   *
   * Null for an empty bike. An AI driver falls back to a pedestrian — the same
   * answer `riderSprite` gives in 2D, and for the same reason: somebody
   * generic on a motorcycle is a far smaller lie than nobody on one.
   */
  private riderOf(
    world: RenderWorld,
    localPlayerId: number,
    local: LocalBodies | undefined,
    driverId: number | null,
  ): string | null {
    if (driverId === null) return null;
    if (driverId < 0) return 'ped#0';
    if (driverId === localPlayerId && local?.player) {
      return `player#${Math.abs(local.player.cosmeticId ?? 0) % PLAYER_VARIANTS}`;
    }
    for (const r of world.players) {
      if (r.player.id === driverId) {
        return `player#${Math.abs(r.player.cosmeticId) % PLAYER_VARIANTS}`;
      }
    }
    return 'ped#0';
  }
}
