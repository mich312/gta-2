import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHudGroundCamera,
  projectGround,
  setHudGroundCamera,
  type HudPoint,
} from '../src/render/project.js';
import { fixedViewport, setViewport, viewport } from '../src/render/viewport.js';
import { FOV_Y, WORLD_TO_SCENE, cameraPose } from '../src/three/cityView.js';

/**
 * Does the HUD draw a ground point where the 3D renderer puts it?
 *
 * Name tags and bullet tracers are drawn in HUD units over whichever renderer
 * is running, and for two rounds they drew at `world - cam` because
 * `renderer.ts` said "the 3D camera hangs straight down over the middle of the
 * same frame". It does not: the shipped `GAME_PITCH` is 10 degrees. The claim
 * had been verified — at pitch 0, before the camera was tilted — and never
 * re-verified afterwards, which is exactly the kind of thing a test outlives a
 * comment at.
 *
 * No GPU: `CityView` owns a `WebGLRenderer` and cannot be built in node, so
 * this does what `cityOrientation.test.ts` does and runs the real three.js
 * projection over the exported `cameraPose` and `WORLD_TO_SCENE` — the same
 * two values the renderer builds its camera from.
 */

/**
 * Frames to check, in world px: a laptop's, the common 1280x720 fit, and the
 * ceiling `MAX_VIEW_W`/`MAX_VIEW_H` allows. Whole numbers, because
 * `fitViewport` only ever produces whole numbers and the camera's aspect is
 * the canvas's.
 */
const FRAMES: Array<[number, number]> = [
  [480, 270],
  [630, 360],
  [700, 400],
];

/** A camera over a world point, framing `viewHeight` world px at `aspect`. */
function cameraOver(x: number, y: number, pitch: number, viewHeight: number, aspect: number) {
  const camera = new THREE.PerspectiveCamera(FOV_Y, aspect, 8, 6000);
  const height = viewHeight / 2 / Math.tan((FOV_Y * Math.PI) / 360);
  const pose = cameraPose(x, y, pitch, height);
  camera.position.copy(pose.position);
  camera.up.copy(pose.up);
  camera.lookAt(pose.target);
  camera.updateProjectionMatrix();
  return camera;
}

/** Where the renderer lands a ground point, in world px from the frame origin. */
function renderedAt(
  wx: number,
  wy: number,
  camera: THREE.PerspectiveCamera,
  vw: number,
  vh: number,
): HudPoint {
  const group = new THREE.Group();
  group.scale.set(WORLD_TO_SCENE.x, WORLD_TO_SCENE.y, WORLD_TO_SCENE.z);
  const dot = new THREE.Object3D();
  dot.position.set(wx, wy, 0);
  group.add(dot);
  group.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const ndc = dot.getWorldPosition(new THREE.Vector3()).project(camera);
  return { x: (ndc.x * 0.5 + 0.5) * vw, y: (-ndc.y * 0.5 + 0.5) * vh };
}

/** The corners, the edge midpoints and the centre of the frame. */
const GRID: Array<[number, number]> = [];
for (const fy of [0.05, 0.25, 0.5, 0.75, 0.95]) {
  for (const fx of [0.05, 0.5, 0.95]) GRID.push([fx, fy]);
}

/** Somewhere unremarkable in the city, in world px. */
const FOCUS = { x: 6400, y: 6400 };

