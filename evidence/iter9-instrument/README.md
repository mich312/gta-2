# Iteration 9 — the instrument, and a restated history

`pnpm mapaudit` read **TOTAL 49 / SCORE 2911.8**. Three iterations had
established that a large part of that measured nothing, and two agents had
declined to correct it because correcting it breaks the loop's only
cross-iteration series. This iteration makes the corrections and pays the
price openly: **both series are restated over every bake the loop has**.

Nothing in `shared/` or `client/` was touched. `citybake --check` is unchanged
at six warnings and the bake is byte-identical.

## The headline

| | TOTAL | SCORE | DRAWN |
| --- | --- | --- | --- |
| before, `bb0aaae` | 49 | 2911.8 | — |
| after | **48** | **2653.8** | **2522.5** |

`mapaudit-before.txt` / `mapaudit-after.txt` are the full runs.

## What SCORE means now

> **SCORE** is the weighted tiles of defect in the **tile plane** — the ground
> as it is baked, which is also what collision drives against. Its meaning is
> otherwise unchanged: it moves when a defect gets smaller without going away,
> it is an area, and it is summed over signatures with the `noisy` ones at
> ×0.25.
>
> **DRAWN** is the part of SCORE a renderer actually puts on the screen. A
> defect can be in the tile plane and painted over: a quay that steps every
> three tiles is repainted against a chord by the coast, bank or deck curve and
> cannot be seen from any camera. Those tiles stay in SCORE, because a renderer
> change can expose them again without one tile of ground moving, and they are
> subtracted in DRAWN, because a reviewer sent to look at them will see
> nothing. SCORE and DRAWN differ only where a signature has measured its own
> drawing, which today is `built-staircase` alone; every other signature is a
> defect in the ground, and ground is drawn.
>
> **TOTAL** is still the count, but it is **no longer comparable back past
> iteration 8** — `country-outside-blocks` now declines a class of region it
> used to report. The restated series below is the continuous one.

## Discount or a column? — the question, answered

Iteration 7 left this open. **A separate column, and not a discount.** The
`built-staircase` magnitude stays exactly `span - count`, and the invisible
staircase — now measured at **525 of its 540 raw tiles, 131.3 weighted** —
stays in SCORE. (Iteration 7 put the invisible part at 402 raw tiles. It is
larger now for two reasons that pull the same way: iteration 8's deck curve
moved the four bridge decks out of the drawn column, and the census fixed
above finally asks the bank chain about the inland quays.)

The deciding argument is `magOf`'s own property 2: *the defect getting smaller
makes the number smaller, and nothing else does*. Iteration 8 moved 149 step
faces from drawn to not-drawn **by teaching three painters a curve, without
moving one tile of ground**. Under a discount, SCORE would have fallen by
about 100 for that — the metric paying out for a repaint at the same rate it
pays for a repair, and unable to tell a reader which had happened. A property
of the drawing is not a property of the map, and mixing them makes the number
mean neither.

The other choice was not free, and here is its cost, stated so a later reader
can reverse this if the trade changes: **SCORE now carries 131 weighted tiles
that nobody can see, in every row of the table, for ever.** A reviewer who
takes SCORE as "how bad does the city look" is over-reading it by 5%. The
mitigation is that DRAWN is printed on the same line, every run, with the
explanation underneath it.

The two corrections are asymmetric on purpose, and this is the distinction:

- `built-staircase` is a **true report of a real fact that is invisible** — the
  steps are in the tile mask, `WORLDGEN.md` §45.5 is open on collision reading
  that mask, and a renderer change could expose them. Column.
- `country-outside-blocks` was a **false report** — the detector claimed ground
  "was never asked what it is" about ground the fill visited and answered. That
  is not a discount question at all; it is a gate that was missing. It now
  fires one fewer, and TOTAL falls with SCORE.

## The three corrections

### 1. `country-outside-blocks` asks the wildness field

The signature's own claim is that the ground *was never asked*. `bake.ts`'s
rule for whether rural country is wood is one line of arithmetic on two
integers, so the audit can ask it directly. A region is now refused when **not
one of its tiles is bare where the wildness field says wood** (`wildBare === 0`).

Zero, not a fraction: it is not a tuning parameter but a statement that the
raster and the rule agree everywhere in that region. It cannot suppress ground
the fill never visited, because unvisited ground keeps the ground pass's meadow
on every tile *including* the ones the field wanted wooded.

`--regions` (new) prints the census it gates on. On the shipped bake:

```
322,740-355,756  Marsh End  land=  507 wood=    0 wild=    0 wildBare=    0 | sized cmp bald .....
```

