# Round 1 — Lens D (the seams: netcode, persistence, CI, stale evidence)

Ground truth accepted as given (`1469611`: build clean, 943 tests green,
`citybake --check` 0 errors). Nothing below contradicts it — none of these is a
failing test, which is the point of the lens.

Retakes and repro scripts are in `evidence/round1/` under a `D-` prefix. Nothing
under `evidence/` itself was touched.

---

## A page reload during play reconnects the player to a body they cannot move

severity: significant
lens: D
where: `server/src/session.ts:422` (`resumeByToken`) and `server/src/session.ts:475`
(`if (intent.seq <= slot.lastQueuedSeq) continue`), against `client/src/main.ts:303`
(`let seq = 1`)

evidence: `resumeByToken` restores `connected` and `disconnectedAtMs` and nothing
else — the slot keeps `lastQueuedSeq` from before the drop. The client's sequence
counter is a module-level `let seq = 1` in `main.ts`, re-initialised by a page
load, and the `welcome` handler (`main.ts:619-644`) does not reset it. The resume
token lives in `sessionStorage`, which survives a reload, so F5 sends
`join{resumeToken}`, the server resumes the slot, and every intent the client
then sends is dropped by the `seq <= lastQueuedSeq` replay guard.

Driving the real `Session`:

```
$ node evidence/round1/D-repro-resume-input.mjs
after 30s of play  lastQueuedSeq = 900
resumed same slot  = true  lastQueuedSeq = 900
intents accepted after reconnect = 0 of 150
ticks of dead controls = 900 (~30s at 30 Hz)
```

Intents are sampled once per 30 Hz tick (`main.ts:974`), so the dead window is
one second for every second played before the reload, bounded by
`RESUME_GRACE_MS` (120 s) — worst case two minutes of a live character that will
not answer a key.

repro: `node evidence/round1/D-repro-resume-input.mjs`

why it matters: reloading the tab is an ordinary thing a player does, and the
reconnect the README advertises hands them back a character standing in the road
that ignores every key until the counter climbs back to where it was. The
held-input path (`holdLimit`) keeps their last intent applied for up to a second
first, so the car drives on by itself and then stops.

prior art: BUGS.md §11.1 covers the other half of resume (the heartbeat, and a
still-`connected` slot refusing a reconnect); §11.4 "Left alone" lists resume
tokens never being rotated. Neither mentions the input-sequence watermark.

---

## The published evidence no longer reproduces from its own retake commands

severity: significant
lens: D
where: `evidence/README.md` and 13 of the PNGs it indexes; retakes in
`evidence/round1/D-retake-*.png`

evidence: every `evidence/README.md` entry whose retake command is deterministic
and offline was re-run at `1469611` and compared pixel-for-pixel
(`evidence/round1/D-pngdiff.mjs` — PNG decode plus per-channel compare):

| committed file | last touched | commits behind | pixels differing |
|---|---|---|---|
| `city-anywhere.png` | 2026-08-03 | 71 | **27.4%** |
| `airstrip.png` | 2026-08-03 | 71 | **command now yields 1536x1536; committed is 480x480** |
| `city-3d-ring.png` | 2026-08-04 | 59 | **73.7%** (overlay: 3801 buildings -> 4066) |
| `city-kerb-review.png` | 2026-08-04 | 62 | 20.4% |
| `city-shore-review.png` | 2026-08-04 | 62 | 4.2% |
| `city-cliff-review.png` | 2026-08-04 | 61 | 2.7% |
| `vector-p1-coast.png` | 2026-08-07 | 39 | **66.2%** |
| `vector-p0-curves.png` | 2026-08-07 | 41 | 14.5% |
| `vector-p0-tiles.png` | 2026-08-07 | 41 | 13.5% |
| `vector-p2-junctions.png` | 2026-08-07 | 39 | 9.8% |
| `bridge-bevel.png` | 2026-08-07 | 32 | 1.3% |
| `city-shore-collide.png` | 2026-08-14 | 16 | 3.8% |
| `city-shore-collide-tiles.png` | 2026-08-14 | 16 | 3.6% |
| `city-lanes.png` | 2026-08-13 | 17 | 0.0003% (1 px) |
| `city-roadnet.png` | 2026-08-12 | 18 | 0.003% (28 px) |

