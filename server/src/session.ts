import {
  type CityMap,
  type FullSnapshot,
  type GameState,
  type InputIntent,
  type ReplayTickRecord,
  type SimCommand,
  type SimEvent,
  type WeaponSlot,
  type WorldgenParams,
  RESPAWN_DELAY_TICKS,
  SNAPSHOT_RING_TICKS,
  createGameState,
  crowdScale,
  generateCity,
  step,
  takeSnapshot,
  timeOfDay,
} from 'shared';

const INPUT_QUEUE_MAX = 60;
/** How many parked cars a session starts with. */
const MAX_VEHICLES = 48;

/**
 * What a fresh guest carries. Fists come first and are never taken away —
 * an unarmed player still needs a verb.
 */
export const DEFAULT_LOADOUT: WeaponSlot[] = [
  { weaponId: 'fists', ammo: 0 },
  { weaponId: 'pistol', ammo: 90 },
];

export interface SessionOptions {
  weaponsLostOnDeath: boolean;
  pedCount: number;
}
/** Ped top-ups per second, and how far from a player they may appear. */
const PED_RESPAWN_PER_SEC = 2;
const PED_RESPAWN_MIN_DIST = 700;
/** Max consecutive ticks a missing client keeps "holding" their last keys. */
const MAX_HELD_TICKS = 6;
/** Hard ceiling on the backlog. Past this we fast-forward, jitter or no jitter. */
const MAX_INPUT_LAG_TICKS = 8;
/**
 * How deep the per-client jitter buffer is meant to sit, in ticks.
 *
 * One spare intent absorbs a single late packet without the server running
 * dry; two would just be latency nobody asked for.
 */
const TARGET_INPUT_DEPTH = 1;
/** How long a window the drain measures the buffer's low-water mark over. */
const DRAIN_WINDOW_TICKS = 30;

export interface PlayerSlot {
  playerId: number;
  name: string;
  resumeToken: string;
  connected: boolean;
  disconnectedAtMs: number | null;
  /** Unconsumed intents, ascending seq. Exactly one is applied per tick. */
  queue: InputIntent[];
  /** Held between messages: pressed keys stay pressed until a newer intent arrives. */
  lastIntent: InputIntent | null;
  /** Consecutive ticks the hold has been in effect; capped so a stalled client stops moving. */
  heldTicks: number;
  lastQueuedSeq: number;
  /** Last seq actually folded into the sim; echoed as ackSeq. */
  lastInputSeq: number;
  /** Lowest backlog seen so far this measuring window. See measureBacklog. */
  depthLowWater: number;
  /** Ticks left in the current window. */
  depthWindowLeft: number;
  /** Surplus intents the drain still means to skip, one per tick. */
  drainDebt: number;
  /** Last snapshot tick the client acked; deltas are computed against it. */
  lastAckTick: number;
  /** Ring of FILTERED snapshots actually sent to this client (interest mgmt). */
  sentRing: Map<number, FullSnapshot>;
}

export interface ReplayWriter {
  record(rec: ReplayTickRecord): void;
}

/**
 * Keep the input jitter buffer from silting up.
 *
 * A client produces one intent per tick and the server consumes at most one
 * per tick, so the two rates are equal — but they are not synchronised. Every
 * time jitter leaves the queue empty the server consumes nothing that tick
 * and holds the last keys instead, while the intent it was waiting for turns
 * up and sits behind the next one. The backlog is a random walk with a floor
 * at zero and no ceiling below MAX_INPUT_LAG_TICKS, so it only ever ratchets
 * upward: within a minute or two of ordinary jitter the buffer is pinned at
 * the cap and the server is simulating that player a quarter of a second in
 * the past — which is exactly the "server lags behind the client physics"
 * symptom, and, at the cap, drops intents the client has already predicted.
 *
 * The fix is the standard one: watch the buffer's LOW-WATER mark over a
 * window. A buffer that never emptied was never needed at that depth, so the
 * surplus is pure latency and gets drained one intent per tick. A buffer that
 * did run dry is doing its job and is left alone.
 */
function measureBacklog(slot: PlayerSlot): void {
  if (slot.queue.length < slot.depthLowWater) slot.depthLowWater = slot.queue.length;
  if (--slot.depthWindowLeft > 0) return;
  const surplus = slot.depthLowWater - TARGET_INPUT_DEPTH;
  if (Number.isFinite(surplus) && surplus > 0) slot.drainDebt = surplus;
  slot.depthLowWater = Infinity;
  slot.depthWindowLeft = DRAIN_WINDOW_TICKS;
}

/**
 * One authoritative game session (one process = one session, per plan).
 * Owns the GameState; everything else talks to the sim through inputs and
 * SimCommands, both of which get recorded for replay.
 */
