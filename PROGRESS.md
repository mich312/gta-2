# PROGRESS

## Phase 7 — pedestrian crowds + interest management

**What changed.** 200 pedestrians per session: sim entities that wander
sidewalks (weighted direction picks that prefer staying on pavement), flee
gunfire, deaths, and speeding cars, and die to bullets and bumpers — killing
one is a crime. NPCs (peds AND cops) move on a staggered 3-tick cadence
(10 Hz with 3× steps — interpolation renders it smooth, sim cost and delta
traffic drop to a third). Interest management: per-client filtered
snapshots — players always included, driven cars ride along, parked cars/
cops/peds only within a 600 px radius — with the delta base being the
filtered snapshot that client acked (per-slot ring), so AOI enter/leave
falls out as ordinary add/remove rows and the client needed zero changes.
Positional events (shots) are radius-filtered too; kill-feed events stay
global. Getting under budget took real bandwidth work: quantizing sim
floats to exact-binary grids (pos/vel 1/8 px, angles 1/256 — 17-digit JSON
floats were the single biggest cost), integer tracer endpoints, dropping
`lastInputSeq` from diffs (remote clients never read it; own reconciliation
rides the message ackSeq), and an exact-binary heat-decay rate.

**Verification.** 63 tests green: ped wander determinism with zero
building-clips over 200 peds × 300 ticks, gunfire scatter, ped-kill heat,
AOI filter correctness (everything excluded is provably far), a moving
client staying hash-consistent through 600 ticks of AOI churn (500+ hashed
deltas, 0 desyncs), and stale-ack full-snapshot fallback. THE GATE: 8-bot
brawl with 200 peds + police swarm — 40-44 KB/s per client, under the
50 KB/s budget, 0 desyncs, lockstep (harness now fails any run over
50 KB/s, permanently). Quantization surfaced a genuine -0 bug (JSON writes
-0 as "0", hashes disagreed by a sign bit) — fixed at quantizer and hash.

**Deliberately deferred.** The binary codec — JSON now fits the budget with
headroom, so per the plan ("switch when profiling proves it") it stays JSON;
the Codec seam is ready when richer traffic (phase 8 props, more players)
needs it. Ped variety (one sprite), sidewalk crossing behavior at lights,
per-district ped density.

**Least confident about.** The 10 Hz NPC cadence under packet loss —
interpolation smooths steady streams; a hiccup drops NPC keyframes harder
than player ones. Brawl clusters bots (worst case for AOI); a pathological
all-eight-players-in-one-plaza scenario still fits budget by measurement,
but barely half of it is headroom. -0 taught me JSON round-tripping has
sharp edges; if another eigenvalue like NaN ever enters the sim it will
desync — sanitizeIntent guards the only external float inputs, but a sim
bug producing NaN would poison hashes silently.

## Phase 6 — police and wanted levels

**What changed.** Heat-based wanted system, entirely in the sim: violence
against players adds heat proportional to damage plus a kill bonus, car
theft adds a little, killing a cop adds a lot; `wantedLevel` = heat/100
clamped to 1–5. Heat decays only while NO cop has line of sight — hide to
cool off; heat survives death by design (dying is not a laundering
mechanic). Cops are sim entities that spawn deterministically from the
kerbside spawn list in a ring around the fugitive (one per tick, ramping to
2 per star, capped per player and globally), pursue with greedy steering —
axis-separated wall-slide plus an rng sidestep when wedged, which the road
grid makes look smarter than it is — and fire only with LOS inside range.
Players can shoot back: cops have health and drop, at a price. All numbers
in `police.json`. Cop shots/`copDown` are events; clients render cops
(sprite, interpolated), tracers, and wanted stars.

**Verification.** 56 tests green: crimes raise heat (violence, theft),
decay-while-hidden to zero, level-3 chase (posse spawns within 10 s,
converges inside firing range, draws blood — the "tense at level 3" gate as
a machine-checkable proxy: pressure arrives fast, from multiple directions,
and standing still is lethal), cop-killing raises heat, and the entire
chase hashing identically across runs. 8-bot brawl with live police: PASS,
lockstep, 0 desyncs; kill counts now include deaths-by-cop. Replay with the
full police sim re-simulates hash-identical.

