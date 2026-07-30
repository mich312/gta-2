import * as THREE from 'three';
import {
  CARDINALS,
  type CityMap,
  PART_HEADLIGHT_L,
  PART_HEADLIGHT_R,
  PART_TAILLIGHT_L,
  PART_TAILLIGHT_R,
  TILE_SIZE,
  getTrafficTuning,
  signalColour,
} from 'shared';
import {
  LIGHT_COLORS,
  type LightKind,
  flicker,
  lampCharacter,
} from '../render/lighting.js';
import { RIGHT_OFFSET, type Scene } from '../render/renderer.js';
import type { Effects } from '../render/effects.js';

/**
 * The city, lit.
 *
 * 3D.md is explicit that the 761-line Canvas light pass should be **deleted
 * rather than ported** — real lights and a shadow map do that job — and this is
 * that. It is not a reimplementation of the 2D pass: it lights the same things,
 * from the same tables, with the same flicker, and lets the renderer work out
 * what that looks like.
 *
 * **The budget is the design.** Every point light is a per-fragment cost across
 * everything it touches, and three.js compiles a fixed light count into every
 * shader, so "one light per lamp" over a 240×240 city is not an option. Instead
 * there are fixed pools, and each frame the nearest and most important sources
 * claim a slot: the things you are looking at get lit, the rest do not, and the
 * shader cost is constant however busy the street is.
 *
 * Priority is deliberate, not incidental, and getting it wrong is invisible in
 * the code and glaring on screen. The first cut ranked by category and put
 * traffic signals and package glints above street lamps: both are 7 px pools
 * you cannot see, both are already drawn as bright geometry that needs no light
 * to read, and there are dozens of them at every junction — so they took all
 * sixteen slots and the city had no street lighting at all.
 *
 * The ranks below are ordered by what a light is FOR. Headlights first, because
 * they are the one light the player steers by. Then the things that carry
 * information — a strobe, a muzzle flash, an explosion. Then street lamps,
 * which are what night actually looks like. Markers come last: they are the
 * cheapest to lose, because the thing they mark is drawn anyway.
 *
 * None of these cast shadows. The sun owns the single shadow map; giving a
 * dozen point lights their own would be a dozen extra depth passes a frame for
 * an effect nobody looks for at night.
 */

/** Point lights available at once. Every one costs fragment work everywhere. */
const MAX_POINTS = 16;
/** Spotlights: headlights, and the searchlight under a police helicopter. */
const MAX_SPOTS = 4;

/**
 * How bright a source is, relative to the 2D pass's alpha for it.
 *
 * The conversion is the fiddly part of this file. three.js lights are physical:
 * intensity is candela and irradiance falls off as 1/d², while the 2D pass
 * speaks in "alpha of a radial gradient of radius R" — a different currency.
 *
 * The trick is picking the distance to convert AT. It is not the radius: what a
 * street lamp actually lights is the road directly beneath it, thirty pixels
 * down, and a lamp converted at its 34 px reach came out eight times too dim
 * (every lamp in the city on, and none of them lighting anything). So each
 * source converts at the distance to the surface it is *for* — its height above
 * the road for a lamp or a tail light, a fraction of the throw for a headlight
 * beam — and `GAIN` is the one number left to taste.
 */
const GAIN = 5;
/** No source converts closer than this, or a light at road level goes nuclear. */
const MIN_REF = 8;

/** How high a light hangs, in world px. A lamp is on a post; a headlight is not. */
const LAMP_Z = 30;
const SIGN_Z = 16;
const HEAD_Z = 5;
const FLASH_Z = 8;

/**
 * What outranks what when there are more lights than slots.
 *
 * Markers sit at the bottom on purpose: a signal head and a hidden package are
 * both drawn as bright geometry that reads without any light on it, so their
 * glow is the first thing worth losing.
 */
const RANK = {
  headlight: 6,
  strobe: 5,
  flash: 5,
  lamp: 4,
  shop: 3,
  taillight: 2,
  glow: 1,
  marker: 0,
} as const;

/** One thing that wants lighting, before the budget has had its say. */
interface Want {
  x: number;
  y: number;
  z: number;
  /** World px the light should reach. */
  radius: number;
  kind: LightKind;
  /** The 2D pass's alpha for this source, 0..1. */
  alpha: number;
  /** Higher wins a slot. See the note on priority above. */
  rank: number;
  /** Spotlight only: which way it points, and how wide. */
  cone?: { angle: number; spread: number };
}

