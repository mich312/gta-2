import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordCrypto } from '../economy/passwords.js';

/**
 * The scrypt implementation that has always been in `accounts.ts`, moved
 * behind the `PasswordCrypto` interface and into the Node-only corner of the
 * server. Same parameters, same output — an account registered before this
 * refactor still verifies.
 *
 * `scrypt` rather than `scryptSync`: same derivation, same cost, but it runs
 * on libuv's thread pool instead of on the event loop the game ticks on. See
 * the note on `PasswordCrypto.hash` for what the synchronous version cost.
 */
export const nodePasswords: PasswordCrypto = {
  newSalt(): string {
    return randomBytes(16).toString('hex');
  },
  hash(password: string, salt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, 32, (err, key) => {
        if (err) reject(err);
        else resolve(key.toString('hex'));
      });
    });
  },
  matches(expectedHex: string, actualHex: string): boolean {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  },
};