`wild=0` — the field says meadow on all 507 tiles, which is what
`evidence/iter8-country/` proved at the source by instrumenting the bake. It
is refused. On the pre-iteration-3 calibration bake the same region is refused
and **the other three hits survive**, carrying 661, 203 and 73 tiles of genuine
disagreement.

`fbm` is imported from the built `shared/dist/world/fields.js` rather than
reimplemented — `world/fields.ts` is not on `shared`'s barrel and this tool may
not add an export to `shared/src`. Only the seed, wavelength and threshold are
copied, and control 1 below is the guard against those drifting.

### 2. `built-staircase` stops mislabelling the inland quays

The census behind "is this staircase drawn" only ran where the tile just
outside the outline was `T_WATER`. An inland quay has no such position, so
eight of the twenty-four findings counted **zero** faces, asked the curve layer
nothing, and printed *"faces dry ground, which no coast curve describes, so it
is drawn as it lies"* about edges the **bank** chain covers at every position.

Every profile position is a face now, put to all three chains — coast, bank and
the deck chain iteration 8 added — which is `evidence/iter7/curve-cover.mjs`'s
method. The tool independently reproduces that script's total: **741 of 741
profile positions across 24 edges**.

### 3. The `drawn` column

`drawn` is the share of each finding's `mag` whose faces lie on no chain. On
the shipped bake: **540 tiles of staircase, 15 drawn** — one yard edge at
82,462, on the kerb of a diagonal street, with no chain anywhere near it. The
four bridge decks read 0 drawn of 123 because of iteration 8's curve; with only
that curve removed they go back to 117.

## Also: a control that had been red for three iterations

`--selftest` **exited 1 on the merge-base head**, and had done since
`ce3189b`. `road-deadend` read `SILENT 4 -> 4`.

The plant, not the detector. It asked `findMeadow` for a 16-deep meadow behind
a 14-tile street, clearing three tiles past its cap, while `deadEnds` looks
**six** tiles past a cap before filing it as `road-stops-short` instead.
Iteration 6's rebake moved two blocks, which re-rolled land use city-wide,
which moved the first matching meadow from 459,312 to 439,313 — where the coast
road runs across the plant's line five tiles below the cap. The plant was
laying a perfectly good `road-stops-short`, which is why that signature read
`13 -> 16` when its own plant adds two.

Depth is now `14 + CAP_LOOKAHEAD + 2`, and `CAP_LOOKAHEAD` is the detector's
own constant so the two cannot drift again. `selftest-before.txt` is the red
state as found; break 6 in `red-controls.txt` reproduces it on demand.

## The restated history — both series

`history.txt`, regenerated by `rescore-history.sh`. `--data` decodes any
committed `city.data.ts`, so this needs no worktree per commit.

```
bake                                  TOTAL      SCORE    TOTAL      SCORE      DRAWN
                                   (before)   (before)  (after)    (after)    (after)
e3306c8~2  pre-iteration-3 (calib)       61    16728.5       60    16470.5    16339.3
7769a2c    pre-iteration-5               55     3129.5       54     2871.5     2740.3
ffb2e89    post-iteration-5              55     2926.5       54     2668.5     2537.3
b5c7805    post-iteration-5 (instr)      55     2926.5       54     2668.5     2537.3
ce3189b    post-iteration-6              49     2911.8       48     2653.8     2522.5
cda745a    post-iteration-7 (no map)     49     2911.8       48     2653.8     2522.5
bb0aaae    post-iteration-8              49     2911.8       48     2653.8     2522.5
```

The BEFORE column reproduces every number the loop published, to the decimal,
which is what licenses the AFTER column beside it. Reading the new series:

| iteration | ΔTOTAL | ΔSCORE | ΔDRAWN |
| --- | --- | --- | --- |
| 5 | 0 | **−203.0** | −203.0 |
| 6 | **−6** | −14.7 | −14.8 |
| 7 | 0 | 0 | 0 |
| 8 | 0 | 0 | 0 |

The corrected series tells the same story as the old one — iteration 5 was
visible only to SCORE, iteration 6 only to TOTAL, iterations 7 and 8 to
neither — with 258 weighted tiles of false positive taken out of every row.
**The correction does not change any iteration's verdict.** That is worth
saying plainly: the false positive was constant across the whole series, so it
never moved a delta; it only inflated the level. Iteration 8's "12.3% of SCORE
is measuring nothing" was true of the level and never affected a comparison.

