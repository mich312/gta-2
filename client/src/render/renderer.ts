import {
  type CityMap,
  type PlayerState,
  type PropState,
  type Vec2,
  PLAYER_RADIUS,
  TILE_SIZE,
  clamp,
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
  localVehicle: { pos: Vec2; heading: number; speed: number } | null;
  /** Remote entities on the interpolated timeline. */
  remotes: RenderWorld;
  /** Seconds since the previous frame, for effects. */
  dt: number;
  /** Wall-clock ms, for strobes and flicker. */
  nowMs: number;
}

/** Camera top-left in world coords. Deliberately *not* rounded — see `render`. */
export function computeCamera(map: CityMap | null, local: Vec2 | null): Vec2 {
  const w = map?.widthPx ?? VIEW_W;
  const h = map?.heightPx ?? VIEW_H;
  const cx = local ? local.x : w / 2;
  const cy = local ? local.y : h / 2;
  return {
    x: clamp(cx - VIEW_W / 2, 0, Math.max(0, w - VIEW_W)),
    y: clamp(cy - VIEW_H / 2, 0, Math.max(0, h - VIEW_H)),
  };
}

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
  }

  drawProps(ctx, sprites, scene.remotes.props, dx, dy);

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
      '#7a7f6d',
    );
  }
  for (const c of scene.remotes.cops) {
    const frame = walkFrame(`c${c.cop.id}`, c.x, c.y);
    const angle = Math.atan2(c.cop.vel.y, c.cop.vel.x);
    drawCharacter(ctx, sprites, `cop_f${frame}`, dx(c.x), dy(c.y), angle, '#3a5fb0');
  }
  for (const r of scene.remotes.players) {
    const frame = walkFrame(`p${r.player.id}`, r.x, r.y);
    drawPlayer(ctx, sprites, r.player, dx(r.x), dy(r.y), r.aimAngle, frame, false);
  }
  if (scene.local && scene.localPos && scene.local.mode !== 'driving') {
    const frame = walkFrame('local', scene.localPos.x, scene.localPos.y);
    drawPlayer(
      ctx,
      sprites,
      scene.local,
      dx(scene.localPos.x),
      dy(scene.localPos.y),
      // The smoothed angle, not the raw one: aim only changes on ticks too,
      // and a 30 Hz aim tick on a 144 Hz display is just as visible as a
      // 30 Hz position.
      scene.localPos.angle,
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
      dx,
      dy,
      scene.nowMs,
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
  aim: number,
  frame: number,
  isLocal: boolean,
): void {
  const variant = Math.abs(p.cosmeticId) % PLAYER_VARIANTS;
  const fallback = isLocal ? LOCAL_COLOR : (REMOTE_COLORS[p.id % REMOTE_COLORS.length] as string);
  drawCharacter(ctx, sprites, `player_v${variant}_f${frame}`, x, y, aim, fallback);

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
  dx: (n: number) => number,
  dy: (n: number) => number,
  nowMs: number,
): void {
  const x = dx(wx);
  const y = dy(wy);
  const name = kind === 'boat' ? 'boat' : `car_v${Math.abs(id) % CAR_VARIANTS}`;
  const fp = sprites.footprint(name);
  drawShadow(ctx, x, y, fp.rx * 0.92, fp.ry * 1.05, 4);

  if (!sprites.draw(ctx, name, x, y, heading)) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.fillStyle = palette.carBody;
    ctx.fillRect(-12 * RENDER_SCALE, -6 * RENDER_SCALE, 24 * RENDER_SCALE, 12 * RENDER_SCALE);
    ctx.restore();
  }

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
  const braking = speed < 0 || Math.abs(speed) < 12;
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
}
