import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import worldgenJson from '../../shared/data/worldgen.json';
import shopJson from '../../shared/data/shop.json';
import economyJson from '../../shared/data/economy.json';
import {
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
