# SHIP — from a prototype to a game people buy

Every backlog this repo has written for itself has been delivered. `ROADMAP.md`
waves A–E, `FEATURES.md` waves F–I, `GAPS.md` waves J–O, `GTA.md` waves P, R
and S — all built, all logged in `PROGRESS.md`. The systems are done.

The game is not.

This document is about that difference. It is not another feature backlog; it
is a production plan for the smaller of the two targets that were on the table
— not AAA, which is a financing problem wearing a technology costume, but the
premium-indie tier this codebase is genuinely within reach of: a paid,
single-purchase game, six to nine people, two to three years, that a stranger
buys on a store page and finishes.

---

## 0. What this document is not

- **It is not a case for AAA.** That was costed separately and declined. The
  short version is in §11: the gap to AAA is a $150M financing and a publisher,
  not an engineering plan, and everything in the first half of any credible AAA
  plan is identical to this document anyway.
- **It is not a rewrite.** Nothing here proposes throwing away `shared/`. The
  central finding (§3) is that the architecture already permits the biggest
  structural change on the list, at the cost of six small shims.
- **It is not a design document for the campaign.** T3 says a campaign must
  exist, says how long, says what verbs it draws on and what has to be built to
  author it. What actually happens in it is a designer's job and a different
  document.
- **It does not re-litigate the declines** in `GTA.md` §10, `GAPS.md` §7 or
  `ROADMAP.md` §6. Rotating camera, aim-relative movement and witness-gated
  heat stay dead.

---

## 1. Where we actually are

Measured, not remembered. Every figure below was read out of the repo.

### What is built

| | |
|---|---|
| Simulation | 16,385 lines in `shared/` — sim, worldgen, netcode, wire protocol. Zero DOM imports, zero Node imports. |
| Whole codebase | ~45,600 lines of TypeScript across three packages, 55 test files |
| Determinism | Every session records a replay; replays re-simulate to identical tick hashes or the build fails |
| Vehicles | 27 kinds, from `bicycle` to `tank`, each with a home somewhere in the world |
| Weapons | 16, including four cop-only and a car-mounted gun |
| Gangs | 7, with turf, respect, standing and gang-on-gang war |
| Missions | 7 verbs (hit, sweep, delivery, escape, race, bomb, escort) × 3 tiers, 12 templates, chains of 4–6 per employer |
| Police | 5 star levels, wave composition, officer memory, cool-down, helicopter, military at five |
| Economy | Append-only ledger, shops, resprays, fittings, crusher, hospitals, districts, scrypt accounts, SQLite or file persistence |
| City life | Traffic signals, horns, self-preserving drivers, peds who board cars, fire that spreads, day/night on a 24-minute clock, 100 hidden packages |
| Renderer | 6,155 lines of Canvas 2D — chunked tiles, extruded walls, cast shadows, two-composite lighting with bloom |
| Renderer cost | p99 **16.8 ms** at 2560×1440. A flat 60, with shadows and bloom on |
| Multiplayer | 4–8 players, prediction with rewind/replay reconciliation, binary codec, **~10.5 KB/s** per client against a 50 KB/s hard gate |
| Tuning | 18 JSON files, shipped to clients in the welcome message |
| Tooling | Bot harness, replay runner, map renderer, chase bench, sprite generator, persistence e2e |

That is a real engine with a real game inside it, and the verification culture
around it is better than most shipped products have.

### What does not exist at all

Also measured. These are greps that return nothing.

- **No title screen. No pause. No settings. No key rebinding.** `index.html` is
  a bare canvas; `main.ts` boots straight into play.
- **No gamepad support.** Zero references to `Gamepad` anywhere in `client/`.
- **No onboarding.** Zero references to `tutorial`, `hint`, `onboard` or
  `firstRun` in any package.
- **No offline mode.** The client's first act is to open a WebSocket. No
  server, no game.
- **No authored content of any kind.** The world is generated. The 57 sprite
  frames are generated from JSON shape descriptions. The audio is generated at
  runtime by WebAudio — `client/public/` contains exactly two files, a 178 KB
  PNG and its metadata, and **zero bytes of recorded sound**. There is no
  dialogue, no music, no hand-placed street, no authored mission.
- **No save file.** Progress is a server-side account row.
- **No localization, no accessibility options, no crash reporting, no
  telemetry, no store presence.**

### The honest ratio

The systems are something like ninety per cent done. The *product* is closer to
fifteen. Every remaining unit of work is in the second number, and almost none
of it looks like the work that got us here.

That is worth stating plainly because it inverts the instinct the last two
years of this repo have trained. The reflex — find the missing system, cost it,
build it, test it — is the wrong reflex now. There are no missing systems worth
having. What is missing is a shape, a surface, and a way to buy it.

