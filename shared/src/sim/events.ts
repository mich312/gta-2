/**
 * Discrete facts the sim derives while stepping. Deterministic (same step,
 * same events) but NOT part of GameState — the server relays them to clients
 * for kill feeds/tracers, and the economy layer will consume kill events for
 * cash awards in phase 5. Replays don't need them: they re-derive.
 */
export type SimEvent =
  | { type: 'shot'; tick: number; playerId: number; x0: number; y0: number; x1: number; y1: number }
  | { type: 'kill'; tick: number; killerId: number; victimId: number; weaponId: string }
  | { type: 'death'; tick: number; playerId: number }
  | { type: 'copDown'; tick: number; killerId: number }
  | { type: 'pedDown'; tick: number; killerId: number }
  | { type: 'propDown'; tick: number; kind: string; x: number; y: number };
