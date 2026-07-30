import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { getVehicleTuning, initTuning } from 'shared';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import trafficJson from 'shared/data/traffic.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
import type { RenderWorld } from '../src/net/interpolation.js';
import { COP_SPRITE, deadPose } from '../src/render/renderer.js';
import { EntityLayer } from '../src/three/entities.js';

/**
 * Bodies, police tiers and battered cars in 3D.
 *
 * The gap this closes is the one that was hardest not to notice: a dead
 * pedestrian in 3D **stood up in the middle of the road**. Somebody on the
 * ground is a different drawing from somebody standing — you are looking down
 * at a back, not at a head and two shoulders — and the sheet has carried
 * `pedDowned`, `pedDeadA/B`, `copDead` and `playerDeadA/B` all along. The 3D
 * layer drew the standing figure for every state.
 *
 * The layer keys its pools by sprite name, so what these tests read back is
 * which drawing each body actually got.
 */

function emptyWorld(over: Partial<RenderWorld> = {}): RenderWorld {
  return {
    players: [],
    vehicles: [],
    cops: [],
    peds: [],
    props: [],
    pickups: [],
    projectiles: [],
    ...over,
  } as unknown as RenderWorld;
}

type Pools = Map<string, { mesh: THREE.InstancedMesh }>;

/** Every pool the layer has, keyed `sprite#variant#frame`. */
function poolsOf(layer: EntityLayer): Pools {
  return (layer as unknown as { pools: Pools }).pools;
}

/** How many instances a pool actually placed this frame. */
function placed(mesh: THREE.InstancedMesh): number {
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    const e = m.elements;
    if (Math.hypot(e[0] as number, e[1] as number, e[2] as number) > 0) n++;
  }
  return n;
}

/**
 * Bodies drawn this frame, summed by SPRITE NAME.
 *
 * Pools are keyed by sprite, colourway and walk frame — all three change the
 * geometry — so a crowd of pedestrians is spread across several pools of the
 * same drawing. What these tests care about is which drawing each body got,
 * so the variant and frame are summed away here.
 */
function drawn(layer: EntityLayer): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, pool] of poolsOf(layer)) {
    const n = placed(pool.mesh);
    if (n === 0) continue;
    const name = key.split('#')[0] as string;
    out.set(name, (out.get(name) ?? 0) + n);
  }
  return out;
}

/** How many bodies are drawn on their feet, as pedestrians or as players. */
function standing(layer: EntityLayer, which: 'peds' | 'players'): number {
  return drawn(layer).get(which === 'peds' ? 'ped' : 'player') ?? 0;
}

function ped(id: number, mode: string): unknown {
  return {
    ped: { id, mode, dirX: 1, dirY: 0, gangId: 0, timer: 60, escortOf: null },
    x: 100 + id * 10,
    y: 100,
  };
}

