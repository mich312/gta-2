/**
 * Discrete facts the sim derives while stepping. Deterministic (same step,
 * same events) but NOT part of GameState — the server relays them to clients
 * for kill feeds/tracers, and the economy layer will consume kill events for
 * cash awards in phase 5. Replays don't need them: they re-derive.
 */
export type SimEvent =
  | {
      type: 'shot';
      tick: number;
      playerId: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      /**
       * How far this shot carries as a noise. On the event rather than looked
       * up per listener: the crowd and the police both react to it, and
       * neither should have to know which weapon fired.
       */
      noise: number;
    }
  | { type: 'kill'; tick: number; killerId: number; victimId: number; weaponId: string }
  | { type: 'death'; tick: number; playerId: number }
  | {
      /** A gang crossed into (or out of) shooting at you on sight. */
      type: 'gangTurned';
      tick: number;
      playerId: number;
      gangId: number;
      hostile: boolean;
    }
  | {
      /** An arrest was walked away from. The card is gone; so is the heat. */
      type: 'jailCardUsed';
      tick: number;
      playerId: number;
    }
  | {
      /** Arrested rather than killed. Always accompanied by a `death` (the
       *  respawn pipeline is the same); the difference is where you wake up
       *  and what it costs — see FEATURES.md F2. */
      type: 'busted';
      tick: number;
      playerId: number;
      copId: number;
    }
  | { type: 'copDown'; tick: number; killerId: number }
  | { type: 'pedDown'; tick: number; killerId: number }
  | {
      /** A vehicle struck somebody on foot. Non-fatal hits have no other
       *  outward sign — a kill emits `kill` as well. */
      type: 'runOver';
      tick: number;
      x: number;
      y: number;
      /** Heading of the car, so the client throws the blood the right way. */
      angle: number;
      /** Closing speed, for scaling the noise and the spray. */
      speed: number;
    }
  | {
      /**
       * Somebody leaning on the horn. Carries the vehicle kind so a bus and a
       * hatchback do not sound alike, and the player id when a person did it,
       * so the client that pressed the key does not play its own horn twice —
       * the same guard the tracer path uses.
       */
      type: 'horn';
      tick: number;
      x: number;
      y: number;
      kind: string;
      playerId: number | null;
    }
  | {
      /** Two gangs shooting at each other, for the feed. */
      type: 'gangFight';
      tick: number;
      gangId: number;
      rivalId: number;
      x: number;
      y: number;
    }
  | { type: 'propDown'; tick: number; kind: string; x: number; y: number }
  | { type: 'propUp'; tick: number; kind: string; x: number; y: number }
  | {
      type: 'pickupTaken';
      tick: number;
      kind: string;
      playerId: number;
      x: number;
      y: number;
    }
  | { type: 'pickupUp'; tick: number; kind: string; id: number }
  | { type: 'vehicleBurning'; tick: number; vehicleId: number; x: number; y: number }
  | {
      /** Metal met something. Without this a crash was the one physical
       *  interaction in the game that made no sound at all. */
      type: 'vehicleCollided';
      tick: number;
      vehicleId: number;
      x: number;
      y: number;
      /** Closing speed, for scaling the noise. */
      speed: number;
    }
  | {
      /** A lamp, a panel or a tyre went. Breakage re-derives from the damage
       *  map on every host, so this exists only so the client can put the
       *  glass on the frame it happened rather than the next redraw. */
      type: 'vehiclePartBroke';
      tick: number;
      vehicleId: number;
      /** One of the PART_* bits in sim/vehicleDamage.ts. */
      part: number;
      x: number;
      y: number;
    }
  | { type: 'explosion'; tick: number; x: number; y: number; radius: number }
  | {
      type: 'frenzyEnded';
      tick: number;
      playerId: number;
      kills: number;
      target: number;
      completed: boolean;
    }
  | { type: 'stuntLaunched'; tick: number; playerId: number; x: number; y: number }
  | {
      type: 'stuntLanded';
      tick: number;
      playerId: number;
      distance: number;
      x: number;
      y: number;
    };
