import { existsSync } from 'node:fs';
import type { PersistenceStore } from './storeTypes.js';
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
 *
 * The other direction is quiet in the same way and is not hypothetical: an
 * operator following README.md's note runs the file store on a build without
 * node:sqlite, then upgrades Node or drops --without-sqlite, and this function
 * silently opens an empty database beside a .json full of accounts. Same
 * mistake, same warning — name the sibling and say it is not being read.
 */
export function createStore(
  path: string,
  warn: (msg: string) => void = console.warn,
): PersistenceStore {
  if (path.endsWith('.json')) return new FileStore(path);
  if (sqliteAvailable()) {
    const orphan = jsonFallbackPath(path);
    if (orphan !== path && existsSync(orphan)) {
      warn(
        `[persistence] using SQLite at ${path}, but ${orphan} also exists — the JSON file store ` +
          'writes there when node:sqlite is missing, and nothing saved in it is read by this ' +
          `store. To keep using it, set PERSIST_PATH=${orphan}; otherwise move it aside.`,
      );
    }
    return new SqliteStore(path);
  }

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
