import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Hand-built fallback bodies.
 *
 * Almost everything is now extruded from `shared/data/sprites.json` by
 * `spriteMesh.ts` — same art as the 2D renderer, same variants, same tuned
 * proportions. These two survive for the case that generator cannot serve: a
 * vehicle kind the sprite sheet has no entry for yet. Without them a missing
 * sprite is an invisible car rather than a plain one.
 *
 * Each model is a handful of boxes merged into **one** geometry carrying
 * per-vertex colours. That is the whole trick that keeps this affordable: a
 * car with a dark cabin, a windscreen and four black wheels is still a single
 * `InstancedMesh` draw, because the colour variation lives in the vertex
 * buffer rather than in separate materials. Splitting a car into six meshes
 * would multiply every draw call by six and there are a hundred cars.
 *
 * They are deliberately blocky. Cel shading wants flat faces — a smooth,
 * dense mesh gives the banding nothing to land on and reads as plastic — and
 * the silhouette is what the player actually reads at this camera distance.
 *
 * Sizes are in world px and come from `vehicles.json` where the sim has an
 * opinion, so the model still fits the collider it is drawn for.
 */

type RGB = [number, number, number];

const hex = (n: number): RGB => [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];

/** A coloured box, positioned and optionally rotated, ready to merge. */
function part(
  w: number,
  d: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  rotZ = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, d, h);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  const c = hex(color);
  const n = (g.attributes['position'] as THREE.BufferAttribute).count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g ?? new THREE.BoxGeometry(1, 1, 1);
}

const TYRE = 0x1a1c20;
const GLASS = 0x2f4358;
const TRIM = 0x2a2e36;

/**
 * A car.
 *
 * `along`/`across` are the collider half-extents, so the model is exactly as
 * long and wide as the thing the simulation resolves against — a car that
 * looks narrower than its hitbox produces "I didn't touch that" complaints
 * that are really rendering complaints.
 *
 * +x is forward, matching the sprite convention the 2D renderer uses.
 */
export function carGeometry(along: number, across: number, bodyColor: number): THREE.BufferGeometry {
  const L = along * 2;
  const W = across * 2;
  const bodyH = 5;
  const cabinH = 4;
  const wheelR = 1.8;

  return merge([
    // Chassis, sitting on the wheels.
    part(L, W, bodyH, 0, 0, wheelR + bodyH / 2, bodyColor),
    // Cabin, set back and inboard so the bonnet reads as a bonnet.
    part(L * 0.44, W * 0.82, cabinH, -L * 0.04, 0, wheelR + bodyH + cabinH / 2 - 0.4, bodyColor),
    // Windscreen and rear glass: thin dark slabs at the cabin ends.
    part(L * 0.06, W * 0.72, cabinH * 0.8, L * 0.16, 0, wheelR + bodyH + cabinH / 2 - 0.4, GLASS),
    part(L * 0.06, W * 0.72, cabinH * 0.8, -L * 0.24, 0, wheelR + bodyH + cabinH / 2 - 0.4, GLASS),
    // Wheels, proud of the body so the silhouette has corners.
    part(wheelR * 2, 1.6, wheelR * 2, L * 0.3, W / 2 - 0.4, wheelR, TYRE),
    part(wheelR * 2, 1.6, wheelR * 2, L * 0.3, -W / 2 + 0.4, wheelR, TYRE),
    part(wheelR * 2, 1.6, wheelR * 2, -L * 0.3, W / 2 - 0.4, wheelR, TYRE),
    part(wheelR * 2, 1.6, wheelR * 2, -L * 0.3, -W / 2 + 0.4, wheelR, TYRE),
  ]);
}





/**
 * A person: legs, torso, head, and a shoulder line.
 *
 * Five boxes rather than one, because the top-down silhouette of a human is
 * the one thing that tells a player where somebody is facing, and a single
 * box facing any direction looks identical.
 */
export function personGeometry(skin: number, shirt: number, trousers: number): THREE.BufferGeometry {
  return merge([
    part(2.6, 4.6, 3.4, 0, 0, 1.7, trousers),
    part(3.0, 5.0, 3.6, 0, 0, 5.2, shirt),
    // Shoulders, wider than the torso so a figure reads as facing across.
    part(2.2, 6.2, 1.6, 0, 0, 6.4, shirt),
    // Arms, slightly forward: gives the silhouette a front.
    part(1.6, 1.4, 3.0, 0.8, 3.0, 5.0, skin),
    part(1.6, 1.4, 3.0, 0.8, -3.0, 5.0, skin),
    part(2.8, 2.8, 2.4, 0.2, 0, 8.4, skin),
  ]);
}