**Deliberately deferred.** Cop cars and roadblocks (on-foot posse only —
level 4/5 currently just means *more* cops; vehicle police would be the
next escalation). Pathfinding beyond greedy wall-slide (cops can be juked
around building corners — arguably a feature; BFS on road tiles is the
planned upgrade if chases feel dumb). Wanted-level UI beyond stars.

**Least confident about.** "Genuinely tense" is a human judgment — the
machine proxy (fast convergence + real damage) is necessary but not
sufficient; tune copsPerStar/moveSpeed/copPistol damage after a real chase.
Greedy pursuit can wedge cops on concave building clusters (the sidestep
frees most cases; some pace circles remain). Cop entity + shot-event
bandwidth tripled brawl traffic — phase 7's interest management is now
load-bearing for two reasons.

## Phase 5 — economy, shops, accounts, persistence

**What changed.** The economy lives entirely server-side behind one seam:
`Economy` validates everything (the server is the cashier) and its only
write-path into the sim is the SimCommands it returns (`grantWeapon`,
`setCosmetic`), which the session queues and records like inputs. Cash is an
append-only ledger — no balance column anywhere; balance is a fold over
transactions, every entry carries a reason and a unique idempotency ref
(duplicate refs are rejected, so retried writes can't double-apply, and
"where did this cash come from" is one query). Persistence sits behind a
`PersistenceStore` interface: the JSON `FileStore` (atomic tmp+rename
writes) is the verified implementation in this environment; the reviewed
MySQL schema is in `server/mysql/schema.sql` — see the open questions at the
end of this file. Purchases: `buy` is a request message; the server checks
alive/on-foot, doorway proximity to the right shop kind, price from its own
catalog, and balance. Awards: kills pay with per-victim diminishing returns
inside a time window, driving pays only *novel* road cells at speed, both
under per-minute caps — all numbers in `economy.json`. No player-to-player
transfers exist, killing the entire duping/muling class. Accounts are
optional (guests always play, session-scoped wallets): username+password
with scrypt from node:crypto; cosmetics persist per account and re-equip on
login via a command. Client: wallet + shop panel (stand in a doorway,
Y/U/I/O to buy), L/K prompt-based login/register.

**Verification.** 50 tests green: ledger idempotency + overdraw rejection,
scrypt account verify (case-insensitive uniqueness, wrong-password fail),
kill-award decay/window-reset/rate caps, novel-cell driving pay,
doorway/shop-kind/balance purchase validation, and the phase gate —
cash, transactions, cosmetics, and idempotency surviving a store reload.
Full-stack `persistCheck` over the real wire: register → kill server →
fresh process on the same store → login → wallet identical and starting
cash seeded exactly once. Kill awards ran live during the brawl runs.

**Deliberately deferred.** MySQL driver integration (no MySQL server in
this environment + driver is a new dependency needing approval — the store
interface and schema are ready; see end-of-run questions). Weapon unlocks
as account inventory — per the death-costs-guns design, weapons are
repurchased, only cosmetics + cash persist. A real login UI (window.prompt
is a placeholder). Shop stock limits.

**Least confident about.** Award tuning (does $100/kill vs $250/pistol feel
right?) is untested by humans. Guest wallets route to a pure-memory ledger
(the persist file only ever holds account rows), but a guest's cash
silently evaporating on session end may need messaging in the UI.
prompt()-based login blocks the render loop while open.

## Phase 4 — weapons, damage, death, respawn, kill feed

