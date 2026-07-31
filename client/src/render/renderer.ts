import {
  type CityMap,
  type PickupState,
  type PlayerState,
  type PropState,
  type Vec2,
  type SignalColour,
  type WeaponTuning,
  nightAmount,
  timeOfDay,
  wetness,
  CARDINALS,
  getTrafficTuning,
  PART_BONNET,
  PART_BUMPER_F,
  PART_BUMPER_R,
  PART_DOOR_L,
  PART_DOOR_R,
  PART_HEADLIGHT_L,
  PART_HEADLIGHT_R,
  PART_RADIATOR,
  PART_TAILLIGHT_L,
  PART_TAILLIGHT_R,
  PART_WINDSCREEN,
  PLAYER_RADIUS,
  RESPAWN_DELAY_TICKS,
  TICK_RATE,
  TILE_SIZE,
  clamp,
  getTuning,
  getVehicleTuning,
  getWeaponTuning,
  signalColour,
  vehicleWear,
} from 'shared';
import palette from 'shared/data/palette.json';
import type { Screen } from './canvas.js';
import { worldTransform } from './canvas.js';
import type { RenderWorld } from '../net/interpolation.js';
import type { SpriteSheet } from './sprites.js';
import type { TileLayer } from './tiles.js';
import { BLOOD_DROP, BLOOD_POOL, type Effects } from './effects.js';
import { flicker, lampCharacter, type LightPass } from './lighting.js';
import type { Occluder } from './shadows.js';
import { RENDER_SCALE, SUN_X, SUN_Y } from './config.js';
import { hash2 } from './noise.js';
import { viewport } from './viewport.js';

const REMOTE_COLORS = ['#e05555', '#55b0e0', '#57c98a', '#d3a24a', '#b06ad6', '#5fd6c9', '#d66a9c'];
const LOCAL_COLOR = '#f2f2f2';

/** Gang colours, keyed by gang id. Mirrors shared/data/gangs.json. */
const GANG_TINT: Record<number, string> = {
  1: '#c8543c',
  2: '#4aa86a',
  3: '#4a7ac8',
  4: '#a86ac8',
  5: '#c8a03c',
  6: '#3cc8b4',
  7: '#c85a8c',
};

/**
 * Which sprite a vehicle is drawn with.
 *
 * Exported and tested because the interesting failure here was silent: the
 * driver's own vehicle was drawn with a hardcoded 'car', so getting into a
 * boat put you in a car. Only the local player was affected — everybody else
 * saw the right sprite — which is exactly the kind of thing that survives a
 * casual look at a screenshot.
 *
 * Anything with a sprite of its own uses it; the generic car is the only kind
 * that comes in colours, so it is the only one that varies by id.
 */
/**
 * Vehicle kinds whose sprite carries the ten-colour `body` variant axis.
 * Mirrors the `variants` blocks in shared/data/sprites.json; the sprite test
 * is what keeps the two honest.
 */
const PAINTED_KINDS = new Set([
  'car',
  'coupe',
  'estate',
  'pickup',
  'sports',
  'hatch',
  'muscle',
  // The two-wheelers came in colours too, and were left off this list on the
  // first pass — so both drew as the fallback rectangle, which the vehicle
  // contact sheet showed as a solid red block the moment it existed.
  'moto',
  'bicycle',
  'plane',
  'chopper',
]);

/**
 * Which sprite a vehicle wears, and which of its colourways.
 *
 * Split from `vehicleSpriteName` because the two renderers want the same
 * answer in two shapes: the 2D one draws a sheet frame called `car_v3`, and
 * the 3D one extrudes the `car` definition asking for variant 3. Keeping the
 * rule in one place is what stops a car being one colour in one view and
 * another colour in the other — and it is not a cosmetic detail, because a
 * gang's colours are how you read whose street you are parked on.
 */
export function vehicleSpriteVariant(
  kind: string,
  id: number,
  gangId = 0,
  /**
   * The colour the sim says this one was painted, or -1 for "work it out from
   * the id".
   *
   * The id used to be the only answer, and it is the wrong one for anything
   * that outlives its entity. A session that walks into the next region tears
   * the ambient world down and rebuilds it (see the `rebase` command), so
   * every parked car comes back with a fresh id — and the whole street changed
   * colour at once, in front of you, for no reason you could see. A paint
   * derived from the KERB survives that; see `paintAt` in worldgen.
   */
  paint = -1,
): { name: string; variant: number } {
  // A gang car wears its gang's colours, not a colour off the rank: the whole
  // reason it exists is that you can tell whose street you are on by what is
  // parked on it.
  // Four liveries for seven gangs: the colours wrap. A body shell is not the
  // identifier — the tint, the turf wash and the respect bar all carry the
  // gang, and minting three more near-identical car sprites would cost sheet
  // space to say something already said three ways.
  if (kind === 'gangcar') return { name: 'gangcar', variant: Math.max(0, gangId - 1) % 4 };
  // Every civilian body comes in the same ten colours, so the suffix rule is
  // a property of the SET rather than of one kind. It used to test
  // `kind === 'car'`, which silently drew each new body in variant-less form
  // — that is, not at all, since no such frame exists.
  if (!PAINTED_KINDS.has(kind)) return { name: kind, variant: 0 };
  return { name: kind, variant: paint >= 0 ? paint % CAR_VARIANTS : Math.abs(id) % CAR_VARIANTS };
}

/** The sheet frame name for a vehicle: `vehicleSpriteVariant`, as a string. */
export function vehicleSpriteName(kind: string, id: number, gangId = 0, paint = -1): string {
  const { name, variant } = vehicleSpriteVariant(kind, id, gangId, paint);
  if (name === 'gangcar') return `gangcar_v${variant}`;
  if (!PAINTED_KINDS.has(kind)) return name;
  return `${name}_v${variant}`;
}

/**
 * The interpolated aim of whoever is at the wheel, or null if nobody is.
 *
 * This is the renderer's half of `turretAngle` in the sim: the same rule —
 * a turret points where its driver points — read off the smoothed view
 * instead of off the authoritative state, so the barrel moves at frame rate
 * rather than in 30 Hz steps. An empty tank rests its gun along the hull,
 * which is what `drawVehicle` falls back to when this returns null.
 */
function aimOf(scene: Scene, driverId: number | null): number | null {
  if (driverId === null) return null;
  if (scene.local && scene.local.id === driverId) return scene.localPos?.angle ?? scene.local.aimAngle;
  for (const r of scene.remotes.players) if (r.player.id === driverId) return r.aimAngle;
  return null;
}

/**
 * Cop kinds that fly. Mirrors the `flies` flag in police.json — the sim owns
 * the behaviour, this owns which of them go above the street rather than in
 * it, and the police test is what keeps the two in step.
 */
const AIR_KINDS = new Set(['heli', 'gunship']);

/**
 * How far above the street a helicopter sits, in world px.
 *
 * Drawn as a lift on the sprite with the shadow left on the ground: the GAP
 * between the two is the whole of what says "that is in the air", exactly as
 * it does for a car mid-stunt-jump.
 */
const AIR_HEIGHT = 26;

/**
 * The sprite to sit on a two-wheeler, for whoever is at the bars.
 *
 * Null for an empty bike, and null for anything with a roof — `drawVehicle`
 * ignores it unless the vehicle has a `riderOffset`. A ped-ridden bike in
 * traffic has no player driver, so it falls back to a pedestrian: an empty
 * motorcycle travelling at 60 px/s is a worse bug than a generic rider.
 */
function riderSprite(scene: Scene, driverId: number | null): string | null {
  if (driverId === null) return null;
  if (driverId < 0) return 'ped_v0_f0'; // an AI driver: somebody, at least
  const local = scene.local && scene.local.id === driverId ? scene.local : null;
  const remote = local ? null : scene.remotes.players.find((r) => r.player.id === driverId);
  const who = local ?? remote?.player;
  if (!who) return 'ped_v0_f0';
  return `player_v${Math.abs(who.cosmeticId) % PLAYER_VARIANTS}_f0`;
}

/** Uniform per force, so what is chasing you is legible at a glance. */
const COP_TINT: Record<string, string> = {
  patrol: '#3a5fb0',
  swat: '#2c3038',
  fed: '#1f2c58',
  army: '#4a5334',
};

/**
 * The sprite each tier turns out in.
 *
 * A tier used to be the patrol figure under a different tint, which reads at
 * a glance as "that officer is standing in a different light" rather than as
 * "that is a different force". They are built off the same anatomy on
 * purpose, so the four still read as the same species — a helmet and a visor,
 * a long coat, webbing and a rifle. See GTA.md P3b.
 */
export const COP_SPRITE: Record<string, string> = {
  patrol: 'cop',
  swat: 'copSwat',
  fed: 'copFed',
  army: 'copArmy',
};

/** World px a walking entity covers per animation frame. */
export const STRIDE = 7;
/** Sprite variant counts, mirroring shared/data/sprites.json. */
export const PLAYER_VARIANTS = 4;
export const PED_VARIANTS = 6;
const CAR_VARIANTS = 10;
export const WALK_FRAMES = 4;

