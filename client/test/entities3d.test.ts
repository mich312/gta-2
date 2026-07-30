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

/** Which body pools have anything in them, by sprite name. */
function drawn(layer: EntityLayer): Map<string, number> {
  const bodies = (layer as unknown as { bodies: Map<string, { mesh: THREE.InstancedMesh }> })
    .bodies;
  const out = new Map<string, number>();
  for (const [name, pool] of bodies) {
    const mesh = pool.mesh;
    let n = 0;
    const m = new THREE.Matrix4();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const e = m.elements;
      const len = Math.hypot(e[0] as number, e[1] as number, e[2] as number);
      if (len > 0) n++;
    }
    if (n > 0) out.set(name, n);
  }
  return out;
}

/** How many instances the standing-pedestrian pool placed. */
function standing(layer: EntityLayer, which: 'peds' | 'players'): number {
  const pool = (layer as unknown as Record<string, { mesh: THREE.InstancedMesh }>)[which]!;
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < pool.mesh.count; i++) {
    pool.mesh.getMatrixAt(i, m);
    const e = m.elements;
    if (Math.hypot(e[0] as number, e[1] as number, e[2] as number) > 0) n++;
  }
  return n;
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

    const pools = (fx as unknown as { vehicles: Map<string, { mesh: THREE.InstancedMesh }> })
      .vehicles;
    const shades: number[] = [];
    for (const pool of pools.values()) {
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
});
