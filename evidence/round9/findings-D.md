# Round 9 — lens D (the seams: netcode, persistence, CI, stale evidence)

Measured on `ee29b03d7a97972d6e1db21e67ffb652cceda166` ("Record the playLocal
fix and the HUD caption error it found"), working tree clean apart from
`evidence/round9/`. Ground truth taken as given; nothing in the suite was
re-run whole.

---

## `persistCheck`, the documented persistence gate, accuses the server of losing a wallet it did send

severity: significant
lens: D
where: `server/src/tools/persistCheck.ts:62-66` (`next()` registers its waiter
only in the microtask after the previous `await` resolves) against its call
sites `:84`/`:86` and `:99`/`:101`
evidence:
`node server/dist/tools/persistCheck.js`, 10 consecutive runs with any leaked
server killed between them, box otherwise quiet (load avg 1.5 on 4 cores):
**1 failure**. The same loop earlier, at load avg ~5.9: **6 failures of 10**.
The same loop with nothing killed between runs, so each failure's leaked
server stays up (see the nit below): **10 failures of 10**, load avg 8.4.
Every failure is the same line:

```
life1: registered, cash=500
Error: timeout waiting for wallet
    at Timeout._onTimeout (.../server/dist/tools/persistCheck.js:55:38)
```

The server is innocent. `evidence/round9/D-persist-trace.mjs` logs every frame
of the same two-life flow and shows both lives answering correctly —
`account {ok:true}` then `wallet {cash:500}`, 500 before the restart and 500
after. The mechanism is in the harness, and
`evidence/round9/D-persist-2life.mjs` catches it in the act: when the two
frames land in one event-loop turn, the `wallet` arrives before the `await
next('account')` continuation has pushed a `wallet` waiter, so it is delivered
to nobody and the 5 s timer fires.

```
L1   1273ms welcome       delivered=true
L1 --- sent register
L1   1276ms wallet        delivered=false     <- the join-time wallet, expected
...
L1   1695ms account       delivered=true
L1   1695ms wallet        delivered=false     <- same millisecond, dropped on the floor
```

repro:
```
node evidence/round9/D-persist-2life.mjs 8      # loops until it fails, prints the frame log
node evidence/round9/D-persist-trace.mjs        # the server's side, both lives, all frames
for i in $(seq 1 10); do node server/dist/tools/persistCheck.js; done   # the rate
```
why it matters: `README.md:180` publishes this as the e2e persistence check and
`ROADMAP.md:563` makes it the gate for "anything touching the economy". Its
failure message is `timeout waiting for wallet` on a restart-survival test —
it reads as *the save file did not come back*, which is the single scariest
thing this project can report. The next person to touch the economy runs it,
sees that, and goes looking for a persistence bug that is not there. This is
the fourth instrument in this exercise found confidently reporting the wrong
thing (`fallSheet`, the corpse-witness script, the round-4 parity port).
prior art: none found. `GAPS.md`, `BUGS.md` and `REVIEW-QUEUE.md` record
`persistCheck` only as passing.

---

## `ci/test.mjs` reports "green" and exits 0 when its filter matches no test at all

severity: significant
lens: D
where: `ci/test.mjs:53` (the empty-collection guard is gated on
`filters.length === 0`) and `ci/test.mjs:62-63` (the unconditional green print)
evidence:
```
$ node ci/test.mjs nosuchtestfilterxyz
...
[ci/test] green: 0 files, 0 failures, 0 ignored runner-noise error(s).
EXIT=0

$ npx vitest run nosuchtestfilterxyz
...
RAW EXIT=1
```
The wrapper is *more* permissive than the runner it wraps: vitest fails a run
that collected nothing, and `ci/test.mjs` converts that into a pass, because
line 53 excuses a filtered run from the `files.length < 50` check and nothing
else looks at whether any test ran.
repro: `node ci/test.mjs nosuchtestfilterxyz; echo $?`
why it matters: `REVIEWER.md:25` instructs every reviewer in this exercise to
run `node ci/test.mjs <filter>` when a specific test bears on a finding. A
mistyped filter, a test renamed by another lens's fix, or a file moved between
packages all answer `green: 0 files, 0 failures` — the exact reading that makes
a reviewer write "verified, the test passes" about a test that did not exist.
CI itself is not exposed (both workflows call `pnpm test` with no filter, and
the `< 50` guard covers that), so this is a defect in the reviewers' own
instrument rather than in the deploy gate.
prior art: none found. The file's own comment defends the `onTaskUpdate`
filter's narrowness at length and says nothing about the empty-run case.

---

## README.md describes a city half the size, with half the boroughs, that has not existed for five waves

severity: significant
lens: D
where: `README.md:96-98` and the borough table at `README.md:100-104`
evidence: README:96-98 reads, in the present tense —

> There is one city and it was drawn, not rolled: **Anywhere City**, 384×384
> tiles (6144×6144 px) of island group — three boroughs joined by four bridges,
> with the sea all the way round as the map's edge.

— and the table under it lists exactly three: Port Vasco, Ravenhill, Sunridge.
The shipped plan says otherwise:
```
$ node -e "const p=require('./shared/data/city-plan.json'); ..."
widthTiles x heightTiles = 768x768 => 12288x12288 px
boroughs 6: Kelvin, Ravenhill, Sunridge, Marsh End, Port Vasco, Gannet Rock
districts 16
crossing-named roads: Kelvin Bridge, Old Bridge, Marsh Causeway, North Sound Bridge, South Sound Bridge
```
(`TILE_SIZE = 16`, `shared/src/world/types.ts:4`.) `pnpm mapgen` renders
1536×1536 at 2 px a tile, which is the same 768. `evidence/README.md` describes
the real city — "768×768 tiles of archipelago … Five boroughs plus Gannet Rock
… eight crossings" — so the project's evidence index and its front door
disagree about the size of the map, the number of boroughs and the number of
crossings.
repro:
```
sed -n '96,104p' README.md
node -e "const p=require('./shared/data/city-plan.json');console.log(p.widthTiles,p.heightTiles,p.boroughs.map(b=>b.name))"
```
why it matters: this is the first description of the game a contributor reads,
and Kelvin, Marsh End and Gannet Rock — a whole borough reachable only by air —
are simply absent from it. Three of this exercise's own findings (R1-A01 Kelvin
Bridge, R1-A02 Hollis Creek, R5-A01 Gannet Rock's respray garages) are about
places the README says the city does not have.
prior art: `PROGRESS.md:412` records the change the README missed —
"**The map.** 384×384 → **768×768 tiles** (12288 px, four times the area…)".
`PROGRESS.md:504-505` is the historical entry the README paragraph was copied
from; that one is correctly dated and should stay as it is.

---

## nit: every failed `persistCheck` run leaves a live 30 Hz server behind, which makes the next run likelier to fail

severity: nit
lens: D
where: `server/src/tools/persistCheck.ts:117-120` — `main().catch()` prints and
`process.exit(1)`s without touching the two children it spawned; `server.kill`
is only reached on the happy path (`:90`, `:105`)
evidence: in the 10-run loop, every failing run left exactly one extra
`node server/dist/index.js` alive (`ps -eo args | grep -c 'dist/inde[x].js'`
returned 1 after each failure, 0 after each pass). Ten failures in a row took
the box from load avg 1.5 to **8.44 on 4 cores** and drove persistCheck's own
failure rate from 1-in-10 to 10-in-10. Each orphan is a full session: 30 Hz
sim, 200 pedestrians, a bound port, and no parent left to stop it.
repro:
```
node server/dist/tools/persistCheck.js ; ps -eo args | grep 'dist/inde[x].js'
```
(run it until one fails — see the finding above — then count the survivors)
why it matters: it is a positive feedback loop on top of the flaky check above,
and it is why the first thing I saw in this lens was 10/10 failures. Anyone
debugging the failure the obvious way — run it again — is loading their own box
with each attempt.
prior art: none found.

---

## nit: `evidence/city-anywhere.png` no longer reproduces from `pnpm mapgen` — Marsh Post is the pre-R7-A04 city

severity: nit
lens: D
where: `evidence/city-anywhere.png` (last written by `5864632`, the round-5
re-retake) against its own retake command
evidence: instrument calibrated first — `pnpm mapgen` run twice into
`evidence/round9/D-city-anywhere.png` and `-2.png` diffs to
`0/2359296 (0.000%)`, so the renderer is bit-deterministic and any count is
real drift.
```
evidence/city-anywhere.png vs evidence/round9/D-city-anywhere.png:
  1536x1536 differing px 72/2359296 (0.003%) maxchan 75
```
The 72 px are one 6×12-px cluster at `[1080..1085]x[1098..1109]`, i.e. tiles
(540..542, 549..554) at 2 px a tile — Marsh Post. Green `47,76,51` in the
committed plate, brown `122,95,78` now. Confirmed as R7-A04 (the park paint
that overran Marsh Post) and not something new: the current tree reproduces
`evidence/round7/A04-after-marsh-post.png` at **0 px** and differs from
`A04-before-marsh-post.png` by 4.500% at the same `maxchan 75`.
repro:
```
node server/dist/tools/mapgen.js --out=evidence/round9/D-city-anywhere.png
node evidence/round1/D-pngdiff.mjs evidence/city-anywhere.png evidence/round9/D-city-anywhere.png
```
why it matters: only as the thing R1-D02 predicted. The round-5 refresh was
valid against a frozen tree and round 7 moved the tree under it; one landmark
in the flagship whole-city plate is now the old city. It is 0.003% and no
caption depends on it — filed so the number exists rather than because anyone
would notice it.
prior art: `REVIEW-QUEUE.md` §"R1-D02 fixed — and the sequencing hazard bit
anyway": *"an evidence refresh is only valid against a frozen tree … if this
were a standing job it should run as a gate on the merge commit, not as a task
in a round."* This is that prediction coming true two rounds later, at the
smallest possible size.

---

# What I checked and did not file

**The staleness spot-check, widened from three plates to all twelve.** Every
committed plate in `evidence/README.md` whose retake command is an offline
`mapgen`/`plangen` render — the class with a **0 px** noise floor — was retaken
into `evidence/round9/` and diffed:

| plate | retake command | diff |
|---|---|---|
| `city-shore-review.png` | `mapgen --crop=600,570,140` | 0 px |
| `city-kerb-review.png` | `mapgen --crop=545,20,90` | 0 px |
| `city-cliff-review.png` | `mapgen --crop=55,555,120` | 0 px |
| `vector-p1-coast.png` | `mapgen --crop=470,390,80` | 0 px |
| `vector-p0-tiles.png` | `mapgen --tiles --crop=552,32,80` | 0 px |
| `vector-p2-junctions.png` | `mapgen --crop=596,76,70` | 0 px |
| `airstrip.png` | `mapgen --crop=494,592,48 --scale=16` | 0 px |
| `bridge-bevel.png` | `mapgen --crop=620,600,70` | 0 px |
| `city-lanes.png` | `mapgen --lanes --crop=300,180,72` | 0 px |
| `city-shore-collide.png` | `mapgen --solid --crop=322,534,14 --scale=44` | 0 px |
| `city-roadnet.png` | `mapgen --net --crop=300,180,120` | 0 px |
| `city-anywhere.png` | `pnpm mapgen` | **72 px** (nit above) |

Eleven of twelve reproduce exactly, five rebakes and two rounds after the
refresh. R1-D02's fix is holding; the 13-of-15 rot of round 1 has not returned.

**Reconnect.** `handleJoin` (`host.ts:499-547`) does exempt a resume from
`maxPlayers` exactly as `README.md:58` claims — the cap check sits in the
`else` branch that only a non-resuming join reaches — and the resume path still
kicks the zombie conn, still hands back `inputSeq: slot.lastQueuedSeq`
(`:539`), and the client still takes `Math.max(seq, msg.inputSeq + 1)`
(`main.ts:632`) off `sessionStorage`, which survives a reload. R1-D01 and
R1-D05 both still hold. `maxConnections` (128) is comfortably above
`maxPlayers` (32), so the socket cap cannot turn a reconnect away first.

**The interest radius.** An entity crossing the 600 px boundary falls out as an
ordinary added/removed row against the client's own acked *filtered* snapshot
(`broadcast.ts:18-20`, `:67-81`), and a driving player's interest centre tracks
the car rather than the kerb they left it at (`step.ts:118`, `p.pos.x = v.pos.x`),
so the radius follows the player at speed. I checked whether the 3D renderer
can see past 600 px, since it is the default and `GRAPHICS.md:199` argues the
ceiling only for the 2D viewport: at the shipped `GAME_PITCH = 10`
(`main.ts:243-247`) with `viewHeight = viewport.h ≤ 400`
(`viewport.ts:24-25`, `main.ts:855`) the far edge stays inside the radius. Only
a hand-typed `?pitch=60` gets outside it, and that is a debug override. Nothing
to file.

**Persistence, both backends.** `SqliteStore.putAccount` (`sqliteStore.ts:138-153`)
updates only `equipped_cosmetic` on conflict and never deletes a cosmetic,
where `MemoryStore.putAccount` replaces the whole row — but no caller changes a
password or removes a cosmetic (`accounts.ts:83-89` is the only update path,
and `register` refuses an existing name on both sides of its hash), so the two
backends agree over every call the game actually makes. Dirty shutdown is safe
for a different reason than the shutdown handler: `index.ts:54-59` never closes
or flushes the store, but it does not need to — `MemoryStore` flushes inside
`appendTransaction`/`putAccount`, `FileStore.flush` is tmp+rename, and every
SQLite write is its own statement. `Ledger` holds only a balance *cache*, never
an unwritten row.

**The deploy gate.** Read `test.yml` and `deploy.yml` against `ci/deploy.sh`.
R1-D03 and R1-D06 both still hold: `DEPLOY_SHA: ${{ github.sha }}` crosses as
an env value, is shape-checked `^[0-9a-f]{40}$` on the runner and `{7,40}` hex
in the script, `deploy.sh:52-62` resolves the commit before touching the
working tree, `if: github.ref == 'refs/heads/main'` sits at job level on the
deploy job, and `healthy()` is `2[0-9][0-9]` only.

---

# Suspicions — unmeasured, do not act on these as findings

1. **Neither workflow compiles or bundles the client.** `pnpm build` is
   `tsc -b server`, whose only reference is `../shared`
   (`server/tsconfig.json`), and `grep -rn "tsc -p client\|filter client\|parity"
   .github/workflows/` returns nothing. So `npx tsc -p client` and
   `pnpm --filter client build` — the second of which the Dockerfile runs at
   `Dockerfile:18` — are outside the gate that is supposed to stand between
   main and the server. I could not turn this into a finding: both are green at
   `ee29b03` (I ran `pnpm --filter client build`: exit 0, 119 modules), and
   producing the input that breaks them means editing source, which this round
   forbids. If it ever does break, `set -euo pipefail` aborts `deploy.sh` at
   line 68 *after* `git reset --hard "$TARGET"` and *before* the rollback
   block, so the checkout is left on the broken commit while the old container
   keeps running — which makes that commit the `PREV` a later deploy would roll
   back to. Reasoned from the script, not observed; there is no deploy host to
   observe it on. One cheap check for a later round: add
   `pnpm --filter client build` to the `test` job and see whether it stays
   green.

2. **`pnpm parity` is called a gate and gates nothing.** `evidence/README.md`
   says "Determinism across the two hosts is a gate, not an impression", and
   `README.md:181` documents the command, but no workflow runs it — it needs a
   browser and the client dev server, which is a plausible reason to leave it
   out. Whether "gate" is meant to describe the round checklist rather than CI
   is a question for the author, not a defect I measured.
