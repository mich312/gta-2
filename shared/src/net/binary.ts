/**
 * Binary wire codec.
 *
 * Why: JSON snapshot deltas cost about 42 KB/s per client against a 50 KB/s
 * gate, which leaves room for roughly two moving vehicles in view. Ambient
 * traffic and police cars need eight to twelve. The `Codec` seam was written
 * for exactly this moment.
 *
 * **The whole contract is that this is lossless.** `hashSnapshot` runs on
 * both sides of the wire, so a value that decodes even one ULP different
 * produces a desync that reads like a physics bug. Two rules keep that true:
 *
 *  1. A field is stored as a quantised integer ONLY where the simulation
 *     itself already quantises it — positions and velocities through `q8`,
 *     angles and speeds through `q256`/`q8`. Encoding those as integers in
 *     the *same* grid the sim rounds to is exact, not approximate.
 *  2. Everything else — health, heat, prop hp, pedestrian heading components
 *     — is written as float64. Those are plain arithmetic results with no
 *     quantisation step behind them, and guessing a grid for them would be
 *     the exact mistake this comment exists to prevent.
 *
 * Note for anyone tempted to shrink a heading: `q256` is 1/256 of a *radian*,
 * not of a turn, so a full circle needs ~1608 steps — 11 bits. A uint8 would
 * be lossy.
 *
 * Only the high-frequency messages are binary: `snapshot`, `full` and client
 * `input`. Everything else (welcome, events, pong, wallet, account, errors,
 * join, buy, login) stays JSON behind a tag byte — those are rare, and
 * hand-rolling a binary format for the nested tuning/worldgen/catalog payload
 * would be a lot of risk for no measurable bandwidth.
 */
import type { Codec, WireMessage } from './codec.js';
import type { FullSnapshot, Patch, SnapshotDelta, TableDelta } from './snapshot.js';
import type {
  CopState,
  PedState,
  PickupState,
  PlayerState,
  PropState,
  VehicleState,
} from '../sim/state.js';
import type { InputIntent } from '../sim/input.js';

/**
 * UTF-8 by hand. `shared/` is required to import nothing from Node or the
 * DOM, and TextEncoder/TextDecoder are typed by neither lib — hand-rolling
 * keeps that constraint intact for the sake of two short helpers. Strings on
 * this wire are weapon ids, prop kinds and player names.
 */
function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // Combine a surrogate pair into a single code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = (c - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return out;
}

function utf8Decode(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  let i = from;
  while (i < to) {
    const b = bytes[i++] as number;
    let c: number;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 0x1f) << 6) | ((bytes[i++] as number) & 0x3f);
    else if (b < 0xf0) {
      c = ((b & 0x0f) << 12) | (((bytes[i++] as number) & 0x3f) << 6) | ((bytes[i++] as number) & 0x3f);
    } else {
      c =
        ((b & 0x07) << 18) |
        (((bytes[i++] as number) & 0x3f) << 12) |
        (((bytes[i++] as number) & 0x3f) << 6) |
        ((bytes[i++] as number) & 0x3f);
    }
    if (c > 0xffff) {
      c -= 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

const TAG_JSON = 0;
const TAG_SNAPSHOT = 1;
const TAG_FULL = 2;
const TAG_INPUT = 3;

const PLAYER_MODES = ['foot', 'driving', 'dead'] as const;
const PED_MODES = ['walk', 'flee'] as const;
const PICKUP_KINDS = ['health', 'armour', 'ammo'] as const;

// ---------------------------------------------------------------- writer

class Writer {
  private buf = new Uint8Array(2048);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** LEB128. */
  uint(v: number): void {
    let x = v >>> 0;
    for (;;) {
      const byte = x & 0x7f;
      x = x >>> 7;
      if (x === 0) {
        this.u8(byte);
        return;
      }
      this.u8(byte | 0x80);
    }
  }

  /** Zigzag + LEB128, for values that may be negative. */
  int(v: number): void {
    this.uint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  /** Larger-than-32-bit-safe unsigned, for ticks late in a long session. */
  big(v: number): void {
    let x = Math.max(0, Math.floor(v));
    for (;;) {
      const byte = x % 128;
      x = Math.floor(x / 128);
      if (x === 0) {
        this.u8(byte);
        return;
      }
      this.u8(byte | 0x80);
    }
  }

  f64(v: number): void {
    this.ensure(8);
    new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, v, true);
    this.len += 8;
  }

  u32(v: number): void {
    this.ensure(4);
    new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 4).setUint32(0, v >>> 0, true);
    this.len += 4;
  }

  str(s: string): void {
    const bytes = utf8Encode(s);
    this.uint(bytes.length);
    this.ensure(bytes.length);
    for (let i = 0; i < bytes.length; i++) this.buf[this.len + i] = bytes[i] as number;
    this.len += bytes.length;
  }

  bool(b: boolean): void {
    this.u8(b ? 1 : 0);
  }

  /** A value the sim quantises with q8 — exact as an integer of eighths. */
  q8(v: number): void {
    this.int(Math.round(v * 8));
  }

  /** A value the sim quantises with q256 — exact as an integer of 1/256ths. */
  q256(v: number): void {
    this.int(Math.round(v * 256));
  }

  /** Nullable integer, as a presence byte plus the value. */
  optInt(v: number | null): void {
    if (v === null) {
      this.u8(0);
      return;
    }
    this.u8(1);
    this.int(v);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---------------------------------------------------------------- reader

class Reader {
  private off = 0;
  private view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    return this.buf[this.off++] as number;
  }

  uint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }

  int(): number {
    const v = this.uint();
    return (v >>> 1) ^ -(v & 1);
  }

  big(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * mul;
      if ((byte & 0x80) === 0) return result;
      mul *= 128;
    }
  }

  f64(): number {
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  str(): string {
    const n = this.uint();
    const s = utf8Decode(this.buf, this.off, this.off + n);
    this.off += n;
    return s;
  }

  bool(): boolean {
    return this.u8() === 1;
  }

  q8(): number {
    return this.int() / 8;
  }

  q256(): number {
    return this.int() / 256;
  }

  optInt(): number | null {
    return this.u8() === 0 ? null : this.int();
  }
}

