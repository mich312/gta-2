import type { CityMap, GameState, Vec2 } from 'shared';

/**
 * Hidden packages.
 *
 * This is the item where the shared-world premise fights the original design
 * hardest, and the design call is the whole feature: **the world is shared,
 * the finding is personal.** A hidden package is a one-time find; in a city
 * with thirty people in it every one of them is found in the first hour and
 * the mechanic is dead for everybody who arrives on day two.
 *
 * So packages are not sim pickups. They are positions on the map plus a
 * per-account found-set, checked server-side by proximity in the same pass
 * that already handles shop doorways. A package you have found pays nothing
 * and renders dim; a package your neighbour found is still there for you.
 * This costs the sim nothing, cannot desync, and survives any number of
 * players — none of which is true of the obvious implementation.
 */

export interface SecretParams {
  /** How close you have to be to pick one up, px. */
  reach: number;
  /** Thresholds, and what reaching them is worth in cash. */
  rewards: Array<{ at: number; cash: number }>;
}

export const DEFAULT_SECRETS: SecretParams = {
  reach: 26,
  rewards: [
    { at: 10, cash: 2000 },
    { at: 25, cash: 6000 },
    { at: 50, cash: 18000 },
    { at: 100, cash: 60000 },
  ],
};

export function parseSecretParams(raw: unknown): SecretParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const reach = r['reach'];
  const rewards = r['rewards'];
  return {
    reach: typeof reach === 'number' && reach > 0 ? reach : DEFAULT_SECRETS.reach,
    rewards: Array.isArray(rewards)
      ? rewards
          .map((v) => (v ?? {}) as Record<string, unknown>)
          .filter((v) => typeof v['at'] === 'number' && typeof v['cash'] === 'number')
          .map((v) => ({ at: v['at'] as number, cash: v['cash'] as number }))
          .sort((a, b) => a.at - b.at)
      : DEFAULT_SECRETS.rewards,
  };
}

export interface SecretFind {
  playerId: number;
  index: number;
  found: number;
  total: number;
  /** Cash for crossing a threshold with this one, or 0. */
  reward: number;
}

/** Who has found what. */
export class Secrets {
  private readonly byPlayer = new Map<number, Set<number>>();

  constructor(private readonly params: SecretParams) {}

  found(playerId: number): number {
    return this.byPlayer.get(playerId)?.size ?? 0;
  }

  /** The set, for persisting with the account. */
  indicesOf(playerId: number): number[] {
    return [...(this.byPlayer.get(playerId) ?? [])].sort((a, b) => a - b);
  }

  /** Restored on login: a find is not a session thing. */
  seed(playerId: number, saved: number[] | undefined): void {
    if (!saved || saved.length === 0) return;
    this.byPlayer.set(playerId, new Set(saved));
  }

  forget(playerId: number): void {
    this.byPlayer.delete(playerId);
  }

  /** Has this player already found the package at `index`? */
  has(playerId: number, index: number): boolean {
    return this.byPlayer.get(playerId)?.has(index) === true;
  }

  /**
   * Anybody standing on a package they have not found yet.
   *
   * Iterated players-then-packages in id order so the result is stable, and
   * it never mutates the sim — the only thing that changes is a set on this
   * object and the message the caller sends.
   */
  step(state: GameState, map: CityMap): SecretFind[] {
    const total = map.packages.length;
    if (total === 0) return [];
    const r2 = this.params.reach * this.params.reach;
    const out: SecretFind[] = [];
    for (const playerId of state.players.ids) {
      const p = state.players.byId[playerId];
      if (!p || p.mode === 'dead') continue;
      let mine = this.byPlayer.get(playerId);
      if (mine && mine.size >= total) continue;
      for (let i = 0; i < total; i++) {
        const spot = map.packages[i] as Vec2;
        const dx = spot.x - p.pos.x;
        const dy = spot.y - p.pos.y;
        if (dx * dx + dy * dy > r2) continue;
        if (mine?.has(i)) continue;
        if (!mine) {
          mine = new Set();
          this.byPlayer.set(playerId, mine);
        }
        mine.add(i);
        const count = mine.size;
        const reward = this.params.rewards.find((t) => t.at === count)?.cash ?? 0;
        out.push({ playerId, index: i, found: count, total, reward });
        break; // one per player per tick; they are never stacked
      }
    }
    return out;
  }
}
