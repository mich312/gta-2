/**
 * The persistence contract, with no implementation attached.
 *
 * Split out of `store.ts` so that the types can be imported by portable code
 * — the economy, the accounts, the in-memory store — without reaching a
 * module that imports `node:fs`. `store.ts` re-exports all of it, so nothing
 * that already imported from there had to change.
 */

export interface TxRow {
  /** Idempotency key: unique per transaction; duplicates must be rejected. */
  ref: string;
  accountKey: string;
  delta: number;
  reason: string;
  at: string;
}

export interface AccountRow {
  username: string;
  passHash: string;
  salt: string;
  createdAt: string;
  cosmeticsOwned: number[];
  equippedCosmetic: number;
}

export interface PersistenceStore {
  appendTransaction(tx: TxRow): void;
  transactionsFor(accountKey: string): TxRow[];
  hasRef(ref: string): boolean;
  getAccount(username: string): AccountRow | null;
  putAccount(row: AccountRow): void;
  flush(): void;
}
