import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, jsonFallbackPath } from '../src/economy/createStore.js';
import { FileStore } from '../src/economy/store.js';
import { SqliteStore, sqliteAvailable } from '../src/economy/sqliteStore.js';
import { Ledger } from '../src/economy/ledger.js';

/**
 * Backend selection, on whatever Node is running the suite. persistFallback
 * covers the no-node:sqlite runtime specifically; this file must pass in both
 * worlds, because the point of the change is that neither one throws.
 */
describe('createStore', () => {
  it('routes .json paths to the file store without touching node:sqlite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-json-'));
    const warn = vi.fn();
    const store = createStore(join(dir, 'persist.json'), warn);
    expect(store).toBeInstanceOf(FileStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it('opens a .db path with whichever backend this Node build can provide', () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-db-'));
    const warn = vi.fn();
    const store = createStore(join(dir, 'persist.db'), warn);

    if (sqliteAvailable()) {
      expect(store).toBeInstanceOf(SqliteStore);
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(store).toBeInstanceOf(FileStore);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('node:sqlite unavailable');
    }

    // Whichever it picked, the ledger contract holds.
    const ledger = new Ledger(store);
    expect(ledger.append('acct:dave', 50, 'start', 'start:acct:dave')).toBe(true);
    expect(ledger.balance('acct:dave')).toBe(50);
  });

  it('does not open a database beside a .json without saying so', () => {
    // The fallback's own direction warns; this is the way back. An operator
    // who ran the file store on a Node build without node:sqlite (README) and
    // later gains it would otherwise get a clean, empty database next to a
    // file full of accounts, with nothing said.
    const dir = mkdtempSync(join(tmpdir(), 'create-orphan-'));
    const json = join(dir, 'persist.json');
    // Written the way the fallback writes it, not by hand.
    const before = new FileStore(json);
    new Ledger(before).append('acct:dave', 50, 'start', 'start:acct:dave');
    before.flush();

    const warn = vi.fn();
    const store = createStore(join(dir, 'persist.db'), warn);
    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain(json);
    if (sqliteAvailable()) {
      // The accounts are in the file the warning names, and not in the store.
      expect(store).toBeInstanceOf(SqliteStore);
      expect(new Ledger(store).balance('acct:dave')).toBe(0);
      expect(new Ledger(new FileStore(json)).balance('acct:dave')).toBe(50);
    } else {
      // No sqlite: the existing fallback warning is the one that fires, and
      // the store it hands back is the file with the accounts in it.
      expect(store).toBeInstanceOf(FileStore);
      expect(msg).toContain('node:sqlite unavailable');
      expect(new Ledger(store).balance('acct:dave')).toBe(50);
    }
  });

  it('derives the fallback path by swapping the extension for .json', () => {
    expect(jsonFallbackPath('data/persist.db')).toBe('data/persist.json');
    expect(jsonFallbackPath('data/persist.sqlite3')).toBe('data/persist.json');
    expect(jsonFallbackPath('data/persist')).toBe('data/persist.json');
    // A dot in a parent directory is not the file's extension.
    expect(jsonFallbackPath('v1.0/persist')).toBe('v1.0/persist.json');
  });
});
