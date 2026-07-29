import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { PasswordCrypto } from '../economy/passwords.js';

/**
 * The scrypt implementation that has always been in `accounts.ts`, moved
 * behind the `PasswordCrypto` interface and into the Node-only corner of the
 * server. Same parameters, same output — an account registered before this
 * refactor still verifies.
 */
export const nodePasswords: PasswordCrypto = {
  newSalt(): string {
    return randomBytes(16).toString('hex');
  },
  hash(password: string, salt: string): string {
    return scryptSync(password, salt, 32).toString('hex');
  },
  matches(expectedHex: string, actualHex: string): boolean {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  },
};
