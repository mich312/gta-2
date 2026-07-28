import { randomUUID } from 'node:crypto';
import {
  type Catalog,
  type CityMap,
  type DistrictType,
  type GameState,
  type SimCommand,
  type SimEvent,
  TILE_SIZE,
  districtAt,
  getTuning,
  stuntReward,
} from 'shared';
import { Ledger } from './ledger.js';
import { Accounts } from './accounts.js';
import { AwardTracker, type EconomyParams } from './awards.js';
import { Standings } from './districts.js';
import { Secrets, parseSecretParams } from './secrets.js';
import { MemoryStore, type PersistenceStore } from './store.js';

/**
 * What the jaws hand back when they pay in kind. Ordered, not random: the
 * cadence is a counter, so a session's prizes are reproducible and nobody
 * has to reason about an rng living outside the sim.
 */
const CRUSH_PRIZES: Array<{ weaponId: string; ammo: number }> = [
  { weaponId: 'pistol', ammo: 60 },
  { weaponId: 'shotgun', ammo: 16 },
  { weaponId: 'smg', ammo: 90 },
  { weaponId: 'molotov', ammo: 4 },
  { weaponId: 'grenade', ammo: 3 },
  { weaponId: 'rocket', ammo: 2 },
];

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
  /** Lifetime earned per district: how well each one knows you (L3). */
  standing: Record<string, number>;
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
  /** Where each player is known, and what that buys them. See districts.ts. */
  private readonly standings: Standings;
  /** Who has found which hidden packages. See secrets.ts. */
  readonly secrets: Secrets;
  /** Latest state/map, stashed by processTick so `credit` knows where you are. */
  private currentState: GameState | null = null;
  private currentMap: CityMap | null = null;
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
    this.standings = new Standings(params.districts);
    this.secrets = new Secrets(params.secrets);
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
    this.standings.forget(playerId);
    this.secrets.forget(playerId);
    this.lifetimeByPlayer.delete(playerId);
  }

  cashOf(playerId: number): number {
    const key = this.keyByPlayer.get(playerId);
    return key ? this.ledgerFor(key).balance(key) : 0;
  }

  multiplierOf(playerId: number): number {
    return this.multiplierByPlayer.get(playerId) ?? 1;
  }

  /**
   * Pay for crossing a hidden-package threshold.
   *
   * Straight through the same ledger as everything else, but NOT through
   * `credit` — a package reward must not be multiplied. The multiplier says
   * what the next thing you do is worth; a find is a fixed prize for a fixed
   * number of them, and scaling it by a streak you happened to be on would
   * make the same hundredth package worth ten times as much to one player.
   */
  creditSecret(playerId: number, amount: number, at: number): void {
    const key = this.keyByPlayer.get(playerId);
    if (!key || amount <= 0) return;
    if (this.ledgerFor(key).append(key, amount, `package:${at}`, `package:${key}:${at}`)) {
      this.lifetimeByPlayer.set(playerId, (this.lifetimeByPlayer.get(playerId) ?? 0) + amount);
    }
  }

  /** Where this player is known, and how well. */
  standingsOf(playerId: number): Record<string, number> {
    return this.standings.view(playerId);
  }

  /** Cash, multiplier and lifetime earnings — what the `wallet` message carries. */
  walletOf(playerId: number): Wallet {
    return {
      cash: this.cashOf(playerId),
      multiplier: this.multiplierOf(playerId),
      lifetime: this.lifetimeByPlayer.get(playerId) ?? 0,
      standing: this.standings.view(playerId),
    };
  }

  /**
   * A job done. Pays through the same chokepoint as everything else, then
   * raises the multiplier — the big one, and what finally makes it climb the
   * way the original's did.
   */
  payMission(playerId: number, pay: number): void {
    this.credit(playerId, pay, 'mission');
    this.raiseMultiplier(playerId, this.params.multiplier.missionGain);
  }

  /** Fares, casualties and bounties. Multiplied like every other earning. */
  payJob(playerId: number, amount: number): void {
    this.credit(playerId, amount, 'job');
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
    const drivethrough = item.kind === 'spray' || item.kind === 'fitting';
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

    // The upper shelf is what a district decides it trusts you with. Refused
    // with a reason rather than silently, because a shop that ignores you is
    // a bug from the far side of the screen.
    const district = districtAt(
      map,
      Math.floor(player.pos.x / TILE_SIZE),
      Math.floor(player.pos.y / TILE_SIZE),
    );
    if (!this.standings.mayBuy(playerId, district, itemId)) {
      return fail(`${district} does not know you well enough for that yet`);
    }

    const ledger = this.ledgerFor(key);
    const ref = `buy:${randomUUID()}`;
    if (!ledger.append(key, -item.price, `buy:${itemId}`, ref)) {
      return fail('not enough cash');
    }

    let command: SimCommand;
    if (item.kind === 'spray') {
      command = { type: 'clearHeat', playerId };
    } else if (item.kind === 'fitting') {
      command = { type: 'fitVehicle', playerId, fitting: item.fitting, ammo: item.ammo };
    } else if (item.kind === 'heal') {
      command = { type: 'healPlayer', playerId, health: item.health, armour: item.armour };
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

  /**
   * The export list: three vehicle kinds the city is currently paying over
   * the odds for, rotated on a timer. This is the "city has a shopping list"
   * job — the thing that makes a player look at traffic as inventory rather
   * than scenery, and the reason to drive past three cars to steal a fourth.
   *
   * Server-side and wall-clock, like every other cashier decision: it never
   * enters step(), so it cannot desync anything.
   */
  private exportList: string[] = [];
  private exportRotatedAtMs = 0;
  /** Bumped on every rotation so callers can tell a stale list from a fresh one. */
  exportListVersion = 0;

  get exportBonus(): number {
    return this.params.crush.exportBonus;
  }

  exports(nowMs: number): string[] {
    const { listSize, refreshSec } = this.params.crush;
    if (this.exportList.length === 0 || nowMs - this.exportRotatedAtMs >= refreshSec * 1000) {
      const kinds = Object.keys(this.params.crush.byKind).filter((k) => k !== 'copcar');
      // Rotate by a stepping offset rather than at random: the sequence is
      // reproducible from the tick clock, and every kind gets its turn
      // instead of one kind being wanted three lists running.
      const start = (this.exportListVersion * listSize) % Math.max(1, kinds.length);
      this.exportList = [];
      for (let i = 0; i < listSize && i < kinds.length; i++) {
        this.exportList.push(kinds[(start + i) % kinds.length] as string);
      }
      this.exportRotatedAtMs = nowMs;
      this.exportListVersion++;
    }
    return this.exportList;
  }

  /**
   * Crush whatever the player is driving, if they have driven it into the
   * jaws. Returns the commands the session should queue, and pays out.
   *
   * The payout is sometimes equipment rather than cash, which is the whole
   * point: it closes the loop between the theft verb and the combat verb, so
   * a stolen car is not just money, it is ammunition.
   */
  private tryCrush(
    playerId: number,
    state: GameState,
    map: CityMap,
    nowMs: number,
    out: SimCommand[],
  ): boolean {
    const p = state.players.byId[playerId];
    if (!p || p.mode !== 'driving' || p.vehicleId === null) return false;
    const v = state.vehicles.byId[p.vehicleId];
    if (!v) return false;
    // Has to be stopped in the jaws: driving through at speed is not
    // delivering a car, it is passing one.
    if (Math.abs(v.speed) > 30) return false;
    const t = this.params.crush;
    const inJaws = map.cranes.some(
      (c) => Math.abs(c.x - v.pos.x) <= t.radius && Math.abs(c.y - v.pos.y) <= t.radius,
    );
    if (!inJaws) return false;

    const wanted = this.exports(nowMs).includes(v.kind);
    const base = t.byKind[v.kind] ?? t.base;
    // A crusher that knows you pays better than one that does not. The
    // district's standing is where the car is delivered, not where it was
    // stolen — the yard is the business you have a relationship with.
    const rate = this.standings.crusherRate(
      playerId,
      districtAt(map, Math.floor(v.pos.x / TILE_SIZE), Math.floor(v.pos.y / TILE_SIZE)),
    );
    const amount = Math.floor(base * (wanted ? t.exportBonus : 1) * rate);
    out.push({ type: 'crushVehicle', vehicleId: v.id });
    this.credit(playerId, amount, `crush:${v.kind}`);

    // Equipment instead of only cash, on a deterministic-enough cadence: the
    // crusher hands back a weapon roughly a third of the time.
    this.crushCount++;
    if (this.crushCount % Math.max(1, Math.round(1 / t.equipmentChance)) === 0) {
      const prize = CRUSH_PRIZES[this.crushCount % CRUSH_PRIZES.length] as {
        weaponId: string;
        ammo: number;
      };
      out.push({ type: 'grantWeapon', playerId, weaponId: prize.weaponId, ammo: prize.ammo });
    }
    return true;
  }

  private crushCount = 0;

  /** Consume sim events + state for cash awards. Returns players whose wallet changed. */
  processTick(
    events: SimEvent[],
    state: GameState,
    nowMs: number,
    map?: CityMap,
    outCommands?: SimCommand[],
  ): Set<number> {
    // Stashed so `credit` can attribute an award to where it happened. The
    // whole of district standing hangs off this one line.
    this.currentState = state;
    this.currentMap = map ?? this.currentMap;
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
      } else if (ev.type === 'pickupTaken' && ev.kind === 'multi') {
        // The crate's entire effect. It lands here rather than in the sim
        // because nothing in step() reads a multiplier, and it goes through
        // raiseMultiplier so the cap applies to it exactly as it does to a
        // finished frenzy — a crate that handed out the ceiling would make
        // the two things the multiplier rewards not worth doing.
        this.raiseMultiplier(ev.playerId, this.params.multiplier.pickupGain);
      } else if (ev.type === 'busted') {
        // The cost of an arrest is the run, not the trip. Death does not do
        // this — that asymmetry is the whole reason both exist.
        this.penaliseMultiplier(ev.playerId);
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
      if (map && outCommands && this.tryCrush(id, state, map, nowMs, outCommands)) {
        changed.add(id);
        continue; // the car is gone; it does not also earn driving pay
      }
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
      this.standings.credit(playerId, this.districtOfPlayer(playerId), scaled);
    }
    return ok;
  }

  /**
   * Which district a player is standing in right now, for attributing what
   * they just earned. Read here rather than passed by every caller: there is
   * one chokepoint and it already knows who, so it may as well know where.
   */
  private districtOfPlayer(playerId: number): DistrictType | null {
    const state = this.currentState;
    const map = this.currentMap;
    if (!state || !map) return null;
    const p = state.players.byId[playerId];
    if (!p) return null;
    return districtAt(map, Math.floor(p.pos.x / TILE_SIZE), Math.floor(p.pos.y / TILE_SIZE));
  }
}

function activeWeaponId(player: { weapons: Array<{ weaponId: string }>; activeWeapon: number }):
  | string
  | null {
  return player.weapons[player.activeWeapon]?.weaponId ?? null;
}
