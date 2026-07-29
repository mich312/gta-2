import type { PersistenceStore, TxRow } from './storeTypes.js';

/**
 * Append-only cash ledger. There is no mutable balance column anywhere:
 * balance is a fold over the account's transactions (cached incrementally).
 * Every entry carries a reason and a unique ref, so exploits are auditable
 * and retried writes can never double-apply.
 */
export class Ledger {
  private balances = new Map<string, number>();

  constructor(private readonly store: PersistenceStore) {}

  balance(accountKey: string): number {
    let cached = this.balances.get(accountKey);
    if (cached === undefined) {
      cached = this.store.transactionsFor(accountKey).reduce((sum, t) => sum + t.delta, 0);
      this.balances.set(accountKey, cached);
    }
    return cached;
  }

  /** Returns false (and writes nothing) if the debit would overdraw. */
  append(accountKey: string, delta: number, reason: string, ref: string): boolean {
    if (this.store.hasRef(ref)) return false; // idempotent retry
    const current = this.balance(accountKey);
    if (current + delta < 0) return false;
    const tx: TxRow = { ref, accountKey, delta, reason, at: new Date().toISOString() };
    this.store.appendTransaction(tx);
    this.balances.set(accountKey, current + delta);
    return true;
  }

  /** Drop the cache entry (e.g. after login switches the backing account). */
  forget(accountKey: string): void {
    this.balances.delete(accountKey);
  }
}
