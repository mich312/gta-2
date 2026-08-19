import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CARDINALS,
  type CityMap,
  getTrafficTuning,
  initTuning,
  signalColour,
} from 'shared';
import trafficJson from 'shared/data/traffic.json';
import vehiclesJson from 'shared/data/vehicles.json';
import playerTuning from 'shared/data/player.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
import {
  PACKAGE_COLOR,
  PACKAGE_TAKEN,
  PICKUP_COLORS,
  SIGNAL_COLORS,
  type Scene,
} from '../src/render/renderer.js';
import { WorldObjectsLayer } from '../src/three/worldObjects.js';

/**
 * Pickups, packages, traffic signals and projectiles, in 3D.
 *
 * All four were 2D-only, and the signals are the ones that mattered most: the
 * traffic obeys them, and until now only the 2D player could see what it was
 * obeying. Colours come from the 2D renderer's own tables so the two views
 * cannot disagree about what a health crate looks like — these tests read the
 * instance colours back and check them against those tables, which is what
 * makes that a guarantee rather than a hope.
 */

/** Every live instance across the layer's pools, with position and colour. */
function instances(
  layer: WorldObjectsLayer,
): Array<{ x: number; y: number; z: number; sx: number; sz: number; color: THREE.Color }> {
  const out: ReturnType<typeof instances> = [];
  const m = new THREE.Matrix4();
  const group = (layer as unknown as { group: THREE.Group }).group;
  for (const child of group.children) {
    const mesh = child as THREE.InstancedMesh;
    // The outline twins share the source mesh's instance buffer; counting them
    // would double every object.
    if (!mesh.isInstancedMesh || !mesh.instanceColor) continue;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      // Column lengths, not `decompose`: decompose reports a scale of 1 for a
      // collapsed instance, so it would count the parked tail of every pool as
      // drawn. Column lengths give the real extents, and zero for a pool slot
      // that was never used.
      const e = m.elements;
      const axis = (o: number): number =>
        Math.hypot(e[o] as number, e[o + 1] as number, e[o + 2] as number);
      const sx = axis(0);
      const sz = axis(8);
      if (sx === 0 && axis(4) === 0 && sz === 0) continue;
      out.push({
        x: e[12] as number,
        y: e[13] as number,
        z: e[14] as number,
        sx,
        sz,
        color: new THREE.Color(
          mesh.instanceColor.getX(i),
          mesh.instanceColor.getY(i),
          mesh.instanceColor.getZ(i),
        ),
      });
    }
  }
  return out;
}

/** What `THREE.Color` makes of a CSS string, for comparing instance colours. */
function expected(css: string): THREE.Color {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/.exec(css);
  return new THREE.Color(m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : css);
}

function sameColor(a: THREE.Color, b: THREE.Color): boolean {
  return Math.abs(a.r - b.r) < 1e-3 && Math.abs(a.g - b.g) < 1e-3 && Math.abs(a.b - b.b) < 1e-3;
}

/** A map with nothing in it but the bits these objects hang off. */
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

/** A scene with nothing in it but what a test puts there. */
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
    nowMs: 0,
    tick: 0,
    ...over,
  } as unknown as Scene;
}

const CAM = { x: 0, y: 0 };
const VIEW = { w: 640, h: 360 };

