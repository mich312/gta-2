# CAR-AI — research: how cars drive themselves in this genre

A reference on car AI — ambient traffic, pursuit, and errand driving — in
top-down and open-city games, written the same way as `RESEARCH.md`: so design
arguments can cite something concrete. It covers what the genre's landmark
games actually shipped, how games *outside* the lineage solve the same four
problems, what the traffic-engineering and game-AI literature offers, where
this project already stands, and what is missing, ranked by how much genre
character the gap costs.

This is a **research document, not a spec**. `ROADMAP.md` and `FEATURES.md`
own sequencing. Where a recommendation is concrete enough to point at a file,
§6 does so.

## 0. Method and confidence

Same environment constraints as `RESEARCH.md` §0: the community wikis,
`gtamp.com` and `gamedeveloper.com` return **403 at the egress proxy**, so
genre claims come from web-search result summaries (sources in §8) plus
general knowledge. The same markers apply:

- unmarked — corroborated by a search result quoted in §8, **or** read
  directly from this repository's code (cited by `file:line`);
- **⚠** — believed correct but not corroborated by a reachable source; treat
  as a hypothesis to verify before it drives a design decision.

Unlike `RESEARCH.md`, a large part of the subject here is *already built and
measured in this repo* — `shared/src/sim/traffic.ts` and `police.ts` carry
their own experiment notes. Those measurements are first-class evidence and
§4 leans on them.

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
   here is a tuning stance, not an algorithm (§2.3).
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
was painted onto the road. Any per-tick sensing this project does (§4) is
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
  `traffic.json` — see §5.7.
- **Per-archetype driver tuning.** The 2013 game exposes per-vehicle AI
  handling (e.g. `MaxSpeedBrakeDistance` in `vehicleaihandlinginfo.meta`) — a
  bus and a sports car brake differently *as AI*, not just as physics.

**The autopilot mission enum.** ⚠ The reverse-engineered source of the 2001
game (the re3 project — taken down and restored, per §8) shows each car
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

---

# 3. Beyond the lineage: how other games solve the same four jobs

The same decomposition (§1), radically different budgets and stances. Six
cases with usable documentation, each reduced to what transfers.

## 3.1 The open-city racers (Midtown Madness, Midnight Club): the documented sibling

The closest thing to this project with a developer-written postmortem: Angel
Studios' "AI Madness" article (Game Developer, 2001) describes the AI of
Midtown Madness 2 and Midnight Club — open cities with free driving,
ambient traffic, cops, pedestrians and racing opponents. Its architecture,
per the article:

- **The city is a graph plus areas.** Roads are line segments connecting
  intersections; intersections are 2D areas; everything else is "open area",
  with authored **shortcuts overlaid** so opponents can leave the graph on
  purpose. (Compare `RESEARCH.md`-era arrows: same split between *where
  traffic lives* and *where racers may cheat*.)
- **Ambient traffic rides splines.** Cars follow Hermite spline curves
  between road segments, each with **its own speed parameter randomly varied
  around the posted limit** — variance as texture, not simulation.
- **Junctions are a four-stage approval.** Before entering an intersection a
  car checks: the traffic-control state (lights), an **accident manager**,
  whether the next road has **capacity**, and conflicts with other vehicles.
  That is gap acceptance plus admission control — the thing this repo
  measured out at its density (§4, `traffic.ts:222`) —
  and it pays off there because a racing game *wants* queues at lights for
  the player to weave through.
- **Opponents plan alternatives.** The racing AI computes **up to three
  alternative paths around every anticipated obstacle**, builds the option
  tree, and picks the least-time route that stays on-road and unblocked.
  That is the errand-driving job (§1.4) done properly, twenty-five years
  ago, in the same genre shape as this project.
- **Pedestrians have a two-zone reaction:** far zone, anticipate and step
  aside; near zone, hug a wall or dive. (`peds.ts` is already equivalent.)

