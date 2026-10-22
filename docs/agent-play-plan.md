# TI4 RAG agent

## Goal

An agent that plays base-game Twilight Imperium 4 through this repo's engine:
an LLM (DeepSeek Flash) chooses each move, with retrieval over the rules,
card data and the SCPT Strategy Guides. The agent gets better over time through its prompts,
its retrieval and lessons learned from its own games. No model weights are
trained.

Out of scope for now: fine-tuning, expansions, and proving effects
statistically (see "Measuring it, later").

## What exists

| Asset | Location | Role |
| --- | --- | --- |
| Rules engine | `app/game/engine/` (`applyAction`) | Pure, validated reducer; the only judge of legality |
| Seat view | `app/game/view.ts` (`viewFor`) | What one seat may see; the agent's only window on the game |
| Pending decisions | `openPrompts` in `engine/helpers.ts` | Off-turn choices (hits, secondaries, votes) |
| Scripted bot v2 | `app/game/agent/scriptedBot.ts` | Opponent, low-stakes decision maker, and planner of concrete moves |
| Game runner | `scripts/scripted-games.ts` | Seeded 6-player games with random factions, seats and maps |
| Corpus | `knowledge/audio/`, `knowledge/manifest.json` | 17 base-game Strategy Guide episodes (2019), one per faction, ~30 hours |

## What the engine cannot do yet

The engine tracks more than it enforces. The agent must not use the escape
hatches, and some of the game is missing:

| Gap | Consequence for the agent |
| --- | --- |
| `ADJUST`, `SET_*`, `COMPONENT_ACTION` bypass the rules | Never offered; rejected if emitted |
| Reactions whose choices cannot be guessed (payments, units to move or build) are offered only as the bot would play them | The agent decides every other reaction, its votes and tie-breaks; the bots still always abstain |
| The engine picks for players in a few agenda outcomes (which ships Arms Reduction destroys, which planets Anti-Intellectual Revolution exhausts) | Rarely matters; noted in the log |
| Expansion content (leaders, exploration, relics, PoK cards) still resolves by hand | Base game only |

Base-game faction abilities, technologies, unit abilities, action cards,
promissory notes, agenda outcomes and laws are resolved by the engine
(`app/game/engine/effects/`, `reactions.ts`, `agenda.ts`). Players use them
in **windows**: at each timing point the engine asks only the players
holding something usable there, and an action card waits while others
decide whether to cancel it with Sabotage. Action-phase secret objectives
are checked against what happened in the current turn.

## How a decision works

```
game loop ──► router ──► low-stakes? ──► scripted bot answers
                │
                └──► agent decision
                       │  system: rules digest + how to play      (cached)
                       │  game:   factions, map, objectives        (cached per game)
                       │  turn:   seat view summary, plan note, candidate menu
                       │
                       ├─ tools: search_guides, lookup, search_lessons, combat_odds
                       └─ choose(candidate, rationale, citations, plan_note)
                              │
                     harness expands the candidate into engine actions,
                     validates with applyAction, logs the decision
```

### The router

The scripted bot handles low-stakes decisions: hit assignment, discards,
token redistribution, tie-breaks, starting units, agenda votes, and steps
inside a move the agent has already chosen. The agent handles the real
choices:

- picking a strategy card,
- what to do on each action-phase turn,
- whether to use a strategy card's secondary,
- research,
- what to score and how to pay,
- whether to retreat,
- trade offers.

Routing rules are code, logged per decision, and easy to change.

### Candidate menu: intents, not raw actions

`MOVE_SHIPS` and `PRODUCE` have huge action spaces, so asking the model for
raw JSON invites illegal or senseless moves. Instead the menu offers
*intents*, each with a concrete plan the harness can carry out:

```
A. Invade Lodor (3/1, cultural) from home: 2 carriers, 4 infantry.  Odds: no combat.
B. Attack Letnev fleet at Arinam: 2 dreadnoughts + 1 cruiser vs 2 cruisers.  Win 78%.
C. Build at home: carrier, 2 infantry, cruiser (6 of 7 resources).
D. Play Technology: research Gravity Drive; second tech Sarween Tools for 6.
E. Move a destroyer next to Mecatol Rex (Intimidate Council 1/2).
F. Pass.
```

