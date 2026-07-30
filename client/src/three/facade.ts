import * as THREE from 'three';
import { Z_PER_STOREY } from 'shared';
import palette from 'shared/data/palette.json';
import { toonGradient } from './toon.js';

/**
 * Marking colours come from the palette, not from this file.
 *
 * Both of these were re-invented here as literals a shade or two brighter
 * than the game's own — a lane line at `#d8cf94` against the palette's
 * `#b9b183`, a crossing at `vec3(0.86)` against `#c2bfae` — which is why the
 * 3D street read as a motorway and the crossings glared white in every
 * screenshot while the 2D view of the same junction did not.
 */
const ROAD_LANE = Number.parseInt(palette.roadLane.slice(1), 16);
const ROAD_CROSSING = new THREE.Color(palette.roadCrossing);

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
  // The gradient map is not optional decoration — without one three.js falls
  // back to a single hard step between 0.7 and 1.0, so a wall facing away from
  // the sun is only 30% darker than one facing it and the banding the whole
  // art direction rests on never appears. Props and vehicles went through
  // `toonMaterial()` and got the real three-band ramp; the city did not, so
  // the two halves of the world were quantised on different curves.
  const mat = new THREE.MeshToonMaterial({ color: opts.color, gradientMap: toonGradient() });
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


/**
 * Road surface: tarmac grain, and a dashed centre line where there is one.
 *
 * `mark` is 0 for plain carriageway, 1 for a centre line running along x, 2
 * along y. Which tiles get which is decided on the CPU from the contiguous
 * road run (see `cityView`), because a tile cannot tell from its own
 * coordinates whether it is the middle of a four-lane street — and painting a
 * line on every tile edge, which is what the first version did, turns the
 * road network into a chequerboard.
 *
 * Still one material per case rather than per road, so the ground stays three
 * instanced draws.
 */
export function roadMaterial(color: number, mark: number, lineColor = ROAD_LANE): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() });
  const uniforms = {
    uLine: { value: new THREE.Color(lineColor) },
    uCrossing: { value: ROAD_CROSSING },
    uTile: { value: 16 },
    uMark: { value: mark },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vWorld;\n varying vec3 vWN;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vec4 rwp = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           rwp = instanceMatrix * rwp;
         #endif
         vWorld = (modelMatrix * rwp).xyz;
         vec3 rn = objectNormal;
         #ifdef USE_INSTANCING
           rn = mat3(instanceMatrix) * rn;
         #endif
         vWN = normalize(mat3(modelMatrix) * rn);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorld;
         varying vec3 vWN;
         uniform vec3 uLine;
         uniform vec3 uCrossing;
         uniform float uTile;
         uniform float uMark;
         float road_hash(vec2 p) {
           return fract(sin(dot(p, vec2(41.3, 289.1))) * 24634.6345);
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         if (vWN.z > 0.5) {
           // Grain first, so the marking sits on the tarmac rather than under.
           float grain = road_hash(floor(vWorld.xy * 0.7));
           diffuseColor.rgb *= 0.95 + grain * 0.10;
           if (uMark > 2.5) {
             // Crossing: stripes across the carriageway at a junction mouth.
             vec2 t = vWorld.xy / uTile;
             float bars = uMark < 3.5 ? fract(t.x * 4.0) : fract(t.y * 4.0);
             float band = uMark < 3.5 ? abs(fract(t.y) - 0.5) : abs(fract(t.x) - 0.5);
             float zebra = (1.0 - step(0.5, bars)) * (1.0 - step(0.42, band));
             diffuseColor.rgb = mix(diffuseColor.rgb, uCrossing, zebra * 0.8);
           } else if (uMark > 0.5) {
             vec2 t = vWorld.xy / uTile;
             // Across the lane: how far from the tile centre, 0 at the middle.
             float across = uMark < 1.5 ? abs(fract(t.y) - 0.5) : abs(fract(t.x) - 0.5);
             // Along the lane: the dash cadence.
             float along  = uMark < 1.5 ? fract(t.x * 1.5) : fract(t.y * 1.5);
             // Half-width 0.031 of a 16 px tile is a 1 px line, which is what
             // tiles.ts paints. 0.075 was 2.4 px — nearly two and a half
             // times the 2D line, on every road in the city.
             float line = (1.0 - step(0.031, across)) * (1.0 - step(0.55, along));
             diffuseColor.rgb = mix(diffuseColor.rgb, uLine, line * 0.72);
           }
         }`,
      );
  };
  mat.customProgramCacheKey = () => 'road';
  return mat;
}


/**
 * Ground surfaces that are not road: grass, pavement, sand, lots.
 *
 * The 2D tile layer speckles all of these — two passes of scattered dots in
 * lighter and darker tones — and it matters more than it sounds. A flat fill
 * over a whole park reads as a placeholder; the same colour with a few per
 * cent of noise in it reads as a surface. This is the same idea in a shader,
 * at two scales so it does not turn into visible dithering when the camera
 * gets close.
 *
 * `edge` darkens the outer few pixels of each tile, which is what gives
 * pavements their slabbing and stops a park being one enormous green
 * rectangle.
 */
export function groundMaterial(color: number, grain = 0.1, edge = 0): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() });
  const uniforms = { uGrain: { value: grain }, uEdge: { value: edge }, uTile: { value: 16 } };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vGW;\n varying vec3 vGN;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vec4 gwp = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           gwp = instanceMatrix * gwp;
         #endif
         vGW = (modelMatrix * gwp).xyz;
         vec3 gn = objectNormal;
         #ifdef USE_INSTANCING
           gn = mat3(instanceMatrix) * gn;
         #endif
         vGN = normalize(mat3(modelMatrix) * gn);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGW;
         varying vec3 vGN;
         uniform float uGrain;
         uniform float uEdge;
         uniform float uTile;
         float g_hash(vec2 p) { return fract(sin(dot(p, vec2(73.1, 41.7))) * 19733.13); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         if (vGN.z > 0.5) {
           float coarse = g_hash(floor(vGW.xy * 0.35));
           float fine   = g_hash(floor(vGW.xy * 1.4));
           diffuseColor.rgb *= 1.0 + (coarse - 0.5) * uGrain + (fine - 0.5) * uGrain * 0.6;
           if (uEdge > 0.0) {
             vec2 f = abs(fract(vGW.xy / uTile) - 0.5);
             float seam = max(step(0.45, f.x), step(0.45, f.y));
             diffuseColor.rgb *= 1.0 - seam * uEdge;
           }
         }`,
      );
  };
  mat.customProgramCacheKey = () => 'ground';
  return mat;
}