export class Session {
  state: GameState;
  latestSnapshot: FullSnapshot;
  readonly seed: number;
  readonly map: CityMap;
  readonly worldgen: WorldgenParams;
  readonly slots = new Map<number, PlayerSlot>();

  private readonly snapshotRing = new Map<number, FullSnapshot>();
  private pendingCommands: SimCommand[] = [];
  /** One counter for every command-spawned entity (players, vehicles). */
  private nextId = 1;
  /** Rolling position in the ped spawn list, so top-ups spread over the city. */
  private pedSpawnCursor = 0;
  /** Events emitted by the most recent tick (kills, shots, deaths). */
  lastEvents: SimEvent[] = [];
  /** Intents applied on the last tick, by player id. */
  lastIntents: Record<number, InputIntent | undefined> = {};
  private pendingRespawns: Array<{
    playerId: number;
    dueTick: number;
    loadout: WeaponSlot[];
    atStation: boolean;
  }> = [];
  private readonly options: SessionOptions;

  constructor(
    seed: number,
    worldgen: WorldgenParams,
    private readonly recorder: ReplayWriter | null = null,
    options: Partial<SessionOptions> = {},
  ) {
    this.options = {
      weaponsLostOnDeath: options.weaponsLostOnDeath ?? true,
      pedCount: options.pedCount ?? 200,
    };
    this.seed = seed;
    this.worldgen = worldgen;
    this.map = generateCity(seed, worldgen);
    this.state = createGameState(seed);
    this.latestSnapshot = takeSnapshot(this.state);
    this.snapshotRing.set(this.latestSnapshot.tick, this.latestSnapshot);

    // Populate the streets: parked cars from the map's spawn list. Commands,
    // so they land in the replay and reproduce exactly.
    // Spread across the whole city, not the first N of a row-major list: that
    // put every parked car in the map's top-left corner, where they jammed the
    // streets solid, and left the rest of the city bare.
    const spots = this.map.parkingSpots;
    const parkStride = Math.max(1, Math.floor(spots.length / MAX_VEHICLES));
    const spawns = spots.filter((_, i) => i % parkStride === 0).slice(0, MAX_VEHICLES);
    // The tank never survives a stride that samples one spot in six, and it
    // is the one piece of parked stock that is a destination rather than
    // scenery — so it is added back explicitly.
    for (const s of spots) {
      if (s.kind === 'tank' && !spawns.includes(s)) spawns.push(s);
    }
    for (const s of spawns) {
      this.pendingCommands.push({
        type: 'spawnVehicle',
        vehicleId: this.nextId++,
        kind: s.kind,
        x: s.x,
        y: s.y,
        heading: s.heading,
        gangId: s.gangId ?? 0,
      });
    }

    // Street furniture.
    for (const spot of this.map.propSpawns) {
      this.pendingCommands.push({
        type: 'spawnProp',
        propId: this.nextId++,
        kind: spot.kind,
        x: spot.x,
        y: spot.y,
        orient: spot.orient,
      });
    }

    // Boats at their moorings. The river is the only thing they can cross,
    // and it is the only thing a car cannot.
    for (const s of this.map.boatSpawns) {
      this.pendingCommands.push({
        type: 'spawnVehicle',
        vehicleId: this.nextId++,
        kind: 'boat',
        x: s.x,
        y: s.y,
        heading: s.heading,
      });
    }

    // Health, armour and ammo crates.
    for (const spot of this.map.pickupSpawns) {
      this.pendingCommands.push({
        type: 'spawnPickup',
        pickupId: this.nextId++,
        kind: spot.kind,
        x: spot.x,
        y: spot.y,
      });
    }

    // The crowds. Evenly sampled from the dense sidewalk spawn list.
    const pedSpawns = this.map.pedSpawns;
    const count = Math.min(this.options.pedCount, pedSpawns.length);
    const stride = count > 0 ? Math.max(1, Math.floor(pedSpawns.length / count)) : 1;
    for (let i = 0; i < count; i++) {
      const spot = pedSpawns[(i * stride) % pedSpawns.length];
      if (!spot) continue;
      this.pendingCommands.push({ type: 'spawnPed', pedId: this.nextId++, x: spot.x, y: spot.y });
    }
  }

  addPlayer(name: string, resumeToken: string): PlayerSlot {
    const playerId = this.nextId++;
    const slot: PlayerSlot = {
      playerId,
      name,
      resumeToken,
      connected: true,
      disconnectedAtMs: null,
      queue: [],
      lastIntent: null,
      heldTicks: 0,
      lastQueuedSeq: 0,
      lastInputSeq: 0,
      depthLowWater: Infinity,
      depthWindowLeft: DRAIN_WINDOW_TICKS,
      drainDebt: 0,
      lastAckTick: -1,
      sentRing: new Map(),
    };
    this.slots.set(playerId, slot);
    this.pendingCommands.push({
      type: 'spawnPlayer',
      playerId,
      name,
      loadout: DEFAULT_LOADOUT.map((w) => ({ ...w })),
    });
    return slot;
  }

