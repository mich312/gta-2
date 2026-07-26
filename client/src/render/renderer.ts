import {
  type PlayerState,
  type Vec2,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  PLAYER_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clamp,
} from 'shared';
import type { Screen } from './canvas.js';
import type { RenderEntity } from '../net/interpolation.js';

const REMOTE_COLORS = ['#e05555', '#55b0e0', '#57c98a', '#d3a24a', '#b06ad6', '#5fd6c9', '#d66a9c'];
const LOCAL_COLOR = '#f2f2f2';
const GRID_STEP = 60;

export interface Scene {
  /** Predicted local player (zero input lag). */
  local: PlayerState | null;
  /** Remote entities on the interpolated timeline. */
  remotes: RenderEntity[];
}

/** Camera top-left in world coords, snapped to whole pixels. */
export function computeCamera(local: PlayerState | null): Vec2 {
  const cx = local ? local.pos.x : WORLD_WIDTH / 2;
  const cy = local ? local.pos.y : WORLD_HEIGHT / 2;
  return {
    x: Math.floor(clamp(cx - INTERNAL_WIDTH / 2, 0, WORLD_WIDTH - INTERNAL_WIDTH)),
    y: Math.floor(clamp(cy - INTERNAL_HEIGHT / 2, 0, WORLD_HEIGHT - INTERNAL_HEIGHT)),
  };
}

export function render(screen: Screen, scene: Scene | null, cam: Vec2): void {
  const { ctx } = screen;
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

  if (!scene) {
    ctx.fillStyle = '#8a939e';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('connecting…', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2);
    ctx.textAlign = 'left';
    return;
  }

  // Ground grid + world border so motion is visible before the city exists.
  ctx.strokeStyle = '#182028';
  ctx.lineWidth = 1;
  for (let gx = Math.ceil(cam.x / GRID_STEP) * GRID_STEP; gx <= cam.x + INTERNAL_WIDTH; gx += GRID_STEP) {
    line(ctx, gx - cam.x + 0.5, 0, gx - cam.x + 0.5, INTERNAL_HEIGHT);
  }
  for (let gy = Math.ceil(cam.y / GRID_STEP) * GRID_STEP; gy <= cam.y + INTERNAL_HEIGHT; gy += GRID_STEP) {
    line(ctx, 0, gy - cam.y + 0.5, INTERNAL_WIDTH, gy - cam.y + 0.5);
  }
  ctx.strokeStyle = '#3a4652';
  ctx.strokeRect(0.5 - cam.x, 0.5 - cam.y, WORLD_WIDTH - 1, WORLD_HEIGHT - 1);

  for (const r of scene.remotes) {
    drawPlayer(ctx, r.player, r.x, r.y, r.aimAngle, cam, false);
  }
  if (scene.local) {
    drawPlayer(ctx, scene.local, scene.local.pos.x, scene.local.pos.y, scene.local.aimAngle, cam, true);
  }
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
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
  ctx.fillStyle = isLocal ? LOCAL_COLOR : (REMOTE_COLORS[p.id % REMOTE_COLORS.length] as string);
  ctx.fillRect(sx - r, sy - r, r * 2, r * 2);

  // Aim tick. Math trig is fine in rendering — only sim code is restricted.
  ctx.strokeStyle = '#ffffff';
  line(ctx, sx, sy, sx + Math.round(Math.cos(aim) * (r + 5)), sy + Math.round(Math.sin(aim) * (r + 5)));

  ctx.fillStyle = '#9aa4ae';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, sx, sy - r - 3);
  ctx.textAlign = 'left';
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
