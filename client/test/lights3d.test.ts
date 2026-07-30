import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CityMap, initTuning } from 'shared';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import trafficJson from 'shared/data/traffic.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
import { Effects } from '../src/render/effects.js';
import type { Scene } from '../src/render/renderer.js';
import { FLASH_Z, LAMP_Z, Lights3dLayer } from '../src/three/lights3d.js';

/**
 * The light budget.
 *
 * three.js compiles a fixed light count into every shader, so a 240×240 city
 * cannot have a light per lamp: there are fixed pools and each frame the most
 * important sources claim a slot. Which makes the *ranking* the whole feature,
 * and a ranking bug invisible in the code and glaring on screen — the first cut
 * put traffic signals and package glints above street lamps, and since every
 * junction has several heads, they took all sixteen slots and the city had no
 * street lighting at all.
 *
 * So these tests are mostly about what wins. No WebGL needed: the lights are
 * ordinary scene-graph objects and their intensities can be read back.
 */

function emptyMap(over: Partial<CityMap> = {}): CityMap {
  return {
    seed: 0,
    widthTiles: 40,
    heightTiles: 40,
    widthPx: 640,
    heightPx: 640,
    tiles: new Uint8Array(1600),
    district: new Uint8Array(1600),
    blocks: [],
    buildings: [],
    shops: [],
    vehicleSpawns: [],
    playerSpawns: [{ x: 100, y: 100 }],
    packages: [],
    ...over,
  } as unknown as CityMap;
}

function emptyScene(over: Partial<Scene> = {}): Scene {
  return {
    local: null,
    localPos: null,
    localVehicle: null,
    remotes: {
      players: [],
      vehicles: [],
      cops: [],
      peds: [],
      props: [],
      pickups: [],
      projectiles: [],
    },
    dt: 1 / 60,
    nowMs: 1000,
    tick: 0,
    ...over,
  } as unknown as Scene;
}

/** A street of lamps, as the sim streams them: props of kind `lamp`. */
function lamps(n: number, from = 0): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: from + i + 1,
    kind: 'lamp',
    intact: true,
    pos: { x: 40 + i * 12, y: 180 },
    orient: 0,
  }));
}

/** Every light with any intensity, brightest first. */
function live(layer: Lights3dLayer): Array<{ kind: string; intensity: number; z: number }> {
  const group = (layer as unknown as { group: THREE.Group }).group;
  const out: ReturnType<typeof live> = [];
  for (const child of group.children) {
    const light = child as THREE.PointLight & { isSpotLight?: boolean };
    if (!(light as THREE.Light).isLight || light.intensity <= 0) continue;
    out.push({
      kind: light.isSpotLight ? 'spot' : 'point',
      intensity: light.intensity,
      z: light.position.z,
    });
  }
  return out.sort((a, b) => b.intensity - a.intensity);
}

const FOCUS = { x: 320, y: 180 };
const CAM = { x: 0, y: 0 };
const VIEW = { w: 640, h: 360 };