  /** Rebind a dropped player within the grace window. Null if not resumable. */
  resumeByToken(token: string): PlayerSlot | null {
    for (const slot of this.slots.values()) {
      if (slot.resumeToken === token && !slot.connected) {
        slot.connected = true;
        slot.disconnectedAtMs = null;
        return slot;
      }
    }
    return null;
  }

  markDisconnected(playerId: number, nowMs: number): void {
    const slot = this.slots.get(playerId);
    if (!slot) return;
    slot.connected = false;
    slot.disconnectedAtMs = nowMs;
  }

  /** Despawn players whose resume grace has expired. */
  expireDisconnected(nowMs: number, graceMs: number): void {
    for (const [id, slot] of this.slots) {
      if (!slot.connected && slot.disconnectedAtMs !== null) {
        if (nowMs - slot.disconnectedAtMs >= graceMs) {
          this.pendingCommands.push({ type: 'despawnPlayer', playerId: id });
          this.slots.delete(id);
        }
      }
    }
  }

  /** External (economy) command injection — the one sanctioned write-path. */
  /**
   * Allocate an entity id, from the same counter every other spawn uses.
   *
   * Exposed so the proving ground cannot get out of step with the session's
   * own allocation — two counters would eventually collide and `insertEntity`
   * throws on a duplicate id.
   */
  allocateEntityId(): number {
    return this.nextId++;
  }

  queueCommand(cmd: SimCommand): void {
    this.pendingCommands.push(cmd);
  }

  queueInput(playerId: number, ackTick: number, intents: InputIntent[]): void {
    const slot = this.slots.get(playerId);
    if (!slot) return;
    if (ackTick > slot.lastAckTick && ackTick <= this.state.tick) {
      slot.lastAckTick = ackTick;
    }
    for (const intent of intents) {
      if (intent.seq <= slot.lastQueuedSeq) continue; // dupes / replays
      slot.lastQueuedSeq = intent.seq;
      slot.queue.push(intent);
      if (slot.queue.length > INPUT_QUEUE_MAX) slot.queue.shift();
    }
  }

  /**
   * Top the crowd back up to target. Peds are killed permanently by the sim,
   * so without this the city empties out over a long session and never
   * recovers. Spawn points are walked round-robin from a rolling cursor and
   * rejected if any player is close enough to watch someone appear — which is
   * why this lives here rather than in step(): it needs to know where clients
   * are looking, and that is server knowledge.
   */
  private topUpPeds(): void {
    // The crowd thins overnight and fills again. This is the only thing the
    // day/night clock changes outside the renderer, and it is deliberately a
    // TARGET rather than a behaviour: it is read where the population was
    // already being topped up, and it draws no random numbers, so the sim's
    // determinism is untouched.
    const scale = crowdScale(
      timeOfDay(this.state.tick, this.worldgen.dayLengthSec),
      this.worldgen.nightCrowdScale,
    );
    const target = Math.min(
      Math.round(this.options.pedCount * scale),
      this.map.pedSpawns.length,
    );
    // Spawns already queued this tick have not reached the sim yet, so they
    // must count against the deficit or the crowd overshoots its target.
    const inFlight = this.pendingCommands.reduce(
      (n, c) => (c.type === 'spawnPed' ? n + 1 : n),
      0,
    );
    const deficit = target - this.state.peds.ids.length - inFlight;
    if (deficit <= 0) return;
    // One arrival per call; the caller's cadence sets the rate.
    const budget = Math.min(deficit, 1);
    const players = this.state.players.ids
      .map((id) => this.state.players.byId[id])
      .filter((p): p is NonNullable<typeof p> => !!p && p.mode !== 'dead');

    let placed = 0;
    for (let i = 0; i < this.map.pedSpawns.length && placed < budget; i++) {
      this.pedSpawnCursor = (this.pedSpawnCursor + 1) % this.map.pedSpawns.length;
      const spot = this.map.pedSpawns[this.pedSpawnCursor];
      if (!spot) continue;
      const tooClose = players.some(
        (p) => Math.hypot(p.pos.x - spot.x, p.pos.y - spot.y) < PED_RESPAWN_MIN_DIST,
      );
      if (tooClose) continue;
      this.pendingCommands.push({
        type: 'spawnPed',
        pedId: this.nextId++,
        x: spot.x,
        y: spot.y,
      });
      placed++;
    }
  }

