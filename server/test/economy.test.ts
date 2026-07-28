import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import worldgenJson from '../../shared/data/worldgen.json';
import shopJson from '../../shared/data/shop.json';
import economyJson from '../../shared/data/economy.json';
import {
  type GameState,
  type SimCommand,
  type SimEvent,
  TILE_SIZE,
  createGameState,
  generateCity,
  initTuning,
  parseCatalog,
  parseWorldgenParams,
  step,
} from 'shared';
import { FileStore, MemoryStore, type PersistenceStore } from '../src/economy/store.js';
import { SqliteStore, sqliteAvailable } from '../src/economy/sqliteStore.js';
import { Ledger } from '../src/economy/ledger.js';
import { Accounts } from '../src/economy/accounts.js';
import { AwardTracker, parseEconomyParams } from '../src/economy/awards.js';
import { Economy } from '../src/economy/economy.js';

const catalog = parseCatalog(shopJson);
const params = parseEconomyParams(economyJson);
const worldgen = parseWorldgenParams(worldgenJson);

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson, weapons: weaponsJson });
});

describe('ledger', () => {
  it('is append-only, idempotent by ref, and never overdraws', () => {
    const ledger = new Ledger(new MemoryStore());
    expect(ledger.append('a', 100, 'seed', 'r1')).toBe(true);
    expect(ledger.append('a', 100, 'seed', 'r1')).toBe(false); // duplicate ref
    expect(ledger.balance('a')).toBe(100);
    expect(ledger.append('a', -150, 'buy', 'r2')).toBe(false); // overdraw
    expect(ledger.append('a', -60, 'buy', 'r3')).toBe(true);
    expect(ledger.balance('a')).toBe(40);
  });
});

describe('accounts', () => {
  it('register + verify; wrong password and unknown user fail', () => {
    const accounts = new Accounts(new MemoryStore());
    expect(accounts.register('alice', 'hunter22').ok).toBe(true);
    expect(accounts.register('ALICE', 'other-pass').ok).toBe(false); // case-insensitive taken
    expect(accounts.verify('alice', 'hunter22')?.username).toBe('alice');
    expect(accounts.verify('alice', 'wrong-pass')).toBeNull();
    expect(accounts.verify('bob', 'hunter22')).toBeNull();
  });
});

describe('awards', () => {
  it('kill awards decay per repeated victim and respect the rate cap', () => {
    const tracker = new AwardTracker(params);
    const t0 = 1_000_000;
    const first = tracker.killAward(1, 2, t0);
    const second = tracker.killAward(1, 2, t0 + 1000);
    const third = tracker.killAward(1, 2, t0 + 2000);
    expect(first).toBe(params.killAward);
    expect(second).toBe(Math.floor(params.killAward * params.killRepeatDecay));
    expect(third).toBeLessThan(second);
    // Fresh victim pays full price again.
    expect(tracker.killAward(1, 3, t0 + 3000)).toBe(params.killAward);
    // Window expiry resets the decay.
    const later = t0 + params.killRepeatWindowSec * 1000 + 5000;
    expect(tracker.killAward(1, 2, later)).toBe(params.killAward);
  });

  it('driving pays novel cells only', () => {
    const tracker = new AwardTracker(params);
    const t0 = 5_000_000;
    const a = tracker.drivingAward(1, 100, 100, 300, t0);
    const again = tracker.drivingAward(1, 110, 105, 300, t0 + 100); // same cell
    const slow = tracker.drivingAward(1, 900, 900, 50, t0 + 200); // too slow
    const fresh = tracker.drivingAward(1, 1000, 1000, 300, t0 + 300);
    expect(a).toBe(params.drivingCellAward);
    expect(again).toBe(0);
    expect(slow).toBe(0);
    expect(fresh).toBe(params.drivingCellAward);
  });
});

