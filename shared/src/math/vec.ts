export interface Vec2 {
  x: number;
  y: number;
}

export function vec(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function cloneVec(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function lenVec(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function distVec(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Quantize to 1/8 px (exact in binary): positions/velocities land on a grid
 * so their JSON stays short ("123.125", not 17 digits) without breaking
 * determinism — Math.round and division by powers of two are exact.
 */
export function q8(v: number): number {
  return Math.round(v * 8) / 8 + 0; // +0 normalizes -0 (JSON writes "0")
}

/** Quantize to 1/256 (angles): ~0.004 rad steps, invisible, short JSON. */
export function q256(v: number): number {
  return Math.round(v * 256) / 256 + 0; // +0 normalizes -0
}

/** Move v toward target by at most maxDelta. */
export function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}
