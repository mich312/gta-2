import type { PersistenceStore } from './store.js';
import { FileStore } from './store.js';
import { SqliteStore, sqliteAvailable, sqliteUnavailableReason } from './sqliteStore.js';

/** `data/persist.db` -> `data/persist.json`; a path with no extension gains one. */
export function jsonFallbackPath(path: string): string {
  return path.replace(/(\.[^./\\]*)?$/, '.json');
}

/**
 * Store selection by path: SQLite (node:sqlite, zero dependencies) is the
 * default; a .json path opts into the simple FileStore. Both implement the
 * same interface — the economy code cannot tell them apart.
 *
 * node:sqlite is not present in every Node build (see sqliteStore.ts), and a
 * missing database module is no reason to refuse to boot a game server, so an
 * unavailable module degrades to the JSON store at the sibling .json path.
 * That changes which file holds the save data, so it warns rather than failing
 * over quietly.
 */
export function createStore(
  path: string,
  warn: (msg: string) => void = console.warn,
): PersistenceStore {
  if (path.endsWith('.json')) return new FileStore(path);
  if (sqliteAvailable()) return new SqliteStore(path);

  const fallback = jsonFallbackPath(path);
  warn(
    `[persistence] node:sqlite unavailable on ${process.version} (${sqliteUnavailableReason()}); ` +
      `falling back to the JSON file store at ${fallback}. Anything already saved in ${path} is ` +
      'NOT read by this store. For SQLite, run Node 22.13+ (or 22.5-22.12 with ' +
      '--experimental-sqlite) from a build compiled with SQLite support; to make the file store ' +
      `the intended setup and silence this, set PERSIST_PATH=${fallback}.`,
  );
  return new FileStore(fallback);
}
