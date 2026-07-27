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

  it('derives the fallback path by swapping the extension for .json', () => {
    expect(jsonFallbackPath('data/persist.db')).toBe('data/persist.json');
    expect(jsonFallbackPath('data/persist.sqlite3')).toBe('data/persist.json');
    expect(jsonFallbackPath('data/persist')).toBe('data/persist.json');
    // A dot in a parent directory is not the file's extension.
    expect(jsonFallbackPath('v1.0/persist')).toBe('v1.0/persist.json');
  });
});