describe('HUD ground projection', () => {
  const restore = { w: viewport.w, h: viewport.h };
  afterEach(() => {
    clearHudGroundCamera();
    setViewport(fixedViewport(restore.w, restore.h));
  });

  /** Run `body` with the frame set to `vw` x `vh` world px. */
  function withFrame(
    [vw, vh]: [number, number],
    body: (vw: number, vh: number, cam: HudPoint) => void,
  ): void {
    setViewport(fixedViewport(vw, vh));
    body(vw, vh, { x: FOCUS.x - vw / 2, y: FOCUS.y - vh / 2 });
  }

  it('is exactly world minus cam with no 3D camera over it', () => {
    // The 2D renderer never registers one, and it has no tilt to correct for.
    // Exactly, not nearly: this is the same subtraction the HUD used to do, so
    // nothing in the 2D path may move by so much as a float's last bit.
    clearHudGroundCamera();
    withFrame([630, 360], (_vw, _vh, cam) => {
      for (const [fx, fy] of GRID) {
        const wx = cam.x + viewport.w * fx;
        const wy = cam.y + viewport.h * fy;
        const at = projectGround(wx, wy, cam, { x: 0, y: 0 });
        expect(at.x).toBe(wx - cam.x);
        expect(at.y).toBe(wy - cam.y);
      }
    });
  });

  it('is exactly world minus cam at pitch 0', () => {
    // The straight-down camera IS the identity, so registering it must not
    // perturb the answer either. This is the control the original claim was
    // verified against, and it has to keep printing zeros.
    setHudGroundCamera(0, FOV_Y);
    withFrame([630, 360], (_vw, _vh, cam) => {
      for (const [fx, fy] of GRID) {
        const wx = cam.x + viewport.w * fx;
        const wy = cam.y + viewport.h * fy;
        const at = projectGround(wx, wy, cam, { x: 0, y: 0 });
        expect(at.x).toBe(wx - cam.x);
        expect(at.y).toBe(wy - cam.y);
      }
    });
  });

  it('lands on the tilted camera at the shipped 10 degrees', () => {
    setHudGroundCamera(10, FOV_Y);
    for (const frame of FRAMES) {
      withFrame(frame, (vw, frameH, cam) => {
        const camera = cameraOver(FOCUS.x, FOCUS.y, 10, frameH, vw / frameH);
        for (const [fx, fy] of GRID) {
          const wx = cam.x + vw * fx;
          const wy = cam.y + frameH * fy;
          const want = renderedAt(wx, wy, camera, vw, frameH);
          const at = projectGround(wx, wy, cam, { x: 0, y: 0 });
          expect(at.x).toBeCloseTo(want.x, 6);
          expect(at.y).toBeCloseTo(want.y, 6);
        }
      });
    }
  });

  it('would have caught the straight-down assumption', () => {
    // The bug, stated as a measurement: at the shipped pitch the old identity
    // is wrong by more than a player is wide near the frame's edges. If this
    // ever drops to zero the camera has been un-tilted and the fix above is
    // dead code rather than correct.
    setHudGroundCamera(10, FOV_Y);
    withFrame([700, 400], (vw, frameH, cam) => {
      const camera = cameraOver(FOCUS.x, FOCUS.y, 10, frameH, vw / frameH);
      let worst = 0;
      for (const [fx, fy] of GRID) {
        const wx = cam.x + vw * fx;
        const wy = cam.y + frameH * fy;
        const want = renderedAt(wx, wy, camera, vw, frameH);
        worst = Math.max(worst, Math.hypot(wx - cam.x - want.x, wy - cam.y - want.y));
      }
      expect(worst).toBeGreaterThan(10);
    });
  });

  it('follows the frame when the window resizes', () => {
    // `setViewHeight` exists because the frame changes size mid-session. A
    // projection that cached the frame it was built with would drift from what
    // it is drawing over, which is the same class of bug one layer up.
    setHudGroundCamera(10, FOV_Y);
    const seen: number[] = [];
    for (const frame of [FRAMES[0] as [number, number], FRAMES[2] as [number, number]]) {
      withFrame(frame, (vw, frameH, cam) => {
        const at = projectGround(cam.x + vw * 0.05, cam.y + frameH * 0.05, cam, { x: 0, y: 0 });
        seen.push(at.x);
      });
    }
    expect(seen[0]).not.toBeCloseTo(seen[1] as number, 3);
  });
});