describe('world objects in 3D', () => {
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

  function layer(): WorldObjectsLayer {
    return new WorldObjectsLayer(new THREE.Group());
  }

  it('draws an active pickup in its own colour and skips a taken one', () => {
    const fx = layer();
    fx.setMap(emptyMap());
    fx.update(
      emptyScene({
        remotes: {
          ...emptyScene().remotes,
          pickups: [
            { id: 1, kind: 'health', pos: { x: 100, y: 100 }, active: true },
            { id: 2, kind: 'armour', pos: { x: 140, y: 100 }, active: false },
          ],
        },
      } as unknown as Partial<Scene>),
      CAM,
      VIEW,
    );
    const drawn = instances(fx);
    expect(drawn).toHaveLength(1);
    expect(sameColor(drawn[0]!.color, expected(PICKUP_COLORS['health']!))).toBe(true);
    // It floats and bobs, rather than lying in the road.
    expect(drawn[0]!.z).toBeGreaterThan(1);
  });

  it('lays a dropped weapon flat instead of floating it', () => {
    // A gun lies where its owner fell. It should read as litter you can pick
    // up, not as a crate somebody put there — which is exactly the distinction
    // the 2D renderer draws, and the reason it does not bob.
    const fx = layer();
    fx.setMap(emptyMap());
    fx.update(
      emptyScene({
        remotes: {
          ...emptyScene().remotes,
          pickups: [{ id: 3, kind: 'weapon', pos: { x: 100, y: 100 }, active: true }],
        },
      } as unknown as Partial<Scene>),
      CAM,
      VIEW,
    );
    const [gun] = instances(fx);
    expect(gun).toBeDefined();
    expect(gun!.z).toBeLessThan(2);
    // Long and thin, not a cube.
    expect(gun!.sx).toBeGreaterThan(gun!.sz * 2);
  });

  it('shows a signal in the phase the traffic is obeying', () => {
    // `signalColour` is the function the drivers consult. Reading the phase off
    // anything else is how a renderer ends up showing green to a player while
    // the cars in front of them sit at a red.
    // `kerb` rather than a constant: §51 measures each head's own distance
    // out to the pavement, because a fixed 9px is half a tile and the
    // approach half of a four-tile arterial is two tiles wide — 398 of the
    // city's 561 posts were standing in a traffic lane.
    const heads = [{ x: 200, y: 160, junctionId: 3, dirIdx: 1, kerb: 26 }];
    const fx = layer();
    fx.setMap(emptyMap({ junctions: { heads } } as unknown as Partial<CityMap>));

    for (const tick of [0, 40, 120, 400, 900]) {
      fx.update(emptyScene({ tick }), CAM, VIEW);
      const want = signalColour(3, 1, tick, getTrafficTuning().signals);
      const drawn = instances(fx);
      // A post and a head.
      expect(drawn).toHaveLength(2);
      const head = drawn.find((d) => sameColor(d.color, expected(SIGNAL_COLORS[want])));
      expect(head, `no ${want} head at tick ${tick}`).toBeDefined();
      // The head stands above its post, at the kerb on the driver's right.
      const ax = CARDINALS[1]![0]!;
      const ay = CARDINALS[1]![1]!;
      expect(head!.x).toBeCloseTo(200 + ax * 5 - ay * heads[0]!.kerb, 5);
      expect(head!.y).toBeCloseTo(160 + ay * 5 + ax * heads[0]!.kerb, 5);
      expect(head!.z).toBeGreaterThan(drawn.find((d) => d !== head)!.z);
    }
  });

  it('greys a package once it has been found', () => {
    const map = emptyMap({ packages: [{ x: 120, y: 120 }] } as unknown as Partial<CityMap>);
    const fx = layer();
    fx.setMap(map);

    fx.update(emptyScene(), CAM, VIEW);
    expect(sameColor(instances(fx)[0]!.color, expected(PACKAGE_COLOR))).toBe(true);

    fx.update(emptyScene({ foundPackages: new Set([0]) }), CAM, VIEW);
    expect(sameColor(instances(fx)[0]!.color, expected(PACKAGE_TAKEN))).toBe(true);
  });

  it('writes nothing for what is off screen', () => {
    // The city is 240 tiles square and every junction arm has a head. Without
    // the cull the pools would be asked to hold the whole city.
    const fx = layer();
    fx.setMap(emptyMap({ packages: [{ x: 5000, y: 5000 }] } as unknown as Partial<CityMap>));
    fx.update(
      emptyScene({
        remotes: {
          ...emptyScene().remotes,
          pickups: [{ id: 9, kind: 'health', pos: { x: 4000, y: 4000 }, active: true }],
        },
      } as unknown as Partial<Scene>),
      CAM,
      VIEW,
    );
    expect(instances(fx)).toHaveLength(0);
  });

  it('draws a rocket along its flight, and a mine that blinks', () => {
    const fx = layer();
    fx.setMap(emptyMap());
    const projectiles = [
      { projectile: { kind: 'rocket', vel: { x: 1, y: 0 } }, x: 100, y: 100 },
      { projectile: { kind: 'mine', vel: { x: 0, y: 0 } }, x: 200, y: 100 },
      { projectile: { kind: 'slick', vel: { x: 0, y: 0 } }, x: 300, y: 100 },
    ];
    fx.update(
      emptyScene({ remotes: { ...emptyScene().remotes, projectiles } } as unknown as Partial<Scene>),
      CAM,
      VIEW,
    );
    expect(instances(fx)).toHaveLength(3);

    // The mine's colour has to change with the blink, or it reads as litter.
    const colourAt = (nowMs: number): THREE.Color => {
      fx.update(
        emptyScene({
          nowMs,
          remotes: { ...emptyScene().remotes, projectiles: [projectiles[1]] },
        } as unknown as Partial<Scene>),
        CAM,
        VIEW,
      );
      return instances(fx)[0]!.color;
    };
    expect(sameColor(colourAt(0), colourAt(600))).toBe(false);
  });
});