Only the last two are current. The drift is not cosmetic. `vector-p1-coast.png`
is captioned as the 26 degree rotated fabric at `--crop=470,390,80`; that crop
now lands on an axis-aligned grid in a different borough
(`D-retake-vector-p1-coast.png`). `city-anywhere.png` — the map the README leads
with, and the one WORLDGEN.md §13.1 argues against — still shows the
pre-fabric-wave city where every borough carries the same screen-aligned lattice;
the city the same command draws today has rotated boroughs, contoured suburbs
and a drawn ring road (`D-retake-city-anywhere.png`). `airstrip.png`'s stated
command (`pnpm mapgen --seed=1`) no longer produces an image of that size at all.

repro:

```bash
node server/dist/tools/mapgen.js --crop=470,390,80 --out=/tmp/coast.png
node evidence/round1/D-pngdiff.mjs evidence/vector-p1-coast.png /tmp/coast.png
node server/dist/tools/mapgen.js --out=/tmp/anywhere.png
node evidence/round1/D-pngdiff.mjs evidence/city-anywhere.png /tmp/anywhere.png
# 3D, with vite up on 5573:
WAIT_GROUND=24 node ci/shot.mjs \
  "http://localhost:5573/city3d.html?fly=1&at=330,630&h=300&pitch=45&night=0" /tmp/ring.png
node evidence/round1/D-pngdiff.mjs evidence/city-3d-ring.png /tmp/ring.png
```

why it matters: `evidence/` is what this repo offers instead of a demo, and every
review round — including this one — is told to judge the code against it.
Thirteen of fifteen checkable pictures show a city the code no longer generates,
so any finding raised or dismissed by looking at them is being decided on a
screenshot from three weeks and seventy commits ago.

prior art: none found. REVIEW-WORLDGEN.md:6 states the invariant this violates
("every screenshot has a retake command"); no doc records that the commands have
stopped matching.

---

## `ci/deploy.sh` ships whatever `origin/main` is, not the commit the suite passed

severity: significant
lens: D
where: `ci/deploy.sh:30-32`, against the `test` job in
`.github/workflows/deploy.yml` and `.github/workflows/test.yml:6-9`

