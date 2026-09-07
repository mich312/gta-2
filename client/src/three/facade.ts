import * as THREE from 'three';
import { Z_PER_STOREY } from 'shared';
import palette from 'shared/data/palette.json';
import { Z_SCALE } from '../render/config.js';
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

/**
 * How a district builds (map loop 16). One grid of identical windows over
 * every wall in the city read as one building repeated four thousand
 * times; a district is recognisable by its facades before its roofs.
 */
export type FacadeStyle = 'downtown' | 'commercial' | 'residential' | 'industrial' | 'park';

interface StyleParams {
  /** Window column pitch, world px. */
  colW: number;
  /** Glass within the column (x0, x1) and within the storey (y0, y1). */
  glass: [number, number, number, number];
  /** Ground floor: 0 windows, 1 shopfront with a fascia, 2 a door among windows, 3 roller doors. */
  ground: 0 | 1 | 2 | 3;
  /** A light string course at each storey line. */
  sill: 0 | 1;
  /** What the flat roof is made of: the slate the wall colour is pulled towards. */
  roof: number;
}

const STYLES: Record<FacadeStyle, StyleParams> = {
  // Curtain wall: wide glass, a shopfront under it.
  downtown: { colW: 8, glass: [0.2, 0.8, 0.22, 0.8], ground: 1, sill: 0, roof: 0x262a30 },
  // Shops under flats: the same shopfront, a string course per floor.
  commercial: { colW: 9, glass: [0.18, 0.82, 0.25, 0.78], ground: 1, sill: 1, roof: 0x2e2a28 },
  // Houses: smaller windows in more wall, a front door on the ground floor.
  residential: { colW: 10, glass: [0.3, 0.7, 0.34, 0.76], ground: 2, sill: 1, roof: 0x34312c },
  park: { colW: 10, glass: [0.3, 0.7, 0.34, 0.76], ground: 2, sill: 1, roof: 0x34312c },
  // Sheds: high strip windows over blank wall, roller doors at the yard.
  // Gravel over felt: a shed's roof is the lightest thing about it.
  industrial: { colW: 14, glass: [0.1, 0.9, 0.55, 0.85], ground: 3, sill: 0, roof: 0x4c4e4a },
};