// ------------------------------------------------- per-table field codecs

/**
 * One entry per diffable field, in the same order as the *_FIELDS arrays in
 * snapshot.ts. The bit index in the update mask is the index here, so this
 * order is part of the wire format — append, never reorder.
 */
interface FieldCodec<T> {
  name: keyof T & string;
  write: (w: Writer, v: T) => void;
  read: (r: Reader, into: Record<string, unknown>) => void;
}

function f<T>(
  name: keyof T & string,
  write: (w: Writer, v: T) => void,
  read: (r: Reader, into: Record<string, unknown>) => void,
): FieldCodec<T> {
  return { name, write, read };
}

const PLAYER_CODECS: Array<FieldCodec<PlayerState>> = [
  f('name', (w, p) => w.str(p.name), (r, o) => (o['name'] = r.str())),
  f(
    'pos',
    (w, p) => {
      w.q8(p.pos.x);
      w.q8(p.pos.y);
    },
    (r, o) => (o['pos'] = { x: r.q8(), y: r.q8() }),
  ),
  f(
    'vel',
    (w, p) => {
      w.q8(p.vel.x);
      w.q8(p.vel.y);
    },
    (r, o) => (o['vel'] = { x: r.q8(), y: r.q8() }),
  ),
  f('aimAngle', (w, p) => w.q256(p.aimAngle), (r, o) => (o['aimAngle'] = r.q256())),
  f(
    'mode',
    (w, p) => w.u8(PLAYER_MODES.indexOf(p.mode)),
    (r, o) => (o['mode'] = PLAYER_MODES[r.u8()]),
  ),
  f('health', (w, p) => w.f64(p.health), (r, o) => (o['health'] = r.f64())),
  f('armour', (w, p) => w.f64(p.armour), (r, o) => (o['armour'] = r.f64())),
  f('vehicleId', (w, p) => w.optInt(p.vehicleId), (r, o) => (o['vehicleId'] = r.optInt())),
  f(
    'weapons',
    (w, p) => {
      w.uint(p.weapons.length);
      for (const s of p.weapons) {
        w.str(s.weaponId);
        w.int(s.ammo);
      }
    },
    (r, o) => {
      const n = r.uint();
      const out: Array<{ weaponId: string; ammo: number }> = [];
      for (let i = 0; i < n; i++) out.push({ weaponId: r.str(), ammo: r.int() });
      o['weapons'] = out;
    },
  ),
  f('activeWeapon', (w, p) => w.int(p.activeWeapon), (r, o) => (o['activeWeapon'] = r.int())),
  f('cosmeticId', (w, p) => w.int(p.cosmeticId), (r, o) => (o['cosmeticId'] = r.int())),
  f('wantedLevel', (w, p) => w.int(p.wantedLevel), (r, o) => (o['wantedLevel'] = r.int())),
  f(
    'respawnAtTick',
    (w, p) => w.optInt(p.respawnAtTick),
    (r, o) => (o['respawnAtTick'] = r.optInt()),
  ),
  f('actionHeld', (w, p) => w.bool(p.actionHeld), (r, o) => (o['actionHeld'] = r.bool())),
  f('fireCooldown', (w, p) => w.int(p.fireCooldown), (r, o) => (o['fireCooldown'] = r.int())),
  f(
    'carHitCooldown',
    (w, p) => w.int(p.carHitCooldown),
    (r, o) => (o['carHitCooldown'] = r.int()),
  ),
  f('heat', (w, p) => w.f64(p.heat), (r, o) => (o['heat'] = r.f64())),
  // Appended last, so no existing mask bit shifts. Deliberately absent from
  // PLAYER_FIELDS (it changes every tick and remote clients ignore it), so
  // the diff never sets this bit and patches never carry it — but a whole
  // entity must, because `full`/`welcome` carry no ackSeq and the client
  // falls back to this field to reconcile against.
  f(
    'lastInputSeq',
    (w, p) => w.big(p.lastInputSeq),
    (r, o) => (o['lastInputSeq'] = r.big()),
  ),
];

