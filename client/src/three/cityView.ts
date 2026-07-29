import * as THREE from 'three';
import {
  TILE_SIZE,
  type CityMap,
  buildVolumeGrid,
  spansAt,
  type VolumeGrid,
} from 'shared';
import palette from 'shared/data/palette.json';
import { addOutline, toonMaterial } from './toon.js';

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

    this.ambient = new THREE.AmbientLight(0x8493ad, 2.2);
    this.hemi = new THREE.HemisphereLight(0xa8cbe6, 0x3a3d33, 1.4);
    this.scene.add(this.ambient);
    this.scene.add(this.hemi);
  }

  private sun!: THREE.DirectionalLight;
  private ambient!: THREE.AmbientLight;
  private hemi!: THREE.HemisphereLight;
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
      deck: { match: (t) => t === 7, color: hex(palette.road ?? '#2c3038') },
      other: { match: () => true, color: hex(palette.lot ?? '#4a4a44') },
    };

    // Which building covers each tile, so a block of them shares one colour
    // instead of every tile rolling its own — the same reason the 2D
    // renderer keys roof colour off the building rather than the tile.
    const buildingOf = new Int32Array(W * H);
    this.map.buildings.forEach((bd, i) => {
      for (let ty = bd.y; ty < bd.y + bd.h; ty++) {
        for (let tx = bd.x; tx < bd.x + bd.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          buildingOf[ty * W + tx] = i + 1;
        }
      }
    });

    // Collect one transform per span, bucketed by the colour it resolves to.
    // Buildings get a bucket per palette variant rather than one for all of
    // them: a city where every block is the same grey reads as a model of a
    // city, and the variants already exist for exactly this.
    const buckets = new Map<string, THREE.Matrix4[]>();
    const colorOf = new Map<string, number>();
    const solidKeys = new Set<string>();
    const bucket = (key: string, color: number, solid: boolean): THREE.Matrix4[] => {
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
        colorOf.set(key, color);
        if (solid) solidKeys.add(key);
      }
      return list;
    };

    const m = new THREE.Matrix4();
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const idx = ty * W + tx;
        const tile = this.map.tiles[idx] as number;
        let key: string;
        let color: number;
        let solid = false;
        if (tile === 3) {
          const bi = (buildingOf[idx] as number) - 1;
          const bd = bi >= 0 ? this.map.buildings[bi] : undefined;
          color = this.roofColor(bi, bd?.district ?? 'downtown');
          key = `b${color.toString(16)}`;
          solid = true;
        } else {
          const k = Object.keys(LAYERS).find((n) => (LAYERS[n] as Layer).match(tile)) ?? 'other';
          key = k;
          color = (LAYERS[k] as Layer).color;
          solid = k === 'deck';
        }
        const list = bucket(key, color, solid);

        for (const span of spansAt(this.vg, tx, ty)) {
          // Clamp the earth to something shallow: a ground span runs from
          // EARTH (-4096) and nobody is looking at the bottom of it.
          //
          // Clamp to a fixed FLOOR, not to `top - depth`. Clamping relative
          // to the top capped every building at the same height whatever its
          // storeys said, because a building span also starts at EARTH — a
          // twelve-storey tower drew exactly as tall as a bungalow, which is
          // the whole point of having heights at all.
          const bottom = Math.max(span.bottom, -16);
          const h = Math.max(1, (span.top - bottom) * Z_SCALE);
          m.makeScale(TILE_SIZE, TILE_SIZE, h);
          m.setPosition(
            (tx + 0.5) * TILE_SIZE,
            (ty + 0.5) * TILE_SIZE,
            (span.top * Z_SCALE) - h / 2,
          );
          list.push(m.clone());
        }
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const [key, mats] of buckets) {
      if (mats.length === 0) continue;
      const mesh = new THREE.InstancedMesh(box, toonMaterial(colorOf.get(key) ?? 0x6b6f7a), mats.length);
      const solid = solidKeys.has(key);
      mesh.castShadow = solid;
      mesh.receiveShadow = true;
      this.instanceCount += mats.length;
      mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      // Outline the things that stand up. Outlining every ground tile would
      // draw a black grid over the whole city — the streets read as one
      // surface, and a surface has no silhouette worth tracing.
      if (solid) addOutline(mesh, this.scene, 1.2);
    }
  }

  /** 0 midday, 1 midnight — the same scale the 2D renderer's ?night= uses. */
  setNight(amount: number): void {
    const t = Math.max(0, Math.min(1, amount));
    this.sun.intensity = 2.6 * (1 - t * 0.85);
    this.ambient.intensity = 2.2 * (1 - t * 0.6);
    this.hemi.intensity = 1.4 * (1 - t * 0.5);
    const sky = new THREE.Color(0x9fc4dd).lerp(new THREE.Color(0x0a1020), t);
    this.scene.background = sky;
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

  /**
   * A building's colour: the same hash and the same palette variants
   * `TileLayer.roofColor` and `ExtrudeLayer` use, so a block is the colour
   * here that it is in the 2D renderer and switching views does not repaint
   * the city.
   */
  private roofColor(index: number, district: string): number {
    const variants =
      (palette.buildingVariants as Record<string, string[]>)[district] ??
      palette.buildingVariants.downtown;
    const id = index + 1;
    // `hash2` from the 2D renderer, inlined — it is the only thing three.js
    // needs out of a module full of canvas helpers.
    const h = Math.sin(id * 127.1 + (id * 7 + 3) * 311.7) * 43758.5453;
    const pick = h - Math.floor(h);
    return hex(variants[Math.floor(pick * variants.length) % variants.length] as string);
  }
}
