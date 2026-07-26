import type { PersistenceStore } from './store.js';
import { FileStore } from './store.js';
import { SqliteStore } from './sqliteStore.js';

/**
 * Store selection by path: SQLite (node:sqlite, zero dependencies) is the
 * default; a .json path opts into the simple FileStore. Both implement the
 * same interface — the economy code cannot tell them apart.
 */
export function createStore(path: string): PersistenceStore {
  return path.endsWith('.json') ? new FileStore(path) : new SqliteStore(path);
}