const VEHICLE_CODECS: Array<FieldCodec<VehicleState>> = [
  f('kind', (w, v) => w.str(v.kind), (r, o) => (o['kind'] = r.str())),
  f(
    'pos',
    (w, v) => {
      w.q8(v.pos.x);
      w.q8(v.pos.y);
    },
    (r, o) => (o['pos'] = { x: r.q8(), y: r.q8() }),
  ),
  f('heading', (w, v) => w.q256(v.heading), (r, o) => (o['heading'] = r.q256())),
  f('speed', (w, v) => w.q8(v.speed), (r, o) => (o['speed'] = r.q8())),
  f('driverId', (w, v) => w.optInt(v.driverId), (r, o) => (o['driverId'] = r.optInt())),
];

const COP_CODECS: Array<FieldCodec<CopState>> = [
  f(
    'pos',
    (w, c) => {
      w.q8(c.pos.x);
      w.q8(c.pos.y);
    },
    (r, o) => (o['pos'] = { x: r.q8(), y: r.q8() }),
  ),
  f(
    'vel',
    (w, c) => {
      w.q8(c.vel.x);
      w.q8(c.vel.y);
    },
    (r, o) => (o['vel'] = { x: r.q8(), y: r.q8() }),
  ),
  f('targetId', (w, c) => w.optInt(c.targetId), (r, o) => (o['targetId'] = r.optInt())),
  f('health', (w, c) => w.f64(c.health), (r, o) => (o['health'] = r.f64())),
  f('fireCooldown', (w, c) => w.int(c.fireCooldown), (r, o) => (o['fireCooldown'] = r.int())),
  f('idleTicks', (w, c) => w.int(c.idleTicks), (r, o) => (o['idleTicks'] = r.int())),
  f(
    'carHitCooldown',
    (w, c) => w.int(c.carHitCooldown),
    (r, o) => (o['carHitCooldown'] = r.int()),
  ),
];

const PED_CODECS: Array<FieldCodec<PedState>> = [
  f(
    'pos',
    (w, p) => {
      w.q8(p.pos.x);
      w.q8(p.pos.y);
    },
    (r, o) => (o['pos'] = { x: r.q8(), y: r.q8() }),
  ),
  // dirX/dirY are normalised flee vectors — arbitrary floats, not quantised.
  f('dirX', (w, p) => w.f64(p.dirX), (r, o) => (o['dirX'] = r.f64())),
  f('dirY', (w, p) => w.f64(p.dirY), (r, o) => (o['dirY'] = r.f64())),
  f('mode', (w, p) => w.u8(PED_MODES.indexOf(p.mode)), (r, o) => (o['mode'] = PED_MODES[r.u8()])),
  f('health', (w, p) => w.f64(p.health), (r, o) => (o['health'] = r.f64())),
  f('timer', (w, p) => w.int(p.timer), (r, o) => (o['timer'] = r.int())),
];

const PROP_CODECS: Array<FieldCodec<PropState>> = [
  f('kind', (w, p) => w.str(p.kind), (r, o) => (o['kind'] = r.str())),
  f(
    'pos',
    (w, p) => {
      w.q8(p.pos.x);
      w.q8(p.pos.y);
    },
    (r, o) => (o['pos'] = { x: r.q8(), y: r.q8() }),
  ),
  f('orient', (w, p) => w.int(p.orient), (r, o) => (o['orient'] = r.int())),
  f('intact', (w, p) => w.bool(p.intact), (r, o) => (o['intact'] = r.bool())),
  f('hp', (w, p) => w.f64(p.hp), (r, o) => (o['hp'] = r.f64())),
  f(
    'respawnAtTick',
    (w, p) => w.optInt(p.respawnAtTick),
    (r, o) => (o['respawnAtTick'] = r.optInt()),
  ),
];

