import { describe, expect, it } from 'vitest';
import { RENDER_SCALE } from '../src/render/config.js';
import {
  BASE_VIEW_H,
  BASE_VIEW_W,
  MAX_VIEW_H,
  MAX_VIEW_W,
  fitViewport,
} from '../src/render/viewport.js';

/** Window sizes worth naming, plus the awkward ones nobody has to hand. */
const WINDOWS: Array<[number, number]> = [
  [1920, 1080],
  [1920, 950],
  [2560, 1440],
  [2560, 1310],
  [3440, 1440],
  [3840, 2160],
  [5120, 2160],
  [1366, 768],
  [1280, 720],
  [1280, 600],
  [1600, 900],
  [800, 600],
  [640, 480],
  [400, 300],
  [300, 900],
  [120, 90],
];

describe('fitViewport', () => {
  it('covers the window at every size', () => {
    // The whole point of the change: no letterbox, ever. A frame is allowed to
    // overhang by up to one world pixel (the view is a whole number) but never
    // to fall short, which is what leaves black bars down the side.
    for (const [w, h] of WINDOWS) {
      const v = fitViewport(w, h);
      expect(v.cssW, `${w}x${h} width`).toBeGreaterThanOrEqual(w);
      expect(v.cssH, `${w}x${h} height`).toBeGreaterThanOrEqual(h);
      expect(v.cssW - w).toBeLessThan(v.zoom + 1e-9);
      expect(v.cssH - h).toBeLessThan(v.zoom + 1e-9);
    }
  });

  it('keeps the field of view inside the ceiling', () => {
    for (const [w, h] of WINDOWS) {
      const v = fitViewport(w, h);
      expect(v.w, `${w}x${h}`).toBeLessThanOrEqual(MAX_VIEW_W);
      expect(v.h, `${w}x${h}`).toBeLessThanOrEqual(MAX_VIEW_H);
    }
  });

  it('leaves the reference resolutions on the design frame', () => {
    // 1080p and 4K are exact multiples of the backing store, and they are what
    // the HUD and the camera lead were tuned against. If either of them ever
    // stops being 480x270 on a whole zoom, something has gone wrong.
    for (const [w, h, zoom] of [
      [1920, 1080, 4],
      [3840, 2160, 8],
    ] as Array<[number, number, number]>) {
      const v = fitViewport(w, h);
      expect(v).toMatchObject({ w: BASE_VIEW_W, h: BASE_VIEW_H, zoom });
      expect(v.cssW).toBe(w);
      expect(v.cssH).toBe(h);
    }
  });

  it('upscales by a whole number wherever a whole step fits', () => {
    // Uneven nearest-neighbour is what makes pixel art crawl. Any window at
    // least as big as the backing store should land on a whole step.
    for (const [w, h] of WINDOWS) {
      if (w < BASE_VIEW_W * RENDER_SCALE || h < BASE_VIEW_H * RENDER_SCALE) continue;
      const v = fitViewport(w, h);
      expect((v.zoom / RENDER_SCALE) % 1, `${w}x${h} zoom ${v.zoom}`).toBe(0);
    }
  });

  it('derives the backing store from the view', () => {
    for (const [w, h] of WINDOWS) {
      const v = fitViewport(w, h);
      expect(v.deviceW).toBe(v.w * RENDER_SCALE);
      expect(v.deviceH).toBe(v.h * RENDER_SCALE);
    }
  });

  it('never shows more world than the server will send', () => {
    // Entities outside INTEREST_RADIUS (600 px, server default) are not on the
    // wire. A view whose corner reaches past that shows streets the server has
    // already decided are empty.
    for (const [w, h] of WINDOWS) {
      const v = fitViewport(w, h);
      expect(Math.hypot(v.w / 2, v.h / 2), `${w}x${h}`).toBeLessThan(600);
    }
  });

  it('survives a degenerate window', () => {
    for (const [w, h] of [
      [0, 0],
      [1, 1],
      [-40, 900],
    ] as Array<[number, number]>) {
      const v = fitViewport(w, h);
      expect(v.w).toBeGreaterThan(0);
      expect(v.h).toBeGreaterThan(0);
      expect(Number.isFinite(v.zoom)).toBe(true);
      expect(v.zoom).toBeGreaterThan(0);
    }
  });

  it('grows the view monotonically with the window', () => {
    // Not strictly — a zoom step is a discontinuity — but a window that grows
    // must never end up with a *smaller* canvas, which is the bug a naive
    // "round to nearest step" fit produces at every boundary.
    let prev = fitViewport(600, 400);
    for (let w = 620; w <= 4000; w += 20) {
      const v = fitViewport(w, Math.round(w * 0.5625));
      expect(v.cssW, `at ${w}`).toBeGreaterThanOrEqual(prev.cssW);
      prev = v;
    }
  });
});
