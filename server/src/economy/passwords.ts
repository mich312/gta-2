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
  /**
   * Derive a hash for `password` under `salt`, hex.
   *
   * **Asynchronous, and that is the point.** A password hash is expensive by
   * design — scrypt is 50 ms and 64 MB on the box this was measured on — and
   * the game server runs its 30 Hz tick on the same event loop that reads
   * sockets. Done synchronously, one `register` message cost more than a tick
   * and a half, so a client that sent them in a loop stopped the world: 53k
   * messages in five seconds took the tick rate from 30 to 1, and it was still
   * 0 fifteen seconds after that client hung up, because the work was already
   * queued. Asynchronous, the derivation runs on the platform's own worker
   * pool and the loop stays free for the game. The rate limits in `GameHost`
   * bound how much of that pool one client may ask for.
   */
  hash(password: string, salt: string): Promise<string>;
  /** Constant-time compare of two hex digests. */
  matches(expectedHex: string, actualHex: string): boolean;
}