---

## 2. The four gaps, and which one is fatal

**Gap 1 — the game has no shape.** It is a sandbox with radiant missions.
Payphone jobs are generated: seven verbs, procedurally targeted, chained four
to six deep per gang, and then they repeat forever. Nothing escalates across
the whole arc, nothing is authored, nothing is remembered. A player has no
reason to come back tomorrow and no moment to tell a friend about. **This is
the fatal gap.** Everything else in this document is polish applied to it, and
polish applied to a shapeless game produces a beautiful thing nobody finishes.

**Gap 2 — nothing is authored.** Procedural generation is this repo's best
trick and its ceiling in the same breath. A generated city has no corner you
learn, no shortcut you own, no building you point at. The premium-indie games
in this genre survive on handmade texture — the specific alley, the specific
song, the specific joke. 178 KB of art and zero bytes of audio is not a small
version of that; it is a different category of object.

**Gap 3 — it reads as a web toy.** Not because the rendering is bad — the
rendering is genuinely good, and 60 fps at 1440p with cast shadows is better
than it has any right to be. It reads as a toy because there is no title
screen, no pause, no settings, no controller, and a canvas that starts playing
the moment it loads. The first fifteen seconds tell a buyer what category of
thing they have bought, and right now they say "browser demo."

**Gap 4 — it is a server game with no server business.** Multiplayer as built
needs a host, and a premium single-purchase game cannot fund a persistent shard
against a one-time $20. This has to be decided rather than drifted into.

**The decision: single-player first, offline-capable, with co-op retained.**
The campaign is the product. Multiplayer becomes session-based — you host, your
friends join, the world is yours and it ends when you close it. That preserves
every line of netcode already written (it is the same protocol, the same
prediction, the same authority model) while removing the operating cost and the
design contortions. `missions.ts` currently spends a paragraph explaining that
"both originals were single-player, so a mission could assume the world was
yours" and then races two players for the same target. Under this decision that
contortion becomes a co-op affordance rather than the default case.

---

## 3. The keystone: the game already runs on one machine

This is the finding that shapes the whole plan, and it was not obvious until
the imports were counted.

**The entire game-logic layer of the server imports nothing from Node.**

Verified by `grep -L "node:"` across `server/src/`:

```
server/src/session.ts          server/src/economy/jobs.ts
server/src/loop.ts             server/src/economy/awards.ts
server/src/missions/missions.ts server/src/economy/districts.ts
server/src/net/broadcast.ts    server/src/economy/ledger.ts
server/src/net/client.ts       server/src/provingGround.ts
```

The session driver, the tick loop, the whole mission runner, the ledger, jobs,
awards, districts, interest management and the per-client broadcast filter are
all portable code that happens to live in the server package. `shared/` was
already required to be host-agnostic; it turns out `server/` mostly is too,
without anyone having set out to make it so.

The Node coupling is exactly six seams, and every one of them is small:

| Seam | File | What it needs |
|---|---|---|
| Tuning load | `tuning.ts` | `readFileSync` → bundled import or `fetch` |
| Replay writer | `replay/record.ts` | fs stream → in-memory buffer, downloadable |
| Transaction ids | `economy/economy.ts` | `randomUUID` → `crypto.randomUUID` (identical API in browsers) |
| Password hashing | `economy/accounts.ts` | `scryptSync` → WebCrypto PBKDF2, or dropped entirely offline |
| Config | `config.ts` | env vars → a settings object |
| Persistence | `store.ts`, `createStore.ts`, `sqliteStore.ts` | already behind a `PersistenceStore` interface, and `MemoryStore` already implements it. Add an IndexedDB or file implementation. |
| Transport | `net/wsServer.ts` | `ws` → a `MessagePort` to a worker |

Seven rows, six of them one-file changes, and the last one is a store
implementation against an interface whose author already wrote in the comments
that "swapping the file store for MySQL means writing one new implementation."

**What that buys.** Run the session in a Web Worker. The client talks to it
over a `MessagePort` using the same protocol it sends over the wire today. No
server process, no hosting, no network. Then the same build, pointed at a real
`ws://` instead of a port, is the co-op host — one code path, two transports.

This is why the plan below is achievable by six people and not sixteen. The
most structurally frightening item on any "make it a real game" list —
*decouple from the server* — is a fortnight, because the architecture was built
right two years ago by people who were disciplined about imports.

### §3a — This has now been built, and it works

The claim above was a paper argument when it was written. It has since been
spiked: `?local=1` runs the whole game in a Web Worker with nothing listening
on 8080. `evidence/offline-host.png` is the screenshot; `pnpm parity` is the
gate.

What it took, against the estimate:

