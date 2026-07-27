import {
  type CityMap,
  type PickupState,
  type PlayerState,
  type PropState,
  type Vec2,
  type WeaponTuning,
  PLAYER_RADIUS,
  TILE_SIZE,
  clamp,
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
    pos: Vec2;
    heading: number;
    speed: number;
    condition: string;
    /** 0 = undamaged, 1 = about to catch fire. */
    wear: number;
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
 * There is nothing else it could be. Movement on foot is aim-relative — `up`
 * runs towards the pointer and the strafe keys sidestep across it — so the
 * facing IS the frame the controls are expressed in, and drawing the body at
 * anything else (the direction of travel, say) would leave the avatar pointing
 * one way while `up` sent it another. Sidestepping therefore looks like
 * sidestepping, which is what it is.
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
    const frame = walkFrame(`d${pd.ped.id}`, pd.x, pd.y);
    const variant = pd.ped.id % PED_VARIANTS;
    drawCharacter(
      ctx,
      sprites,
      `ped_v${variant}_f${frame}`,
      dx(pd.x),
      dy(pd.y),
      Math.atan2(pd.ped.dirY, pd.ped.dirX),
      // Gang members wear their colours. Being able to read a street at a
      // glance is the whole reason turf exists.
      GANG_TINT[pd.ped.gangId] ?? '#7a7f6d',
    );
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
    const frame = walkFrame(`c${c.cop.id}`, c.x, c.y);
    const angle = Math.atan2(c.cop.vel.y, c.cop.vel.x);
    // The uniform says which force you have brought down on yourself. Police
    // blue, SWAT charcoal, federal navy, army olive — you should be able to
    // tell what is chasing you without reading the star count.
    drawCharacter(ctx, sprites, `cop_f${frame}`, dx(c.x), dy(c.y), angle, COP_TINT[c.cop.kind] ?? '#3a5fb0');
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
      'car',
      scene.localVehicle.pos.x,
      scene.localVehicle.pos.y,
      scene.localVehicle.heading,
      scene.localVehicle.speed,
      true,
      scene.localVehicle.condition,
      scene.localVehicle.wear,
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

/** Most dents a car can show, at the point where it is about to catch fire. */
const MAX_DENTS = 7;

/**
 * Crumpled panels, drawn straight onto the car's own sprite.
 *
 * A car's condition was invisible until the instant it burst into flame: you
 * could shunt one down a street and it looked showroom-fresh right up to the
 * fireball. The dents are keyed off the vehicle id, so a given car's damage
 * appears in the same places every frame and grows outward as it takes more —
 * dents that danced around the bodywork would read as static, not as damage.
 *
 * `source-atop` clips the patches to the sprite's own alpha, so they land on
 * the bodywork and never square off over the road underneath.
 */
function drawDents(
  ctx: CanvasRenderingContext2D,
  id: number,
  x: number,
  y: number,
  heading: number,
  fp: { rx: number; ry: number },
  wear: number,
): void {
  const count = Math.floor(wear * MAX_DENTS);
  if (count <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.translate(x, y);
  ctx.rotate(heading);
  for (let i = 0; i < count; i++) {
    // A cheap deterministic hash of (id, i): no rng, no per-frame state, and
    // stable across the client restarting mid-session.
    const h = Math.abs(Math.sin(id * 12.9898 + i * 78.233) * 43758.5453);
    const u = h % 1;
    const w = (h * 7) % 1;
    const px = (u * 2 - 1) * fp.rx * 0.8;
    const py = (w * 2 - 1) * fp.ry * 0.75;
    const r = (0.7 + ((h * 13) % 1) * 0.9) * RENDER_SCALE;
    ctx.fillStyle = i % 3 === 0 ? 'rgba(20, 18, 20, 0.55)' : 'rgba(38, 34, 34, 0.42)';
    ctx.beginPath();
    ctx.ellipse(px, py, r * 1.6, r, ((h * 31) % 1) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Past half-wrecked the paint is scorched as well as bent.
  if (wear > 0.5) {
    ctx.fillStyle = `rgba(26, 22, 22, ${((wear - 0.5) * 0.5).toFixed(3)})`;
    ctx.fillRect(-fp.rx, -fp.ry, fp.rx * 2, fp.ry * 2);
  }
  ctx.restore();
}

function drawVehicle(
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
  // Anything with a sprite of its own uses it; the generic car is the only
  // kind that comes in colours, so it is the only one that varies by id.
  const name = kind === 'car' ? `car_v${Math.abs(id) % CAR_VARIANTS}` : kind;
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

  drawDents(ctx, id, x, y, heading, fp, wear);

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

  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const nx = -sin;
  const ny = cos;
  const front = 11 * RENDER_SCALE;
  const side = 4.5 * RENDER_SCALE;
  for (const s of [-1, 1]) {
    lights.point(
      x + cos * front + nx * side * s,
      y + sin * front + ny * side * s,
      6 * RENDER_SCALE,
      'head',
      0.7,
    );
  }
  lights.cone(x + cos * front, y + sin * front, heading, 66 * RENDER_SCALE, 'head', 0.42);
  const braking = speed < 0 || Math.abs(speed) < 7;
  for (const s of [-1, 1]) {
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

  layRubber(effects, id, wx, wy, heading, speed, nowMs);
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