describe('purchases', () => {
  function setupShopScenario() {
    const map = generateCity(777, worldgen);
    const economy = new Economy(new MemoryStore(), catalog, params);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'shopper' }], map);
    economy.bindGuest(1);
    const gunShop = map.shops.find((s) => s.kind === 'gun');
    if (!gunShop) throw new Error('no gun shop generated');
    return { map, economy, state, gunShop };
  }

  it('rejects buys away from the doorway; accepts in it; charges exactly once', () => {
    const { map, economy, state, gunShop } = setupShopScenario();
    const before = economy.cashOf(1);

    const away = economy.buy(1, 'pistol', state, map);
    expect(away.ok).toBe(false);
    expect(economy.cashOf(1)).toBe(before);

    // Stand in the doorway (server-side test may position directly).
    state.players.byId[1]!.pos = {
      x: (gunShop.doorX + 0.5) * TILE_SIZE,
      y: (gunShop.doorY + 0.5) * TILE_SIZE,
    };
    const ok = economy.buy(1, 'pistol', state, map);
    expect(ok.ok).toBe(true);
    expect(ok.command).toEqual({ type: 'grantWeapon', playerId: 1, weaponId: 'pistol', ammo: 60 });
    expect(economy.cashOf(1)).toBe(before - 250);

    // Clothing item in a gun shop: rejected.
    const wrongShop = economy.buy(1, 'jacket_red', state, map);
    expect(wrongShop.ok).toBe(false);

    // Burn the wallet down; the last unaffordable buy must not go through.
    let guard = 20;
    while (economy.cashOf(1) >= 250 && guard-- > 0) economy.buy(1, 'pistol', state, map);
    const broke = economy.buy(1, 'shotgun', state, map);
    expect(broke.ok).toBe(false);
  });
});

describe('persistence (the phase gate: a purchase survives a server restart)', () => {
  // Same scenario against both implementations: SQLite (node:sqlite, the
  // default) and the JSON FileStore. The economy cannot tell them apart.
  // The sqlite rows drop out on Node builds without node:sqlite (see
  // sqliteStore.ts) — the store cannot exist there, and createStore's fallback
  // is what covers those runtimes instead.
  const backends: Array<[string, (dir: string) => PersistenceStore]> = [
    ...(sqliteAvailable()
      ? ([['sqlite', (dir: string) => new SqliteStore(join(dir, 'persist.db'))]] as const)
      : []),
    ['file', (dir) => new FileStore(join(dir, 'persist.json'))],
  ];

  for (const [name, open] of backends) {
    it(`${name}: cash, transactions, and cosmetics reload from disk`, () => {
      const dir = mkdtempSync(join(tmpdir(), `persist-${name}-`));

      {
        const store = open(dir);
        const accounts = new Accounts(store);
        const ledger = new Ledger(store);
        accounts.register('carol', 'secret-pw');
        ledger.append('acct:carol', 400, 'starting-cash', 'start:acct:carol');
        ledger.append('acct:carol', -300, 'buy:jacket_red', 'buy:tx-1');
        accounts.addCosmetic('carol', 1);
        // process "dies" here — every write is already durable
      }

      const store2 = open(dir);
      const accounts2 = new Accounts(store2);
      const ledger2 = new Ledger(store2);
      expect(ledger2.balance('acct:carol')).toBe(100);
      expect(accounts2.verify('carol', 'secret-pw')?.cosmeticsOwned).toEqual([1]);
      expect(accounts2.get('carol')?.equippedCosmetic).toBe(1);
      // Idempotency survives restart too: replaying the old tx does nothing.
      expect(ledger2.append('acct:carol', -300, 'buy:jacket_red', 'buy:tx-1')).toBe(false);
      expect(ledger2.balance('acct:carol')).toBe(100);
    });
  }

  it.skipIf(!sqliteAvailable())(
    'sqlite: a raw duplicate ref throws at the store (backstop under the ledger)',
    () => {
      const store = new SqliteStore(':memory:');
      const tx = { ref: 'r1', accountKey: 'a', delta: 5, reason: 'x', at: 'now' };
      store.appendTransaction(tx);
      expect(() => store.appendTransaction(tx)).toThrow();
      expect(store.hasRef('r1')).toBe(true);
    },
  );
});

