import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodePasswords } from '../src/platform/nodePasswords.js';

/**
 * The failure this pins down: `Unknown builtin module: node:sqlite`. node:sqlite
 * is missing before Node 22.5, flagged on 22.5-22.12, and compiled out of some
 * distro builds. This file forces that world on a Node that *does* have it, so
 * the fallback path is exercised on every machine, not only broken ones.
 */
vi.mock('../src/economy/sqliteStore.js', () => ({
  sqliteAvailable: () => false,
  sqliteUnavailableReason: () => 'Unknown builtin module: node:sqlite',
  SqliteStore: class {
    constructor() {
      throw new Error('node:sqlite is not available in this Node build');
    }
  },
}));

const { createStore } = await import('../src/economy/createStore.js');
const { FileStore } = await import('../src/economy/store.js');
const { Accounts } = await import('../src/economy/accounts.js');
const { Ledger } = await import('../src/economy/ledger.js');

describe('persistence without node:sqlite', () => {
  it('boots on the sibling .json file instead of throwing, and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-sqlite-'));
    const warn = vi.fn();

    const store = createStore(join(dir, 'persist.db'), warn);
    expect(store).toBeInstanceOf(FileStore);
    expect(existsSync(join(dir, 'persist.db'))).toBe(false);

    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('node:sqlite unavailable');
    expect(message).toContain(join(dir, 'persist.json'));

    // Same guarantees as the SQLite store: durable, idempotent, append-only.
    const accounts = new Accounts(store, nodePasswords);
    const ledger = new Ledger(store);
    accounts.register('erin', 'secret-pw');
    ledger.append('acct:erin', 400, 'starting-cash', 'start:acct:erin');
    expect(ledger.append('acct:erin', 400, 'starting-cash', 'start:acct:erin')).toBe(false);

    const reopened = createStore(join(dir, 'persist.db'), warn);
    expect(new Ledger(reopened).balance('acct:erin')).toBe(400);
    expect(reopened.getAccount('erin')?.username).toBe('erin');
  });
});
