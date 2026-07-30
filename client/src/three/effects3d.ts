import * as THREE from 'three';
import {
  type Effects,
  decalAlpha,
  decalSpread,
  particleAlpha,
  particleSize,
} from '../render/effects.js';

/**
 * Particles and decals, in 3D, from the same pools the 2D renderer draws.
 *
 * Not a second effects system — there is one `Effects`, it is advanced once a
 * frame in `main.ts`, and this presents it. A skid mark is one skid mark that
 * two renderers can draw, which is the only arrangement in which they cannot
 * drift apart.
 *
 * **Flat quads, and that is not a compromise.** The camera hangs directly over
 * the city, so a quad in the XY plane already faces it square on — no
 * billboarding, no per-particle orientation work, and a decal lies on the road
 * exactly as it does in 2D. The one thing this buys over compositing the 2D
 * canvas on top is **depth**: a blood pool behind a tower is behind the tower,
 * where a composited layer would paint it cheerfully across the roof.
 *
 * Two instanced draws for particles (one additive, one not) and one for decals.
 * A firefight is a few hundred quads and three draw calls.
 */

/** Ground clearance for a decal, in world px. Enough to beat z-fighting. */
const DECAL_Z = 0.35;
/** How high a particle floats above the road when it has no height of its own. */
const PARTICLE_Z = 5;

/**
 * A pool of flat coloured quads, coloured and faded per instance.
 *
 * `InstancedMesh.setColorAt` carries RGB and nothing else, so alpha rides along
 * as its own instanced attribute and the shader multiplies the two. Without it
 * every particle in a puff of smoke would be equally opaque and the pool would
 * pop out of existence rather than fading.
 */
class QuadPool {
  readonly mesh: THREE.InstancedMesh;
  /** What the buffers hold. `mesh.count` is how many are drawn this frame. */
  private readonly capacity: number;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly shape: THREE.InstancedBufferAttribute;
  private used = 0;
  private readonly m = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(0, 0, 1);
  private readonly color = new THREE.Color();

  constructor(parent: THREE.Object3D, capacity: number, additive: boolean) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float instanceAlpha;
        attribute float instanceShape;
        varying float vAlpha;
        varying float vShape;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          vAlpha = instanceAlpha;
          vShape = instanceShape;
          vColor = instanceColor;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying float vShape;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          if (vAlpha <= 0.0) discard;
          float a = vAlpha;
          // 0 rect, 1 ellipse, 2 scorch. A tyre mark IS a rectangle; blood is
          // an ellipse; a burn fades out at its edge the way burnt asphalt
          // does. Drawn as a plain square, an explosion's scorch reads as a
          // rectangular blast radius — which is the exact artifact the 2D
          // layer's cached radial gradient exists to avoid, so it is not one
          // worth reintroducing here.
          if (vShape > 0.5) {
            float r = length(vUv - 0.5) * 2.0;
            if (vShape > 1.5) {
              // Same stops as the 2D scorch texture: strong to 0.45, then
              // thinning to nothing by the rim.
              a *= 1.0 - smoothstep(0.45, 1.0, r);
            } else if (r > 1.0) {
              discard;
            }
          }
          if (a <= 0.0) discard;
          gl_FragColor = vec4(vColor, a);
          // A ShaderMaterial gets the *pars* chunks injected for it and none
          // of the applications, so these two have to be asked for by name.
          // Without them the linear colour that THREE.Color converted on the
          // way in is written straight into an sRGB buffer: every skid mark,
          // blood pool, scorch, spark and muzzle flash came out far darker and
          // more saturated than the 2D effect it mirrors — palette fireGlow
          // #ff8a30 arriving on screen as a dark blood red. They were also the
          // only thing in the frame skipping ACES, so additive flashes clipped
          // hard while everything around them rolled off.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    // `instanceColor` is only declared in the shader when three.js knows the
    // mesh has one, which it learns from the attribute existing.
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute('instanceAlpha', this.alpha);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute('instanceShape', this.shape);
    // Effects are transient and everywhere; a bounding sphere computed once
    // would cull the whole pool the moment the camera moved off its origin.
    this.mesh.frustumCulled = false;
    // Over the ground, under the HUD. Decals also disable depth writes, so
    // two overlapping marks blend instead of fighting.
    this.mesh.renderOrder = additive ? 3 : 2;
    parent.add(this.mesh);
  }

  begin(): void {
    this.used = 0;
  }

  /** Place one quad. Silently drops past capacity rather than throwing. */
  put(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    angle: number,
    css: string,
    alpha: number,
    /** 0 rect, 1 ellipse, 2 scorch. See the fragment shader. */
    shape = 0,
  ): void {
    const i = this.used;
    if (i >= this.capacity || alpha <= 0 || w <= 0 || h <= 0) return;
    this.m.compose(
      this.pos.set(x, y, z),
      this.quat.setFromAxisAngle(this.axis, angle),
      this.scl.set(w, h, 1),
    );
    this.mesh.setMatrixAt(i, this.m);
    // The pools carry CSS colour strings, because that is what a Canvas
    // renderer needs. `THREE.Color` parses `rgba()` and ignores the alpha,
    // which is why alpha is passed separately rather than read back out.
    this.color.set(cssRgb(css));
    this.mesh.setColorAt(i, this.color);
    this.alpha.setX(i, alpha * cssAlpha(css));
    this.shape.setX(i, shape);
    this.used++;
  }

  /** Park the unused tail at zero scale and flush. */
  end(): void {
    // Draw only what was placed. The tail used to be hidden by zeroing its
    // alpha, which still rasterised every quad and discarded it per fragment.
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.shape.needsUpdate = true;
  }
}