The scripted bot's planners already produce these plans: invasion targets,
movement, landings, production orders, research options and payments. The
menu lists the top few of each kind, ranked by the bot, so it shows the
bot's view without deciding. After the agent picks an intent, the harness
plays out its steps (activation, movement, landing, production) through the
bot's step logic and validates each one.

A free-form option (`custom: GameAction`) stays available for moves the menu
misses. It is validated with `applyAction`; an error goes back to the model
once, and after a second failure the bot's top candidate is played.
Free-form use is logged: when it is frequent, the menu is missing something.

### Tools

| Tool | What it returns |
| --- | --- |
| `search_guides(query, faction?)` | Top SCPT chunks with episode, timestamp and `playable` tag |
| `lookup(kind, id)` | Exact data for a faction, unit, technology, objective, strategy card or planet |
| `search_lessons(query)` | Active lessons from past games (see Improving) |
| `combat_odds(system)` | Exact odds for a fight, from `engine/odds.ts` |
| `choose(candidate, rationale, citations, plan_note)` | Ends the decision |

The harness validates every tool call's arguments against its schema (Zod)
and returns a validation error as the tool result, so it does not depend on
the provider enforcing schemas. The model must finish with `choose`: the
system prompt says so, and the harness re-asks once if a response ends
without it. Each decision allows a bounded number of retrieval calls
(about 6).

