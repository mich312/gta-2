/**
 * The proving ground: a room you walk into and leave with whatever you need
 * to test something.
 *
 * Deliberately NOT part of the economy. It has no prices, no ledger entry, no
 * standings gate and no district — it is a debug facility, and threading
 * "except when it's free" through the shop path would put a hole in the one
 * system in the game that is about scarcity. The client reuses the shop HUD
 * because that is free; nothing else is shared.
 *
 * It only exists when the session was started with the proving ground turned
 * on (`WorldgenParams.provingGround`, from `PROVING_GROUND=1`). The parameter
 * rides in the welcome message like every other worldgen setting, so both
 * hosts build the same city and there is no way for a client to conjure the
 * room on a server that did not ask for it.
 */

/** What one row of the counter hands over. */
export type DepotGrant =
  | { kind: 'vehicle'; vehicle: string; count: number }
  /** Every weapon in the game, loaded. */
  | { kind: 'arsenal' }
  /** Health and armour back to full. */
  | { kind: 'patch' }
  | { kind: 'cash'; amount: number };

export interface DepotRow {
  /** Shown on the counter, and what the client sends back. */
  id: string;
  grant: DepotGrant;
}

/**
 * The counter, in the order it is displayed and keyed (Y U I O H J N P).
 *
 * Eight rows because there are eight buy keys, so the list is chosen rather
 * than accumulated. The four vehicle rows are the four cases the crush rule
 * has: something it flattens, a row of them to drive down, and the two sizes
 * that stop it.
 */
export const DEPOT_ROWS: readonly DepotRow[] = [
  { id: 'tank', grant: { kind: 'vehicle', vehicle: 'tank', count: 1 } },
  { id: 'car', grant: { kind: 'vehicle', vehicle: 'car', count: 1 } },
  { id: 'six cars in a row', grant: { kind: 'vehicle', vehicle: 'car', count: 6 } },
  { id: 'bus', grant: { kind: 'vehicle', vehicle: 'bus', count: 1 } },
  { id: 'truck', grant: { kind: 'vehicle', vehicle: 'truck', count: 1 } },
  { id: 'every weapon', grant: { kind: 'arsenal' } },
  { id: 'patch up', grant: { kind: 'patch' } },
  { id: 'cash', grant: { kind: 'cash', amount: 10_000 } },
];

/** Look a row up by the id the client sent. Null for anything else. */
export function depotRow(id: string): DepotRow | null {
  return DEPOT_ROWS.find((r) => r.id === id) ?? null;
}
