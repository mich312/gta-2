interface SheetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation pivot, relative to the frame's top-left. */
  px: number;
  py: number;
  /** Rotation steps to bake; 0 = the sprite is never rotated. */
  rot: number;
}

interface SheetMeta {
  scale: number;
  frames: Record<string, SheetFrame>;
}

/**
 * Sprite sheet access, with rotation baked at load rather than applied at draw
 * time.
 *
 * Rotating a 30-pixel sprite with `ctx.rotate` every frame costs a transform
 * flush and, worse, resamples the art on every angle change — small pixel
 * sprites visibly crawl as they turn. Baking each angle once into its own
 * canvas gives a clean resample per angle (done with smoothing on, which is
 * what keeps diagonals looking drawn rather than stair-stepped) and reduces
 * drawing to a plain axis-aligned blit.
 *
 * Baking is lazy and cached: only the angles and colour variants actually on
 * screen are ever built.
 */
export class SpriteSheet {
  /** Art pixels per world pixel, from the generator. */
  scale = 2;
  ready = false;

  private image: HTMLImageElement | null = null;
  private frames: Record<string, SheetFrame> = {};
  private baked = new Map<string, HTMLCanvasElement>();

  async load(): Promise<void> {
    try {
      // Root-absolute, not relative. The sheet lives at the site root
      // whatever page asked for it, and a relative path silently resolved
      // against the PAGE — so any page not at `/` 404'd and every sprite in
      // the game fell back to a coloured rectangle. It cost an afternoon of
      // believing the evidence harness was lying.
      const meta = (await (await fetch('/sprites.meta.json')).json()) as SheetMeta;
      const img = new Image();
      img.src = '/sprites.png';
      await img.decode();
      this.frames = meta.frames;
      this.scale = meta.scale || 2;
      this.image = img;
      this.ready = true;
    } catch {
      // Missing sheet is fine — placeholder rects render instead.
    }
  }

  has(name: string): boolean {
    return this.image !== null && this.frames[name] !== undefined;
  }

  /** Size of a sprite in world pixels, or null if it is not in the sheet. */
  sizeOf(name: string): { w: number; h: number } | null {
    const f = this.frames[name];
    return f ? { w: f.w / this.scale, h: f.h / this.scale } : null;
  }

  /**
   * Draw a sprite centred on its pivot at device-pixel (x, y), rotated to
   * `angle` radians. Coordinates are floored so the art lands on whole device
   * pixels. Returns false when the sprite is unavailable.
   */
  draw(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, angle: number): boolean {
    const frame = this.frames[name];
    if (!this.image || !frame) return false;
    const canvas = this.bake(name, frame, this.stepFor(frame, angle));
    ctx.drawImage(canvas, Math.floor(x - canvas.width / 2), Math.floor(y - canvas.height / 2));
    return true;
  }

  /** Silhouette half-extents in device pixels, used to size drop shadows. */
  footprint(name: string): { rx: number; ry: number } {
    const f = this.frames[name];
    if (!f) return { rx: 7, ry: 7 };
    return { rx: f.w / 2, ry: f.h / 2 };
  }

  private stepFor(frame: SheetFrame, angle: number): number {
    if (frame.rot <= 0) return 0;
    const raw = Math.round((angle / (Math.PI * 2)) * frame.rot);
    return ((raw % frame.rot) + frame.rot) % frame.rot;
  }

  private bake(name: string, frame: SheetFrame, step: number): HTMLCanvasElement {
    const key = `${name}#${step}`;
    const cached = this.baked.get(key);
    if (cached) return cached;

    // Square canvas wide enough to hold the sprite at any angle, with the
    // pivot dead centre so drawing is a straight centred blit.
    const reach = Math.ceil(
      2 *
        Math.max(
          Math.hypot(frame.px, frame.py),
          Math.hypot(frame.w - frame.px, frame.py),
          Math.hypot(frame.px, frame.h - frame.py),
          Math.hypot(frame.w - frame.px, frame.h - frame.py),
        ),
    );
    const size = reach + 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    // Smoothing on *for the bake only*: this is the one resample the art ever
    // gets, and letting it interpolate is what keeps rotated edges clean. The
    // unrotated frame stays pixel-exact.
    ctx.imageSmoothingEnabled = step !== 0;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(size / 2, size / 2);
    if (step !== 0) ctx.rotate((step / frame.rot) * Math.PI * 2);
    ctx.drawImage(
      this.image as HTMLImageElement,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      -frame.px,
      -frame.py,
      frame.w,
      frame.h,
    );

    this.baked.set(key, canvas);
    return canvas;
  }
}