`plan_note` is a short, free-text plan the agent writes for itself ("take
Mecatol in round 3, hold Imperial"). It is passed into the next decision,
which gives the agent continuity without carrying a whole game of
conversation.

### Model and API

- **Model:** `deepseek-flash` (served as DeepSeek-V4.1-Flash-1017 as of
  October 2026), with thinking mode, its default. It has a 1M-token context
  and supports tool calls and JSON output. Per million tokens, peak /
  off-peak:

  | Price type | Peak | Off-peak |
  | --- | --- | --- |
  | Input, cache miss | $0.30 | $0.15 |
  | Input, cache hit | $0.006 | $0.003 |
  | Output | $1.20 | $0.60 |

  `deepseek-v4-pro` is the stronger, pricier option to compare against.
- **Behind an interface.** The agent talks to a small `Policy` interface
  (`decide(turn) -> Decision`), so the model and provider are configuration.
  Swapping in another model, for comparison or if Flash falls short, should
  not touch the harness. The provider and model are part of `agentVersion`.
- **Client.** DeepSeek's API is OpenAI-compatible at
  `https://api.deepseek.com`, so use the `openai` npm package with that base
  URL. It also offers an Anthropic-compatible endpoint
  (`https://api.deepseek.com/anthropic`).
- **One fresh request per decision.** Each decision is its own short
  conversation: the turn context, a few tool calls, then `choose`. Nothing
  is carried over except `plan_note`. That keeps cost per decision flat and
  sidesteps questions about replaying reasoning across long histories.
- **Manual tool loop.** A plain loop (call, validate and run tools, append
  results, repeat until `choose`), with a hard cap on iterations, gives
  exact control over turn budgets and logging.
- **To check before building:**
  - whether thinking mode needs its reasoning passed back between tool
    calls,
  - which `tool_choice` values are supported,
  - whether tool calls run in parallel.

  The docs don't say. The design works either way: arguments are validated
  locally and `choose` is enforced by re-asking.
- **Prompt caching is automatic.** DeepSeek caches shared prompt prefixes
  with no opt-in, so the prompt order is what matters:
  1. tools,
  2. the system prompt (rules digest, how to read the menu),
  3. the game block (factions in play, map, revealed objectives),
  4. the turn.

  Anything that changes per turn (round, a timestamp) must stay out of the
  first three. Check `usage.prompt_cache_hit_tokens` across decisions.
  Caching is best-effort and cleared after hours to days of disuse.
- **Offline work runs off-peak.** Use off-peak hours (half price) for the
  transcript correction pass, chunk titles and tags, drafting lessons from
  review notes, and checking that citations match the chunks they cite.
  There is no separate batch API to rely on.
- **Failures.** Retry on rate limits and server errors with backoff. If a
  decision still fails (an error, a malformed answer after the retry, or an
  empty response), play the bot's top candidate and log it, so a game never
  stalls.

### Staying honest

- The agent's context is built from `viewFor(state, seat)` only.
- Legality probes and candidate planning may run on the real state, because
  they report only what is legal for the agent's own seat. Anything that
  plays the game forward (rollouts) must run on a state rebuilt from the
  view, with unseen cards reshuffled. Rollouts are not in the first version.
- Blocked actions are filtered from the menu and rejected if emitted.

### Replay log

Every game writes `{seed, setup, agentVersion, actions[], decisions[]}`.
Each decision records:
- the view summary and the menu,
- the tool calls and their results,
- the choice, rationale, citations and plan note,
- token usage and latency.

The game can be replayed exactly from the seed and actions. `agentVersion`
hashes the model, effort, prompts, routing rules, index build, lessons set
and bot version.

## Knowledge

### Rules digest

A compact system-prompt section, written once and then cached:
- turn structure, the action types, combat steps, and scoring and payment
  rules,
- what the engine does not support (the gaps table, in plain words).

Exact numbers stay out of the prose: the agent gets them through `lookup`,
which reads `app/game/data/generated/`.

### SCPT index

1. **Transcribe** with Parakeet TDT 0.6B v3 (FluidAudio, local); store word
   timings as gzipped JSON in `knowledge/transcripts/`.
2. **Correct proper nouns.** Build a glossary from the base-game data
   (factions, leaders, technologies, planets, units), run an exact and fuzzy
   alias pass, then one batch LLM pass limited to proper nouns.
3. **Chunk** by topic, not by fixed size. Give each chunk a title, a summary,
   a faction, a game phase and a topic.
4. **Tag playability.** A chunk is `playable` if its advice can be acted on in
   this engine, and `unplayable: <reason>` if it relies on something the
   engine leaves out (see the table above). The agent sees the tag.
5. **Index** in SQLite with FTS5 (`knowledge/knowledge.db`, rebuildable):
   `episodes`, `chunks`, `chunks_fts`, `glossary`, `lessons`, `lessons_fts`.
   Add embeddings only if keyword search proves too weak.

### Lessons

Lessons are short, checkable heuristics learned from the agent's own games:
for example, "don't leave home without ships while an enemy carrier is two
moves away".
- `knowledge/lessons.jsonl` is tracked and is the source of truth; the index
  build loads it into the `lessons` table.
- A model may draft a lesson from a review note (as `draft`); only a human
  makes it `active`.
- Each has an id (`L3`), a status (`draft`, `active`, `retired`), the
  heuristic, an optional why, topics, and dates; `scripts/lessons.ts`
  keeps the file, and only active lessons reach the agent.
- Lessons record where they came from (game and decision) and are retired,
  never deleted.

### Content scope

The engine plays the base game, and each expansion or codex is turned on or
off per game (`state.options.expansions`: `pok`, `codex1` to `codex4`,
`te`). A card's text, and whether advice about it holds, depends on which
printing is in play. The engine already tags every component with its
`source`. Knowledge carries the same tags (`app/knowledge/scope.ts`):
- **Where it came from.** Every source records the content its games were
  played with: `recordedWith` on each guide episode (all 17 are `[]`: base
  game, before Prophecy of Kings), and `learnedWith` on each lesson, read from
  the game's replay log.
- **Where it holds.** A passage or lesson can carry a `scope`: `needs` (content
  it is about, which must be on) and `voidedBy` (content that replaces what
  it is about), plus a note naming the component or printing. Without a
  scope it holds everywhere.
- **What the agent sees.** Search returns only what holds for the game's
  content, and shows the note. When a game has content a guide was not
  recorded with, the results say so.

What is tagged so far:
- 121 passages about the base Warfare or Construction cards are voided by
  Thunder's Edge, which reprints both. Lesson L7 (Warfare's double expansion)
  is too.
