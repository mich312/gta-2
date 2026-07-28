import type { DistrictType } from 'shared';
import { DISTRICT_TYPES } from 'shared';

/**
 * District standing: how well a district knows you.
 *
 * The originals gated geography on score — reach a threshold, the next
 * district unlocks. `AUDIT.md` records why this project cannot do that: in a
 * shared city, locking a district locks it for a player standing next to
 * somebody who is already inside it, and there is no single-player level
 * target to be set back from.
 *
 * So the geography stays open and the **services** are what you earn. You can
 * walk anywhere from your first minute; what you can *do* there grows with
 * what you have done there. That preserves the thing the original was
 * reaching for — there is more city than you have earned yet — without a wall,
 * and it composes with respect rather than duplicating it:
 *
 *   respect is WHO trusts you.  standing is WHERE you are known.
 *
 * Server-side, like the multiplier and for the same reason: nothing in
 * `step()` reads it.
 */

export interface DistrictParams {
  /** Lifetime earnings in a district before its upper shelf opens. */
  shelfAt: number;
  /** ...and before the crusher there pays the better rate. */
  crusherAt: number;
  /** How much more the crusher pays once it knows you. */
  crusherBonus: number;
  /** Shop items gated behind the upper shelf, by item id. */
  gatedItems: string[];
}

export const DEFAULT_DISTRICTS: DistrictParams = {
  shelfAt: 6000,
  crusherAt: 12000,
  crusherBonus: 1.35,
  gatedItems: ['rocket', 'flamethrower', 'mines'],
};

export function parseDistrictParams(raw: unknown): DistrictParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string, fallback: number): number => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const items = r['gatedItems'];
  return {
    shelfAt: n('shelfAt', DEFAULT_DISTRICTS.shelfAt),
    crusherAt: n('crusherAt', DEFAULT_DISTRICTS.crusherAt),
    crusherBonus: n('crusherBonus', DEFAULT_DISTRICTS.crusherBonus),
    gatedItems: Array.isArray(items)
      ? items.filter((v): v is string => typeof v === 'string')
      : DEFAULT_DISTRICTS.gatedItems,
  };
}

/** Lifetime earned per player per district. */
export class Standings {
  private readonly byPlayer = new Map<number, Map<DistrictType, number>>();

  constructor(private readonly params: DistrictParams) {}

  credit(playerId: number, district: DistrictType | null, amount: number): void {
    if (!district || amount <= 0) return;
    let row = this.byPlayer.get(playerId);
    if (!row) {
      row = new Map();
      this.byPlayer.set(playerId, row);
    }
    row.set(district, (row.get(district) ?? 0) + amount);
  }

  of(playerId: number, district: DistrictType): number {
    return this.byPlayer.get(playerId)?.get(district) ?? 0;
  }

  /** Every district's standing, for the wallet message and the radar. */
  view(playerId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of DISTRICT_TYPES) out[d] = this.of(playerId, d);
    return out;
  }

  forget(playerId: number): void {
    this.byPlayer.delete(playerId);
  }

  /** Restored from the ledger on login, so standing is not a session thing. */
  seed(playerId: number, saved: Record<string, number> | undefined): void {
    if (!saved) return;
    const row = new Map<DistrictType, number>();
    for (const d of DISTRICT_TYPES) {
      const v = saved[d];
      if (typeof v === 'number' && v > 0) row.set(d, v);
    }
    this.byPlayer.set(playerId, row);
  }

  /**
   * May this player buy `itemId` in `district`?
   *
   * Ungated items are always available, everywhere. The gated ones — the
   * launcher, the flamethrower, the mines — are what a district decides it
   * trusts you with, and the refusal reaches the HUD as a reason rather than
   * a silent no-op, because a shop that ignores you is a bug from the far
   * side of the screen.
   */
  mayBuy(playerId: number, district: DistrictType | null, itemId: string): boolean {
    if (!this.params.gatedItems.includes(itemId)) return true;
    if (!district) return false;
    return this.of(playerId, district) >= this.params.shelfAt;
  }

  /** What the crusher in this district pays, as a multiplier. */
  crusherRate(playerId: number, district: DistrictType | null): number {
    if (!district) return 1;
    return this.of(playerId, district) >= this.params.crusherAt
      ? this.params.crusherBonus
      : 1;
  }
}
