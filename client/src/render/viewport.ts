import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from 'shared';
import { RENDER_SCALE } from './config.js';

/**
 * The design field of view: the frame the HUD, the camera lead and every
 * balance decision were tuned against. The window no longer has to match it,
 * but it is still what the fit aims for.
 */
export const BASE_VIEW_W = INTERNAL_WIDTH;
export const BASE_VIEW_H = INTERNAL_HEIGHT;

/**
 * The ceiling on how much world one screen may show.
 *
 * Two reasons it exists. The server only streams entities within
 * `INTEREST_RADIUS` (600 px) of you, so a view whose half-diagonal approaches
 * that would show empty streets at the edges; and a 32:9 monitor left
 * unbounded would hand its owner three times the situational awareness of a
 * laptop. At the ceiling the half-diagonal is 403 px — comfortably inside the
 * interest radius — and it sits where it does so that the common laptop
 * resolutions land on a whole zoom step rather than being pushed up one and
 * losing a third of their frame to get there.
 */
export const MAX_VIEW_W = 700;
export const MAX_VIEW_H = 400;

/** Whole zoom steps we are willing to climb to get under the ceiling. */
const MAX_STEPS = 8;

export interface ViewportFit {
  /** World pixels visible, horizontally and vertically. */
  w: number;
  h: number;
  /** Backing-store size, in device pixels. */
  deviceW: number;
  deviceH: number;
  /** CSS pixels per world pixel. */
  zoom: number;
  /** On-page size of the canvas element, in CSS pixels. */
  cssW: number;
  cssH: number;
}

/**
 * Fit the world view to a window.
 *
 * The old rule was "draw 480×270 world pixels into the largest whole multiple
 * of the 960×540 backing store that fits, and letterbox the rest", which meant
 * every display that was not exactly 1920×1080 (or 3840×2160) played inside
 * black bars — a 1440p monitor lost a third of its glass.
 *
 * The new rule inverts it: pick the zoom first, then let the view grow to
 * whatever the window has room for. Zoom prefers a whole multiple of
 * `RENDER_SCALE`, so one backing-store pixel covers a whole number of CSS
 * pixels and nearest-neighbour upscaling stays even — an uneven upscale is
 * what makes pixel art shimmer. It falls back to a fractional zoom only where
 * no whole step both fills the window and stays under the ceiling, because
 * the alternative there is the letterbox this replaced.
 *
 * Pure, and exported on its own, because the interesting cases are the ones
 * nobody has to hand: ultrawides, half-height windows, and the exact multiples
 * that must keep behaving as they always did.
 */
export function fitViewport(winW: number, winH: number): ViewportFit {
  const w = Math.max(1, Math.floor(winW));
  const h = Math.max(1, Math.floor(winH));
  // The zoom that would show exactly the design frame, fitted.
  const ideal = Math.min(w / BASE_VIEW_W, h / BASE_VIEW_H);

  // The zoom that exactly caps the field of view. Whatever else happens, the
  // frame is never allowed below this, or the canvas stops covering the window.
  const atCeiling = Math.max(w / MAX_VIEW_W, h / MAX_VIEW_H);

  let zoom = Math.max(0.5, ideal, atCeiling);
  if (zoom >= RENDER_SCALE) {
    // Round *down* to a whole step, so one backing-store pixel covers a whole
    // number of CSS pixels: erring towards zooming out fills the window rather
    // than cropping it. Then climb until the field of view is under the
    // ceiling — which is the same test, one step at a time.
    let steps = Math.max(1, Math.floor(zoom / RENDER_SCALE));
    while (steps < MAX_STEPS && steps * RENDER_SCALE < atCeiling) steps++;
    const stepped = steps * RENDER_SCALE;
    // A window wider than eight steps of the ceiling is past anything a
    // display does; fill it fractionally rather than letterbox it.
    zoom = stepped >= atCeiling ? stepped : atCeiling;
  }

  const vw = Math.min(MAX_VIEW_W, Math.max(1, Math.ceil(w / zoom)));
  const vh = Math.min(MAX_VIEW_H, Math.max(1, Math.ceil(h / zoom)));
  return {
    w: vw,
    h: vh,
    deviceW: vw * RENDER_SCALE,
    deviceH: vh * RENDER_SCALE,
    zoom,
    cssW: vw * zoom,
    cssH: vh * zoom,
  };
}

/** The frame an offscreen or evidence canvas renders, where no window applies. */
export function fixedViewport(w: number, h: number): ViewportFit {
  return {
    w,
    h,
    deviceW: w * RENDER_SCALE,
    deviceH: h * RENDER_SCALE,
    zoom: RENDER_SCALE,
    cssW: w * RENDER_SCALE,
    cssH: h * RENDER_SCALE,
  };
}

/**
 * The live viewport. Mutated in place rather than replaced so the twenty-odd
 * modules that read it can hold the object instead of re-importing a getter
 * on every draw call.
 */
export const viewport: ViewportFit = fixedViewport(BASE_VIEW_W, BASE_VIEW_H);

type Listener = (v: ViewportFit) => void;
const listeners = new Set<Listener>();

/** Told whenever the frame changes size, for anything holding a sized buffer. */
export function onViewportChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Adopt a new fit. Returns whether anything actually moved. */
export function setViewport(next: ViewportFit): boolean {
  if (next.w === viewport.w && next.h === viewport.h && next.zoom === viewport.zoom) return false;
  Object.assign(viewport, next);
  for (const fn of listeners) fn(viewport);
  return true;
}
