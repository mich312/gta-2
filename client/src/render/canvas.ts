import { RENDER_SCALE } from './config.js';
import { fitViewport, fixedViewport, setViewport, viewport } from './viewport.js';

export interface Screen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixels per *world* pixel. HUD and mouse maths work in these units. */
  scale: number;
}

export interface ScreenOptions {
  /**
   * Render a fixed frame instead of following the window. For the evidence
   * pages and the sprite tools, which crop known rectangles out of the
   * backing store and would otherwise depend on the size of whatever browser
   * happened to run them.
   */
  fixed?: { w: number; h: number };
}

/**
 * The canvas, sized to the window.
 *
 * The backing store holds RENDER_SCALE device pixels per world pixel; the
 * browser upscales the element. World drawing works in device pixels and snaps
 * there — never at world-pixel granularity, which is what made motion judder.
 * HUD drawing runs under `hudTransform`, which restores world-pixel units so
 * overlay code can stay in the units it was written for.
 *
 * How much world that adds up to is `viewport`'s decision, and it changes with
 * the window: the frame used to be a fixed 480×270 letterboxed into whatever
 * whole multiple of it fitted, so every display that was not a multiple of
 * 1920×1080 played inside black bars.
 */
export function setupCanvas(canvas: HTMLCanvasElement, opts: ScreenOptions = {}): Screen {
  // No alpha: the compositor can skip blending the canvas against the page.
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2d context');

  const screen: Screen = { canvas, ctx, scale: viewport.zoom };
  const apply = (): void => {
    canvas.width = viewport.deviceW;
    canvas.height = viewport.deviceH;
    // Resizing the backing store resets every context property, this one
    // included — and without it the whole game is bilinear-filtered.
    ctx.imageSmoothingEnabled = false;
    canvas.style.width = `${Math.round(viewport.cssW)}px`;
    canvas.style.height = `${Math.round(viewport.cssH)}px`;
    screen.scale = viewport.zoom;
  };

  if (opts.fixed) {
    setViewport(fixedViewport(opts.fixed.w, opts.fixed.h));
    apply();
    return screen;
  }

  const resize = (): void => {
    if (setViewport(fitViewport(window.innerWidth, window.innerHeight))) apply();
  };
  window.addEventListener('resize', resize);
  // Chrome fires no `resize` for a devicePixelRatio change on its own (a
  // window dragged between monitors, or the page zoomed), and `orientation`
  // on a phone lands before `resize` reports the new size on some builds.
  window.addEventListener('orientationchange', resize);
  setViewport(fitViewport(window.innerWidth, window.innerHeight));
  apply();
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