/**
 * Split a CSS colour into something `THREE.Color` will take, and its alpha.
 *
 * The particle pools speak `rgba(...)` and named palette hexes. `THREE.Color`
 * understands `rgb()` and `#rrggbb` but drops the fourth channel silently, so a
 * blood stain authored at 0.6 alpha would render as flat opaque maroon.
 */
const rgbCache = new Map<string, { rgb: string; a: number }>();

function parseCss(css: string): { rgb: string; a: number } {
  const hit = rgbCache.get(css);
  if (hit) return hit;
  let out = { rgb: css, a: 1 };
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(css);
  if (m) {
    out = { rgb: `rgb(${m[1]}, ${m[2]}, ${m[3]})`, a: Number(m[4]) };
  }
  rgbCache.set(css, out);
  return out;
}

function cssRgb(css: string): string {
  return parseCss(css).rgb;
}

function cssAlpha(css: string): number {
  return parseCss(css).a;
}

export class Effects3dLayer {
  private readonly group = new THREE.Group();
  private readonly decals: QuadPool;
  private readonly plain: QuadPool;
  private readonly additive: QuadPool;

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    // Capacities match the pools they present (`MAX_DECALS`, and the particle
    // ring), so nothing is ever dropped for want of an instance.
    this.decals = new QuadPool(this.group, 512, false);
    this.plain = new QuadPool(this.group, 512, false);
    this.additive = new QuadPool(this.group, 512, true);
  }

  /** Present this frame's pools. Call after `Effects.update`. */
  update(effects: Effects): void {
    this.decals.begin();
    this.plain.begin();
    this.additive.begin();

    for (const d of effects.decalPool) {
      const spread = decalSpread(d);
      this.decals.put(
        d.x,
        d.y,
        DECAL_Z,
        d.w * spread,
        d.h * spread,
        d.angle,
        d.color,
        decalAlpha(d),
        d.shape === 'scorch' ? 2 : d.shape === 'ellipse' ? 1 : 0,
      );
    }

    for (const p of effects.particlePool) {
      if (!p.alive) continue;
      const size = particleSize(p);
      const pool = p.additive ? this.additive : this.plain;
      pool.put(p.x, p.y, PARTICLE_Z, size, size, 0, p.color, particleAlpha(p));
    }

    this.decals.end();
    this.plain.end();
    this.additive.end();
  }
}