const PICKUP_CODECS: Array<FieldCodec<PickupState>> = [
  f(
    'kind',
    (w, p) => w.u8(PICKUP_KINDS.indexOf(p.kind)),
    (r, o) => (o['kind'] = PICKUP_KINDS[r.u8()]),
  ),
  f(
    'pos',
    (w, p) => {
      w.q8(p.pos.x);
      w.q8(p.pos.y);
    },
    (r, o) => (o['pos'] = { x: r.q8(), y: r.q8() }),
  ),
  f('active', (w, p) => w.bool(p.active), (r, o) => (o['active'] = r.bool())),
  f(
    'respawnAtTick',
    (w, p) => w.optInt(p.respawnAtTick),
    (r, o) => (o['respawnAtTick'] = r.optInt()),
  ),
];

// ------------------------------------------------------------ table codecs

function writeEntity<T extends { id: number }>(
  w: Writer,
  e: T,
  codecs: Array<FieldCodec<T>>,
): void {
  w.uint(e.id);
  for (const c of codecs) c.write(w, e);
}

function readEntity<T extends { id: number }>(r: Reader, codecs: Array<FieldCodec<T>>): T {
  const out: Record<string, unknown> = { id: r.uint() };
  for (const c of codecs) c.read(r, out);
  return out as unknown as T;
}

function writePatch<T extends { id: number }>(
  w: Writer,
  patch: Patch<T>,
  codecs: Array<FieldCodec<T>>,
): void {
  w.uint(patch.id);
  let mask = 0;
  for (let i = 0; i < codecs.length; i++) {
    if ((codecs[i] as FieldCodec<T>).name in patch) mask |= 1 << i;
  }
  w.uint(mask);
  for (let i = 0; i < codecs.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    (codecs[i] as FieldCodec<T>).write(w, patch as unknown as T);
  }
}

function readPatch<T extends { id: number }>(r: Reader, codecs: Array<FieldCodec<T>>): Patch<T> {
  const out: Record<string, unknown> = { id: r.uint() };
  const mask = r.uint();
  for (let i = 0; i < codecs.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    (codecs[i] as FieldCodec<T>).read(r, out);
  }
  return out as unknown as Patch<T>;
}

function writeTable<T extends { id: number }>(
  w: Writer,
  d: TableDelta<T>,
  codecs: Array<FieldCodec<T>>,
): void {
  w.uint(d.added.length);
  for (const e of d.added) writeEntity(w, e, codecs);
  w.uint(d.updated.length);
  for (const p of d.updated) writePatch(w, p, codecs);
  w.uint(d.removed.length);
  for (const id of d.removed) w.uint(id);
}

function readTable<T extends { id: number }>(
  r: Reader,
  codecs: Array<FieldCodec<T>>,
): TableDelta<T> {
  const added: T[] = [];
  let n = r.uint();
  for (let i = 0; i < n; i++) added.push(readEntity(r, codecs));
  const updated: Array<Patch<T>> = [];
  n = r.uint();
  for (let i = 0; i < n; i++) updated.push(readPatch(r, codecs));
  const removed: number[] = [];
  n = r.uint();
  for (let i = 0; i < n; i++) removed.push(r.uint());
  return { added, updated, removed };
}

function writeList<T extends { id: number }>(
  w: Writer,
  list: T[],
  codecs: Array<FieldCodec<T>>,
): void {
  w.uint(list.length);
  for (const e of list) writeEntity(w, e, codecs);
}

function readList<T extends { id: number }>(r: Reader, codecs: Array<FieldCodec<T>>): T[] {
  const n = r.uint();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(readEntity(r, codecs));
  return out;
}

function writeSnapshot(w: Writer, s: FullSnapshot): void {
  w.big(s.tick);
  writeList(w, s.players, PLAYER_CODECS);
  writeList(w, s.vehicles, VEHICLE_CODECS);
  writeList(w, s.cops, COP_CODECS);
  writeList(w, s.peds, PED_CODECS);
  writeList(w, s.props, PROP_CODECS);
  writeList(w, s.pickups, PICKUP_CODECS);
}

function readSnapshot(r: Reader): FullSnapshot {
  return {
    tick: r.big(),
    players: readList(r, PLAYER_CODECS),
    vehicles: readList(r, VEHICLE_CODECS),
    cops: readList(r, COP_CODECS),
    peds: readList(r, PED_CODECS),
    props: readList(r, PROP_CODECS),
    pickups: readList(r, PICKUP_CODECS),
  };
}

