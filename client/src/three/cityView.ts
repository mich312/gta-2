import * as THREE from 'three';
import { type CityMap } from 'shared';
import palette from 'shared/data/palette.json';
import { GRADE_DAY, GRADE_NIGHT } from '../render/config.js';
import { buildCity, disposeCity } from './cityGeometry.js';
import { collectFacadeNight, setFacadeNight } from './facade.js';
import { PostChain } from './post.js';

/**
 * The renderer, the camera and the lights — the frame the city is drawn in.
 *
 * The city itself is `cityGeometry.ts`, which this holds one of and replaces
 * whole whenever the map changes underneath it. That split exists because the
 * map DOES change: with ROAM on the session recentres its window and
 * regenerates the world, and a view that could only be built once went on
 * drawing the region the player had left.
 */

/**
 * Vertical field of view.
 *
 * This one number is the whole look. Narrow is nearly orthographic and the
 * city flattens to a floorplan; wide splays the edges hard and the buildings
 * at the frame's corners lie down. GTA 1 and 2 sit somewhere near here — far
 * enough to show the sides of buildings a block away, tight enough that what
 * is under you still reads as directly under you.
 */
const FOV_Y = 34;

export interface CityViewOptions {
  canvas: HTMLCanvasElement;
  map: CityMap;
  /** Camera pitch in degrees from straight down. 0 is the old top-down view. */
  pitch: number;
  /** How many world px the view is high. */
  viewHeight: number;
  /** Full-screen passes. Off leaves the renderer drawing straight to canvas. */
  post?: boolean;
}

function hex(s: string): number {
  return parseInt(s.replace('#', ''), 16);
}

/**
 * World space (the game's, y-DOWN) -> scene space (three.js's, y-UP).
 *
 * Applied once, as the scale of `CityView.world`, so everything inside that
 * group is placed in the coordinates the sim, the 2D renderer, the HUD and the
 * radar all use. Exported so the orientation can be tested without a GPU: see
 * `client/test/cityOrientation.test.ts`.
 */
export const WORLD_TO_SCENE = Object.freeze({ x: 1, y: -1, z: 1 });

/**
 * Where the sun sits, relative to what the camera is looking at, in world px.
 *
 * Up, and back along the direction the 2D renderer throws its shadows
 * (`SUN_X`, `SUN_Y` in `render/config.ts`), so a building's shadow falls the
 * same way whichever renderer drew it. It is a fixed offset rather than a fixed
 * place because the shadow map is only 1024 px square: rigged to the camera it
 * covers what is on screen, and pinned to a corner of a 240×240 city it would
 * be a few texels per building.
 */
export const SUN_OFFSET = Object.freeze({ x: -420, y: -620, z: 900 });

/**
 * What the sun, the ambient and the sky are worth at midday and at midnight.
 *
 * **Midday is calibrated against the palette, not chosen by eye.** Both
 * renderers colour the world out of `shared/data/palette.json`, and the 2D one
 * paints those values almost neat: its own day grade is (252, 246, 232) — a
 * multiply by 0.98 — so at noon a road is very nearly `palette.road`. The 3D
 * one lights them, and was lighting them to about 1.17× in sRGB, so the same
 * street was a fifth brighter here than in the view next door. Switching
 * renderers changed the hour, which is a thing a renderer must not do.
 *
 * These numbers put a flat, sun-facing surface back on its palette colour. The
 * night end is untouched from where it was tuned: night has to actually be
 * dark or a street lamp cannot read against it, and that is the whole point of
 * having lamps.
 *
 * The split between them matters as much as the total. The sun is the only
 * term that is banded — ambient and hemisphere are flat fill by definition —
 * so when fill outweighs key, the quantisation it is all built for lands on a
 * few percent of the final pixel and the city reads as flat colour. The old
 * numbers had 3.02 of fill against 2.18 of key, which measured as a 5% step
 * across the terminator. These keep the lit level where it was calibrated and
 * put the contrast back into the banded term.
 */
const DAYLIGHT = Object.freeze({ sun: 2.95, ambient: 1.18, hemi: 0.62 });

/**
 * Half-extent of the sun's shadow camera, in world px.
 *
 * Shared by the rig and by `lookAt`, which needs it to work out how big a
 * shadow texel is before it can snap the camera to one.
 */
export const SHADOW_HALF_EXTENT = 460;