export interface FacadeOptions {
  /** Base colour of the building mass. */
  color: number;
  /** The district's way of building; downtown when unsaid. */
  style?: FacadeStyle;
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
  const style = STYLES[opts.style ?? 'downtown'];
  const glass = new THREE.Color(opts.glass ?? 0x2b3a4d);
  const lit = new THREE.Color(opts.lit ?? 0xffd9a0);
  const uniforms = {
    uGlass: { value: glass },
    uLit: { value: lit },
    uNight: { value: opts.night ?? 0 },
    // The DRAWN storey, not the modelled one. `cityGeometry` builds the mass
    // at `Z_SCALE` of its collision height, and this shader spaces its floor
    // slabs and shopfront off world z — so left at the raw `Z_PER_STOREY` a
    // nine-storey block would wear two storeys of windows and be one
    // continuous shopfront from the pavement to the roof.
    uStorey: { value: Z_PER_STOREY * Z_SCALE },
    uColW: { value: style.colW },
    uGlassBox: { value: new THREE.Vector4(...style.glass) },
    uGround: { value: style.ground },
    uSill: { value: style.sill },
    uDoor: { value: new THREE.Color(0x3a2a22) },
    uRoof: { value: new THREE.Color(style.roof) },
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
         uniform float uColW;
         uniform vec4 uGlassBox;
         uniform float uGround;
         uniform float uSill;
         uniform vec3 uDoor;
         uniform vec3 uRoof;

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
           float side = 1.0 - min(1.0, abs(vWorldNormal.z) * 4.0);

           // A roof is not the same material as the wall under it.
           //
           // It used to keep the mass colour, so a pastel block was pastel on
           // top as well — and seen from almost overhead the roof is most of
           // what a building IS on screen. Real roofs are tar, felt and gravel:
           // dark, desaturated, and much closer to each other than the facades
           // they cap. Pulling them down onto a common slate keeps enough of
           // the building's own hue to tell blocks apart while taking the
           // brightest large mass in the frame out of the picture.
           if (side <= 0.0) {
             // Pushed well below what looks right as an albedo, because a roof
             // faces the sun square on and collects more irradiance than any
             // other surface in the city — a slate that reads correctly in
             // isolation comes out mid-grey once it is lit.
             // The district's roofing (map loop 19): slate downtown, tar on
             // the shops, felt on the houses, pale gravel on the sheds.
             vec3 slate = uRoof;
             float grit = (win_hash(floor(vWorld.xy * 1.7)) - 0.5) * 0.03;
             diffuseColor.rgb = mix(diffuseColor.rgb, slate, 0.72) * 0.46 + grit;
           }

           if (side > 0.0) {
             // Which way the wall faces decides whether windows run along
             // world X or world Y.
             float u = abs(vWorldNormal.x) > abs(vWorldNormal.y) ? vWorld.y : vWorld.x;
             float storey = floor(vWorld.z / uStorey);
             float inStorey = fract(vWorld.z / uStorey);

             // Column grid at the district's pitch, and the district's share
             // of it glass — a curtain wall downtown, more wall than window
             // on a house, a high strip over blank brick on a shed.
             float col = floor(u / uColW);
             float inCol = fract(u / uColW);

             // How fast the pattern is moving across this pixel. On a wall seen
             // almost edge-on a storey is 24 world px and a window column 8, and
             // both fall under one screen pixel — the step() grid then samples
             // noise and the wall turns to scribble. Fading the pattern out as
             // its own features approach a pixel is the standard answer, and it
             // costs two derivatives.
             float fade = 1.0 - smoothstep(0.25, 0.5, max(fwidth(inCol), fwidth(inStorey)));

             float glassMask =
               step(uGlassBox.z, inStorey) * step(inStorey, uGlassBox.w) *
               step(uGlassBox.x, inCol) * step(inCol, uGlassBox.y);

             // A floor slab line between storeys reads as structure and is
             // what stops a tall building looking like one stretched decal.
             float slab = (1.0 - step(0.06, inStorey)) * fade;
             vec3 wall = diffuseColor.rgb * (1.0 - slab * 0.35);
             // A string course under each window line, where the district
             // lays one: a light band that says brick and sill rather than
             // render.
             float sill = step(0.86, inStorey) * step(inStorey, 0.92) * fade * uSill;
             wall = mix(wall, wall * 1.22, sill);

             // Salted per WALL PLANE, so the lit windows are that facade's own
             // pattern rather than one grid laid across the whole city. The
             // salt is the coordinate that is constant across the face — a
             // wall facing x lives on one x plane from end to end — where the
             // old floor(vWorld / 64) lattice cut straight through any wall
             // longer than four tiles: one unbroken facade changed its window
             // pattern abruptly mid-face at every 64-px world line, and two
             // buildings inside one cell shared an identical arrangement.
             // (Per-instance salt is no answer here: the city is instanced
             // per TILE, which would cut the pattern every sixteen pixels.)
             // The plane is as stable frame to frame as the wall itself, so a
             // lit window still stays lit.
             float plane = abs(vWorldNormal.x) > abs(vWorldNormal.y) ? vWorld.x : vWorld.y;
             float r = win_hash(vec2(col, storey) + floor(plane / 4.0) * 17.0);
             // More windows lit as it gets darker; never all of them.
             float on = step(1.0 - uNight * 0.55, r);
             vec3 pane = mix(uGlass, uLit, on * uNight);

             // The ground floor, the district's way.
             bool ground = vWorld.z < uStorey;
             if (ground) {
               if (uGround < 0.5) {
                 // Windows, as above.
               } else if (uGround < 1.5) {
                 // A shopfront: one tall opening, no mullions, a dark fascia
                 // over it for the sign.
                 glassMask = step(0.15, inStorey) * step(inStorey, 0.72) * step(0.08, inCol) * step(inCol, 0.92);
                 float fascia = step(0.78, inStorey) * step(inStorey, 0.95) * fade;
                 wall *= 1.0 - fascia * 0.3;
               } else if (uGround < 2.5) {
                 // A front door in one column of every five, the column
                 // chosen per wall; the rest keep their windows.
                 float doorCol = floor(win_hash(vec2(floor(plane / 4.0) * 3.0, 7.0)) * 5.0);
                 if (mod(col, 5.0) == doorCol) {
                   glassMask = step(0.32, inCol) * step(inCol, 0.68) * step(inStorey, 0.78);
                   pane = uDoor;
                 }
               } else {
                 // Roller doors two columns wide with a column of wall between,
                 // ribbed across; nothing else on a shed's ground floor.
                 float bay = mod(col, 3.0);
                 if (bay < 2.0) {
                   float inBay = (bay + inCol) / 2.0;
                   glassMask = step(0.06, inBay) * step(inBay, 0.94) * step(inStorey, 0.84);
                   float rib = 0.85 + 0.15 * step(0.5, fract(vWorld.z * 0.8));
                   pane = uDoor * 1.6 * rib;
                 } else {
                   glassMask = 0.0;
                 }
               }
             }

             diffuseColor.rgb = mix(wall, pane, glassMask * side * fade);
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

/** The night uniform of one facade material, if it has one. */
type NightUniform = { uNight: { value: number } };

/**
 * Every facade material under a group, found once.
 *
 * `setFacadeNight` used to walk the whole scene graph on every frame — every
 * city chunk, every outline twin, every entity and prop pool, hundreds of nodes
 * — to write one float into a handful of uniform objects. Chunking the city
 * multiplied the nodes it had to visit. The set only changes when the city is
 * rebuilt, so it is collected there instead.
 */
export function collectFacadeNight(root: THREE.Object3D): NightUniform[] {
  const out: NightUniform[] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (!m || seen.has(m)) return;
    seen.add(m);
    const u = (m as unknown as { userData?: { uniforms?: NightUniform } }).userData?.uniforms;
    if (u && u.uNight) out.push(u);
  });
  return out;
}

/** Update the night amount on a set collected by `collectFacadeNight`. */
export function setFacadeNight(mats: readonly NightUniform[], night: number): void {
  for (const u of mats) u.uNight.value = night;
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
           // GAME world coordinates: the world group is y-flipped into scene
           // space, and the marks below are no longer all symmetric about the
           // tile centre — an edge offset or a diagonal drawn in scene y
           // lands mirrored from where the 2D painter puts it.
           vec2 g = vec2(vWorld.x, -vWorld.y) / uTile;
           if (uMark > 7.5) {
             // Diagonal band centre line: 8 runs up-right, 9 down-right,
             // through the middle of the tile the shared rule named. Cadence
             // measured along the band in world px — the same phase the 2D
             // painter computes, so the two renderers dash in step.
             vec2 t = fract(g);
             float across = uMark < 8.5 ? abs(t.x + t.y - 1.0) : abs(t.x - t.y);
             float along = uMark < 8.5 ? (g.x - g.y) * 0.5 : (g.x + g.y) * 0.5;
             float dash = fract(along * 2.0 - 0.25);
             // 0.044 across the diagonal is the 1 px line width over sqrt(2).
             float line = (1.0 - step(0.044, across)) * (1.0 - step(0.5, dash));
             diffuseColor.rgb = mix(diffuseColor.rgb, uLine, line * 0.72);
           } else if (uMark > 5.5) {
             // Centre line at the tile's FAR edge: the even-width case, where
             // the true centre is the tile boundary and the painter keeps the
             // whole line inside the tile that owns it (laneDashOffset).
             float across = uMark < 6.5 ? abs(fract(g.y) - 0.96875) : abs(fract(g.x) - 0.96875);
             float along  = uMark < 6.5 ? fract(g.x * 2.0 - 0.25) : fract(g.y * 2.0 - 0.25);
             float line = (1.0 - step(0.03125, across)) * (1.0 - step(0.5, along));
             diffuseColor.rgb = mix(diffuseColor.rgb, uLine, line * 0.72);
           } else if (uMark > 4.5) {
             // Stunt ramp: chevrons, so it reads as "hit this fast". The 2D
             // painter draws three of them on the lot base; in 3D the tile was
             // bare lot colour and drawnSpans flattens it to street level, so a
             // ramp was pixel-for-pixel an industrial yard and frenzy.ts
             // launched the player off unmarked tarmac.
             vec2 t = fract(vWorld.xy / uTile);
             float v = abs(t.y - 0.5) * 2.0;
             float band = fract(t.x * 3.0 - v * 0.5);
             float chev = (1.0 - step(0.42, band)) * step(0.08, t.x) * step(t.x, 0.92);
             diffuseColor.rgb = mix(diffuseColor.rgb, uLine, chev * 0.75);
           } else if (uMark > 2.5) {
             // Crossing: stripes across the carriageway at a junction mouth.
             float bars = uMark < 3.5 ? fract(g.x * 4.0) : fract(g.y * 4.0);
             float band = uMark < 3.5 ? abs(fract(g.y) - 0.5) : abs(fract(g.x) - 0.5);
             float zebra = (1.0 - step(0.5, bars)) * (1.0 - step(0.42, band));
             diffuseColor.rgb = mix(diffuseColor.rgb, uCrossing, zebra * 0.8);
           } else if (uMark > 0.5) {
             // Across the lane: how far from the tile centre, 0 at the middle.
             float across = uMark < 1.5 ? abs(fract(g.y) - 0.5) : abs(fract(g.x) - 0.5);
             // Along the lane: the dash cadence — two dashes per tile at 50%
             // duty starting an eighth of a tile in, which is what tiles.ts
             // paints. The old fract(t * 1.5) was a different period AND a
             // different duty, so the fallback dashes never lined up with the
             // painted ground that replaced them.
             float along  = uMark < 1.5 ? fract(g.x * 2.0 - 0.25) : fract(g.y * 2.0 - 0.25);
             // Half-width 0.031 of a 16 px tile is a 1 px line, which is what
             // tiles.ts paints. 0.075 was 2.4 px — nearly two and a half
             // times the 2D line, on every road in the city.
             float line = (1.0 - step(0.031, across)) * (1.0 - step(0.5, along));
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