function writeDelta(w: Writer, d: SnapshotDelta): void {
  writeTable(w, d.players, PLAYER_CODECS);
  writeTable(w, d.vehicles, VEHICLE_CODECS);
  writeTable(w, d.cops, COP_CODECS);
  writeTable(w, d.peds, PED_CODECS);
  writeTable(w, d.props, PROP_CODECS);
  writeTable(w, d.pickups, PICKUP_CODECS);
}

function readDelta(r: Reader): SnapshotDelta {
  return {
    players: readTable(r, PLAYER_CODECS),
    vehicles: readTable(r, VEHICLE_CODECS),
    cops: readTable(r, COP_CODECS),
    peds: readTable(r, PED_CODECS),
    props: readTable(r, PROP_CODECS),
    pickups: readTable(r, PICKUP_CODECS),
  };
}

function writeIntent(w: Writer, i: InputIntent): void {
  w.big(i.seq);
  w.big(i.tick);
  const bits =
    (i.up ? 1 : 0) |
    (i.down ? 2 : 0) |
    (i.left ? 4 : 0) |
    (i.right ? 8 : 0) |
    (i.fire ? 16 : 0) |
    (i.action ? 32 : 0);
  w.u8(bits);
  w.q256(i.aimAngle);
  w.int(i.slot);
}

function readIntent(r: Reader): InputIntent {
  const seq = r.big();
  const tick = r.big();
  const bits = r.u8();
  return {
    seq,
    tick,
    up: (bits & 1) !== 0,
    down: (bits & 2) !== 0,
    left: (bits & 4) !== 0,
    right: (bits & 8) !== 0,
    fire: (bits & 16) !== 0,
    action: (bits & 32) !== 0,
    aimAngle: r.q256(),
    slot: r.int(),
  };
}

// ------------------------------------------------------------------ codec

export const binaryCodec: Codec = {
  encode(msg: WireMessage): string | Uint8Array {
    const w = new Writer();
    switch (msg.type) {
      case 'snapshot': {
        w.u8(TAG_SNAPSHOT);
        w.big(msg.tick);
        // Base is always at or before tick, so the gap is a small unsigned.
        w.big(msg.tick - msg.baseTick);
        w.big(msg.ackSeq);
        if (msg.hash === undefined) {
          w.u8(0);
        } else {
          w.u8(1);
          w.u32(msg.hash);
        }
        writeDelta(w, msg.delta);
        return w.bytes();
      }
      case 'full': {
        w.u8(TAG_FULL);
        writeSnapshot(w, msg.snapshot);
        return w.bytes();
      }
      case 'input': {
        w.u8(TAG_INPUT);
        w.int(msg.ackTick);
        w.uint(msg.intents.length);
        for (const i of msg.intents) writeIntent(w, i);
        return w.bytes();
      }
      default: {
        // Rare, structurally complex messages stay JSON behind the tag byte.
        const json = utf8Encode(JSON.stringify(msg));
        const out = new Uint8Array(json.length + 1);
        out[0] = TAG_JSON;
        for (let i = 0; i < json.length; i++) out[i + 1] = json[i] as number;
        return out;
      }
    }
  },

  decode(data: string | Uint8Array): unknown {
    if (typeof data === 'string') {
      // Tolerated so a JSON-speaking peer still works during a rollout.
      return JSON.parse(data) as unknown;
    }
    const tag = data[0];
    const body = data.subarray(1);
    switch (tag) {
      case TAG_JSON:
        return JSON.parse(utf8Decode(body, 0, body.length)) as unknown;
      case TAG_SNAPSHOT: {
        const r = new Reader(body);
        const tick = r.big();
        const baseTick = tick - r.big();
        const ackSeq = r.big();
        const hasHash = r.u8() === 1;
        const hash = hasHash ? r.u32() : undefined;
        const delta = readDelta(r);
        const msg: Record<string, unknown> = { type: 'snapshot', tick, baseTick, ackSeq, delta };
        if (hash !== undefined) msg['hash'] = hash;
        return msg;
      }
      case TAG_FULL: {
        const r = new Reader(body);
        const snapshot = readSnapshot(r);
        return { type: 'full', tick: snapshot.tick, snapshot };
      }
      case TAG_INPUT: {
        const r = new Reader(body);
        const ackTick = r.int();
        const n = r.uint();
        const intents: InputIntent[] = [];
        for (let i = 0; i < n; i++) intents.push(readIntent(r));
        return { type: 'input', ackTick, intents };
      }
      default:
        throw new Error(`binaryCodec: unknown frame tag ${String(tag)}`);
    }
  },
};