The lesson: the genre-sibling with the best documentation converged on the
same split this document argues for — dumb data-following circulation,
planning only for the cars that race or chase.

## 3.2 Mafia (2002): traffic law as gameplay

The 2002 game made ambient traffic *rules* player-facing: police ticket the
player for exactly three traffic violations — **speeding, collisions, and
running red lights** — on an offence ladder where minor violations fine and
serious ones (weapons, assault) escalate to arrest or gunfire. It shipped a
**speed-limiter key** so obeying the law is playable rather than tedious.

The lesson cuts both ways. It is the strongest existence proof that ambient
traffic rules can carry *gameplay* (tension while driving wounded through a
red light with a cop watching is the game's signature feeling) — and the
best-documented case of the cost: the realism was "primitive and prone to
weirdness", players found enforcement frustrating enough that the
speed-limiter became famous, and the remake kept the system only softened.
For this project — arcade-paced, multiplayer — the applicable half is the
*witness* structure it shares with `RESEARCH.md` §6 idea 3 (crime must be
witnessed to be punished),
not the law-abiding-by-default half: a game whose core verb is theft cannot
fine its way to fun.

## 3.3 Watch Dogs: traffic as an attack surface

The hacking games invert the relationship: traffic is not backdrop, it is
the thing the *player* manipulates. Hacked traffic lights "enter a flash
mode that confuses drivers and causes them to accelerate", producing
accidents that are **emergent, not canned** — the developers state the
outcome isn't scripted, "unlike other game engines where the designer would
instruct the AI exactly what to do" — and the accident becomes a **chase
breaker** against pursuers. The sequel's civilian behaviour set is famously
**data-driven from spreadsheets**, authored by designers role-playing
scenarios before coding them. ⚠ (403 on the article; from its summary.)

The lesson: a perturbable traffic system is a *weapon system* for free, but
only if drivers genuinely sense and react — a canned swerve can't compound
into a pile-up. This repo's IDM already gives it the first half (cars brake
honestly for whatever enters their path, `traffic.ts:263`); the missing
half is the panic response (§5.1). Note the convergence with this repo's
planned car fittings (`FEATURES.md` G2: oil slick, mines): the genre keeps
rediscovering that pursuit wants player-side countermeasures, whether
bought at a garage or hacked from a phone.

## 3.4 Cyberpunk 2077: a checklist of what players notice

Shipped with rigid, lane-bound traffic and spent three years upgrading it in
public; the 2.0 patch notes are effectively a ranked list of what players
notice about car AI, straight from the developer that got it wrong first:
**lane-switching to avoid obstacles** (the headline fix), better braking and
acceleration in traffic, **density varying by time of day**, drivers avoiding
the player on foot, quest NPCs no longer silently disabling the traffic lane
they occupy, and — the reaction item — "some NPCs now might react
aggressively when you hijack their vehicle".

The lesson is the ordering: of everything a AAA studio could fix, they led
with *obstacle avoidance around a blocked lane* and *hijack reactions* — the
exact two behaviours ranked first for this repo (§5.1, and the lane-preference
overtaking this repo already has, `traffic.ts:140`). Independent confirmation
of the priority order, from the most expensive possible experiment.

## 3.5 City builders and truck sims: the sim-first pole

The opposite stance from everything above: no player-centric illusion at all.

- **Cities: Skylines 1** pathfinds every agent A→B over the real network,
  and **despawns a vehicle whose route breaks** (edit a road, the car
  evaporates) as an explicit anti-gridlock safeguard. **Cities: Skylines
  2** goes further: agents have genuine destinations and needs, route cost
  is a weighted sum of **time, money, comfort and behaviour**, and vehicles
  **re-route dynamically around accidents and jams**.
- **Euro Truck Simulator 2** (SCS dev blog): the studio's own account is
  that AI had "always been a compromise" until they staffed it; their roads
  ship as **prefabs with the AI lane data baked in**, which is why
  roundabouts work — and community documentation agrees the chronic failure
  is **merging**, where the AI "can't see you at certain merge points".

