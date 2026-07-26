/**
 * Deterministic hashing for *visual* variation — per-tile speckle, roof
 * furniture, outfit picks. Entirely separate from the sim PRNG: this may be
 * called freely from rendering without touching determinism, and the same
 * (seed, coords) always styles the same pixel on every client.
 */

/** 2D integer hash → uint32. Cheap avalanche, good enough for speckle. */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ x, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ y, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** hash2 folded to [0, 1). */
export function hash01(seed: number, x: number, y: number): number {
  return hash2(seed, x, y) / 0x1_0000_0000;
}

/** hash2 folded to an integer in [0, n). */
export function hashPick(seed: number, x: number, y: number, n: number): number {
  return hash2(seed, x, y) % n;
}

/** Tiny splittable stream for multi-draw features on one anchor. */
export class VisualStream {
  private state: number;

  constructor(seed: number, x: number, y: number) {
    this.state = hash2(seed, x, y) || 1;
  }

  /** Next float in [0, 1). xorshift32 — fast, stable, non-sim. */
  next(): number {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.state = s >>> 0;
    return this.state / 0x1_0000_0000;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Parse `#rrggbb` or `rgb(r, g, b)` → [r, g, b]. */
export function hexRgb(color: string): [number, number, number] {
  if (color.startsWith('rgb')) {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return [255, 0, 255];
  }
  const v = Number.parseInt(color.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Lighten (amt > 0) or darken (amt < 0) a hex colour; amt in [-1, 1]. */
export function shade(hex: string, amt: number): string {
  const [r, g, b] = hexRgb(hex);
  const f = (c: number): number => {
    const v = amt >= 0 ? c + (255 - c) * amt : c * (1 + amt);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/** Mix two hex colours; t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexRgb(a);
  const [br, bg, bb] = hexRgb(b);
  const m = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return `rgb(${m(ar, br)}, ${m(ag, bg)}, ${m(ab, bb)})`;
}
