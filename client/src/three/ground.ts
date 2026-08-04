import * as THREE from 'three';
import { TILE_SIZE, type CityMap } from 'shared';
import { CHUNK_TILES } from '../render/config.js';
import type { TileLayer } from '../render/tiles.js';
import { toonGradient } from './toon.js';

/**
 * The ground, painted rather than coloured.
 *
 * `cityGeometry` builds the world from instanced boxes carrying one flat
 * colour per surface type — fourteen colours for an entire city. `TileLayer`,
 * next door, has always painted the same ground from forty-odd palette entries
 * with grain, resurfacing patches, manholes, kerb shading, paving joints and a
 * per-district pavement tint. At a near-overhead camera the ground is roughly
 * ninety per cent of the frame, so one flat value per surface across all of it
 * is most of the reason the 3D city reads as a model.
 *
 * This lays that painting over the boxes: one textured quad per 8×8-tile chunk,
 * from `TileLayer.groundChunk`. No new art, and a divergence removed rather
 * than a second pipeline started.
 *
 * **Why over the boxes rather than instead of them.** The boxes are not only
 * colour: a ground column is a slab running down to −16, and its sides are what
 * you see at the water's edge, at a bridge and at the map border. Replacing
 * them with flat quads would lose all of that. The quads sit a hair above z=0,
 * high enough to win the depth test against the slab tops and far enough below
 * a kerb or a body to be under everything that stands on the street.
 *
 * Water is transparent in the source canvas, so the river keeps the depth and
 * the shoreline its geometry gives it. Building footprints are painted rather
 * than punched out: a building hides its own footprint anyway, and filling it
 * lets most chunks stay opaque.
 */

/** World px across one chunk. */
const CHUNK_WORLD = CHUNK_TILES * TILE_SIZE;

/**
 * How far above the slab tops the painting sits, in world px.
 *
 * Enough to beat the depth test at any distance the camera reaches, small
 * enough that a kerb, a body or a decal is still unambiguously above it.
 * Decals sit at 0.35, so this has to stay well under that.
 */
const LIFT = 0.06;

/**
 * How many chunk textures to keep resident.
 *
 * Each is 256×256 RGBA plus mipmaps — a little over a third of a megabyte. The
 * frame is at most 700×400 world px, which is about 35 chunks, and building one
 * costs a full paint of 64 tiles. This holds roughly two screens' worth so
 * ordinary driving never repaints, and evicts the least recently seen beyond
 * that rather than growing to the 900 chunks a 240×240 map would need.
 */
const MAX_RESIDENT = 96;

/** How many chunks outside the view to keep painted, so driving does not pop. */
const MARGIN_CHUNKS = 1;

/** How many chunks may be painted in one frame. A paint is 64 tiles of canvas. */
const BUILDS_PER_FRAME = 2;

/**
 * Undo three.js's upload flip, because the world group already flipped.
 *
 * A `CanvasTexture` uploads with `flipY = true`: WebGL's texture origin is the
 * BOTTOM-left and a canvas's is the top-left, so three.js turns the image over
 * on the way to the GPU and `v = 0` lands on the canvas's LAST row. A plane's
 * own UVs put `v = 0` on its `-y` edge, so out of the box a quad shows the
 * canvas the right way up in a y-UP scene.
 *
 * This scene is not y-up. `CityView` scales the world group by −1 in y so that
 * the game's y-DOWN coordinates land where the radar says they are, and that
 * mirror is applied to the quad's geometry, not to its texture — so the
 * painting arrived mirrored north-for-south inside every chunk. `groundChunk`
 * paints row `ty0` at canvas y = 0, and it was being shown at the chunk's
 * SOUTH edge.
 *
 * What that looked like: the building footprints, which the painter fills with
 * `wallShade` because a building normally covers them, were drawn out in the
 * open as near-black rectangles a couple of tiles off their block; the
 * carriageway, its lane lines and its crossings were painted across the block
 * interiors so buildings stood in the middle of a road; and the water cutout —
 * the same flip, in the mask that punches the river through the ground plane —
 * put the hole on the mirror image of the coast, so the sea showed through dry
 * land and the ground plane floated over open water.
 *
 * One flag per texture, and the mirror cancels. Nothing else on these quads
 * cares which way the image went up.
 *
 * Exported, with `chunkQuad` below, so the orientation can be held to its
 * contract without a GPU: a mirrored city is a plausible-looking city, which
 * is exactly why this shipped and why it gets a test.
 */
export function flipForWorld(texture: THREE.Texture): void {
  texture.flipY = false;
}

