import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Low-poly bodies for everything that moves.
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

/** A bus or truck: taller, flat-fronted, with a separate cab band. */
export function boxVehicleGeometry(
  along: number,
  across: number,
  bodyColor: number,
  height: number,
): THREE.BufferGeometry {
  const L = along * 2;
  const W = across * 2;
  const wheelR = 2.2;
  return merge([
    part(L, W, height, 0, 0, wheelR + height / 2, bodyColor),
    // Windscreen band across the front, and a window strip down each side.
    part(L * 0.05, W * 0.86, height * 0.4, L * 0.48, 0, wheelR + height * 0.72, GLASS),
    part(L * 0.8, 0.6, height * 0.3, 0, W / 2, wheelR + height * 0.72, GLASS),
    part(L * 0.8, 0.6, height * 0.3, 0, -W / 2, wheelR + height * 0.72, GLASS),
    part(wheelR * 2, 1.8, wheelR * 2, L * 0.34, W / 2 - 0.4, wheelR, TYRE),
    part(wheelR * 2, 1.8, wheelR * 2, L * 0.34, -W / 2 + 0.4, wheelR, TYRE),
    part(wheelR * 2, 1.8, wheelR * 2, -L * 0.34, W / 2 - 0.4, wheelR, TYRE),
    part(wheelR * 2, 1.8, wheelR * 2, -L * 0.34, -W / 2 + 0.4, wheelR, TYRE),
  ]);
}

/**
 * An aeroplane: fuselage, wings, tailplane and fin.
 *
 * Wings span well past the collider, which is correct — the sim collides a
 * plane by its body, and a wing that clipped a lamp post would be a different
 * and much larger design decision.
 */
export function planeGeometry(along: number, across: number, bodyColor: number): THREE.BufferGeometry {
  const L = along * 2;
  const span = Math.max(across * 2 * 2.6, L * 0.9);
  return merge([
    part(L, L * 0.16, L * 0.16, 0, 0, 4, bodyColor),
    // Nose, tapered by using a shorter, thinner box in front.
    part(L * 0.18, L * 0.1, L * 0.1, L * 0.55, 0, 4, TRIM),
    // Cockpit glass on top of the fuselage.
    part(L * 0.2, L * 0.12, L * 0.07, L * 0.18, 0, 4 + L * 0.1, GLASS),
    // Main wing.
    part(L * 0.22, span, 1.2, -L * 0.02, 0, 4, bodyColor),
    // Tailplane and fin.
    part(L * 0.12, span * 0.34, 1.0, -L * 0.42, 0, 4, bodyColor),
    part(L * 0.12, 1.0, L * 0.22, -L * 0.44, 0, 4 + L * 0.12, bodyColor),
  ]);
}

/** A helicopter: body, skids, tail boom and a rotor disc. */
export function helicopterGeometry(
  along: number,
  across: number,
  bodyColor: number,
): THREE.BufferGeometry {
  const L = along * 2;
  const W = across * 2;
  return merge([
    part(L * 0.55, W, L * 0.3, L * 0.08, 0, 6, bodyColor),
    part(L * 0.2, W * 0.7, L * 0.22, L * 0.32, 0, 6, GLASS),
    part(L * 0.5, W * 0.18, L * 0.1, -L * 0.38, 0, 7, bodyColor),
    part(L * 0.14, W * 0.16, L * 0.26, -L * 0.58, 0, 8, bodyColor),
    // Rotor: a thin cross, which at this distance reads as a disc in motion.
    part(L * 1.1, 1.2, 0.8, 0, 0, 6 + L * 0.2, TRIM),
    part(1.2, L * 1.1, 0.8, 0, 0, 6 + L * 0.2, TRIM),
    // Skids.
    part(L * 0.5, 0.9, 0.9, 0, W * 0.42, 1.2, TRIM),
    part(L * 0.5, 0.9, 0.9, 0, -W * 0.42, 1.2, TRIM),
  ]);
}

/** A boat: hull with a pointed bow and a small wheelhouse. */
export function boatGeometry(along: number, across: number, bodyColor: number): THREE.BufferGeometry {
  const L = along * 2;
  const W = across * 2;
  return merge([
    part(L * 0.8, W, 4, -L * 0.05, 0, 2, bodyColor),
    part(L * 0.3, W * 0.6, 4, L * 0.42, 0, 2, bodyColor, 0),
    part(L * 0.25, W * 0.6, 4, -L * 0.15, 0, 5, TRIM),
    part(L * 0.16, W * 0.5, 2.4, -L * 0.14, 0, 7.4, GLASS),
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
