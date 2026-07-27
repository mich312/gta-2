import {
  type CityMap,
  type GameState,
  type SimCommand,
  type SimEvent,
  type Vec2,
} from 'shared';

/**
 * Service-vehicle work: the ambulance, the taxi, and the bounty on a
 * vigilante's cruiser.
 *
 * All of it lives outside the sim, like the economy and the mission runner:
 * a fare is a cashier decision, not physics. The sim only ever sees the
 * despawn and respawn of the person in the back seat.
 *
 * The ambulance is the one worth the effort. Pedestrians who go down instead
 * of dying (see `sim/peds.ts`) are casualties somebody has to collect, and
 * they are produced by ordinary play — which means in a shared city one
 * player's hit-and-run is another player's fare. Nothing else in this
 * project couples two players' play that cheaply.
 *
 * NOT built: ambulances that turn out on their own to casualties nobody has
 * claimed. That needs an AI driver with a destination, which the traffic
 * layer does not have a notion of yet.
 */

export interface JobsParams {
  /** Cash per 100 px of a fare's journey. */
  taxiPer100: number;
  /** Base payment for delivering a casualty alive. */
  ambulanceBase: number;
  /** Extra, scaled by how much of their bleed-out clock is left. */
  ambulanceUrgency: number;
  /** How close the ambulance has to be to pick somebody up. */
  pickupRadius: number;
  /** How close to a hospital door counts as delivered. */
  deliverRadius: number;
  /** Bounty for a kill made from a police cruiser. */
  vigilanteBounty: number;
}

export const DEFAULT_JOBS: JobsParams = {
  taxiPer100: 12,
  ambulanceBase: 260,
  ambulanceUrgency: 240,
  pickupRadius: 44,
  deliverRadius: 70,
  vigilanteBounty: 150,
};

interface Carrying {
  /** Ped id, so it can be put back down where it is delivered. */
  pedId: number;
  kind: 'fare' | 'casualty';
  from: Vec2;
  /** For a casualty: fraction of their bleed-out clock left at pickup. */
  urgency: number;
}

export interface JobsOutcome {
  commands: SimCommand[];
  /** playerId -> cash earned this tick. */
  pay: Map<number, number>;
  notices: Array<{ playerId: number; text: string }>;
}

export class Jobs {
  private readonly carrying = new Map<number, Carrying>();

  constructor(private readonly params: JobsParams = DEFAULT_JOBS) {}

  carryingWhat(playerId: number): 'fare' | 'casualty' | null {
    return this.carrying.get(playerId)?.kind ?? null;
  }

  forget(playerId: number): void {
    this.carrying.delete(playerId);
  }

  step(events: SimEvent[], state: GameState, map: CityMap, bleedOutTicks: number): JobsOutcome {
    const out: JobsOutcome = { commands: [], pay: new Map(), notices: [] };

    // Vigilante: a kill made from behind the wheel of a cruiser pays a
    // bounty. Nearly free — the events already exist.
    for (const ev of events) {
      if (ev.type !== 'kill' || ev.killerId < 0) continue;
      const killer = state.players.byId[ev.killerId];
      if (!killer || killer.mode !== 'driving' || killer.vehicleId === null) continue;
      if (state.vehicles.byId[killer.vehicleId]?.kind !== 'copcar') continue;
      add(out.pay, ev.killerId, this.params.vigilanteBounty);
    }

    for (const id of state.players.ids) {
      const p = state.players.byId[id];
      if (!p) continue;

      // Falling out of the vehicle loses whoever was in the back.
      if (p.mode !== 'driving' || p.vehicleId === null) {
        if (this.carrying.has(id)) {
          const held = this.carrying.get(id) as Carrying;
          this.carrying.delete(id);
          out.notices.push({
            playerId: id,
            text: held.kind === 'fare' ? 'your fare got out' : 'you left them in the road',
          });
        }
        continue;
      }
      const v = state.vehicles.byId[p.vehicleId];
      if (!v) continue;

      const held = this.carrying.get(id);
      if (held) {
        if (Math.abs(v.speed) > 40) continue; // you have to actually stop
        if (held.kind === 'casualty') {
          const door = nearest(map.hospitals, v.pos);
          if (door && within(door, v.pos, this.params.deliverRadius)) {
            this.carrying.delete(id);
            const pay = Math.round(
              this.params.ambulanceBase + this.params.ambulanceUrgency * held.urgency,
            );
            add(out.pay, id, pay);
            out.commands.push({ type: 'spawnPed', pedId: held.pedId, x: door.x, y: door.y });
            out.notices.push({ playerId: id, text: 'casualty delivered' });
          }
        } else {
          // A fare is paid for the distance travelled, not for time spent —
          // so circling the pickup earns nothing.
          const dist = Math.hypot(v.pos.x - held.from.x, v.pos.y - held.from.y);
          if (dist > 240) {
            this.carrying.delete(id);
            add(out.pay, id, Math.round((dist / 100) * this.params.taxiPer100));
            out.commands.push({
              type: 'spawnPed',
              pedId: held.pedId,
              x: v.pos.x,
              y: v.pos.y,
            });
            out.notices.push({ playerId: id, text: 'fare paid' });
          }
        }
        continue;
      }

      // Nothing aboard: look for somebody to pick up.
      if (v.kind === 'ambulance') {
        for (const pedId of state.peds.ids) {
          const ped = state.peds.byId[pedId];
          if (!ped || ped.mode !== 'downed') continue;
          if (!within(ped.pos, v.pos, this.params.pickupRadius)) continue;
          if (Math.abs(v.speed) > 60) continue;
          this.carrying.set(id, {
            pedId,
            kind: 'casualty',
            from: { x: v.pos.x, y: v.pos.y },
            urgency: bleedOutTicks > 0 ? Math.min(1, ped.timer / bleedOutTicks) : 0,
          });
          // Removed from the table while aboard: cheaper on the wire than a
          // ridingVehicleId field, and simpler than drawing a passenger.
          out.commands.push({ type: 'despawnPed', pedId });
          out.notices.push({ playerId: id, text: 'casualty aboard — get to a hospital' });
          break;
        }
      } else if (v.kind === 'taxi') {
        for (const pedId of state.peds.ids) {
          const ped = state.peds.byId[pedId];
          // Anybody civilian and upright will take a cab. NOT `mode ===
          // 'walk'`: a pedestrian standing next to a car is already in
          // `flee`, so that test never matched a single fare.
          if (!ped || ped.mode === 'downed' || ped.mode === 'hostile') continue;
          if (ped.gangId !== 0) continue;
          if (!within(ped.pos, v.pos, this.params.pickupRadius)) continue;
          if (Math.abs(v.speed) > 30) continue;
          this.carrying.set(id, {
            pedId,
            kind: 'fare',
            from: { x: v.pos.x, y: v.pos.y },
            urgency: 0,
          });
          out.commands.push({ type: 'despawnPed', pedId });
          out.notices.push({ playerId: id, text: 'fare aboard' });
          break;
        }
      }
    }
    return out;
  }
}

function add(map: Map<number, number>, key: number, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function within(a: Vec2, b: Vec2, r: number): boolean {
  return Math.abs(a.x - b.x) <= r && Math.abs(a.y - b.y) <= r;
}

function nearest(list: readonly Vec2[], from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const p of list) {
    const d = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
