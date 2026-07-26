# PLAN — top-down multiplayer city sandbox

This is the phase-0 plan for review. No code exists yet. Nothing below gets
built until this document is approved.

---

## 1. Architecture decisions (questions resolved in review)

**Q1 — Session topology: RESOLVED — one process = one 4–8 player session.**
Simpler tick loop, simpler bot harness, no room id in the wire protocol. A
room manager can wrap the session object later; the cost of deferring is one
refactor of `server/src/index.ts`, not the protocol.

**Q2 — Reconnect policy: RESOLVED — resume enabled.** The `welcome` message
includes a `resumeToken` (random server-generated secret, valid for this
session only); presenting it within a 120 s grace window re-binds the
connection to the existing player entity.

*Identity model (clarified in review):* joining is guest-first — the join
message carries only a display name, no login of any kind. The `resumeToken`
is not an account credential; it's a per-session secret that dies with the
session. Accounts arrive in phase 5 and a bare username field is **not**
enough there — anyone could type someone else's name and claim their cash and
cosmetics. Plan of record for phase 5: username + password, hashed with
`scrypt` from `node:crypto` (built in, no new dependency), still strictly
optional per the brief — guests always play. If you'd prefer a different
scheme (e.g. generated secret key instead of passwords), flag it before
phase 5; nothing before then depends on it.

**Q3 — Mid-session purchases: RESOLVED — apply immediately** via the
server-side **sim command queue**: the economy layer emits
`{tick, playerId, grantWeapon}` commands that the sim consumes at a tick
boundary, exactly like player inputs.

*What "currency stays outside the sim" means, concretely:* `GameState` — the
object that ticks at 30 Hz, gets predicted on the client, and must be
bit-identical everywhere — contains **no cash field anywhere**. Money exists
only in the server's ledger. When you buy a gun, the economy code (plain
non-deterministic server code) checks the ledger, appends a debit
transaction, and then drops a `grantWeapon` command into the next tick's
command queue. The sim sees a weapon appear; it never sees, reads, or
computes money. The two systems touch at exactly one seam — the command
queue — and because commands are tick-stamped and recorded in replay files,
replays reproduce perfectly even though the economy that emitted them is not
deterministic. This is what keeps a phase-6 desync hunt from ever having to
look at purchase code, and vice versa.

