import * as THREE from 'three';
import {
  TILE_SIZE,
  type CityMap,
  buildVolumeGrid,
  spansAt,
  type VolumeGrid,
} from 'shared';
import palette from 'shared/data/palette.json';

/**
 * The city as actual geometry.
 *
 * Built from the **volume grid**, not from the tile grid — which is the whole
 * point of the exercise. A span is a box: bottom, top, one tile square. So
 * the thing the collision resolves against and the thing you look at are the
 * same description of the world, and a bridge you can sail under is a bridge
 * you can *see* under, because both come from the same two numbers.
 *
 * Everything is instanced. A 240×240 city is ~57,600 columns and rather more
 * spans; as individual meshes that is a five-figure draw count and a dead
 * frame. As a handful of `InstancedMesh`es it is single digits.
 *
 * This is a viewer, not the game renderer. It reads the map and draws it.
 * Wiring entities, prediction and the HUD through it is the next item — see
 * 3D.md.
 */

/** Vertical exaggeration, so a 3-storey street reads at a shallow angle. */
const Z_SCALE = 1;

interface Layer {
  /** Which spans go in this layer. */
  match: (tileType: number) => boolean;
  color: number;
}

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

export class CityView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly vg: VolumeGrid;
  private readonly map: CityMap;
  private readonly pitch: number;
  private viewHeight: number;

  /** Where the camera is looking, in world px. */
  target = new THREE.Vector2(0, 0);

  constructor(opts: CityViewOptions) {
    this.map = opts.map;
    this.vg = buildVolumeGrid(opts.map);
    this.pitch = opts.pitch;
    this.viewHeight = opts.viewHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(hex(palette.field ?? '#1a2a1a'));

    // Orthographic, because this is still a top-down game: a perspective
    // camera would make the same building look different depending on where
    // it sat on screen, which is exactly the readability the genre trades
    // verticality for. The pitch is what gives the height somewhere to go.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 8000);
    this.resize(opts.canvas.width, opts.canvas.height);

    this.buildLights();
    this.buildGeometry();
  }

  private buildLights(): void {
    // One sun with a shadow map, replacing 761 lines of Canvas compositing.
    const sun = new THREE.DirectionalLight(0xffeccd, 2.6);
    sun.position.set(-600, -900, 1200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = 900;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 4000;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    this.scene.add(new THREE.AmbientLight(0x8493ad, 2.2));
    this.scene.add(new THREE.HemisphereLight(0xa8cbe6, 0x3a3d33, 1.4));
  }

  private sun!: THREE.DirectionalLight;
  private instanceCount = 0;

  /**
   * Turn every span into a box, batched by what it is.
   *
   * The `ground` layer is one flat plane per tile rather than a deep box —
   * the earth below is `EARTH`-deep and drawing that would waste most of the
   * depth buffer on dirt nobody sees.
   */
  private buildGeometry(): void {
    const W = this.map.widthTiles;
    const H = this.map.heightTiles;

    const LAYERS: Record<string, Layer> = {
      road: { match: (t) => t === 1 || t === 13, color: hex(palette.road ?? '#2c3038') },
      pavement: { match: (t) => t === 2, color: hex(palette.sidewalk ?? '#575d68') },
      grass: { match: (t) => t === 4 || t === 0 || t === 11, color: hex(palette.grassDark ?? '#2f4a2a') },
      water: { match: (t) => t === 6, color: hex(palette.water ?? '#25506b') },
      building: { match: (t) => t === 3, color: hex(palette.buildingVariants?.downtown?.[0] ?? '#6b6f7a') },
      deck: { match: (t) => t === 7, color: hex(palette.road ?? '#2c3038') },
      other: { match: () => true, color: hex(palette.lot ?? '#4a4a44') },
    };

    // Collect one transform per span, bucketed by layer.
    const buckets = new Map<string, THREE.Matrix4[]>();
    for (const k of Object.keys(LAYERS)) buckets.set(k, []);

    const m = new THREE.Matrix4();
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const tile = this.map.tiles[ty * W + tx] as number;
        const key =
          Object.keys(LAYERS).find((k) => (LAYERS[k] as Layer).match(tile)) ?? 'other';

        for (const span of spansAt(this.vg, tx, ty)) {
          // Clamp the earth to something shallow: the span says -4096 and
          // nobody is looking at the bottom of it.
          const bottom = Math.max(span.bottom, span.top - 64);
          const h = Math.max(1, (span.top - bottom) * Z_SCALE);
          m.makeScale(TILE_SIZE, TILE_SIZE, h);
          m.setPosition(
            (tx + 0.5) * TILE_SIZE,
            (ty + 0.5) * TILE_SIZE,
            (span.top * Z_SCALE) - h / 2,
          );
          (buckets.get(key) as THREE.Matrix4[]).push(m.clone());
        }
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const [key, mats] of buckets) {
      if (mats.length === 0) continue;
      const layer = LAYERS[key] as Layer;
      const mat = new THREE.MeshLambertMaterial({ color: layer.color });
      const mesh = new THREE.InstancedMesh(box, mat, mats.length);
      mesh.castShadow = key === 'building' || key === 'deck';
      mesh.receiveShadow = true;
      this.instanceCount += mats.length;
      mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const h = this.viewHeight / 2;
    this.camera.top = h;
    this.camera.bottom = -h;
    this.camera.left = -h * aspect;
    this.camera.right = h * aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Point the camera at a world position. */
  lookAt(x: number, y: number): void {
    this.target.set(x, y);
    const rad = (this.pitch * Math.PI) / 180;
    const dist = 2000;
    // Pitch tilts the camera back along -y, so "up the screen" stays north.
    this.camera.position.set(
      x,
      y - Math.sin(rad) * dist,
      Math.cos(rad) * dist,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(x, y, 0);
    this.sun.target.position.set(x, y, 0);
    this.sun.position.set(x - 600, y - 900, 1200);
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
