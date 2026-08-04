import type { AccountRow, PersistenceStore } from './storeTypes.js';
import type { PasswordCrypto } from './passwords.js';

/** What register/verify say when the host has no password implementation. */
const OFFLINE = 'accounts are online-only';

/**
 * Salt used when the account does not exist, so `verify` does the same work
 * either way. Any fixed hex string does — it is never stored and never
 * compared against, it only has to make the derivation happen.
 */
const DUMMY_SALT = '00000000000000000000000000000000';

/**
 * Optional accounts (guests always play). Username + password: a bare
 * username is NOT identity — without the password anyone could claim another
 * player's cash.
 *
 * The hashing arrives as a constructor argument rather than an import, so
 * this class is portable. The server passes `nodePasswords` — scrypt, the
 * same parameters as before, so accounts registered against older builds
 * still verify. A local single-player host passes nothing and both verbs
 * decline: offline there is one player, no server to be authenticated by,
 * and a local save file to keep the money in.
 */
export class Accounts {
  constructor(
    private readonly store: PersistenceStore,
    private readonly crypto: PasswordCrypto | null = null,
  ) {}

  async register(username: string, password: string): Promise<{ ok: boolean; message: string }> {
    if (!this.crypto) return { ok: false, message: OFFLINE };
    if (this.store.getAccount(username)) {
      return { ok: false, message: 'username taken' };
    }
    const salt = this.crypto.newSalt();
    const passHash = await this.crypto.hash(password, salt);
    // Checked again on the far side of the hash: two registrations for the
    // same name can now be in flight at once, and without this the second one
    // overwrites the first's row — including its password.
    if (this.store.getAccount(username)) {
      return { ok: false, message: 'username taken' };
    }
    const row: AccountRow = {
      username,
      passHash,
      salt,
      createdAt: new Date().toISOString(),
      cosmeticsOwned: [],
      equippedCosmetic: 0,
    };
    this.store.putAccount(row);
    return { ok: true, message: 'account created' };
  }

  /**
   * Check a password, taking the same time whether the account exists or not.
   *
   * The early `return null` for an unknown username was a username oracle:
   * a name nobody had registered answered in microseconds, a name somebody
   * had answered in fifty milliseconds, so anyone could enumerate the
   * player list by timing. Hashing against a fixed dummy salt costs one
   * derivation on the worker pool and removes the difference. What stops
   * that being a way to spend the pool is the auth rate limit in `GameHost`,
   * which does not care whether the account exists either.
   */
  async verify(username: string, password: string): Promise<AccountRow | null> {
    if (!this.crypto) return null;
    const row = this.store.getAccount(username);
    const salt = row ? row.salt : DUMMY_SALT;
    const attempt = await this.crypto.hash(password, salt);
    if (!row) return null;
    if (!this.crypto.matches(row.passHash, attempt)) return null;
    return row;
  }

  /** Read-only lookup (no auth) — for equipped-cosmetic display etc. */
  get(username: string): AccountRow | null {
    return this.store.getAccount(username);
  }

  addCosmetic(username: string, cosmeticId: number): void {
    const row = this.store.getAccount(username);
    if (!row) return;
    if (!row.cosmeticsOwned.includes(cosmeticId)) row.cosmeticsOwned.push(cosmeticId);
    row.equippedCosmetic = cosmeticId;
    this.store.putAccount(row);
  }
}
