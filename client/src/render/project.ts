import type { Vec2 } from 'shared';
import { viewport } from './viewport.js';

/**
 * Where a point on the ground lands in the HUD's frame.
 *
 * Everything drawn over the world in HUD units — name tags, bullet tracers —
 * used to assume `screen = world - cam`, on the stated grounds that "the 3D
 * camera hangs straight down over the middle of the same frame". It does not:
 * `GAME_PITCH` is 10 degrees, and a tilted camera moves a ground point away
 * from that identity by up to 15 world px at the corners of the largest frame
 * — a name tag half a car width off the head it belongs to, a tracer that
 * misses the wall it hit. The identity was verified at pitch 0 and never
 * re-verified after the camera was tilted.
 *
 * So the HUD asks here instead of subtracting. With no 3D camera registered —
 * the 2D renderer, and any offscreen or evidence canvas — this is exactly the
 * old subtraction, the same expression on the same numbers, so the 2D path
 * cannot move. At pitch 0 it takes the same branch, which is why the pitch-0
 * control still prints zeros to the last digit rather than to a tolerance.
 *
 * The projection is closed form rather than a matrix round-trip through
 * three.js: `render/` is the 2D layer and must not pull the 3D renderer in
 * behind it, and a ground plane under a camera pitched about its own focus has
 * a two-line answer. Derivation, with `d` the offset from the focus, `H` the
 * camera height and `p` the pitch:
 *
 *   depth  = H - dy·sin p          (tilt pulls the far side of the frame away)
 *   scale  = H / depth             (perspective divide)
 *   screen = centre + (dx·scale, dy·cos p·scale)
 *
 * which is the identity at p = 0. Two multiplies and a divide per point, and
 * the callers are a handful of tags and tracers per frame.
 */
interface GroundCamera {
  sinPitch: number;
  cosPitch: number;
  /** tan of half the vertical field of view, for the camera height. */
  tanHalfFov: number;
}

let camera3d: GroundCamera | null = null;

/**
 * Tell the HUD which 3D camera is over the world.
 *
 * Called by `CityView`, which owns the pitch and the field of view, so the HUD
 * and the camera cannot drift apart the way the comment and `GAME_PITCH` did.
 * A pitch of 0 registers nothing: the straight-down camera *is* the identity,
 * and saying so keeps that case free.
 */
export function setHudGroundCamera(pitchDeg: number, fovYDeg: number): void {
  if (!(pitchDeg > 0)) {
    camera3d = null;
    return;
  }
  const rad = (pitchDeg * Math.PI) / 180;
  camera3d = {
    sinPitch: Math.sin(rad),
    cosPitch: Math.cos(rad),
    tanHalfFov: Math.tan((fovYDeg * Math.PI) / 360),
  };
}

/** Forget it again — the 3D renderer has been disposed or fallen back to 2D. */
export function clearHudGroundCamera(): void {
  camera3d = null;
}

export interface HudPoint {
  x: number;
  y: number;
}

/**
 * Project a ground point into HUD units, writing into `out` and returning it.
 *
 * `out` is the caller's own scratch, so a per-frame path allocates nothing.
 */
export function projectGround(wx: number, wy: number, cam: Vec2, out: HudPoint): HudPoint {
  const c = camera3d;
  if (c === null) {
    out.x = wx - cam.x;
    out.y = wy - cam.y;
    return out;
  }
  const halfW = viewport.w / 2;
  const halfH = viewport.h / 2;
  const dx = wx - cam.x - halfW;
  const dy = wy - cam.y - halfH;
  // How high the camera sits for `viewport.h` world px to fill the frame —
  // the same expression as `CityView.camHeight`, which is what makes the two
  // agree rather than merely resemble each other.
  const height = halfH / c.tanHalfFov;
  // A ground point at or past the horizon has no screen position. Inside the
  // view ceiling `dy·sin p` is at most 35 px against a height near 590, so
  // this is a guard and not a case: it keeps a bad viewport from producing
  // an infinity rather than a wrong number.
  const depth = Math.max(1e-3, height - dy * c.sinPitch);
  const scale = height / depth;
  out.x = halfW + dx * scale;
  out.y = halfH + dy * c.cosPitch * scale;
  return out;
}
