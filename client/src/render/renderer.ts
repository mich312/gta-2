import {
  type CityMap,
  type PickupState,
  type PlayerState,
  type PropState,
  type Vec2,
  type WeaponTuning,
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
  TILE_SIZE,
  clamp,
  getVehicleTuning,
  getWeaponTuning,
  vehicleWear,
} from 'shared';
import palette from 'shared/data/palette.json';
import type { Screen } from './canvas.js';
import { worldTransform } from './canvas.js';
import type { RenderWorld } from '../net/interpolation.js';
import type { SpriteSheet } from './sprites.js';
import type { TileLayer } from './tiles.js';
import type { Effects } from './effects.js';
import type { LightPass } from './lighting.js';
import { DEVICE_H, DEVICE_W, RENDER_SCALE, SUN_X, SUN_Y, VIEW_H, VIEW_W } from './config.js';

const REMOTE_COLORS = ['#e05555', '#55b0e0', '#57c98a', '#d3a24a', '#b06ad6', '#5fd6c9', '#d66a9c'];
const LOCAL_COLOR = '#f2f2f2';

/** Gang colours, keyed by gang id. Mirrors shared/data/gangs.json. */
const GANG_TINT: Record<number, string> = {
  1: '#c8543c',
  2: '#4aa86a',
  3: '#4a7ac8',
  4: '#a86ac8',
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
export function vehicleSpriteName(kind: string, id: number): string {
  return kind === 'car' ? `car_v${Math.abs(id) % CAR_VARIANTS}` : kind;
}

/** Uniform per force, so what is chasing you is legible at a glance. */
const COP_TINT: Record<string, string> = {
  patrol: '#3a5fb0',
  swat: '#2c3038',
  fed: '#1f2c58',
  army: '#4a5334',
};

/** World px a walking entity covers per animation frame. */
const STRIDE = 7;
/** Sprite variant counts, mirroring shared/data/sprites.json. */
const PLAYER_VARIANTS = 4;
const PED_VARIANTS = 6;
const CAR_VARIANTS = 10;
const WALK_FRAMES = 4;

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
  } | null;
  /** Remote entities on the interpolated timeline. */
  remotes: RenderWorld;
  /** Seconds since the previous frame, for effects. */
  dt: number;
  /** Wall-clock ms, for strobes and flicker. */
  nowMs: number;
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
  const w = map?.widthPx ?? VIEW_W;
  const h = map?.heightPx ?? VIEW_H;
  const cx = (local ? local.x : w / 2) + (lead?.x ?? 0);
  const cy = (local ? local.y : h / 2) + (lead?.y ?? 0);
  return {
    x: clamp(cx - VIEW_W / 2, 0, Math.max(0, w - VIEW_W)),
    y: clamp(cy - VIEW_H / 2, 0, Math.max(0, h - VIEW_H)),
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
  ctx.fillRect(0, 0, DEVICE_W, DEVICE_H);

  if (!map || !scene) {
    ctx.fillStyle = '#8a939e';
    ctx.font = `${10 * RENDER_SCALE}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('connecting…', DEVICE_W / 2, DEVICE_H / 2);
    ctx.textAlign = 'left';
    return;
  }

  // One rounded origin for the whole frame. Every world position derives from
  // it, so the scene translates as a rigid body: no seams between cached
  // chunks, and no entities shivering against the ground by a pixel.
  const originX = Math.round(-cam.x * RENDER_SCALE);
  const originY = Math.round(-cam.y * RENDER_SCALE);
  const dx = (wx: number): number => originX + Math.round(wx * RENDER_SCALE);
  const dy = (wy: number): number => originY + Math.round(wy * RENDER_SCALE);

  tiles.draw(ctx, cam, originX, originY);
  effects.update(scene.dt);
  effects.drawDecals(ctx, originX, originY);

  // Street lighting, from the props the server already streams us.
  for (const prop of scene.remotes.props) {
    if (prop.kind !== 'lamp' || !prop.intact) continue;
    // A touch of flicker, keyed off the prop id so lamps are out of phase.
    const flicker = 0.88 + 0.12 * Math.sin(scene.nowMs * 0.004 + prop.id * 2.3);
    lights.point(dx(prop.pos.x), dy(prop.pos.y), 34 * RENDER_SCALE, 'lamp', 0.52 * flicker);
  }
  for (const shop of map.shops) {
    const wx = (shop.doorX + 0.5) * TILE_SIZE;
    const wy = (shop.doorY + 0.5) * TILE_SIZE;
    if (wx < cam.x - 32 || wy < cam.y - 32 || wx > cam.x + VIEW_W + 32 || wy > cam.y + VIEW_H + 32) {
      continue;
    }
    lights.point(dx(wx), dy(wy), 22 * RENDER_SCALE, 'shop', 0.45);
    // The room behind the door is lit too, or walking in is walking into a
    // dark hole in the middle of a lit street.
    const r = shop.interior;
    const cx = (r.x + r.w / 2) * TILE_SIZE;
    const cy = (r.y + r.h / 2) * TILE_SIZE;
    const reach = Math.max(r.w, r.h) * TILE_SIZE * 0.8;
    lights.point(dx(cx), dy(cy), reach * RENDER_SCALE, 'shop', 0.5);
  }

  drawProps(ctx, sprites, scene.remotes.props, dx, dy);
  drawPickups(ctx, scene.remotes.pickups, dx, dy, lights, scene.nowMs);

  for (const pd of scene.remotes.peds) {
    const variant = pd.ped.id % PED_VARIANTS;
    const facing = Math.atan2(pd.ped.dirY, pd.ped.dirX);
    // Gang members wear their colours. Being able to read a street at a
    // glance is the whole reason turf exists.
    const tint = GANG_TINT[pd.ped.gangId] ?? '#7a7f6d';
    const down = pd.ped.mode === 'dead' || pd.ped.mode === 'downed';
    if (down) {
      drawBody(ctx, sprites, `ped_v${variant}_f0`, dx(pd.x), dy(pd.y), facing, tint);
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

  for (const c of scene.remotes.cops) {
    const angle = Math.atan2(c.cop.vel.y, c.cop.vel.x);
    // The uniform says which force you have brought down on yourself. Police
    // blue, SWAT charcoal, federal navy, army olive — you should be able to
    // tell what is chasing you without reading the star count.
    const tint = COP_TINT[c.cop.kind] ?? '#3a5fb0';
    // An officer at zero health is a body, not a pursuer — see damageCop.
    if (c.cop.health <= 0) {
      drawBody(ctx, sprites, 'cop_f0', dx(c.x), dy(c.y), angle, tint);
      continue;
    }
    const frame = walkFrame(`c${c.cop.id}`, c.x, c.y);
    drawCharacter(ctx, sprites, `cop_f${frame}`, dx(c.x), dy(c.y), angle, tint);
  }
  for (const r of scene.remotes.players) {
    const key = `p${r.player.id}`;
    const frame = walkFrame(key, r.x, r.y);
    drawPlayer(ctx, sprites, r.player, dx(r.x), dy(r.y), r.aimAngle, frame, false);
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
    );
  }

  effects.drawParticles(ctx, originX, originY, lights);
  lights.render(ctx);

  // Name tags go on last, above the grade, so they stay readable at night.
  for (const r of scene.remotes.players) {
    const color = REMOTE_COLORS[r.player.id % REMOTE_COLORS.length] as string;
    const tag = label(r.player.name, color);
    ctx.drawImage(tag, dx(r.x) - tag.width / 2, dy(r.y) - (PLAYER_RADIUS + 12) * RENDER_SCALE);
  }
  if (scene.local && scene.localPos && scene.local.mode !== 'driving') {
    const tag = label(scene.local.name, LOCAL_COLOR);
    ctx.drawImage(
      tag,
      dx(scene.localPos.x) - tag.width / 2,
      dy(scene.localPos.y) - (PLAYER_RADIUS + 12) * RENDER_SCALE,
    );
  }
}

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

const PICKUP_COLORS: Record<string, string> = {
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

function drawCharacter(
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

/** How flat a body reads against the pavement, as a fraction of standing. */
const BODY_FLATTEN = 0.55;

/**
 * Somebody who is not getting up.
 *
 * The sim leaves the dead in the world now — a pedestrian's body for forty
 * seconds, an officer's for the same, a player's until they respawn — and
 * before this they were drawn walking about like everyone else. Same sprite,
 * squashed towards the ground, greyed, over a pool: no new art, and legible
 * at 480 x 270 from across the street.
 */
function drawBody(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  name: string,
  x: number,
  y: number,
  angle: number,
  fallback: string,
): void {
  const r = PLAYER_RADIUS * RENDER_SCALE;
  ctx.save();
  ctx.fillStyle = 'rgba(96, 14, 18, 0.5)';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.3, r * 1.5, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(x, y);
  ctx.scale(1, BODY_FLATTEN);
  if (!sprites.draw(ctx, name, 0, 0, angle)) {
    ctx.fillStyle = fallback;
    ctx.fillRect(-r, -r, r * 2, r * 2);
  }
  ctx.restore();
  // Drained of colour: a body is the one thing on the street that has stopped
  // being a participant, and it should stop drawing the eye like one.
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#1a1a20';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.1, r * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  p: PlayerState,
  x: number,
  y: number,
  /** Where the mouse points: both the firing line and the way the body faces. */
  aim: number,
  frame: number,
  isLocal: boolean,
): void {
  const variant = Math.abs(p.cosmeticId) % PLAYER_VARIANTS;
  const fallback = isLocal ? LOCAL_COLOR : (REMOTE_COLORS[p.id % REMOTE_COLORS.length] as string);
  // Dead is dead: no walk cycle, no aim tick, and a body on the tarmac for
  // the three seconds before the ambulance-shaped respawn timer runs out.
  if (p.mode === 'dead') {
    drawBody(ctx, sprites, `player_v${variant}_f0`, x, y, aim, fallback);
    return;
  }
  // Empty hands look like empty hands. The avatar used to hold a pistol
  // whatever was selected, so a fist fight was two men pointing guns at each
  // other and a punch came out of the barrel.
  const weapon = weaponOf(p);
  const melee = weapon === null || weapon.melee;
  const swinging = melee && p.fireCooldown > 0 && weapon !== null && p.fireCooldown * 2 > weapon.cooldownTicks;
  const name = swinging
    ? `playerPunch_v${variant}`
    : melee
      ? `playerFist_v${variant}_f${frame}`
      : `player_v${variant}_f${frame}`;
  drawCharacter(ctx, sprites, name, x, y, aim, fallback);

  // A short aim tick keeps the firing line legible when the sprite's own
  // weapon is only a few pixels long.
  ctx.strokeStyle = isLocal ? 'rgba(255,255,255,0.6)' : 'rgba(200,200,200,0.35)';
  ctx.lineWidth = RENDER_SCALE;
  ctx.beginPath();
  const inner = (PLAYER_RADIUS + 3) * RENDER_SCALE;
  const outer = (PLAYER_RADIUS + 8) * RENDER_SCALE;
  ctx.moveTo(x + Math.cos(aim) * inner, y + Math.sin(aim) * inner);
  ctx.lineTo(x + Math.cos(aim) * outer, y + Math.sin(aim) * outer);
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
): void {
  // Airborne: lift the sprite, scale it up a touch, and leave the shadow on
  // the ground where it belongs. The gap between the two is what sells it.
  const lift = z * RENDER_SCALE * 0.6;
  const x = dx(wx);
  const y = dy(wy) - lift;
  const name = vehicleSpriteName(kind, id);
  const fp = sprites.footprint(name);
  const shrink = z > 0 ? 0.75 : 1;
  drawShadow(ctx, dx(wx), dy(wy), fp.rx * 0.92 * shrink, fp.ry * 1.05 * shrink, 4);

  // A wreck is drawn dark and never lit; a burning car throws its own light
  // and sheds flame until it goes.
  if (condition === 'wreck') {
    ctx.save();
    ctx.globalAlpha = 0.85;
    sprites.draw(ctx, name, x, y, heading);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(18, 16, 18, 0.72)';
    ctx.fillRect(x - fp.rx, y - fp.ry, fp.rx * 2, fp.ry * 2);
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

  drawBodyDamage(ctx, id, x, y, heading, fp, zones, broken, maxHealth, wear);

  // Smoke before fire. This is the warning the burn fuse never gave: a car
  // showing grey off the bonnet is one you should think about swapping, and
  // one showing black has had it. Sampled off wall-clock like the exhaust, so
  // a fast display does not smoke four times as hard.
  const holed = (broken & PART_RADIATOR) !== 0;
  if (condition === 'ok' && (holed || (broken & PART_BONNET) !== 0)) {
    const period = holed ? 1.4 : 2.6;
    if ((nowMs * 0.06 + id) % period < 1) {
      effects.engineSmoke(
        wx + Math.cos(heading) * 8,
        wy + Math.sin(heading) * 8,
        holed,
      );
    }
  }

  // Strobing light bar on any cruiser with an officer aboard.
  if (kind === 'copcar' && occupied) {
    const phase = Math.sin(nowMs * 0.012 + id) > 0;
    const bx = x + Math.cos(heading) * 2 * RENDER_SCALE;
    const by = y + Math.sin(heading) * 2 * RENDER_SCALE;
    lights.point(bx, by, 20 * RENDER_SCALE, phase ? 'red' : 'blue', 0.8);
  }

  if (condition === 'burning') {
    effects.fire(wx, wy);
    const flicker = 0.7 + 0.3 * Math.sin(nowMs * 0.02 + id);
    lights.point(x, y, 30 * RENDER_SCALE, 'head', 0.75 * flicker);
  }

  // Rubber goes down whoever is driving and whatever the lights are doing:
  // an AI car standing on the brakes for a pedestrian leaves marks too.
  layRubber(effects, id, wx, wy, heading, speed, nowMs);

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
      both ? 0.42 : 0.3,
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

  // Exhaust while under way; sampled off wall-clock so it does not thicken on
  // a fast display.
  if (Math.abs(speed) > 40 && (nowMs * 0.06 + id) % 3 < 1) {
    effects.exhaust(wx, wy, heading);
  }
}

/** Per-vehicle heading and speed history, for spotting a slide or a stop. */
const skidState = new Map<
  number,
  { heading: number; speed: number; ms: number; nextAtMs: number }
>();

/** Below this there is not enough weight on the tyres to mark the road. */
const SKID_MIN_SPEED = 170;
/** Rad/s of yaw that counts as a slide. Peak steering authority is 2.8. */
const SKID_MIN_YAW_RATE = 1.9;
/**
 * Deceleration that counts as standing on the brakes, px/s². A car brakes at
 * 520 and coasts down at 180 (`vehicles.json`), so this catches the pedal and
 * ignores lifting off.
 */
const SKID_MIN_DECEL = 180;
/** ...and the speed it has to be doing for the marks to show. */
const SKID_MIN_BRAKE_SPEED = 54;
/** Rubber is laid at a wall-clock cadence, not per frame — a 240 Hz display
 *  must not lay four times the rubber of a 60 Hz one. */
const SKID_INTERVAL_MS = 45;

/**
 * Tyre marks: two arcs under the rear wheels through a slide, four straight
 * ones under a hard stop.
 *
 * `Effects.skid` was written, complete, at the same time as the rest of the
 * particle pool and then never called from anywhere — the review flagged it as
 * dead code. Cornering brought it to life; braking is the other half, and it
 * is the one you see most, because every car in the city brakes.
 */
function layRubber(
  effects: Effects,
  id: number,
  wx: number,
  wy: number,
  heading: number,
  speed: number,
  nowMs: number,
): void {
  const prev = skidState.get(id);
  skidState.set(id, {
    heading,
    speed,
    ms: nowMs,
    nextAtMs: prev?.nextAtMs ?? 0,
  });
  if (!prev) return;

  const dtMs = nowMs - prev.ms;
  if (dtMs <= 0 || dtMs > 250) return; // first frame back on screen: no history
  // Shortest signed angle between the two headings, so wrapping past ±π
  // doesn't read as a violent slide.
  let delta = heading - prev.heading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const yawRate = Math.abs(delta) / (dtMs / 1000);
  const sliding = Math.abs(speed) >= SKID_MIN_SPEED && yawRate >= SKID_MIN_YAW_RATE;

  // Braking, as opposed to crashing: a wall reverses the speed outright, and
  // a rebound is not a brake mark.
  const decel = (Math.abs(prev.speed) - Math.abs(speed)) / (dtMs / 1000);
  const braking =
    Math.abs(speed) >= SKID_MIN_BRAKE_SPEED && speed * prev.speed > 0 && decel >= SKID_MIN_DECEL;

  if (!sliding && !braking) return;
  if (nowMs < prev.nextAtMs) return;

  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const track = 5;
  // A slide marks the rear wheels; all four lock up under braking.
  const axles = braking ? [8, -8] : [8];
  for (const back of axles) {
    for (const s of [-1, 1]) {
      effects.skid(wx - cos * back - sin * track * s, wy - sin * back + cos * track * s, heading);
    }
  }
  skidState.set(id, { heading, speed, ms: nowMs, nextAtMs: nowMs + SKID_INTERVAL_MS });
}