  /** Advance one tick: drain inputs and commands, step, snapshot, record. */
  tick(): FullSnapshot {
    // Rate-limited: at most PED_RESPAWN_PER_SEC arrivals a second.
    if (this.state.tick % Math.round(30 / PED_RESPAWN_PER_SEC) === 0) this.topUpPeds();
    const inputs: Record<number, InputIntent> = {};
    for (const [id, slot] of this.slots) {
      let intent: InputIntent | null = null;
      measureBacklog(slot);
      if (slot.queue.length > 0) {
        // One intent per tick, in seq order — required for reconciliation:
        // the server must apply every seq exactly once. If a client bursts
        // (network jitter delivered several at once), drain the backlog down
        // to a small bound so its sim time doesn't lag real time.
        while (slot.queue.length > MAX_INPUT_LAG_TICKS) {
          intent = slot.queue.shift() as InputIntent;
        }
        // Standing backlog, as opposed to a burst: skip one extra intent per
        // tick until the buffer is back at its target depth.
        if (slot.drainDebt > 0 && slot.queue.length > 1) {
          slot.drainDebt--;
          intent = slot.queue.shift() as InputIntent;
        }
        intent = slot.queue.shift() as InputIntent;
        slot.lastIntent = intent;
        slot.heldTicks = 0;
      } else if (slot.lastIntent && slot.heldTicks < MAX_HELD_TICKS) {
        // Brief gap: hold the last keys so movement doesn't stutter.
        intent = slot.lastIntent;
        slot.heldTicks++;
      }
      if (intent) {
        inputs[id] = intent;
        slot.lastInputSeq = intent.seq;
      }
    }
    // Respawns that have come due join this tick's command batch.
    const nowTick = this.state.tick + 1;
    for (let i = this.pendingRespawns.length - 1; i >= 0; i--) {
      const r = this.pendingRespawns[i];
      if (r && r.dueTick <= nowTick) {
        this.pendingCommands.push({
          type: 'respawnPlayer',
          playerId: r.playerId,
          loadout: r.loadout,
          atStation: r.atStation,
        });
        this.pendingRespawns.splice(i, 1);
      }
    }

    const commands = this.pendingCommands;
    this.pendingCommands = [];

    this.recorder?.record({
      t: this.state.tick + 1,
      inputs: inputs as unknown as Record<string, InputIntent>,
      commands,
    });

    const prev = this.state;
    const events: SimEvent[] = [];
    this.state = step(this.state, inputs, commands, this.map, events);
    this.lastEvents = events;
    // Kept for anything server-side that needs to know what a player was
    // holding this tick — a hold-up (O1) is a held key, not an event.
    this.lastIntents = inputs;

    // Deaths schedule a respawn. The WEAPONS_LOST_ON_DEATH design flag lives
    // HERE, not in sim code: it only changes what loadout the respawn
    // command carries, so both settings replay deterministically.
    // An arrest emits `busted` alongside its `death`; collect those first so
    // the respawn below knows which front door to use.
    const arrested = new Set<number>();
    for (const ev of events) if (ev.type === 'busted') arrested.add(ev.playerId);

    for (const ev of events) {
      if (ev.type !== 'death') continue;
      if (!this.slots.has(ev.playerId)) continue; // despawned player
      const weaponsAtDeath = prev.players.byId[ev.playerId]?.weapons ?? [];
      // Evidence is evidence: an arrest confiscates the guns whatever the
      // death flag says. WEAPONS_LOST_ON_DEATH is a question about dying.
      const loadout =
        this.options.weaponsLostOnDeath || arrested.has(ev.playerId)
          ? DEFAULT_LOADOUT.map((w) => ({ ...w }))
          : // Keeping your guns still means keeping exactly one pair of fists.
            [
              { weaponId: 'fists', ammo: 0 },
              ...weaponsAtDeath.filter((w) => w.weaponId !== 'fists').map((w) => ({ ...w })),
            ];
      this.pendingRespawns.push({
        playerId: ev.playerId,
        dueTick: ev.tick + RESPAWN_DELAY_TICKS,
        loadout,
        atStation: arrested.has(ev.playerId),
      });
    }

    const snap = takeSnapshot(this.state);
    this.latestSnapshot = snap;
    this.snapshotRing.set(snap.tick, snap);
    for (const t of this.snapshotRing.keys()) {
      if (t < snap.tick - SNAPSHOT_RING_TICKS) this.snapshotRing.delete(t);
    }
    return snap;
  }

  getSnapshotAt(tick: number): FullSnapshot | null {
    return this.snapshotRing.get(tick) ?? null;
  }
}