describe('score multiplier', () => {
  function setup() {
    const map = generateCity(777, worldgen);
    const economy = new Economy(new MemoryStore(), catalog, params);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'earner' }], map);
    economy.bindGuest(1);
    return { map, economy, state };
  }

  /** Cash earned by running exactly these events through the economy. */
  function earn(economy: Economy, state: GameState, events: SimEvent[], nowMs = 1_000_000): number {
    const before = economy.cashOf(1);
    economy.processTick(events, state, nowMs);
    return economy.cashOf(1) - before;
  }

  it('multiplies every award path, and nothing else', () => {
    // The gate from FEATURES.md F1: no earning path may bypass the
    // multiplier. Each award source is driven twice — once at ×1, once at
    // ×3 — and must pay exactly three times as much the second time.
    const paths: Array<[string, (tick: number) => SimEvent[]]> = [
      ['kill', (t) => [{ type: 'kill', tick: t, killerId: 1, victimId: 50 + t, weaponId: 'pistol' }]],
      [
        'frenzy',
        (t) => [{ type: 'frenzyEnded', tick: t, playerId: 1, kills: 5, target: 5, completed: true }],
      ],
      ['stunt', (t) => [{ type: 'stuntLanded', tick: t, playerId: 1, distance: 200, x: 0, y: 0 }]],
    ];

    for (const [name, mk] of paths) {
      const plain = setup();
      const base = earn(plain.economy, plain.state, mk(1));
      expect(base, `${name} pays something at ×1`).toBeGreaterThan(0);

      const boosted = setup();
      boosted.economy.raiseMultiplier(1, 2); // ×3
      expect(boosted.economy.multiplierOf(1)).toBe(3);
      const paid = earn(boosted.economy, boosted.state, mk(1));
      expect(paid, `${name} pays 3x at x3`).toBe(base * 3);
    }
  });

  it('multiplies the driving award too (the path with no event)', () => {
    // Driving pays off state, not events — exactly the kind of path that
    // quietly skips a chokepoint.
    function driveOnce(economy: Economy, state: GameState): number {
      const p = state.players.byId[1]!;
      p.mode = 'driving';
      p.vehicleId = 7;
      state.vehicles.byId[7] = {
        id: 7,
        kind: 'car',
        pos: { x: 4000, y: 4000 },
        heading: 0,
        speed: 300,
        driverId: 1,
        health: 100,
        condition: 'ok',
        fuseAtTick: null,
      };
      state.vehicles.ids = [7];
      const before = economy.cashOf(1);
      economy.processTick([], state, 2_000_000);
      return economy.cashOf(1) - before;
    }

    const plain = setup();
    const base = driveOnce(plain.economy, plain.state);
    expect(base).toBeGreaterThan(0);

    const boosted = setup();
    boosted.economy.raiseMultiplier(1, 2);
    expect(driveOnce(boosted.economy, boosted.state)).toBe(base * 3);
  });

    it('a crate raises the multiplier through the same chokepoint a frenzy does', () => {
      const { economy, state } = setup();
      expect(economy.multiplierOf(1)).toBe(1);
      economy.processTick(
        [{ type: 'pickupTaken', tick: 1, kind: 'multi', playerId: 1, x: 0, y: 0 }],
        state,
        1_000_000,
      );
      expect(economy.multiplierOf(1)).toBe(1 + params.multiplier.pickupGain);
    });

    it('a crate cannot push past the cap', () => {
      // A crate that hands out the ceiling makes frenzies and missions — the
      // two things the multiplier exists to reward — not worth doing.
      const { economy, state } = setup();
      for (let i = 0; i < 40; i++) {
        economy.processTick(
          [{ type: 'pickupTaken', tick: i, kind: 'multi', playerId: 1, x: 0, y: 0 }],
          state,
          1_000_000 + i * 100,
        );
      }
      expect(economy.multiplierOf(1)).toBe(params.multiplier.max);
    });

    it('every other crate leaves the multiplier alone', () => {
      const { economy, state } = setup();
      for (const kind of ['health', 'armour', 'ammo', 'bribe', 'jailcard', 'damage'] as const) {
        economy.processTick(
          [{ type: 'pickupTaken', tick: 1, kind, playerId: 1, x: 0, y: 0 }],
          state,
          1_000_000,
        );
      }
      expect(economy.multiplierOf(1)).toBe(1);
    });

  it('a completed frenzy raises the multiplier, and the cap holds', () => {
    const { economy, state } = setup();
    expect(economy.multiplierOf(1)).toBe(1);
    economy.processTick(
      [{ type: 'frenzyEnded', tick: 1, playerId: 1, kills: 5, target: 5, completed: true }],
      state,
      1_000_000,
    );
    expect(economy.multiplierOf(1)).toBe(1 + params.multiplier.frenzyGain);

    // A failed frenzy pays nothing and raises nothing.
    const before = economy.multiplierOf(1);
    const cash = economy.cashOf(1);
    economy.processTick(
      [{ type: 'frenzyEnded', tick: 2, playerId: 1, kills: 2, target: 5, completed: false }],
      state,
      1_000_100,
    );
    expect(economy.multiplierOf(1)).toBe(before);
    expect(economy.cashOf(1)).toBe(cash);

    for (let i = 0; i < 50; i++) economy.raiseMultiplier(1, 1);
    expect(economy.multiplierOf(1)).toBe(params.multiplier.max);
  });

  it('arrest halves it and death does not; the floor is 1', () => {
    const { economy } = setup();
    economy.raiseMultiplier(1, 5); // ×6
    expect(economy.penaliseMultiplier(1)).toBe(3);
    expect(economy.penaliseMultiplier(1)).toBe(1); // floor(3*0.5)=1
    expect(economy.penaliseMultiplier(1)).toBe(1); // never below 1
  });

  it('purchases are not multiplied — you do not pay x3 for a pistol', () => {
    const map = generateCity(777, worldgen);
    const economy = new Economy(new MemoryStore(), catalog, params);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'shopper' }], map);
    economy.bindGuest(1);
    economy.raiseMultiplier(1, 4);
    const gunShop = map.shops.find((s) => s.kind === 'gun')!;
    state.players.byId[1]!.pos = {
      x: (gunShop.doorX + 0.5) * TILE_SIZE,
      y: (gunShop.doorY + 0.5) * TILE_SIZE,
    };
    const before = economy.cashOf(1);
    expect(economy.buy(1, 'pistol', state, map).ok).toBe(true);
    expect(economy.cashOf(1)).toBe(before - 250);
  });

  it('starting cash is not multiplied either', () => {
    const economy = new Economy(new MemoryStore(), catalog, params);
    economy.bindGuest(1);
    economy.raiseMultiplier(1, 3);
    economy.bindAccount(1, 'dave');
    expect(economy.cashOf(1)).toBe(params.startingCash);
  });

  it('the leaderboard ranks on cash, not on kills', () => {
    const { economy, state } = setup();
    economy.bindGuest(2);
    // Player 2 gets one kill; player 1 gets none but is handed cash by
    // spending nothing and earning a big stunt.
    economy.processTick(
      [
        { type: 'kill', tick: 1, killerId: 2, victimId: 9, weaponId: 'pistol' },
        { type: 'stuntLanded', tick: 1, playerId: 1, distance: 900, x: 0, y: 0 },
      ],
      state,
      3_000_000,
    );
    const board = economy.leaderboard();
    expect(board[0]!.playerId).toBe(1);
    expect(board[0]!.cash).toBeGreaterThan(board[1]!.cash);
    expect(board[1]!.kills).toBe(1); // the killer is still ranked below
  });

  it('no new earning path can bypass the chokepoint unnoticed', () => {
    // The behavioural tests above cover the paths that exist today. This one
    // is for the path somebody adds next year: every write to a ledger in
    // Economy is enumerated here, so a new one fails this test and forces a
    // decision — route it through credit(), or add it to this list and say
    // why it is exempt.
    const src = readFileSync(new URL('../src/economy/economy.ts', import.meta.url), 'utf8');
    const sites = src.match(/\.append\(/g) ?? [];
    const exempt = [
      "guestLedger.append(key, this.params.startingCash", // opening balance
      "acctLedger.append(key, this.params.startingCash", // opening balance
      'ledger.append(key, -item.price', // a purchase is a debit
      'ledger.append(key, item.price', // its refund
    ];
    for (const e of exempt) expect(src, `exempt site missing: ${e}`).toContain(e);
    // exempt sites + the single credit() site
    expect(
      sites.length,
      'a ledger write was added to Economy: route earnings through credit() so they are multiplied, or list it as exempt here',
    ).toBe(exempt.length + 1);
  });

  it('lifetime earnings accumulate the multiplied amounts', () => {
    const { economy, state } = setup();
    economy.raiseMultiplier(1, 1); // x2
    economy.processTick(
      [{ type: 'kill', tick: 1, killerId: 1, victimId: 5, weaponId: 'pistol' }],
      state,
      4_000_000,
    );
    expect(economy.walletOf(1).lifetime).toBe(params.killAward * 2);
    expect(economy.walletOf(1).multiplier).toBe(2);
  });
});

