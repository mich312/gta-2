import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { type PropState, initTuning } from 'shared';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import trafficJson from 'shared/data/traffic.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
import { SceneryLayer } from '../src/three/scenery.js';

/**
 * The props the sim owns, in 3D — and specifically what the layer SUBMITS.
 *
 * The pools are 192 instances each and are never retired, so what the tail of
 * a pool does is most of what the layer costs. It used to zero-scale that
 * tail: invisible, but still transformed, still counted, and still walked by
 * the shadow pass — and by the outline twin, which shares the same instance
 * buffer. Eight kinds live (four props × intact/broken) meant ~1536 instances
 * submitted every frame to draw the few dozen actually on screen, on a layer
 * that runs off `requestAnimationFrame` with no dirty check.
 *
 * `Pool.end` (entities) and `SolidPool.end` (world objects) both shorten
 * `count` instead, for exactly this reason. These tests hold the props to the
 * same rule.
 *
 * Testable in node: `SceneryLayer` takes an `Object3D`, not a renderer.
 */

/** A prop the layer will accept, at a position of its own. */
function prop(id: number, kind: string, intact = true): PropState {
  return {
    id,
    kind,
    pos: { x: 100 + id * 16, y: 200 },
    orient: 0,
    intact,
    hp: 10,
    respawnAtTick: null,
  };
}

/** Every instanced mesh under the layer, twins included. */
function meshes(layer: SceneryLayer): THREE.InstancedMesh[] {
  const group = (layer as unknown as { group: THREE.Group }).group;
  return group.children.filter(
    (c) => (c as THREE.InstancedMesh).isInstancedMesh,
  ) as THREE.InstancedMesh[];
}

/** How many instances the layer's props would hand the GPU this frame. */
function submitted(layer: SceneryLayer): number {
  return meshes(layer).reduce((n, m) => n + m.count, 0);
}

describe('prop pools', () => {
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

  it('submits the props that are there, not the pool they sit in', () => {
    const layer = new SceneryLayer(new THREE.Group());
    const props = [prop(1, 'bin'), prop(2, 'bin'), prop(3, 'lamp')];
    layer.updateProps(props);

    // A mesh and its outline twin per kind, so two kinds is four meshes and
    // three props is six instances. The tail is not submitted at all.
    expect(meshes(layer).length).toBe(4);
    expect(submitted(layer)).toBe(props.length * 2);
  });

  it('shortens the twin along with the mesh', () => {
    // The twin shares the mesh's `instanceMatrix`, so leaving its count alone
    // would draw the parked tail once more with the outline material — the
    // half of the cost that is easiest to forget.
    const layer = new SceneryLayer(new THREE.Group());
    layer.updateProps([prop(1, 'bin')]);
    for (const m of meshes(layer)) expect(m.count).toBe(1);
  });

  it('grows back after a frame with fewer props', () => {
    // The trap in shortening `count`: it is the draw length, not the
    // capacity, so a placement loop that guards against `mesh.count` can
    // never fill a pool again once it has been emptied.
    const layer = new SceneryLayer(new THREE.Group());
    const many = Array.from({ length: 40 }, (_, i) => prop(i, 'bin'));
    layer.updateProps(many);
    expect(submitted(layer)).toBe(80);
    layer.updateProps([prop(0, 'bin')]);
    expect(submitted(layer)).toBe(2);
    layer.updateProps(many);
    expect(submitted(layer)).toBe(80);
  });

  it('drops props past the pool rather than overrunning it', () => {
    // Pools are a fixed 192 and the layer places into them without growing
    // them, so the guard has to hold whatever the capacity is.
    const layer = new SceneryLayer(new THREE.Group());
    layer.updateProps(Array.from({ length: 500 }, (_, i) => prop(i, 'bin')));
    const [mesh] = meshes(layer) as [THREE.InstancedMesh];
    expect(mesh.count).toBeLessThanOrEqual(mesh.instanceMatrix.count);
    expect(mesh.count).toBe(mesh.instanceMatrix.count);
  });

  it('empties the pool when every prop of a kind goes away', () => {
    // An instance that is not written keeps last frame's matrix, so this is
    // the case shortening `count` has to get right: a bin nobody can see must
    // not go on being drawn where it was.
    const layer = new SceneryLayer(new THREE.Group());
    layer.updateProps([prop(1, 'bin'), prop(2, 'bin')]);
    layer.updateProps([]);
    expect(submitted(layer)).toBe(0);
  });
});
