import * as THREE from 'three';
import { type CityMap } from 'shared';
import palette from 'shared/data/palette.json';
import { GRADE_DAY, GRADE_NIGHT } from '../render/config.js';
import { buildCity, disposeCity } from './cityGeometry.js';
import { setFacadeNight } from './facade.js';

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
 */
const DAYLIGHT = Object.freeze({ sun: 2.18, ambient: 1.84, hemi: 1.18 });
const MOONLIGHT = Object.freeze({ sun: 0.21, ambient: 0.4, hemi: 0.39 });

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
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // ACES filmic instead of the linear default: it rolls off the highlights
    // so a sunlit roof stops clipping to flat white, and it deepens the
    // shadows without crushing them. Cel shading gives hard bands; this is
    // what stops those bands reading as posterisation.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene.background = new THREE.Color(hex(palette.field ?? '#1a2a1a'));

    // World space -> scene space. See the note on `world`.
    this.world.scale.set(WORLD_TO_SCENE.x, WORLD_TO_SCENE.y, WORLD_TO_SCENE.z);
    this.scene.add(this.world);

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
   */
  setMap(map: CityMap): void {
    if (this.city) disposeCity(this.city);
    const built = buildCity(map);
    this.city = built.group;
    this.instanceCount = built.instances;
    this.world.add(this.city);
    // The new facades are built at midday whatever time it is, so hand them
    // back the hour. `main.ts` sets this every frame and would fix it anyway;
    // `city3d.html` and `live.ts` set it once and would not.
    setFacadeNight(this.scene, this.night);
  }

  private buildLights(): void {
    // One sun with a shadow map, replacing 761 lines of Canvas compositing.
    const sun = new THREE.DirectionalLight(0xffeccd, DAYLIGHT.sun);
    sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = 900;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 4000;
    // In the world group, so the sun is rigged in world coordinates like
    // everything else: `SUN_OFFSET` is the direction `SUN_X`/`SUN_Y` throw the
    // 2D renderer's walls and drop shadows, and the two views now agree on
    // which way a building's shadow falls.
    this.world.add(sun);
    this.world.add(sun.target);
    this.sun = sun;

    // Ambient and hemisphere stay in scene space. Neither describes a place in
    // the city — the hemisphere's axis is a screen-space one — so mirroring
    // them would change how the city is lit for no reason.
    this.ambient = new THREE.AmbientLight(0x8493ad, DAYLIGHT.ambient);
    this.hemi = new THREE.HemisphereLight(0xa8cbe6, 0x3a3d33, DAYLIGHT.hemi);
    this.scene.add(this.ambient);
    this.scene.add(this.hemi);
  }

  private sun!: THREE.DirectionalLight;
  private ambient!: THREE.AmbientLight;
  private hemi!: THREE.HemisphereLight;
  private instanceCount = 0;
  private night = 0;

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
    const lerp = (a: number, b: number): number => a + (b - a) * t;
    this.sun.intensity = lerp(DAYLIGHT.sun, MOONLIGHT.sun);
    this.ambient.intensity = lerp(DAYLIGHT.ambient, MOONLIGHT.ambient);
    this.hemi.intensity = lerp(DAYLIGHT.hemi, MOONLIGHT.hemi);
    const grade = (c: { r: number; g: number; b: number }): THREE.Color =>
      new THREE.Color(c.r / 255, c.g / 255, c.b / 255);
    this.ambient.color = grade(GRADE_DAY).lerp(grade(GRADE_NIGHT), t);
    const sky = new THREE.Color(0x9fc4dd).lerp(new THREE.Color(0x0a1020), t);
    this.scene.background = sky;
    // Windows light up as it gets dark — the one cue that turns a block of
    // flats at night from a silhouette into somewhere people live.
    setFacadeNight(this.scene, t);
    this.night = t;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
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
    this.sun.target.position.set(x, y, 0);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(x + SUN_OFFSET.x, y + SUN_OFFSET.y, SUN_OFFSET.z);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
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
