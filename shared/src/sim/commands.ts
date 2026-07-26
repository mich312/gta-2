/**
 * Sim commands: the ONLY write-path into the deterministic sim from the
 * outside world (connection lifecycle now; economy grants from phase 5).
 * Commands are tick-stamped by the session, applied at tick boundaries like
 * inputs, and recorded in replay files — so replays reproduce exactly even
 * though the code emitting commands (joins, purchases) is not deterministic.
 */
export type SimCommand =
  | { type: 'spawnPlayer'; playerId: number; name: string }
  | { type: 'despawnPlayer'; playerId: number };