**What changed.** Hitscan weapons (pistol/smg/shotgun in `weapons.json`):
tile-DDA wall ray + analytic ray-circle target tests, nearest hit wins,
spread rolled from the sim PRNG (server-side weapons pass only — prediction
never touches the rng). Health/damage/death in the sim: dying drops you out
of any car, freezes the corpse, clears weapons, stamps `respawnAtTick`.
Respawning is a server-issued `respawnPlayer` command 3 s after the death
event — which is exactly where the `WEAPONS_LOST_ON_DEATH` flag (default
true) lives: it only decides the loadout the command carries (fresh pistol
vs. weapons at death), so the sim stays flag-free and both settings replay
deterministically. `step()` now emits deterministic SimEvents (shot/kill/
death) via an out-param; the server relays them; the client shows a kill
feed, tracers, health/ammo HUD, and a wasted-screen countdown. Run-over
damage for fast cars with a short immunity window. Weapon switching added as
a `slot` field on the input intent (keys 1-8) — still an intent, but it is
a deliberate extension of the brief's fixed field list, flagged here.
Brawl bot script: chase nearest living player, strafe, shoot.

**Verification.** 44 tests green: hitscan damage/cooldown/ammo/kill/loot-
clear/respawn lifecycle, walls actually block shots, bit-identical combat
determinism (same fight twice), run-over damage. 8-bot brawl 60 s: 21 kills,
every bot died and respawned, 0 desyncs, corrections back to ≤4.33 px once
respawn teleports were correctly excluded from the correction metric (they
are legitimate teleports, not prediction error — that fix is in the
predictor, found by the harness tripping on 2000 px "corrections").
**10-minute unattended 8-bot brawl: PASS — 18010 ticks, 135 kills, every
bot died 14–20 times and respawned, tick spread ≤1, 0 desyncs, corrections
≤10.3 px, no crash.**

**Deliberately deferred.** Drive-by shooting (fire is on-foot only).
Vehicle damage/destruction. Weapon pickups/drops on the ground (decided
against in plan — dupe/grief surface). Damage directionality/knockback.

**Least confident about.** Balance numbers (damage/cooldown/spread) are
untested by humans. The kill feed names use snapshot lookup at event time —
a player who disconnects the same tick renders as #id. Shot events are
broadcast unfiltered; at 8 players this is noise, but phase 7's interest
management must filter events too, not just entity deltas.

## Phase 3 — vehicles

**What changed.** Vehicles are sim entities: signed forward speed along a
heading, steering authority that grows with speed (reversing inverts it),
hard friction when coasting, wall crashes damp and slightly rebound speed —
arcade, not rigid-body, all tunables in `vehicles.json`. 48 parked cars
spawn per session from the map's kerbside spawn list (as recorded commands,
so replays reproduce them). Enter/exit is an edge-triggered `action` intent
resolved in the sim: nearest free near-stationary car within radius; a
contested door on the same tick resolves by player id; exit tries left/right/
rear spots and refuses if boxed in. Car-vs-car contact is a simple stop-on-
overlap (server-side only). Snapshots/deltas/hashes generalized over both
entity tables. The predictor now predicts the driven car (same shared
physics), while enter/exit and car-vs-car remain deliberately unpredicted —
server-granted, corrections smoothed. Client interpolates and renders
vehicles; joyride bots seek, steal, and drive cars.

**Verification.** 39 tests green: enter/drive/exit lifecycle, edge-trigger
(holding action doesn't re-trigger), contested same-tick entry with range
gating, wall crash on a synthetic arena (speed >200 px/s, damped on impact,
never penetrates, never passes the wall), and bit-exact driving prediction
(zero correction over 150 ticks of throttle+steering). 8-bot joyride 60 s:
lockstep 1809..1809, 0 desyncs, 4 bots stole and drove cars, corrections
18–22 px only from deliberately-unpredicted transitions (limit 96). Replay
still hash-identical twice.

**Deliberately deferred.** Run-over damage and drive-by fire (phase 4).
Vehicle health/destruction (phase 8 decides if cars burn). Car-vs-car
momentum transfer — stop-on-overlap is deliberately crude; revisit only if
play feels bad. Bots don't pathfind around buildings to reach cars (half of
them nose into walls; harmless for verification purposes).

