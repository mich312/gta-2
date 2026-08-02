import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GRADE_DAY, GRADE_NIGHT } from '../render/config.js';

/**
 * The full-screen passes — the grade the game already owns, finally applied.
 *
 * `render/config.ts` has always defined `GRADE_DAY` and `GRADE_NIGHT` with a
 * `tint` and a `vignette` alongside their colour. The 2D renderer applies all
 * three, plus a bloom. The 3D renderer imported the same two constants and used
 * **only the r/g/b**, as an ambient light colour — so two thirds of the game's
 * own authored grade went on the floor, and the 3D view had no full-screen pass
 * of any kind.
 *
 * This is not a new art direction. It is the existing one, reaching the
 * renderer that was missing it.
 *
 * **Order, and why the grade comes last.** Bloom wants linear HDR, so it sits
 * before `OutputPass` — which is where tone mapping and the sRGB transform
 * happen, because three.js skips both when a material renders into a target
 * rather than the screen. The grade then runs *after* `OutputPass`, in sRGB, so
 * its tint and vignette composite exactly as the 2D pass's `fillStyle` and
 * radial gradient do over a canvas. Grading in linear would be more defensible
 * in the abstract and would not match the look this game already has.
 */

/** The cool wash the 2D pass lays over the frame — `rgba(24, 34, 58, tint)`. */
const TINT = new THREE.Color(24 / 255, 34 / 255, 58 / 255);
/** What the corners fall towards. The 2D vignette ends at `rgb(3, 6, 12)`. */
const VIGNETTE_COLOR = new THREE.Color(3 / 255, 6 / 255, 12 / 255);

/**
 * Tint and vignette, in screen space.
 *
 * The radii are the 2D pass's own: transparent inside 0.32 of the short side,
 * full strength by 0.72 of the long one, so the falloff lands in the same place
 * whichever renderer drew the frame.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTint: { value: 0 },
    uTintColor: { value: TINT },
    uVignette: { value: 0 },
    uVignetteColor: { value: VIGNETTE_COLOR },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTint;
    uniform vec3 uTintColor;
    uniform float uVignette;
    uniform vec3 uVignetteColor;
    uniform vec2 uResolution;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb = mix(c.rgb, uTintColor, uTint);
      vec2 px = vUv * uResolution;
      float d = distance(px, uResolution * 0.5);
      float inner = min(uResolution.x, uResolution.y) * 0.32;
      float outer = max(uResolution.x, uResolution.y) * 0.72;
      float v = smoothstep(inner, outer, d) * uVignette;
      c.rgb = mix(c.rgb, uVignetteColor, v);
      gl_FragColor = c;
    }
  `,
};

/** Bloom that only the genuinely bright things reach. */
const BLOOM_STRENGTH = 0.38;
const BLOOM_RADIUS = 0.5;
/**
 * Above this, in linear HDR, a pixel blooms.
 *
 * Set above 1 on purpose: a lit surface should not glow, only a source should.
 * Lamps, headlights, sirens and lit windows are the things that exceed it.
 */
const BLOOM_THRESHOLD = 1.05;

export class PostChain {
  private readonly composer: EffectComposer;
  private readonly grade: ShaderPass;
  private readonly bloom: UnrealBloomPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
  ) {
    // Our own target, so the multisampling survives.
    //
    // `EffectComposer`'s default target leaves `samples` at 0, which silently
    // throws away the MSAA `antialias: true` gives the canvas — every edge in a
    // city of boxes goes stair-stepped the moment a composer is introduced, and
    // it looks like the post chain did it.
    //
    // 2×, not 4×. This is the only AA in the chain so it cannot go to zero,
    // but the target is HalfFloat — the resolve bandwidth is double a normal
    // target's per sample — and the world canvas now runs at full display
    // resolution, where geometric edges are half as jagged to begin with.
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 2,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    // The bloom works at HALF resolution. `UnrealBloomPass` builds a five-level
    // mip chain of separable blurs from whatever size it is given — sized to
    // the frame that is ~11 near-full-screen passes in half float. Bloom is
    // defined by having no sharp detail, so feeding the chain a half-size
    // frame reads identically and costs a quarter of the fill.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.ceil(width / 2), Math.ceil(height / 2)),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloom);
    // Tone mapping and the sRGB transform. Everything before this is linear.
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.setSize(width, height);
  }

  /** 0 at midday, 1 at midnight — the same number the rest of the rig takes. */
  setNight(t: number): void {
    const u = this.grade.uniforms;
    (u.uTint as { value: number }).value =
      GRADE_DAY.tint + (GRADE_NIGHT.tint - GRADE_DAY.tint) * t;
    (u.uVignette as { value: number }).value =
      GRADE_DAY.vignette + (GRADE_NIGHT.vignette - GRADE_DAY.vignette) * t;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    // Half resolution, like the constructor — `composer.setSize` resizes every
    // pass to the full frame, so the bloom must be re-shrunk after it.
    this.bloom.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
    (this.grade.uniforms.uResolution as { value: THREE.Vector2 }).value.set(width, height);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