/** Sun and sky colours at each end of the day, for the night grade. */
const SUN_DAY = new THREE.Color(0xffeccd);
const SUN_NIGHT = new THREE.Color(0x9fb4d8);
const HEMI_SKY_DAY = new THREE.Color(0xa8cbe6);
const HEMI_SKY_NIGHT = new THREE.Color(0x2a3a58);
const HEMI_GROUND_DAY = new THREE.Color(0x3a3d33);
const HEMI_GROUND_NIGHT = new THREE.Color(0x181c26);
const MOONLIGHT = Object.freeze({ sun: 0.21, ambient: 0.4, hemi: 0.39 });
/** The ambient grade endpoints, as colours, built once rather than per frame. */
const AMBIENT_DAY = new THREE.Color(GRADE_DAY.r / 255, GRADE_DAY.g / 255, GRADE_DAY.b / 255);
const AMBIENT_NIGHT = new THREE.Color(
  GRADE_NIGHT.r / 255,
  GRADE_NIGHT.g / 255,
  GRADE_NIGHT.b / 255,
);
const SKY_DAY = new THREE.Color(0x9fc4dd);
/** The map's own size in world px, for the backdrop that outlives it. */
const MAP_PX = 768 * 16;
/**
 * How far below sea level the backdrop sits, in world px.
 *
 * Under the shore prisms and the water slabs so it never z-fights them, and
 * shallow enough that it is still the sea rather than a hole: what shows of
 * it is only ever the part beyond the map.
 */
const OCEAN_DROP = 2;
const SKY_NIGHT = new THREE.Color(0x0a1020);

/**
 * The shadow camera's own right/up axes, in SCENE space, built once.
 *
 * Texel snapping has to happen in this basis: the shadow map's texel grid is
 * aligned to the light's view plane, which for this sun is rotated ~34° in
 * plan and foreshortened ~1.25× by its tilt. Rounding the target in world XY
 * — the previous version — snapped to a grid the shadow map does not use, so
 * edges still crawled sub-texel while driving. The axes come from the same
 * lookAt construction three.js uses for the shadow camera: z along
 * position−target, x = up₀ × z, y = z × x, with the world group's y-flip
 * folded in (a game offset (dx, dy, dz) is (dx, −dy, dz) in scene space).
 */
const SHADOW_BASIS = (() => {
  const z = new THREE.Vector3(SUN_OFFSET.x, -SUN_OFFSET.y, SUN_OFFSET.z).normalize();
  const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return { x, y };
})();
/** Scratch for the snap, so `lookAt` allocates nothing per frame. */
const SNAP_SCRATCH = new THREE.Vector3();

/** Where the camera sits and what it points at, both in SCENE space. */
export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

/**
 * Place the camera over a world position.
 *
 * `pitch` is degrees off straight down, and 0 — the GTA default — is the
 * interesting case: the camera hangs directly over the player, and the only
 * thing tilting buildings is the perspective divide. A few degrees of tilt is
 * available because it helps a low-set camera see a little more of the street
 * ahead, but it is not what makes the effect.
 *
 * Pure, and separate from the class, because it is half of the answer to
 * "which way up is the city" and the other half is `WORLD_TO_SCENE`. Both are
 * cheap to get subtly wrong and expensive to notice.
 */
export function cameraPose(x: number, y: number, pitchDeg: number, height: number): CameraPose {
  const rad = (pitchDeg * Math.PI) / 180;
  // The camera lives on the far side of the world group's flip, so the point
  // it looks at is the mirror of the world one.
  const sy = y * WORLD_TO_SCENE.y;
  return {
    // Pitch pulls the camera towards the bottom of the frame — screen-down is
    // -Y in scene space, whichever way the world runs — so a tilted view sees
    // further up the street ahead rather than behind.
    position: new THREE.Vector3(x, sy - Math.sin(rad) * height, Math.cos(rad) * height),
    target: new THREE.Vector3(x, sy, 0),
    up: new THREE.Vector3(0, 1, 0),
  };
}

