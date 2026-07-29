import * as THREE from 'three';
import { Z_PER_STOREY } from 'shared';

/**
 * Building facades, computed in the fragment shader from world position.
 *
 * The alternative was geometry — a window box per window — which for a
 * downtown block of twelve storeys is thousands of extra boxes per building
 * and defeats the instancing that makes the city one draw call. The other
 * alternative was textures, which needs a different UV scale per building
 * height and so a different material per height, which defeats it again.
 *
 * Doing it in the shader keeps **one material for every building**. Storey
 * lines fall on world Z, window columns on world X or Y depending on which
 * way the wall faces, and the ground floor gets its own treatment because a
 * shopfront is not a window and a building whose bottom storey matches the
 * forty above it reads as a filing cabinet.
 *
 * It is injected into `MeshToonMaterial` with `onBeforeCompile` rather than
 * written as a `ShaderMaterial`, so the toon banding, the shadow map and the
 * lighting all keep working — reimplementing those to get windows would be a
 * bad trade.
 */

export interface FacadeOptions {
  /** Base colour of the building mass. */
  color: number;
  /** Window glass colour by day. */
  glass?: number;
  /** Lit-window colour; mixed in as night falls. */
  lit?: number;
  /** 0 by day, 1 at night — drives how many windows are lit. */
  night?: number;
}

/**
 * A toon material that draws a facade on vertical faces and leaves
 * horizontal ones alone.
 *
 * The top/side test is `abs(normal.z)`: roofs get roof treatment, walls get
 * windows. Without it the window grid would tile across every roof and the
 * city would look like it was made of graph paper.
 */
export function facadeMaterial(opts: FacadeOptions): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ color: opts.color });
  const glass = new THREE.Color(opts.glass ?? 0x2b3a4d);
  const lit = new THREE.Color(opts.lit ?? 0xffd9a0);
  const uniforms = {
    uGlass: { value: glass },
    uLit: { value: lit },
    uNight: { value: opts.night ?? 0 },
    uStorey: { value: Z_PER_STOREY },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorld;
         varying vec3 vWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vec4 wp = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           wp = instanceMatrix * wp;
         #endif
         wp = modelMatrix * wp;
         vWorld = wp.xyz;
         vec3 on = objectNormal;
         #ifdef USE_INSTANCING
           on = mat3(instanceMatrix) * on;
         #endif
         vWorldNormal = normalize(mat3(modelMatrix) * on);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorld;
         varying vec3 vWorldNormal;
         uniform vec3 uGlass;
         uniform vec3 uLit;
         uniform float uNight;
         uniform float uStorey;

         // Deterministic per-window hash, so a window that is lit stays lit
         // rather than flickering as the camera moves.
         float win_hash(vec2 p) {
           return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           // Vertical faces only. A roof keeps the mass colour.
           float side = 1.0 - min(1.0, abs(vWorldNormal.z) * 4.0);
           if (side > 0.0) {
             // Which way the wall faces decides whether windows run along
             // world X or world Y.
             float u = abs(vWorldNormal.x) > abs(vWorldNormal.y) ? vWorld.y : vWorld.x;
             float storey = floor(vWorld.z / uStorey);
             float inStorey = fract(vWorld.z / uStorey);

             // Column grid: a window every 8 world px, 55% glass.
             float col = floor(u / 8.0);
             float inCol = fract(u / 8.0);

             // A band of wall at the top and bottom of each storey, and a
             // mullion between columns. What is left is glass.
             float glassMask =
               step(0.22, inStorey) * step(inStorey, 0.80) *
               step(0.20, inCol) * step(inCol, 0.80);

             // Ground floor: taller opening, no mullions — a shopfront.
             bool ground = vWorld.z < uStorey;
             if (ground) {
               glassMask = step(0.15, inStorey) * step(inStorey, 0.72) * step(0.08, inCol) * step(inCol, 0.92);
             }

             // A floor slab line between storeys reads as structure and is
             // what stops a tall building looking like one stretched decal.
             float slab = 1.0 - step(0.06, inStorey);
             vec3 wall = diffuseColor.rgb * (1.0 - slab * 0.35);

             float r = win_hash(vec2(col, storey));
             // More windows lit as it gets darker; never all of them.
             float on = step(1.0 - uNight * 0.55, r);
             vec3 pane = mix(uGlass, uLit, on * uNight);

             diffuseColor.rgb = mix(wall, pane, glassMask * side);
           }
         }`,
      );
  };

  // Materials with the same program are batched by three.js on the shader
  // cache key; without this every building colour would recompile.
  mat.customProgramCacheKey = () => 'facade';
  (mat as unknown as { userData: { uniforms: typeof uniforms } }).userData = { uniforms };
  return mat;
}

/** Update the night amount on every facade material in a scene. */
export function setFacadeNight(scene: THREE.Object3D, night: number): void {
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    const u = (m as unknown as { userData?: { uniforms?: { uNight: { value: number } } } })?.userData
      ?.uniforms;
    if (u) u.uNight.value = night;
  });
}
