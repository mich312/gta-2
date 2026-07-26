/**
 * Deterministic trig for simulation code.
 *
 * Math.sin/cos/atan2 are not IEEE-pinned and can differ across JS engines in
 * the last bits, which breaks client/server lockstep. These implementations
 * use only + - * / and Math.floor/abs — all exact under IEEE-754 — so results
 * are bit-identical everywhere. Sim code must never call Math trig directly.
 */
export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle into [-PI, PI). Exact ops only. */
export function wrapAngle(x: number): number {
  return x - TWO_PI * Math.floor((x + PI) / TWO_PI);
}

/** Deterministic sine. Max abs error ~6e-8. */
export function dSin(x: number): number {
  let r = wrapAngle(x);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const x2 = r * r;
  // Taylor series through the x^11 term; error bound at |r| = PI/2 is ~6e-8.
  return (
    r *
    (1 +
      x2 *
        (-1 / 6 +
          x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 - x2 / 39916800)))))
  );
}

/** Deterministic cosine. */
export function dCos(x: number): number {
  return dSin(x + HALF_PI);
}

/** atan on [0, 1]; polynomial approximation, max error ~1e-5 rad. */
function atan01(z: number): number {
  const z2 = z * z;
  return (
    z *
    (0.999866 +
      z2 * (-0.3302995 + z2 * (0.180141 + z2 * (-0.085133 + z2 * 0.0208351))))
  );
}

/** Deterministic atan. */
export function dAtan(z: number): number {
  const a = z < 0 ? -z : z;
  const r = a <= 1 ? atan01(a) : HALF_PI - atan01(1 / a);
  return z < 0 ? -r : r;
}

/** Deterministic atan2 with standard quadrant handling. dAtan2(0, 0) === 0. */
export function dAtan2(y: number, x: number): number {
  if (x > 0) return dAtan(y / x);
  if (x < 0) return y >= 0 ? dAtan(y / x) + PI : dAtan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}
