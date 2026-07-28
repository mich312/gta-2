export interface EconomyParams {
  startingCash: number;
  killAward: number;
  killRepeatDecay: number;
  killRepeatWindowSec: number;
  drivingCellAward: number;
  drivingCellSizePx: number;
  drivingMinSpeed: number;
  perMinuteCaps: { kill: number; driving: number };
  /**
   * The score multiplier: what success raises and arrest halves. Every award
   * is multiplied by it before it lands, so a good run accelerates — the one
   * mechanic the 1997 original built its whole economy around.
   */
  multiplier: {
    max: number;
    frenzyGain: number;
    /** Raised by a multiplier crate. Rare by design; see the pickup cycle. */
    pickupGain: number;
    missionGain: number;
    /** Fraction of the multiplier kept when busted. 0.5 = halved. */
    bustPenalty: number;
  };
  /**
   * The car crusher: what the city pays for a stolen vehicle, and what it
   * sometimes pays in instead of cash.
   */
  crush: {
    base: number;
    byKind: Record<string, number>;
    /** Multiplier on a kind that is currently on the export list. */
    exportBonus: number;
    listSize: number;
    refreshSec: number;
    /** Odds a crush pays in equipment rather than only cash. */
    equipmentChance: number;
    /** How close the car has to be to the jaws, px. */
    radius: number;
  };
}

export function parseEconomyParams(raw: unknown): EconomyParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`economy: ${k} must be a non-negative number`);
    }
    return v;
  };
  const caps = (r['perMinuteCaps'] ?? {}) as Record<string, unknown>;
  const cap = (k: string): number => {
    const v = caps[k];
    if (typeof v !== 'number' || v <= 0) throw new Error(`economy: perMinuteCaps.${k}`);
    return v;
  };
  const mult = (r['multiplier'] ?? {}) as Record<string, unknown>;
  const m = (k: string, min: number): number => {
    const v = mult[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      throw new Error(`economy: multiplier.${k} must be a number >= ${min}`);
    }
    return v;
  };
  return {
    startingCash: n('startingCash'),
    killAward: n('killAward'),
    killRepeatDecay: n('killRepeatDecay'),
    killRepeatWindowSec: n('killRepeatWindowSec'),
    drivingCellAward: n('drivingCellAward'),
    drivingCellSizePx: n('drivingCellSizePx'),
    drivingMinSpeed: n('drivingMinSpeed'),
    perMinuteCaps: { kill: cap('kill'), driving: cap('driving') },
    multiplier: {
      max: m('max', 1),
      frenzyGain: m('frenzyGain', 0),
    pickupGain: m('pickupGain', 0),
      missionGain: m('missionGain', 0),
      bustPenalty: m('bustPenalty', 0),
    },
    crush: parseCrush(r['crush']),
  };
}

function parseCrush(raw: unknown): EconomyParams['crush'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string, min = 0): number => {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      throw new Error(`economy: crush.${k} must be a number >= ${min}`);
    }
    return v;
  };
  const byKindRaw = (r['byKind'] ?? {}) as Record<string, unknown>;
  const byKind: Record<string, number> = {};
  for (const [k, v] of Object.entries(byKindRaw)) {
    if (typeof v !== 'number' || v < 0) throw new Error(`economy: crush.byKind.${k}`);
    byKind[k] = v;
  }
  return {
    base: n('base'),
    byKind,
    exportBonus: n('exportBonus', 1),
    listSize: n('listSize', 1),
    refreshSec: n('refreshSec', 1),
    equipmentChance: n('equipmentChance'),
    radius: n('radius', 1),
  };
}

interface RateWindow {
  windowStartMs: number;
  earned: number;
}

/**
 * Award anti-farming state, per player. The realistic exploit here is not a
 * hacked client but degenerate play: kill-trading with a friend, driving in
 * circles. Diminishing returns per victim, novelty requirement for driving
 * pay, and per-category rate caps — all numbers from economy.json.
 */
export class AwardTracker {
  /** killer -> victim -> [timestamps of recent kills] */
  private killHistory = new Map<number, Map<number, number[]>>();
  /** playerId -> set of visited driving cells (novel coverage only pays once) */
  private drivingCells = new Map<number, Set<number>>();
  private rate = new Map<string, RateWindow>();

  constructor(private readonly params: EconomyParams) {}

  /** Cash for this kill, after decay and caps. 0 if farmed dry. */
  killAward(killerId: number, victimId: number, nowMs: number): number {
    let perVictim = this.killHistory.get(killerId);
    if (!perVictim) {
      perVictim = new Map();
      this.killHistory.set(killerId, perVictim);
    }
    const windowMs = this.params.killRepeatWindowSec * 1000;
    const recent = (perVictim.get(victimId) ?? []).filter((t) => nowMs - t < windowMs);
    const amount = Math.floor(
      this.params.killAward * Math.pow(this.params.killRepeatDecay, recent.length),
    );
    recent.push(nowMs);
    perVictim.set(victimId, recent);
    return this.capped(`kill:${killerId}`, this.params.perMinuteCaps.kill, amount, nowMs);
  }

  /** Cash for driving through a world position at speed; pays novel cells only. */
  drivingAward(playerId: number, x: number, y: number, speed: number, nowMs: number): number {
    if (Math.abs(speed) < this.params.drivingMinSpeed) return 0;
    const size = this.params.drivingCellSizePx;
    const cell = Math.floor(x / size) * 100_000 + Math.floor(y / size);
    let cells = this.drivingCells.get(playerId);
    if (!cells) {
      cells = new Set();
      this.drivingCells.set(playerId, cells);
    }
    if (cells.has(cell)) return 0;
    cells.add(cell);
    return this.capped(
      `driving:${playerId}`,
      this.params.perMinuteCaps.driving,
      this.params.drivingCellAward,
      nowMs,
    );
  }

  private capped(key: string, capPerMin: number, amount: number, nowMs: number): number {
    let w = this.rate.get(key);
    if (!w || nowMs - w.windowStartMs >= 60_000) {
      w = { windowStartMs: nowMs, earned: 0 };
      this.rate.set(key, w);
    }
    const granted = Math.max(0, Math.min(amount, capPerMin - w.earned));
    w.earned += granted;
    return granted;
  }
}
