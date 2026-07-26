import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AccountRow, PersistenceStore } from './store.js';

/**
 * Optional accounts (guests always play). Username + password, scrypt from
 * node:crypto — no new dependency. A bare username is NOT identity: without
 * the password anyone could claim another player's cash.
 */
export class Accounts {
  constructor(private readonly store: PersistenceStore) {}

  register(username: string, password: string): { ok: boolean; message: string } {
    if (this.store.getAccount(username)) {
      return { ok: false, message: 'username taken' };
    }
    const salt = randomBytes(16).toString('hex');
    const passHash = scryptSync(password, salt, 32).toString('hex');
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
    const row = this.store.getAccount(username);
    if (!row) return null;
    const expected = Buffer.from(row.passHash, 'hex');
    const actual = scryptSync(password, row.salt, 32);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
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
