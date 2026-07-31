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

interface Tile {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  /** Frame counter when this was last inside the view, for eviction. */
  seen: number;
}

export class GroundLayer {
  private readonly group = new THREE.Group();
  private readonly tiles = new Map<number, Tile>();
  private readonly geometry: THREE.PlaneGeometry;
  private map: CityMap | null = null;
  private frame = 0;

  constructor(
    scene: THREE.Object3D,
    private readonly painter: TileLayer,
  ) {
    // One plane, shared by every chunk; only the transform and the map differ.
    this.geometry = new THREE.PlaneGeometry(CHUNK_WORLD, CHUNK_WORLD);
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
    const { canvas, holes } = this.painter.groundChunk(cx, cy);
    const texture = new THREE.CanvasTexture(canvas);
    // The canvas is authored in sRGB; without this it is treated as linear and
    // every painted surface comes out washed out against the boxes beneath.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;

    const material = new THREE.MeshToonMaterial({
      map: texture,
      gradientMap: toonGradient(),
      // Only chunks with water in them carry a hole, and most do not. An
      // alpha-tested draw gives up early-z for every pixel of the frame's
      // largest surface, so it is worth asking rather than assuming.
      transparent: holes,
      alphaTest: holes ? 0.5 : 0,
    });

    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.receiveShadow = true;
    mesh.position.set((cx + 0.5) * CHUNK_WORLD, (cy + 0.5) * CHUNK_WORLD, LIFT);
    this.group.add(mesh);
    return { mesh, texture, seen: this.frame };
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
