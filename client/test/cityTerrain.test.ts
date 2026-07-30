import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_DECK_Z,
  RAMP_Z,
  T_BRIDGE,
  T_RAMP,
  T_ROAD,
  T_RUNWAY,
  T_SAND,
  T_TREES,
  TILE_SIZE,
  TREE_Z,
  type CityMap,
} from 'shared';
import palette from 'shared/data/palette.json';
import { buildCity, drawnSpans, isCarriageway } from '../src/three/cityGeometry.js';

/**
 * What the 3D city is made of, and at what height.
 *
 * Two families of bug live here and both were visible from the pavement.
 *
 * **Height.** `volume.ts` models the city the 3D collision will resolve
 * against once the simulation adopts it — a bridge deck 40 px up with a river
 * underneath. Nothing in the simulation uses it yet: `step()` collides on the
 * flat tile grid and pins every land vehicle to `z = 0`. Drawing the volume
 * grid literally therefore built a city the game was not being played in, and
 * traffic crossing a bridge disappeared under its own deck for the length of
 * the span.
 *
 * **Colour.** Fourteen terrain types were being drawn in three colours, so a
 * beach rendered as an industrial yard and a runway was striped like a
 * B-road — while `palette.json` had `sand`, `trees`, `park`, `field`, `bank`
 * and `runway` in it the whole time.
 */

function hex(s: string): number {
  return parseInt(s.replace('#', ''), 16);
}

/** Only what is inside the window: the edge skirt is not a terrain type. */
function inWindow(
  map: CityMap,
  list: Array<{ x: number; y: number; top: number; color: number }>,
): Array<{ x: number; y: number; top: number; color: number }> {
  const w = map.widthTiles * TILE_SIZE;
  const h = map.heightTiles * TILE_SIZE;
  return list.filter((s) => s.x >= 0 && s.y >= 0 && s.x <= w && s.y <= h);
}

/** A map of one tile type, with a couple of tiles overridden. */
function mapOf(
  fill: number,
  over: Array<[number, number, number]> = [],
  size = 12,
): CityMap {
  const tiles = new Uint8Array(size * size).fill(fill);
  for (const [tx, ty, t] of over) tiles[ty * size + tx] = t;
  return {
    widthTiles: size,
    heightTiles: size,
    tiles,
    buildings: [],
    shops: [],
    props: [],
    parkingSpots: [],
    vehicleSpawns: [],
    pickups: [],
    landmarks: [],
  } as unknown as CityMap;
}

/** Every instance in the built city, as {x, y, top, colour}. */
function surfaces(map: CityMap): Array<{ x: number; y: number; top: number; color: number }> {
  const { group } = buildCity(map);
  const out: Array<{ x: number; y: number; top: number; color: number }> = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const q = new THREE.Quaternion();
  group.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const mat = mesh.material as THREE.MeshToonMaterial;
    // The outline twins are a black hull over their source mesh; they carry no
    // information about what the surface is.
    if (!mat.color || mat.type !== 'MeshToonMaterial') return;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(pos, q, scl);
      out.push({ x: pos.x, y: pos.y, top: pos.z + scl.z / 2, color: mat.color.getHex() });
    }
  });
  return out;
}

describe('the 3D city, against the world the simulation runs', () => {
  it('lays the bridge deck at the height cars are actually driven at', () => {
    // `volume.ts` puts the deck at BRIDGE_DECK_Z with the river below it. The
    // sim drives at zero, so drawing it there swallowed the traffic.
    expect(BRIDGE_DECK_Z).toBeGreaterThan(0);
    const spans = drawnSpans(T_BRIDGE, [
      { bottom: -4096, top: -8 },
      { bottom: BRIDGE_DECK_Z, top: BRIDGE_DECK_Z + 6 },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.top).toBe(0);
    // And the drowned river span is dropped rather than redrawn: it was being
    // emitted into the deck's own bucket, which paved the water under every
    // bridge in the city.
    expect(spans[0]!.bottom).toBeLessThan(0);
  });

  it('lays a ramp at street level too', () => {
    // A stunt ramp launches a car by `frenzy.ts` reading the tile type, not by
    // being a surface it climbs.
    const spans = drawnSpans(T_RAMP, [{ bottom: -4096, top: RAMP_Z }]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.top).toBe(0);
  });

  it('leaves solid volumes alone', () => {
    // Woodland is solid to anything on the ground — `isSolidTile` agrees — so
    // its 36 px canopy is right and only its colour was wrong.
    const spans = drawnSpans(T_TREES, [{ bottom: -4096, top: TREE_Z }]);
    expect(spans[0]!.top).toBe(TREE_Z);
  });

  it('draws no bridge surface above the road that feeds it', () => {
    const map = mapOf(T_ROAD, [
      [5, 5, T_BRIDGE],
      [6, 5, T_BRIDGE],
    ]);
    // The rails stand up, as a parapet should; the SURFACE does not.
    const kerb = hex(palette.kerb as string);
    for (const s of surfaces(map)) {
      if (s.color === kerb) continue;
      expect(s.top).toBeLessThanOrEqual(0);
    }
  });

  it('gives woodland, beach and runway the palette colours the 2D layer uses', () => {
    const seen = (fill: number): Set<number> => {
      const map = mapOf(fill);
      return new Set(inWindow(map, surfaces(map)).map((s) => s.color));
    };
    // Each of these used to come out as one of three colours: field green,
    // industrial-lot olive, or road grey.
    expect(seen(T_TREES)).toContain(hex(palette.trees as string));
    expect(seen(T_SAND)).toContain(hex(palette.sand as string));
    expect(seen(T_RUNWAY)).toContain(hex(palette.runway as string));
    // ...and none of them is the road or the lot any more.
    expect(seen(T_SAND)).not.toContain(hex(palette.lot as string));
    expect(seen(T_RUNWAY)).not.toContain(hex(palette.road as string));
  });

  it('does not stripe the runway like a street', () => {
    // `isRoad` counted T_RUNWAY, so the carriageway centre-line rule painted a
    // dashed road marking down the one surface an aeroplane can take off from.
    expect(isCarriageway(T_ROAD)).toBe(true);
    // A bridge still counts: it is the same street, and the 2D painter agrees.
    expect(isCarriageway(T_BRIDGE)).toBe(true);
    expect(isCarriageway(T_RUNWAY)).toBe(false);
  });

  it('carries the road surface across a bridge', () => {
    // The marking rule only ran for tiles keyed `road`, and a bridge was keyed
    // `deck` — so the centre line stopped dead at the riverbank. Both are the
    // carriageway now, so the whole street is one surface.
    const size = 12;
    const span = Array.from(
      { length: size },
      (_, ty) => [5, ty, T_BRIDGE] as [number, number, number],
    );
    const map = mapOf(T_ROAD, span, size);
    const ground = inWindow(map, surfaces(map)).filter((s) => s.top === 0);
    const colors = new Set(ground.map((s) => s.color));
    expect(colors.size).toBe(1);
    expect(colors).toContain(hex(palette.road as string));
  });

  it('puts ground beyond the window so the world does not end in sky', () => {
    const map = mapOf(T_ROAD);
    const w = map.widthTiles * TILE_SIZE;
    const far = surfaces(map).filter((s) => s.top <= 0);
    // Something is drawn outside the map's own footprint.
    const { group } = buildCity(map);
    let outside = 0;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const q = new THREE.Quaternion();
    group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        m.decompose(pos, q, scl);
        if (pos.x + scl.x / 2 > w + TILE_SIZE) outside++;
      }
    });
    expect(far.length).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });
});