| Predicted | Actual |
|---|---|
| Six seams | Seven. `ledger.ts` imported `PersistenceStore` from `store.js` — a *type-only* import that dragged `node:fs` into the graph. Found by the boundary test, not by reading. |
| `randomUUID` → `crypto.randomUUID` | Exactly that, one file |
| Persistence | `MemoryStore` moved to its own module; `store.ts` re-exports, so no caller changed |
| scrypt | Extracted behind a `PasswordCrypto` interface. The server passes the same scrypt; offline passes nothing and accounts decline, which is the design |
| Tuning load | Free — `vite.config.ts` already aliased `shared/data/*` |
| Transport | `GameHost` (transport-free) + `Conn`; `wsServer.ts` went from 419 lines to 89 |

Three findings worth carrying into the real item:

1. **The boundary needs a walked graph, not a list.** `server/test/portable.test.ts`
   walks every import reachable from `host.ts`. A hand-maintained list would
   have passed while `ledger.ts` was quietly pulling in the filesystem — the
   failure mode is silent and it had already happened.
2. **Determinism holds across hosts, and it is cheap to prove.** Four seeds ×
   1800 ticks, hashes sampled every 30 — Node and Chromium agree exactly.
   `pnpm parity` is a minute and belongs in CI from the first commit of the
   real item.
3. **The worker was the right call for the reason predicted.** 60 fps, p50
   frame 16.7 ms, sustained 30.01 Hz on the sim thread, `desyncs 0`, `ghost
   drift 0.00px`. Prediction and reconciliation needed no changes at all.

What the spike does **not** do, and the real item must: an IndexedDB store (it
uses `MemoryStore`, so the wallet dies with the tab), an in-memory replay
recorder, and moving the portable layer into its own package instead of
reaching into `server/src` through a bundler alias.

---

## 4. The constraints every item obeys

All the invariants in `ROADMAP.md` §0 hold in full and are not restated. Four
of them do most of the work here, and this document adds three more.

**Inherited, and load-bearing:**

- **`step()` stays bit-identical everywhere.** Nothing in this plan may make
  the simulation host-dependent. A worker and a Node process must produce the
  same hashes from the same inputs, and the replay corpus is how we know.
- **`shared/` imports nothing from Node or the DOM.** The rule that made §3
  possible. It now applies to the portable half of `server/` as well (see new
  constraint 1).
- **Every gameplay number is a tunable in `shared/data/*.json`**, and adding a
  key to the welcome payload bumps `PROTOCOL_VERSION` (currently 8).
- **The 50 KB/s per-client gate is a hard gate**, enforced by the bot harness.
  It stays, because co-op still crosses a network.

**New, for this phase:**

1. **The portable server stays portable.** The ten files listed in §3 must
   never acquire a Node import. This wants a lint rule, not a convention — it
   is now load-bearing for the product, not just for tidiness.

2. **Authored content must survive regeneration.** The moment a human edits the
   world, the generator stops being the source of truth and becomes a tool that
   produces a starting point. Every authored artefact — map edits, mission
   placements, named locations — lives in a file that a regeneration merges
   into rather than overwrites. Getting this wrong once costs a district.

3. **Determinism is now a shipping feature, not an internal one.** Replays
   become bug reports players can attach, speedrun verification, and — if the
   AAA fork is ever taken — the differential oracle for a native port. It is
   the most valuable property this codebase has and nothing may weaken it for
   convenience.

---

## 5. Wave map

Four waves, deliberately unequal. Wave T is the game; the rest is the product
around it.

| Wave | What it is | Size | Risk |
|---|---|---|---|
| **T** | One machine, and a game with a shape | L | High (design) |
| **U** | A city, not a generator | L | Medium |
| **V** | It looks and sounds bought | L | Medium-high |
| **W** | It ships | M | Low, but non-negotiable |

They are not strictly sequential — U2 (heights) wants to land early because
every screenshot from the day it lands is better, and W3 (telemetry) is
worthless unless it precedes the first playtest. §9 gives the actual ordering.

---

# Wave T — one machine, and a game with a shape

## T1 — The in-process host (M, medium risk)

Make the game run with no server.

Move the session into a Web Worker. Implement the seven seams from §3. Keep
the protocol byte-identical: the worker speaks the same `welcome`, `snapshot`,
`mission` and `SimCommand` messages over a `MessagePort` that the server speaks
over `ws`, and the client cannot tell which it is talking to behind a
`Transport` interface with two implementations.

**Why a worker and not the main thread.** Two reasons, and the second is the
real one. The obvious reason is that a 30 Hz simulation sharing a thread with a
60 Hz renderer will produce tick jitter under render load. The better reason is
that a worker enforces the boundary: if the session can only be reached by
message-passing, nobody can accidentally reach into sim state from the
renderer, and the discipline that made §3 possible is preserved by the compiler
rather than by review.