**Least confident about.** Whether driving "feels weighty" — the numbers
(330 px/s top speed ≈ 20 tiles/s, speed-scaled steering) are reasoned, not
felt; they're one JSON edit away from retuning once a human drives.
Correction magnitude during contested entries under real latency (60 ms
round trip) — bots on localhost show ~20 px; worth watching the ghost when
first played over a real link.

## Phase 2 — procedural city, collision, camera, pixel-art pipeline

**What changed.** `shared/src/world/` generates the whole city as a pure
function of (seed, params): district Voronoi seeds → jittered arterial grid →
recursive block subdivision with district-sized targets → per-district block
fill (downtown packs solid, residential rows with yards, industrial slabs on
open lots, parks stay green) → shops with sidewalk doorway zones (quota'd:
gun shops prefer industrial/commercial, clothing prefers commercial/downtown)
→ parked-car spawn points → spread-apart player spawns. 240×240 tiles at
16 px (3840² px world), generated in ~30 ms. Movement now collides with
building tiles via axis-separated AABB sweeps, sub-stepped ≤ half a tile so
fast movers can't tunnel (a real bug the test caught before vehicles made it
matter). The map threads through `step()` and the predictor; the server ships
its parsed tuning + worldgen params in the welcome message so a server-side
JSON tune can never desync client generation, and replay headers embed both,
making replays self-contained. `pnpm mapgen --seed=N` renders a city PNG
(hand-rolled encoder over node:zlib); `pnpm sprites` emits the placeholder
sprite sheet from palette + shape descriptors; the client draws the tile
world, sprites rotated at draw time, integer-scaled camera clamped to the
city.

**Verification.** 35 tests green: worldgen purity (bit-identical tiles for
same seed), density/district/quota/spawn invariants across seeds, doorways
walkable, collision escape-proofing (600 ticks of input mashing never ends
inside a wall), flush clamping. Rendered seeds 7/8/9 to PNG and eyeballed:
three clearly different cities (different downtown placement, park spread,
block texture). 8-bot 60 s run over the real city: lockstep 1810..1810,
0 desyncs, corrections still exactly one held tick (4.33 px) — collision is
bit-exact in prediction. Fresh replay re-simulates to identical hashes.

**Deliberately deferred.** Explicit road graph (nodes/edges) — police/ped AI
will pathfind on the road tile grid directly (BFS), which is the boring
version; a graph can be derived later if profiling demands it. Crosswalks,
lane markings beyond a sparse dot texture, building interiors (per brief:
none, shops are doorway zones). District-specific palettes beyond building
colors.

**Least confident about.** District *feel* at street level — the aerial PNGs
read distinct, but on-foot distinctiveness (building height cues, prop
density) is thin until props (phase 8) and peds (phase 7) arrive. Residential
blocks lean sparse; worldgen.json numbers are all tunable without a rebuild
if the density feels wrong in play.

## Phase 1 — prediction, reconciliation, interpolation

**What changed.** The server now consumes exactly one input intent per tick,
in seq order (with a 6-tick bounded hold for gaps and a fast-forward drain
for bursts) — the contract reconciliation needs. Extracted
`stepPlayerMovement()` so one function moves a player on the server, in the
client predictor, and in bots. Added `Predictor` to shared/: applies local
inputs instantly (zero input lag), and on every snapshot rewinds to the
authoritative player and replays unacked inputs; it tracks correction
magnitude, which the overlay shows as ghost drift. The browser client renders
the local player from the predictor and remote players through a new
~100 ms (3-tick) interpolation buffer with a servo'd render clock — no
snapping, no extrapolation. Bots now run the identical Predictor and the
harness fails if any correction exceeds 32 px.

**Verification.** 29 tests green, including an in-process client/server
prediction test proving zero correction when each input is applied exactly
once, and convergence (corrections return to zero, no accumulated drift)
after a deliberately dropped input. 8-bot 60 s run: lockstep ticks
1807..1807, 0 desyncs, max correction 4.33 px — exactly one tick of walk
speed, the expected transient when setInterval jitter makes the server hold
an input for one tick; it does not accumulate.

