import * as THREE from 'three';
import {
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
import { type Scene } from '../render/renderer.js';
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

/**
 * How high a light hangs, in world px. A lamp is on a post; a headlight is not.
 *
 * `LAMP_Z` tracks the lamp *mesh*, and the two have to be changed together —
 * it was 30 because the lamp sprite's max z of 12 at a scale of 5.0 came out
 * at exactly 30, and nothing said so. Leave it behind and the glow floats
 * above the bulb it is supposed to be coming from.
 *
 * It is also the distance the lamp's brightness is converted at, so lowering
 * it dims the source and the pool on the road beneath stays where it was
 * tuned. See `GAIN`.
 */
export const LAMP_Z = 14;
const SIGN_Z = 16;
const HEAD_Z = 5;
export const FLASH_Z = 8;

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
  /**
   * Stable identity across frames, for the slot hysteresis in `spend`.
   *
   * Composed as `tag * 1e6 + source id`, where the tag says which family the
   * light belongs to (lamp, sign, head…) so ids from different tables cannot
   * collide. Transient lights (flashes, glow particles) key off their pool
   * slot, which is as stable as anything that lives half a second needs.
   */
  key: number;
  /**
   * The lamp's moment-to-moment character — `flicker()`, a package's pulse —
   * applied to the granted light's INTENSITY only, never to the ranking.
   *
   * This split is most of the fix for the 3D flicker. The 2D pass draws
   * every light it knows about, so a humming lamp dims and recovers in
   * place; here the same multiplier sat inside `alpha`, alpha sat inside the
   * ranking weight, and a lamp near the budget cutoff crossed it every time
   * its character wavered — which in a granted-or-parked world is a hard
   * on/off pop, sustained, on every marginal lamp in view. Ranking on the
   * stable base and flickering only what was granted turns that back into
   * what the tables meant: character, not churn.
   */
  flick?: number;
  /**
   * Skip the slot fades — arrive and leave at full brightness.
   *
   * For the lights whose whole job is to be abrupt: a muzzle flash, an
   * explosion, a burning particle, the strobe on a police car. Their own
   * `alpha` already carries the shape of their life, and easing a flash in is
   * a way of not having a flash.
   *
   * Everything else fades, headlights emphatically included. They used to be
   * exempt by accident — the exemption tested `rank < RANK.flash` and a
   * headlight outranks a flash — so of all the lights in the city, the four
   * that change hands most often were the four that changed hands hardest.
   */
  instant?: boolean;
  /** Contribution near the focus, filled by `spend` just before sorting. */
  weight?: number;
}

/**
 * three.js's range window at a distance, for a light of the given range.
 *
 * A `PointLight`/`SpotLight` with `decay = 2` attenuates as
 * `(1 - (d/distance)^4)^2 / d^2`. The second factor is the physical inverse
 * square and is what `GAIN` is tuned against; the first exists only so the
 * light reaches zero at its stated range instead of being clipped there. That
 * window is what makes a shorter range quietly darker as well as smaller.
 *
 * Floored rather than allowed to reach zero: a source converting at or beyond
 * its own range is a tuning mistake, and dividing by nearly nothing would turn
 * it into a flare rather than showing up as one.
 */
function falloffWindow(d: number, distance: number): number {
  if (distance <= 0) return 1;
  const t = Math.min(1, d / distance);
  const w = (1 - t * t * t * t) ** 2;
  return Math.max(0.15, w);
}

/** Squared distance, for ranking without a square root. */
function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * How long a light takes to arrive, and to leave.
 *
 * Both halves matter and only the first was ever built. A newly granted light
 * used to ramp up over ~150 ms while the light it displaced went out between
 * one frame and the next — so every handover was still a pop, just a pop and a
 * swell rather than two pops. What the eye reads as flashing is the leaving
 * half.
 */
const FADE_MS = 140;

