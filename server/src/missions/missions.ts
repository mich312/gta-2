import {
  type CityMap,
  type GameState,
  type SimCommand,
  type SimEvent,
  type Vec2,
  TICK_RATE,
  creditGangFavour,
  gangAt,
  gangName,
  getTuning,
  respectOf,
} from 'shared';

/**
 * Payphone missions.
 *
 * Lives SERVER-SIDE, outside the deterministic sim, for the same reason the
 * economy does: an objective is arbitration, not physics. Nothing here may
 * enter `step()` or the hash. The runner reads sim state and events, writes
 * through SimCommands, and pushes a per-player `mission` message.
 *
 * Both originals were single-player, so a mission could assume the world was
 * yours. Here two players can hold jobs pointed at the same target, so every
 * mission is a per-player instance and the first to finish wins — the other
 * is failed with a notice saying why. It is honest, it is cheap, and it
 * turns a conflict into a race.
 */

export type MissionKind = 'hit' | 'sweep' | 'delivery';
export type MissionTier = 'green' | 'yellow' | 'red';

export interface MissionSpec {
  kind: MissionKind;
  tier: MissionTier;
  /** Respect with the employer needed before they will offer it. */
  needs: number;
  /** How long you get, in seconds. */
  seconds: number;
  /** Bodies, or vehicles, depending on the verb. */
  count: number;
  pay: number;
}

export interface ActiveMission {
  id: number;
  playerId: number;
  spec: MissionSpec;
  employer: number;
  /** Sim tick the clock runs out on. */
  deadlineTick: number;
  progress: number;
  /** Where to go, for the HUD marker. Null when the objective is "anywhere". */
  marker: Vec2 | null;
  /** For a delivery: the vehicle kind wanted, and where it goes. */
  wantKind?: string;
}

export interface MissionView {
  active: boolean;
  text: string;
  tier: MissionTier;
  employer: string;
  progress: number;
  target: number;
  secondsLeft: number;
  marker: Vec2 | null;
}

/** The offer board. Two green, three yellow, two red, as the original did. */
const SPECS: MissionSpec[] = [
  { kind: 'hit', tier: 'green', needs: -10, seconds: 90, count: 2, pay: 400 },
  { kind: 'sweep', tier: 'green', needs: -10, seconds: 120, count: 3, pay: 500 },
  { kind: 'delivery', tier: 'yellow', needs: 10, seconds: 150, count: 1, pay: 900 },
  { kind: 'hit', tier: 'yellow', needs: 10, seconds: 100, count: 4, pay: 1000 },
  { kind: 'sweep', tier: 'yellow', needs: 10, seconds: 120, count: 6, pay: 1100 },
  { kind: 'delivery', tier: 'red', needs: 35, seconds: 120, count: 1, pay: 2200 },
  { kind: 'hit', tier: 'red', needs: 35, seconds: 110, count: 7, pay: 2600 },
];

const WANTED_KINDS = ['bus', 'firetruck', 'ambulance', 'truck', 'taxi'];

export interface MissionOutcome {
  commands: SimCommand[];
  /** Players whose mission state changed, so the server re-sends their view. */
  changed: Set<number>;
  /** Human-readable lines to push as notices, per player. */
  notices: Array<{ playerId: number; text: string }>;
  /** Completed missions, for the economy to pay out. */
  completed: Array<{ playerId: number; employer: number; pay: number }>;
}

export class Missions {
  private readonly active = new Map<number, ActiveMission>();
  private nextId = 1;
  /** Rotates which spec a given phone offers, so a phone is not one job forever. */
  private offerCursor = 0;

  /** How close you have to be to answer. */
  private readonly reach = 40;

  activeFor(playerId: number): ActiveMission | undefined {
    return this.active.get(playerId);
  }

  view(playerId: number, tick: number): MissionView {
    const m = this.active.get(playerId);
    if (!m) {
      return {
        active: false,
        text: '',
        tier: 'green',
        employer: '',
        progress: 0,
        target: 0,
        secondsLeft: 0,
        marker: null,
      };
    }
    return {
      active: true,
      text: describe(m),
      tier: m.spec.tier,
      employer: gangName(m.employer),
      progress: m.progress,
      target: m.spec.count,
      secondsLeft: Math.max(0, Math.ceil((m.deadlineTick - tick) / TICK_RATE)),
      marker: m.marker,
    };
  }