/**
 * The quad one painted chunk is shown on: `CHUNK_WORLD` square, in the plane.
 *
 * A function rather than a constant because the layer shares ONE geometry
 * across every chunk and the test needs its own; what matters to both is that
 * the UVs come from the same construction.
 */
export function chunkQuad(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(CHUNK_WORLD, CHUNK_WORLD);
}

interface Tile {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  surface: THREE.Texture;
  cut: THREE.Texture;
  /** Frame counter when this was last inside the view, for eviction. */
  seen: number;
}

/**
 * Rain, after the fact.
 *
 * `wetness()` in the shared clock says how much water is on the street; this
 * is what the street does about it. Three things, in the order they read:
 *
 * 1. **It goes dark.** A water film traps most of the light that would have
 *    scattered back out of the tarmac, and the drop is large — a wet road is
 *    close to half the albedo of a dry one. This is the part that carries at
 *    any distance and in any light.
 * 2. **It picks up the sky.** A flat wet surface is a weak mirror pointed
 *    straight up, and a top-down camera is looking down the reflected ray, so
 *    the sky lands square in the middle of the frame. That is what stops the
 *    darkening reading as a dirty road.
 * 3. **It holds the lamps.** The reflection that sells rain is a sodium lamp
 *    smeared across the carriageway. This does the cheap version of it —
 *    where a light already lands, it lands much harder and keeps its colour.
 *
 * Where the water sits is a noise field rather than the drainage the map does
 * not model, so puddles are patches rather than gutters. Between them the
 * surface is damp, which is a third of the effect at full strength.
 *
 * The layer this runs on is the only one that gets it. The road boxes
 * underneath stay dry, and are only visible off the edge of the painted
 * chunks — that is, off screen. Cars and people stay dry too, which is a
 * bigger omission and a much bigger job.
 */

/** How much of its albedo a fully wet surface keeps. */
const WET_ALBEDO = 0.54;
/** How much of a full puddle's surface is sky rather than what is under it. */
const WET_SKY = 0.3;
/**
 * The sky, as a wet road reflects it — and note how dark these are.
 *
 * This is mixed into the **albedo**, so it is a reflectance and not a
 * radiance: the fraction of what lands on a puddle that comes straight back
 * up. For water at the near-normal incidence a top-down camera works at, that
 * is about three per cent, and the first pass of this had it at ten times
 * more. Tarmac's own albedo is only four per cent, so an overcast-grey sky
 * mixed in at face value made a wet road *brighter* than a dry one, which is
 * the opposite of the one thing everybody knows about wet roads.
 *
 * The point of it is the hue, not the level. A puddle is a hole in the road
 * with the sky at the bottom, and going cold is how that reads.
 */
const SKY_DAY = new THREE.Color(0.030, 0.037, 0.052);
const SKY_NIGHT = new THREE.Color(0.005, 0.007, 0.013);
/**
 * The irradiance a light has to beat before it flares — and it moves.
 *
 * The bar has to sit above the sun, or the sun itself glints and the whole
 * street turns to chrome at midday. But the sun is not a fixed number: it runs
 * 2.95 down to 0.21 between noon and midnight, which is 0.94 down to 0.05 once
 * the toon term's `1/π` is taken out. A single bar tall enough for noon is
 * twenty times higher than anything at midnight can reach, and the first cut
 * of this had exactly that — a wet road at night with no reflections on it at
 * all, which is the one time of day the effect is for.
 *
 * So it tracks the sun down. At noon only a source bright enough to beat
 * daylight registers; after dark, a street lamp comfortably clears it.
 */
const KNEE_DAY = 1.15;
const KNEE_NIGHT = 0.3;
/** How wide the ramp from "no reflection" to "full reflection" is. */
const KNEE_RAMP = 0.5;
/**
 * What fraction of the light it catches a wet surface throws back.
 *
 * Small, and much smaller by day. This adds to a pool that is already near the
 * top of the range, so the useful setting is the one that roughly doubles the
 * brightest part of a lamp's pool and does nothing at its edge.
 */
const GLOSS_DAY = 0.06;
const GLOSS_NIGHT = 0.45;

export class GroundLayer {
  private readonly group = new THREE.Group();
  private readonly tiles = new Map<number, Tile>();
  private readonly geometry: THREE.PlaneGeometry;
  private map: CityMap | null = null;
  private frame = 0;

  /**
   * Shared by every chunk material, by reference.
   *
   * `onBeforeCompile` copies the uniform *objects* into each shader, so
   * setting `.value` here reaches all of them at once and the weather never
   * arrives on one chunk a frame behind another.
   */
  private readonly weather = {
    uWet: { value: 0 },
    uGloss: { value: GLOSS_DAY },
    uKnee: { value: KNEE_DAY },
    uSky: { value: SKY_DAY.clone() },
  };

