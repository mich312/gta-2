import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistence boundary. The rest of the server talks only to this interface;
 * swapping the file store for MySQL (schema in server/mysql/schema.sql)
 * means writing one new implementation. Everything is synchronous and tiny
 * at 4-8 players; the MySQL impl will make these async behind a write queue.
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