**Weapons on death: lost by default, switchable via env flag.**
`WEAPONS_LOST_ON_DEATH` (default `true`) in `server/src/config.ts`. Rationale
for the default: money is the spine of the loop, gun shops need repeat
customers, and death-as-cash-sink is what makes surviving a level-3 chase
worth something. Cosmetics and cash always persist regardless of the flag.
Implementation note: the flag never touches sim code — death clears the
entity, and it's the server's respawn `SimCommand` that either re-grants the
previous loadout (flag off) or grants the bare default (flag on). Since spawn
commands are recorded in replays, both settings stay fully deterministic to
replay. No weapon drops on the ground initially (loot piles are a
griefing/duping surface we don't need yet).

---

## 2. Workspace layout — every file created in phase 0

pnpm workspace, three packages. All sim logic in `shared/` (zero DOM, zero
Node imports — enforced by its tsconfig having no `dom`/`node` lib/types).

```
/
├── package.json               # workspace root; scripts: dev, test, bots, (mapgen in ph2)
├── pnpm-workspace.yaml
├── tsconfig.base.json         # strict, shared compiler options
├── vitest.workspace.ts
├── .gitignore
├── PLAN.md                    # this file
├── PROGRESS.md                # per-phase log, appended each phase
│
├── shared/
│   ├── package.json
│   ├── tsconfig.json          # lib: ["ES2022"] only — no dom, no node types
│   ├── data/
│   │   └── player.json        # walk speed, accel — tunables as JSON from day one
│   ├── src/
│   │   ├── index.ts           # public re-exports
│   │   ├── constants.ts       # TICK_RATE=30, TICK_MS, PROTOCOL_VERSION
│   │   ├── math/vec.ts        # Vec2 ops (pure, allocation-light)
│   │   ├── math/trig.ts       # deterministic sin/cos/atan2 (table+lerp) — see §5
│   │   ├── rng/prng.ts        # mulberry32-style seeded PRNG; state is a number
│   │   ├── sim/state.ts       # GameState types + createGameState(seed)
│   │   ├── sim/entities.ts    # sorted-id entity table (deterministic iteration)
│   │   ├── sim/input.ts       # InputIntent type, sanitize/clamp
│   │   ├── sim/player.ts      # on-foot movement system (placeholder walk in ph0)
│   │   ├── sim/step.ts        # step(state, inputsByPlayer, commands) -> state
│   │   ├── net/messages.ts    # every wire type — see §3
│   │   ├── net/codec.ts       # Codec interface + JsonCodec (the one swap point)
│   │   ├── net/snapshot.ts    # full snapshot + delta encode/apply
│   │   └── replay/format.ts   # replay file format: {seed, ticks: inputs+commands}
│   └── test/
│       ├── prng.test.ts       # known-answer sequence for a fixed seed
│       ├── step.test.ts       # same seed+inputs twice -> deep-equal states
│       ├── snapshot.test.ts   # apply(delta(a,b), a) === b
│       └── codec.test.ts      # round-trip every message type
│
├── server/
│   ├── package.json           # deps: ws (only)
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts           # entry: config -> session -> wsServer -> loop
│   │   ├── config.ts          # port, seed override, WEAPONS_LOST_ON_DEATH, from env/args
│   │   ├── loop.ts            # drift-corrected 30 Hz driver (accumulator, not naive setInterval)
│   │   ├── session.ts         # owns GameState; per tick: drain inputs -> step -> snapshot
│   │   ├── net/wsServer.ts    # ws lifecycle, join/handshake, resumeToken table
│   │   ├── net/client.ts      # per-connection: playerId, input queue, lastAckTick/Seq, bandwidth counters
│   │   ├── net/broadcast.ts   # per-client delta vs that client's last acked tick
│   │   ├── replay/record.ts   # append per-tick inputs+commands to .replay file
│   │   ├── replay/run.ts      # CLI: replay file -> headless re-sim -> per-tick state hash
│   │   ├── bots/harness.ts    # CLI: pnpm bots --count=8 --script=cruise
│   │   ├── bots/bot.ts        # headless client: ws + shared codec + ack loop
│   │   └── bots/scripts.ts    # input scripts: idle, cruise, circle, jitter
│   └── test/
│       └── session.test.ts    # inputs in -> authoritative state advances as sim says
│
└── client/
    ├── package.json           # deps: vite (dev) only
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.ts            # boot: connect -> fixed-tick input sampler -> render loop
        ├── net/connection.ts  # ws wrapper over shared codec, ping/pong RTT
        ├── net/sync.ts        # apply snapshots, track acks (prediction lands ph1)
        ├── input/keyboard.ts  # sample keyboard -> InputIntent per sim tick
        ├── render/canvas.ts   # fixed internal res, integer scale, imageSmoothing off
        ├── render/renderer.ts # draw state (colored rects in ph0; reads state, never writes)
        ├── debug/overlay.ts   # ~ toggle: tick, RTT, entities, KB/s up+down, hitboxes, prediction ghost
        └── debug/stats.ts     # rolling counters the overlay reads
```

Phase-1 additions (listed so the seams are visible now, not built in ph0):
`client/src/net/prediction.ts` (input buffer, rewind+replay),
`client/src/net/interpolation.ts` (~100 ms remote buffer). Phase-2 adds
`shared/src/world/*` (see §6), `server/src/tools/mapgen.ts` (PNG via
`node:zlib`, no new deps), `shared/data/palette.json`, and the sprite-sheet
generator script.

Bot harness and mapgen live in `server/` because they need Node; they import
everything real from `shared/`. Root scripts: `pnpm bots` and `pnpm mapgen`
filter into the server package. `pnpm dev` = `pnpm -r --parallel dev` (no
`concurrently` dependency).

Record/replay from day one: the server records `{seed, tickInputs[]}` for
every session; `replay/run.ts` re-simulates headlessly and prints a state hash
per N ticks. Two runs of the same file must hash identically — that's the
determinism regression test, and every future bug gets captured as one of
these files before it gets fixed.

---

## 3. Wire protocol — exact message types

All types live in `shared/src/net/messages.ts`. Everything crosses the wire
through `Codec`:

```ts
interface Codec {
  encode(msg: ClientMessage | ServerMessage): string | Uint8Array;
  decode(data: string | Uint8Array): ClientMessage | ServerMessage;
}
// JsonCodec now; a future BinaryCodec touches only codec.ts.
```

Client → server:

```ts
interface InputIntent {          // exactly the brief's shape
  seq: number;                   // monotonic per client, for reconciliation acks
  tick: number;                  // client's estimate of the sim tick it applies to
  up: boolean; down: boolean; left: boolean; right: boolean;
  fire: boolean;
  aimAngle: number;              // radians, clamped by sanitizeInput()
  action: boolean;               // context: enter/exit vehicle, buy, etc.
}

type ClientMessage =
  | { type: 'join'; protocol: number; name: string; resumeToken?: string }
  | { type: 'input'; ackTick: number; intents: InputIntent[] }
      // ackTick = last snapshot tick applied; intents batched (usually 1–2)
      // so acks piggyback on the input stream — no separate ack chatter
  | { type: 'ping'; t: number };
```

Server → client:

```ts
type ServerMessage =
  | { type: 'welcome';
      playerId: number; seed: number; tick: number; tickRate: number;
      resumeToken: string; snapshot: FullSnapshot }
  | { type: 'snapshot';
      tick: number;
      baseTick: number;          // the client-acked tick this delta is against
      ackSeq: number;            // last input seq folded into this state -> drives rewind+replay
      delta: SnapshotDelta;
      hash?: number }            // periodic state checksum in debug builds (desync tripwire)
  | { type: 'full'; tick: number; snapshot: FullSnapshot }
      // resync fallback: sent when a client's ack is too stale to delta against
  | { type: 'event'; tick: number; event: GameEvent }
      // discrete non-state facts: kill feed, purchase results, wanted-level stings.
      // Envelope defined now; first GameEvent variants arrive phase 4.
  | { type: 'pong'; t: number; serverTick: number }
  | { type: 'error'; code: string; message: string };

interface SnapshotDelta {
  added:   Entity[];             // full records for entities new since baseTick
  updated: EntityPatch[];        // id + only the fields that changed
  removed: number[];             // ids
}
```

Server keeps a ring buffer of the last ~2 s of snapshots per session and each
client's `ackTick`; deltas are computed against the acked tick, and a client
that falls out of the ring gets a `full`. Interest management (phase 7) plugs
in as a filter on which entities enter a given client's delta — the message
shape doesn't change.

---

## 4. Game state shape

```ts
// shared/src/sim/state.ts
interface GameState {
  tick: number;
  seed: number;
  rng: number;                   // PRNG state; advances ONLY inside step()
  nextEntityId: number;
  players:     EntityTable<PlayerState>;
  vehicles:    EntityTable<VehicleState>;   // empty until phase 3
  pedestrians: EntityTable<PedState>;       // empty until phase 7
  props:       EntityTable<PropState>;      // empty until phase 8
}

// Deterministic iteration is non-negotiable, so entities never live in a bare
// object/Map walked in insertion order:
interface EntityTable<T> { ids: number[] /* always sorted */; byId: Record<number, T>; }

interface PlayerState {
  id: number;
  pos: Vec2; vel: Vec2;
  aimAngle: number;
  mode: 'foot' | 'driving' | 'dead';
  health: number;
  vehicleId: number | null;
  // injected by the server at spawn / via sim commands — never client-set:
  weapons: WeaponSlot[]; activeWeapon: number;
  cosmeticId: number;
  wantedLevel: number;           // 0–5, phase 6
  respawnAtTick: number | null;
  lastInputSeq: number;          // echoed as ackSeq in snapshots
}
```

Deliberately **not** in `GameState`: cash, account inventory, unlocks,
resume tokens, sockets. Currency lives in the server-side ledger
(append-only transaction log, MySQL in phase 5, in-memory before that). The
only bridge between the two worlds is:

```ts
step(state: GameState,
     inputs: Record<playerId, InputIntent>,
     commands: SimCommand[]        // spawnPlayer(loadout), grantWeapon, despawn…
): GameState
```

`SimCommand`s are ordered, tick-stamped, and recorded in replays alongside
inputs — so replays stay deterministic even though the economy that emitted
the commands is not. World geometry is also not in `GameState`: it's derived
from `seed` on both sides (phase 2) and only collision-relevant, never
transmitted, never mutated (destructible props are entities, not map edits).

The world is a finite walled city on a tile grid (~240×240 tiles at 16 px);
movement is continuous floats over it, collision is tile AABBs plus
entity-vs-entity circles. Boring and robust.

---

## 5. Determinism enforcement (how, concretely)

- Fixed 30 Hz timestep everywhere; `dt` is a constant, never multiplied from
  frame time. Client runs the same `step()` for prediction.
- `prng.ts` is the only randomness; its state is a field of `GameState`, so
  it rewinds/replays with everything else. Known-answer test pins it.
- **No `Math.sin/cos/atan2/pow` in sim code** — transcendentals are not
  IEEE-pinned and genuinely differ across engines. `math/trig.ts` provides
  table-based versions; sim imports only those. `+ - * / sqrt` are IEEE-exact
  and fine.
- Entity iteration always via the sorted `ids` array.
- State hash (FNV over a canonical field walk) computed periodically; the
  debug overlay compares client-predicted vs server hash, and replays print it.

---

## 6. World generation (phase 2) — algorithm in pseudocode

Pure function in `shared/src/world/`, `generateCity(seed): CityMap`. Server
sends only the seed; client regenerates. One PRNG consumed in fixed order.

```
generateCity(seed):
  rng = prng(seed)
  grid = W×H tiles (240×240), all 'field'

  # 1. Road graph first — roads define everything else
  arterials: pick 3 vertical + 3 horizontal corridors at jittered offsets,
             width 4 tiles; carve into grid; record as graph edges
  secondary: recursively split each region between arterials with width-2
             roads until block extents fall inside the target range
             (targets vary by district, see step 2 — downtown splits small,
              industrial stays coarse)
  roadGraph = intersections (nodes) + segments (edges)   # kept: police &
              pedestrian AI path on this graph later, no free-space pathfinding

  # 2. Districts — coarse identity so the city doesn't read as uniform
  place district seeds: downtown (weighted center), industrial (edge),
        park (1–2), commercial strip, residential (fills rest)
  each block -> nearest seed (jittered manhattan voronoi)
  district controls: block size target, building style/height, palette accents,
        road width, shop probability, parked-car density, ped density (ph7)

  # 3. Blocks: flood-fill non-road regions bounded by roads
  # 4. Sidewalks: 1-tile ring inside each block edge; crosswalks at nodes
  # 5. Building footprints per block, by district:
       downtown:    pack the block nearly solid, 1–2 big footprints
       residential: rows of small houses with yard gaps
       industrial:  1–2 large slabs + open lot
       park:        no buildings; trees/paths (props later)
       commercial:  medium footprints, every one street-facing
     all footprints -> solid collision tiles
  # 6. Parking & vehicle spawns: sample road-edge tiles per district density
       -> list of {pos, heading, vehicleType} consumed by the server at ph3
  # 7. Shops: choose street-facing footprints until quotas met
       (≥2 gun, ≥2 clothing per city, spread across districts);
       mark 1-tile doorway zone on the sidewalk side
  # 8. Player spawns: sidewalk tiles, pairwise distance ≥ 30 tiles,
       never inside doorway/parking zones

  return { tiles, districts, roadGraph, buildings, shops,
           vehicleSpawns, playerSpawns }
```

`pnpm mapgen --seed=N` renders `tiles`+`districts` to PNG (hand-rolled PNG
writer over `node:zlib`, no new dependency) so generation quality is judged
without launching the game.

---

## 7. The three things most likely to bite us by phase 6

**1. Cross-engine float determinism, specifically transcendentals.**
Browser V8/JSC/SpiderMonkey and Node agree on IEEE `+ - * / sqrt` but *not*
on `Math.sin/cos/atan2`. The moment vehicle physics (phase 3) puts a
non-shared `cos` in a heading calculation, client prediction and server
diverge by 1e-16, which compounds through collision response into visible
ghost drift by phase 6 — and it'll look like a netcode bug, not a math bug.
Mitigation is §5: shared `trig.ts` from day one, replay hashing as the
regression alarm, and the overlay ghost watched after literally every change.

**2. Prediction against dynamic entities — worst case, contested car theft.**
Prediction (phase 1) is clean while the local player only collides with
static tiles. Phase 3 adds cars: two players race for the same door, both
predict success, one is wrong and gets warped; car-vs-car nudges make the
predicted car feel haunted. Plan: the client predicts only the local
player/vehicle against *static* geometry; dynamic entities don't block the
prediction (server resolves, correction is smoothed over a few frames); door
entry is server-granted via `action` intent — the client never predicts entry
itself, it plays a reach animation until the snapshot confirms. If phase 3
"feels laggy on entry", this seam is why, and we tune the animation, not the
authority model.

**3. The economy/sim boundary under mid-session mutation.**
The brief's "loadout read once at spawn" and "shops you walk into" pull
against each other (Q3). Without the `SimCommand` queue decided up front,
phase 5 will grow ad-hoc paths where purchase handlers reach into sim state
directly — and then currency is entangled with the deterministic sim, replays
stop reproducing, and the append-only ledger can drift from what the sim
granted. The command queue (tick-stamped, recorded in replays, the *only*
write-path into the sim from outside) is cheap in phase 0 and nearly impossible
to retrofit cleanly in phase 5.

Honorable mention: interest management (phase 7) trims **bandwidth**, not
**server CPU** — 200 pedestrians and police AI still simulate globally at
30 Hz. Keeping ped/police steps O(entity) with the road graph (no free-space
pathfinding) is what keeps the server on budget.

---

## 8. What phase 0 does *not* contain

No prediction, no interpolation, no world, no art pipeline, no economy — only
the skeleton the brief lists: workspace, shared sim with a placeholder walk,
30 Hz authoritative loop, JSON-over-ws transport behind the codec interface,
delta snapshots + acks, bot harness, debug overlay, record/replay. Done means:
8 bots connected for 60 s, ticking in lockstep, replay of that run hashes
identically twice, `pnpm test` green, PROGRESS.md written.