export interface Scene {
  /** Predicted local player. */
  local: PlayerState | null;
  /** Its pose, smoothed across the tick boundary. */
  localPos: { x: number; y: number; angle: number } | null;
  /** Predicted vehicle when the local player is driving, smoothed. */
  localVehicle: {
    /** What you are actually driving. Without it the driver's own vehicle
     *  was drawn as a car whatever it was — a boat included. */
    kind: string;
    pos: Vec2;
    heading: number;
    speed: number;
    condition: string;
    /** 0 = undamaged, 1 = about to catch fire. */
    wear: number;
    /** Per-zone damage and broken-part bits; see sim/vehicleDamage.ts. */
    zones: number[];
    broken: number;
    /** Height off the ground; nonzero only mid-stunt. */
    z: number;
    /** Whose car it is; picks the livery for a gang car. */
    gangId: number;
    /** Factory colour, or -1 for "off the id". See `vehicleSpriteName`. */
    paint: number;
  } | null;
  /** Remote entities on the interpolated timeline. */
  remotes: RenderWorld;
  /** Hidden packages this player has found; the rest are still worth taking. */
  foundPackages?: ReadonlySet<number>;
  /** Seconds since the previous frame, for effects. */
  dt: number;
  /** Wall-clock ms, for strobes and flicker. */
  nowMs: number;
  /**
   * Force the hour, 0 (midday) to 1 (midnight), instead of reading it off the
   * tick. A debug affordance — `?night=` — because a full day is 24 minutes
   * long and the lighting work is otherwise unreviewable without waiting for
   * dusk. Never set in normal play.
   */
  night?: number | null;
  /**
   * Newest authoritative sim tick. Two things want it, for unrelated reasons.
   *
   * Traffic signals are a pure function of it, so a light is computed rather
   * than sent. And how far a dead player's blood has spread is a function of
   * how long they have been down, whose only clock is `respawnAtTick` counted
   * back from now. Pedestrians and officers carry their own age in a field.
   */
  tick: number;
}

/** How far ahead of the player the camera leads, at full speed, in world px. */
const LEAD_MAX = 54;
/** Speed at which the lead reaches its maximum. */
const LEAD_FULL_SPEED = 168;

/**
 * Camera top-left in world coords. Deliberately *not* rounded — see `render`.
 *
 * The camera leads towards where the player is going. Without it, a car
 * crosses the 480 px viewport in a couple of seconds, so the driver only ever
 * sees a second of road ahead and is permanently steering into the blind half
 * of the screen.
 */
export function computeCamera(
  map: CityMap | null,
  local: Vec2 | null,
  lead: Vec2 | null = null,
): Vec2 {
  const w = map?.widthPx ?? viewport.w;
  const h = map?.heightPx ?? viewport.h;
  const cx = (local ? local.x : w / 2) + (lead?.x ?? 0);
  const cy = (local ? local.y : h / 2) + (lead?.y ?? 0);
  return {
    x: clamp(cx - viewport.w / 2, 0, Math.max(0, w - viewport.w)),
    y: clamp(cy - viewport.h / 2, 0, Math.max(0, h - viewport.h)),
  };
}

/**
 * Where the camera should lead, given the local player's motion. Returns a
 * world-space offset; the caller smooths it so the view eases rather than
 * snapping when a car changes direction.
 */
export function cameraLead(
  heading: number | null,
  speed: number,
  velX: number,
  velY: number,
): Vec2 {
  if (heading !== null) {
    // Driving: lead along the car's nose, scaled by how fast it is going.
    const f = Math.min(1, Math.abs(speed) / LEAD_FULL_SPEED);
    const dir = speed >= 0 ? 1 : -1;
    return { x: Math.cos(heading) * LEAD_MAX * f * dir, y: Math.sin(heading) * LEAD_MAX * f * dir };
  }
  const mag = Math.hypot(velX, velY);
  if (mag < 1) return { x: 0, y: 0 };
  const f = Math.min(1, mag / 78) * 0.35;
  return { x: (velX / mag) * LEAD_MAX * f, y: (velY / mag) * LEAD_MAX * f };
}

/**
 * Which standing pose a player is in: armed, bare-fisted, or mid-swing.
 *
 * Exported because the 3D renderer needs the same answer. It used to pool
 * `'player'` unconditionally, so an unarmed player still held a pistol and a
 * punch never played at all — the two views disagreed about what the player was
 * doing, which is exactly the drift `sprites.json` being one source of art is
 * supposed to prevent.
 */
export function playerPose(p: PlayerState): 'player' | 'playerFist' | 'playerPunch' {
  // A state with no weapon list at all is not unarmed, it is under-described —
  // an interpolated body the wire has not filled in yet, or a fixture. Drawing
  // it armed is the safe answer: it is what this drew before poses existed.
  if (!p.weapons) return 'player';
  const weapon = weaponOf(p);
  const melee = weapon === null || weapon.melee;
  if (!melee) return 'player';
  const swinging =
    p.fireCooldown > 0 && weapon !== null && p.fireCooldown * 2 > weapon.cooldownTicks;
  return swinging ? 'playerPunch' : 'playerFist';
}

/** Tuning of the weapon a player is holding, or null for bare hands. */
function weaponOf(p: PlayerState): WeaponTuning | null {
  const slot = p.weapons[p.activeWeapon];
  return slot ? getWeaponTuning(slot.weaponId) : null;
}

/**
 * Which way an avatar's BODY points: wherever it is aiming, which is wherever
 * the mouse is.
 *
 * Movement is screen-relative, so the facing and the direction of travel are
 * independent — which is the point. You can back away from something while
 * still covering it, and walking left while looking right looks like exactly
 * that.
 */

/** Per-entity walk-cycle state, keyed by table and id. */
const walkState = new Map<string, { x: number; y: number; dist: number }>();

function walkFrame(key: string, x: number, y: number): number {
  let s = walkState.get(key);
  if (!s) {
    s = { x, y, dist: 0 };
    walkState.set(key, s);
  }
  const moved = Math.hypot(x - s.x, y - s.y);
  // A teleport (respawn, resync) must not spin the legs; ignore big jumps.
  if (moved < 24) s.dist += moved;
  s.x = x;
  s.y = y;
  return Math.floor(s.dist / STRIDE) % WALK_FRAMES;
}

let shadowTexture: HTMLCanvasElement | null = null;

function getShadowTexture(): HTMLCanvasElement {
  if (shadowTexture) return shadowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(4, 7, 12, 0.55)');
  grad.addColorStop(0.55, 'rgba(4, 7, 12, 0.32)');
  grad.addColorStop(1, 'rgba(4, 7, 12, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  shadowTexture = canvas;
  return canvas;
}

/**
 * Soft contact shadow, offset towards the sun-away direction by the entity's
 * notional height. Cheaper and steadier than a silhouette baked per rotation
 * step, and at this size a blob is what reads as grounding anyway.
 */
function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  height: number,
): void {
  const tex = getShadowTexture();
  const ox = x + SUN_X * height * RENDER_SCALE;
  const oy = y + SUN_Y * height * RENDER_SCALE;
  ctx.drawImage(tex, ox - rx, oy - ry, rx * 2, ry * 2);
}

/** Text is expensive on canvas; each label is rasterised once and reused. */
const labelCache = new Map<string, HTMLCanvasElement>();