- 3 passages need Codex I: Magen Defense Grid Ω (Mentak, Yin's PDS fortress)
  and the X-89 Ω combination with Harrow (L1Z1X).
- 4 passages carry a note but hold everywhere: Ω printings the guides mention
  in passing (Magen Defense Grid, Greyfire Mutagen, Wormhole Generator).

Rule for new sources: no source joins the knowledge base without recording
the content its games were played with. Games from other sites qualify only
when that content matches ours or is tagged. For example, recent AsyncTI4
games (bot.asyncti4.com/api/public/game/pbdNNNN) are nearly all Prophecy of
Kings with Thunder's Edge, and often homebrew factions. They teach nothing
about base-game play without that tagging.

Two points about engine data found along the way:
- Diplomacy's only printing is tagged `codex1`, and Construction's is tagged
  `pok`. Base games use them on purpose: `strategyCardsFor` treats the
  errata'd cards as shipping in every box. The Saar guide's "Codex
  Diplomacy" is therefore the one we play.
- Yin Spinner exists only as its Ω printing, tagged `base`. Whether the
  engine's other single-printing cards (Greyfire Mutagen, Wormhole Generator)
  are the original or Ω text is unchecked. Their passages tell the agent to
  look the card up.

## Watching and improving

### Seeing what it does

- **Live mode:** `scripts/agent-play.ts --approve` prints each agent
  decision (menu, choice, rationale, citations) and waits for approve or
  override before playing it.
- **Replay page:** steps through a logged game with the board and a card per
  decision. Each card is rated on the move (agree / prefer another), the
  rationale (sound / right move for the wrong reason / wrong) and the
  failure type:
  - board misread,
  - rule error,
  - menu missing the right move,
  - bad advice,
  - judgment,
  - routing.

### The loop

1. Play a batch: one agent seat against five scripted bots, rotating the
   agent's seat.
2. Review the decisions that look worst: big VP or fleet swings, free-form
   moves, retries, and choices that differ sharply from the bot's top
   candidate.
3. Count failure types and fix the most common:

| Failure | Change |
| --- | --- |
| Board misread | The turn summary or the menu text |
| Rule error | The rules digest or `lookup` |
| Menu missing the right move | Candidate generation |
| Bad advice | Retrieval queries or tags |
| Judgment | A lesson, the prompt, or effort |
| Routing | The router |

4. Record each change in `docs/agent-changelog.md`: version, what changed,
   why, and before-and-after numbers.

### Numbers to watch

- **Agent seat:** VP share (seat VP / total VP), VP after round 6, and how
  often it wins against five bots.
- **Mechanics:** free-form rate, retry rate, and refusals.
- **Cost:** tokens and cost per decision and per game, and cache hit rate.
- **Retrieval:** citation rate, and how often the agent cites `unplayable`
  advice.

These are for steering, not proof; a batch of 20 games is noisy.

## Milestones

1. **The agent plays a whole game, without retrieval.**
   - Router, intent menu from the bot's planners, `choose` and `lookup`
     tools, rules digest, `plan_note` and replay log.
   - Block the escape hatches at the agent boundary.
   - Done when the agent finishes games against five bots without stalls,
     and cost per game is measured.
2. **Watchable.** `--approve` mode and the replay page with decision cards.
3. **Knowledge.** Transcription, glossary correction, chunking with
   playability tags, the FTS5 index, `search_guides`, and citations in
   decisions and on the cards.
4. **Lessons.** Done: `knowledge/lessons.jsonl` (seeded with eleven
   active lessons from the October reviews), loaded into `lessons` and
   `lessons_fts` by `tsx scripts/kb.ts index` (or alone by
   `tsx scripts/kb.ts lessons`); a `search_lessons` tool over active
   lessons, which the agent can cite as `[L3]`, and the best-matching
   lessons in each briefing; `scripts/lessons.ts` to read a reviewed
   decision, draft a lesson from it, list, activate (human) and retire;
   and `docs/agent-changelog.md`.
5. **Faction abilities** (an engine track). Done for the base game, along
   with action cards, promissory notes and agendas. The agent decides its
   own reactions, votes, speaker tie-breaks and free research
   (`app/game/agent/choices.ts`): at each window where it can use
   something, its menu lists each play the engine accepts, with targets,
   and Pass; on a vote it can abstain, or vote for each outcome with the
   fewest planets that would lead or with all of them. Windows with
   nothing usable stay with the bot.
6. **Stronger bot.** Fighting back for lost planets, a deliberate plan for
   Mecatol and Imperial, and spending idle tactic tokens. A stronger
   opponent makes the agent's wins mean more and gives it better menu
   candidates.
7. **Table talk.** Public and private chat between players, so they can
   make and remember non-binding deals, such as a free commodity refresh
   for a trade good later, or staying out of each other's slice.
   - Messages and a deal log live with the game (not in the engine's
     rules), shown in the web app and in each player's turn block.
   - The agent gets tools to post a message and to propose, accept or
     drop a deal, and sees its open deals and who has kept or broken
     theirs.
   - Bots answer from simple rules: accept deals that pay, keep them
     unless keeping them costs more than they are worth, and remember
     who broke one.
   - Replaces the hard-coded "owe one for a free refresh" convention in
     `app/game/agent/conventions.ts`, which then becomes one deal among
     many.
   - Done when the agent can strike a refresh-for-a-trade-good deal in
     one round, collect it in a later one, and the history shows both.
   - **Done.** `app/game/agent/talk.ts` keeps messages (public or to one
     player), deals and a log of what happened to them, beside the game.
     A deal has plain-text terms and the parts the table checks: a free
     refresh when the other side plays Trade, trade goods paid later as
     the surplus of a trade (from a due round on), and a truce (neither
     activates a system in the other's slice or holding the other's
     units or planets). Deals are proposed, accepted, then kept, broken
     or dropped; a debt nobody had the chance to pay (never neighbours
     with something to pay) lapses instead of breaking.
   - The agent has `post_message`, `propose_deal`, `accept_deal` and
     `drop_deal` while planning and deciding; none ends the decision. Its
     turn block gains a "Table talk" section: recent messages it may
     read, its open deals and proposals, and everyone's kept/broken
     record.
   - Bots answer at once: they accept deals that pay (a refresh is worth
     the commodities it replenishes) from players who have broken none,
     pay debts of up to 2 trade goods (what they reckon their word is
     worth) unless the creditor broke a deal, hold a truce unless one
     activation gains more than 6, and leave players who broke a deal
     out of their free Trade refreshes.
   - The old convention is now the standard deal: letting a player
     replenish for free offers them "a trade good later" (due by the end
     of next round) unless another deal was struck, and taking the
     refresh accepts it. A refresh that replenishes nothing is dropped.
   - The replay log keeps `talk` (messages, deals, events); each move's
     note carries what was said and agreed with it, shown on the web
     app's new Talk tab and in the history's reasoning. Notes that carry
     only talk have an empty choice. `--policy first` games keep 0
     fallbacks; most standard deals are kept.
   - Not yet: bots do not propose deals of their own beyond the standard
     refresh, or read messages; text-only deals are recorded but not
     checked, and a bot declines them.
8. **Drafting.** An agent that drafts like a competitive player: in a
   Milty draft it picks a faction, a slice and a speaker position in turn,
   weighing each faction against the slices left (does the slice suit
   what the faction needs: plastic for Ghosts, influence for Barony),
   neighbours, and what others have already taken.
   - Today `draftedSetupFor` deals balanced Milty slices and factions at
     random; drafting replaces the dealing, so the seat, slice and
     faction come from picks.
   - The SCPT guides already rate factions and say what each wants from a
     slice, so the drafter can search them like the player does.
   - Bots draft by simple rules (best slice value left, then a faction
     that fits it) so a table of bots and one agent can draft together.
   - Done when the agent's picks come with a rationale a reviewer agrees
     with, and games on drafted setups show seat-to-seat balance close to
     the dealt ones.
9. **Checks and evals.** Known mistakes, found in reviews, written once as
   rule-based checks and used twice: to grade the agent offline and to
   warn it in play.
   - **Checks** (`app/game/agent/checks.ts`) are predicates over (state,
     seat, chosen action) that return a plain-English warning: a build
     that strands its ground forces (or a carrier with nothing to carry),
     a move that leaves a public objective the seat could score this round
     unpaid at the status phase, a planet left empty within reach of
     another player's carriers, a strategy pick that leaves Imperial to the
     Mecatol Rex holder, a stall in rounds 1-3, and ground forces carried
     through a gravity rift when a way around exists.
   - **Evals** (`evals/cases.json`, `app/game/agent/evals.ts`,
     `scripts/eval.ts`): a case is a decision rebuilt exactly from a replay
     log (tracked, trimmed and gzipped in `evals/fixtures/`) at a move,
     with the checks its choice must not trip, and optionally options to
     choose or avoid, rationale patterns that mark a misreading, and the
     lesson it relates to. The runner asks a policy each case N times and
     reports pass rates and cost; `scan` lists a log's choices that trip a
     check, to find new cases, and `fixture` cuts a log down for one.
   - **Review in play:** after the agent chooses and before the move is
     played, the checks run on its choice. If any fire, it is asked once
     more with the warnings ("Keep it, or choose again?") and may keep its
     move, saying why, or change it. Warnings, never vetoes. The decision
     record says which checks fired, whether the move changed and why;
     `agent-play` sums them up. On by default (`--no-review` to skip); the
     first-candidate policy keeps its choice, so bot play is unchanged.
   - Grows with the loop: each mistake a review finds becomes a check (or
     an option to avoid) and a case, so a fix is measured before and after,
     and the case keeps it fixed. Pass rates over a handful of cases are
     for steering, like the other numbers here, not proof.
   - Done when every reviewed mistake class has a check and a case, and a
     change to the prompt, lessons or menu is judged by its eval pass rate
     as well as by games.
10. **Human match data.** Learn from AsyncTI4's public games as well as the
    agent's own. See `docs/async-match-data.md`.
    - **Fetch and tag** (`scripts/async-fetch.ts`): read games politely and
      cache them. Ask the maintainers before any bulk read. Tag each game
      with its content (expansions in the engine's terms), player count and
      VP target. Drop homebrew and unfinished games. Nothing reaches lessons
      or evals untagged (see "Content scope").
    - **Statistics as lesson drafts:** for each kind of content, measure:
      - winners' VP by round;
      - how often the Mecatol holder takes Imperial, and what that does to
        their win rate;
      - slice holding by round 3;
      - strategy card picks.

      These test lessons L4–L6 and the guides' round-one rankings. They also
      set human targets for "Numbers to watch". Findings become draft
      lessons with `learnedWith`, which a human activates.
    - **Calibrating the checks:** run the milestone 9 checks on winners'
      moves. A check that often fires on strong play is too strict, or it
      misses a reason humans have.
    - **Eval cases from human decisions,** such as the round-one strategy
      pick, the round-one expansion and the Imperial pick. Each is graded
      softly, as agreement with the winner. They need a converter from
      AsyncTI4's game state into `GameState`, starting with the strategy
      phase.
    - Done when:
      - games are fetched, tagged and cached;
      - at least one lesson has been confirmed or retired on human data;
      - each check's firing rate on winners' moves is known;
      - the eval set has human-decision cases for the content we play.

## Measuring it, later

When it is time to make claims ("retrieval helps", "lessons help"), the
earlier review of this design lists what is needed:

- **Fixed comparisons.** Pick the comparison in advance (for example, no
  retrieval against retrieval).
- **Matched dice.** Derive dice from the situation (round, system, combat
  round, player) so paired games share them.
- **A real puzzle set.** Hundreds of reviewed positions, answered blind by
  two reviewers.
- **Enough games.** About 250 games per condition to detect a 0.5 VP
  difference.

None of this blocks building the agent.
