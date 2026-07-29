import type { AccountRow, PersistenceStore } from './storeTypes.js';
import type { PasswordCrypto } from './passwords.js';

/** What register/verify say when the host has no password implementation. */
const OFFLINE = 'accounts are online-only';

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

  register(username: string, password: string): { ok: boolean; message: string } {
    if (!this.crypto) return { ok: false, message: OFFLINE };
    if (this.store.getAccount(username)) {
      return { ok: false, message: 'username taken' };
    }
    const salt = this.crypto.newSalt();
    const passHash = this.crypto.hash(password, salt);
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

  verify(username: string, password: string): AccountRow | null {
    if (!this.crypto) return null;
    const row = this.store.getAccount(username);
    if (!row) return null;
    if (!this.crypto.matches(row.passHash, this.crypto.hash(password, row.salt))) return null;
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
