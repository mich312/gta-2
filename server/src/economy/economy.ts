import { randomUUID } from 'node:crypto';
import {
  type Catalog,
  type CityMap,
  type GameState,
  type SimCommand,
  type SimEvent,
  TILE_SIZE,
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
  }

  cashOf(playerId: number): number {
    const key = this.keyByPlayer.get(playerId);
    return key ? this.ledgerFor(key).balance(key) : 0;
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
    if (player.mode !== 'foot') return fail('step out of the car first');
    const item = this.catalog[itemId];
    if (!item) return fail('no such item');

    // Must be standing in a doorway of the right shop kind.
    const inShop = map.shops.some((s) => {
      if (s.kind !== item.shop) return false;
      const cx = (s.doorX + 0.5) * TILE_SIZE;
      const cy = (s.doorY + 0.5) * TILE_SIZE;
      return Math.abs(player.pos.x - cx) < DOORWAY_RADIUS_PX && Math.abs(player.pos.y - cy) < DOORWAY_RADIUS_PX;
    });
    if (!inShop) return fail(`find a ${item.shop} shop doorway`);

    const ledger = this.ledgerFor(key);
    const ref = `buy:${randomUUID()}`;
    if (!ledger.append(key, -item.price, `buy:${itemId}`, ref)) {
      return fail('not enough cash');
    }

    let command: SimCommand;
    if (item.kind === 'cosmetic') {
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
      if (ev.type !== 'kill' || ev.killerId < 0) continue;
      const amount = this.awards.killAward(ev.killerId, ev.victimId, nowMs);
      if (amount > 0 && this.credit(ev.killerId, amount, `kill:${ev.victimId}`)) {
        changed.add(ev.killerId);
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

  private credit(playerId: number, amount: number, reason: string): boolean {
    const key = this.keyByPlayer.get(playerId);
    if (!key) return false;
    return this.ledgerFor(key).append(key, amount, reason, `award:${randomUUID()}`);
  }
}

function activeWeaponId(player: { weapons: Array<{ weaponId: string }>; activeWeapon: number }):
  | string
  | null {
  return player.weapons[player.activeWeapon]?.weaponId ?? null;
}
