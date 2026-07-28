import {
  type CityMap,
  type GameState,
  type PlayerState,
  type SimCommand,
  type SimEvent,
  type Vec2,
  TICK_RATE,
  TILE_SIZE,
  creditGangFavour,
  drivableTile,
  gangAt,
  gangName,
  getTuning,
  respectOf,
  wantedLevelOf,
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

export type MissionKind =
  | 'hit'
  | 'sweep'
  | 'delivery'
  /** Take on heat, then reach a marker and stay clean while a clock runs. */
  | 'escape'
  /** Hit an ordered list of markers before the clock does. */
  | 'race'
  /** Drive a bomb-fitted car to a target and set it off. */
  | 'bomb'
  /** Walk somebody across town without losing them. */
  | 'escort';
export type MissionTier = 'green' | 'yellow' | 'red';

export interface MissionSpec {
  kind: MissionKind;
  tier: MissionTier;
  /** Respect with the employer needed before they will offer it. */
  needs: number;
  /** How long you get, in seconds. */
  seconds: number;
  /** Bodies, vehicles, or checkpoints, depending on the verb. */
  count: number;
  pay: number;
  /** escape: stars you must be carrying before the run counts. */
  needsStars?: number;
  /** escape: seconds you must stay clean at the marker. */
  holdSeconds?: number;
  /** escort: how far you may get from them before they are lost, px. */
  loseDistance?: number;
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
  /** For a race: every checkpoint, in order. `marker` is the next one. */
  route?: Vec2[];
  /** Which link of the employer's chain this is, or undefined off-chain. */
  chainStep?: number;
  /** For an escape: tick the hold completes on, or null before it starts. */
  holdUntilTick?: number | null;
  /** For an escort: the pedestrian in your care. */
  escorteeId?: number;
  /** For a delivery: the vehicle the job depends on, once you are in it. */
  vehicleId?: number;
  /**
   * For an escape: have you ever actually been as hot as the job requires?
   *
   * Without this the mission is a walk — take it, drive to the marker clean,
   * stand still for eight seconds, collect. You have to EARN the heat before
   * losing it counts as losing it.
   */
  primed?: boolean;
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
  /** Every remaining checkpoint, for a race. The first is `marker`. */
  route: Vec2[];
  /** Where this sits in the employer's chain, 0/0 when off-chain. */
  chainStep: number;
  chainOf: number;
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
  // Escape makes the POLICE the objective rather than the obstacle, which is
  // the most developed system this project has and the one nothing else
  // pointed a mission at.
  { kind: 'escape', tier: 'yellow', needs: 10, seconds: 150, count: 1, pay: 1200, needsStars: 2, holdSeconds: 8 },
  { kind: 'race', tier: 'green', needs: -10, seconds: 95, count: 4, pay: 700 },
  { kind: 'race', tier: 'red', needs: 35, seconds: 110, count: 6, pay: 2400 },
  { kind: 'bomb', tier: 'red', needs: 35, seconds: 140, count: 1, pay: 2800 },
  { kind: 'escort', tier: 'yellow', needs: 10, seconds: 160, count: 1, pay: 1400, loseDistance: 260 },
];

/** How close counts as reaching a marker, px. */
const MARKER_REACH = 60;

/**
 * What each gang asks of you, in order.
 *
 * Short on purpose: four to six jobs. A twenty-mission chain in a persistent
 * world is a commitment the player cannot pause, and this game has no
 * cutscenes to carry one — four is enough to feel like a relationship and
 * short enough to finish in a sitting. Each chain escalates in tier, so a
 * gang's last job is their best-paying one.
 *
 * Indexes into SPECS, so a chain cannot ask for a job that does not exist.
 * Per (player, gang) and persisted with the account, which is what makes it a
 * relationship rather than a session.
 */
const CHAINS: number[][] = [
  // Kessler Row: bodies first, then their rivals' ground, then the big one.
  [0, 3, 4, 6],
  // Sunnyside: errands, then a race, then a delivery.
  [1, 8, 2, 5],
  // The Quay: a sweep, an escort, an escape, a delivery.
  [1, 12, 7, 5],
  // Halloran: hits, a race, and a bomb on somebody's doorstep.
  [0, 3, 9, 11],
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
  private pendingCommands: SimCommand[] = [];
  /** How far each player has got with each gang. `${playerId}:${gangId}`. */
  private readonly chain = new Map<string, number>();

  chainStep(playerId: number, gangId: number): number {
    return this.chain.get(`${playerId}:${gangId}`) ?? 0;
  }

  private setChainStep(playerId: number, gangId: number, step: number): void {
    this.chain.set(`${playerId}:${gangId}`, step);
  }

  /** Restored on login, so a relationship is not a session. */
  seedChains(playerId: number, saved: Record<string, number> | undefined): void {
    if (!saved) return;
    for (const [gang, step] of Object.entries(saved)) {
      if (typeof step === 'number' && step > 0) this.chain.set(`${playerId}:${gang}`, step);
    }
  }

  /** Everything this player has done with everybody, for persistence. */
  chainsOf(playerId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, step] of this.chain) {
      const [pid, gang] = key.split(':');
      if (Number(pid) === playerId && gang) out[gang] = step;
    }
    return out;
  }

  /** How far along, for the HUD: "job 3 of 5". */
  chainProgress(playerId: number, gangId: number): { step: number; of: number } {
    const chain = CHAINS[(gangId - 1) % CHAINS.length] ?? [];
    return { step: this.chainStep(playerId, gangId), of: chain.length };
  }

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
        route: [],
        chainStep: 0,
        chainOf: 0,
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
      route: m.route ? m.route.slice(m.progress) : [],
      // A chain the player cannot see is a chain that feels like coincidence.
      chainStep: m.chainStep === undefined ? 0 : m.chainStep + 1,
      chainOf: m.chainStep === undefined ? 0 : this.chainProgress(playerId, m.employer).of,
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

    // A gang you have worked for asks for the next thing on their list. Only
    // once you have earned the tier it sits at, so a chain cannot smuggle you
    // past the respect gate — it decides WHAT they say next, not whether they
    // will talk to you at all.
    let spec: MissionSpec | null = null;
    const step = this.chainStep(playerId, employer);
    const chain = CHAINS[(employer - 1) % CHAINS.length] ?? [];
    const next = step < chain.length ? SPECS[chain[step] as number] : undefined;
    const offers = SPECS.filter((s) => standing >= s.needs);
    if (offers.length === 0) return `${gangName(employer)} has nothing for you yet`;

    // The chain's next link first, then the flat board — and the board is a
    // genuine fallback rather than a formality. Setting a job up can fail for
    // reasons that have nothing to do with the player (an escort needs
    // somebody on the street to escort), and a chain that refuses in that
    // case would leave them unable to get work from that gang ever again.
    const candidates: Array<{ spec: MissionSpec; step: number | null }> = [];
    if (next && standing >= next.needs) candidates.push({ spec: next, step });
    for (let i = 0; i < offers.length; i++) {
      candidates.push({ spec: offers[(this.offerCursor + i) % offers.length] as MissionSpec, step: null });
    }
    this.offerCursor++;

    let lastWhy = `${gangName(employer)} has nothing for you yet`;
    for (const candidate of candidates) {
      const built = this.build(playerId, p, employer, candidate.spec, candidate.step, state, map);
      if (typeof built === 'string') {
        lastWhy = built;
        continue;
      }
      this.active.set(playerId, built);
      return null;
    }
    return lastWhy;
  }

  /**
   * Turn a spec into a live mission, or say why it cannot be one right now.
   * Separated from `take` so the chain can fall back to the board when a
   * particular job has no way to exist at this moment.
   */
  private build(
    playerId: number,
    p: PlayerState,
    employer: number,
    spec: MissionSpec,
    chainStep: number | null,
    state: GameState,
    map: CityMap,
  ): ActiveMission | string {

    const mission: ActiveMission = {
      id: this.nextId++,
      playerId,
      spec,
      employer,
      deadlineTick: state.tick + Math.round(spec.seconds * TICK_RATE),
      progress: 0,
      marker: null,
    };
    if (chainStep !== null) mission.chainStep = chainStep;
    if (spec.kind === 'delivery') {
      mission.wantKind = WANTED_KINDS[mission.id % WANTED_KINDS.length] as string;
      mission.marker = nearestCrane(map, p.pos);
    } else if (spec.kind === 'sweep') {
      // A sweep sends you onto somebody else's ground: the employer's rival.
      const rival = getTuning().gangs.gangs.find((g) => g.id === employer)?.rivals[0] ?? 0;
      mission.marker = homeOf(map, rival);
    } else if (spec.kind === 'escape') {
      // Somewhere to run TO. A crane yard: reachable, off the main drag, and
      // already a landmark the radar draws.
      mission.marker = nearestCrane(map, p.pos);
      mission.holdUntilTick = null;
      mission.primed = false;
    } else if (spec.kind === 'race') {
      mission.route = raceRoute(map, p.pos, spec.count, mission.id);
      mission.marker = mission.route[0] ?? null;
    } else if (spec.kind === 'escort') {
      // The nearest civilian on foot becomes your problem. Chosen here rather
      // than spawned, because a person who appears out of nowhere to be
      // escorted is a person the player has no reason to care about.
      const pick = nearestCivilian(state, p.pos);
      if (pick === null) return 'nobody here needs walking anywhere';
      mission.escorteeId = pick;
      mission.marker = homeOf(map, employer);
      this.pendingCommands.push({ type: 'setEscort', pedId: pick, playerId });
    } else if (spec.kind === 'bomb') {
      // The target is a rival's home ground: a bomb job is a message.
      const rival = getTuning().gangs.gangs.find((g) => g.id === employer)?.rivals[0] ?? 0;
      mission.marker = homeOf(map, rival);
    }
    return mission;
  }

  /** Commands the take() above queued, drained by the caller. */
  drainCommands(): SimCommand[] {
    const out = this.pendingCommands;
    this.pendingCommands = [];
    return out;
  }

  abandon(playerId: number): void {
    const m = this.active.get(playerId);
    if (m?.escorteeId !== undefined) {
      this.pendingCommands.push({ type: 'setEscort', pedId: m.escorteeId, playerId: null });
    }
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
          const near =
            Math.abs(v.pos.x - m.marker.x) < MARKER_REACH &&
            Math.abs(v.pos.y - m.marker.y) < MARKER_REACH;
          if (near && Math.abs(v.speed) < 40) m.progress = m.spec.count;
        }
      }

      if (m.spec.kind === 'escape') {
        // Three conditions, and the order is the mission: get hot, get to the
        // marker, then get cold and stay put. Dropping any one of them turns
        // it into a different, easier job — most obviously, without `primed`
        // you can drive there clean and simply wait.
        const stars = wantedLevelOf(p);
        if (stars >= (m.spec.needsStars ?? 1) && !m.primed) {
          m.primed = true;
          out.changed.add(playerId);
          out.notices.push({ playerId, text: 'they are on you — now lose them' });
        }
        const atMarker =
          m.marker !== null &&
          Math.abs(p.pos.x - m.marker.x) < MARKER_REACH &&
          Math.abs(p.pos.y - m.marker.y) < MARKER_REACH;
        if (!atMarker || !m.primed || stars > 0) {
          m.holdUntilTick = null;
        } else if (m.holdUntilTick === null || m.holdUntilTick === undefined) {
          m.holdUntilTick = state.tick + Math.round((m.spec.holdSeconds ?? 8) * TICK_RATE);
          out.changed.add(playerId);
        } else if (state.tick >= m.holdUntilTick) {
          m.progress = m.spec.count;
        }
      }

      if (m.spec.kind === 'race' && m.route) {
        const at = m.route[m.progress];
        if (
          at &&
          Math.abs(p.pos.x - at.x) < MARKER_REACH &&
          Math.abs(p.pos.y - at.y) < MARKER_REACH
        ) {
          // IN ORDER. Standing on checkpoint four does nothing until one,
          // two and three have been visited — which is the whole difference
          // between a race and a scavenger hunt.
          m.progress++;
          m.marker = m.route[m.progress] ?? m.marker;
        }
      }

      if (m.spec.kind === 'escort') {
        const ped = m.escorteeId === undefined ? undefined : state.peds.byId[m.escorteeId];
        if (!ped || ped.mode === 'downed') {
          this.fail(out, playerId, 'they did not make it');
          continue;
        }
        const gap = Math.hypot(ped.pos.x - p.pos.x, ped.pos.y - p.pos.y);
        if (gap > (m.spec.loseDistance ?? 260)) {
          this.fail(out, playerId, 'you lost them');
          continue;
        }
        if (
          m.marker &&
          Math.abs(ped.pos.x - m.marker.x) < MARKER_REACH &&
          Math.abs(ped.pos.y - m.marker.y) < MARKER_REACH
        ) {
          m.progress = m.spec.count;
        }
      }

      // The car a job depends on, wrecked. Remembered the moment you get into
      // the right one, so losing it is a failure rather than a shrug and a
      // walk to find another.
      if (m.spec.kind === 'delivery') {
        if (m.vehicleId === undefined && p.mode === 'driving' && p.vehicleId !== null) {
          const v = state.vehicles.byId[p.vehicleId];
          if (v && v.kind === m.wantKind) m.vehicleId = v.id;
        }
        if (m.vehicleId !== undefined) {
          const v = state.vehicles.byId[m.vehicleId];
          if (!v || v.condition === 'wreck') {
            this.fail(out, playerId, 'the car is a write-off');
            continue;
          }
        }
      }

      if (m.spec.kind === 'bomb' && m.marker) {
        for (const ev of events) {
          if (ev.type !== 'explosion') continue;
          const near =
            Math.abs(ev.x - m.marker.x) < MARKER_REACH * 2 &&
            Math.abs(ev.y - m.marker.y) < MARKER_REACH * 2;
          if (near) m.progress = m.spec.count;
        }
      }

      if (m.progress !== before) out.changed.add(playerId);

      if (m.progress >= m.spec.count) {
        this.release(out, m);
        this.active.delete(playerId);
        // Only a job that was ON the chain advances it. Finishing a flat-board
        // job for them is work, not progress through their story.
        if (m.chainStep !== undefined) this.setChainStep(playerId, m.employer, m.chainStep + 1);
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
    this.release(out, this.active.get(playerId));
    this.active.delete(playerId);
    out.notices.push({ playerId, text: `job failed — ${why}` });
    out.changed.add(playerId);
  }

  /**
   * Hand an escortee back to the crowd. Called on every exit from a mission —
   * success, failure, abandonment — because a person still following you
   * after the job ended is a bug you notice ten minutes later.
   */
  private release(out: MissionOutcome, m: ActiveMission | undefined): void {
    if (m?.escorteeId === undefined) return;
    out.commands.push({ type: 'setEscort', pedId: m.escorteeId, playerId: null });
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
    case 'escape':
      if (m.holdUntilTick != null) return 'lie low — do not move';
      return m.primed
        ? 'lose them, then get to the crane'
        : `pull ${m.spec.needsStars ?? 1} stars first`;
    case 'race':
      return `${m.spec.count} checkpoints, in order`;
    case 'bomb':
      return 'put a bomb car on their doorstep';
    case 'escort':
      return 'walk them home, and keep them alive';
  }
}