/**
 * How long a light keeps its slot before the ranking may take it away.
 *
 * The hysteresis below defends a slot against noise; this defends it against
 * a genuine, sustained crossing — which for four spot slots and a street of
 * moving cars happens constantly, because the ranking is distance-based and
 * the cars are what is moving. Without it, two headlights of nearly equal
 * weight trade the same slot back and forth for as long as they are side by
 * side, each trade costing a full fade out and in.
 *
 * A higher rank still preempts immediately: rank is sorted before weight, so
 * a muzzle flash never waits behind a street lamp's dwell.
 */
const DWELL_MS = 400;
/** Weight multiplier while an incumbent is inside its dwell window. */
const DWELL_BOOST = 12;
/** Weight multiplier for an incumbent past its dwell — noise rejection only. */
const HYSTERESIS = 1.6;

/** Speed at which brake lights come on, and the higher one at which they go off. */
const BRAKE_ON = 6;
const BRAKE_OFF = 9;

/**
 * One slot of one pool, and what is happening in it.
 *
 * A slot is the unit the crossfade lives on, and it has to be: the pools are a
 * fixed size because three.js compiles the number of *visible* lights into
 * every shader, so a handover cannot borrow a spare light to fade out on. The
 * outgoing light therefore fades out on its own slot and the incoming one
 * waits for it — about a seventh of a second, invisible against a light that
 * would otherwise have snapped on.
 */
interface Slot {
  /** The want holding it, or 0 for free. */
  key: number;
  /** 0 dark, 1 full. */
  fade: number;
  /** Fading out and about to free itself. */
  retiring: boolean;
  /** When this key took the slot, for the dwell. */
  sinceMs: number;
  /**
   * Recorded from the want at the moment of the grant, not read off it later.
   *
   * A flash is the thing most likely to be gone by the time its slot is
   * released — that is what a flash is — and a released slot has no want left
   * to ask. Kept here, a dead muzzle flash still cuts out instead of easing.
   */
  instant: boolean;
  /**
   * The light's intensity at full fade, from the last frame its want existed.
   *
   * A slot can outlive the thing that asked for it: a car leaves the streamed
   * world, a driver gets out, a flash dies. The fade still has to finish, and
   * with no want left to convert there is nothing to compute it from — so the
   * last figure is kept and simply scaled down. Position, colour and range are
   * left where they were, which is where the light was when its source went.
   */
  base: number;
}

function freeSlot(): Slot {
  return { key: 0, fade: 0, retiring: false, sinceMs: 0, instant: false, base: 0 };
}

export class Lights3dLayer {
  private readonly group = new THREE.Group();
  private readonly points: THREE.PointLight[] = [];
  private readonly spots: THREE.SpotLight[] = [];
  private map: CityMap | null = null;
  private readonly wants: Want[] = [];
  private budget = { points: MAX_POINTS, spots: MAX_SPOTS };
  private readonly colors = new Map<LightKind, THREE.Color>();
  /** What holds each point slot, and how far through its fade it is. */
  private readonly pointSlots: Slot[] = [];
  /** The same, for the spots — which is where the headlights live. */
  private readonly spotSlots: Slot[] = [];
  /**
   * When each currently-held key took its slot, for the hysteresis and dwell.
   *
   * Rebuilt from the slots after every spend, so it cannot drift out of step
   * with them.
   */
  private readonly heldSince = new Map<number, number>();
  /** Slots that changed hands on the last spend, for the overlay. */
  private lastTurnover = 0;
  private lastSpendMs = 0;
  /** Scratch, so the per-frame decision allocates nothing. */
  private readonly wantByKey = new Map<number, Want>();
  private readonly winners = new Set<number>();
  /** Vehicle ids whose brake lights are currently on. See `braking`. */
  private readonly brakeLatch = new Set<number>();