**Persistence.** A new `PersistenceStore` implementation over IndexedDB in the
browser, and over the filesystem in the desktop build (W1). `MemoryStore`
already exists and already passes the store tests, so the test surface is
written.

**Accounts.** Offline, there is no account. The ledger keys off a local
profile id. Scrypt stays in the co-op host path, where it is still guarding
something.

**Verification.** The existing replay corpus is the gate: every recorded replay
must re-simulate to identical hashes under the worker host. If it does not, the
port is wrong, and we will know precisely which tick it went wrong on. This is
the single best example of the §4 constraint 3 dividend.

**What it costs on the wire:** nothing. It removes a wire.

## T2 — The front end (M, low risk)

The fifteen seconds that tell a buyer what they bought.

- **Title screen.** New game, continue, settings, quit.
- **Save slots.** Three, with a screenshot, a district name, a play time and a
  campaign position. Serialized from the ledger, the chain map, the district
  standing and the respect table — all of which already persist; none of which
  currently has a player-facing shape.
- **Pause.** Which the game has never had, because a shared world cannot pause.
  Single-player can, and must.
- **Settings.** Audio mixes, the three lighting modes already exposed as
  `?lights=`, resolution and window handling, and key rebinding.
- **A death and arrest screen** that says what happened and what it cost,
  instead of a three-second respawn timer.

None of this is hard. All of it is missing, and its absence is doing more
damage to the perceived quality of the game than any rendering item on this
list.

## T3 — The spine (L, high design risk)

The fatal gap. A designed campaign.

**Shape.** Three acts, roughly twenty-five to thirty authored missions, eight
to twelve hours to finish, with the sandbox remaining open throughout and the
radiant payphone jobs continuing to exist alongside. Act boundaries gate on
story rather than on respect, so a player cannot grind past the writing.

