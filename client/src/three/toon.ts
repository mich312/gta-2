import * as THREE from 'three';

/**
 * The Chinatown Wars look: flat banded shading and a hard black outline.
 *
 * Two decisions, and both of them are also the cheap option, which is why
 * this art direction suits a small team:
 *
 * **Banded, not smooth.** `MeshToonMaterial` quantises diffuse light against
 * a gradient map. A one-pixel-per-step gradient gives hard bands — two or
 * three tones per surface instead of a continuous ramp. That reads as drawn
 * rather than rendered, and it hides low-poly geometry that smooth shading
 * would expose.
 *
 * **Outlines by inverted hull, not post-process.** Draw the mesh a second
 * time, slightly fattened along its normals, with front faces culled so only
 * the back of the swollen copy shows — a black silhouette a few pixels wide.
 * The alternative is a depth/normal edge-detect pass, which catches interior
 * creases too but costs a full-screen pass and a second render target. For a
 * city of boxes seen from above, the hull is the better trade: it works with
 * `InstancedMesh`, needs no render target, and the interior creases it misses
 * are exactly the ones the banding already draws.
 *
 * The palette stays the game's own (`shared/data/palette.json`). This changes
 * how light lands on a colour, not what the colours are.
 */

/** Cache: one gradient texture per band count, shared by every material. */
const gradients = new Map<number, THREE.DataTexture>();

/**
 * A `bands`-step gradient map.
 *
 * Nearest-filtered on purpose — bilinear would smooth the steps back out and
 * undo the whole effect.
 */
export function toonGradient(bands = 3): THREE.DataTexture {
  const cached = gradients.get(bands);
  if (cached) return cached;
  const data = new Uint8Array(bands);
  for (let i = 0; i < bands; i++) {
    // Skew the ramp so the lit band is wide and the shadow bands are narrow:
    // a surface in light should read as one flat colour, with the darks used
    // sparingly for edges.
    const t = (i + 1) / bands;
    data[i] = Math.round(255 * Math.pow(t, 0.65));
  }
  const tex = new THREE.DataTexture(data, bands, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradients.set(bands, tex);
  return tex;
}

export function toonMaterial(color: number, bands = 3): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(bands) });
}

/**
 * The outline material: an inverted hull.
 *
 * `side: BackSide` is what makes it an outline rather than a black blob — the
 * swollen copy's front faces are culled, so it is only visible where it pokes
 * out past the real mesh's silhouette.
 */
export function outlineMaterial(
  thickness: number,
  color = 0x0a0d12,
  welded = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    defines: welded ? { USE_OUTLINE_NORMAL: '' } : {},
    uniforms: { thickness: { value: thickness }, outlineColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `
      uniform float thickness;
      #ifdef USE_OUTLINE_NORMAL
        attribute vec3 outlineNormal;
      #endif
      #include <common>
      #include <skinning_pars_vertex>
      void main() {
        // Instanced meshes bring their transform in through instanceMatrix,
        // which three.js only injects when the shader asks for it. Without
        // this the whole hull collapses onto the origin.
        #ifdef USE_INSTANCING
          mat4 im = instanceMatrix;
        #else
          mat4 im = mat4(1.0);
        #endif
        vec4 mvPosition = modelViewMatrix * im * vec4(position, 1.0);
        // Fatten along the normal in VIEW space, so the outline keeps an
        // even width whatever the surface is facing.
        //
        // Welded normals where the geometry carries them (see
        // addOutlineNormals). The shading wants per-face normals and the
        // hull wants shared ones, so sprite meshes supply both.
        #ifdef USE_OUTLINE_NORMAL
          vec3 raw = normalMatrix * mat3(im) * outlineNormal;
        #else
          vec3 raw = normalMatrix * mat3(im) * normal;
        #endif
        // Unused pool slots are parked by zeroing their instance matrix, which
        // makes this vector zero, and normalize() of a zero vector is a NaN
        // written into gl_Position. Drivers are free to do anything with that,
        // including drawing a stray triangle across the screen.
        vec3 n = dot(raw, raw) > 0.0 ? normalize(raw) : vec3(0.0);
        mvPosition.xyz += n * thickness;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 outlineColor;
      void main() { gl_FragColor = vec4(outlineColor, 1.0); }
    `,
  });
}

/**
 * Give a mesh an outline by adding a fattened back-faced twin beside it.
 *
 * Returns the twin so the caller can keep its transforms in step — for an
 * `InstancedMesh` the twin shares nothing automatically and its
 * `instanceMatrix` has to be updated alongside the original's.
 */
export function addOutline(
  mesh: THREE.Mesh | THREE.InstancedMesh,
  parent: THREE.Object3D,
  thickness: number,
): THREE.Mesh | THREE.InstancedMesh {
  const mat = outlineMaterial(thickness, 0x0a0d12, !!mesh.geometry.attributes['outlineNormal']);
  let twin: THREE.Mesh | THREE.InstancedMesh;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    const src = mesh as THREE.InstancedMesh;
    const inst = new THREE.InstancedMesh(src.geometry, mat, src.count);
    inst.instanceMatrix = src.instanceMatrix;
    twin = inst;
  } else {
    twin = new THREE.Mesh(mesh.geometry, mat);
  }
  // Behind everything else: the outline should lose every depth fight with
  // the real surfaces, or it would rim the front faces too.
  twin.renderOrder = -1;
  twin.castShadow = false;
  twin.receiveShadow = false;
  parent.add(twin);
  return twin;
}