export class CityView {
  readonly scene = new THREE.Scene();
  /**
   * Everything expressed in GAME world coordinates hangs off this.
   *
   * The game's world is y-DOWN: `y` grows southwards, which is what the sim,
   * the 2D renderer, the HUD and the radar all mean by it. three.js draws a
   * y-UP scene — with the camera overhead and `up` at +Y, world +y would come
   * out at the TOP of the frame. Placed straight in, the whole city rendered
   * mirrored north-for-south: the park the radar put above you was drawn below
   * you, driving south moved you up the screen, and the sun threw its shadows
   * the opposite way from `SUN_Y`.
   *
   * One flip here fixes all of it at once, and keeps every call site in the
   * coordinates the rest of the game uses: a mesh, an entity or a light goes in
   * at its world (x, y) and lands where the radar says it is. Rotations come
   * out right for free — a heading measured clockwise in a y-down frame is
   * counter-clockwise in the mirrored one, which is exactly what the reflection
   * does to it.
   *
   * three.js handles the mirror the rest of the way itself: a negative
   * determinant on an object's world matrix flips the winding it culls by, and
   * the normal matrix reflects normals along with the surface, so the toon
   * shading, the inverted-hull outlines and the shadow map all keep working.
   */
  readonly world = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  /** The city geometry currently in the scene. Replaced whole on a rebase. */
  private city: THREE.Group | null = null;
  private readonly pitch: number;
  private viewHeight: number;

  /** Where the camera is looking, in world px. */
  target = new THREE.Vector2(0, 0);

