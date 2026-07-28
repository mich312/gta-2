import {
  type FullSnapshot,
  type InputIntent,
  type PlayerState,
  PI,
  TWO_PI,
  nextFloat01,
  seedRng,
  wrapAngle,
} from 'shared';

export type ScriptedKeys = Pick<
  InputIntent,
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'fire'
  | 'aimAngle'
  | 'action'
  | 'fitting'
  | 'horn'
  | 'slot'
>;

/** What a bot "sees": its own predicted player and the latest snapshot. */
export interface BotView {
  me: PlayerState | null;
  snapshot: FullSnapshot | null;
}

export type BotScript = (tick: number, botIndex: number, view?: BotView) => ScriptedKeys;

/** Steer toward a world point with a small deadzone. */
function seek(me: PlayerState, x: number, y: number): Partial<ScriptedKeys> {
  return {
    up: y < me.pos.y - 4,
    down: y > me.pos.y + 4,
    left: x < me.pos.x - 4,
    right: x > me.pos.x + 4,
  };
}

const NONE: ScriptedKeys = {
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
  aimAngle: 0,
  action: false,
  fitting: false,
  horn: false,
  slot: -1,
};

const DIRS: Array<Partial<ScriptedKeys>> = [
  { up: true },
  { up: true, right: true },
  { right: true },
  { down: true, right: true },
  { down: true },
  { down: true, left: true },
  { left: true },
  { up: true, left: true },
];

function cruiseKeys(tick: number, botIndex: number): ScriptedKeys {
  const phase = (Math.floor(tick / 45) + botIndex) % DIRS.length;
  return { ...NONE, ...DIRS[phase], aimAngle: wrapAngle(tick * 0.07 + botIndex) };
}

const scripts: Record<string, BotScript> = {
  idle: () => ({ ...NONE }),
  /**
   * Walk east, forever: the B4 roaming gate (WORLDGEN.md §11.2). Crossing
   * the window margin trips rebases; every client must re-simulate each
   * one identically or the harness's desync counter says so.
   */
  roam: () => ({ ...NONE, right: true }),

  /** Wander in a heading that rotates slowly, offset per bot. */
  cruise: cruiseKeys,

  /** Tight squares: up/right/down/left, one second each. */
  circle: (tick, botIndex) => {
    const phase = (Math.floor(tick / 30) + botIndex) % 4;
    return { ...NONE, ...DIRS[phase * 2], aimAngle: wrapAngle((phase * TWO_PI) / 4 - PI) };
  },

  /**
   * Car thief: seek the nearest free car, grab it, then drive in sweeping
   * arcs (crash, exit occasionally, steal the next one). Exercises entry
   * contention, driving prediction, and car-vs-car contact.
   */
  joyride: (tick, botIndex, view) => {
    const base = cruiseKeys(tick, botIndex);
    const me = view?.me ?? null;
    const snap = view?.snapshot ?? null;
    if (!me || !snap) return base;

    if (me.mode === 'driving') {
      // Cruise in arcs; bail out every ~20 s to go steal a different car.
      const arc = Math.floor(tick / 90 + botIndex) % 2 === 0;
      const bail = (tick + botIndex * 31) % 600 === 0;
      return { ...base, up: true, down: false, left: arc, right: !arc, action: bail };
    }

    // On foot: walk at the nearest free car and press action near it.
    let target: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const v of snap.vehicles) {
      if (v.driverId !== null) continue;
      const d = Math.hypot(v.pos.x - me.pos.x, v.pos.y - me.pos.y);
      if (d < bestD) {
        bestD = d;
        target = v.pos;
      }
    }
    if (!target) return base;
    const near = bestD < 24;
    return {
      ...base,
      ...seek(me, target.x, target.y),
      action: near && tick % 8 < 2, // pulsed so the edge-trigger keeps firing
    };
  },

  /**
   * Gunfight: chase the nearest living player, strafe, and shoot at them.
   * The 10-minute unattended stability run uses this.
   */
  brawl: (tick, botIndex, view) => {
    const base = cruiseKeys(tick, botIndex);
    const me = view?.me ?? null;
    const snap = view?.snapshot ?? null;
    if (!me || !snap || me.mode === 'dead') return { ...base, fire: false };

    let target: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const p of snap.players) {
      if (p.id === me.id || p.mode === 'dead') continue;
      const d = Math.hypot(p.pos.x - me.pos.x, p.pos.y - me.pos.y);
      if (d < bestD) {
        bestD = d;
        target = p.pos;
      }
    }
    if (!target) return base;
    const aim = Math.atan2(target.y - me.pos.y, target.x - me.pos.x);
    // Slot 0 is fists, which reach about 24 px. Select the first real gun so
    // the harness keeps exercising ranged combat (and the damage, heat and
    // police paths that hang off it) rather than shadow-boxing.
    const gun = me.weapons.findIndex((w) => w.weaponId !== 'fists' && w.ammo > 0);
    const strafe = Math.floor(tick / 20 + botIndex) % 2 === 0;
    const keys =
      bestD > 90
        ? seek(me, target.x, target.y)
        : {
            up: strafe,
            down: !strafe && (tick + botIndex) % 5 === 0,
            left: !strafe,
            right: strafe && tick % 3 === 0,
          };
    return {
      ...base,
      ...keys,
      slot: gun >= 0 ? gun : -1,
      aimAngle: aim,
      fire: bestD < (gun >= 0 ? 210 : 22),
    };
  },

  /** Deterministic chaos: every key rolled from a per-tick PRNG. */
  jitter: (tick, botIndex) => {
    let s = seedRng(tick * 31 + botIndex * 1009 + 7);
    const roll = (): number => {
      let v: number;
      [v, s] = nextFloat01(s);
      return v;
    };
    return {
      slot: -1,
      up: roll() < 0.4,
      down: roll() < 0.4,
      left: roll() < 0.4,
      right: roll() < 0.4,
      fire: roll() < 0.1,
      aimAngle: roll() * TWO_PI - PI,
      action: roll() < 0.02,
      // Chaos includes mashing whatever is bolted to the car.
      fitting: roll() < 0.05,
      horn: roll() < 0.05,
    };
  },
};

export function getScript(name: string): BotScript {
  const script = scripts[name];
  if (!script) {
    throw new Error(`unknown bot script '${name}' (have: ${Object.keys(scripts).join(', ')})`);
  }
  return script;
}
