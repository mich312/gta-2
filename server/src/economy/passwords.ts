/**
 * Password hashing, behind an interface.
 *
 * `Accounts` used scrypt from `node:crypto` directly, which put the whole
 * economy out of reach of any host without Node. The scrypt is unchanged and
 * still the only implementation the server uses — it just arrives as an
 * argument now.
 *
 * The other reason this is an interface: offline single-player has no
 * accounts. There is nobody to authenticate against and nothing to protect,
 * so the local host passes `null` and `register`/`verify` decline. That is
 * the design (SHIP.md T1), not a gap — a password prompt on a game with one
 * player and a local save file is theatre.
 */
export interface PasswordCrypto {
  /** Fresh random salt, hex. */
  newSalt(): string;
  /** Derive a hash for `password` under `salt`, hex. */
  hash(password: string, salt: string): string;
  /** Constant-time compare of two hex digests. */
  matches(expectedHex: string, actualHex: string): boolean;
}