function label(text: string, color: string): HTMLCanvasElement {
  const key = `${color}|${text}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d') as CanvasRenderingContext2D;
  const font = `${7 * RENDER_SCALE}px monospace`;
  measure.font = font;
  canvas.width = Math.ceil(measure.measureText(text).width) + 4;
  canvas.height = 10 * RENDER_SCALE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(4, 7, 12, 0.75)';
  ctx.fillText(text, 2, 2);
  ctx.fillStyle = color;
  ctx.fillText(text, 1, 1);
  if (labelCache.size > 128) labelCache.clear();
  labelCache.set(key, canvas);
  return canvas;
}

export function render(
  screen: Screen,
  map: CityMap | null,
  scene: Scene | null,
  cam: Vec2,
  sprites: SpriteSheet,
  tiles: TileLayer,
  effects: Effects,
  lights: LightPass,
): void {
  const { ctx } = screen;
  worldTransform(ctx);
  ctx.fillStyle = '#0a0d11';
  ctx.fillRect(0, 0, viewport.deviceW, viewport.deviceH);

  if (!map || !scene) {
    ctx.fillStyle = '#8a939e';
    ctx.font = `${10 * RENDER_SCALE}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('connecting…', viewport.deviceW / 2, viewport.deviceH / 2);
    ctx.textAlign = 'left';
    return;
  }

  // The hour, from the tick being rendered. A pure function of it, like the
  // traffic signals: nothing about the clock is on the wire, and two players
  // on the same corner see the same sky because they compute the same number.
  // The hour is set in `main.ts` now, for both renderers. See `sceneNight`.

  // One rounded origin for the whole frame. Every world position derives from
  // it, so the scene translates as a rigid body: no seams between cached
  // chunks, and no entities shivering against the ground by a pixel.
  const originX = Math.round(-cam.x * RENDER_SCALE);
  const originY = Math.round(-cam.y * RENDER_SCALE);
  const dx = (wx: number): number => originX + Math.round(wx * RENDER_SCALE);
  const dy = (wy: number): number => originY + Math.round(wy * RENDER_SCALE);

  // What the light pass needs to know to work out what is standing in front of
  // a lamp: the city, where world origin landed on screen this frame, and
  // everything with a body between the two.
  lights.setWorld(map, originX, originY);
  lights.setOccluders(collectOccluders(scene, cam));

  tiles.draw(ctx, cam, originX, originY);
  // The pools are advanced and fed in `main.ts` — see `spawnSceneEffects` —
  // because the 3D renderer needs the identical set and effects both must have
  // cannot be a side effect of one of them drawing.
  effects.drawDecals(ctx, originX, originY);

  // Street lighting, from the props the server already streams us. Fades in
  // with the dusk: a lamp burning at noon is the one thing that gives away a
  // scene with no clock behind it.
  const lit = 0.15 + 0.85 * lights.nightAmount;
  for (const prop of scene.remotes.props) {
    if (prop.kind !== 'lamp' || !prop.intact) continue;
    // Every lamp on this street is a different lamp: most steady, some
    // humming, one on the way out, the odd dead one that tries and fails.
    // Character comes off the id, so it is the same lamp for every player.
    const f = flicker(lampCharacter(prop.id), prop.id, scene.nowMs);
    lights.point(
      dx(prop.pos.x),
      dy(prop.pos.y),
      34 * RENDER_SCALE,
      'lamp',
      0.5 * f * lit,
      'static',
    );
  }
  drawWindows(map, cam, lit, scene.nowMs, dx, dy, lights);
  for (const shop of map.shops) {
    const wx = (shop.doorX + 0.5) * TILE_SIZE;
    const wy = (shop.doorY + 0.5) * TILE_SIZE;
    if (wx < cam.x - 32 || wy < cam.y - 32 || wx > cam.x + viewport.w + 32 || wy > cam.y + viewport.h + 32) {
      continue;
    }
    // A sign over a door, on a tube old enough to stutter now and then.
    const sign = flicker('neon', shop.doorX * 31 + shop.doorY, scene.nowMs);
    lights.point(dx(wx), dy(wy), 22 * RENDER_SCALE, 'shop', 0.45 * lit * sign, 'static');
    // The room behind the door is lit too, or walking in is walking into a
    // dark hole in the middle of a lit street. Shadowed, which is what makes
    // the light spill out through the doorway and nowhere else.
    const r = shop.interior;
    const cx = (r.x + r.w / 2) * TILE_SIZE;
    const cy = (r.y + r.h / 2) * TILE_SIZE;
    const reach = Math.max(r.w, r.h) * TILE_SIZE * 0.8;
    lights.point(dx(cx), dy(cy), reach * RENDER_SCALE, 'shop', 0.5, 'static');
  }

  drawPackages(ctx, map, cam, scene, dx, dy, lights);
  drawSignals(ctx, map, cam, scene.tick, dx, dy, lights);

  drawProps(ctx, sprites, scene.remotes.props, dx, dy);
  drawPickups(ctx, scene.remotes.pickups, dx, dy, lights, scene.nowMs);

  for (const pd of scene.remotes.peds) {
    // Somebody in your care, marked. An unmarked NPC you must protect is a
    // mission you fail without ever knowing which person mattered.
    if (pd.ped.escortOf !== null) {
      const mx = dx(pd.x);
      const my = dy(pd.y) - (PLAYER_RADIUS + 7) * RENDER_SCALE;
      ctx.fillStyle = '#ffd27a';
      ctx.beginPath();
      ctx.moveTo(mx, my + 4 * RENDER_SCALE);
      ctx.lineTo(mx - 3 * RENDER_SCALE, my);
      ctx.lineTo(mx + 3 * RENDER_SCALE, my);
      ctx.closePath();
      ctx.fill();
    }
    const variant = pd.ped.id % PED_VARIANTS;
    const facing = Math.atan2(pd.ped.dirY, pd.ped.dirX);
    // Gang members wear their colours. Being able to read a street at a
    // glance is the whole reason turf exists.
    const tint = GANG_TINT[pd.ped.gangId] ?? '#7a7f6d';
    // Down but not out: still on the bleed-out clock, and still worth an
    // ambulance. See drawBody.
    const dying = pd.ped.mode === 'downed';
    if (dying || pd.ped.mode === 'dead') {
      // `timer` counts DOWN from the clock they are on, so what is left of it
      // is what says how long they have been there.
      const full = (dying ? getTuning().peds.bleedOutSec : getTuning().peds.corpseSec) * TICK_RATE;
      // Curled if they are still in there, sprawled if they are not — and
      // which sprawl is hashed off the id, so the same body keeps the same
      // pose on every client and for as long as it lies there.
      const pose = dying ? 'Downed' : `Dead${deadPose(pd.ped.id)}`;
      drawBody(ctx, sprites, `ped${pose}_v${variant}`, dx(pd.x), dy(pd.y), facing, tint, pd.x, pd.y, {
        alive: dying,
        ageSec: Math.max(0, full - pd.ped.timer) / TICK_RATE,
        nowMs: scene.nowMs,
        key: `d${pd.ped.id}`,
        seed: pd.ped.id,
        effects,
      });
      continue;
    }
    const frame = walkFrame(`d${pd.ped.id}`, pd.x, pd.y);
    drawCharacter(ctx, sprites, `ped_v${variant}_f${frame}`, dx(pd.x), dy(pd.y), facing, tint);
  }
  // Projectiles: small, bright, and drawn over everything on the ground so a
  // rocket coming at you is the most legible thing on screen.
  for (const pr of scene.remotes.projectiles) {
    const x = dx(pr.x);
    const y = dy(pr.y);
    const kind = pr.projectile.kind;
    if (kind === 'slick') {
      // A stain on the road, not a bright object: you are meant to be able to
      // miss it, and to swear when you do not.
      ctx.fillStyle = 'rgba(20, 18, 26, 0.62)';
      ctx.beginPath();
      ctx.ellipse(x, y, 11 * RENDER_SCALE, 8 * RENDER_SCALE, 0, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    if (kind === 'mine') {
      ctx.fillStyle = '#c85a4a';
      ctx.fillRect(x - 2 * RENDER_SCALE, y - 2 * RENDER_SCALE, 4 * RENDER_SCALE, 4 * RENDER_SCALE);
      // A slow blink, so a mine reads as armed rather than as litter.
      if (Math.floor(scene.nowMs / 500) % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 120, 90, 0.5)';
        ctx.beginPath();
        ctx.arc(x, y, 5 * RENDER_SCALE, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    const rocket = kind === 'rocket';
    ctx.fillStyle = rocket ? '#ffd27a' : '#c8d0a0';
    ctx.beginPath();
    ctx.arc(x, y, (rocket ? 2.2 : 1.8) * RENDER_SCALE, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rocket ? 'rgba(255, 168, 64, 0.45)' : 'rgba(190, 200, 150, 0.3)';
    ctx.beginPath();
    ctx.arc(x, y, (rocket ? 4.5 : 3.2) * RENDER_SCALE, 0, Math.PI * 2);
    ctx.fill();
  }

  // Air units are drawn LAST, after everything on the ground, so a
  // helicopter passes over the street rather than behind a lamp post.
  const airborne: typeof scene.remotes.cops = [];
  for (const c of scene.remotes.cops) {
    const angle = Math.atan2(c.cop.vel.y, c.cop.vel.x);
    if (c.cop.health > 0 && AIR_KINDS.has(c.cop.kind)) {
      airborne.push(c);
      continue;
    }
    // The uniform says which force you have brought down on yourself. Police
    // blue, SWAT charcoal, federal navy, army olive — you should be able to
    // tell what is chasing you without reading the star count.
    const tint = COP_TINT[c.cop.kind] ?? '#3a5fb0';
    // An officer at zero health is a body, not a pursuer — see damageCop.
    // `idleTicks` counts UP from the moment they went down, which is exactly
    // the age the blood wants.
    if (c.cop.health <= 0) {
      drawBody(ctx, sprites, 'copDead', dx(c.x), dy(c.y), angle, tint, c.x, c.y, {
        alive: false,
        ageSec: c.cop.idleTicks / TICK_RATE,
        nowMs: scene.nowMs,
        key: `c${c.cop.id}`,
        seed: c.cop.id,
        effects,
      });
      continue;
    }
    const frame = walkFrame(`c${c.cop.id}`, c.x, c.y);
    const base = COP_SPRITE[c.cop.kind] ?? 'cop';
    drawCharacter(ctx, sprites, `${base}_f${frame}`, dx(c.x), dy(c.y), angle, tint);
  }
  for (const r of scene.remotes.players) {
    const key = `p${r.player.id}`;
    const frame = walkFrame(key, r.x, r.y);
    drawPlayer(
      ctx,
      sprites,
      r.player,
      dx(r.x),
      dy(r.y),
      r.aimAngle,
      frame,
      false,
      r.x,
      r.y,
      scene.tick,
      scene.nowMs,
      effects,
    );
  }
  if (scene.local && scene.localPos && scene.local.mode !== 'driving') {
    const frame = walkFrame('local', scene.localPos.x, scene.localPos.y);
    // The smoothed aim angle, not the raw one: aim only changes on ticks too,
    // and a 30 Hz aim tick on a 144 Hz display is just as visible as a 30 Hz
    // position.
    const aim = scene.localPos.angle;
    drawPlayer(
      ctx,
      sprites,
      scene.local,
      dx(scene.localPos.x),
      dy(scene.localPos.y),
      aim,
      frame,
      true,
      scene.localPos.x,
      scene.localPos.y,
      scene.tick,
      scene.nowMs,
      effects,
    );
  }

  // Vehicles ride above people on foot: a car passing over someone should
  // occlude them, not the other way round.
  for (const rv of scene.remotes.vehicles) {
    drawVehicle(
      ctx,
      sprites,
      lights,
      effects,
      rv.vehicle.id,
      rv.vehicle.kind,
      rv.x,
      rv.y,
      rv.heading,
      rv.vehicle.speed,
      rv.vehicle.driverId !== null,
      rv.vehicle.condition,
      vehicleWear(rv.vehicle),
      rv.vehicle.zones,
      rv.vehicle.broken,
      getVehicleTuning(rv.vehicle.kind).health,
      dx,
      dy,
      scene.nowMs,
      // Altitude comes off the wire now: an aircraft is over the city, and
      // everybody watching it needs to see that, not just its pilot.
      rv.vehicle.z,
      rv.vehicle.gangId,
      // A turret points where its driver is aiming, and the driver's aim is
      // already interpolated for their body, so the barrel is exactly as
      // smooth as everything else on screen.
      aimOf(scene, rv.vehicle.driverId),
      riderSprite(scene, rv.vehicle.driverId),
      rv.vehicle.paint,
    );
  }
  if (scene.localVehicle) {
    drawVehicle(
      ctx,
      sprites,
      lights,
      effects,
      scene.local?.vehicleId ?? 0,
      scene.localVehicle.kind,
      scene.localVehicle.pos.x,
      scene.localVehicle.pos.y,
      scene.localVehicle.heading,
      scene.localVehicle.speed,
      true,
      scene.localVehicle.condition,
      scene.localVehicle.wear,
      scene.localVehicle.zones,
      scene.localVehicle.broken,
      getVehicleTuning(scene.localVehicle.kind).health,
      dx,
      dy,
      scene.nowMs,
      scene.localVehicle.z,
      scene.localVehicle.gangId,
      // Your own turret comes off your own smoothed aim, not off the wire, so
      // it answers the mouse on the frame you move it.
      scene.localPos?.angle ?? scene.local?.aimAngle ?? null,
      riderSprite(scene, scene.local?.vehicleId === null ? null : (scene.local?.id ?? null)),
      scene.localVehicle.paint,
    );
  }

  // Air support, over the top of the whole street.
  //
  // A helicopter is a COP in the sim — same table, same targeting, same
  // corpse timer — and the only thing the renderer has to know is that it is
  // not standing on the ground. The lift plus a shadow left where the shadow
  // belongs is what sells it, the same trick a car mid-stunt-jump uses.
  for (const c of airborne) {
    const angle = Math.atan2(c.cop.vel.y, c.cop.vel.x);
    const sx = dx(c.x);
    const sy = dy(c.y);
    const lift = AIR_HEIGHT * RENDER_SCALE;
    const fp = sprites.footprint(c.cop.kind);
    drawShadow(ctx, sx, sy, fp.rx * 0.5, fp.ry * 0.5, AIR_HEIGHT);
    // The searchlight: a cone under the aircraft, pointed the way it is
    // going. It is the reason the thing is frightening rather than merely
    // present — you can see exactly what it can see.
    const beam = getTuning().police.kinds[c.cop.kind]?.searchlight ?? 0;
    if (beam > 0) {
      lights.point(sx, sy, beam * RENDER_SCALE * 0.55, 'shop', 0.5, 'none');
      lights.cone(sx, sy, angle, beam * RENDER_SCALE, 'head', 0.42, 'none');
    }
    sprites.draw(ctx, c.cop.kind, sx, sy - lift, angle);
  }

  effects.drawParticles(ctx, originX, originY, lights);
  lights.render(ctx);

  // Name tags are drawn in HUD space from `main.ts` now, for both renderers.
  // See `drawNameTags`.
}

/**
 * Who everybody is, over their heads.
 *
 * Drawn in HUD units rather than device pixels, and from `main.ts` rather than
 * from inside a renderer, because both renderers need it and the mapping is the
 * same for both: the 3D camera hangs straight down over the middle of the same
 * frame, so a point on the ground lands at `world - cam` in either view. That
 * is the same identity the radar and mouse aim rely on.
 *
 * Last, above everything including the night grade, so a name stays readable in
 * the dark.
 */
export function drawNameTags(ctx: CanvasRenderingContext2D, scene: Scene, cam: Vec2): void {
  const tag = (text: string, color: string, wx: number, wy: number): void => {
    const img = label(text, color);
    // `label` rasterises at RENDER_SCALE for the device-pixel path it was
    // written for; in HUD units that is one scale factor too many.
    const w = img.width / RENDER_SCALE;
    const h = img.height / RENDER_SCALE;
    ctx.drawImage(img, wx - cam.x - w / 2, wy - cam.y - (PLAYER_RADIUS + 12), w, h);
  };
  for (const r of scene.remotes.players) {
    if (r.player.mode === 'dead') continue;
    tag(
      r.player.name,
      REMOTE_COLORS[r.player.id % REMOTE_COLORS.length] as string,
      r.x,
      r.y,
    );
  }
  if (scene.local && scene.localPos && scene.local.mode !== 'driving') {
    tag(scene.local.name, LOCAL_COLOR, scene.localPos.x, scene.localPos.y);
  }
}

/**
 * How long a day is for this city, in seconds.
 *
 * Carried on the map because it ships with the seed in the welcome message,
 * so the client's clock and the server's are the same function of the tick
 * without a second thing to keep in step.
 */
/**
 * How dark it is in the scene being rendered, 0 (midday) to 1 (midnight).
 *
 * A pure function of the tick, like the traffic signals: nothing about the clock
 * is on the wire, and two players on the same corner see the same sky because
 * they compute the same number.
 *
 * Exported and called from `main.ts` because BOTH renderers need it. It used to
 * be computed inside `render()` and pushed into the light pass there, which
 * meant the 3D path read `lights.nightAmount` before anything had ever set it —
 * so the 3D city sat at the pass's initial 0.5 for ever and the day never turned
 * over. Same shape of bug as the effects that were never advanced.
 */
export function sceneNight(map: CityMap, scene: Scene): number {
  return scene.night ?? nightAmount(timeOfDay(scene.tick, dayLengthSec(map)));
}

function dayLengthSec(map: CityMap): number {
  return map.dayLengthSec > 0 ? map.dayLengthSec : 1440;
}

/**
 * How wet the streets are, on the same terms as `sceneNight`.
 *
 * Only the 3D ground layer draws it. The 2D renderer paints its ground from a
 * chunk cache that is built once and blitted thereafter, so weather there
 * would mean repainting the city every time the number moved.
 */
export function sceneWet(map: CityMap, scene: Scene): number {
  return wetness(scene.tick, dayLengthSec(map));
}

/**
 * Hidden packages, drawn where the map says they are.
 *
 * Never streamed: the client generated the same city from the same seed, so
 * the positions are already here and the only thing the server has to say is
 * which ones YOU have found. One found is drawn dim and pays nothing; your
 * neighbour's find is still there for you. That is the whole design.
 */
/** A hidden package: gold while it is worth taking, grey once it is not. */
export const PACKAGE_COLOR = '#f0e2a0';
export const PACKAGE_TAKEN = 'rgba(120, 130, 145, 0.35)';

function drawPackages(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  cam: Vec2,
  scene: Scene,
  dx: (x: number) => number,
  dy: (y: number) => number,
  lights: LightPass,
): void {
  const found = scene.foundPackages;
  const R = RENDER_SCALE;
  for (let i = 0; i < map.packages.length; i++) {
    const at = map.packages[i] as Vec2;
    if (
      at.x < cam.x - 20 ||
      at.y < cam.y - 20 ||
      at.x > cam.x + viewport.w + 20 ||
      at.y > cam.y + viewport.h + 20
    ) {
      continue;
    }
    const taken = found?.has(i) === true;
    const x = dx(at.x);
    const y = dy(at.y);
    // A slow glint rather than the pickups' bob: it should read as something
    // left behind, not as something laid out for you.
    const pulse = taken ? 0 : 0.5 + 0.5 * Math.sin(scene.nowMs * 0.002 + i);
    ctx.fillStyle = taken ? PACKAGE_TAKEN : PACKAGE_COLOR;
    ctx.fillRect(x - 2 * R, y - 2 * R, 4 * R, 4 * R);
    if (!taken) lights.point(x, y, (6 + pulse * 4) * R, 'shop', 0.25 + pulse * 0.2);
  }
}

/**
 * How tall things stand, in world pixels, for the shadows they throw.
 *
 * The numbers matter against `LIGHT_HEIGHT`, not on their own: a person at 9
 * is taller than a headlight at 4 and shorter than a street lamp at 30, so the
 * same pedestrian throws a shadow down the whole street in front of a car and
 * a stub of one under a lamp post. That ratio is the entire model.
 */
const BODY_HEIGHT = 9;
const CAR_HEIGHT = 7;

/** Reused every frame: the light pass reads it and never keeps it. */
const occluders: Occluder[] = [];

/**
 * The bodies and cars close enough to the view to be worth casting.
 *
 * A margin of one screen beyond the frame, because a shadow is thrown by
 * something that need not be visible itself — the whole point of the long
 * shadow a headlight throws is that you see it before you see what is making
 * it. Parked and moving cars alike: an empty car parked across a beam stops it
 * just as well as one with a driver.
 */
function collectOccluders(scene: Scene, cam: Vec2): Occluder[] {
  occluders.length = 0;
  const x0 = cam.x - viewport.w * 0.5;
  const y0 = cam.y - viewport.h * 0.5;
  const x1 = cam.x + viewport.w * 1.5;
  const y1 = cam.y + viewport.h * 1.5;
  const inView = (x: number, y: number): boolean => x > x0 && y > y0 && x < x1 && y < y1;
  const body = (x: number, y: number): void => {
    if (!inView(x, y)) return;
    occluders.push({
      x,
      y,
      r: PLAYER_RADIUS,
      halfLong: 0,
      halfWide: 0,
      heading: 0,
      height: BODY_HEIGHT,
    });
  };

  for (const r of scene.remotes.players) body(r.x, r.y);
  for (const c of scene.remotes.cops) body(c.x, c.y);
  for (const pd of scene.remotes.peds) {
    // The dead lie down. A body on the tarmac is not a wall.
    if (pd.ped.mode === 'dead' || pd.ped.mode === 'downed') continue;
    body(pd.x, pd.y);
  }
  if (scene.localPos && scene.local?.mode !== 'driving') body(scene.localPos.x, scene.localPos.y);

  const car = (x: number, y: number, heading: number, kind: string): void => {
    if (!inView(x, y)) return;
    const t = getVehicleTuning(kind);
    occluders.push({
      x,
      y,
      r: 0,
      // The body's real half-extents, the same pair everything else asks
      // for. A shadow cast from a 9 px square while the car it belongs to is
      // 12 long and 5.5 wide is a shadow that does not fit its own car.
      halfLong: t.halfLength,
      halfWide: t.halfWidth,
      heading,
      height: CAR_HEIGHT,
    });
  };
  for (const rv of scene.remotes.vehicles) {
    car(rv.x, rv.y, rv.heading, rv.vehicle.kind);
  }
  if (scene.localVehicle) {
    car(
      scene.localVehicle.pos.x,
      scene.localVehicle.pos.y,
      scene.localVehicle.heading,
      scene.localVehicle.kind,
    );
  }
  return occluders;
}

/** Windows lit in one frame, whatever the view size. Bounds the worst block. */
const MAX_WINDOWS = 96;
/** Share of a building's edge tiles with somebody still up. */
const WINDOW_ODDS = 0.26;

/**
 * Lit windows, after dark.
 *
 * The single cheapest thing that turns a grid of dark roofs back into a city:
 * a scatter of warm rectangles around the edge of every block, out of phase,
 * a few of them the flickering blue of a television nobody is watching. Which
 * windows are lit is a hash of the tile, so it is the same building every
 * night and for every player, and it costs no state.
 *
 * They cast nothing — a window is already at the wall it would be occluded
 * by — which is what keeps a hundred of them affordable.
 */
function drawWindows(
  map: CityMap,
  cam: Vec2,
  lit: number,
  nowMs: number,
  dx: (x: number) => number,
  dy: (y: number) => number,
  lights: LightPass,
): void {
  // Nothing to see until the light has actually gone.
  if (lit < 0.35) return;
  const x0 = cam.x - TILE_SIZE;
  const y0 = cam.y - TILE_SIZE;
  const x1 = cam.x + viewport.w + TILE_SIZE;
  const y1 = cam.y + viewport.h + TILE_SIZE;
  let budget = MAX_WINDOWS;

  for (const b of map.buildings) {
    if (budget <= 0) return;
    const bx0 = b.x * TILE_SIZE;
    const by0 = b.y * TILE_SIZE;
    const bx1 = (b.x + b.w) * TILE_SIZE;
    const by1 = (b.y + b.h) * TILE_SIZE;
    if (bx1 < x0 || by1 < y0 || bx0 > x1 || by0 > y1) continue;

    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        // Edge tiles only: the middle of a block has no outside wall.
        const edgeX = tx === b.x ? -1 : tx === b.x + b.w - 1 ? 1 : 0;
        const edgeY = ty === b.y ? -1 : ty === b.y + b.h - 1 ? 1 : 0;
        if (edgeX === 0 && edgeY === 0) continue;
        const r = hash2(tx, ty, 0x77d1);
        if (r > WINDOW_ODDS) continue;
        const wx = (tx + 0.5 + edgeX * 0.42) * TILE_SIZE;
        const wy = (ty + 0.5 + edgeY * 0.42) * TILE_SIZE;
        if (wx < x0 || wy < y0 || wx > x1 || wy > y1) continue;
        if (budget-- <= 0) return;
        // One in eight is a television: cooler, and never still.
        const tv = r < WINDOW_ODDS * 0.13;
        const id = tx * 7919 + ty;
        const f = tv ? 0.4 + 0.6 * flicker('fire', id, nowMs) : 1;
        lights.point(
          dx(wx),
          dy(wy),
          (tv ? 7 : 9) * RENDER_SCALE,
          tv ? 'blue' : 'window',
          (tv ? 0.3 : 0.34) * lit * f,
        );
      }
    }
  }
}

/** Traffic-signal colours, ordered so the array index is the lamp position. */
export const SIGNAL_COLORS: Record<SignalColour, string> = {
  red: '#ff5a4a',
  amber: '#ffc23c',
  green: '#5ce08a',
};

/**
 * The lights at every junction arm in view.
 *
 * Read from `signalColour` — the same function the drivers consult — with the
 * tick being rendered, so what the player sees and what the traffic obeys
 * cannot drift apart. Nothing about signals is on the wire; both ends compute
 * the phase from the tick they already have.
 *
 * Drawn here rather than baked into the tile layer on purpose: the colour
 * changes every few seconds, and a cached chunk that had to be rebuilt on
 * every phase change would turn a free feature into a performance problem.
 */
function drawSignals(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  cam: Vec2,
  tick: number,
  dx: (x: number) => number,
  dy: (y: number) => number,
  lights: LightPass,
): void {
  const heads = map.junctions?.heads;
  if (!heads) return;
  const timing = getTrafficTuning().signals;
  const R = RENDER_SCALE;
  for (const head of heads) {
    if (
      head.x < cam.x - 24 ||
      head.y < cam.y - 24 ||
      head.x > cam.x + viewport.w + 24 ||
      head.y > cam.y + viewport.h + 24
    ) {
      continue;
    }
    const colour = signalColour(head.junctionId, head.dirIdx, tick, timing);
    // Stand the head at the kerb on the driver's right, facing back down the
    // arm — where a real one is, and out of the carriageway the car uses.
    const ax = CARDINALS[head.dirIdx]![0]!;
    const ay = CARDINALS[head.dirIdx]![1]!;
    const px = head.x + ax * 5 - ay * RIGHT_OFFSET;
    const py = head.y + ay * 5 + ax * RIGHT_OFFSET;
    const sx = dx(px);
    const sy = dy(py);
    ctx.fillStyle = '#1b2028';
    ctx.fillRect(sx - 2 * R, sy - 2 * R, 4 * R, 4 * R);
    ctx.fillStyle = SIGNAL_COLORS[colour];
    ctx.fillRect(sx - 1 * R, sy - 1 * R, 2 * R, 2 * R);
    // Dimmer than it was, because the bloom now carries it: every junction
    // arm has a head, and at the old alpha a night grid read as fairy lights.
    lights.point(sx, sy, 7 * R, colour === 'green' ? 'lamp' : 'red', 0.22, 'static');
  }
}

/** How far off the centre of the arm a signal head stands, in world px. */
export const RIGHT_OFFSET = 9;

function drawProps(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  props: PropState[],
  dx: (n: number) => number,
  dy: (n: number) => number,
): void {
  for (const prop of props) {
    const x = dx(prop.pos.x);
    const y = dy(prop.pos.y);
    const name = prop.intact ? prop.kind : `${prop.kind}_broken`;
    const rot = prop.orient === 1 ? Math.PI / 2 : 0;
    if (prop.intact) {
      const fp = sprites.footprint(name);
      drawShadow(ctx, x, y, fp.rx * 0.85, fp.ry * 0.85, 3);
    }
    if (!sprites.draw(ctx, name, x, y, rot)) {
      ctx.fillStyle = prop.intact ? '#8a8f96' : '#4a4e53';
      ctx.fillRect(x - 3 * RENDER_SCALE, y - 3 * RENDER_SCALE, 6 * RENDER_SCALE, 6 * RENDER_SCALE);
    }
  }
}

/**
 * Pickup, package and signal colours, and where a signal head stands.
 *
 * Exported because the 3D renderer draws the same objects and a health crate
 * that is green in one view and blue in the other is not the same city. One
 * definition, both renderers — the same reason the effects fade curves are
 * shared.
 */
export const PICKUP_COLORS: Record<string, string> = {
  health: '#57c98a',
  armour: '#5aa8e0',
  ammo: '#e0b452',
  // Power-ups read as a distinct family: hotter, and none of them green.
  frenzy: '#e0543c',
  bribe: '#f0c040',
  jailcard: '#e8e0c0',
  damage: '#ff7a4a',
  invis: '#9fd8e8',
  reload: '#c39ce0',
  // Gold, and alone in being gold: it is the rarest thing on the ground.
  multi: '#ffd75e',
  // Green, and the only green that is not health: it is money.
  cash: '#8fe07a',
  // Gunmetal, and deliberately not part of the crate family: this one was
  // dropped by somebody, not placed by the city.
  weapon: '#b9bcc4',
};

/**
 * Pickups are drawn rather than sprited: a small floating lozenge with a
 * glow, bobbing on wall-clock time. They have to read instantly at a glance
 * from across the street, and a flat colour-coded shape does that better
 * than a 12-pixel crate would.
 */
function drawPickups(
  ctx: CanvasRenderingContext2D,
  pickups: PickupState[],
  dx: (n: number) => number,
  dy: (n: number) => number,
  lights: LightPass,
  nowMs: number,
): void {
  for (const pu of pickups) {
    if (!pu.active) continue;
    const color = PICKUP_COLORS[pu.kind] ?? '#c0c0c0';
    // A dropped gun lies where its owner fell: it does not float or bob, and
    // it should read as litter you can pick up rather than as a crate the
    // level designer put there.
    if (pu.kind === 'weapon') {
      const gx = dx(pu.pos.x);
      const gy = dy(pu.pos.y);
      const len = 4 * RENDER_SCALE;
      drawShadow(ctx, gx, gy, len, len * 0.5, 1);
      ctx.fillStyle = color;
      ctx.fillRect(gx - len, gy - RENDER_SCALE, len * 2, RENDER_SCALE * 2);
      ctx.fillRect(gx - len * 0.3, gy, RENDER_SCALE * 2, RENDER_SCALE * 2);
      lights.point(gx, gy, 7 * RENDER_SCALE, 'head', 0.16);
      continue;
    }
    const bob = Math.sin(nowMs * 0.004 + pu.id) * 1.5 * RENDER_SCALE;
    const x = dx(pu.pos.x);
    const y = dy(pu.pos.y) + bob;
    const r = 4 * RENDER_SCALE;

    drawShadow(ctx, dx(pu.pos.x), dy(pu.pos.y), r * 1.1, r * 0.8, 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = RENDER_SCALE;
    ctx.stroke();
    ctx.lineWidth = 1;
    lights.point(x, y, 9 * RENDER_SCALE, 'head', 0.22);
  }
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  name: string,
  x: number,
  y: number,
  angle: number,
  fallback: string,
): void {
  drawShadow(ctx, x, y, 8 * RENDER_SCALE, 7 * RENDER_SCALE, 3);
  if (sprites.draw(ctx, name, x, y, angle)) return;
  ctx.fillStyle = fallback;
  const r = PLAYER_RADIUS * RENDER_SCALE;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/**
 * The shape of somebody lying on the floor.
 *
 * There are three of these now and they are drawn, not derived. What they
 * replaced was the STANDING sprite scaled 1.5x along the axis it fell and
 * 0.82x across — a trick that got the silhouette roughly right and everything
 * else wrong. A standing figure seen from above is a head, two shoulders and
 * the tops of two feet; stretching that gives you a stretched head and
 * stretched shoulders, which reads as a person standing slightly further
 * away. Somebody on the ground is a different drawing: you are looking down
 * their whole length, their arms are out, their legs are splayed, and their
 * face is either in the tarmac or at the sky.
 *
 * Which pose a given body takes is hashed off its id, so it is the same body
 * on every client and stays the same for as long as it lies there.
 *
 * The `downed` pose — curled on one side, one arm across the chest — is the
 * one that earns its keep twice over. A casualty on the bleed-out clock has
 * an ambulance coming and is worth something to whoever reaches them; a
 * corpse is not. That difference used to be carried entirely by an alpha
 * value and a slightly warmer colour, which is to say by nothing you would
 * notice from across a street.
 */
const DEAD_POSES = 2;

/**
 * Which sprawl a given body takes: stable per entity, same on every client.
 *
 * Through the proper mixer, not `id * someLargePrime % 2`. That was the first
 * version and it always returned the same pose, because multiplying by an odd
 * number preserves parity — every even id took pose A and every odd id took
 * pose B, and any id sequence with a stride of 2 (which is most of them, ids
 * being handed out in runs) took one pose for ever. A test caught it.
 */
export function deadPose(id: number): string {
  return String.fromCharCode(65 + Math.floor(hash2(id, 0, 0xb0d1) * DEAD_POSES) % DEAD_POSES);
}

/** Seconds a fresh body keeps bleeding out onto the ground. */
const BLEED_SEC = 4.5;


/**
 * Somebody on the ground.
 *
 * The sim leaves the dead in the world now — a pedestrian's body for forty
 * seconds, an officer's for the same, a player's until they respawn — and
 * before this they were drawn walking about like everyone else. Same sprite,
 * squashed towards the ground, over a pool: no new art, and legible at
 * 480 x 270 from across the street.
 *
 * `alive` is the whole reason this takes a flag. A pedestrian who went down
 * instead of dying is on a bleed-out clock and an ambulance is on its way to
 * them (sim/ambulance.ts) — but drawn identically to a corpse, which is what
 * a screenshot of the finished feature showed, they are indistinguishable
 * from the thing nobody can do anything about. A casualty keeps their colour
 * and breathes; a body is drained and still.
 */
interface BodyOptions {
  /** On the bleed-out clock rather than gone. Keeps its colour, and breathes. */
  alive: boolean;
  /** Seconds since they went down. Drives how far the blood has spread. */
  ageSec: number;
  nowMs: number;
  /** Stable per-entity key: the bleed cadence and the pool's shape hang off it. */
  key: string;
  /** Entity id, for the pool's hashed irregularity and the breathing phase. */
  seed: number;
  /** Where the blood goes. Emitted here, so it needs no event to exist. */
  effects: Effects;
}

export function drawBody(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  name: string,
  x: number,
  y: number,
  /** World angle they came to rest along. */
  angle: number,
  fallback: string,
  /** World position, for emitting decals — x/y above are device pixels. */
  wx: number,
  wy: number,
  o: BodyOptions,
): void {
  const r = PLAYER_RADIUS * RENDER_SCALE;


  // The pool directly beneath, which unlike the decals tracks the body and is
  // guaranteed present — a corpse that comes into view a minute after it was
  // made must not arrive on clean tarmac. Three overlapping blobs, hashed off
  // the id: a single ellipse is the shape of a thing that was printed, not
  // the shape of a thing that leaked.
  const spread = o.alive
    ? 0.55 + 0.25 * Math.min(1, o.ageSec / 8)
    : 0.35 + 0.65 * Math.min(1, o.ageSec / BLEED_SEC);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = o.alive ? BLOOD_DROP : BLOOD_POOL;
  for (let i = 0; i < 3; i++) {
    const h = hash3(o.seed, i, 7);
    const along = (h % 1) * 2 - 1;
    const across = ((h * 3.7) % 1) * 2 - 1;
    const size = 0.55 + ((h * 11.3) % 1) * 0.55;
    ctx.beginPath();
    ctx.ellipse(
      along * r * 0.85 * spread,
      across * r * 0.4 * spread,
      r * 1.25 * spread * size,
      r * 0.75 * spread * size,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();

  // The body: a plain baked blit at the angle they came to rest along, like
  // every other sprite in the game. No transform, no scale — the drawing
  // already IS a person on the ground.
  if (!sprites.draw(ctx, name, x, y, angle)) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = fallback;
    ctx.fillRect(-r * 1.5, -r * 0.8, r * 3, r * 1.6);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (o.alive) {
    // Breathing. A slow, shallow glow is the cheapest possible "there is
    // still someone in there", and it is the only cue that says an ambulance
    // would not be wasted on them.
    const breath = 0.5 + 0.5 * Math.sin(o.nowMs * 0.0035 + o.seed);
    ctx.globalAlpha = 0.12 + 0.16 * breath;
    ctx.fillStyle = '#e8d4b0';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * (1.2 + 0.2 * breath), r * (0.55 + 0.1 * breath), 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Drained of colour: a body is the one thing on the street that has
    // stopped being a participant, and it should stop drawing the eye.
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#1a1a20';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.5, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  p: PlayerState,
  x: number,
  y: number,
  /** Where the mouse points: both the firing line and the way the body faces. */
  aim: number,
  frame: number,
  isLocal: boolean,
  /** World position and the scene clock, for a body's blood. */
  wx = 0,
  wy = 0,
  tick = 0,
  nowMs = 0,
  effects: Effects | null = null,
): void {
  const variant = Math.abs(p.cosmeticId) % PLAYER_VARIANTS;
  const fallback = isLocal ? LOCAL_COLOR : (REMOTE_COLORS[p.id % REMOTE_COLORS.length] as string);
  // Dead is dead: no walk cycle, no aim tick, and a body on the tarmac for
  // the three seconds before the ambulance-shaped respawn timer runs out.
  if (p.mode === 'dead' && effects) {
    // The respawn clock counts down, so what has elapsed of it is the age.
    const left = p.respawnAtTick === null ? 0 : p.respawnAtTick - tick;
    drawBody(ctx, sprites, `playerDead${deadPose(p.id)}_v${variant}`, x, y, aim, fallback, wx, wy, {
      alive: false,
      ageSec: Math.max(0, RESPAWN_DELAY_TICKS - left) / TICK_RATE,
      nowMs,
      key: `p${p.id}`,
      seed: p.id,
      effects,
    });
    return;
  }
  // Empty hands look like empty hands. The avatar used to hold a pistol
  // whatever was selected, so a fist fight was two men pointing guns at each
  // other and a punch came out of the barrel.
  const pose = playerPose(p);
  const name =
    pose === 'playerPunch'
      ? `playerPunch_v${variant}`
      : `${pose}_v${variant}_f${frame}`;
  // Off the ground: bailing out of an aircraft is a real fall in the sim, and
  // without this it read as standing still for a quarter of a second and then
  // bleeding for no reason. Same lift-and-shadow trick as an air unit, at the
  // player's own `z` — which the snapshot already carries, so a remote player
  // falls in your window too.
  let by = y;
  if (p.z > 0) {
    drawShadow(ctx, x, y, PLAYER_RADIUS * RENDER_SCALE, PLAYER_RADIUS * 0.6 * RENDER_SCALE, p.z);
    by -= p.z * RENDER_SCALE;
  }
  drawCharacter(ctx, sprites, name, x, by, aim, fallback);

  // A short aim tick keeps the firing line legible when the sprite's own
  // weapon is only a few pixels long.
  ctx.strokeStyle = isLocal ? 'rgba(255,255,255,0.6)' : 'rgba(200,200,200,0.35)';
  ctx.lineWidth = RENDER_SCALE;
  ctx.beginPath();
  const inner = (PLAYER_RADIUS + 3) * RENDER_SCALE;
  const outer = (PLAYER_RADIUS + 8) * RENDER_SCALE;
  ctx.moveTo(x + Math.cos(aim) * inner, by + Math.sin(aim) * inner);
  ctx.lineTo(x + Math.cos(aim) * outer, by + Math.sin(aim) * outer);
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Most dents one quadrant of a car can show before it is simply crumpled. */
const MAX_DENTS_PER_ZONE = 4;

/** A cheap deterministic hash: no rng, no per-frame state, stable on restart. */
function hash3(a: number, b: number, c: number): number {
  return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453);
}

/**
 * Crumpled panels, shattered lamps, missing bumpers — drawn onto the sprite.
 *
 * A car's condition used to be `floor(wear * 7)` dents in positions hashed off
 * the vehicle id. Two things were wrong with that. The first dent needed 28.6
 * of a car's 200 health, which took four full-speed impacts, so an ordinary
 * prang left the bodywork completely untouched. And the placement had nothing
 * to do with where you were hit: you could reverse into a wall and watch a
 * dent appear on the bonnet.
 *
 * Both come from the damage map now. Dents are counted per zone and confined
 * to that quadrant of the body, so the corner you hit is the corner that
 * crumples, and the first one arrives at 3% of health — one solid knock.
 *
 * `source-atop` clips everything to the sprite's own alpha, so it lands on the
 * bodywork and never squares off over the road underneath.
 */
function drawBodyDamage(
  ctx: CanvasRenderingContext2D,
  id: number,
  x: number,
  y: number,
  heading: number,
  fp: { rx: number; ry: number },
  zones: number[],
  broken: number,
  maxHealth: number,
  wear: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);

  // Panels that are simply GONE read as a dark gap in the bodywork, clipped
  // to the sprite like everything else here.
  //
  // Not `destination-out`: erasing the sprite leaves a transparent hole, and
  // the light pass then adds headlight glow into it with `lighter`, so a
  // missing front bumper came out as a bright white bar — which looks like
  // chrome that is still attached rather than chrome that has gone.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(10, 9, 11, 0.9)';
  if ((broken & PART_BUMPER_F) !== 0) {
    ctx.fillRect(fp.rx - 1.6 * RENDER_SCALE, -fp.ry * 0.62, 1.7 * RENDER_SCALE, fp.ry * 1.24);
  }
  if ((broken & PART_BUMPER_R) !== 0) {
    ctx.fillRect(-fp.rx - 0.1 * RENDER_SCALE, -fp.ry * 0.62, 1.7 * RENDER_SCALE, fp.ry * 1.24);
  }
  if ((broken & PART_DOOR_L) !== 0) {
    ctx.fillRect(-fp.rx * 0.2, -fp.ry, fp.rx * 0.5, 1.5 * RENDER_SCALE);
  }
  if ((broken & PART_DOOR_R) !== 0) {
    ctx.fillRect(-fp.rx * 0.2, fp.ry - 1.5 * RENDER_SCALE, fp.rx * 0.5, 1.5 * RENDER_SCALE);
  }
  // Dents, per quadrant. Zone order is front, right, rear, left; each one is
  // painted inside its own third of the body so the damage is where the hit
  // was. Placement is hashed off (id, zone, index) — a given car's dents sit
  // in the same places every frame, which is what makes them read as damage
  // rather than as static.
  const perDent = maxHealth * 0.03;
  for (let z = 0; z < 4; z++) {
    const amount = zones[z] ?? 0;
    const count = Math.min(MAX_DENTS_PER_ZONE, Math.floor(amount / perDent));
    for (let i = 0; i < count; i++) {
      const h = hash3(id, z * 11 + 1, i);
      const u = h % 1;
      const w = (h * 7) % 1;
      // Along the body for front/rear, across it for left/right.
      let px: number;
      let py: number;
      if (z === 0) {
        px = fp.rx * (0.28 + u * 0.55);
        py = (w * 2 - 1) * fp.ry * 0.7;
      } else if (z === 2) {
        px = -fp.rx * (0.28 + u * 0.55);
        py = (w * 2 - 1) * fp.ry * 0.7;
      } else {
        px = (u * 2 - 1) * fp.rx * 0.66;
        py = (z === 1 ? 1 : -1) * fp.ry * (0.3 + w * 0.6);
      }
      const r = (0.7 + ((h * 13) % 1) * 0.9) * RENDER_SCALE;
      ctx.fillStyle = i % 3 === 0 ? 'rgba(20, 18, 20, 0.55)' : 'rgba(38, 34, 34, 0.42)';
      ctx.beginPath();
      ctx.ellipse(px, py, r * 1.6, r, ((h * 31) % 1) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // A shattered lamp is a dark socket where the light used to be. Lamps are
  // at the corners of the body; the two on an end break at different
  // thresholds, so a car on one headlight is the common case, not a rarity.
  const lamp = (lx: number, ly: number): void => {
    ctx.fillStyle = 'rgba(14, 12, 14, 0.85)';
    ctx.beginPath();
    ctx.ellipse(lx, ly, 1.1 * RENDER_SCALE, 0.9 * RENDER_SCALE, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  if ((broken & PART_HEADLIGHT_L) !== 0) lamp(fp.rx * 0.86, -fp.ry * 0.6);
  if ((broken & PART_HEADLIGHT_R) !== 0) lamp(fp.rx * 0.86, fp.ry * 0.6);
  if ((broken & PART_TAILLIGHT_L) !== 0) lamp(-fp.rx * 0.86, -fp.ry * 0.6);
  if ((broken & PART_TAILLIGHT_R) !== 0) lamp(-fp.rx * 0.86, fp.ry * 0.6);

  // Crazed glass: a few pale cracks across the cabin.
  if ((broken & PART_WINDSCREEN) !== 0) {
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.5)';
    ctx.lineWidth = Math.max(1, 0.4 * RENDER_SCALE);
    const cx = fp.rx * 0.2;
    for (let i = 0; i < 4; i++) {
      const h = hash3(id, 91, i);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx + ((h % 1) * 2 - 1) * fp.rx * 0.3, ((h * 7) % 1) * 2 * fp.ry - fp.ry);
      ctx.stroke();
    }
  }

  // Past half-wrecked the paint is scorched as well as bent.
  if (wear > 0.5) {
    ctx.fillStyle = `rgba(26, 22, 22, ${((wear - 0.5) * 0.5).toFixed(3)})`;
    ctx.fillRect(-fp.rx, -fp.ry, fp.rx * 2, fp.ry * 2);
  }
  ctx.restore();
}

/**
 * Exported for the damage contact sheet (`debug/damageSheet.ts`), which draws
 * one car at every rung of the breakage ladder side by side. The same idea as
 * `pnpm sprites -- --preview`: some things you can only check by looking, and
 * a sheet you can eyeball beats hunting for the state in a live game.
 */
export function drawVehicle(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  lights: LightPass,
  effects: Effects,
  id: number,
  kind: string,
  wx: number,
  wy: number,
  heading: number,
  speed: number,
  occupied: boolean,
  condition: string,
  /** 0 = undamaged, 1 = about to catch fire. See `vehicleWear`. */
  wear: number,
  /** Per-zone damage and the broken-part bits; see sim/vehicleDamage.ts. */
  zones: number[],
  broken: number,
  maxHealth: number,
  dx: (n: number) => number,
  dy: (n: number) => number,
  nowMs: number,
  z = 0,
  gangId = 0,
  /** Where the turret points, or null on anything without one. */
  turret: number | null = null,
  /**
   * Who is riding it, on a two-wheeler: the sprite to composite at the
   * saddle, or null. On anything with a roof the driver is inside and
   * invisible, which is why this is a parameter rather than a lookup.
   */
  rider: string | null = null,
  /** Factory colour off the sim, or -1 to fall back to the id. */
  paint = -1,
): void {
  // Airborne: lift the sprite, scale it up a touch, and leave the shadow on
  // the ground where it belongs. The gap between the two is what sells it.
  const lift = z * RENDER_SCALE * 0.6;
  const x = dx(wx);
  const y = dy(wy) - lift;
  const name = vehicleSpriteName(kind, id, gangId, paint);
  const fp = sprites.footprint(name);
  const shrink = z > 0 ? 0.75 : 1;
  drawShadow(ctx, dx(wx), dy(wy), fp.rx * 0.92 * shrink, fp.ry * 1.05 * shrink, 4);

  // A turret is the one part of a vehicle that does not turn with the body,
  // so it cannot be a baked rotation frame of the hull sprite: it is its own
  // sprite, pivoted on the ring, drawn at its own angle. The ring is offset
  // along the hull, so the pivot has to be carried round with the heading.
  // A wreck still has its barrel, it just stops traversing — drawn inside the
  // wreck's own save/restore so the scorching lands on it too.
  const off = getVehicleTuning(kind).turretOffset;
  const drawTurret = (): void => {
    if (off === null) return;
    const tx = dx(wx + Math.cos(heading) * off);
    const ty = dy(wy + Math.sin(heading) * off) - lift;
    sprites.draw(ctx, `${name}_turret`, tx, ty, condition === 'wreck' ? heading : (turret ?? heading));
  };

  // The rider sits ON a bike rather than inside it, which is the whole
  // reason a motorcycle reads as a motorcycle from above. Same mechanism as
  // the turret — a second sprite pivoted at an offset along the hull — but
  // this one turns WITH the body, because a rider faces where the bike goes.
  const seat = getVehicleTuning(kind).riderOffset;
  const drawRider = (): void => {
    if (seat === null || rider === null || condition !== 'ok') return;
    const rx = dx(wx + Math.cos(heading) * seat);
    const ry = dy(wy + Math.sin(heading) * seat) - lift;
    sprites.draw(ctx, rider, rx, ry, heading);
  };

  // A wreck is drawn dark and never lit; a burning car throws its own light
  // and sheds flame until it goes.
  if (condition === 'wreck') {
    ctx.save();
    ctx.globalAlpha = 0.85;
    sprites.draw(ctx, name, x, y, heading);
    drawTurret();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(18, 16, 18, 0.72)';
    // Wide enough to cover a barrel lying across the hull as well as the hull.
    const rx = off === null ? fp.rx : fp.rx * 2;
    const ry = off === null ? fp.ry : fp.ry * 2;
    ctx.fillRect(x - rx, y - ry, rx * 2, ry * 2);
    ctx.restore();
    // A burnt-out shell has every panel off it. Detonation sets all the bits,
    // so this is the same code path as any other damage — the wreck used to
    // be the intact sprite in shadow, which read as a car parked out of the
    // sun rather than one that had exploded.
    drawBodyDamage(ctx, id, x, y, heading, fp, zones, broken, maxHealth, 1);
    return;
  }

  if (!sprites.draw(ctx, name, x, y, heading)) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.fillStyle = palette.carBody;
    ctx.fillRect(-12 * RENDER_SCALE, -6 * RENDER_SCALE, 24 * RENDER_SCALE, 12 * RENDER_SCALE);
    ctx.restore();
  }

  // Damage goes on the hull, then the turret rides over it: a scrape on the
  // tracks should not be painted across the gun.
  drawBodyDamage(ctx, id, x, y, heading, fp, zones, broken, maxHealth, wear);
  drawTurret();
  drawRider();

  // Smoke before fire. This is the warning the burn fuse never gave: a car
  // showing grey off the bonnet is one you should think about swapping, and
  // one showing black has had it. Sampled off wall-clock like the exhaust, so
  // a fast display does not smoke four times as hard.
  const holed = (broken & PART_RADIATOR) !== 0;
  // Strobing light bar on any cruiser with an officer aboard.
  if (kind === 'copcar' && occupied) {
    const phase = Math.sin(nowMs * 0.012 + id) > 0;
    const bx = x + Math.cos(heading) * 2 * RENDER_SCALE;
    const by = y + Math.sin(heading) * 2 * RENDER_SCALE;
    // Shadowed: a strobe that throws the shape of the street across the
    // buildings is most of what makes a chase read as a chase.
    lights.point(bx, by, 22 * RENDER_SCALE, phase ? 'red' : 'blue', 0.85, 'dynamic');
  }

  if (condition === 'burning') {
    // The one light in the game that is allowed to overshoot: a flame that
    // only ever dims reads as a lamp on a dimmer, not as something alight.
    const f = flicker('fire', id, nowMs);
    lights.point(x, y, 32 * RENDER_SCALE, 'fire', 0.8 * f, 'dynamic');
  }

  // Rubber goes down whoever is driving and whatever the lights are doing:
  // an AI car standing on the brakes for a pedestrian leaves marks too.
  //
  // Off the ground it does not: there is no road under the tyres. A
  // helicopter cornering at cruise height was laying two black arcs on the
  // street forty-eight pixels below it, which is the most conspicuous half of
  // "planes behave like cars". The skid sampler still sees it so its
  // history stays continuous across a take-off and a landing.
  // Only a car with someone in it has its lights on — a street of parked cars
  // all blazing away washes the scene out and reads as nonsense.
  if (!occupied) return;

  // Lamps, one at a time. Every light on a car used to be a single boolean —
  // `occupied` — so a car that had been through a wall at full speed still had
  // two perfect headlights. Each is gated on its own bit now, and losing one
  // is both the commonest damage state and the most legible: a car coming the
  // other way on one headlight tells you what has happened to it.
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const nx = -sin;
  const ny = cos;
  const front = 11 * RENDER_SCALE;
  const side = 4.5 * RENDER_SCALE;
  const headL = (broken & PART_HEADLIGHT_L) === 0;
  const headR = (broken & PART_HEADLIGHT_R) === 0;
  for (const [s, lit] of [
    [-1, headL],
    [1, headR],
  ] as Array<[number, boolean]>) {
    if (!lit) continue;
    lights.point(
      x + cos * front + nx * side * s,
      y + sin * front + ny * side * s,
      6 * RENDER_SCALE,
      'head',
      0.7,
    );
  }
  // One lamp still throws a beam, but a narrower one, and from where it
  // actually is rather than down the centreline.
  if (headL || headR) {
    const both = headL && headR;
    const off = both ? 0 : (headL ? -1 : 1) * side;
    lights.cone(
      x + cos * front + nx * off,
      y + sin * front + ny * off,
      heading,
      (both ? 66 : 46) * RENDER_SCALE,
      'head',
      both ? 0.46 : 0.32,
      'dynamic',
    );
  }
  const braking = speed < 0 || Math.abs(speed) < 7;
  for (const [s, lit] of [
    [-1, (broken & PART_TAILLIGHT_L) === 0],
    [1, (broken & PART_TAILLIGHT_R) === 0],
  ] as Array<[number, boolean]>) {
    if (!lit) continue;
    lights.point(
      x - cos * front + nx * side * s,
      y - sin * front + ny * side * s,
      (braking ? 6 : 4) * RENDER_SCALE,
      'red',
      braking ? 0.55 : 0.32,
    );
  }
}

