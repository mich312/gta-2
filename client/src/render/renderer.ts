import {
  type CityMap,
  type PlayerState,
  type Vec2,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  PLAYER_RADIUS,
  clamp,
} from 'shared';
import type { Screen } from './canvas.js';
import type { RenderWorld } from '../net/interpolation.js';
import type { SpriteSheet } from './sprites.js';
import { drawWorld } from './world.js';

const REMOTE_COLORS = ['#e05555', '#55b0e0', '#57c98a', '#d3a24a', '#b06ad6', '#5fd6c9', '#d66a9c'];
const LOCAL_COLOR = '#f2f2f2';

export interface Scene {
  /** Predicted local player (zero input lag). */
  local: PlayerState | null;
  /** Predicted vehicle when the local player is driving. */
  localVehicle: { pos: { x: number; y: number }; heading: number } | null;
  /** Remote entities on the interpolated timeline. */
  remotes: RenderWorld;
}

/** Camera top-left in world coords, snapped to whole pixels. */
export function computeCamera(map: CityMap | null, local: PlayerState | null): Vec2 {
  const w = map?.widthPx ?? INTERNAL_WIDTH;
  const h = map?.heightPx ?? INTERNAL_HEIGHT;
  const cx = local ? local.pos.x : w / 2;
  const cy = local ? local.pos.y : h / 2;
  return {
    x: Math.floor(clamp(cx - INTERNAL_WIDTH / 2, 0, Math.max(0, w - INTERNAL_WIDTH))),
    y: Math.floor(clamp(cy - INTERNAL_HEIGHT / 2, 0, Math.max(0, h - INTERNAL_HEIGHT))),
  };
}

export function render(
  screen: Screen,
  map: CityMap | null,
  scene: Scene | null,
  cam: Vec2,
  sprites: SpriteSheet,
): void {
  const { ctx } = screen;
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

  if (!map || !scene) {
    ctx.fillStyle = '#8a939e';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('connecting…', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2);
    ctx.textAlign = 'left';
    return;
  }

  drawWorld(ctx, map, cam);

  for (const rv of scene.remotes.vehicles) {
    drawVehicle(ctx, sprites, rv.x, rv.y, rv.heading, cam);
  }
  if (scene.localVehicle) {
    drawVehicle(
      ctx,
      sprites,
      scene.localVehicle.pos.x,
      scene.localVehicle.pos.y,
      scene.localVehicle.heading,
      cam,
    );
  }
  for (const pd of scene.remotes.peds) {
    const sx = Math.floor(pd.x - cam.x);
    const sy = Math.floor(pd.y - cam.y);
    if (!sprites.draw(ctx, 'ped', sx, sy, Math.atan2(pd.ped.dirY, pd.ped.dirX))) {
      ctx.fillStyle = '#7a7f6d';
      ctx.fillRect(sx - 5, sy - 5, 10, 10);
    }
  }
  for (const c of scene.remotes.cops) {
    const sx = Math.floor(c.x - cam.x);
    const sy = Math.floor(c.y - cam.y);
    if (!sprites.draw(ctx, 'cop', sx, sy, Math.atan2(c.cop.vel.y, c.cop.vel.x))) {
      ctx.fillStyle = '#3a5fb0';
      ctx.fillRect(sx - PLAYER_RADIUS, sy - PLAYER_RADIUS, PLAYER_RADIUS * 2, PLAYER_RADIUS * 2);
    }
  }
  for (const r of scene.remotes.players) {
    drawPlayer(ctx, sprites, r.player, r.x, r.y, r.aimAngle, cam, false);
  }
  if (scene.local && scene.local.mode !== 'driving') {
    drawPlayer(
      ctx,
      sprites,
      scene.local,
      scene.local.pos.x,
      scene.local.pos.y,
      scene.local.aimAngle,
      cam,
      true,
    );
  }
}

function drawVehicle(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  wx: number,
  wy: number,
  heading: number,
  cam: Vec2,
): void {
  const sx = Math.floor(wx - cam.x);
  const sy = Math.floor(wy - cam.y);
  if (!sprites.draw(ctx, 'car', sx, sy, heading)) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(heading);
    ctx.fillStyle = '#b03a3a';
    ctx.fillRect(-12, -6, 24, 12);
    ctx.restore();
  }
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSheet,
  p: PlayerState,
  wx: number,
  wy: number,
  aim: number,
  cam: Vec2,
  isLocal: boolean,
): void {
  const sx = Math.floor(wx - cam.x);
  const sy = Math.floor(wy - cam.y);
  const r = PLAYER_RADIUS;

  if (!sprites.draw(ctx, 'player', sx, sy, aim)) {
    ctx.fillStyle = isLocal ? LOCAL_COLOR : (REMOTE_COLORS[p.id % REMOTE_COLORS.length] as string);
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  }

  // Aim tick. Math trig is fine in rendering — only sim code is restricted.
  ctx.strokeStyle = isLocal ? '#ffffff' : '#c0c0c0';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx + Math.round(Math.cos(aim) * (r + 5)), sy + Math.round(Math.sin(aim) * (r + 5)));
  ctx.stroke();

  ctx.fillStyle = isLocal ? '#e8f0e8' : '#9aa4ae';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, sx, sy - r - 4);
  ctx.textAlign = 'left';
}
