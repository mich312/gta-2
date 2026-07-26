import {
  type FullSnapshot,
  type GameState,
  type InputIntent,
  type ReplayTickRecord,
  type SimCommand,
  SNAPSHOT_RING_TICKS,
  createGameState,
  step,
  takeSnapshot,
} from 'shared';

const INPUT_QUEUE_MAX = 60;

export interface PlayerSlot {
  playerId: number;
  name: string;
  resumeToken: string;
  connected: boolean;
  disconnectedAtMs: number | null;
  /** Unconsumed intents, ascending seq. Phase 1 consumes one per tick; phase 0 applies the newest. */
  queue: InputIntent[];
  /** Held between messages: pressed keys stay pressed until a newer intent arrives. */
  lastIntent: InputIntent | null;
  lastQueuedSeq: number;
  /** Last seq actually folded into the sim; echoed as ackSeq. */
  lastInputSeq: number;
  /** Last snapshot tick the client acked; deltas are computed against it. */
  lastAckTick: number;
}

export interface ReplayWriter {
  record(rec: ReplayTickRecord): void;
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
  readonly slots = new Map<number, PlayerSlot>();

  private readonly snapshotRing = new Map<number, FullSnapshot>();
  private pendingCommands: SimCommand[] = [];
  private nextPlayerId = 1;

  constructor(
    seed: number,
    private readonly recorder: ReplayWriter | null = null,
  ) {
    this.seed = seed;
    this.state = createGameState(seed);
    this.latestSnapshot = takeSnapshot(this.state);
    this.snapshotRing.set(this.latestSnapshot.tick, this.latestSnapshot);
  }

  addPlayer(name: string, resumeToken: string): PlayerSlot {
    const playerId = this.nextPlayerId++;
    const slot: PlayerSlot = {
      playerId,
      name,
      resumeToken,
      connected: true,
      disconnectedAtMs: null,
      queue: [],
      lastIntent: null,
      lastQueuedSeq: 0,
      lastInputSeq: 0,
      lastAckTick: -1,
    };
    this.slots.set(playerId, slot);
    this.pendingCommands.push({ type: 'spawnPlayer', playerId, name });
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

  /** Advance one tick: drain inputs and commands, step, snapshot, record. */
  tick(): FullSnapshot {
    const inputs: Record<number, InputIntent> = {};
    for (const [id, slot] of this.slots) {
      let intent = slot.lastIntent;
      if (slot.queue.length > 0) {
        intent = slot.queue[slot.queue.length - 1] as InputIntent;
        slot.queue.length = 0;
      }
      if (intent) {
        inputs[id] = intent;
        slot.lastIntent = intent;
        slot.lastInputSeq = intent.seq;
      }
    }
    const commands = this.pendingCommands;
    this.pendingCommands = [];

    this.recorder?.record({
      t: this.state.tick + 1,
      inputs: inputs as unknown as Record<string, InputIntent>,
      commands,
    });

    this.state = step(this.state, inputs, commands);
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
