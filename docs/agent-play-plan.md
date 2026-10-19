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
| `PLAY_ACTION_CARD` discards without resolving | Action cards are drawn but not played |
| `PLAY_PROMISSORY_NOTE` logs without effect | Notes are not played; trades are goods only |
| Agenda outcomes only raise a "resolve by hand" prompt | Votes change nothing |
| "Manual" objectives score without a check | The agent may only claim objectives the engine can check |
| **Faction abilities are not implemented** | Factions differ only in units, technologies, starting position and combat modifiers |

The last row matters most: most of each SCPT episode is about its faction's
abilities. Implementing them is a parallel engine track (Milestone 5), and
the retrieval index tags advice the engine cannot play yet, so the agent
knows not to act on it.

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
   this engine, and `unplayable: <reason>` if it relies on faction
   abilities, action cards, agendas or promissory notes. The agent sees the
   tag. As abilities are implemented (Milestone 5), re-tag those chunks.
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
- Lessons record where they came from (game and decision) and are retired,
  never deleted.

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
4. **Lessons.** The lessons file and table, `search_lessons`, drafting
   lessons from reviews, and the changelog.
5. **Faction abilities** (an engine track, parallel from Milestone 1).
   Implement the abilities that most change how a faction plays, starting
   with:
   - Sardakk Orbital Drop,
   - Mentak Pillage,
   - Arborec Mitosis,
   - Nekro Assimilate,
   - Muaat Star Forge,
   - Yssaril Stall Tactics,
   - Xxcha Peace Accords,
   - Saar Scavenge.

   Re-tag the matching chunks as each lands.
6. **Stronger bot.** Fighting back for lost planets, a deliberate plan for
   Mecatol and Imperial, and spending idle tactic tokens. A stronger
   opponent makes the agent's wins mean more and gives it better menu
   candidates.

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