  constructor(opts: CityViewOptions) {
    this.pitch = opts.pitch;
    this.viewHeight = opts.viewHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true });
    // One backing pixel per pixel asked for, deliberately.
    //
    // `setPixelRatio` multiplies whatever `setSize` is given, so a ratio of 2
    // made `canvas.width` twice the size the caller requested. `main.ts` then
    // compared `worldCanvas.width` against the size it had asked for, never
    // saw them agree, and called `setSize` again on every single frame — and
    // writing `canvas.width` makes the browser throw away and rebuild the
    // colour, depth and multisample buffers. A HiDPI display was paying for
    // four times the fill rate and a full framebuffer reallocation per frame.
    //
    // The 2D renderer draws the world at half resolution (`RENDER_SCALE`) and
    // upscales; matching that here keeps the two views consistent as well as
    // cheap.
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // ACES filmic instead of the linear default: it rolls off the highlights
    // so a sunlit roof stops clipping to flat white, and it deepens the
    // shadows without crushing them. Cel shading gives hard bands; this is
    // what stops those bands reading as posterisation.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    // Count the whole frame, not its last pass.
    //
    // `WebGLRenderer.render` zeroes `info.render` at its own top, and the post
    // chain drives every pass through `render` — so what `stats()` read was
    // whatever the final pass did on its own: the grade's fullscreen triangle,
    // printing as `draws 1  tris 0k` on a city of 762k. Take the reset over
    // ourselves and do it once, at the top of `render()`, so the counters span
    // scene, shadow map and post and are still *this* frame's rather than a
    // total since the page loaded.
    this.renderer.info.autoReset = false;

    // Sky, not field. This was `palette.field` — a leftover from before there
    // was a sky at all — and although `setNight` overwrites it on the first
    // frame, the value here is what any path that renders before that shows.
    // A city whose horizon is grass is the §23.3 "green void" (§32).
    this.scene.background = SKY_DAY.clone();

    // World space -> scene space. See the note on `world`.
    this.world.scale.set(WORLD_TO_SCENE.x, WORLD_TO_SCENE.y, WORLD_TO_SCENE.z);
    this.scene.add(this.world);

    // The open sea, past the edge of the map (§32).
    //
    // The city is 768 tiles of ground and then nothing: stand on the north
    // beach and the water stopped dead on the straight line x = 768, with the
    // background behind it. The plan keeps a margin of open sea round the
    // whole map precisely so the edge is never reachable, and this is the
    // other half of that promise — the sea runs to the horizon, so the margin
    // reads as ocean rather than as the end of the world.
    //
    // Twenty times the map, one plane, no lighting: it is the backdrop, and
    // anything that shades it would make the seam it exists to hide.
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // DoubleSide: `world` is scaled (1, -1, 1) to put the city the right
      // way up, which flips every face's winding — a single-sided plane comes
      // out facing away from the camera and is culled, leaving exactly the
      // void this exists to fill.
      new THREE.MeshBasicMaterial({
        color: hex(palette.water ?? '#1a3749'),
        side: THREE.DoubleSide,
      }),
    );
    ocean.scale.set(MAP_PX * 20, MAP_PX * 20, 1);
    ocean.position.set(MAP_PX / 2, MAP_PX / 2, -OCEAN_DROP);
    ocean.renderOrder = -1;
    this.world.add(ocean);

    // PERSPECTIVE, looking straight down. This is the original GTA camera and
    // the earlier orthographic one was wrong for it.
    //
    // Under ortho every building is drawn as if seen from directly above, so
    // you only ever see roofs and the city reads as a floorplan. Under
    // perspective a building away from the screen centre splays outward and
    // shows the face turned towards the camera — you see the north side of
    // buildings north of you and the south side of those south of you. That
    // splay IS the look, and it is the same effect the 2D renderer fakes by
    // hand in `extrude.ts` for exactly this reason.
    //
    // The camera sits directly over the player at whatever height makes the
    // requested world span fill the frame, so `viewHeight` still means what
    // it meant under ortho.
    this.camera = new THREE.PerspectiveCamera(FOV_Y, 1, 8, 6000);
    if (opts.post !== false) {
      this.post = new PostChain(
        this.renderer,
        this.scene,
        this.camera,
        opts.canvas.width,
        opts.canvas.height,
      );
    }
    this.resize(opts.canvas.width, opts.canvas.height);

    this.buildLights();
    this.setMap(opts.map);
  }

  /**
   * Adopt a city — the first one, or a replacement.
   *
   * It is a replacement more often than it sounds. With ROAM on, the session
   * recentres its window whenever a player nears the edge and regenerates the
   * whole map at the new origin; the tile layer and the radar were told and
   * this was not, so the 3D world went on drawing the *previous* region for
   * the rest of the session. The terrain stopped matching the radar, buildings
   * from the old window stood in the middle of the new one's streets — walls
   * where the map said there was road — and the disagreement arrived all at
   * once, at the moment a new region was generated.
   *
   * The old city is disposed rather than merely detached: a session that
   * crosses a few regions would otherwise leave a whole city's buffers on the
   * GPU each time.
   *
   * It is disposed *after* the replacement is built, which is not fussiness.
   * three.js reference-counts compiled programs by how many materials use
   * them, so disposing first drops every count to zero, deletes the four
   * programs, and then the identical materials built a line later have to
   * compile and link them all over again — a stall added to the one frame that
   * could least afford it. Building first keeps each count above zero across
   * the handover and no recompile happens.
   */
  setMap(map: CityMap): void {
    const previous = this.city;
    const built = buildCity(map);
    if (previous) disposeCity(previous);
    this.city = built.group;
    this.instanceCount = built.instances;
    this.world.add(this.city);
    // The new facades are built at midday whatever time it is, so hand them
    // back the hour. `main.ts` sets this every frame and would fix it anyway;
    // `city3d.html` and `live.ts` set it once and would not.
    this.facadeNight = collectFacadeNight(this.scene);
    // `night` is -1 until the first `setNight`; the facades want a real hour.
    setFacadeNight(this.facadeNight, Math.max(0, this.night));
  }

  private buildLights(): void {
    // One sun with a shadow map, replacing 761 lines of Canvas compositing.
    const sun = new THREE.DirectionalLight(0xffeccd, DAYLIGHT.sun);
    sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    // Half-extent of the shadow camera, in world px.
    //
    // This was 900, which is 1800 px of map across 1024 texels — 1.76 world px
    // per texel — for a frame that is at most 700×400 (`viewport.ts`). Over
    // nine tenths of the map was spent on world nobody could see. 460 covers
    // the visible frame with room for the shadows thrown into it from just
    // outside, at nearly 4× the texel density.
    const d = SHADOW_HALF_EXTENT;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 4000;
    // Without a bias a surface shadows itself: the depth it compares against
    // is its own, quantised to a texel, so half of every lit roof and wall
    // came out in dashed diagonal stripes at noon. `normalBias` pushes the
    // lookup along the surface normal, which is what fixes acne on the large
    // flat faces this city is made of; the constant bias mops up the rest.
    sun.shadow.normalBias = 1.5;
    sun.shadow.bias = -0.0005;
    // Penumbra width, in shadow-map texels.
    //
    // `PCFShadowMap` samples a Vogel disk whose spread is this radius, and it
    // has been sitting at the default 1 — a hard edge, which on a city of
    // boxes reads as cut paper. Note that switching the map type to
    // `PCFSoftShadowMap` would make it *harder*, not softer: in three r185
    // that type has no shader define of its own and falls through to the
    // single-tap basic path. The softness is this number.
    sun.shadow.radius = 3.5;
    // In the world group, so the sun is rigged in world coordinates like
    // everything else: `SUN_OFFSET` is the direction `SUN_X`/`SUN_Y` throw the
    // 2D renderer's walls and drop shadows, and the two views now agree on
    // which way a building's shadow falls.
    this.world.add(sun);
    this.world.add(sun.target);
    this.sun = sun;

    // Ambient has no direction, so it stays in scene space; the hemisphere
    // does have one and it has to be the world's.
    //
    // A `HemisphereLight` mixes ground colour into sky colour by the surface
    // normal along its own axis, and left at its default position that axis is
    // scene +Y. This is a Z-up world: buildings extrude in z, the camera sits
    // on +z. So roofs and roads — the surfaces most of the frame is made of —
    // were taking the exact 50/50 blend of sky and ground instead of the sky
    // they face, while north-facing walls got a blue wash and south-facing
    // walls an olive one, for a light that does not exist.
    this.ambient = new THREE.AmbientLight(0x8493ad, DAYLIGHT.ambient);
    this.hemi = new THREE.HemisphereLight(0xa8cbe6, 0x3a3d33, DAYLIGHT.hemi);
    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.ambient);
    this.scene.add(this.hemi);
  }

  private sun!: THREE.DirectionalLight;
  private ambient!: THREE.AmbientLight;
  private hemi!: THREE.HemisphereLight;
  private instanceCount = 0;
  /**
   * The applied hour, `-1` until `setNight` first runs so the first call
   * always applies — the constructor leaves the background at the field
   * colour, and an early-out at a genuine midday 0 would keep it there.
   */
  private night = -1;
  /** The grade, the bloom and the vignette. Null when `?post=off`. */
  private post: PostChain | null = null;
  /** Facade night uniforms, refreshed when the city is rebuilt. */
  private facadeNight: ReturnType<typeof collectFacadeNight> = [];

  /**
   * 0 midday, 1 midnight — the same scale the 2D renderer's `?night=` uses.
   *
   * Night has to actually be dark, and it was not. The daylight was dimmed by
   * about half and the ambient barely at all, which looked like an overcast
   * afternoon and — worse — left every street lamp invisible, because a lamp
   * cannot read against an ambient brighter than itself. That is the whole
   * point of a night: the sun goes away and the lights you put in the street
   * become the thing you see by.
   *
   * The hue comes from `GRADE_NIGHT`, the 2D pass's own night grade, so the two
   * renderers at least agree on what colour night is even though one gets there
   * by grading a flat image and the other by turning the sun down.
   */
  setNight(amount: number): void {
    const t = Math.max(0, Math.min(1, amount));
    // `main.ts` calls this every frame; the hour moves once a second at most.
    // Everything below is lerps and colour writes, so skipping the no-change
    // case is what keeps a per-frame call from allocating per frame.
    if (t === this.night) return;
    const lerp = (a: number, b: number): number => a + (b - a) * t;
    this.sun.intensity = lerp(DAYLIGHT.sun, MOONLIGHT.sun);
    this.ambient.intensity = lerp(DAYLIGHT.ambient, MOONLIGHT.ambient);
    this.hemi.intensity = lerp(DAYLIGHT.hemi, MOONLIGHT.hemi);
    // Night is a colour, not just less of the day.
    //
    // Only the ambient was being graded; the sun kept its warm 0xffeccd at
    // midnight and the hemisphere kept its daylight sky and ground. So 3D night
    // held full daytime chroma and read as an underexposed afternoon, where the
    // 2D pass shifts blue-over-red by 48% across the same hours and this shifted
    // 11%. Moonlight is cool and weak; the sky it falls out of is cooler still.
    this.sun.color.copy(SUN_DAY).lerp(SUN_NIGHT, t);
    this.hemi.color.copy(HEMI_SKY_DAY).lerp(HEMI_SKY_NIGHT, t);
    this.hemi.groundColor.copy(HEMI_GROUND_DAY).lerp(HEMI_GROUND_NIGHT, t);
    this.ambient.color.copy(AMBIENT_DAY).lerp(AMBIENT_NIGHT, t);
    // Written in place: reassigning `scene.background` hands three.js a new
    // object reference to re-examine every frame, for a colour that has not
    // moved. The constructor set a Color here, so it is always one.
    (this.scene.background as THREE.Color).copy(SKY_DAY).lerp(SKY_NIGHT, t);
    // Windows light up as it gets dark — the one cue that turns a block of
    // flats at night from a silhouette into somewhere people live.
    setFacadeNight(this.facadeNight, t);
    // The bloom threshold is a ratio to the key light, not an absolute, so the
    // post chain needs to know how much light the rig is putting in — the three
    // intensities just written, added up. 4.75 at midday against 1.00 at
    // midnight: a threshold that ignored that could only be right at one hour,
    // and by day it let ordinary lit surfaces glow. See `post.ts`.
    this.post?.setNight(t, this.sun.intensity + this.ambient.intensity + this.hemi.intensity);
    this.night = t;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.post?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * How much world the frame covers vertically.
   *
   * The window can change size mid-session — `fitViewport` answers a 1440p
   * window with a taller frame than a laptop's — and the HUD, the radar and
   * mouse aim all move to the new figure on the next frame. Without this the
   * camera kept the height it was built with, so the world was drawn at one
   * scale and everything drawn over it at another: markers drifted from what
   * they marked, further the nearer the edge of the frame.
   */
  setViewHeight(h: number): void {
    this.viewHeight = h;
  }

  /** How high the camera must sit for `viewHeight` world px to fill the frame. */
  private get camHeight(): number {
    return this.viewHeight / 2 / Math.tan((FOV_Y * Math.PI) / 360);
  }

  /** Point the camera at a world position. See `cameraPose`. */
  lookAt(x: number, y: number): void {
    this.target.set(x, y);
    const pose = cameraPose(x, y, this.pitch, this.camHeight);
    this.camera.position.copy(pose.position);
    this.camera.up.copy(pose.up);
    this.camera.lookAt(pose.target);
    // Keep the sun rigged to the camera so the shadow map always covers what
    // is on screen. The sun lives in the world group, so `SUN_OFFSET` is in
    // world px and means the same thing here as `SUN_X`/`SUN_Y` do in 2D.
    //
    // Snapped to whole shadow texels, in the LIGHT'S basis — see
    // `SHADOW_BASIS`. Following the camera to unquantised coordinates slides
    // the depth grid by a fraction of a texel every frame and every shadow
    // edge crawls; snapping in world XY (the previous fix) quantised to a
    // grid the tilted shadow camera does not sample on, which only slowed
    // the crawl. Remove the target's fractional part along the light's own
    // right/up and the samples land on the same texels frame to frame.
    // Shifting target and sun by the same in-plane step leaves the light
    // direction untouched, so it is invisible except to the texel grid.
    const texel = (2 * SHADOW_HALF_EXTENT) / this.sun.shadow.mapSize.x;
    const t = SNAP_SCRATCH.set(x, -y, 0); // scene space
    const a = t.dot(SHADOW_BASIS.x);
    const b = t.dot(SHADOW_BASIS.y);
    t.addScaledVector(SHADOW_BASIS.x, Math.round(a / texel) * texel - a);
    t.addScaledVector(SHADOW_BASIS.y, Math.round(b / texel) * texel - b);
    // Back to the world group's coordinates (game y is scene −y).
    this.sun.target.position.set(t.x, -t.y, t.z);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(t.x + SUN_OFFSET.x, -t.y + SUN_OFFSET.y, t.z + SUN_OFFSET.z);
  }

  render(): void {
    // `autoReset` is off (see the constructor), so the frame's counters start
    // here. Everything drawn between this and the next `render()` — shadow
    // map, scene, every post pass — is what `stats()` reports.
    this.renderer.info.reset();
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Give the GPU everything back.
   *
   * For when 3D is being abandoned rather than merely paused — the fallback to
   * the 2D renderer. Hiding the canvas leaves the context, the shadow map and
   * the city resident, and a browser will only grant a page so many contexts
   * before it starts taking the oldest ones away.
   */
  dispose(): void {
    this.post?.dispose();
    this.post = null;
    if (this.city) disposeCity(this.city);
    this.city = null;
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /**
   * Draw calls and triangles.
   *
   * The numbers worth quoting from a box with no GPU. Frame rate here is
   * SwiftShader's, which says nothing about a real machine; draw count is a
   * property of how the scene is built and is the same everywhere.
   */
  stats(): { draws: number; triangles: number; instances: number } {
    const info = this.renderer.info.render;
    return { draws: info.calls, triangles: info.triangles, instances: this.instanceCount };
  }

  /** Shadow map size, so a slow machine can turn it down. */
  setShadowQuality(size: number): void {
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as unknown as { map: null }).map = null;
  }

}
