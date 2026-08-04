import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from 'shared';
import { CHUNK_TILES } from '../src/render/config.js';
import { chunkQuad, flipForWorld } from '../src/three/ground.js';
import { WORLD_TO_SCENE } from '../src/three/cityView.js';

/**
 * Which way up the painted ground is.
 *
 * `cityOrientation.test.ts` next door holds the world group's y-flip — the
 * mirror that turns the game's y-DOWN coordinates into a y-UP scene. This is
 * the same question asked of the one thing in the scene that carries its own
 * image: the painted ground chunk.
 *
 * `TileLayer.groundChunk` paints its northernmost tile row (`ty0`) into canvas
 * row 0, top-down, exactly as a canvas is written. The quad that shows it is
 * inside the flipped group, and a `CanvasTexture` uploads with `flipY = true`
 * — so with three.js's default the painting came out mirrored north-for-south
 * inside every 8×8-tile chunk. It cost the renderer a black rectangle of
 * building-footprint fill out in the open, carriageway painted across block
 * interiors with buildings standing on it, and — through the same flip in the
 * water cutout — a coastline whose holes were the mirror image of the water,
 * so the sea showed through dry land and the ground floated over open water.
 *
 * Nothing throws when this is wrong and the city still looks like a city,
 * which is why it needs a test rather than a screenshot.
 */

const CHUNK_WORLD = CHUNK_TILES * TILE_SIZE;

/** Where a chunk quad's vertices land, in GAME world px, and what they sample. */
function corners(flip: boolean): Array<{ x: number; y: number; row: number; col: number }> {
  const texture = new THREE.Texture();
  if (flip) flipForWorld(texture);

  // The layer's own construction: one quad, centred on the chunk, hung off a
  // group carrying the world mirror.
  const group = new THREE.Group();
  group.scale.set(WORLD_TO_SCENE.x, WORLD_TO_SCENE.y, WORLD_TO_SCENE.z);
  const mesh = new THREE.Mesh(chunkQuad());
  // Chunk (0, 0): its tiles run from world (0, 0) to (CHUNK_WORLD, CHUNK_WORLD).
  mesh.position.set(CHUNK_WORLD / 2, CHUNK_WORLD / 2, 0);
  group.add(mesh);
  group.updateMatrixWorld(true);

  const pos = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  const out: Array<{ x: number; y: number; row: number; col: number }> = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    // Back out of scene space into the game's y-down world.
    const world = { x: v.x / WORLD_TO_SCENE.x, y: v.y / WORLD_TO_SCENE.y };
    // What the GPU samples, as a fraction of the canvas. `flipY` turns the
    // image over on upload, so v = 0 reads the canvas's LAST row when it is
    // on and its FIRST row when it is off.
    const s = uv.getX(i);
    const t = uv.getY(i);
    out.push({
      x: world.x,
      y: world.y,
      row: texture.flipY ? 1 - t : t,
      col: s,
    });
  }
  return out;
}

/** The corner of the quad nearest the given world point. */
function at(
  cs: ReturnType<typeof corners>,
  x: number,
  y: number,
): { row: number; col: number } {
  const hit = cs.find((c) => Math.abs(c.x - x) < 0.5 && Math.abs(c.y - y) < 0.5);
  expect(hit, `no vertex at world (${x}, ${y})`).toBeDefined();
  const { row, col } = hit as { row: number; col: number };
  return { row, col };
}

describe('the painted ground chunk', () => {
  it('shows the canvas the way the painter wrote it: row 0 to the north', () => {
    const cs = corners(true);
    // `groundChunk` walks ty from ty0 up, writing each row further DOWN the
    // canvas — so the chunk's north-west corner is canvas (0, 0) and its
    // south-east corner is the far one.
    expect(at(cs, 0, 0)).toEqual({ row: 0, col: 0 });
    expect(at(cs, CHUNK_WORLD, 0)).toEqual({ row: 0, col: 1 });
    expect(at(cs, 0, CHUNK_WORLD)).toEqual({ row: 1, col: 0 });
    expect(at(cs, CHUNK_WORLD, CHUNK_WORLD)).toEqual({ row: 1, col: 1 });
  });

  it('is mirrored north-for-south without the flip — the bug this guards', () => {
    // Left to three.js's default the painting is upside down in the world:
    // the chunk's northern edge reads the canvas's LAST row. Asserted so the
    // test above is known to be measuring something, and so anyone who
    // deletes `flipForWorld` learns what it was for.
    const cs = corners(false);
    expect(at(cs, 0, 0).row).toBe(1);
    expect(at(cs, 0, CHUNK_WORLD).row).toBe(0);
  });

  it('never mirrors east-for-west: only y carries the world flip', () => {
    for (const flip of [true, false]) {
      const cs = corners(flip);
      expect(at(cs, 0, 0).col).toBe(0);
      expect(at(cs, CHUNK_WORLD, 0).col).toBe(1);
    }
  });
});