**What it draws on.** The seven mission verbs already implemented cover more
than people expect: `hit`, `sweep`, `delivery`, `escape`, `race`, `bomb`,
`escort`. What they lack is not verbs but *specificity* — an authored mission
is the same verb pointed at a hand-placed target with a hand-written reason.
Assume two or three new verbs will be wanted once a designer is actually
writing (a stealth approach, a defend-this-position, a chase-don't-lose-them),
and budget for them rather than pretending the existing seven will carry
thirty missions.

**What has to be built to author it.** This is the engineering half, and it is
the part that gets underestimated:

- **A mission script format.** Today a mission is a `MissionSpec` row: a verb,
  a tier, a count, a payout. An authored mission needs ordered beats,
  conditions, branches, failure states with distinct messages, and triggers
  tied to specific world positions. This is a small declarative language and a
  runner for it, sitting where `missions.ts` sits now — server-side, outside
  the sim, reading state and writing `SimCommand`s. The existing runner is the
  right architecture and the wrong data model.
- **Placement.** Missions must reference authored locations, which means T3
  depends on U1.
- **Dialogue and presentation.** At minimum: a speaker, a portrait, a line, and
  a way to skip it. Cutscenes are declined (§10).
- **A mission editor, or at least a hot-reload loop.** A designer who has to
  rebuild and reconnect to test a beat will write a third as many beats.

**Why this is the highest-risk item in the document.** Everything else here is
work with a knowable end. This one can be done competently and still be dull,
and no amount of engineering rescues that. It wants a designer hired early,
before the tools are finished, so the tools are shaped by someone using them.

## T4 — The first ten minutes (S–M, medium risk)

There is currently no onboarding of any kind — the grep returns nothing. A
player arrives in a generated city with eight weapon slots, twenty-seven
vehicle kinds, a respect system, a district system, a fitting system and no
indication that any of it exists.

Build a designed opening: a short authored sequence that teaches driving, then
entering a building, then a weapon, then the wanted system, then a payphone,
in that order, without a tutorial box in sight. It is the single most-watched
ten minutes in the game and the one every review describes.

Contextual prompts throughout — the shop keys `Y U I O H J N P` are currently
documented only in the README, which is not where players are.

## T5 — The gamepad (S, low risk)

Zero support today. A top-down driving game on a stick is not a port, it is the
better input for half the game. Twin-stick aim on foot, trigger throttle in a
car. Full remapping. Glyph swapping in every prompt T4 adds.

Small, cheap, and it moves the game from "web toy" to "product" faster per hour
spent than anything else on this list.

---

# Wave U — a city, not a generator

## U1 — The generator becomes a tool (M, medium risk)

The pivot in §4 constraint 2, made concrete.

Today `generateCity()` is the source of truth and the world is a pure function
of a seed. Change it so that generation *bakes* — a seed produces a map
artefact on disk, that artefact is what ships, and humans edit it.

- **Bake.** `pnpm mapgen` already renders a city to PNG without the game; teach
  it to emit the full map structure instead.
- **Edit.** Hand-place buildings, move roads, name districts and streets, place
  mission markers, landmarks and interiors.
- **Merge, not overwrite.** Regenerating with a new seed must preserve edits
  where it can and report conflicts where it cannot. Getting this wrong loses
  a district's worth of authoring, which is why it is called out as an
  invariant rather than a nice-to-have.
- **Keep the infinite world.** `ROAM=1` and the sliding window stay, for the
  sandbox beyond the authored city's edges. The campaign happens in the
  authored part; the generated countryside is what is past the ring road.

Everything downstream — collision, the road grid, traffic routing, amenities,
turf, vehicle homes — reads the map through existing interfaces and does not
care where it came from. That is why this is medium and not large.

## U2 — Heights, and true extrusion (M, medium risk)

Already the top two items in `GRAPHICS.md`'s own "what's next," and they are
one item: worldgen knows the district and the building rect but not how tall
anything is.

Add per-building height, then draw the visible buildings offset outward from
screen centre in proportion to it. You see the north face of buildings north of
you and the south face of buildings south of you. Height then drives extrusion
depth, shadow length and roof detail density at once.

**Do this early.** It is the largest single change in how the game looks per
unit of work, it is a prerequisite for any 3D-presentation fork later, and
every screenshot and every clip from the day it lands is better than every one
before it. When a publisher or a festival asks for material, this is what
decides the answer.

The cost is that buildings leave the chunk cache and get drawn per frame,
against a renderer currently sitting at p99 16.8 ms with no headroom to spare
at 1440p. Budget a profiling pass alongside it. This may be the item that
forces V1 earlier than planned, and that is worth knowing in advance rather
than discovering.

### U2a — This has been spiked, and it fits

`?extrude=1` draws it; `pnpm bench` measures it; `evidence/extrude-*.png` is
the before and after. **The answer is that U2 does not force V1 forward**, and
risk 2 in §11 is retired.

Median of three interleaved passes, 12 s of driving, seed 7, CPU inside the
world render only:

| | p50 | p95 | p99 |
|---|---|---|---|
| 1920×1080 baked | 4.80 ms | 7.40 ms | 9.90 ms |
| 1920×1080 parallax | 4.80 ms | 6.60 ms | 8.80 ms |
| 2560×1440 baked | 6.70 ms | 9.60 ms | 10.80 ms |
| 2560×1440 parallax | 7.00 ms | 10.00 ms | 12.00 ms |

About +0.3 ms at p50 and +1.2 ms at p99, worst case, against a 16.7 ms budget.
60 fps throughout.

**Why it is nearly free**, which was not the prediction: the cached path
sweeps a wall for *every building tile*, so a downtown block pays for forty
sweeps. Drawing per *building* is at most two wall quads and one roof blit for
the whole mass — 21 buildings on screen at 1080p, 29 at 1440p. Moving the work
out of the chunk bake and into the frame roughly cancels itself out.

Three things the real item still has to settle, none of them about speed:

1. **The screen centre goes flat.** True parallax gives a building under the
   camera no lean and therefore no visible wall, where the baked path gave
   every building a constant 5 px sweep. It is physically right and a visual
   loss exactly where the player is looking. The fix is a floor on the lean —
   a constant sweep the parallax adds to rather than replaces. Pinned by a
   test so it changes deliberately (`client/test/extrude.test.ts`).
2. **Roofs must be baked per building, not repainted.** The first version drew
   flat roof rectangles and lost the speckle, parapets and clutter. Baking each
   roof to its own canvas and blitting it displaced keeps the art at one
   `drawImage` per building; a per-frame repaint would have put the per-tile
   cost straight back and the measurement above would have been a fiction.
3. **The lighting pass still casts against the tile grid**, so shadows and
   occlusion use the footprint while the roof has moved. Nobody notices at
   3 px a storey; somebody will at 8.

**On the numbers themselves.** They come off a shared container with no GPU,
and the same configuration measured 4.8 ms in one pass and 11.9 ms in another
when the passes were run back to back rather than interleaved. The absolute
values are not a shipping target. The A/B delta is the finding, and taking
medians of alternating passes is what makes it trustworthy — `ci/renderBench.mjs`
does it that way for that reason.

## U3 — An authored district (L, medium risk)

With U1 built, actually build the city. Landmarks you navigate by. A waterfront
that is a specific waterfront. Streets with names and character. Geometry that
rewards learning — the alley that cuts the block, the ramp that only works at
speed, the one-way system that punishes panic.

This is the largest pure-content item in the document and the one that most
directly answers "why is this better than the generated version." It is also
the item where a level designer earns their salary in a fortnight.

Scope it at **two to four square kilometres** of authored city. That is small
next to the genre's giants and correct for this tier: dense and learnable beats
large and forgettable, and the generated world is still out there past the
edges for anyone who wants to keep driving.

## U4 — Interiors and set-pieces (M, medium risk)

Shops are currently doorways with a key prompt. Give the campaign somewhere to
happen indoors — a handful of authored interiors, entered seamlessly, used by
T3's missions. This is where authored missions stop feeling like generated ones
with better text.

---

# Wave V — it looks and sounds bought

## V1 — The GPU renderer (L, high risk)

Canvas 2D is at 60 fps today and will not survive U2's per-frame buildings plus
V4's weather plus a crowd twice the current 200. The measurements in
`GRAPHICS.md` are unusually honest about why: `copy` and `source-in` are
unbounded composite operations, a 136-pixel lamp paid for 262,144 pixels of
work, and the fix was careful buffer management rather than headroom. There is
no headroom.

Move to WebGL2 behind the existing render interface. The sprite pipeline
already bakes 32 rotation steps and caches them, which is a texture atlas by
another name; the lighting pass is already a separate accumulation buffer
composited back, which is a shader by another name. The architecture is right;
the executor is wrong.

**Keep the Canvas path for one release.** Two renderers producing visibly
identical output is the only way to know the port is correct, and the
screenshot corpus in `evidence/` is the comparison harness — it already exists,
and it already photographs the running game.

**High risk** because it is the one item here with no partial credit: a
half-ported renderer ships nothing.

## V2 — The art pass (M, medium risk)

`GRAPHICS.md` items 3, 4 and 5, which are the three that most affect how the
game reads in motion:

- **Directional character art.** Characters are currently one silhouette
  rotated. A dedicated front/back/side set — or at minimum a different arm
  arrangement moving versus aiming — transforms how on-foot combat reads.
- **Vehicle damage states.** The generator's delta model already supports it;
  add `variants` on a damage axis and crumple the body polygon. The damage
  *simulation* is 638 lines and fully built; it is currently invisible.
- **Skid marks.** The decal pool and emitter both exist; it needs a lateral-slip
  signal out of the vehicle sim.

And the bigger question underneath: **does the procedural sprite pipeline
survive to ship?** It is a genuine asset — a new sprite is a JSON edit, the
height-field relighting is what makes flat art read as solid, and it gives an
art velocity a small team cannot otherwise buy. It is also a look, and a
uniform one. My recommendation: keep it as the base layer for the long tail
(props, parked cars, background peds) and hand-author the two hundred things
the player looks at most. Hybrid, with the generator doing the volume.

The sheet is 57 frames in one 178 KB PNG. `GRAPHICS.md` notes that past a few
hundred frames the shelf packer wants a real bin packer and the sheet wants
splitting by category. Assume both, early in this wave.

## V3 — Audio that was recorded (M–L, medium risk)

Currently: zero audio files. Sixteen sounds, an engine, a siren and a radio,
all synthesized by WebAudio at runtime.

This is a remarkable engineering achievement and it is the single most
prototype-revealing thing about the game. Synthesized gunfire is recognizably
synthesized in the first two seconds, and audio is the sense that decides
whether an impact feels like an impact.

- **Recorded foley** for everything the player causes: weapons, impacts,
  doors, footsteps, glass, fire.
- **Layered engine audio** per vehicle class — keep the synthesis as a
  modulation layer over recorded loops; the existing engine model already has
  the right parameters, it just has nothing good to modulate.
- **Music.** Commission it. Do not licence it. Licensed radio is the line item
  that makes this genre expensive and it is the clearest thing separating this
  tier from AAA — an original soundtrack for a handful of in-game stations is
  affordable, distinctive, and does not expire.
- **Middleware.** FMOD or Wwise. Both have indie terms that fit this budget,
  and hand-rolling a mixer is a month that buys nothing.
- **Voice.** T3's dialogue needs a decision. Full VO is expensive and
  schedule-coupled; text with character-specific vocal stings is the honest
  premium-indie answer and reads as a choice rather than a shortfall.

## V4 — Weather (M, low risk)

Rain as a screen-space particle layer plus a wet-asphalt specular tint on the
road chunks, on a server-authoritative clock so co-op players see the same sky.
The day/night cycle already establishes the pattern — a formula over `tick`,
no sim state, nothing on the wire, cannot desync.

Cheap, high-visibility, and it wants to land after V1 rather than before.

---

# Wave W — it ships

Low risk, non-negotiable, and routinely underestimated by a factor of three.

## W1 — The desktop build (M, low risk)

Tauri or Electron wrapping the Vite build, with the T1 worker host inside it.
Tauri if binary size matters, Electron if the team wants fewer surprises.
Steamworks integration: achievements, cloud saves, controller API, rich
presence. Windows first, then macOS and Linux — the codebase makes the last two
nearly free and there is no reason to leave them.

## W2 — Save, settings, accessibility, localization (M, low risk)

- **Save** in the desktop filesystem via the `PersistenceStore` interface, with
  Steam Cloud sync and — given a deterministic sim and an append-only ledger —
  corruption recovery that is actually tractable.
- **Accessibility.** Colourblind-safe palettes (there is already a
  `palette.json` to key off), text scaling, remappable everything, a
  hold-versus-toggle option on every held input, screen-shake and flash
  reduction. Do it as the UI is built, not after.
- **Localization.** Extract every string — there is no string table today. Six
  to eight languages. Note that the shop-key HUD prompts and the mission text
  T3 introduces are the bulk of it, and both are being written during this
  plan, so extract as you go and the cost is near zero. Retrofit later and it
  is a month.

## W3 — Telemetry, crash reporting, QA (M, low risk)

**Build this before the first playtest, not after.** Opt-in telemetry — where
players die, where they quit, which missions get retried, how long the opening
takes. Every one of those numbers changes a T3 or T4 decision, and they are
worthless if they arrive after the decisions are made.

Crash reporting with the replay attached. This is the dividend of determinism
that most directly pays for itself: a bug report that re-simulates is a bug
report that reproduces.

QA is a real line item — a contract QA pass before each milestone and a
sustained one in the last six months.

## W4 — The store page and the demo (M, low risk)

A Steam page up early, because wishlists compound and a page that has existed
for eighteen months outperforms one that appeared at launch. A trailer that
uses U2's extrusion and V2's art. A demo built from T4's opening, which is
already the most-polished ten minutes in the game. Next Fest. Press. A
publisher conversation, entered from a position of having a vertical slice
rather than a pitch.

---

## 9. Sequencing

The ordering is driven by three things: the fatal gap first, the tools before
the content they author, and anything that makes screenshots better as early as
it can be afforded.

**Months 0–6 — prove the shape.**
T1 (in-process host), T2 (front end), T5 (gamepad), W3 (telemetry). Then start
T3's tooling — the mission script format and its runner — and U1 (bake and
edit). Hire the designer at month zero, not month six.