describe('bodies and vehicles in 3D', () => {
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

  function layer(): EntityLayer {
    return new EntityLayer(new THREE.Group());
  }

  it('lays a dead pedestrian down instead of standing them up', () => {
    const fx = layer();
    fx.update(emptyWorld({ peds: [ped(1, 'dead'), ped(2, 'downed'), ped(3, 'walk')] } as never), -1);
    const pools = drawn(fx);
    // Downed is still on the bleed-out clock and holds its own pose; dead takes
    // one of the sprawls, hashed off the id so it is the same body everywhere.
    expect(pools.get('pedDowned')).toBe(1);
    expect(pools.get(`pedDead${deadPose(1)}`)).toBe(1);
    // Exactly one of them is upright.
    expect(standing(fx, 'peds')).toBe(1);
  });

  it('gives each police tier its own figure, and a downed one a body', () => {
    // A tier used to be the patrol figure under a different tint, which reads as
    // "that officer is standing in a different light" rather than as "that is a
    // different force".
    const cops = ['patrol', 'swat', 'fed', 'army'].map((kind, i) => ({
      cop: { id: i + 1, kind, health: 100, vel: { x: 1, y: 0 }, idleTicks: 0 },
      x: 100 + i * 20,
      y: 200,
    }));
    cops.push({
      cop: { id: 9, kind: 'patrol', health: 0, vel: { x: 0, y: 0 }, idleTicks: 30 },
      x: 300,
      y: 200,
    });
    const fx = layer();
    fx.update(emptyWorld({ cops } as never), -1);
    const pools = drawn(fx);
    for (const kind of ['patrol', 'swat', 'fed', 'army']) {
      expect(pools.get(COP_SPRITE[kind]!), `no figure for ${kind}`).toBe(1);
    }
    expect(pools.get('copDead')).toBe(1);
  });

  it('lays a dead player down, local or remote', () => {
    const fx = layer();
    fx.update(
      emptyWorld({
        players: [
          { player: { id: 5, mode: 'dead', aimAngle: 0, z: 0 }, x: 100, y: 300 },
          { player: { id: 6, mode: 'foot', aimAngle: 0, z: 0 }, x: 140, y: 300 },
        ],
      } as never),
      -1,
      { player: { x: 200, y: 300, z: 0, heading: 0, id: 7, mode: 'dead' } },
    );
    const pools = drawn(fx);
    expect(pools.get(`playerDead${deadPose(5)}`)).toBe(1);
    expect(pools.get(`playerDead${deadPose(7)}`)).toBe(1);
    expect(standing(fx, 'players')).toBe(1); // only the live remote
  });

  it('marks somebody you are meant to be protecting', () => {
    // An unmarked NPC you must protect is a mission you fail without ever
    // knowing which person mattered.
    const escorted = {
      ped: { id: 4, mode: 'walk', dirX: 1, dirY: 0, gangId: 0, timer: 60, escortOf: 1 },
      x: 100,
      y: 400,
    };
    const fx = layer();
    fx.update(emptyWorld({ peds: [escorted, ped(5, 'walk')] } as never), -1);
    const escorts = (fx as unknown as { escorts: { mesh: THREE.InstancedMesh } | null }).escorts;
    expect(escorts).not.toBeNull();
    const m = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < escorts!.mesh.count; i++) {
      escorts!.mesh.getMatrixAt(i, m);
      const e = m.elements;
      if (Math.hypot(e[0] as number, e[1] as number, e[2] as number) > 0) n++;
    }
    expect(n).toBe(1); // the escorted one, not the bystander
  });

  it('darkens a car as it takes damage', () => {
    // The 2D renderer draws real dents; a merged sprite mesh cannot lose a panel
    // without being rebuilt, so the same information arrives as paint that has
    // been through a wall.
    const car = (id: number, health: number): unknown => ({
      vehicle: {
        id,
        kind: 'car',
        driverId: null,
        speed: 0,
        broken: 0,
        condition: 'ok',
        health,
        z: 0,
      },
      x: 100 + id * 30,
      y: 500,
      heading: 0,
    });
    // Full health comes off the tuning, not a guess: a car is not 100.
    const full = getVehicleTuning('car').health;
    const fx = layer();
    fx.update(emptyWorld({ vehicles: [car(1, full), car(2, full * 0.05)] } as never), -1);

    const shades: number[] = [];
    for (const pool of poolsOf(fx).values()) {
      const col = pool.mesh.instanceColor;
      if (!col) continue;
      const m = new THREE.Matrix4();
      for (let i = 0; i < pool.mesh.count; i++) {
        pool.mesh.getMatrixAt(i, m);
        const e = m.elements;
        if (Math.hypot(e[0] as number, e[1] as number, e[2] as number) > 0) shades.push(col.getX(i));
      }
    }
    expect(shades).toHaveLength(2);
    shades.sort((a, b) => a - b);
    // The battered one is darker, and the fresh one is left alone entirely.
    expect(shades[1]).toBeCloseTo(1, 5);
    expect(shades[0]).toBeLessThan(0.85);
    // ...but still recognisably the colour of car it is, not black.
    expect(shades[0]).toBeGreaterThan(0.5);
  });

  /** A vehicle as the wire carries it. */
  function veh(over: Record<string, unknown>): unknown {
    return {
      vehicle: {
        id: 1,
        kind: 'car',
        driverId: null,
        speed: 0,
        broken: 0,
        condition: 'ok',
        health: 1000,
        z: 0,
        paint: -1,
        gangId: 0,
        ...over,
      },
      x: 100,
      y: 100,
      heading: 0,
      ...(over['at'] as object),
    };
  }

  /**
   * Where each placed instance of a sprite is, and which way it faces.
   *
   * Read straight off the matrix elements rather than through `decompose`,
   * which normalises a parked (zero-scale) instance back to unit scale and so
   * cannot tell one from a real body. Bodies are composed with unit scale
   * about +Z, so the first column is (cos, sin) and the translation is the
   * last one.
   */
  function instances(layer: EntityLayer, sprite: string): Array<{ x: number; y: number; yaw: number }> {
    const out: Array<{ x: number; y: number; yaw: number }> = [];
    const m = new THREE.Matrix4();
    for (const [key, pool] of poolsOf(layer)) {
      if (key.split('#')[0] !== sprite) continue;
      for (let i = 0; i < pool.mesh.count; i++) {
        pool.mesh.getMatrixAt(i, m);
        const e = m.elements;
        const sx = Math.hypot(e[0] as number, e[1] as number, e[2] as number);
        if (sx === 0) continue;
        out.push({
          x: e[12] as number,
          y: e[13] as number,
          yaw: Math.atan2(e[1] as number, e[0] as number),
        });
      }
    }
    return out;
  }

  it('gives the tank a turret, pointed where its driver is pointing', () => {
    // `tank_turret` has been in the sheet all along and the 2D renderer has
    // always traversed it to the driver's aim. The 3D layer had no turret code
    // at all, so the tank was a bare hull with nothing to say where its gun was.
    const off = getVehicleTuning('tank').turretOffset;
    expect(off, 'the tank is the turreted case').not.toBeNull();
    const fx = layer();
    fx.update(
      emptyWorld({ vehicles: [veh({ kind: 'tank', id: 3, driverId: 9 })] } as never),
      -1,
      undefined,
    );
    // With nobody the renderer can see at the wheel, the gun rests along the hull.
    const resting = instances(fx, 'tank_turret');
    expect(resting).toHaveLength(1);
    expect(resting[0]!.yaw).toBeCloseTo(0, 5);
    // The pivot is offset ALONG the hull, not at its centre.
    expect(resting[0]!.x).toBeCloseTo(100 + (off as number), 5);

    // Now with a driver aiming somewhere else entirely.
    const aimed = layer();
    aimed.update(
      emptyWorld({
        vehicles: [veh({ kind: 'tank', id: 3, driverId: 9 })],
        players: [{ player: { id: 9, mode: 'driving', aimAngle: 1.2, z: 0, cosmeticId: 0 }, x: 100, y: 100, aimAngle: 1.2 }],
      } as never),
      -1,
    );
    const t = instances(aimed, 'tank_turret');
    expect(t).toHaveLength(1);
    // A turret is the one part that does NOT turn with the body.
    expect(t[0]!.yaw).toBeCloseTo(1.2, 5);
  });

  it('puts somebody on a motorcycle, and nobody on an empty one', () => {
    // Traffic runs motos at weight 5 and bicycles at 4, all with AI drivers.
    // Without this the 3D city had driverless bikes cruising it at 60 px/s.
    const seat = getVehicleTuning('moto').riderOffset;
    expect(seat, 'the moto is the ridden case').not.toBeNull();

    const ridden = layer();
    ridden.update(emptyWorld({ vehicles: [veh({ kind: 'moto', id: 4, driverId: -7 })] } as never), -1);
    const on = instances(ridden, 'ped');
    expect(on, 'an AI driver falls back to a pedestrian, as it does in 2D').toHaveLength(1);
    expect(on[0]!.x).toBeCloseTo(100 + (seat as number), 5);

    const empty = layer();
    empty.update(emptyWorld({ vehicles: [veh({ kind: 'moto', id: 4, driverId: null })] } as never), -1);
    expect(instances(empty, 'ped')).toHaveLength(0);
  });

  it('keeps the driver inside the car rather than standing on its roof', () => {
    // The 2D renderer guards this at its call site (`mode !== 'driving'`); the
    // 3D one drew the predicted local player wherever they were, which while
    // driving is the middle of the car they are steering.
    const fx = layer();
    fx.update(emptyWorld({ vehicles: [veh({ kind: 'car', id: 2, driverId: 1 })] } as never), 1, {
      player: { x: 100, y: 100, z: 0, heading: 0, id: 1, mode: 'driving', cosmeticId: 0 },
      vehicle: { id: 2, kind: 'car', x: 100, y: 100, z: 0, heading: 0, wear: 0, paint: -1, gangId: 0, aim: 0 },
    });
    expect(instances(fx, 'player')).toHaveLength(0);
  });

  it('paints a car the colour the simulation says, not the colour of its id', () => {
    // `VehicleState.paint` exists because a rebase re-spawns every parked car
    // with a fresh id; a colour hashed off the id repainted the whole street in
    // front of the player when the window moved.
    const fx = layer();
    fx.update(
      emptyWorld({
        vehicles: [
          veh({ id: 11, paint: 4, at: { x: 100, y: 100 } }),
          veh({ id: 999, paint: 4, at: { x: 200, y: 100 } }),
          veh({ id: 11, paint: 7, at: { x: 300, y: 100 } }),
        ],
      } as never),
      -1,
    );
    const keys = [...poolsOf(fx).keys()].filter((k) => k.startsWith('car#'));
    // Two ids, one paint: one pool. A third car with the same id and a
    // different paint: a second.
    expect(new Set(keys).size).toBe(2);
    expect(keys.some((k) => k === 'car#4#0')).toBe(true);
    expect(keys.some((k) => k === 'car#7#0')).toBe(true);
  });

  it('gives a gang car its gang colours', () => {
    // Four liveries, and which one you see is how you read whose street you
    // are parked on. Hashing the id gave you somebody else's.
    const fx = layer();
    fx.update(
      emptyWorld({ vehicles: [veh({ kind: 'gangcar', id: 31, gangId: 3 })] } as never),
      -1,
    );
    expect([...poolsOf(fx).keys()]).toContain('gangcar#2#0');
  });

  it('walks the legs: a pedestrian on the move changes frame', () => {
    // `sprites.json` carries `frames: 4` and an `anim` block of per-shape
    // offsets, and `spriteMesh.ts` read neither — so every body in the city
    // slid along frozen in frame 0, which is what "the people do not move" was.
    const fx = layer();
    const frames = new Set<string>();
    for (let step = 0; step < 6; step++) {
      const walker = {
        ped: { id: 1, mode: 'walk', dirX: 1, dirY: 0, gangId: 0, timer: 60, escortOf: null },
        x: 100 + step * 8,
        y: 100,
      };
      fx.update(emptyWorld({ peds: [walker] } as never), -1);
      for (const [key, pool] of poolsOf(fx)) {
        if (key.startsWith('ped#') && placed(pool.mesh) > 0) frames.add(key);
      }
    }
    // Six strides of 8 px against a 7 px stride: more than one frame, and no
    // more than the four the sheet has.
    expect(frames.size).toBeGreaterThan(1);
    expect(frames.size).toBeLessThanOrEqual(4);
  });

  it('dresses the crowd in more than one shirt', () => {
    // `ped` has six colourways and the 3D layer built one pool at variant 0,
    // so the entire city wore the same shirt.
    const fx = layer();
    fx.update(
      emptyWorld({ peds: [ped(1, 'walk'), ped(2, 'walk'), ped(3, 'walk')] } as never),
      -1,
    );
    const variants = new Set(
      [...poolsOf(fx).keys()].filter((k) => k.startsWith('ped#')).map((k) => k.split('#')[1]),
    );
    expect(variants.size).toBe(3);
  });
});
