# CAR-AI — research: how cars drive themselves in this genre

A reference on car AI — ambient traffic, pursuit, and errand driving — in
top-down and open-city games, written the same way as `RESEARCH.md`: so design
arguments can cite something concrete. It covers what the genre's landmark
games actually shipped, what the traffic-engineering and game-AI literature
offers, where this project already stands, and what is missing, ranked by how
much genre character the gap costs.

This is a **research document, not a spec**. `ROADMAP.md` and `FEATURES.md`
own sequencing. Where a recommendation is concrete enough to point at a file,
§5 does so.

## 0. Method and confidence

Same environment constraints as `RESEARCH.md` §0: the community wikis and
`gtamp.com` return **403 at the egress proxy**, so genre claims come from
web-search result summaries (sources in §7) plus general knowledge. The same
markers apply:

- unmarked — corroborated by a search result quoted in §7, **or** read
  directly from this repository's code (cited by `file:line`);
- **⚠** — believed correct but not corroborated by a reachable source; treat
  as a hypothesis to verify before it drives a design decision.

Unlike `RESEARCH.md`, a large part of the subject here is *already built and
measured in this repo* — `shared/src/sim/traffic.ts` and `police.ts` carry
their own experiment notes. Those measurements are first-class evidence and
§3 leans on them.

---

# 1. The four jobs a car AI does

"Car AI" is not one system. Every game in the genre decomposes it the same
way, and the decomposition is worth stating because each part wants a
different algorithm and a different simulation budget:

1. **Circulation** — ambient cars that make streets read as inhabited. Wants:
   cheap per-car cost, lane discipline, believable following and yielding.
   Never needs to reach a destination.
2. **Reaction** — what a driver does when the world goes wrong: gunfire,
   collisions, a carjacker at the window, a siren behind. This is where the
   *player's* actions get their echo, so it is disproportionately visible.
3. **Pursuit and interception** — police and rivals. Wants: aggression,
   corner-cutting, ramming, blocking; explicitly *not* road rules. Fairness
   here is a tuning stance, not an algorithm (§2.4).
4. **Errand driving** — a car that must get somewhere: mission targets,
   getaway drivers, patrols, NPC service vehicles, race opponents. The only
   job that needs actual routing.

Plus one cross-cutting concern: **population management** — spawning ahead of
the player, culling behind, keeping density believable at a bounded cost.
Every open-city game since 1997 does the same ring trick.

---

# 2. What the genre actually shipped

## 2.1 The 1997/1999 top-down originals: navigation baked into the map

The 1999 game's map format answers how its traffic drove: it didn't sense the
road — it followed **authored arrows**. The map editor places **green arrows
on road blocks indicating vehicle path direction**; a separate red-arrow
channel was reserved for mission paths but went unused. Junctions needing
lights are marked as **traffic-light zones**, and "the game will automatically
construct a traffic light system at each traffic light zone".

Two consequences documented by the editor community:

- **No dead ends.** The 1999 game's cars "can't turn around tight bends to
  drive back, which is why every road network consists of circles" — the
  drivers were arrow-followers with no U-turn, so the *authoring rules* had to
  guarantee circuits.
- **Leave room to pass.** Mappers are told to keep space beside roads "to
  bypass heavy traffic so players won't get stuck" — congestion recovery was
  the player's job, not the AI's.