**Deliberately deferred.** Smoothing of reconciliation corrections (currently
applied instantly — at 4 px it's invisible; revisit when vehicles raise
speeds). Input redundancy (sending last N intents per message) — TCP
WebSockets don't drop, only delay, so holds are rare and bounded.

**Least confident about.** The "two tabs feel" criterion is verified by
proxy (bots + math) since this environment has no browser windows;
interpolation smoothness under real frame-rate jank is untested. The render
clock servo (5% pull toward target delay) is a guess that may need tuning on
a real 60 ms connection.

## Phase 0 — workspace, sim skeleton, transport, bots, overlay, replay

**What changed.** Built the entire phase-0 skeleton from an empty repo: pnpm
workspace (`shared`/`server`/`client`), the deterministic sim core in
`shared/` (fixed 30 Hz `step()`, seeded mulberry32 PRNG stored in GameState,
sorted-id entity tables, deterministic polynomial sin/cos/atan2 so no engine
transcendentals ever touch the sim), the full wire protocol behind the
`Codec` interface (JSON now), delta snapshots against per-client acked ticks
with a 3 s ring and full-resync fallback, periodic FNV state hashes in
snapshots as the desync tripwire, the authoritative server (drift-corrected
tick loop, join/resume with per-session tokens, input sanitation at the trust
boundary), record/replay (every session records; the replay runner re-sims
and hash-verifies), the bot harness, and a minimal browser client (fixed
480×270 integer-scaled canvas, keyboard/mouse intents, `~` overlay with tick
rate, RTT, entities, KB/s, hitboxes, and the predicted-vs-authoritative ghost
slot). Sim tunables live in `shared/data/player.json`, loaded by each host
and injected via `initTuning()`. The `WEAPONS_LOST_ON_DEATH` env flag is
parsed in server config, ready for phase 4/5.

**Verification.** `pnpm test`: 27 tests green across shared+server, including
step determinism (same seed+inputs ⇒ identical hash), delta round-trip
equality, trust-boundary rejection tests, and a pinned PRNG known-answer
sequence. `pnpm bots --count=8 --script=cruise --duration=60`: all 8 bots
finished at the identical tick (1808..1808), 8 entities each, 0 desyncs,
0 stale deltas, 0 full resyncs; a 20 s `jitter` chaos run also passed. The
recorded replay of the live 8-bot session re-simulated twice to the same
final hash (`8fbba894`). Client typechecks and `vite build` passes.

**Deliberately deferred.** Prediction/reconciliation and interpolation
(phase 1) — the client renders raw snapshots, so remote motion quantizes to
snapshot arrival for now and the overlay ghost is trivially zero. The server
applies the newest queued intent per tick (input hold); phase 1 changes
consumption to one-intent-per-tick by seq for reconciliation. Snapshot
deltas diff whole fields (a moving player resends pos+vel every tick) — fine
under JSON, revisit with the binary codec or interest management. Deviations
from the PLAN file list: added `shared/src/net/sync.ts` (snapshot reassembly
shared by client and bots), `shared/src/net/hash.ts`, `shared/src/tuning.ts`,
and `server/src/tuning.ts` (fs loader); per-phase entity tables
(vehicles/peds/props) will be added to GameState in their phases rather than
sitting empty now.

**Least confident about.** (1) Wall-clock input timing: bots and client send
intents on their own setInterval/rAF clocks and the server applies "latest
wins" — good enough for lockstep verification, but phase 1's
tick-aligned input scheduling is where real timing bugs will surface, and
the current smoothness is not evidence they don't exist. (2) The resume path
is tested at the session level but not end-to-end under a real mid-game
socket drop with a stale ack ring. (3) Bandwidth (~29 KB/s per client with 8
players under JSON) is fine now but the JSON+full-field-diff combination has
no headroom for phase 7's pedestrians — the interest-management milestone is
carrying real load.
