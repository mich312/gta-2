import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from 'shared';

export interface Screen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Current integer scale factor from internal pixels to CSS pixels. */
  scale: number;
}

/**
 * Fixed internal resolution, integer-scaled to the window, nearest-neighbour.
 * All drawing happens at internal resolution; the browser upscales the
 * element. Never draw at fractional coordinates.
 */
export function setupCanvas(canvas: HTMLCanvasElement): Screen {
  canvas.width = INTERNAL_WIDTH;
  canvas.height = INTERNAL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingEnabled = false;

  const screen: Screen = { canvas, ctx, scale: 1 };
  const resize = (): void => {
    const scale = Math.max(
      1,
      Math.floor(Math.min(window.innerWidth / INTERNAL_WIDTH, window.innerHeight / INTERNAL_HEIGHT)),
    );
    screen.scale = scale;
    canvas.style.width = `${INTERNAL_WIDTH * scale}px`;
    canvas.style.height = `${INTERNAL_HEIGHT * scale}px`;
  };
  window.addEventListener('resize', resize);
  resize();
  return screen;
}