describe("Pay'n'Spray", () => {
  function setupGarage() {
    const map = generateCity(777, worldgen);
    const economy = new Economy(new MemoryStore(), catalog, params);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    economy.bindGuest(1);
    const garage = map.shops.find((s) => s.kind === 'spray');
    if (!garage) throw new Error('no spray garage generated');
    return { map, economy, state, garage };
  }

  it('worldgen places respray garages', () => {
    const map = generateCity(777, worldgen);
    expect(map.shops.filter((s) => s.kind === 'spray').length).toBeGreaterThan(0);
  });

  it('refuses a respray on foot — you drive the hot car in', () => {
    const { map, economy, state, garage } = setupGarage();
    const p = state.players.byId[1]!;
    p.pos = { x: (garage.doorX + 0.5) * TILE_SIZE, y: (garage.doorY + 0.5) * TILE_SIZE };
    p.heat = 350;
    const res = economy.buy(1, 'respray', state, map);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/drive/i);
  });

  it('clears heat outright, and the cops lose interest', () => {
    const { map, economy, state, garage } = setupGarage();
    const p = state.players.byId[1]!;
    p.pos = { x: (garage.doorX + 0.5) * TILE_SIZE, y: (garage.doorY + 0.5) * TILE_SIZE };
    p.heat = 450;
    // In a car, parked in the garage doorway.
    p.mode = 'driving';
    p.vehicleId = 99;

    const cashBefore = economy.cashOf(1);
    const res = economy.buy(1, 'respray', state, map);
    expect(res.ok).toBe(true);
    expect(res.command).toEqual({ type: 'clearHeat', playerId: 1 });
    expect(economy.cashOf(1)).toBeLessThan(cashBefore);

    // The command is what actually does it, at a tick boundary like any other.
    const after = step(state, {}, [res.command!], map);
    expect(after.players.byId[1]!.heat).toBe(0);
    expect(after.players.byId[1]!.wantedLevel).toBe(0);
  });
});