/**
 * A ring of checkpoints around the player, each on a road.
 *
 * A ring rather than a random scatter: it guarantees the route goes somewhere
 * and comes back, so a race cannot be won by standing still and cannot send
 * you off the edge of the map either. The starting angle varies by mission
 * id, so two races from the same corner are not the same race.
 */
function raceRoute(map: CityMap, from: Vec2, count: number, salt: number): Vec2[] {
  const out: Vec2[] = [];
  const radius = 520;
  for (let i = 0; i < count; i++) {
    const angle = ((i + salt * 0.37) / count) * Math.PI * 2;
    const want = { x: from.x + Math.cos(angle) * radius, y: from.y + Math.sin(angle) * radius };
    out.push(nearestRoad(map, want) ?? want);
  }
  return out;
}

/** Nearest drivable tile centre to a point, searched outwards. */
function nearestRoad(map: CityMap, want: Vec2): Vec2 | null {
  const tx0 = Math.floor(want.x / TILE_SIZE);
  const ty0 = Math.floor(want.y / TILE_SIZE);
  for (let r = 0; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = tx0 + dx;
        const ty = ty0 + dy;
        if (!drivableTile(map, tx, ty)) continue;
        return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
      }
    }
  }
  return null;
}

/** Nearest civilian on foot, by id order for ties. */
function nearestCivilian(state: GameState, from: Vec2): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped || ped.gangId !== 0 || ped.mode === 'downed' || ped.escortOf !== null) continue;
    const d = (ped.pos.x - from.x) ** 2 + (ped.pos.y - from.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
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
