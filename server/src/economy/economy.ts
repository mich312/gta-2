import { randomUUID } from 'node:crypto';
import {
  type Catalog,
  type CityMap,
  type GameState,
  type SimCommand,
  type SimEvent,
  TILE_SIZE,
  getTuning,
  stuntReward,
} from 'shared';
import { Ledger } from './ledger.js';
import { Accounts } from './accounts.js';
import { AwardTracker, type EconomyParams } from './awards.js';
import { MemoryStore, type PersistenceStore } from './store.js';

const DOORWAY_RADIUS_PX = TILE_SIZE * 1.25;

export interface BuyResult {
  ok: boolean;
  message: string;
  /** Command for the sim when the purchase grants something physical. */
  command: SimCommand | null;
  cash: number;
}

/** Everything the HUD needs about a player's standing, in one shot. */
export interface Wallet {
  cash: number;
  multiplier: number;
  /** Total ever earned this session. Flavour — the rank is cash. */
  lifetime: number;
}

/**
 * The economy facade: cash, purchases, awards, accounts. Lives entirely
 * outside the deterministic sim — its only write-path into the sim is the
 * SimCommands it returns, which the session queues and records like inputs.
 */
export class Economy {
  /** Account wallets: persistent store. */
  private readonly acctLedger: Ledger;
  /** Guest wallets are session-scoped by design: pure memory, never on disk. */
  private readonly guestLedger = new Ledger(new MemoryStore());
  readonly accounts: Accounts;
  private readonly awards: AwardTracker;
  /** playerId -> accountKey (guest:<uuid> or acct:<username>) */
  private readonly keyByPlayer = new Map<number, string>();
  private readonly usernameByPlayer = new Map<number, string>();
  /**
   * Score multiplier, per player. Session-scoped on purpose: it is a streak,
   * and a streak that survives logout is not a streak. Never persisted, never
   * in the sim — nothing in step() reads a multiplier.
   */
  private readonly multiplierByPlayer = new Map<number, number>();
  private readonly lifetimeByPlayer = new Map<number, number>();

  constructor(
    store: PersistenceStore,
    readonly catalog: Catalog,
    private readonly params: EconomyParams,
  ) {
    this.acctLedger = new Ledger(store);
    this.accounts = new Accounts(store);
    this.awards = new AwardTracker(params);
  }

  private ledgerFor(accountKey: string): Ledger {
    return accountKey.startsWith('guest:') ? this.guestLedger : this.acctLedger;
  }

  /** Guests get a fresh session-scoped wallet with starting cash. */
  bindGuest(playerId: number): void {
    const key = `guest:${randomUUID()}`;
    this.keyByPlayer.set(playerId, key);
    this.usernameByPlayer.delete(playerId);
    this.guestLedger.append(key, this.params.startingCash, 'starting-cash', `start:${key}`);
  }

  /** After successful login: switch the player's wallet to the account. */
  bindAccount(playerId: number, username: string): void {
    const key = `acct:${username.toLowerCase()}`;
    this.keyByPlayer.set(playerId, key);
    this.usernameByPlayer.set(playerId, username);
    // First login ever: seed starting cash (idempotent ref).
    this.acctLedger.append(key, this.params.startingCash, 'starting-cash', `start:${key}`);
  }

  unbind(playerId: number): void {
    this.keyByPlayer.delete(playerId);
    this.usernameByPlayer.delete(playerId);
    this.multiplierByPlayer.delete(playerId);
    this.lifetimeByPlayer.delete(playerId);
  }

  cashOf(playerId: number): number {
    const key = this.keyByPlayer.get(playerId);
    return key ? this.ledgerFor(key).balance(key) : 0;
  }

  multiplierOf(playerId: number): number {
    return this.multiplierByPlayer.get(playerId) ?? 1;
  }

  /** Cash, multiplier and lifetime earnings — what the `wallet` message carries. */
  walletOf(playerId: number): Wallet {
    return {
      cash: this.cashOf(playerId),
      multiplier: this.multiplierOf(playerId),
      lifetime: this.lifetimeByPlayer.get(playerId) ?? 0,
    };
  }

  /** Success raises the multiplier, capped. Returns the new value. */
  raiseMultiplier(playerId: number, gain: number): number {
    const next = Math.min(this.params.multiplier.max, this.multiplierOf(playerId) + gain);
    this.multiplierByPlayer.set(playerId, next);
    return next;
  }