*Gate:* the game runs offline, has a title screen, is playable on a pad, and a
designer can author a mission without an engineer.

**Months 6–14 — build the game.**
T3 (the spine) is the through-line for this entire period. U2 (heights and
extrusion) lands early in it, for the screenshots. U3 (the authored district)
runs in parallel with T3, because missions need places and places need missions
to justify them. T4 (the opening) comes last, once there is a game to open.

*Gate:* a vertical slice — one authored district, act one playable end to end,
at target look. This is the artefact that raises money if money is being
raised.

**Months 14–22 — make it good.**
V1 (GPU renderer), V2 (art pass), V3 (audio), U4 (interiors), V4 (weather).
Acts two and three of T3 continue throughout.

*Gate:* content complete. Everything exists; nothing is polished.

**Months 22–30 — ship it.**
W1, W2, W4. Balance, bug-fix, localize, certify. Demo out for a Next Fest.
Launch.

**On the 30-month figure.** It assumes six to nine people and no disaster. The
honest version of this schedule has T3 slipping, because narrative design
always does and because it is the item where competent work can still be dull
and need redoing. Build the buffer in at the T3 boundary rather than at the
end, where it will be eaten by certification.

---

## 10. Team and budget

**The team, at full strength:**

| Role | Count | Notes |
|---|---|---|
| Creative lead / designer | 1 | Hired first. Owns T3. |
| Gameplay engineer | 2 | One owns the portable host and tools, one owns sim and missions |
| Graphics engineer | 1 | Owns V1, U2 |
| Technical artist | 1 | Owns the sprite pipeline's future, bridges V2 |
| Artist | 1–2 | Environment and character |
| Level designer | 1 | Owns U3, arrives with U1 |
| Producer / QA lead | 1 | Part-time early, full-time from month 14 |
| Audio | contract | V3, plus a composer |