This settles a question left open in `RESEARCH.md` §8 ("whether traffic obeys
signals in either game"): the 1999 game has real traffic lights,
auto-constructed at authored junction zones.

The design lesson is not "author arrows" — it is that ambient traffic in the
originals was **data-following, not deciding**. Per-car cost was near zero,
behaviour was deterministic, and cars looked purposeful because the purpose
was painted onto the road. Any per-tick sensing this project does (§3) is
already *more* simulation than the originals had.

## 2.2 The 3D era: path-node graphs with per-node metadata

The series' 3D games (2001–2004) moved to an explicit **path-node graph**
shipped beside the map. For the 2004 game the format is documented: 64 node
files, one per 750×750-unit cell, storing an adjacency-list graph where each
node carries flags including **lane counts** (bits 8–10 left lanes, 11–13
right lanes, relative to the link's direction vector), a **traffic level** in
four steps (full/high/medium/low), a **node type** (1 = cars, 2 = boats,
higher values reserved for racetracks and mission use), and **flood IDs**
marking connected components so route calculation never tries to path between
disconnected islands.

Points worth absorbing:

- **Lanes are graph metadata, not geometry.** The road's drawable surface and
  the AI's idea of the road are different data. Every game in the genre keeps
  these separate; this project derives lanes from the tile grid per tick
  instead (`traffic.ts:140`), trading authoring for computation.
- **Density is data too.** The per-node traffic level, and in the 2013 game a
  per-region-per-time-of-day population file (`popcycle.dat`) plus model
  pools (`popgroups`), let designers thin traffic by neighbourhood without
  touching code. This repo's analogue is a single global `count` in
  `traffic.json` — see §4.7.
- **Per-archetype driver tuning.** The 2013 game exposes per-vehicle AI
  handling (e.g. `MaxSpeedBrakeDistance` in `vehicleaihandlinginfo.meta`) — a
  bus and a sports car brake differently *as AI*, not just as physics.

**The autopilot mission enum.** ⚠ The reverse-engineered source of the 2001
game (the re3 project — taken down and restored, per §7) shows each car
carrying a small **autopilot** with a *mission* field: cruise, go to
coordinates (with and without obeying the road), **ram the player**
(far/close variants), **block the player** (far/close), follow, flee, stop.
Police cruisers are ordinary traffic cars whose mission is set to ram/block
with boosted speed; mission scripting drives every chase, escort and getaway
through the same enum. Distant cars run as simplified "dummy" vehicles snapped
to the path nodes and are promoted to full physics near the player. I could
not fetch the source to quote it (repository out of session scope), so the
enum's exact membership is uncorroborated — but the *shape* is the important
finding: **a tiny closed set of car missions covers everything the genre ever
does with a car**, and pursuit is not a special system, it is `mission =
ram/block` on the standard driver.

## 2.3 Arcade pursuit racers: fairness as a stance

The pursuit-racing lineage (the Need for Speed series is the documented case)
treats chase balance as explicit rubber-banding: pursuers get
**heat-tier performance boosts** and "can very quickly snap back to your
position", and are scripted with **blocking** as well as ramming. Players
notice and resent it when it is crude — a wrecked pursuer "streaking up
behind at extremely high speeds" seconds later — and the newest entries
advertise its removal.

The transferable lesson for a persistent multiplayer city: **catchability is
a design dial, not an emergent fact.** This repo already turns that dial
honestly — cop cars arrive motorised only from a wanted tier
(`police.ts:110`), roadblocks spawn *ahead* of the fugitive's heading
(`police.ts:405`) — and the `ROADMAP.md` C3 gate states the stance outright:
catchable at 3+ stars sometimes, escapable at 1–2 usually. Rubber-banding by
spawn placement (where fresh units appear) reads as fair; rubber-banding by
physics (speeding up existing units) reads as cheating. The originals and
this repo both do the former.

## 2.4 The literature: four models, three already evaluated here

- **Steering behaviours** (Reynolds 1999): seek, flee, arrival, **pursuit
  with target-motion prediction**, offset pursuit, path following, unaligned
  collision avoidance — composable accelerations over a point-mass. The
  vocabulary the whole field uses; the pursuit-with-prediction behaviour is
  the one thing on the list this repo hasn't tried (§4.6).
- **IDM** — the Intelligent Driver Model (Treiber, Hennecke & Helbing 2000):
  one continuous acceleration from desired speed, gap, and closing rate.
  **Implemented** at `traffic.ts:356`, and the comment records why: the
  bang-bang controller it replaced could not follow anything.
- **MOBIL** (Kesting, Treiber & Helbing 2007): companion lane-change model —
  change lanes when the *incentive* (acceleration gained, minus politeness ×
  acceleration imposed on others) clears a threshold and a *safety* criterion
  holds. **Effectively subsumed** here by the ordered lane-preference list
  (`traffic.ts:140`), which was measured against a gated variant over twelve
  seeds (lane discipline, head-on rate, flow — `traffic.ts:124-135`). MOBIL
  earns its complexity on multi-lane highways with speed differentials; at a
  four-tile arterial and 14 ambient cars it would be tuning theatre. ⚠ (the
  judgement, not the model.)
- **Gap acceptance** (junction yielding): the literature's third ingredient
  after car-following and lane-keeping. **Built here, measured, and removed**
  — `traffic.ts:222-239` records that yielding-to-occupied-junction made four
  of five metrics *worse*, because IDM already brakes for crossing traffic
  and a stopped car at a junction mouth is itself an obstacle. "Cheap
  politeness, expensive traffic." This is a real finding worth keeping
  citable: at this density, junction discipline is emergent, not a rule.

---

# 3. Where this project already stands

Assessed against `shared/src/sim/` on this branch. The short version: **jobs
1 and 3 of §1 are built and measured; jobs 2 and 4 do not exist.**

| Capability | Where | Notes |
|---|---|---|
| Lane model with overtaking | `traffic.ts:140` | Ordered preference: kerb lane, inner lane, oncoming-as-last-resort. Measured better than gating the oncoming half. |
| Car following | `traffic.ts:356` | IDM, exact-ops for determinism. |
| Forward sensing | `traffic.ts:263` | One scan returning gap + lead speed + is-person; oncoming traffic reports negative lead speed. |
| Junction traversal | `traffic.ts:202` | Aim at where the lane resumes on the far side — corners become arcs. |
| Route choice | `traffic.ts:409` | Random walk: mostly straight, `turnChance` turns, U-turn only at dead ends (unlike the 1999 game's drivers, these *can* U-turn). |
| Think/act split | `traffic.ts:560` | Routing at 10 Hz staggered, wheel/pedals/physics at 30 Hz — the comment explains why the split lands exactly there. |
| Stuck recovery | `traffic.ts:583` | Wedge counter → bounded reverse; pedestrians get 3× the patience of walls. |
| Population ring | `traffic.ts:597` | Spawn 420–760 px from a player, cull past 1100, weighted kind mix. Same trick as every game since 1997. |
| Carjacking | `traffic.ts:694` | The genre verb; ejects the AI driver. See §4.1 for what's missing. |
| Pursuit driving | `police.ts:289` | Deliberately cruder than traffic — cuts corners, uses both lanes. Corner slowdown, U-turn mode, greedy road-grid detour around buildings (`police.ts:260`), dismount-and-continue-on-foot. |
| Pursuit stuck logic | `police.ts:199` | Not-closing counter (progress projected onto the *target* bearing, not the detour) → reverse → bail out of the car. |
| Roadblocks | `police.ts:405` | Two cruisers across the road ahead of travel, from a wanted tier. |
| Escalation by kind | `police.ts:58`, `data/police.json` | Foot posse → motorised from `carsFromStar`. |
| Service-vehicle jobs | `server/src/economy/jobs.ts` | Taxi fares and ambulance casualties — but **player-driven only**. |

Two things here exceed the originals: IDM following (the originals'
arrow-followers had nothing comparable) and measured lane overtaking. One
thing is leaner by choice: no authored path data at all — everything is
derived from the road tile grid per tick.

---

# 4. The gaps, ranked by genre character lost

## 4.1 Drivers do not react — the biggest visible gap

Pedestrians flee gunfire and roaring engines (`peds.ts:100`, `peds.ts:109`).
**Drivers don't.** Fire a machine gun down a street and every ambient car
continues serene lane-keeping through the massacre; `RESEARCH.md` §3.2 lists
"flee danger and gunfire, sound horns" as ambient-driver behaviour in *both*
originals. And the carjack verb is half-implemented as theatre: `ROADMAP.md`
C2 specified "AI driver ejected (**becomes a fleeing ped**)", but
`tryCarjack` (`traffic.ts:694`) deletes the driver record and nobody climbs
out — the person you dragged from the wheel does not exist.

This is job 2 of §1, and it is where the player is looking when it fails.
What it needs is small: a `panic` flag on `TrafficDriver` set by nearby
`shot`/`explosion` events (the events already exist in `events.ts`), which
swaps the desired speed up, loosens lane preference to any-open-lane, and
biases `chooseDir` away from the threat; plus one `spawnPed`-style command in
the carjack path so the ejected driver lands on the pavement in `flee` mode —
the ped machinery for that already exists (`peds.ts:258`).

## 4.2 No errand driving: nothing can drive *to* anywhere

`chooseDir` is a random walk and `drivePursuit` is a greedy homing missile.
There is **no "drive to X" primitive** — no route, no A* over the road grid.
Every feature on the books that needs one is blocked on the same missing
piece:

- NPC ambulance/fire response to casualties and burning cars (the peds go
  `downed` (`jobs.ts:150`) and only a *player* ambulance ever comes);
- gang cars patrolling their own turf (`RESEARCH.md` §2.2: signature cars on
  their own streets are half of what makes turf legible);
- getaway/escort/chase mission targets for H3 payphone jobs — the mission
  verb list (`RESEARCH.md` §3.1) is mostly "a car that must get somewhere";
- race opponents, if races ever land.

The 2001 game's shape (§2.2) is the right one and fits this codebase almost
embarrassingly well: a **car mission enum** (`cruise | goto | ram | block |
flee`) on the driver record, where `cruise` is today's behaviour, `ram` is
today's `drivePursuit`, and `goto` is A* over drivable tiles (or a
precomputed junction graph — worldgen already knows where junctions are)
producing a waypoint list that the *existing* lane controller consumes: aim
`laneControl`'s pursuit point down the route instead of down the current
cardinal. The controller, the IDM, the stuck recovery all stay. This is one
graph search plus a field, not a new driver.

## 4.3 Gang cars

Gangs hold turf and walk it (`turf.ts`, H1) but own no vehicles, and
`RESEARCH.md` §2.2 is blunt that the signature car is part of a gang's
identity — and that hijacking one is supposed to anger its occupants. With
4.2's `cruise`-constrained-to-turf and the existing hostility machinery
(`respect.ts`), a gang car is mostly data: a `kind`, a turf constraint, and a
carjack consequence (occupants become hostile peds instead of vanishing —
which is 4.1's mechanism reused).

## 4.4 Sirens part traffic

Genre texture with high visibility: ambient cars pull to the kerb and stop
when a siren approaches from behind. The lane-preference list already ranks
the kerb lane first (`traffic.ts:164`); the behaviour is "if a `copcar`,
`ambulance` or `firetruck` with an active driver is behind within N px and
closing, pin the lane choice to kerb and set desired speed 0". Cheap, and it
makes both the player's ambulance job and 4.2's NPC responders read.
⚠ whether the originals did this — not corroborated; the 2013 game does.

## 4.5 Traffic lights: probably keep not building them

The 1999 game auto-built lights at authored junction zones (§2.1). Here,
junction *yielding* was measured out (§2.4) — but lights are a different
mechanism (they batch conflicts in time rather than resolving them by
right-of-way), so the measurement doesn't automatically condemn them.
Still: at `count: 14` ambient cars the junction conflict rate that lights
exist to solve barely occurs, and stopped queues are exactly what the
gap-acceptance experiment showed this city cannot afford. Revisit only if
density rises past the bandwidth gate (`ROADMAP.md` §risks) — and then
measure, as this repo does.

## 4.6 Pursuit sharpening, in order of honesty

1. **Lead pursuit** (Reynolds): aim at the target's predicted position
   (`pos + vel × k`, k capped by distance) instead of current. One line in
   `drivePursuit`'s `want`, makes cruisers cut corners on a fleeing car the
   way a human does. No fairness cost — it's smarter, not faster.
2. **Ramming as a tier behaviour**: `ROADMAP.md` C3's tier 5 promises
   "aggressive ramming"; today ramming is incidental contact. An explicit
   `ram` offset (aim at the target's rear quarter, commit through contact)
   at high tiers only.
3. **Blocking**: the second half of the 2001 enum and the racer lineage —
   overtake, then brake across the fugitive's line. Expensive to do well;
   roadblocks already cover the fantasy at lower cost. Rank it last.

## 4.7 Density as data

One global `count: 14` serves a city with districts of distinct character.
The genre precedent (§2.2) is per-region density; the cheap local version is
a per-district multiplier in `worldgen`/`districts` consulted by the
population ring. Matters more once districts differ in wealth and traffic
should say so (beat-up cars in poor districts is the 2013 game's trick, and
`mix` is already per-kind weighted — a per-district mix override is data,
not code).

---

# 5. Recommendations

Ranked by genre-character-per-effort, sized in this repo's S/M/L convention:

1. **Panic + the ejected driver exists** (S) — §4.1. Event-driven flag,
   existing ped flee mode, one spawn command. Pays off every gunfight and
   every carjack, i.e. the two headline verbs.
2. **Car missions + route follower** (M) — §4.2. A* on the road grid feeding
   the existing lane controller; `cruise|goto|ram|flee` enum. Unblocks four
   planned features; nothing else on this list compounds like it.
3. **Siren yield** (S) — §4.4. Reuses the lane list; makes every emergency
   vehicle — player or NPC — feel like one.
4. **Gang cars on turf** (S–M, after 2) — §4.3. Data plus reuse of 1's
   hostility path.
5. **NPC ambulance response** (S, after 2) — first consumer of `goto`,
   closes the loop G3 opened (a city that *reacts* to casualties instead of
   waiting for a player to monetise them).
6. **Lead pursuit + tiered ramming** (S) — §4.6, items 1–2 only.

Everything above stays inside the standing constraints: deterministic (rng
draws from the sim stream, exact ops), staggered NPC cadence, and the
bandwidth gate measured before committing (`ROADMAP.md` §1 — traffic was
named the phase most likely to breach it, and grew anyway; these additions
add *behaviour*, not entity count, except 4–5 which add a handful).

---

# 6. Open questions

- Whether the 1999 game's green arrows encode per-lane direction or only
  per-block flow — the map-format page 403s; the editor description suggests
  per-block. Answerable from `gtamp.com` when reachable.
- The exact autopilot mission enum of the 2001 game (§2.2 ⚠) — verifiable
  against the re3 source from an environment allowed to read it.
- Whether either original parts traffic for sirens (§4.4 ⚠).
- Whether panic (rec 1) needs a bandwidth check at all — it changes inputs,
  not entity counts, so predicted no, but this repo's rule is measure anyway.
- Per-district density (§4.7): worth doing before or after districts get
  distinct economic character? Pure sequencing, `ROADMAP.md`'s call.

---

# 7. Sources

Read via search-result summaries only (§0). Repo citations inline above.

- [Creating roads (GTA2) — WikiGTA](https://en.wikigta.org/wiki/Creating_roads_(GTA2)) — green/red arrows, no-dead-ends rule, room-to-pass advice
- [GTA2 Editor — WikiGTA](https://en.wikigta.org/wiki/GTA2_Editor) — block info, arrows, traffic-light zones auto-construction
- [GTA2 GMP map file format — GTAMP](https://gtamp.com/gta2/gta2-gmp-map-file-format/) — 403 at proxy; not read
- [Paths (GTA SA) — GTAMods Wiki](https://gtamods.com/wiki/Paths_(GTA_SA)) — node files, lane-count bits, traffic level, node types, flood IDs
- [Paths (GTA SA) — Grand Theft Wiki](https://www.grandtheftwiki.com/Paths_(GTA_SA))
- [Path Nodes — open.mp docs](https://open.mp/docs/scripting/resources/path-nodes)
- [Paths (GTA IV) — GTA Wiki](https://gta.fandom.com/wiki/Paths_(GTA_IV))
- [re3: GTA III, Vice City — GitHub (restored fork)](https://github.com/GTAmodding/re3) — existence and takedown/restoration; source not read from this session
- [Reverse-engineered GTA III source code is back online — PC Gamer](https://www.pcgamer.com/reverse-engineered-gta-iii-source-code-is-back-online/)
- [Steering Behaviors For Autonomous Characters — Reynolds, GDC 1999](https://www.red3d.com/cwr/papers/1999/gdc99steer.pdf)
- [Steering Behaviors — red3d.com behaviour index](https://www.red3d.com/cwr/steer/)
- [General Lane-Changing Model MOBIL for Car-Following Models — Kesting, Treiber, Helbing 2007](https://journals.sagepub.com/doi/10.3141/1999-10)
- [TrafficSimulation (IDM + MOBIL) — GitHub mirror](https://github.com/tsaglam/TrafficSimulation)
- [Faster AI Traffic/Road Fix — gta5-mods](https://ms.gta5-mods.com/misc/gta-v-road-fix) — node speeds as data in the 2013 game
- [More Add-On Traffic (popgroups.ymt) — gta5-mods](https://www.gta5-mods.com/misc/popgroups-ymt) — population pools
- [Sparky's Traffic Overhaul — gta5mod.net](https://gta5mod.net/gta-5-mods/misc/sparkys-traffic-overhaul-1-6/) — popcycle density-by-region
- [AI Traffic Fluidity & Discipline — LCPDFR](https://www.lcpdfr.com/downloads/gta5mods/datafile/21596-ai-traffic-fluidity-discipline/) — `vehicleaihandlinginfo.meta`
- [Need for Speed Hot Pursuit Remastered review — ComicBook.com](https://comicbook.com/gaming/news/need-for-speed-hot-pursuit-remastered-review-blast-from-the-past/) — rubber-banding
- [NFS Heat rubber-band discussion — Steam](https://steamcommunity.com/app/1222680/discussions/0/2288338908683003015/) — heat-tier cop performance boosts
- [Need for Speed III: Hot Pursuit — Wikipedia](https://en.wikipedia.org/wiki/Need_for_Speed_III:_Hot_Pursuit) — police blocking tactics
- [Better Carjacking — gta5-mods](https://ca.gta5-mods.com/scripts/better-carjacking) — driver flee-on-carjack as a celebrated fix
- [NPC Activity — gta5-mods](https://ko.gta5-mods.com/scripts/npcactivity) — ped/driver panic reactions to weapons and reckless driving
