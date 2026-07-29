import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore } from './memoryStore.js';
import type { AccountRow, TxRow } from './storeTypes.js';

/**
 * Persistence boundary. The rest of the server talks only to this interface;
 * swapping the file store for MySQL (schema in server/mysql/schema.sql)
 * means writing one new implementation. Everything is synchronous and tiny
 * at 4-8 players; the MySQL impl will make these async behind a write queue.
 *
 * This module is the *filesystem* half. The contract lives in
 * `storeTypes.ts` and the in-memory implementation in `memoryStore.ts`,
 * neither of which imports Node, so a host without a filesystem can still
 * have a store. Both are re-exported here: importing `PersistenceStore` or
 * `MemoryStore` from this module works exactly as it always did.
 */

export type { AccountRow, PersistenceStore, TxRow } from './storeTypes.js';
export { MemoryStore } from './memoryStore.js';

interface FileShape {
  version: 1;
  txs: TxRow[];
  accounts: AccountRow[];
}

/**
 * JSON-file store: the verified persistence path in this environment (no
 * MySQL server available here). Append-only semantics preserved; writes are
 * atomic (tmp + rename) so a crash can't corrupt the file.
 */
export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as FileShape;
      this.txs = raw.txs ?? [];
      for (const t of this.txs) this.refs.add(t.ref);
      for (const a of raw.accounts ?? []) this.accounts.set(a.username.toLowerCase(), a);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  override flush(): void {
    const data: FileShape = {
      version: 1,
      txs: this.txs,
      accounts: [...this.accounts.values()],
    };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }
}
