import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountRow, PersistenceStore, TxRow } from './store.js';

/**
 * SQLite persistence via node:sqlite (built into Node 22+, no dependency).
 * Same append-only discipline as the interface demands: transactions are
 * INSERT-only with a UNIQUE ref (the idempotency key), balance is always
 * SUM(delta), and nothing ever UPDATEs or DELETEs a transaction row.
 */
export class SqliteStore implements PersistenceStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        username_lower    TEXT PRIMARY KEY,
        username          TEXT NOT NULL,
        pass_hash         TEXT NOT NULL,
        salt              TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        equipped_cosmetic INTEGER NOT NULL DEFAULT 0
      );
      -- Append-only: no UPDATE or DELETE is ever issued against this table.
      CREATE TABLE IF NOT EXISTS transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ref         TEXT NOT NULL UNIQUE,
        account_key TEXT NOT NULL,
        delta       INTEGER NOT NULL,
        reason      TEXT NOT NULL,
        at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_key, id);
      CREATE TABLE IF NOT EXISTS cosmetics_owned (
        username_lower TEXT NOT NULL,
        cosmetic_id    INTEGER NOT NULL,
        acquired_at    TEXT NOT NULL,
        PRIMARY KEY (username_lower, cosmetic_id)
      );
    `);
  }

  appendTransaction(tx: TxRow): void {
    // UNIQUE(ref) turns a duplicate into a throw — same contract as MemoryStore.
    this.db
      .prepare('INSERT INTO transactions (ref, account_key, delta, reason, at) VALUES (?, ?, ?, ?, ?)')
      .run(tx.ref, tx.accountKey, tx.delta, tx.reason, tx.at);
  }

  transactionsFor(accountKey: string): TxRow[] {
    const rows = this.db
      .prepare('SELECT ref, account_key, delta, reason, at FROM transactions WHERE account_key = ? ORDER BY id')
      .all(accountKey) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ref: r['ref'] as string,
      accountKey: r['account_key'] as string,
      delta: Number(r['delta']),
      reason: r['reason'] as string,
      at: r['at'] as string,
    }));
  }

  hasRef(ref: string): boolean {
    return this.db.prepare('SELECT 1 FROM transactions WHERE ref = ?').get(ref) !== undefined;
  }

  getAccount(username: string): AccountRow | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE username_lower = ?')
      .get(username.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) return null;
    const cosmetics = this.db
      .prepare('SELECT cosmetic_id FROM cosmetics_owned WHERE username_lower = ? ORDER BY cosmetic_id')
      .all(username.toLowerCase()) as Array<Record<string, unknown>>;
    return {
      username: row['username'] as string,
      passHash: row['pass_hash'] as string,
      salt: row['salt'] as string,
      createdAt: row['created_at'] as string,
      equippedCosmetic: Number(row['equipped_cosmetic']),
      cosmeticsOwned: cosmetics.map((c) => Number(c['cosmetic_id'])),
    };
  }

  putAccount(row: AccountRow): void {
    const lower = row.username.toLowerCase();
    this.db
      .prepare(
        `INSERT INTO accounts (username_lower, username, pass_hash, salt, created_at, equipped_cosmetic)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(username_lower) DO UPDATE SET equipped_cosmetic = excluded.equipped_cosmetic`,
      )
      .run(lower, row.username, row.passHash, row.salt, row.createdAt, row.equippedCosmetic);
    const insertCosmetic = this.db.prepare(
      'INSERT OR IGNORE INTO cosmetics_owned (username_lower, cosmetic_id, acquired_at) VALUES (?, ?, ?)',
    );
    for (const id of row.cosmeticsOwned) {
      insertCosmetic.run(lower, id, new Date().toISOString());
    }
  }

  flush(): void {} // every write above is already durable

  close(): void {
    this.db.close();
  }
}