describe('car crusher and the export list (G1)', () => {
  const craneMap = generateCity(777, worldgen);

  function setupCrane() {
    const economy = new Economy(new MemoryStore(), catalog, params);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], craneMap);
    economy.bindGuest(1); // no wallet, no payout — the crusher still eats the car
    const crane = craneMap.cranes[0];
    if (!crane) throw new Error('no crane generated');
    return { economy, state, crane };
  }

  /** Park `kind` in the jaws with the player at the wheel. */
  function driveIn(
    state: GameState,
    crane: { x: number; y: number },
    kind: string,
  ): GameState {
    const s = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 40, kind, x: crane.x, y: crane.y, heading: 0 }],
      craneMap,
    );
    const p = s.players.byId[1]!;
    p.pos = { x: crane.x, y: crane.y };
    p.mode = 'driving';
    p.vehicleId = 40;
    s.vehicles.byId[40]!.driverId = 1;
    s.vehicles.byId[40]!.speed = 0;
    return s;
  }

  it('worldgen places crushers, spread out across the city', () => {
    expect(craneMap.cranes.length).toBeGreaterThan(0);
    for (let i = 0; i < craneMap.cranes.length; i++) {
      for (let j = i + 1; j < craneMap.cranes.length; j++) {
        const a = craneMap.cranes[i]!;
        const b = craneMap.cranes[j]!;
        expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(600);
      }
    }
  });

  it('a car driven into the jaws is crushed and paid for, exactly once', () => {
    const { economy, state, crane } = setupCrane();
    const s = driveIn(state, crane, 'car');
    const before = economy.cashOf(1);
    const cmds: SimCommand[] = [];
    economy.processTick([], s, 1_000_000, craneMap, cmds);
    expect(cmds.some((c) => c.type === 'crushVehicle' && c.vehicleId === 40)).toBe(true);
    expect(economy.cashOf(1)).toBeGreaterThan(before);

    // The command is what removes it, at a tick boundary like everything else.
    const after = step(s, {}, cmds, craneMap);
    expect(after.vehicles.byId[40]).toBeUndefined();
    expect(after.players.byId[1]!.mode).toBe('foot'); // you walk out
  });

  it('driving through at speed is not delivering a car', () => {
    const { economy, state, crane } = setupCrane();
    const s = driveIn(state, crane, 'car');
    s.vehicles.byId[40]!.speed = 180;
    const cmds: SimCommand[] = [];
    economy.processTick([], s, 1_000_000, craneMap, cmds);
    expect(cmds.length).toBe(0);
  });

  it('bigger vehicles are worth more, and the export list is worth more again', () => {
    const pay = (kind: string, exported: boolean): number => {
      const { economy, state, crane } = setupCrane();
      const s = driveIn(state, crane, kind);
      let now = 1_000_000;
      for (let i = 0; i < 24 && economy.exports(now).includes(kind) !== exported; i++) {
        now += params.crush.refreshSec * 1000 + 1;
      }
      expect(economy.exports(now).includes(kind), `${kind} exported=${exported}`).toBe(exported);
      const before = economy.cashOf(1);
      economy.processTick([], s, now, craneMap, []);
      return economy.cashOf(1) - before;
    };
    expect(pay('bus', false)).toBeGreaterThan(pay('car', false));
    expect(pay('car', true)).toBe(pay('car', false) * params.crush.exportBonus);
  });

  it('the jaws sometimes pay in equipment, which is the point of them', () => {
    const { economy, state, crane } = setupCrane();
    let grants = 0;
    for (let i = 0; i < 12; i++) {
      const s = driveIn(state, crane, 'car');
      const cmds: SimCommand[] = [];
      economy.processTick([], s, 1_000_000 + i * 1000, craneMap, cmds);
      grants += cmds.filter((c) => c.type === 'grantWeapon').length;
    }
    expect(grants).toBeGreaterThan(0);
  });

  it('the export list rotates and covers more than one set over time', () => {
    const economy = new Economy(new MemoryStore(), catalog, params);
    const seen = new Set<string>();
    let now = 1_000_000;
    for (let i = 0; i < 12; i++) {
      for (const k of economy.exports(now)) seen.add(k);
      now += params.crush.refreshSec * 1000 + 1;
    }
    expect(seen.size).toBeGreaterThan(params.crush.listSize);
    // A police cruiser is never a legitimate export.
    expect(seen.has('copcar')).toBe(false);
  });
});