Seven to nine at peak, ramping from two or three.

**Budget, at fully-loaded Western European or US rates** — roughly $130–180k
per head-year including employer costs, tooling and overhead:

| | |
|---|---|
| Core team, ~17 head-years over 30 months | $2.2M – $3.0M |
| Contract audio, composer, outsourced art | $250k – $450k |
| Middleware, tools, hardware, certification | $60k – $120k |
| Marketing, festivals, trailer, PR | $150k – $400k |
| **Total** | **$2.7M – $4.0M** |

**The lean version, which is what most teams in this tier actually do:** three
to four people, thirty-six months, heavier reliance on the procedural pipelines
already built, contract art and audio only. **$900k – $1.5M.** It is slower and
it ships a smaller city, and it is a perfectly good version of this plan — the
codebase's procedural tooling is precisely what makes the lean version viable
where it would not be for a team starting from nothing.

Either number is two orders of magnitude below the AAA figure, which is the
point.

---

## 11. Risks, ranked

1. **T3 is competent and dull.** The highest-probability failure and the one
   no engineering answers. Mitigation: hire the designer first, get act one
   playable by month twelve, and playtest it with strangers with W3's telemetry
   running. If act one is not fun with placeholder art, the art will not fix it.

2. ~~**U2 forces V1 earlier than budgeted.**~~ **Retired** — spiked and
   measured (§U2a). Per-building drawing replaces per-tile baking, so the work
   roughly cancels: +0.3 ms p50, +1.2 ms p99 worst case, 60 fps throughout.
   V1 stays where the plan put it. What U2 does still owe is three visual
   problems, all listed in §U2a and none of them about frame time.