evidence: `deploy.yml`'s `test` job runs `pnpm build && pnpm test &&
citybake --check` on an `actions/checkout@v4` of the event's ref, then the
`deploy` job pipes `ci/deploy.sh` over SSH. On the server that script does:

```sh
PREV=$(git rev-parse HEAD)
git fetch origin --quiet
git reset --hard origin/main      # ci/deploy.sh:31
```

The gate is by-commit on the runner; the deploy is by-branch-tip on the server,
resolved minutes later. Two concrete inputs separate them:

1. **A second push during the test window.** Push A starts run 1. Push B lands
   while run 1's `test` job is still running (the suite alone takes ~5 min; the
   job's budget is 45). `concurrency: deploy-gta` with `cancel-in-progress:
   false` queues run 2 rather than cancelling run 1, so run 1's deploy job resets
   the server to B and ships it. B has not been tested. If B is bad, run 2's
   `test` job fails and never deploys — leaving the untested B running with
   nothing to roll it back, because the rollback at `deploy.sh:43-45` fires only
   on a failed health check and a suite-failing build serves HTTP 200 fine.
2. **`workflow_dispatch`.** Dispatching `deploy.yml` from any branch tests that
   branch's checkout and then deploys `origin/main`.

repro: read `ci/deploy.sh:29-32` beside the `test` job in
`.github/workflows/deploy.yml` — the workflow tests `github.sha`, the script
deploys `origin/main`.

why it matters: `test.yml:6-9` states the guarantee as "deploy now refuses a main
whose suite has not passed", and `deploy.yml` says the gate is duplicated inline
"so a deploy cannot be dispatched around it". Both are true of the *workflow* and
false of the *commit that reaches the server*. Checking out the SHA the workflow
tested (`git reset --hard "$GITHUB_SHA"`, passed in over the SSH invocation)
closes it.

prior art: PLAN-WORLDGEN.md wave 0.4 is cited in both workflows as what closed
the deploy gate; it added the suite to the deploy job and does not cover which
commit the server checks out. Not in GAPS.md, BUGS.md, SHIP.md or AUDIT.md.

---

## A Node build that gains `node:sqlite` silently abandons every account the JSON fallback saved

severity: significant
lens: D
where: `server/src/economy/createStore.ts:25-26`

evidence: `createStore` picks the backend from the path extension and
`sqliteAvailable()` alone. It never asks whether the sibling `.json` — the file
its own fallback wrote at `createStore.ts:28-36` — exists or holds anything. The
fallback *into* the file store warns at length; the way back out warns nothing.

Same `PERSIST_PATH`, same volume, only the Node build changing between boots:

```
$ node evidence/round1/D-repro-backend-swap.mjs
after the fallback run : /tmp/swap-.../persist.json exists = true | erin balance = 25000
after the node bump    : SqliteStore | erin account = null | erin balance = 0
warnings printed       : 0
the .json is still on disk, untouched and unread: true
```

The trigger is a floating base image, not a hypothetical: the runtime image is
`FROM node:24-slim` (`Dockerfile:19`) while CI builds and tests on
`node-version: 22` (`.github/workflows/test.yml`), and `sqliteAvailable()` is a
property of whichever build gets pulled. `ci/deploy.sh:35` rebuilds the image on
every deploy (`compose up -d --build`), so the swap lands at exactly the moment
nobody is reading logs.

repro: `node evidence/round1/D-repro-backend-swap.mjs`

why it matters: the two stores are documented as one contract — "the economy code
cannot tell them apart" — and they do agree on semantics. What they disagree
about is which file *is* the save. Every registered account, password and balance
disappears with no error, no warning and no crash: the server comes up clean and
empty, the health check passes, the deploy reports green, and the old data sits
beside the new database unread.

prior art: none found. `server/test/createStore.test.ts` and
`server/test/persistFallback.test.ts` both cover backend *selection* and the
fallback's warning; neither has two boots at one path with `sqliteAvailable()`
changing between them.

---

## A client rejected for protocol mismatch reconnects every two seconds for ever

severity: nit
lens: D
where: `client/src/net/connection.ts:75-81` against `client/src/main.ts:682-687`

evidence: the server answers a bad `join` with `{type:'error', code:'protocol'}`
and then `conn.close()` (`server/src/host.ts:357-368`). The client's handler sets
`fatal` and breaks (`main.ts:682-687`); it never calls `conn.close()`, so
`closedByUs` stays false and `ws.onclose` schedules another `connect()` after
`RECONNECT_DELAY_MS` (2 s). The loop has no attempt ceiling — `attempts` is only
used to phrase a message. Concrete input: any server and client on different
`PROTOCOL_VERSION` (`shared/src/constants.ts:27`, currently 8), which is the
state of every tab left open across a deploy that bumps it.

repro: open a tab against a server built at a different `PROTOCOL_VERSION`; the
socket reopens every 2 s while the canvas shows the same unchanging fatal message.

why it matters: the screen already says what is wrong and will not change, so
every retry is pure cost — and it arrives from every stale tab at once, straight
after a deploy, when the server is coldest. The same handler also covers
`code:'full'`, where retrying is the right behaviour; only the terminal codes
need to stop.

prior art: none found. BUGS.md §11 covers the server's side of connection abuse
(token buckets, backpressure, heartbeat) but not the client's own retry policy.

---

### Checked and not filed

- **Interest management across the radius.** `server/test/interest.test.ts`
  already walks a client 600 ticks through AOI churn and asserts a hash match on
  every delta; re-read against `broadcast.ts`, enter/leave really does fall out
  as ordinary added/removed rows. The 2D viewport is capped at 700x400
  (`client/src/render/viewport.ts:23-24`, half-diagonal 403) and the playable 3D
  pitch is 10 degrees, both well inside 600 — the `interestRadius: 900` at
  `client/src/three/live.ts:85` is the flyover demo, not the game.
- **`MAX_PLAYERS` and the reconnect exemption.** The README's claim holds:
  `host.ts:499-517` takes the resume branch before the cap is tested.
- **`ci/test.mjs`'s known-error filter.** It matches one exact string and only
  against `getUnhandledErrors()`; test failures and every other unhandled error
  still fail the run, and the `files.length < 50` floor catches a suite that did
  not collect. No input found that makes it swallow a real failure.
- **`FileStore` durability.** `flush()` rewrites the whole ledger on every
  transaction — measured 6.1 ms at 20,000 rows against a 33.3 ms tick, growing
  linearly — and its constructor's unguarded `JSON.parse` turns an unreadable
  save into a boot loop under `restart: unless-stopped`. Both are real; neither
  has an input that reaches it in the shipped configuration, so neither is filed.
- **`node ci/playLocal.mjs`** did not complete in this shared container (hung in
  `getInCar` past 420 s on two attempts, on a browser that takes `ci/shot.mjs`
  captures fine). `play-dusk.png`, `play-drift.png` and `play-foot.png` are
  therefore *unchecked* by the staleness table above, not verified.