  constructor(
    scene: THREE.Object3D,
    private readonly painter: TileLayer,
  ) {
    // One plane, shared by every chunk; only the transform and the map differ.
    this.geometry = chunkQuad();
    scene.add(this.group);
  }

  setMap(map: CityMap): void {
    this.map = map;
    this.clear();
  }

  /**
   * Paint what is in view, drop what has not been for a while.
   *
   * `cam` is the top-left of the view in world px, as the 2D renderer means it.
   */
  update(cam: { x: number; y: number }, view: { w: number; h: number }): void {
    const map = this.map;
    if (!map) return;
    this.frame++;

    const cw = map.widthTiles / CHUNK_TILES;
    const ch = map.heightTiles / CHUNK_TILES;
    const cx0 = Math.floor(cam.x / CHUNK_WORLD) - MARGIN_CHUNKS;
    const cy0 = Math.floor(cam.y / CHUNK_WORLD) - MARGIN_CHUNKS;
    const cx1 = Math.floor((cam.x + view.w) / CHUNK_WORLD) + MARGIN_CHUNKS;
    const cy1 = Math.floor((cam.y + view.h) / CHUNK_WORLD) + MARGIN_CHUNKS;

    let built = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
        const key = cy * 4096 + cx;
        const hit = this.tiles.get(key);
        if (hit) {
          hit.seen = this.frame;
          continue;
        }
        // Budgeted: a paint is 64 tiles of canvas work and doing a screenful in
        // one frame is a visible hitch. Anything not reached this frame is
        // reached on the next, which is why the margin exists.
        if (built >= BUILDS_PER_FRAME) continue;
        built++;
        this.tiles.set(key, this.build(cx, cy));
      }
    }

    if (this.tiles.size > MAX_RESIDENT) this.evict();
  }

  private build(cx: number, cy: number): Tile {
    const { canvas, holes, surface: surfaceCanvas, cut } = this.painter.groundChunk(cx, cy);
    const texture = new THREE.CanvasTexture(canvas);
    // The canvas is authored in sRGB; without this it is treated as linear and
    // every painted surface comes out washed out against the boxes beneath.
    texture.colorSpace = THREE.SRGBColorSpace;
    flipForWorld(texture);
    // Pixel art, sampled as pixel art. The default linear magnification plus a
    // mipmap chain smeared every 1-px lane line and paving joint across two
    // screen pixels — crawling as the camera moved — and gave each chunk its
    // own mip pyramid whose clamped edge texels opened a faint seam grid at
    // the chunk pitch. The surface mask below always knew to ask for nearest;
    // the painting itself is what everyone is looking at. Minification keeps a
    // plain linear filter (the camera can pull back a little when the window
    // is tall), which needs no mipmaps.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = 1;
    texture.needsUpdate = true;

    // One texel per tile, and a number rather than a colour: no filtering, no
    // colour space. A blurred edge here would put a wet fringe on the grass.
    const surface = new THREE.CanvasTexture(surfaceCanvas);
    flipForWorld(surface);
    surface.magFilter = THREE.NearestFilter;
    surface.minFilter = THREE.NearestFilter;
    surface.generateMipmaps = false;
    surface.needsUpdate = true;

    // The water cutout — same discipline as the surface mask. See
    // `GroundChunk.cut` for why the hole lives in its own mask rather than in
    // the painting's alpha channel.
    const cutTex = new THREE.CanvasTexture(cut);
    flipForWorld(cutTex);
    cutTex.magFilter = THREE.NearestFilter;
    cutTex.minFilter = THREE.NearestFilter;
    cutTex.generateMipmaps = false;
    cutTex.needsUpdate = true;

    const material = new THREE.MeshToonMaterial({
      map: texture,
      gradientMap: toonGradient(),
      // Only chunks with water in them carry a hole, and most do not. An
      // alpha test costs early-z for every pixel of the frame's largest
      // surface, so it is worth asking rather than assuming.
      //
      // A cutout, not a blend: the river wants the depth its own geometry has,
      // and leaving `transparent` off keeps these quads in the opaque pass
      // where they can occlude rather than queue up behind it.
      alphaMap: holes ? cutTex : null,
      alphaTest: holes ? 0.5 : 0,
    });
    this.makeWet(material, surface);

    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.receiveShadow = true;
    mesh.position.set((cx + 0.5) * CHUNK_WORLD, (cy + 0.5) * CHUNK_WORLD, LIFT);
    this.group.add(mesh);
    return { mesh, texture, surface, cut: cutTex, seen: this.frame };
  }

  /** Hang the rain onto a chunk's material. See the note above `WET_ALBEDO`. */
  private makeWet(material: THREE.MeshToonMaterial, surface: THREE.Texture): void {
    const own = { uSurface: { value: surface } };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, own, this.weather);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n varying vec3 vWetW;`)
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vWetW = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vWetW;
           uniform sampler2D uSurface;
           uniform float uWet;
           uniform float uGloss;
           uniform float uKnee;
           uniform vec3 uSky;
           float wet_hash(vec2 p) { return fract(sin(dot(p, vec2(73.1, 41.7))) * 19733.13); }
           float wet_noise(vec2 p) {
             vec2 i = floor(p);
             vec2 f = fract(p);
             f = f * f * (3.0 - 2.0 * f);
             return mix(mix(wet_hash(i), wet_hash(i + vec2(1.0, 0.0)), f.x),
                        mix(wet_hash(i + vec2(0.0, 1.0)), wet_hash(i + vec2(1.0, 1.0)), f.x),
                        f.y);
           }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           // Water sits where the surface lets it and where the ground dips.
           // The map has no drainage, so the second half is noise: broad
           // patches with a finer edge, near enough to how a road holds rain.
           float wetSheen = texture2D(uSurface, vMapUv).r;
           float wetShape = wet_noise(vWetW.xy / 34.0) * 0.68
                          + wet_noise(vWetW.xy / 11.0) * 0.32;
           float wetPool = smoothstep(0.42, 0.72, wetShape);
           float wetFilm = uWet * wetSheen;
           float wetSheet = wetFilm * (0.34 + 0.66 * wetPool);
           diffuseColor.rgb *= mix(1.0, ${WET_ALBEDO.toFixed(3)}, wetSheet);
           diffuseColor.rgb = mix(diffuseColor.rgb, uSky, wetSheet * wetPool * ${WET_SKY.toFixed(3)});`,
        )
        .replace(
          '#include <opaque_fragment>',
          `// The lamps, reflected. Divide the albedo back out of the toon term
           // to recover what actually arrived, so darkening a wet road does
           // not also dim the light it is supposed to be mirroring.
           vec3 wetIrr = reflectedLight.directDiffuse / max(diffuseColor.rgb, vec3(0.03));
           float wetLit = max(max(wetIrr.r, wetIrr.g), wetIrr.b);
           float wetFlare = smoothstep(uKnee, uKnee + ${KNEE_RAMP.toFixed(2)}, wetLit);
           outgoingLight += wetIrr * wetFlare * wetFlare * wetSheet * uGloss;
           #include <opaque_fragment>`,
        );
    };
    // Every chunk compiles to the same program; only the maps differ.
    material.customProgramCacheKey = () => 'ground-wet';
  }

  /**
   * How wet the streets are and how dark it is, both 0 to 1.
   *
   * Night is not a second weather channel — it only decides what the water is
   * reflecting: a pale sky by day, the street lamps after dark.
   */
  setWeather(wet: number, night: number): void {
    const t = Math.min(1, Math.max(0, night));
    this.weather.uWet.value = Math.min(1, Math.max(0, wet));
    this.weather.uGloss.value = GLOSS_DAY + (GLOSS_NIGHT - GLOSS_DAY) * t;
    this.weather.uKnee.value = KNEE_DAY + (KNEE_NIGHT - KNEE_DAY) * t;
    this.weather.uSky.value.copy(SKY_DAY).lerp(SKY_NIGHT, t);
  }

  /** Drop the least recently seen chunks back to the cap. */
  private evict(): void {
    const byAge = [...this.tiles.entries()].sort((a, b) => a[1].seen - b[1].seen);
    for (const [key, tile] of byAge) {
      if (this.tiles.size <= MAX_RESIDENT) break;
      this.dispose(tile);
      this.tiles.delete(key);
    }
  }

  private dispose(tile: Tile): void {
    this.group.remove(tile.mesh);
    tile.texture.dispose();
    tile.surface.dispose();
    tile.cut.dispose();
    (tile.mesh.material as THREE.Material).dispose();
  }

  private clear(): void {
    for (const tile of this.tiles.values()) this.dispose(tile);
    this.tiles.clear();
  }

  /** Give everything back — the geometry too, which the chunks share. */
  disposeAll(): void {
    this.clear();
    this.geometry.dispose();
    this.group.removeFromParent();
  }

  /** Resident chunk count, for the debug overlay. */
  get resident(): number {
    return this.tiles.size;
  }
}
