# Using AsyncTI4 match data

How we plan to use human games from AsyncTI4 to improve the agent's
lessons and evals. Nothing here is built yet.

## What is available

AsyncTI4's bot server serves any game by id, without logging in:

- `https://bot.asyncti4.com/api/public/game/pbdNNNN/web-data`: the game's
  current or final state. It covers:
  - the winner, and each player's faction, VP, planets, techs and the
    objectives they scored, with a score breakdown;
  - the map tiles and units, laws in play, and the strategy cards picked;
  - the game's VP target and round.
- `https://bot.asyncti4.com/api/public/game/pbdNNNN/events`: the move
  history. Each event has a type, round, phase, faction, timestamp, payload
  and a snapshot of the map. Event types include turns, tactical actions,
  strategy card picks and plays, research, transactions, card plays and
  objective scores. One recent game had 211 events.
- `https://bot.asyncti4.com/api/public/community/stats`: totals. At the time
  of writing these were 24,753 completed games and about 1,700 active.

Ids run from `pbd1` to about `pbd30561`. There is no listing endpoint, so we
find games by walking the ids. Older games have no events: `pbd5000` returns
an empty list. Where the move history starts is not yet known.

## The catch: content

Nearly every recent game is Prophecy of Kings with Thunder's Edge, and many
use homebrew factions. Every passage and lesson must say which content it
holds for (see "Content scope" in `agent-play-plan.md`). So every game we
import gets a content tag before anything else is done with it:

- **Expansions,** in the engine's terms (`pok`, `codex1`–`codex4`, `te`).
  These are worked out from the factions, strategy card ids (`te6warfare`),
  breakthroughs, tiles and relics.
- **Homebrew:** any faction, tile or card the engine does not have.
  Homebrew games are dropped.
- **Shape:** player count, VP target, and whether the game finished.

A finding only becomes a lesson or eval for the content it was drawn from.
Base-game-only games are likely rare. Most of what we learn will therefore
be scoped to Prophecy of Kings, or to Prophecy of Kings with Thunder's
Edge. The exception is a finding that holds everywhere, which we have shown
across several kinds of game.

## Uses

### 1. Statistics as candidate lessons

Statistics aggregated over finished games, split by content and player
count, turn into lesson drafts. Each draft carries `learnedWith`, and a
human activates it. Questions worth asking:

- **Scoring tempo:** winners' VP by round, and how often they score a public
  objective every round. This tests lesson L6.
- **Mecatol and Imperial:** how often the Mecatol holder takes Imperial,
  and how often that player wins. This tests L4.
- **Slices:** how many of their slice's planets winners hold by rounds 2
  and 3, against the rest of the table. This tests L5. It needs each
  player's slice, from their home position and the map string.
- **Strategy cards:** pick rates by faction and round, with win rates.
  These can check the guides' round-one rankings, and flag where the
  community meta has moved on.
- **Secrets:** which secret objectives winners score, and when. This covers
  action-phase secrets against the rest.

These also give us targets for "Numbers to watch". If we know where human
winners stand in VP after rounds 3 and 6, we can measure the agent against
that.

### 2. Calibrating the checks

The checks from milestone 9 (stranded ground forces, objective budget,
undefended planets, Imperial to the Mecatol holder, early stalls,
gravity-rift cargo) are guesses at mistakes. Run against winners' moves,
they show how strict each check is:

- A check that rarely fires on strong human play is safe to keep in the
  review step.
- A check that fires often is too strict, or there is a reason humans make
  that move that the check misses.

We can start with the checks that only need the map snapshot and an
event's payload, before any full replay exists.

### 3. Eval cases from human decisions

An eval case is a position, a menu and a grade. Human games supply
positions the agent's own games never reach, along with what a strong
player did there. The grade is soft: "agrees with the winner" is a signal,
not a pass/fail, because humans differ and also make mistakes. Good
candidates:

- the round-one strategy pick, given the drafted map and factions;
- the first two tactical actions of round 1, for slice expansion;
- the Imperial pick when another player holds Mecatol Rex.

This needs a converter from AsyncTI4's map and units into our `GameState`.
The converter is only possible for content the engine resolves. Main now
resolves Prophecy of Kings and Thunder's Edge effects, so it is within
reach. We start with the strategy phase, which needs the least state.

## Pipeline

1. **Fetch** (`scripts/async-fetch.ts`): walk an id range at no more than
   one request a second. Cache each game gzipped under `data/async/` and
   send a user agent that names the project. Before bulk fetching, ask the
   AsyncTI4 maintainers: it is a volunteer-run server.
2. **Tag** each game with its content and shape, and drop homebrew and
   unfinished games.
3. **Derive:** compute the statistics, scan human moves with the checks, and
   cut eval cases into `evals/cases.json`. Every case and draft lesson
   records its source game ids and content.
4. **Review:** a human reads the drafts and activates lessons. Eval cases
   are checked by hand before they count.

## Open questions

- Do the maintainers mind bulk reads, and is there a dump or a better
  endpoint?
- Which game id does the move history start at?
- Player skill: can we tell strong players from weak ones (for example by
  their record across games) without storing personal data? We keep
  factions and seats only, never Discord names.
- How many base-game-only or Prophecy of Kings-only games exist, and are
  there enough to tell us anything?