describe('the 3D light budget', () => {
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

  function layer(): Lights3dLayer {
    const l = new Lights3dLayer(new THREE.Group());
    l.setMap(emptyMap());
    return l;
  }

  it('lights the street at night and leaves it alone at midday', () => {
    // A lamp burning at noon is the one thing that gives away a scene with no
    // clock behind it, so the street fades in with the dusk.
    const fx = layer();
    const scene = emptyScene({ remotes: { ...emptyScene().remotes, props: lamps(6) } } as never);

    fx.update(scene, new Effects(), 1, FOCUS, CAM, VIEW);
    const night = live(fx);
    fx.update(scene, new Effects(), 0, FOCUS, CAM, VIEW);
    const noon = live(fx);

    expect(night.length).toBeGreaterThan(0);
    expect(noon.length).toBe(night.length); // same lamps, still on their posts
    const sum = (a: typeof night): number => a.reduce((t, l) => t + l.intensity, 0);
    expect(sum(noon)).toBeLessThan(sum(night) * 0.25);
  });

  it('spends the budget on street lamps rather than on markers', () => {
    // The regression that made this file worth testing. Sixty signal heads and
    // packages against a handful of lamps: the lamps must still get slots.
    const heads = Array.from({ length: 60 }, (_, i) => ({
      x: 300 + (i % 10) * 4,
      y: 180 + Math.floor(i / 10) * 4,
      junctionId: i,
      dirIdx: i % 4,
    }));
    const fx = new Lights3dLayer(new THREE.Group());
    fx.setMap(
      emptyMap({
        junctions: { heads },
        packages: Array.from({ length: 40 }, (_, i) => ({ x: 310 + i, y: 185 })),
      } as unknown as Partial<CityMap>),
    );

    fx.update(
      emptyScene({ remotes: { ...emptyScene().remotes, props: lamps(8) } } as never),
      new Effects(),
      1,
      FOCUS,
      CAM,
      VIEW,
    );
    // Lamps hang on posts; markers sit at knee height or below. Every slot
    // taken by something at lamp height is a slot doing the job of lighting.
    // Against the real LAMP_Z rather than a number that happens to sit above
    // it today: this read `z > 20`, which was silently a copy of a LAMP_Z of
    // 30, and broke the moment the lamp mesh — and the bulb with it — came
    // down to the height the camera can afford.
    const atLampHeight = live(fx).filter((l) => l.z >= LAMP_Z && l.kind === 'point');
    expect(atLampHeight.length).toBeGreaterThanOrEqual(8);
  });

  it('gives a headlight a spotlight, and an unlit car nothing', () => {
    const fx = layer();
    const driven = {
      kind: 'car',
      pos: { x: 320, y: 180 },
      heading: 0,
      speed: 90,
      condition: 'ok',
      wear: 0,
      zones: [0, 0, 0, 0],
      broken: 0,
      z: 0,
      gangId: 0,
      paint: -1,
    };
    fx.update(
      emptyScene({ localVehicle: driven, local: { vehicleId: 7 } } as never),
      new Effects(),
      1,
      FOCUS,
      CAM,
      VIEW,
    );
    expect(live(fx).some((l) => l.kind === 'spot')).toBe(true);

    // A parked car with nobody in it stays dark: a street of them all blazing
    // away washes the scene out and reads as nonsense.
    const fx2 = layer();
    fx2.update(
      emptyScene({
        remotes: {
          ...emptyScene().remotes,
          vehicles: [
            {
              vehicle: {
                id: 9,
                kind: 'car',
                driverId: null,
                speed: 0,
                broken: 0,
                condition: 'ok',
                health: 100,
                z: 0,
              },
              x: 320,
              y: 180,
              heading: 0,
            },
          ],
        },
      } as never),
      new Effects(),
      1,
      FOCUS,
      CAM,
      VIEW,
    );
    expect(live(fx2)).toHaveLength(0);
  });

  it('lets an explosion outrank the street it happens in', () => {
    // A flash is information: it says where somebody is shooting from. A lamp
    // is atmosphere. When there are not enough slots for both, the flash wins.
    const effects = new Effects();
    effects.explosion(320, 180, 40);
    const fx = layer();
    fx.update(
      emptyScene({ remotes: { ...emptyScene().remotes, props: lamps(40) } } as never),
      effects,
      1,
      FOCUS,
      CAM,
      VIEW,
    );
    const drawn = live(fx);
    // Forty lamps could fill the pool on their own. The test is that the
    // fireball still got a slot — not that it is the brightest number, which is
    // not comparable across heights: intensity converts at the distance to the
    // surface a light is for, so a lamp thirty pixels up carries a bigger
    // figure than a fireball at eight for the same brightness on the ground.
    expect(drawn.some((l) => l.z <= FLASH_Z)).toBe(true);
    expect(drawn.filter((l) => l.z >= LAMP_Z).length).toBeGreaterThan(0); // lamps too
    expect(drawn.length).toBeLessThanOrEqual(20);
  });

  it('never exceeds its pools, however busy the street', () => {
    const fx = layer();
    fx.update(
      emptyScene({ remotes: { ...emptyScene().remotes, props: lamps(400) } } as never),
      new Effects(),
      1,
      FOCUS,
      CAM,
      VIEW,
    );
    const drawn = live(fx);
    expect(drawn.filter((l) => l.kind === 'point').length).toBeLessThanOrEqual(16);
    expect(drawn.filter((l) => l.kind === 'spot').length).toBeLessThanOrEqual(4);
    expect(fx.counts().wanted).toBeGreaterThan(drawn.length);
  });

  it('spends a quarter of the budget when told to be cheap', () => {
    // `?lights=off` and `?lights=cheap` are the 2D pass's escape hatches for a
    // machine that cannot afford it, and they have to mean something here too.
    const fx = layer();
    const scene = emptyScene({ remotes: { ...emptyScene().remotes, props: lamps(200) } } as never);
    fx.update(scene, new Effects(), 1, FOCUS, CAM, VIEW);
    const full = live(fx).length;

    fx.setCheap(true);
    fx.update(scene, new Effects(), 1, FOCUS, CAM, VIEW);
    const cheap = live(fx).length;
    expect(cheap).toBeLessThan(full);
    expect(cheap).toBeGreaterThan(0);

    // ...and back again, or a session that ever ran cheap would stay cheap.
    fx.setCheap(false);
    fx.update(scene, new Effects(), 1, FOCUS, CAM, VIEW);
    expect(live(fx).length).toBe(full);
  });

  it('parks a light rather than leaving it burning where it was', () => {
    // The pools are reused every frame. A slot that is not claimed this frame
    // has to go out, or last frame's explosion lights the street for ever.
    const effects = new Effects();
    effects.explosion(320, 180, 40);
    const fx = layer();
    fx.update(emptyScene(), effects, 1, FOCUS, CAM, VIEW);
    expect(live(fx).length).toBeGreaterThan(0);

    for (let i = 0; i < 400; i++) effects.update(0.05);
    fx.update(emptyScene(), effects, 1, FOCUS, CAM, VIEW);
    expect(live(fx)).toHaveLength(0);
  });
});
