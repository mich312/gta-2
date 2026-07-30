import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Effects, decalAlpha, decalSpread, particleAlpha, particleSize } from '../src/render/effects.js';
import { Effects3dLayer } from '../src/three/effects3d.js';

/**
 * The 3D renderer presents the SAME effects the 2D one does.
 *
 * Not a second particle system — that is the whole design, and the reason it is
 * worth a test. `Effects` is advanced once a frame in `main.ts` and both
 * renderers read its pools, so a skid mark is one skid mark drawn twice rather
 * than two that have to be kept in step.
 *
 * Before this, effects in 3D were not merely undrawn: `effects.update` and the
 * skid/exhaust/bleed spawns lived *inside* the 2D `render()`, so in 3D they were
 * never created. Nothing to draw, and nothing to notice missing except that the
 * road never got dirty.
 *
 * three.js needs no WebGL to build a scene graph, so this runs in node: feed a
 * pool, present it, and read the instance buffers back.
 */

/** The per-instance shape flags of every live instance: 0 rect, 1 ellipse, 2 scorch. */
function shapes(layer: Effects3dLayer): number[] {
  const out: number[] = [];
  const group = (layer as unknown as { group: THREE.Group }).group;
  for (const child of group.children) {
    const mesh = child as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) continue;
    const alpha = mesh.geometry.getAttribute('instanceAlpha');
    const shape = mesh.geometry.getAttribute('instanceShape');
    for (let i = 0; i < mesh.count; i++) {
      if (alpha.getX(i) > 0) out.push(shape.getX(i));
    }
  }
  return out;
}

/** Every live instance of a pool, as (position, scale, alpha). */
function instances(
  layer: Effects3dLayer,
): Array<{ x: number; y: number; z: number; w: number; h: number; alpha: number; additive: boolean }> {
  const out: ReturnType<typeof instances> = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const group = (layer as unknown as { group: THREE.Group }).group;
  for (const child of group.children) {
    const mesh = child as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) continue;
    const alpha = mesh.geometry.getAttribute('instanceAlpha');
    const additive =
      (mesh.material as THREE.ShaderMaterial).blending === THREE.AdditiveBlending;
    for (let i = 0; i < mesh.count; i++) {
      const a = alpha.getX(i);
      if (a <= 0) continue;
      mesh.getMatrixAt(i, m);
      m.decompose(pos, quat, scl);
      out.push({ x: pos.x, y: pos.y, z: pos.z, w: scl.x, h: scl.y, alpha: a, additive });
    }
  }
  return out;
}

function layer(): { fx: Effects3dLayer; root: THREE.Group } {
  const root = new THREE.Group();
  return { fx: new Effects3dLayer(root), root };
}

describe('effects in 3D', () => {
  it('presents every decal in the pool, at its world position', () => {
    const effects = new Effects();
    effects.skid(100, 200, 0.5);
    effects.skid(140, 260, 0.5);
    const { fx } = layer();
    fx.update(effects);

    const drawn = instances(fx);
    expect(drawn).toHaveLength(2);
    // A decal lies ON the road, not in it, and not floating above the traffic.
    for (const d of drawn) {
      expect(d.z).toBeGreaterThan(0);
      expect(d.z).toBeLessThan(1);
    }
    expect(drawn.map((d) => [d.x, d.y])).toEqual([
      [100, 200],
      [140, 260],
    ]);
  });

  it('presents live particles and skips dead ones', () => {
    const effects = new Effects();
    effects.exhaust(50, 60, 0);
    const live = effects.counts().particles;
    expect(live).toBeGreaterThan(0);

    const { fx } = layer();
    fx.update(effects);
    // Decals plus particles; exhaust leaves no mark, so these are all particles.
    expect(instances(fx)).toHaveLength(live);

    // Age the pool right out. Nothing is left alive, so nothing is presented —
    // and in particular the tail of the instance buffer is not left holding
    // last frame's puff, which is what a pool that only ever writes forwards
    // would do.
    for (let i = 0; i < 400; i++) effects.update(0.1);
    expect(effects.counts()).toEqual({ decals: 0, particles: 0 });
    fx.update(effects);
    expect(instances(fx)).toHaveLength(0);
  });

  it('fades with the same curve the 2D renderer uses', () => {
    // The presentation maths is shared (`decalAlpha`, `particleSize`, …) rather
    // than reimplemented, so this pins that the layer actually calls it.
    const effects = new Effects();
    effects.skid(0, 0, 0);
    effects.update(20); // well into the fade
    const d = effects.decalPool[0]!;
    const { fx } = layer();
    fx.update(effects);
    const drawn = instances(fx)[0]!;
    // Skid rubber is authored at 0.4 alpha; the instance carries the decal's own
    // fade multiplied by the colour's alpha.
    expect(drawn.alpha).toBeCloseTo(decalAlpha(d) * 0.4, 5);
    expect(drawn.w).toBeCloseTo(d.w * decalSpread(d), 5);
  });

  it('gives a burn mark a round soft edge and a tyre mark a straight one', () => {
    // An untextured quad draws a scorch as a hard black SQUARE, which makes a
    // blast radius look rectangular — the exact artifact the 2D layer's cached
    // radial gradient was written to avoid. The shader takes a shape per
    // instance instead; this pins which decal gets which.
    const effects = new Effects();
    effects.skid(0, 0, 0); // rubber: genuinely a rectangle
    effects.explosion(200, 200, 40); // scorch: soft radial burn
    effects.bleed(400, 400, 0, 8); // blood: an ellipse
    for (let i = 0; i < 40; i++) effects.update(0.016); // let them spread in

    const { fx } = layer();
    fx.update(effects);
    const seen = new Set(shapes(fx));
    expect(seen.has(0)).toBe(true);
    expect(seen.has(1)).toBe(true);
    expect(seen.has(2)).toBe(true);
  });

  it('separates additive particles from ordinary ones', () => {
    // Sparks and flame composite additively; smoke does not. One pool each, or
    // a muzzle flash would be drawn as grey paint.
    const effects = new Effects();
    effects.fire(10, 10);
    effects.exhaust(10, 10, 0);
    const { fx } = layer();
    fx.update(effects);
    const drawn = instances(fx);
    expect(drawn.some((d) => d.additive)).toBe(true);
    expect(drawn.some((d) => !d.additive)).toBe(true);
  });

  it('sizes a particle the way the 2D renderer does', () => {
    const effects = new Effects();
    effects.exhaust(0, 0, 0);
    const p = effects.particlePool.find((q) => q.alive)!;
    const { fx } = layer();
    fx.update(effects);
    const match = instances(fx).find((d) => Math.abs(d.w - particleSize(p)) < 1e-6);
    expect(match).toBeDefined();
    expect(match!.alpha).toBeCloseTo(particleAlpha(p) * alphaOf(p.color), 5);
  });
});

/** The alpha baked into a CSS colour string, or 1 if it carries none. */
function alphaOf(css: string): number {
  const m = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(css);
  return m ? Number(m[1]) : 1;
}
