import { type InputIntent, PI, TWO_PI, nextFloat01, seedRng, wrapAngle } from 'shared';

export type ScriptedKeys = Pick<
  InputIntent,
  'up' | 'down' | 'left' | 'right' | 'fire' | 'aimAngle' | 'action'
>;

export type BotScript = (tick: number, botIndex: number) => ScriptedKeys;

const NONE: ScriptedKeys = {
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
  aimAngle: 0,
  action: false,
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

const scripts: Record<string, BotScript> = {
  idle: () => ({ ...NONE }),

  /** Wander in a heading that rotates slowly, offset per bot. */
  cruise: (tick, botIndex) => {
    const phase = (Math.floor(tick / 45) + botIndex) % DIRS.length;
    return { ...NONE, ...DIRS[phase], aimAngle: wrapAngle(tick * 0.07 + botIndex) };
  },

  /** Tight squares: up/right/down/left, one second each. */
  circle: (tick, botIndex) => {
    const phase = (Math.floor(tick / 30) + botIndex) % 4;
    return { ...NONE, ...DIRS[phase * 2], aimAngle: wrapAngle((phase * TWO_PI) / 4 - PI) };
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
      up: roll() < 0.4,
      down: roll() < 0.4,
      left: roll() < 0.4,
      right: roll() < 0.4,
      fire: roll() < 0.1,
      aimAngle: roll() * TWO_PI - PI,
      action: roll() < 0.02,
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
