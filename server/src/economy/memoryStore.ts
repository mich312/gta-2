import type { AccountRow, PersistenceStore, TxRow } from './storeTypes.js';

/**
 * The in-memory persistence store, and the base class every other store
 * extends.
 *
 * It lives in its own file — apart from `FileStore`, which needs `node:fs`,
 * and `SqliteStore`, which needs `node:sqlite` — so that a host without a
 * filesystem can have persistence at all. Importing `store.js` to reach
 * `MemoryStore` would pull `node:fs` into a browser bundle for a class that
 * never touches it. See SHIP.md §3.
 */
export class MemoryStore implements PersistenceStore {
  protected txs: TxRow[] = [];
  protected refs = new Set<string>();
  protected accounts = new Map<string, AccountRow>();

  appendTransaction(tx: TxRow): void {
    if (this.refs.has(tx.ref)) throw new Error(`duplicate transaction ref ${tx.ref}`);
    this.refs.add(tx.ref);
    this.txs.push({ ...tx });
    this.flush();
  }

  transactionsFor(accountKey: string): TxRow[] {
    return this.txs.filter((t) => t.accountKey === accountKey).map((t) => ({ ...t }));
  }

  hasRef(ref: string): boolean {
    return this.refs.has(ref);
  }

  getAccount(username: string): AccountRow | null {
    const row = this.accounts.get(username.toLowerCase());
    return row ? { ...row, cosmeticsOwned: [...row.cosmeticsOwned] } : null;
  }

  putAccount(row: AccountRow): void {
    this.accounts.set(row.username.toLowerCase(), {
      ...row,
      cosmeticsOwned: [...row.cosmeticsOwned],
    });
    this.flush();
  }

  flush(): void {}
}