  /**
   * Arrest halves it — floor 1, rounded down. Death deliberately does NOT
   * call this: the asymmetry between busted and wasted is the whole point of
   * having two failure modes.
   */
  penaliseMultiplier(playerId: number): number {
    const next = Math.max(
      1,
      Math.floor(this.multiplierOf(playerId) * this.params.multiplier.bustPenalty),
    );
    this.multiplierByPlayer.set(playerId, next);
    return next;
  }

  equippedCosmetic(playerId: number): number {
    const username = this.usernameByPlayer.get(playerId);
    if (!username) return 0;
    return this.accounts.get(username)?.equippedCosmetic ?? 0;
  }

  /**
   * Validate and execute a purchase. The server is the cashier: position,
   * shop kind, price, and balance are all checked against server state.
   */
  buy(playerId: number, itemId: string, state: GameState, map: CityMap): BuyResult {
    const key = this.keyByPlayer.get(playerId);
    const player = state.players.byId[playerId];
    const fail = (message: string): BuyResult => ({
      ok: false,
      message,
      command: null,
      cash: key ? this.ledgerFor(key).balance(key) : 0,
    });
    if (!key || !player) return fail('no wallet');
    const item = this.catalog[itemId];
    if (!item) return fail('no such item');
    // A respray is the one thing you buy WITHOUT getting out — you drive the
    // hot car into the garage. Everything else is a shop counter.
    const drivethrough = item.kind === 'spray';
    if (!drivethrough && player.mode !== 'foot') return fail('step out of the car first');
    if (drivethrough && player.mode !== 'driving') return fail('drive a car into the garage');

    // Must be standing (or parked) in the doorway of the right shop kind, or
    // inside the shop itself — the buildings are hollow now, and the counter
    // is the obvious place to expect to be served.
    const inShop = map.shops.some((s) => {
      if (s.kind !== item.shop) return false;
      const cx = (s.doorX + 0.5) * TILE_SIZE;
      const cy = (s.doorY + 0.5) * TILE_SIZE;
      const reach = drivethrough ? DOORWAY_RADIUS_PX * 2 : DOORWAY_RADIUS_PX;
      if (Math.abs(player.pos.x - cx) < reach && Math.abs(player.pos.y - cy) < reach) return true;
      const r = s.interior;
      return (
        player.pos.x >= r.x * TILE_SIZE &&
        player.pos.y >= r.y * TILE_SIZE &&
        player.pos.x <= (r.x + r.w) * TILE_SIZE &&
        player.pos.y <= (r.y + r.h) * TILE_SIZE
      );
    });
    if (!inShop) return fail(`find a ${item.shop} shop`);

    const ledger = this.ledgerFor(key);
    const ref = `buy:${randomUUID()}`;
    if (!ledger.append(key, -item.price, `buy:${itemId}`, ref)) {
      return fail('not enough cash');
    }

    let command: SimCommand;
    if (item.kind === 'spray') {
      command = { type: 'clearHeat', playerId };
    } else if (item.kind === 'cosmetic') {
      const username = this.usernameByPlayer.get(playerId);
      if (username) this.accounts.addCosmetic(username, item.cosmeticId);
      command = { type: 'setCosmetic', playerId, cosmeticId: item.cosmeticId };
    } else {
      const weaponId = item.kind === 'ammo' ? activeWeaponId(player) : itemId;
      if (!weaponId) {
        // Refund: buying ammo with no weapon. (Refund is a new tx — the
        // ledger stays append-only and the audit trail shows both.)
        ledger.append(key, item.price, `refund:${itemId}`, `refund:${ref}`);
        return fail('no weapon to buy ammo for');
      }
      command = { type: 'grantWeapon', playerId, weaponId, ammo: item.ammo };
    }
    return { ok: true, message: `bought ${itemId}`, command, cash: ledger.balance(key) };
  }