  constructor(scene: THREE.Object3D) {
    scene.add(this.group);
    for (let i = 0; i < MAX_POINTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 100, 2);
      light.castShadow = false;
      this.group.add(light);
      this.points.push(light);
      this.pointSlots.push(freeSlot());
    }
    for (let i = 0; i < MAX_SPOTS; i++) {
      const light = new THREE.SpotLight(0xffffff, 0, 200, 0.6, 0.5, 2);
      light.castShadow = false;
      this.group.add(light);
      this.group.add(light.target);
      this.spots.push(light);
      this.spotSlots.push(freeSlot());
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
        alpha: 0.5 * lit,
        flick: f,
        rank: RANK.lamp,
        key: 1e6 + prop.id,
      });
    }

    if (map) {
      for (let si = 0; si < map.shops.length; si++) {
        const shop = map.shops[si]!;
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
          alpha: 0.45 * lit,
          flick: sign,
          rank: RANK.shop,
          key: 2e6 + si,
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
          key: 3e6 + si,
        });
      }

      // Signals, and the packages still worth taking. Both are small glows that
      // matter for the same reason: they mark something you are looking for.
      const heads = map.junctions?.heads;
      if (heads) {
        const timing = getTrafficTuning().signals;
        for (let hi = 0; hi < heads.length; hi++) {
          const head = heads[hi]!;
          if (!inView(head.x, head.y)) continue;
          const colour = signalColour(
            map.junctions?.phase?.[head.junctionId] ?? head.junctionId,
            head.dirIdx,
            scene.tick,
            timing,
          );
          wants.push({
            x: head.postX,
            y: head.postY,
            z: 26,
            radius: 7,
            kind: colour === 'green' ? 'lamp' : 'red',
            alpha: 0.22,
            rank: RANK.marker,
            key: 4e6 + hi,
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
          // Base geometry and alpha are STABLE — the pulse rides on `flick` —
          // so a package's rank near the cutoff does not breathe it in and
          // out of existence. Radius was pulsing too, which squared into the
          // ranking weight.
          radius: 8,
          kind: 'shop',
          alpha: 0.35,
          flick: (0.25 + pulse * 0.2) / 0.35,
          rank: RANK.marker,
          key: 5e6 + i,
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
        night,
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
        night,
      );
    }

    // Flashes and glowing particles: a muzzle flash, a fireball, a burning
    // wreck. These outrank everything static, because a flash is information.
    // Keyed by pool slot: transient by design, and their fade lives in
    // `alpha` on purpose — a flash is SUPPOSED to preempt and die.
    let fi = 0;
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
        instant: true,
        key: 9e6 + fi++,
      });
    }
    let gi = 0;
    for (const p of effects.particlePool) {
      gi++;
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
        instant: true,
        key: 10e6 + gi,
      });
    }

    // A car that leaves the streamed world while its brake lights are on
    // leaves its id behind in the latch. Dropping the lot when it gets large
    // costs one frame in which every car inside the deadband re-decides from
    // its speed alone, which is what it would have decided anyway unless it
    // is in the three-unit band — and then for one frame.
    if (this.brakeLatch.size > 256) this.brakeLatch.clear();

    this.spend(wants, focus, scene.nowMs);
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
    /** 0 midday, 1 midnight. NOT the lamp curve — see `beam` below. */
    night: number,
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
    // The hour was being discarded outright. A headlight is a real light in 3D rather than an
    // additive smear over a bright frame as it is in 2D, so an ungated one is
    // as bright as the midday sun: every occupied car dragged a white pool
    // down the road at noon, and the four spot slots were spent before dusk.
    // Off `night` rather than `lit`, and with a much smaller floor than the
    // lamps have. `lit` never drops below 0.15 because a street lamp keeps a
    // little presence by day; a headlight should not. That floor was invisible
    // until the bloom pass arrived and turned "slightly on" into a glowing
    // halo on the tarmac at midday.
    const beam = 0.06 + 0.94 * night;
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
        key: 6e6 + id,
      });
    }
    const braking = this.braking(id, speed);
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
        key: 7e6 + id * 2 + (s + 1) / 2,
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
        alpha: 0.85 * (0.45 + 0.55 * night),
        rank: RANK.strobe,
        instant: true,
        key: 8e6 + id,
      });
    }
  }

  /**
   * Are this car's brake lights on — with a deadband, so they stay decided.
   *
   * The test was a bare `|speed| < 7`, and traffic spends most of its life
   * either side of that: a car queueing at a junction, or crawling behind a
   * bus, crosses it several times a second. Each crossing swung the tail
   * light's ranking weight by nearly three (0.55·6² against 0.32·4²), which is
   * more than enough to walk it across the point-pool cutoff and back — a red
   * light on the car in front, blinking at whatever rate the traffic happened
   * to be doing. The lamp is genuinely meant to change here; what it is not
   * meant to do is change on the same tenth of a mile per hour twice a second.
   *
   * Reversing is unambiguous and needs no band.
   */
  private braking(id: number, speed: number): boolean {
    if (speed < 0) return true;
    const was = this.brakeLatch.has(id);
    const on = speed < (was ? BRAKE_OFF : BRAKE_ON);
    if (on) this.brakeLatch.add(id);
    else this.brakeLatch.delete(id);
    return on;
  }

  /**
   * Hand the pools out to the best candidates and park the rest.
   *
   * Rank first, then distance from where the camera is looking: a headlight
   * always beats a lamp, and between two lamps the near one wins. What the
   * ranking decides is only who *should* be lit; the slots below decide when
   * that actually happens, because the change of hands is what the eye sees.
   */
  private spend(wants: Want[], focus: { x: number; y: number }, nowMs: number): void {
    // Fade step for this frame; clamped so a stall does not skip the fade.
    const step = Math.min(100, Math.max(0, nowMs - this.lastSpendMs)) / FADE_MS;
    this.lastSpendMs = nowMs;

    // Rank first, then how much this light will actually contribute where the
    // player is looking — brightness and reach over distance. Sorting on
    // distance alone put a dim glow six feet away above a lamp lighting the
    // junction you are driving into. Weights are computed once per light
    // before the sort: a comparator that recomputes both operands' weights
    // (a dist2 each) runs them O(n log n) times per frame instead of O(n).
    const byKey = this.wantByKey;
    byKey.clear();
    for (const w of wants) {
      w.weight = (w.alpha * w.radius * w.radius) / Math.max(1, dist2(w.x, w.y, focus.x, focus.y));
      // Slot hysteresis, and above it the dwell. The margin defends a slot
      // against noise; the dwell defends it against a real crossing for long
      // enough that two cars running side by side stop trading one slot
      // between them. Both only ever apply within a rank.
      const since = this.heldSince.get(w.key);
      if (since !== undefined) {
        w.weight *= nowMs - since < DWELL_MS ? DWELL_BOOST : HYSTERESIS;
      }
      byKey.set(w.key, w);
    }
    wants.sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank;
      return (b.weight as number) - (a.weight as number);
    });

    // Who should be lit. Cones and points are separate pools with separate
    // budgets, and a beam that cannot get a spot slot is dropped rather than
    // demoted — see the note further down.
    const winners = this.winners;
    winners.clear();
    let wantPoints = 0;
    let wantSpots = 0;
    for (const w of wants) {
      if (w.alpha <= 0.002) continue;
      if (w.cone) {
        if (wantSpots >= this.budget.spots) continue;
        wantSpots++;
      } else {
        if (wantPoints >= this.budget.points) continue;
        wantPoints++;
      }
      winners.add(w.key);
    }

    let turnover = 0;
    turnover += this.assign(this.spotSlots, winners, byKey, this.budget.spots, step, nowMs);
    turnover += this.assign(this.pointSlots, winners, byKey, this.budget.points, step, nowMs);
    this.lastTurnover = turnover;

    // What holds what, for next frame's hysteresis and dwell. Rebuilt from the
    // slots rather than tracked alongside them, so the two cannot disagree.
    this.heldSince.clear();
    for (const slots of [this.spotSlots, this.pointSlots]) {
      for (const s of slots) {
        if (s.key !== 0 && !s.retiring) this.heldSince.set(s.key, s.sinceMs);
      }
    }

    for (let i = 0; i < this.spots.length; i++) {
      this.applySpot(i, this.spotSlots[i]!, byKey);
    }
    for (let i = 0; i < this.points.length; i++) {
      this.applyPoint(i, this.pointSlots[i]!, byKey);
    }
  }

  /**
   * Move one pool's slots towards what the ranking asked for.
   *
   * The rule a slot follows, and the whole of the repair:
   *
   * - **Holding a winner** — fade towards full and stay put.
   * - **Holding a loser** — fade towards dark, *keeping the light*, and only
   *   free the slot when it reaches zero. This is the half that was missing:
   *   an evicted light used to vanish between two frames, so every legitimate
   *   handover still flashed however gently its replacement arrived.
   * - **Free** — take the highest-ranked winner nobody is holding, starting
   *   dark. A winner that finds no free slot simply waits: the fade it is
   *   waiting on is a seventh of a second.
   *
   * Instant lights — a muzzle flash, an explosion, a police strobe — skip both
   * fades. A flash that eases in is not a flash, and a strobe that eases out
   * is not a strobe.
   *
   * Returns how many slots changed hands, which is the flicker as a number.
   */
  private assign(
    slots: Slot[],
    winners: Set<number>,
    byKey: Map<number, Want>,
    budget: number,
    step: number,
    nowMs: number,
  ): number {
    let turnover = 0;
    // First, what the slots already hold: keep it, or start letting go of it.
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.key === 0) continue;
      // Over budget (`?lights=cheap` turned down mid-session): release at once.
      // Nothing is drawn from these slots either way.
      if (i >= budget) {
        slot.key = 0;
        slot.fade = 0;
        slot.retiring = false;
        continue;
      }
      const want = byKey.get(slot.key);
      const keep = !slot.retiring && winners.has(slot.key) && want !== undefined;
      if (keep) {
        slot.retiring = false;
        slot.fade = Math.min(1, slot.fade + step);
        continue;
      }
      // Losing it. An instant light and one whose want has gone out of the
      // world entirely both go straight to dark; anything else fades.
      slot.retiring = true;
      slot.fade = slot.instant ? 0 : Math.max(0, slot.fade - step);
      if (slot.fade <= 0) {
        slot.key = 0;
        slot.retiring = false;
      }
    }

    // Then fill what is free, best first: `winners` was filled in sorted
    // order, so iterating it is iterating the ranking.
    const isSpot = slots === this.spotSlots;
    let slotIndex = 0;
    for (const key of winners) {
      const want = byKey.get(key);
      if (!want) continue;
      // A cone only ever goes in a spot slot and a point only in a point slot;
      // `winners` holds both families, so skip the ones this pool cannot take.
      if (isSpot !== (want.cone !== undefined)) continue;
      // Including a slot part-way through its fade out — a key cannot hold two.
      if (this.holds(slots, key)) continue;
      while (slotIndex < slots.length && slotIndex < budget && slots[slotIndex]!.key !== 0) {
        slotIndex++;
      }
      if (slotIndex >= slots.length || slotIndex >= budget) break;
      const slot = slots[slotIndex]!;
      slot.key = key;
      slot.retiring = false;
      slot.instant = want.instant === true;
      // A flash arrives at full. Everything else starts at a floor rather than
      // at nothing, so the light has presence on the frame it lands and the
      // fade carries it the rest of the way.
      slot.fade = want.instant === true ? 1 : Math.min(1, 0.15 + step);
      slot.sinceMs = nowMs;
      turnover++;
    }
    return turnover;
  }

  private holds(slots: Slot[], key: number): boolean {
    for (const s of slots) if (s.key === key) return true;
    return false;
  }

  /**
   * Brightness for a slot, in three.js's candela.
   *
   * The conversion happens at the distance to the surface the light is *for*
   * (see `GAIN`), `flick` — the lamp's moment-to-moment character — rides on
   * top of it, and the slot's fade rides on top of that.
   */
  private intensityOf(w: Want, fade: number): number {
    const ref = w.cone ? Math.max(MIN_REF, w.radius * 0.5) : Math.max(MIN_REF, w.z);
    return w.alpha * (w.flick ?? 1) * fade * GAIN * ref * ref;
  }

  private applySpot(i: number, slot: Slot, byKey: Map<number, Want>): void {
    const light = this.spots[i]!;
    // Unspent slots are hidden, not merely dimmed.
    //
    // `WebGLLights.setup` counts every *visible* light whatever its intensity,
    // and the count is a program cache key — so a zeroed light still made the
    // toon shader loop over it for every fragment it touched, and
    // `?lights=cheap` bought nothing at all on the GPU. `projectObject` skips
    // an invisible one, so this is what makes the option mean something. It
    // costs one shader recompile at the moment the count changes, which is why
    // intensity is zeroed as well: a light that is off looks the same either
    // way, and the count only moves when the budget does.
    light.visible = i < this.budget.spots;
    const w = slot.key === 0 ? undefined : byKey.get(slot.key);
    if (slot.fade <= 0) {
      light.intensity = 0;
      return;
    }
    if (!w) {
      // The source is gone and the fade is not finished. Dim what is already
      // there rather than cutting it — see `Slot.base`.
      light.intensity = slot.base * slot.fade;
      return;
    }
    // A retiring light keeps following its want while it fades: a headlight
    // that lost its slot belongs to a car that is still driving, and fading
    // out where the car used to be would leave a pool behind on the road.
    const ref = Math.max(MIN_REF, w.radius * 0.5);
    const throwTo = w.radius * 2.4;
    light.color.copy(this.colors.get(w.kind) ?? this.colors.get('lamp')!);
    slot.base = this.intensityOf(w, 1) / falloffWindow(ref, throwTo);
    light.intensity = slot.base * slot.fade;
    light.distance = throwTo;
    light.angle = w.cone?.spread ?? 0.6;
    light.position.set(w.x, w.y, w.z + 6);
    // Aimed down the bonnet and slightly at the road, so the beam lands on
    // the street ahead rather than lighting the skyline.
    const angle = w.cone?.angle ?? 0;
    light.target.position.set(w.x + Math.cos(angle) * w.radius, w.y + Math.sin(angle) * w.radius, 0);
    light.target.updateMatrixWorld();
  }

  private applyPoint(i: number, slot: Slot, byKey: Map<number, Want>): void {
    const light = this.points[i]!;
    light.visible = i < this.budget.points;
    const w = slot.key === 0 ? undefined : byKey.get(slot.key);
    if (slot.fade <= 0) {
      light.intensity = 0;
      return;
    }
    if (!w) {
      light.intensity = slot.base * slot.fade;
      return;
    }
    const ref = Math.max(MIN_REF, w.z);
    // Wide enough for the pool to reach the road it is lighting, but short
    // of the 2.6× that had sixteen lamps overlapping into a flat ambient
    // wash with no pools in it at all. At 1.25× the patch stopped at the
    // kerb and the carriageway stayed black, which is not what a street lamp
    // is for either. The compensation below is what makes this a free choice
    // about the shape of the pool rather than one about its brightness.
    const distance = w.radius * 2.0;
    light.color.copy(this.colors.get(w.kind) ?? this.colors.get('lamp')!);
    // Shortening the range dims the light as well as narrowing it, which is
    // not what was wanted and is easy to miss. three.js windows the inverse
    // square by `(1 - (d/distance)^4)^2`, so at a lamp's own 30 px height
    // that window is 0.97 at the old reach and 0.57 at this one — the pool
    // on the road came out barely over half as bright, which reads as the
    // same flat dimness the wide version had. Dividing the window out at the
    // reference distance makes brightness *there* independent of the range,
    // so the range is free to be a shape decision on its own.
    slot.base = this.intensityOf(w, 1) / falloffWindow(ref, distance);
    light.intensity = slot.base * slot.fade;
    light.distance = distance;
    light.position.set(w.x, w.y, w.z);
  }

  /** What the budget actually spent, for the debug overlay. */
  counts(): { points: number; spots: number; wanted: number; turnover: number } {
    return {
      points: this.points.filter((l) => l.intensity > 0).length,
      spots: this.spots.filter((l) => l.intensity > 0).length,
      wanted: this.wants.length,
      // How many slots changed hands on the last spend — the flicker, as a
      // number. Standing still it should sit at zero; every unit above that
      // is a light that popped.
      turnover: this.lastTurnover,
    };
  }
}
