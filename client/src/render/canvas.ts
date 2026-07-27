import { DEVICE_H, DEVICE_W, RENDER_SCALE, VIEW_H, VIEW_W } from './config.js';

export interface Screen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixels per *world* pixel. HUD and mouse maths work in these units. */
  scale: number;
}

/**
 * Fixed internal resolution, scaled to the window, nearest-neighbour.
 *
 * The backing store holds RENDER_SCALE device pixels per world pixel; the
 * browser upscales the element. World drawing works in device pixels and snaps
 * there — never at world-pixel granularity, which is what made motion judder.
 * HUD drawing runs under `hudTransform`, which restores world-pixel units so
 * overlay code can stay in the 480×270 space it was written for.
 */
export function setupCanvas(canvas: HTMLCanvasElement): Screen {
  canvas.width = DEVICE_W;
  canvas.height = DEVICE_H;
  // No alpha: the compositor can skip blending the canvas against the page.
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingEnabled = false;

  const screen: Screen = { canvas, ctx, scale: RENDER_SCALE };
  const resize = (): void => {
    // Prefer whole multiples of the backing store so upscaling stays crisp;
    // below that, fall back to a fractional (downscaled) fit.
    const steps = Math.floor(Math.min(window.innerWidth / DEVICE_W, window.innerHeight / DEVICE_H));
    const scale =
      steps >= 1
        ? RENDER_SCALE * steps
        : Math.max(0.5, Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H));
    screen.scale = scale;
    canvas.style.width = `${VIEW_W * scale}px`;
    canvas.style.height = `${VIEW_H * scale}px`;
  };
  window.addEventListener('resize', resize);
  resize();
  return screen;
}

/** Switch the context into world-pixel units, for HUD and overlay drawing. */
export function hudTransform(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
}

/** Switch the context back into device-pixel units, for world drawing. */
export function worldTransform(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
