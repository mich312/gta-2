import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from 'shared';
import { SUN_X, SUN_Y } from '../src/render/config.js';
import { SUN_OFFSET, WORLD_TO_SCENE, cameraPose } from '../src/three/cityView.js';

/**
 * Which way up the 3D city is.
 *
 * The game's world is y-DOWN — `y` grows southwards, and that is what the sim,
 * the 2D renderer, the HUD and the radar all mean by it. three.js is y-UP, so
 * the city has to be mirrored on its way into the scene. It was not, and the
 * whole world rendered north-for-south: the park the radar put above you was
 * drawn below you, driving south walked you up the screen, and the sun threw
 * its shadows against `SUN_Y`. Nothing crashed and nothing looked broken in a
 * screenshot — a grid city mirrors into a plausible grid city — which is why
 * it shipped and why it gets a test.
 *
 * No GPU here: `CityView` owns a `WebGLRenderer` and cannot be built in node,
 * so the two values that decide the orientation are exported and the real
 * three.js projection maths is run over them. That is the whole of the answer
 * — a world position goes through the group's scale and the camera, and lands
 * somewhere in normalised device coordinates, where +x is right and +y is UP.
 */

/** Project a WORLD position to NDC, the way a frame actually would. */
function project(world: THREE.Vector3, camera: THREE.PerspectiveCamera): THREE.Vector3 {
  const group = new THREE.Group();
  group.scale.set(WORLD_TO_SCENE.x, WORLD_TO_SCENE.y, WORLD_TO_SCENE.z);
  const dot = new THREE.Object3D();
  dot.position.copy(world);
  group.add(dot);
  group.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  return dot.getWorldPosition(new THREE.Vector3()).project(camera);
}

/** A camera over a world point, framing `viewHeight` world px. */
function cameraOver(x: number, y: number, pitch = 0, viewHeight = 360): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 8, 6000);
  const height = viewHeight / 2 / Math.tan((34 * Math.PI) / 360);
  const pose = cameraPose(x, y, pitch, height);
  camera.position.copy(pose.position);
  camera.up.copy(pose.up);
  camera.lookAt(pose.target);
  camera.updateProjectionMatrix();
  return camera;
}

describe('3D world orientation', () => {
  const HERE = { x: 3400, y: 1288 };

  it('puts the player under the middle of the frame', () => {
    const camera = cameraOver(HERE.x, HERE.y);
    const p = project(new THREE.Vector3(HERE.x, HERE.y, 0), camera);
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });

  it('draws increasing world y DOWN the screen, as the radar and the HUD do', () => {
    const camera = cameraOver(HERE.x, HERE.y);
    const south = project(new THREE.Vector3(HERE.x, HERE.y + 200, 0), camera);
    const north = project(new THREE.Vector3(HERE.x, HERE.y - 200, 0), camera);
    expect(south.y).toBeLessThan(0);
    expect(north.y).toBeGreaterThan(0);
  });

  it('draws increasing world x RIGHT across the screen', () => {
    const camera = cameraOver(HERE.x, HERE.y);
    const east = project(new THREE.Vector3(HERE.x + 200, HERE.y, 0), camera);
    const west = project(new THREE.Vector3(HERE.x - 200, HERE.y, 0), camera);
    expect(east.x).toBeGreaterThan(0);
    expect(west.x).toBeLessThan(0);
  });

  it('frames the requested height of world', () => {
    // The HUD, the radar and mouse aim are all drawn assuming the frame covers
    // exactly `viewport.h` world px. If the camera disagrees, every marker
    // sits off the thing it marks, further out the nearer the frame's edge.
    for (const viewHeight of [270, 360, 400]) {
      const camera = cameraOver(HERE.x, HERE.y, 0, viewHeight);
      const top = project(new THREE.Vector3(HERE.x, HERE.y - viewHeight / 2, 0), camera);
      const bottom = project(new THREE.Vector3(HERE.x, HERE.y + viewHeight / 2, 0), camera);
      expect(top.y).toBeCloseTo(1, 5);
      expect(bottom.y).toBeCloseTo(-1, 5);
    }
  });

  it('agrees with the 2D renderer about which way shadows fall', () => {
    // `SUN_X`/`SUN_Y` is the direction the 2D layer offsets a drop shadow: down
    // and to the right. Mirrored, the 3D city threw them up and to the right
    // instead, so the same street was lit from opposite sides in the two
    // renderers. On screen, a shadow has to run towards the bottom-right.
    const camera = cameraOver(HERE.x, HERE.y);
    const shadow = project(
      new THREE.Vector3(HERE.x + SUN_X * 200, HERE.y + SUN_Y * 200, 0),
      camera,
    );
    expect(shadow.x).toBeGreaterThan(0);
    expect(shadow.y).toBeLessThan(0);
  });

  it('rigs the sun opposite the direction shadows fall', () => {
    // The light comes from the far side of what it lights. Both numbers are
    // world px, so this is a plain check that the 3D rig and the 2D constants
    // describe the same sun rather than two that happen to look similar.
    const rig = Math.atan2(-SUN_OFFSET.y, -SUN_OFFSET.x);
    const shadows = Math.atan2(SUN_Y, SUN_X);
    expect(rig).toBeCloseTo(shadows, 1);
    expect(SUN_OFFSET.z).toBeGreaterThan(0);
  });

  it('keeps a tile at the screen position the tile grid says', () => {
    // The one that matters for the reported bug: a tile the radar draws NE of
    // the player has to be drawn NE of them, not SE.
    const camera = cameraOver(HERE.x, HERE.y);
    const tile = (tx: number, ty: number): THREE.Vector3 =>
      project(new THREE.Vector3((tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE, 0), camera);
    const here = { tx: Math.floor(HERE.x / TILE_SIZE), ty: Math.floor(HERE.y / TILE_SIZE) };
    const northEast = tile(here.tx + 5, here.ty - 5);
    const southEast = tile(here.tx + 5, here.ty + 5);
    expect(northEast.x).toBeGreaterThan(0);
    expect(northEast.y).toBeGreaterThan(0);
    expect(southEast.x).toBeGreaterThan(0);
    expect(southEast.y).toBeLessThan(0);
  });

  it('tilts the camera towards the bottom of the frame', () => {
    // Pitch exists to see further up the street ahead. Tilted the other way it
    // shows the pavement behind you, which is the same sign error again.
    const flat = cameraOver(HERE.x, HERE.y, 0);
    const tilted = cameraOver(HERE.x, HERE.y, 12);
    const ahead = new THREE.Vector3(HERE.x, HERE.y - 400, 0);
    expect(project(ahead, tilted).y).toBeLessThan(project(ahead, flat).y);
  });
});
