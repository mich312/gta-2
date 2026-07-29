import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  NULL_INPUT,
  TILE_SIZE,
  T_FIELD,
  type CityMap,
  type GameState,
  type InputIntent,
  createGameState,
  initTuning,
  step,
} from 'shared';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import trafficJson from 'shared/data/traffic.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
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

/**
 * The keys, all the way through to the frame.
 *
 * The other half of the same report: "the arrows were moving the player in the
 * wrong direction". They were not — `stepPlayer` has always read `up` as -y,
 * and steering has always turned the heading the way a y-down world says it
 * should. The mirror was in the picture, so pressing up walked you DOWN the
 * screen and turning right swung the car left, which from the driving seat is
 * indistinguishable from the controls being inverted.
 *
 * Neither half is wrong on its own, so neither half can be tested on its own.
 * This runs the real sim over a real intent and projects the result through the
 * real camera: press a key, and assert which way the avatar goes ON SCREEN.
 */
describe('what the arrow keys do on screen', () => {
  beforeAll(() => {
    initTuning({
      player: playerTuning,
      vehicles: vehiclesJson,
      traffic: trafficJson,
      peds: pedsJson,
      police: policeJson,
      props: propsJson,
      weapons: weaponsJson,
    });
  });

  /** Open field, big enough that nothing in here ever meets a wall. */
  function arena(): CityMap {
    const W = 80;
    const H = 40;
    return {
      seed: 0,
      widthTiles: W,
      heightTiles: H,
      widthPx: W * TILE_SIZE,
      heightPx: H * TILE_SIZE,
      tiles: new Uint8Array(W * H).fill(T_FIELD),
      district: new Uint8Array(W * H),
      blocks: [],
      buildings: [],
      shops: [],
      vehicleSpawns: [],
      playerSpawns: [{ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE }],
    };
  }

  /** Walk for half a second on one key, and report where that put you on screen. */
  function walk(keys: Partial<InputIntent>): { x: number; y: number } {
    const map = arena();
    let state: GameState = createGameState(1);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'walker' }], map);
    const from = { ...(state.players.byId[1] as { pos: { x: number; y: number } }).pos };
    for (let i = 0; i < 15; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i + 1, ...keys } }, [], map);
    }
    const to = (state.players.byId[1] as { pos: { x: number; y: number } }).pos;
    // The camera stays where the walker started, so the avatar's drift across
    // the frame is what a player watching the screen actually sees.
    const camera = cameraOver(from.x, from.y);
    const p = project(new THREE.Vector3(to.x, to.y, 0), camera);
    return { x: p.x, y: p.y };
  }

  it('sends you up the screen on up, and down on down', () => {
    expect(walk({ up: true }).y).toBeGreaterThan(0.01);
    expect(walk({ down: true }).y).toBeLessThan(-0.01);
  });

  it('sends you left on left, and right on right', () => {
    expect(walk({ left: true }).x).toBeLessThan(-0.01);
    expect(walk({ right: true }).x).toBeGreaterThan(0.01);
  });

  it('does not swap the axes', () => {
    // A transposed frame would pass the pair above and still be wrong.
    expect(Math.abs(walk({ up: true }).x)).toBeLessThan(0.001);
    expect(Math.abs(walk({ right: true }).y)).toBeLessThan(0.001);
  });

  /** Drive off in a car, and report where the nose is pointing on screen. */
  function steer(keys: Partial<InputIntent>): { x: number; y: number } {
    const map = arena();
    let state: GameState = createGameState(1);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
    const spot = { ...(state.players.byId[1] as { pos: { x: number; y: number } }).pos };
    state = step(
      state,
      {},
      // Nose pointing east, so a right turn has to swing it southwards and a
      // left turn northwards. Starting on an axis makes the sign unambiguous.
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: spot.x, y: spot.y, heading: 0 }],
      map,
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    // Ten ticks: enough wheel to read the direction of the turn, not so much
    // that the nose swings past a right angle and the sign stops meaning
    // "which way did it go".
    for (let i = 0; i < 10; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i + 2, ...keys } }, [], map);
    }
    const car = state.vehicles.byId[2] as { pos: { x: number; y: number }; heading: number };
    const camera = cameraOver(car.pos.x, car.pos.y);
    // Where the bonnet is, relative to the car: the thing a driver steers by.
    const nose = project(
      new THREE.Vector3(
        car.pos.x + Math.cos(car.heading) * 60,
        car.pos.y + Math.sin(car.heading) * 60,
        0,
      ),
      camera,
    );
    return { x: nose.x, y: nose.y };
  }

  it('swings the bonnet the way you turn the wheel', () => {
    // Mirrored, this was the loudest of the lot: hold right, and the car goes
    // left. The nose starts pointing screen-right; a right turn brings it down
    // the frame and a left turn brings it up.
    expect(steer({ up: true, right: true }).y).toBeLessThan(-0.01);
    expect(steer({ up: true, left: true }).y).toBeGreaterThan(0.01);
    // The bonnet is still ahead of the driver in both, so those are turns
    // rather than the car having spun past a right angle.
    expect(steer({ up: true, right: true }).x).toBeGreaterThan(0);
    expect(steer({ up: true, left: true }).x).toBeGreaterThan(0);
  });
});