  /** Consume sim events + state for cash awards. Returns players whose wallet changed. */
  processTick(events: SimEvent[], state: GameState, nowMs: number): Set<number> {
    const changed = new Set<number>();
    for (const ev of events) {
      if (ev.type === 'kill' && ev.killerId >= 0) {
        const amount = this.awards.killAward(ev.killerId, ev.victimId, nowMs);
        if (amount > 0 && this.credit(ev.killerId, amount, `kill:${ev.victimId}`)) {
          changed.add(ev.killerId);
        }
        this.bumpScore(ev.killerId, 1);
      } else if (ev.type === 'frenzyEnded' && ev.completed) {
        // Paid only on completion — the timer is what makes it a frenzy.
        const reward = getTuning().pickups.frenzyReward;
        if (this.credit(ev.playerId, reward, `frenzy:${ev.tick}`)) changed.add(ev.playerId);
        this.bumpScore(ev.playerId, 0, 1);
        // Pay at the multiplier you had, THEN raise it: the frenzy you just
        // finished is worth what it was worth, and the next one is worth more.
        this.raiseMultiplier(ev.playerId, this.params.multiplier.frenzyGain);
        changed.add(ev.playerId);
      } else if (ev.type === 'stuntLanded') {
        const reward = stuntReward(ev.distance);
        if (reward > 0 && this.credit(ev.playerId, reward, `stunt:${ev.tick}`)) {
          changed.add(ev.playerId);
        }
        this.bumpScore(ev.playerId, 0, 0, ev.distance);
      }
    }
    for (const id of state.players.ids) {
      const p = state.players.byId[id];
      if (!p || p.mode !== 'driving' || p.vehicleId === null) continue;
      const v = state.vehicles.byId[p.vehicleId];
      if (!v) continue;
      const amount = this.awards.drivingAward(id, v.pos.x, v.pos.y, v.speed, nowMs);
      if (amount > 0 && this.credit(id, amount, 'driving')) changed.add(id);
    }
    return changed;
  }

  /** Running per-session tally, surfaced to the client and the leaderboard. */
  readonly scores = new Map<number, { kills: number; frenzies: number; bestStunt: number }>();

  private bumpScore(playerId: number, kills = 0, frenzies = 0, stuntDistance = 0): void {
    let sc = this.scores.get(playerId);
    if (!sc) {
      sc = { kills: 0, frenzies: 0, bestStunt: 0 };
      this.scores.set(playerId, sc);
    }
    sc.kills += kills;
    sc.frenzies += frenzies;
    sc.bestStunt = Math.max(sc.bestStunt, stuntDistance);
  }

  /**
   * Session leaderboard, richest first. The rank is **cash**, exactly as the
   * originals ranked on a score that doubled as your wallet: spending is
   * supposed to cost you standing, or the shops are free in the only currency
   * that matters. Kills and frenzies survive as tie-breaks and flavour.
   */
  leaderboard(): Array<{
    playerId: number;
    cash: number;
    multiplier: number;
    kills: number;
    frenzies: number;
    bestStunt: number;
  }> {
    const ids = new Set([...this.scores.keys(), ...this.keyByPlayer.keys()]);
    return [...ids]
      .map((playerId) => ({
        playerId,
        cash: this.cashOf(playerId),
        multiplier: this.multiplierOf(playerId),
        ...(this.scores.get(playerId) ?? { kills: 0, frenzies: 0, bestStunt: 0 }),
      }))
      .sort((a, b) => b.cash - a.cash || b.kills - a.kills || b.bestStunt - a.bestStunt);
  }

  /**
   * The one place an award becomes money. Every earning path in this class
   * goes through here and gets multiplied — that is what makes the multiplier
   * a real mechanic rather than a HUD decoration, and `awardSources()` exists
   * so a future path that forgets cannot land silently.
   *
   * Debits (purchases) and starting cash deliberately bypass it: you do not
   * pay ×3 for a pistol, and a multiplier on your opening balance would be
   * free money.
   */
  private credit(playerId: number, amount: number, reason: string): boolean {
    const key = this.keyByPlayer.get(playerId);
    if (!key) return false;
    const scaled = Math.floor(amount * this.multiplierOf(playerId));
    if (scaled <= 0) return false;
    const ok = this.ledgerFor(key).append(key, scaled, reason, `award:${randomUUID()}`);
    if (ok) {
      this.lifetimeByPlayer.set(playerId, (this.lifetimeByPlayer.get(playerId) ?? 0) + scaled);
    }
    return ok;
  }
}

function activeWeaponId(player: { weapons: Array<{ weaponId: string }>; activeWeapon: number }):
  | string
  | null {
  return player.weapons[player.activeWeapon]?.weaponId ?? null;
}