3. **The authored/generated merge in U1 eats a district.** Mitigation: version
   the map artefact, make edits additive rather than destructive, and write the
   conflict-reporting test before the merge code.

4. **Determinism breaks quietly during the worker port.** Mitigation: the
   replay corpus is the gate, and it must be run in CI against both hosts from
   T1's first commit. A hash that diverges at tick 4,312 is a fifteen-minute
   bug; a hash nobody checked is a fortnight.

5. **The procedural art look becomes a ceiling on perceived quality.**
   Mitigation: decide the hybrid split in V2 early, and test it by hand-drawing
   exactly one vehicle and one character and putting them next to the generated
   ones. If the difference is not worth the money, that is a real answer and it
   saves a year.

6. **Scope creep back toward AAA.** The declined items are declined. The
   temptation after V1 ships and the game looks good will be to widen the city
   and add systems, and that is how this tier's projects die. §12 exists to be
   pointed at.

7. **Localization retrofitted.** Cheap if strings are extracted as they are
   written, expensive as a late pass. Mitigation: the string table exists from
   T2, before there are any strings.

---

## 12. What this document declines

- **Full 3D.** Costed in the AAA analysis and declined for the same reason it
  was there: the simulation is 2D throughout — `collide.ts`, `roadgrid.ts`, the
  oriented-box vehicle collision, worldgen, flight — and going 3D rewrites
  around forty per cent of `shared/` to rebuy gameplay already proven. If a 3D
  *presentation* is ever wanted, U2's building heights are the groundwork and
  the sim stays untouched. That is the fork to take. Not this one.

- **A persistent shared world.** Declined with Gap 4. It is an operating cost
  a single-purchase game cannot carry, and it is what forces every mission to
  be a race between strangers. Co-op sessions keep the netcode and drop the
  business model.

- **A native engine port.** Rust or C++ for the sim was the first item of the
  AAA plan and is not needed here. TypeScript at 30 Hz with a few hundred
  entities is comfortably within budget, and the port would cost six to nine
  months that buy nothing a player notices. The replay corpus keeps the option
  open at any time, which is the whole reason to say no to it now.

- **Cutscenes.** Camera scripting, character rigs, a cinematics pipeline and a
  dedicated animator. In-engine dialogue with portraits reads as a deliberate
  style at this tier; half-budget cutscenes read as a shortfall.

- **Licensed music.** Restated because it will come up every time somebody
  remembers what the radio in this genre is for. Commission it.

- **User-generated content and mod support.** Genuinely tempting given that the
  whole game is JSON tunables and a deterministic sim, and genuinely a
  post-launch item. Shipping first, mod tools second, and it is a much easier
  conversation with a shipped game behind it.

- **Mobile.** Canvas 2D and a touch layer make it look nearly free. It is not:
  it is a different control scheme, a different session length, a different
  store and a different price point, and it would compete with T3 for the
  designer's attention during the exact months T3 cannot afford it.

---

## 13. If only three items get built

**T3, T1, U2** — in that order.

**T3** is the fatal gap. A sandbox with generated missions is what this repo
already has, and no amount of the rest of this document changes what it is.
Everything else here is amplification, and amplifying a shapeless game produces
a beautiful thing nobody finishes.

**T1** is what turns it from a thing you host into a thing you sell, and §3 is
the reason it is second rather than fifth: the architecture already permits it
at the cost of six shims, so it is the highest ratio of product change to
engineering hours anywhere in this plan.

**U2** is the screenshot. Building heights and true parallax extrusion are the
largest visible change per unit of work available, they are the groundwork for
every rendering fork after them, and they are what a store page, a trailer and
a festival submission are made of.

That trio is a game with a shape, that runs on the machine of the person who
bought it, and that looks like something worth buying. The other twenty items
make it good.