The lesson is the frame, not the techniques. A sim-first city pays for every
car's biography whether or not anyone is looking; an illusion-first city
(every game in §2, and this repo's spawn ring, `traffic.ts:597`) pays only
around players — the correct choice here and not worth revisiting. The two
usable specifics: *despawn-on-inconsistency* is an honest safeguard with
precedent (this repo's cull already quietly demotes AI cars to parked ones),
and *merges/roundabouts are where lane-followers die* — this city's
worldgen has neither, and if it ever grows them, ETS2 says bake the paths.

## 3.6 Racing opponents with personality: the Drivatar pole

Forza's Drivatar is the maximal answer to "opponents that feel like people":
segment the racing line, classify **twelve turn types**, learn per-segment
statistics of a real player's braking, line and consistency, then generalise
so the avatar "drives like you might" on tracks the player never touched.
Recent entries walked it back toward ML-trained-to-be-fast, because faithful
imitation reproduced *faults* players complained about.

Machine learning is out of the question here (deterministic lockstep sim, and
the whole point of `shared/` is replayable exactness) — but the underlying
insight ports cheaply: **variance is personality**. Midtown's per-car speed
variance (§3.1) is the same idea at minimum cost. This repo's drivers
currently share identical tuning; a seeded per-driver jitter on
`cruiseSpeed`, `timeHeadway` and patience (drawn once at spawn from the sim
rng, so it replays) would make traffic read as *drivers* rather than a
fleet, for a handful of bytes per car. ⚠ (that it reads better here is a
hypothesis — but it is the cheapest experiment on this list.)

---

# 4. The literature: four models, three already evaluated here

- **Steering behaviours** (Reynolds 1999): seek, flee, arrival, **pursuit
  with target-motion prediction**, offset pursuit, path following, unaligned
  collision avoidance — composable accelerations over a point-mass. The
  vocabulary the whole field uses; the pursuit-with-prediction behaviour is
  the one thing on the list this repo hasn't tried (§5.6).
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
  citable: at this density, junction discipline is emergent, not a rule —
  though Midtown's admission-control junctions (§3.1) show the same rule
  earning its keep in a game that wants queues.

---

# 5. Where this project already stands

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
| Carjacking | `traffic.ts:694` | The genre verb; ejects the AI driver. See §6.1 for what's missing. |
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

# 6. The gaps, ranked by genre character lost

## 6.1 Drivers do not react — the biggest visible gap

Pedestrians flee gunfire and roaring engines (`peds.ts:100`, `peds.ts:109`).
**Drivers don't.** Fire a machine gun down a street and every ambient car
continues serene lane-keeping through the massacre; `RESEARCH.md` §3.2 lists
"flee danger and gunfire, sound horns" as ambient-driver behaviour in *both*
originals. And the carjack verb is half-implemented as theatre: `ROADMAP.md`
C2 specified "AI driver ejected (**becomes a fleeing ped**)", but
`tryCarjack` (`traffic.ts:694`) deletes the driver record and nobody climbs
out — the person you dragged from the wheel does not exist.

This is job 2 of §1, and it is where the player is looking when it fails —
independently confirmed by Cyberpunk 2077's fix list leading with exactly
these two behaviours (§3.4). What it needs is small: a `panic` flag on
`TrafficDriver` set by nearby `shot`/`explosion` events (the events already
exist in `events.ts`), which swaps the desired speed up, loosens lane
preference to any-open-lane, and biases `chooseDir` away from the threat;
plus one `spawnPed`-style command in the carjack path so the ejected driver
lands on the pavement in `flee` mode — the ped machinery for that already
exists (`peds.ts:258`).

## 6.2 No errand driving: nothing can drive *to* anywhere

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
graph search plus a field, not a new driver. If races ever matter, Midtown's
opponent planner (§3.1 — three alternatives around each obstacle, pick the
cheapest) is the grown-up version of the same primitive.

## 6.3 Gang cars

Gangs hold turf and walk it (`turf.ts`, H1) but own no vehicles, and
`RESEARCH.md` §2.2 is blunt that the signature car is part of a gang's
identity — and that hijacking one is supposed to anger its occupants. With
6.2's `cruise`-constrained-to-turf and the existing hostility machinery
(`respect.ts`), a gang car is mostly data: a `kind`, a turf constraint, and a
carjack consequence (occupants become hostile peds instead of vanishing —
which is 6.1's mechanism reused).

## 6.4 Sirens part traffic

Genre texture with high visibility: ambient cars pull to the kerb and stop
when a siren approaches from behind. The lane-preference list already ranks
the kerb lane first (`traffic.ts:164`); the behaviour is "if a `copcar`,
`ambulance` or `firetruck` with an active driver is behind within N px and
closing, pin the lane choice to kerb and set desired speed 0". Cheap, and it
makes both the player's ambulance job and 6.2's NPC responders read.
⚠ whether the originals did this — not corroborated; the 2013 game does.

## 6.5 Traffic lights: probably keep not building them

The 1999 game auto-built lights at authored junction zones (§2.1), and
Midtown ran full admission-control junctions (§3.1). Here, junction
*yielding* was measured out (§4) — but lights are a different mechanism
(they batch conflicts in time rather than resolving them by right-of-way),
so the measurement doesn't automatically condemn them. Still: at `count: 14`
ambient cars the junction conflict rate that lights exist to solve barely
occurs, and stopped queues are exactly what the gap-acceptance experiment
showed this city cannot afford — Midtown could afford them because a racer
*wants* queues to weave through. Revisit only if density rises past the
bandwidth gate (`ROADMAP.md` §risks) — and then measure, as this repo does.

## 6.6 Pursuit sharpening, in order of honesty

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

## 6.7 Density as data, and drivers as individuals

One global `count: 14` serves a city with districts of distinct character.
The genre precedent (§2.2) is per-region density; the cheap local version is
a per-district multiplier in `worldgen`/`districts` consulted by the
population ring. Matters more once districts differ in wealth and traffic
should say so (beat-up cars in poor districts is the 2013 game's trick, and
`mix` is already per-kind weighted — a per-district mix override is data,
not code).

Same lever, per car: seeded per-driver variance on speed, headway and
patience (§3.6). Midtown shipped it in 1999; here it is a few rng draws at
spawn.

---

# 7. Recommendations

Ranked by genre-character-per-effort, sized in this repo's S/M/L convention:

1. **Panic + the ejected driver exists** (S) — §6.1. Event-driven flag,
   existing ped flee mode, one spawn command. Pays off every gunfight and
   every carjack, i.e. the two headline verbs.
2. **Car missions + route follower** (M) — §6.2. A* on the road grid feeding
   the existing lane controller; `cruise|goto|ram|flee` enum. Unblocks four
   planned features; nothing else on this list compounds like it.
3. **Siren yield** (S) — §6.4. Reuses the lane list; makes every emergency
   vehicle — player or NPC — feel like one.
4. **Gang cars on turf** (S–M, after 2) — §6.3. Data plus reuse of 1's
   hostility path.
5. **NPC ambulance response** (S, after 2) — first consumer of `goto`,
   closes the loop G3 opened (a city that *reacts* to casualties instead of
   waiting for a player to monetise them).
6. **Lead pursuit + tiered ramming** (S) — §6.6, items 1–2 only.
7. **Per-driver variance** (S) — §6.7/§3.6. A few seeded draws at spawn;
   the cheapest experiment here, and honestly droppable if it doesn't read.

Everything above stays inside the standing constraints: deterministic (rng
draws from the sim stream, exact ops), staggered NPC cadence, and the
bandwidth gate measured before committing (`ROADMAP.md` §1 — traffic was
named the phase most likely to breach it, and grew anyway; these additions
add *behaviour*, not entity count, except 4–5 which add a handful).

---

# 8. Open questions

- Whether the 1999 game's green arrows encode per-lane direction or only
  per-block flow — the map-format page 403s; the editor description suggests
  per-block. Answerable from `gtamp.com` when reachable.
- The exact autopilot mission enum of the 2001 game (§2.2 ⚠) — verifiable
  against the re3 source from an environment allowed to read it.
- Whether either original parts traffic for sirens (§6.4 ⚠).
- The full detail of Midtown's accident manager and road-capacity admission
  (§3.1) — the "AI Madness" article itself 403s; read it when reachable, it
  is the single most relevant document to this project found anywhere.
- Whether panic (rec 1) needs a bandwidth check at all — it changes inputs,
  not entity counts, so predicted no, but this repo's rule is measure anyway.
- Per-district density (§6.7): worth doing before or after districts get
  distinct economic character? Pure sequencing, `ROADMAP.md`'s call.

---

# 9. Sources

Read via search-result summaries only (§0). Repo citations inline above.

**The lineage:**

- [Creating roads (GTA2) — WikiGTA](https://en.wikigta.org/wiki/Creating_roads_(GTA2)) — green/red arrows, no-dead-ends rule, room-to-pass advice
- [GTA2 Editor — WikiGTA](https://en.wikigta.org/wiki/GTA2_Editor) — block info, arrows, traffic-light zones auto-construction
- [GTA2 GMP map file format — GTAMP](https://gtamp.com/gta2/gta2-gmp-map-file-format/) — 403 at proxy; not read
- [Paths (GTA SA) — GTAMods Wiki](https://gtamods.com/wiki/Paths_(GTA_SA)) — node files, lane-count bits, traffic level, node types, flood IDs
- [Paths (GTA SA) — Grand Theft Wiki](https://www.grandtheftwiki.com/Paths_(GTA_SA))
- [Path Nodes — open.mp docs](https://open.mp/docs/scripting/resources/path-nodes)
- [Paths (GTA IV) — GTA Wiki](https://gta.fandom.com/wiki/Paths_(GTA_IV))
- [re3: GTA III, Vice City — GitHub (restored fork)](https://github.com/GTAmodding/re3) — existence and takedown/restoration; source not read from this session
- [Reverse-engineered GTA III source code is back online — PC Gamer](https://www.pcgamer.com/reverse-engineered-gta-iii-source-code-is-back-online/)
- [Faster AI Traffic/Road Fix — gta5-mods](https://ms.gta5-mods.com/misc/gta-v-road-fix) — node speeds as data in the 2013 game
- [More Add-On Traffic (popgroups.ymt) — gta5-mods](https://www.gta5-mods.com/misc/popgroups-ymt) — population pools
- [Sparky's Traffic Overhaul — gta5mod.net](https://gta5mod.net/gta-5-mods/misc/sparkys-traffic-overhaul-1-6/) — popcycle density-by-region
- [AI Traffic Fluidity & Discipline — LCPDFR](https://www.lcpdfr.com/downloads/gta5mods/datafile/21596-ai-traffic-fluidity-discipline/) — `vehicleaihandlinginfo.meta`

**Other games:**

- [AI Madness: Using AI to Bring Open-City Racing to Life — Adzima, Game Developer](https://www.gamedeveloper.com/programming/ai-madness-using-ai-to-bring-open-city-racing-to-life) — 403 at proxy; details from search summaries
- [Midtown Madness — Wikipedia](https://en.wikipedia.org/wiki/Midtown_Madness)
- [Mafia (video game) — Wikipedia](https://en.wikipedia.org/wiki/Mafia_(video_game)) — simulationist stance, reception
- [How Police works in Mafia — mafiagame.fandom](https://mafiagame.fandom.com/f/p/3008876316197294630) — the three ticketable violations, offence ladder
- [Traffic Lights Control — Watch Dogs Wiki](https://watchdogs.fandom.com/wiki/Traffic_Lights_Control) — flash mode, chase breaker
- [How Spreadsheets Power Civilian AI in Watch Dogs 2 — Game Developer](https://www.gamedeveloper.com/design/how-spreadsheets-power-civilian-ai-in-watch-dogs-2) — 403 at proxy; from summary
- [Is This The Most Powerful Open-World Game Engine Yet? — Fast Company](https://www.fastcompany.com/3009837/is-this-the-most-powerful-open-world-game-engine-yet) — unscripted traffic-light accidents
- [Update 2.0 — cyberpunk.net](https://www.cyberpunk.net/en/news/49060/update-2-0) — lane-switching, hijack reactions, time-of-day density
- [Every Change In Cyberpunk 2077's 2.0 Update — Kotaku](https://kotaku.com/cyberpunk-2077-update-2-0-patch-notes-skills-cyberware-1850861309)
- [Development Diary #2: Traffic AI — Colossal Order](https://colossalorder.fi/?p=1597) — CS2 agent destinations, cost model, dynamic rerouting
- [Cities: Skylines II Feature Highlight: Traffic AI — Paradox](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai)
- [No Vehicle Despawn mod discussion — Paradox forums](https://forum.paradoxplaza.com/forum/threads/no-vehicle-despawn-mod.1695356/) — despawn as anti-gridlock safeguard in CS1
- [Improvements in traffic AI — SCS Software blog](https://blog.scssoft.com/2011/03/improvements-in-traffic-ai.html) — "AI was always a compromise"
- [ETS2 roads and prefabs — SCS Software blog](https://blog.scssoft.com/2011/03/euro-truck-simulator-2-roads-and.html) — AI lanes baked into prefabs
- [How Forza's Drivatar Actually Works — Game Developer](https://www.gamedeveloper.com/design/how-forza-s-drivatar-actually-works) — 403 at proxy; from summary
- [The Inner Workings of Forza's Drivatar — AI and Games](https://www.aiandgames.com/p/the-inner-workings-of-forzas-drivatar) — twelve turn types, per-segment learning
- [Driving — Sleeping Dogs Wiki](https://sleepingdogs.fandom.com/wiki/Driving) — NFS-derived ram verb

**Pursuit racers and the literature:**

- [Steering Behaviors For Autonomous Characters — Reynolds, GDC 1999](https://www.red3d.com/cwr/papers/1999/gdc99steer.pdf)
- [Steering Behaviors — red3d.com behaviour index](https://www.red3d.com/cwr/steer/)
- [General Lane-Changing Model MOBIL for Car-Following Models — Kesting, Treiber, Helbing 2007](https://journals.sagepub.com/doi/10.3141/1999-10)
- [TrafficSimulation (IDM + MOBIL) — GitHub mirror](https://github.com/tsaglam/TrafficSimulation)
- [Need for Speed Hot Pursuit Remastered review — ComicBook.com](https://comicbook.com/gaming/news/need-for-speed-hot-pursuit-remastered-review-blast-from-the-past/) — rubber-banding
- [NFS Heat rubber-band discussion — Steam](https://steamcommunity.com/app/1222680/discussions/0/2288338908683003015/) — heat-tier cop performance boosts
- [Need for Speed III: Hot Pursuit — Wikipedia](https://en.wikipedia.org/wiki/Need_for_Speed_III:_Hot_Pursuit) — police blocking tactics
- [Better Carjacking — gta5-mods](https://ca.gta5-mods.com/scripts/better-carjacking) — driver flee-on-carjack as a celebrated fix
- [NPC Activity — gta5-mods](https://ko.gta5-mods.com/scripts/npcactivity) — ped/driver panic reactions to weapons and reckless driving