  /**
   * Answer the nearest ringing phone. Returns why not, or null on success.
   * The employer is whoever holds the ground the phone stands on — the city
   * is carved up, so a phone belongs to somebody.
   */
  take(playerId: number, state: GameState, map: CityMap): string | null {
    if (this.active.has(playerId)) return 'you already have a job on';
    const p = state.players.byId[playerId];
    if (!p) return 'no such player';
    if (p.mode !== 'foot') return 'get out of the car to answer it';
    const phone = map.payphones.find(
      (q) => Math.abs(q.x - p.pos.x) < this.reach && Math.abs(q.y - p.pos.y) < this.reach,
    );
    if (!phone) return 'find a payphone';

    const employer = gangAt(map, phone.x, phone.y);
    if (employer === 0) return 'nobody works this corner';
    const standing = respectOf(p, employer);
    if (standing <= getTuning().respect.hostileAt) {
      return `${gangName(employer)} would not give you the time of day`;
    }

    // Walk the board from a rotating start so the same phone does not offer
    // the same job forever, and take the first one they trust you with.
    const offers = SPECS.filter((s) => standing >= s.needs);
    if (offers.length === 0) return `${gangName(employer)} has nothing for you yet`;
    const spec = offers[this.offerCursor % offers.length] as MissionSpec;
    this.offerCursor++;

    const mission: ActiveMission = {
      id: this.nextId++,
      playerId,
      spec,
      employer,
      deadlineTick: state.tick + Math.round(spec.seconds * TICK_RATE),
      progress: 0,
      marker: null,
    };
    if (spec.kind === 'delivery') {
      mission.wantKind = WANTED_KINDS[mission.id % WANTED_KINDS.length] as string;
      mission.marker = nearestCrane(map, p.pos);
    } else if (spec.kind === 'sweep') {
      // A sweep sends you onto somebody else's ground: the employer's rival.
      const rival = getTuning().gangs.gangs.find((g) => g.id === employer)?.rivals[0] ?? 0;
      mission.marker = homeOf(map, rival);
    }
    this.active.set(playerId, mission);
    return null;
  }

  abandon(playerId: number): void {
    this.active.delete(playerId);
  }

  /**
   * Advance every running mission. Called once per tick, after the sim has
   * stepped, with that tick's events.
   */
  step(events: SimEvent[], state: GameState, map: CityMap): MissionOutcome {
    const out: MissionOutcome = {
      commands: [],
      changed: new Set(),
      notices: [],
      completed: [],
    };

    for (const [playerId, m] of [...this.active].sort((a, b) => a[0] - b[0])) {
      const p = state.players.byId[playerId];
      if (!p) {
        this.active.delete(playerId);
        continue;
      }

      // Failure conditions first, because they are what make a job tense in a
      // sandbox you can always simply drive away from.
      if (state.tick >= m.deadlineTick) {
        this.fail(out, playerId, 'out of time');
        continue;
      }
      if (p.mode === 'dead') {
        this.fail(out, playerId, 'you did not make it');
        continue;
      }

      const before = m.progress;
      for (const ev of events) {
        if (ev.type === 'pedDown' && ev.killerId === playerId) {
          if (m.spec.kind === 'hit' || m.spec.kind === 'sweep') m.progress++;
        }
      }

      if (m.spec.kind === 'delivery') {
        const v = p.mode === 'driving' && p.vehicleId !== null ? state.vehicles.byId[p.vehicleId] : null;
        if (v && v.kind === m.wantKind && m.marker) {
          const near = Math.abs(v.pos.x - m.marker.x) < 60 && Math.abs(v.pos.y - m.marker.y) < 60;
          if (near && Math.abs(v.speed) < 40) m.progress = m.spec.count;
        }
      }

      if (m.progress !== before) out.changed.add(playerId);

      if (m.progress >= m.spec.count) {
        this.active.delete(playerId);
        creditGangFavour(p, m.employer, getTuning().respect.missionFavour);
        out.completed.push({ playerId, employer: m.employer, pay: m.spec.pay });
        out.notices.push({
          playerId,
          text: `job done for ${gangName(m.employer)}`,
        });
        out.changed.add(playerId);
      }
    }
    return out;
  }

  private fail(out: MissionOutcome, playerId: number, why: string): void {
    this.active.delete(playerId);
    out.notices.push({ playerId, text: `job failed — ${why}` });
    out.changed.add(playerId);
  }
}

function describe(m: ActiveMission): string {
  switch (m.spec.kind) {
    case 'hit':
      return `take out ${m.spec.count} of them`;
    case 'sweep':
      return `hit ${m.spec.count} on rival ground`;
    case 'delivery':
      return `bring a ${m.wantKind ?? 'car'} to the crusher`;
  }
}

function nearestCrane(map: CityMap, from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const c of map.cranes) {
    const d = (c.x - from.x) ** 2 + (c.y - from.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function homeOf(map: CityMap, gangId: number): Vec2 | null {
  const home = map.turfHomes.find((h) => h.gang === gangId);
  return home ? { x: home.x, y: home.y } : null;
}