`e3306c8~2` is carried as a calibration bake, older than the series: the defect
is KNOWN present there, so a corrected detector reporting it clean would be a
corrected detector gone blind. It still reports 3 hits and 1512 tiles.

**A caveat that has to be stated.** The DRAWN column on an old bake is what
**today's** renderer would draw of that old map. `buildDeckCut` is code, not
baked data, so running this tool over `7769a2c` asks "how much of the 2024 map
would the 2026 painters show". That is the right question for a re-scored
series — one instrument, seven maps — but it is not a record of what a reviewer
saw at the time. DRAWN before iteration 8 was, on the map as it was then drawn,
about 131 tiles higher.

## The controls, and watching every one of them go red

Nine instruments in this exercise have been caught lying, five found by a
control rather than a failure. `--selftest` gained three, on top of its 18
plants and the half-fix control.

| control | what it holds | red when |
| --- | --- | --- |
| `wildness-field` | `wildAt` against the ground inside rural blocks: 88.3% agreement, gate 75% | the copied seed/wavelength/threshold drift from `bake.ts` |
| `unasked-country` A | the answered-meadow region clears every OTHER gate and is still refused | the gate does nothing |
| `unasked-country` B | a region wooded → silent, stripped bare → fires with `wildBare` > 0 | the gate suppresses a real defect |
| `drawn` A (SPLIT) | at least one finding fully drawn AND one fully dissolved | the census is stuck on one answer |
| `drawn` A0 (WHOLE) | faces asked == profile positions, 741 of 741 | the census asks about part of an edge |
| `drawn` B (UNCOVER) | with every chain blanked, all 540 tiles read drawn | the census is not reading the chains |
| `drawn` C (DECKS) | blanking only `courses` moves the decks 0 → 117 and the quays not at all | the deck chain is not what is being read |

`red-controls.sh` breaks the tool six ways and shows `--selftest` exit 1 each
time; `red-controls.txt` is the run.

**The fifth break is why that script exists.** Restoring the pre-iteration-9
face census — the one-line `if (at(ox, oy) !== T_WATER) continue` — left
`--selftest` **green at exit 0**. SPLIT, UNCOVER and DECKS all passed while
eight inland quays counted zero faces and defaulted to "fully drawn". Four of
five controls firing is four of five. The WHOLE leg was written because of it,
and it catches the break at 502 of 741 positions across 11 partial edges.

## What is in here

| file | what |
| --- | --- |
| `mapaudit-before.txt` / `mapaudit-after.txt` | full `--all` runs on the shipped bake, either side |
| `selftest-before.txt` | `--selftest` as found on `bb0aaae`: **exit 1**, `road-deadend` SILENT |
| `selftest-after.txt` | `--selftest` on this tree: 18 plants, 4 controls, exit 0 |
| `selftest-prefix3.txt` | the same against the pre-iteration-3 calibration bake, exit 0 |
| `red-controls.sh` / `.txt` | six deliberate breaks, every one turning `--selftest` red |
| `rescore-history.sh` / `history.txt` | both series over all seven bakes |
| `regions.txt` / `regions-prefix3.txt` | `--regions`, the census the country gate reads |
| `ci-test.txt` | `node ci/test.mjs`: 93 files, 998 tests, 0 failures |
| `citybake-check.txt` | six warnings, unchanged; the bake is byte-identical |

## Retaking

```bash
pnpm build
node server/dist/tools/mapAudit.js --all
node server/dist/tools/mapAudit.js --selftest
node server/dist/tools/mapAudit.js --regions

sh evidence/iter9-instrument/red-controls.sh      # every control, going red
sh evidence/iter9-instrument/rescore-history.sh   # both series, seven bakes

pnpm build && node ci/test.mjs && node server/dist/tools/citybake.js --check
```

Use `node ci/test.mjs`, never raw `npx vitest` — vitest hangs on an
`onTaskUpdate` starvation signature that `ci/test.mjs` filters. And do not
build while the suite runs: two of its files time out under the contention and
read as failures (they pass alone; measured this iteration).

## Not done, and why

- **`mag` for `country-outside-blocks` is still the neighbours' rate**
  (`land × (inside − outside)`), not `wildBare`. `wildBare` is the truer
  magnitude now that the field is being asked, and switching to it is the
  obvious next step — but it would change the number for every surviving
  finding and confound two changes inside one restatement. The value is printed
  in every finding's reason so the next agent can see both.
- **`drawn` is only measured for `built-staircase`.** Every other signature
  defaults to `mag`, which is honest for a ground defect and would not be for a
  future signature about something a painter can hide. `drawnOf` is where a new
  one plugs in.