/** Squared distance, for ranking without a square root. */
function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export class Lights3dLayer {
  private readonly group = new THREE.Group();
  private readonly points: THREE.PointLight[] = [];
  private readonly spots: THREE.SpotLight[] = [];
  private map: CityMap | null = null;
  private readonly wants: Want[] = [];
  private budget = { points: MAX_POINTS, spots: MAX_SPOTS };
  private readonly colors = new Map<LightKind, THREE.Color>();

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    for (let i = 0; i < MAX_POINTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 100, 2);
      light.castShadow = false;
      this.group.add(light);
      this.points.push(light);
    }
    for (let i = 0; i < MAX_SPOTS; i++) {
      const light = new THREE.SpotLight(0xffffff, 0, 200, 0.6, 0.5, 2);
      light.castShadow = false;
      this.group.add(light);
      this.group.add(light.target);
      this.spots.push(light);
    }
    for (const kind of Object.keys(LIGHT_COLORS) as LightKind[]) {
      this.colors.set(kind, new THREE.Color(LIGHT_COLORS[kind]));
    }
  }

  setMap(map: CityMap): void {
    this.map = map;
  }

  /**
   * Spend less, for a machine that cannot afford the full pool.
   *
   * `?lights=cheap` is the 2D pass's escape hatch — it drops shadow casting and
   * bloom there — and it means the same thing here: a quarter of the point
   * lights and half the spots. The ranking is what makes that survivable: what
   * is left is the headlights and the flashes, which is the half that carries
   * information, and the street lamps go before them.
   */
  setCheap(cheap: boolean): void {
    this.budget = cheap
      ? { points: Math.floor(MAX_POINTS / 4), spots: 1 }
      : { points: MAX_POINTS, spots: MAX_SPOTS };
  }

  /**
   * Work out what should be lit this frame, then spend the budget on it.
   *
   * `night` is 0 at midday and 1 at midnight — the same number the 2D grade
   * uses. Street lighting fades in with the dusk: a lamp burning at noon is the
   * one thing that gives away a scene with no clock behind it.
   */
  update(
    scene: Scene,
    effects: Effects,
    night: number,
    /** Where the camera is looking, in world px: the centre of the budget. */
    focus: { x: number; y: number },
    cam: { x: number; y: number },
    view: { w: number; h: number },
  ): void {
    const wants = this.wants;
    wants.length = 0;
    const lit = 0.15 + 0.85 * night;
    const map = this.map;

    const inView = (x: number, y: number): boolean =>
      x >= cam.x - 48 && y >= cam.y - 48 && x <= cam.x + view.w + 48 && y <= cam.y + view.h + 48;

    // Street lamps, from the props the server already streams. Character comes
    // off the id, so the lamp that hums is the same lamp for every player.
    for (const prop of scene.remotes.props) {
      if (prop.kind !== 'lamp' || !prop.intact) continue;
      if (!inView(prop.pos.x, prop.pos.y)) continue;
      const f = flicker(lampCharacter(prop.id), prop.id, scene.nowMs);
      wants.push({
        x: prop.pos.x,
        y: prop.pos.y,
        z: LAMP_Z,
        radius: 34,
        kind: 'lamp',
        alpha: 0.5 * f * lit,
        rank: RANK.lamp,
      });
    }

    if (map) {
      for (const shop of map.shops) {
        const wx = (shop.doorX + 0.5) * TILE_SIZE;
        const wy = (shop.doorY + 0.5) * TILE_SIZE;
        if (!inView(wx, wy)) continue;
        // A sign over a door, on a tube old enough to stutter now and then.
        const sign = flicker('neon', shop.doorX * 31 + shop.doorY, scene.nowMs);
        wants.push({
          x: wx,
          y: wy,
          z: SIGN_Z,
          radius: 22,
          kind: 'shop',
          alpha: 0.45 * lit * sign,
          rank: RANK.shop,
        });
        // The room behind the door is lit too, or walking in is walking into a
        // dark hole in the middle of a lit street.
        const r = shop.interior;
        const cx = (r.x + r.w / 2) * TILE_SIZE;
        const cy = (r.y + r.h / 2) * TILE_SIZE;
        wants.push({
          x: cx,
          y: cy,
          z: SIGN_Z,
          radius: Math.max(r.w, r.h) * TILE_SIZE * 0.8,
          kind: 'shop',
          alpha: 0.5,
          rank: RANK.shop,
        });
      }

      // Signals, and the packages still worth taking. Both are small glows that
      // matter for the same reason: they mark something you are looking for.
      const heads = map.junctions?.heads;
      if (heads) {
        const timing = getTrafficTuning().signals;
        for (const head of heads) {
          if (!inView(head.x, head.y)) continue;
          const colour = signalColour(head.junctionId, head.dirIdx, scene.tick, timing);
          const ax = CARDINALS[head.dirIdx]![0]!;
          const ay = CARDINALS[head.dirIdx]![1]!;
          wants.push({
            x: head.x + ax * 5 - ay * RIGHT_OFFSET,
            y: head.y + ay * 5 + ax * RIGHT_OFFSET,
            z: 26,
            radius: 7,
            kind: colour === 'green' ? 'lamp' : 'red',
            alpha: 0.22,
            rank: RANK.marker,
          });
        }
      }
      const found = scene.foundPackages;
      for (let i = 0; i < map.packages.length; i++) {
        const at = map.packages[i]!;
        if (found?.has(i) === true || !inView(at.x, at.y)) continue;
        const pulse = 0.5 + 0.5 * Math.sin(scene.nowMs * 0.002 + i);
        wants.push({
          x: at.x,
          y: at.y,
          z: 6,
          radius: 6 + pulse * 4,
          kind: 'shop',
          alpha: 0.25 + pulse * 0.2,
          rank: RANK.marker,
        });
      }
    }

    // Vehicles: headlights, brake lights, and the strobe on a cruiser with an
    // officer aboard. Only a car with somebody in it has its lights on — a
    // street of parked cars all blazing away washes the scene out.
    for (const rv of scene.remotes.vehicles) {
      if (rv.vehicle.driverId === null) continue;
      this.vehicleLights(
        rv.x,
        rv.y,
        rv.heading,
        rv.vehicle.speed,
        rv.vehicle.broken ?? 0,
        rv.vehicle.kind,
        rv.vehicle.id,
        scene.nowMs,
        lit,
      );
    }
    const lv = scene.localVehicle;
    if (lv) {
      this.vehicleLights(
        lv.pos.x,
        lv.pos.y,
        lv.heading,
        lv.speed,
        lv.broken,
        lv.kind,
        scene.local?.vehicleId ?? 0,
        scene.nowMs,
        lit,
      );
    }

    // Flashes and glowing particles: a muzzle flash, a fireball, a burning
    // wreck. These outrank everything static, because a flash is information.
    for (const f of effects.flashPool) {
      const t = f.life / f.maxLife;
      wants.push({
        x: f.x,
        y: f.y,
        z: FLASH_Z,
        radius: f.radius * (1.25 - 0.25 * t),
        kind: f.kind,
        // Fades on a curve, not a ramp: the first third of a flash is most of
        // what the eye gets.
        alpha: f.peak * t * t,
        rank: RANK.flash,
      });
    }
    for (const p of effects.particlePool) {
      if (!p.alive || p.glow <= 0) continue;
      const t = p.life / p.maxLife;
      wants.push({
        x: p.x,
        y: p.y,
        z: FLASH_Z,
        radius: p.glow * 4,
        kind: 'muzzle',
        alpha: t * 0.6,
        rank: RANK.glow,
      });
    }

    this.spend(wants, focus);
  }

  /** Headlights, tail lights and a strobe, for one occupied vehicle. */
  private vehicleLights(
    x: number,
    y: number,
    heading: number,
    speed: number,
    broken: number,
    kind: string,
    id: number,
    nowMs: number,
    lit: number,
  ): void {
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const nx = -sin;
    const ny = cos;
    const front = 11;
    const side = 4.5;
    const headL = (broken & PART_HEADLIGHT_L) === 0;
    const headR = (broken & PART_HEADLIGHT_R) === 0;
    // Each lamp is gated on its own bit: a car coming the other way on one
    // headlight tells you what has happened to it.
    // Dipped by day, full beam at night.
    //
    // `lit` is the day/night factor every other emitter here is scaled by, and
    // it was being discarded. A headlight is a real light in 3D rather than an
    // additive smear over a bright frame as it is in 2D, so an ungated one is
    // as bright as the midday sun: every occupied car dragged a white pool
    // down the road at noon, and the four spot slots were spent before dusk.
    const beam = 0.18 + 0.82 * lit;
    if (headL || headR) {
      const both = headL && headR;
      this.wants.push({
        x: x + cos * front,
        y: y + sin * front,
        z: HEAD_Z,
        radius: both ? 66 : 46,
        kind: 'head',
        alpha: (both ? 0.46 : 0.32) * beam,
        rank: RANK.headlight,
        cone: { angle: heading, spread: 0.62 },
      });
    }
    const braking = speed < 0 || Math.abs(speed) < 7;
    for (const [s, ok] of [
      [-1, (broken & PART_TAILLIGHT_L) === 0],
      [1, (broken & PART_TAILLIGHT_R) === 0],
    ] as Array<[number, boolean]>) {
      if (!ok) continue;
      this.wants.push({
        x: x - cos * front + nx * side * s,
        y: y - sin * front + ny * side * s,
        z: HEAD_Z,
        radius: braking ? 6 : 4,
        kind: 'red',
        alpha: (braking ? 0.55 : 0.32) * beam,
        rank: RANK.taillight,
      });
    }
    if (kind === 'copcar') {
      // A strobe that throws the shape of the street across the buildings is
      // most of what makes a chase read as a chase.
      const phase = Math.sin(nowMs * 0.012 + id) > 0;
      this.wants.push({
        x: x + cos * 2,
        y: y + sin * 2,
        z: HEAD_Z + 4,
        radius: 22,
        kind: phase ? 'red' : 'blue',
        // A strobe is meant to be seen in daylight, so it keeps most of its
        // punch — but not all of it, or a squad car outshines the sun.
        alpha: 0.85 * (0.45 + 0.55 * lit),
        rank: RANK.strobe,
      });
    }
  }

  /**
   * Hand the pools out to the best candidates and park the rest.
   *
   * Rank first, then distance from where the camera is looking: a headlight
   * always beats a lamp, and between two lamps the near one wins.
   */
  private spend(wants: Want[], focus: { x: number; y: number }): void {
    // Rank first, then how much this light will actually contribute where the
    // player is looking — brightness and reach over distance. Sorting on
    // distance alone put a dim glow six feet away above a lamp lighting the
    // junction you are driving into.
    const weight = (w: Want): number =>
      (w.alpha * w.radius * w.radius) / Math.max(1, dist2(w.x, w.y, focus.x, focus.y));
    wants.sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank;
      return weight(b) - weight(a);
    });

    let pi = 0;
    let si = 0;
    for (const w of wants) {
      if (w.alpha <= 0.002) continue;
      // Convert at the distance to the surface this light is for: a lamp lights
      // the road beneath it, a beam lights the street ahead.
      const ref = w.cone ? Math.max(MIN_REF, w.radius * 0.5) : Math.max(MIN_REF, w.z);
      const intensity = w.alpha * GAIN * ref * ref;
      const color = this.colors.get(w.kind) ?? this.colors.get('lamp')!;
      if (w.cone && si < this.budget.spots) {
        const light = this.spots[si++]!;
        light.color.copy(color);
        light.intensity = intensity;
        light.distance = w.radius * 2.4;
        light.angle = w.cone.spread;
        light.position.set(w.x, w.y, w.z + 6);
        // Aimed down the bonnet and slightly at the road, so the beam lands on
        // the street ahead rather than lighting the skyline.
        light.target.position.set(
          w.x + Math.cos(w.cone.angle) * w.radius,
          w.y + Math.sin(w.cone.angle) * w.radius,
          0,
        );
        light.target.updateMatrixWorld();
        continue;
      }
      // A beam that could not get a spot slot is dropped, not demoted.
      //
      // Falling through to the point path turned it into an omnidirectional
      // light carrying the cone's intensity — a headlight became a sun-bright
      // sphere on the car's bonnet, throwing light backwards and sideways down
      // a street it should have been aiming along. And because headlights
      // outrank lamps, those fakes then evicted the street lighting that was
      // doing an honest job.
      if (w.cone) continue;
      if (pi >= this.budget.points) continue;
      const light = this.points[pi++]!;
      light.color.copy(color);
      light.intensity = intensity;
      // Reach close to the authored radius. At 2.6× a lamp lit nearly seven
      // times the area the 2D renderer gives it, so sixteen of them overlapped
      // into a flat ambient wash with no pools in it — the thing street lamps
      // exist to make. `GAIN` carries the brightness; this is only how far it
      // gets before falling off.
      light.distance = w.radius * 1.25;
      light.position.set(w.x, w.y, w.z);
    }
    for (let i = pi; i < this.points.length; i++) this.points[i]!.intensity = 0;
    for (let i = si; i < this.spots.length; i++) this.spots[i]!.intensity = 0;
  }

  /** What the budget actually spent, for the debug overlay. */
  counts(): { points: number; spots: number; wanted: number } {
    return {
      points: this.points.filter((l) => l.intensity > 0).length,
      spots: this.spots.filter((l) => l.intensity > 0).length,
      wanted: this.wants.length,
    };
  }
}
