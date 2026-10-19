# Agent Play: TI4 agents that decide moves from engine state and SCPT knowledge

## Goal

Build a headless harness in which agents play base-game Twilight Imperium 4
through the existing engine, making decisions using two knowledge sources:

1. **Structured rules and card data** already in this repo.
2. **Strategy judgment** distilled from Space Cats Peace Turtles (SCPT).

The primary deliverable is evidence, not a demo: does retrieved strategy
knowledge measurably improve play over a competent scripted bot, as judged by
both game outcomes and expert review of individual decisions?

## Scope: base game only

Every game runs with `expansions: []`. That switches off leaders, exploration,
relics, the Prophecy of Kings agenda changes and the PoK factions, and it
matches the corpus: the SCPT Strategy Guides were recorded in 2019 for the
base game. Expansions are out of scope until the base-game results are in.

## What the repo already provides

| Asset | Location | Why it matters |
| --- | --- | --- |
| Pure validated reducer | `app/game/engine/index.ts` (`applyAction`, `settle`) | Legal-move oracle; returns `{ok:false,error}` without mutating state |
| Typed action space | `app/game/actions.ts` (`GameAction`) | ~35-variant union the agent emits as JSON |
| Per-seat projection | `app/game/view.ts` (`viewFor`) | Hides other hands, deck order, RNG; prevents cheating by construction |
| Pending-decision queue | `app/game/engine/helpers.ts` (`openPrompts`) | Off-turn decisions (hits, votes, secondaries) are first-class |
| Headless harness | `app/game/engine/testing.ts` | `testGame`, `skipSetup`, `autoplay`, `play`, `rejection` |
| Test bot | `app/game/engine/testing.ts` (`botMove`) | Drives tests forward; **not** a usable baseline (see Phase 1) |
| Expansion switch | `app/game/engine/setup.ts` (`createGame`) | `expansions: []` gives a base-game deck, faction pool and setup |
| Structured game data | `app/game/data/generated/*.ts` | Exact faction, ability and tech data for glossary and lookup |

### What the engine does not enforce

The engine is partly a tracker. These actions bypass rules enforcement and
exist for human tables to fix up state by hand:

| Action | Problem for an agent |
| --- | --- |
| `ADJUST` | Arbitrary state edits, including VP |
| `SET_EXHAUSTED`, `SET_LEADER`, `SET_BREAKTHROUGH` | Toggle card state without paying for it |
| `COMPONENT_ACTION { description }` | Free text; no effect is applied |
| `PLAY_ACTION_CARD { card }` | Discards the card; its effect is not resolved |

Agents never see these in their candidate menu, and the harness rejects them
if emitted. Consequence: **action cards and component actions are out of the
experiment.** Agents still draw action cards (they count toward hand limit and
discards) but cannot play them. This is a known distortion of the game,
applied equally to every condition.

Two more gaps shape the experiment:

- **Agenda effects are not resolved.** Voting works, but the outcome only
  raises a `resolve` prompt for the table to apply by hand. Agendas never
  award VP or change state, so agenda play is out of the experiment too.
- **Manual objectives score unchecked.** Objectives the engine cannot verify
  (several secrets, such as Destroy Their Greatest Ship) are accepted by
  `SCORE_OBJECTIVE(S)` without any check. The harness rejects an agent's
  claim to an objective whose status is `manual`.

The VP left in play comes from public objectives, checkable secrets, the
custodians token and Imperial with Mecatol Rex.

## Architecture

```
SCPT audio ──► Parakeet ──► raw transcript ──► glossary correction ──► chunks ──┐
                                                                                │
knowledge/lessons.jsonl ──────────────────────────────────────────► lessons ───┤
        ▲                                                                       ▼
        │                                                     SQLite + FTS5 index
        │                                                                       │
        │   repo game data ──► exact lookup ────────────────────────────────────┤
        │                                                                       ▼
        │                     observe ──► retrieve ──► decide ──► validate ──► log
        │                                                                       │
        │                                         ┌─────────────────────────────┤
        │                                         ▼                             ▼
        └──────────── human-approved ─── decision review UI       replay + evaluation
                                                  │
                                                  ▼
                                      puzzle set (dev / held-out)
```

Knowledge flows one way within a game. Nothing in the agent loop writes back
to the index. Between games, the review step can add **lessons**: short,
human-approved notes learned from playthroughs. They live in a tracked file,
are loaded into their own table next to the strategy-guide chunks, and only
change when the index is rebuilt. Puzzles are an evaluation input, never a
retrieval source.

## Build order

The knowledge base is the hypothesis, so it is built last. First prove the
harness, the baseline and the evaluation can tell good play from bad. If an
LLM with no knowledge base cannot handle the action space, retrieval will not
rescue it.

1. Phase 1 — Scripted bot
2. Phase 2 — Agent harness (no knowledge base)
3. Phase 3 — Decision review and puzzle set
4. Phase 4 — Corpus, glossary and knowledge index
5. Phase 5 — Evaluation
6. Phase 6 — Improvement loop (runs continuously from Phase 3 onward)

## Phase 1 — Scripted bot

`botMove` exists to push tests forward. It picks strategy cards by
`state.version % cards.length`, always produces nothing, never bombards, and
activates systems when `version % 3 !== 0`. Beating it proves nothing, and a
rollout driven by a bot that never builds measures noise.

Write `app/game/agent/scriptedBot.ts`, a deterministic heuristic player that is
used in three roles:

- **Baseline** — the condition every LLM agent must beat.
- **Reflex tier** — answers forced and low-stakes prompts for LLM agents.
- **Rollout policy** — plays forward from candidate moves (Phase 2).

Minimum competence:

- **Strategy phase:** fixed priority list per card, adjusted for what is
  scorable (e.g. Imperial when holding Mecatol or a scorable public).
- **Expansion:** activate the highest-value adjacent uncontrolled planet
  system the fleet can reach and the ground forces can take.
- **Production:** spend available resources each round; carriers and infantry
  early, warships when an enemy fleet is within reach.
- **Combat:** reuse `suggestAssignment`; retreat when the exact odds in
  `app/game/engine/odds.ts` fall below a threshold.
- **Tech:** follow one colour toward a faction-appropriate unit upgrade.
- **Scoring:** score the cheapest eligible public and any met secret every
  status phase.
- **Agenda:** vote for the outcome that helps it, or abstain.

Acceptance, measured with `tsx scripts/scripted-games.ts 20` (6-player
scripted-vs-scripted games, seeds 1–20, base factions drawn per seed):

- At least 90% of games end by a player reaching 10 VP, not by the public
  objectives running out after round 9.
- The median VP win comes by round 8.
- Fewer than 0.1% of moves fall back to `botMove`, and none is illegal.

The bar sits below a human table's pace (10 VP by round 6–7) because the
reduced game has fewer VP sources: no agendas and no action cards. Track the
mean leader VP by round alongside these numbers; it is the most sensitive
signal when tuning. Keep `botMove` untouched for the existing tests.

Status (scripted bot v1): 60–75% of games end by VP, median VP win in round
9, leader averages 6.2 VP after round 6, no fallbacks. Not yet passing.

## Phase 2 — Agent harness

New entry point: `scripts/agent-play.ts`, run with `tsx`.

```ts
for (;;) {
  const view = viewFor(state, seat);
  const prompt = openPrompts(state).find((p) => p.player === seat);
  if (!prompt && state.activePlayer !== seat) { /* not our decision */ }

  const decision = prompt ? describePrompt(prompt) : describeTurn(view);
  if (isReflex(decision)) { play(scriptedBot(state, seat)); continue; }

  const context = retrieve(decision, view);           // empty until Phase 4
  const candidates = enumerateLegal(state, seat)       // applyAction probes
    .filter((a) => !BLOCKED.has(a.type));              // see "does not enforce"
  const rollouts = rollout(state, seat, candidates);   // scripted bot forward
  const choice = await policy.choose(decision, context, candidates, rollouts);

  const result = applyAction(state, seat, choice.action);
  if (!result.ok) { retry with result.error; else fall back to scriptedBot; }
  log({ state, seat, decision, candidates, rollouts, choice, result });
}
```

`policy.choose` returns a structured decision, not just an action:

```ts
type Decision = {
  action: GameAction;
  rationale: string;            // why, in board terms
  alternatives: { action: GameAction; rejectedBecause: string }[];
  citations: (
    | { kind: "guide"; episode: number; startMs: number }
    | { kind: "lesson"; lessonId: string }
  )[];
};
```

The rationale and alternatives cost a few hundred tokens per decision and are
what make Phase 3 possible.

### Levers

1. **Two-tier policy.** Route forced and low-stakes prompts (hit assignment,
   discards, tie-breaks, redistribution, secondaries the bot would always take)
   through the scripted bot. Spend the model on real choices: strategy card,
   activation, Mecatol, tech path, scoring payment, contested votes.
2. **Candidate enumeration.** `applyAction` is pure and cheap, so probe
   candidates and hand the model a menu of legal moves. The model chooses
   instead of guessing syntax.
3. **Rollout.** For each of the top few candidates, let the scripted bot play
   forward to the end of the round on several seeds and report the mean VP
   and resource deltas next to the retrieved advice.

### Replay

Every game writes `{seed, setup, agentVersions, actions[], decisions[]}`.
Seeds plus an action log make games exactly reproducible and give head-to-head
matches with only one seat changed.

`agentVersions` records, per seat, a hash of everything that can change the
agent's behaviour: model id, prompt templates, reflex routing rules, rollout
settings, retrieval settings, the index build (guide chunks and the active
lessons set) and the scripted-bot version. Every result is attributable to a
version.

## Phase 3 — Decision review and puzzle set

Win rate is a slow, noisy signal. Expert review of individual decisions is
fast and says *why* an agent is weak.

### Review UI

A route in the app that loads a replay log and steps through the LLM's
decisions (reflex-tier decisions are hidden by default). Each decision renders
as a card:

```
Round 3, action phase — Hacan, 4 tactic / 2 fleet / 3 strategy
[board rendered at this point in the replay]

Chosen: ACTIVATE_SYSTEM 26 (Lodor) → move 2 carriers + 4 inf
Rationale: secures a 3-resource planet for Diversify Research; Sol is 2 away
           with fleet pressure but no carrier lane.
Cited: SCPT Ep118 @ 41:12 "Hacan wants trade goods early…"
Rollout: +0.6 VP / end of round (vs pass: +0.1)

Alternatives considered:
  B. Take Imperial (Mecatol)  — rejected: Letnev dreadnoughts adjacent
  C. Pass                     — rejected: wastes a tactic token

Move:      [Agree] [Prefer B] [Prefer C] [Other…]
Rationale: [Sound] [Right move, wrong reason] [Wrong]
Failure:   [Board misread] [Rule error] [Menu] [Bad advice] [Judgment] [Routing]
Note: ________
[Draft a lesson from this note]
```

Rate the move and the rationale separately. "Right move, wrong reason" catches
the two failure modes this project cares about: board-blind podcast advice and
strategy opinion presented as a rule. The failure category is required when
the reviewer disagrees; Phase 6 uses it to choose what to change next.

Reviews are stored next to the replay as `{gameId, decisionIndex, verdict,
preferred?, rationaleVerdict, failure?, note}`.

### Puzzle set

Every review where the reviewer chose a move becomes a puzzle: a serialized
game state, the seat to move, the candidate menu and the expert's preferred
action (plus acceptable alternatives). Puzzles are stored in
`knowledge/puzzles/` as JSON and are tracked.

Each puzzle is assigned to one of two splits when it is created:

- **Dev** — visible while diagnosing failures and writing lessons.
- **Held-out** — never inspected while changing the agent. Only held-out
  scores decide whether a change ships. Roughly a third of new puzzles go
  here, assigned by hash of the puzzle id so the split is stable.

Held-out puzzles are rotated into dev periodically as new ones arrive, so the
held-out set stays unseen without becoming stale.

Every agent version is scored against both splits: agreement rate, plus
rationale ratings where a reviewer has rated that version. This is cheap,
repeatable and directly comparable across conditions.

### Live mode

`scripts/agent-play.ts --approve` pauses on each non-reflex decision, prints
the decision card and waits for approve or override. Overrides are applied to
the game and logged as reviews. Play a few full games this way early to find
where the agent breaks before running anything at scale.

## Phase 4 — Corpus, glossary and knowledge index

### Corpus: the original Strategy Guide series

SCPT published faction material in several generations. The **Strategy
Guides** (eps. 097–163) are one episode per faction, 17 episodes, recorded in
2019 before Prophecy of Kings shipped. They cover exactly the base-game
faction pool this project plays.

| Episode | Faction | Duration | Size |
| --- | --- | --- | --- |
| Ep 097 | Federation of Sol | 2:05:12 | 180.3 MB |
| Ep 104 | Barony of Letnev | 2:06:45 | 182.5 MB |
| Ep 109 | Sardakk N'orr | 1:46:58 | 154.1 MB |
| Ep 118 | Emirates of Hacan | 2:01:29 | 175.0 MB |
| Ep 122 | Universities of Jol-Nar | 2:08:52 | 185.6 MB |
| Ep 132 | Xxcha Kingdom | 2:08:53 | 185.6 MB |
| Ep 135 | Mentak Coalition | 1:57:45 | 169.6 MB |
| Ep 136 | Yssaril Tribes | 1:37:21 | 140.2 MB |
| Ep 139 | Naalu Collective | 1:18:32 | 113.1 MB |
| Ep 140 | L1Z1X Mindnet | 1:40:08 | 144.2 MB |
| Ep 145 | The Winnu | 1:28:25 | 127.3 MB |
| Ep 150 | Clan of Saar | 1:16:04 | 109.6 MB |
| Ep 156 | Yin Brotherhood | 1:32:45 | 133.6 MB |
| Ep 159 | Embers of Muaat | 1:18:04 | 112.4 MB |
| Ep 160 | Ghosts of Creuss | 1:42:51 | 148.1 MB |
| Ep 161 | Nekro Virus | 1:28:48 | 127.9 MB |
| Ep 163 | Arborec | 2:01:22 | 174.8 MB |

Total: 17 episodes, 17 factions, 29:40:14 of audio, 2.56 GB.

Much faction advice in these episodes concerns action cards and component
actions, which the experiment cannot play. Chunks are tagged so that advice
can be filtered out or flagged in the prompt (see Index rules).

### Layout

```
knowledge/
  manifest.json            # tracked: episode metadata, hashes, source URLs
  glossary.json            # tracked: alias -> canonical, versioned
  lessons.jsonl            # tracked: lessons from playthroughs (Phase 6)
  puzzles/                 # tracked: reviewed decisions (Phase 3)
  audio/                   # ignored: original MP3s
  transcripts/             # ignored: raw Parakeet JSON, gzipped, word timings
  chunks/                  # ignored: topical chunk JSON per episode
  knowledge.db             # ignored: SQLite + FTS5 index
```

### Transcription

Use Parakeet TDT 0.6B v3 via FluidAudio on the M1 Max. At the published
150–300× realtime range, the 29.7-hour corpus takes minutes, so the cost is in
the correction and chunking passes, not the ASR.

Store word-level timings only as gzipped per-episode JSON. Only segment-level
rows go into SQLite.

### Glossary and correction

The ASR will get faction names wrong. Fix it deterministically before any
model sees the text.

1. Generate `knowledge/glossary.json` from the base-game entries in
   `app/game/data/generated/`: canonical faction names, short names, tech
   names, unit names, plus hand-written aliases for known confusions.
2. Run a deterministic alias pass (exact and fuzzy) over transcripts.
3. Run one LLM correction pass over remaining uncertain proper nouns, with the
   glossary in the prompt and instructions to change proper nouns only.
4. Stamp each transcript with `glossaryVersion`. A glossary fix re-runs the
   correction pass, never the ASR.

### Index

Single SQLite file, FTS5, no server.

```sql
episodes(id, number, title, publishedAt, audioPath, durationMs, glossaryVersion)
segments(id, episodeId, startMs, endMs, speakerId, text)
segments_fts USING fts5(text, content='segments')   -- external content
chunks(id, episodeId, startMs, endMs, title, summary, text, tags)
chunks_fts USING fts5(text, content='chunks')
glossary(alias, canonical, kind, factionId)
lessons(id, text, faction, phase, topic, status,
        sourceGameId, decisionIndex, puzzleId,
        addedInVersion, retiredInVersion)
lessons_fts USING fts5(text, content='lessons')
```

`knowledge.db` is ignored and rebuildable. The guide tables are rebuilt from
transcripts; the `lessons` table is rebuilt from `knowledge/lessons.jsonl`,
which is the source of truth because lessons are hand-written and cannot be
regenerated. See Phase 6 for how lessons are written and checked.

Rules:

- Retrieve **chunks**, not isolated utterances. Cut at semantic-distance spikes
  so a hit is a coherent topic, not five scattered sentences.
- Return windows with episode and timestamp so every claim is citable.
- Tag chunks at build time: faction, game phase (opening / mid / late),
  topic (strategy cards, tech, expansion, combat, politics, objectives), and
  `unplayable` when the advice depends on action cards or component actions.
- Precompute faction- and objective-keyed rollups once the chunks exist. Most
  in-game queries then become a lookup rather than a search.
- Keep `search_transcripts(query)` as the long-tail tool behind the rollups.
- `retrieve()` queries guide chunks and active lessons with the same tags and
  labels each hit by source, so the prompt and the review card show whether
  the agent leaned on SCPT or on a lesson. Each source can be switched off
  independently.

## Phase 5 — Evaluation

### Conditions

Run every condition on identical seeds.

| Condition | Question it answers |
| --- | --- |
| Scripted bot | Baseline |
| LLM, no knowledge base | What the model already knows |
| LLM, own faction's full transcript in context | Does raw source help at all |
| LLM, retrieved chunks | The actual hypothesis |
| LLM, retrieved chunks + rollout | Does grounding beat vibes |
| LLM, irrelevant retrieved chunks | Is it following advice that doesn't fit the board |
| LLM, lessons only + rollout | Do our own playthrough notes help without SCPT |
| LLM, chunks + lessons + rollout | Do the two sources combine |

The lessons conditions only become meaningful once the active lessons set is
non-trivial; until then they are skipped.

The full-transcript condition loads one faction's episode (roughly 20–30k
tokens), not the whole corpus.

### Match formats

Six-player win rate needs hundreds of games per condition before differences
are meaningful, and each game is 1000+ decisions. Use cheaper formats first
and save full games for the conditions that survive.

1. **Puzzle set** — agreement with expert choices. Cheapest; run on every
   change.
2. **Seat swap** — one LLM seat against five scripted bots, same seed and
   factions, swapping only the condition in that seat. Compare VP at the end
   of round 4 and final VP against the scripted bot in the same seat.
3. **Full games** — multiple LLM seats, for the final comparison only.

### Metrics

- Puzzle agreement rate (held-out is the headline number); rationale rating
  distribution.
- VP at round N, final VP, win rate (vs. scripted bot in the same seat).
- Objectives scored, VP per round.
- Illegal-action retry rate (speaks to action-space fluency).
- Tokens and cost per game, wall-clock per game.
- Citation rate and citation accuracy (does the cited chunk say what the
  rationale claims).

## Phase 6 — Improvement loop

Phases 1–5 build the agent and measure it once. This phase is how it gets
better. Each iteration changes one thing and is judged on puzzles the change
was not tuned on.

```
play batch ──► triage ──► review ──► diagnose ──► change one lever ──► gate ──► record
     ▲                                                                   │
     └───────────────────────────────────────────────────────────────────┘
```

### 1. Play a batch

About 20 seat-swap games (one LLM seat, five scripted bots) on fixed seeds,
with the version stamped in every replay.

### 2. Triage

A batch produces thousands of model decisions; a reviewer can look at a few
dozen. `scripts/triage.ts` ranks decisions for the review queue by:

- **Rollout regret** — a rejected alternative's rollout beat the chosen move
  by more than a threshold.
- **Version disagreement** — another agent version chose differently from the
  same position (replay the position under both versions).
- **Retries** — an illegal first attempt, or a fallback to the scripted bot.
- **Swing** — the decision precedes a large VP, planet or fleet loss.
- **Citation mismatch** — the rationale claims something the cited chunk or
  lesson does not say (a cheap model check).

### 3. Review

Through the Phase 3 review UI. Disagreements carry a failure category; agreed
decisions with a sound rationale can still become puzzles.

### 4. Diagnose

Count failure categories across the batch and work on the largest. Each
category maps to the part of the system to change:

| Failure | Lever |
| --- | --- |
| Board misread (missed an adjacent fleet, wrong resource count) | State description: `describeTurn`, `describePrompt` |
| Rule error | Exact lookup from repo game data; rules text in the prompt |
| Menu (good move missing, or too many candidates to choose well) | `enumerateLegal` generation and ranking |
| Bad advice (retrieved advice that does not fit the board) | Retrieval queries, chunk tags, the `unplayable` filter |
| Judgment (knew the idea, weighed it wrong) | Rollout depth and seeds, prompt framing, or a lesson |
| Routing (model spent on a trivial choice, or bot on a real one) | Reflex routing rules |

### 5. Change one lever

One change per agent version, so the result is attributable. Writing lessons
is one lever among these, not the default.

#### Lessons

A lesson is a short, board-checkable heuristic learned from a reviewed
decision, for example: "Do not leave the home system without ships while an
enemy carrier is within two moves." Lessons:

- Are written from a review note. The review UI can ask a model to draft one;
  a draft is saved with `status: "draft"` and only a human sets it `active`.
- Carry the same tags as guide chunks (`faction`, `phase`, `topic`) so one
  `retrieve()` call finds both.
- Record provenance: `sourceGameId`, `decisionIndex` and, if derived from a
  puzzle, `puzzleId`.
- Are retired, never deleted: `status: "retired"` with `retiredInVersion`,
  so the changelog can show which lessons helped and which hurt.

The index build enforces two checks and fails if either is violated:

- No active lesson's `puzzleId` is a held-out puzzle, so lessons cannot leak
  held-out answers.
- Every lesson has a source decision that exists in a stored replay.

### 6. Gate

A change ships only if:

1. Held-out puzzle agreement does not drop beyond noise (bootstrap the
   confidence interval over puzzles).
2. A seat-swap run on **fresh** seeds shows no regression in VP against the
   previous version in the same seat.

Shipped versions join a running Elo-style ladder from head-to-head games
between versions, so progress is measured against earlier agents and not only
against the scripted bot.

### 7. Record

`docs/agent-changelog.md` gets one entry per iteration: version, lever
changed, failure category targeted, held-out agreement before and after,
seat-swap VP before and after, and whether it shipped. Over time this shows
which levers pay off and feeds the final investment decision.

### Keeping the opponent honest

Once the agent beats the scripted bot easily, seat-swap results stop
discriminating. Improve the scripted bot from the same reviews (it has its own
version in `agentVersions`), and always compare agent versions against the
same bot version.

### Later: model-assisted review

A model can pre-rate rationales and pre-fill failure categories so the
reviewer only sees uncertain cases. Trust it only after measuring its
agreement with a few hundred human ratings, and never let it create puzzles or
activate lessons on its own.

## Risks and open questions

- **The knowledge base may not help.** A frontier model has probably read TI4
  material. The marginal value is likely SCPT-specific heuristics and
  faction-specific openings. The no-knowledge-base condition measures this.
- **The scripted bot may be the real bottleneck.** If it is weak, the
  baseline, reflex tier and rollouts all mislead. Phase 1 acceptance criteria
  exist for this reason; revisit them if LLM agents beat it trivially.
- **No action cards.** Excluding action cards and component actions changes
  the game, especially for factions like Yssaril. Results apply to this
  reduced game. Automating card effects is a separate engine project.
- **Rules authority.** Where the model's prior and the engine disagree, the
  engine wins, always. Never let retrieved prose override a legality check.
- **Reviewer bandwidth.** The puzzle set and the lessons set grow only as fast
  as someone reviews decisions. Triage exists to spend that time well.
- **Overfitting to the puzzles.** Prompt tweaks and lessons tuned on dev
  puzzles can look like progress without being progress. The held-out split
  and the build-time leak check exist for this.
- **Lessons that encode the reviewer's own style.** Lessons reflect one
  reviewer's judgment. Test them as their own condition rather than assuming
  they help.
- **Diarization.** Parakeet gives text, not speakers. `speakerId` stays null
  until a separate pass exists.
- **Latency.** The reflex tier is not an optimization, it is what makes the
  experiment finish.
- **Hidden information.** The agent boundary is `viewFor`, never the raw
  `GameState`. Rollouts run on the real state and would leak hidden
  information; run them on a determinized state sampled from `viewFor`.

## Milestones

- [x] Download the 17 base-game Strategy Guide episodes and record a manifest.
- [ ] Block bypass actions (`ADJUST`, `SET_*`, `COMPONENT_ACTION`,
  `PLAY_ACTION_CARD`) at the agent boundary.
- [ ] Write the scripted bot and meet the Phase 1 acceptance criteria.
- [ ] Write `scripts/agent-play.ts` with two-tier policy, structured decisions
  and replay logs; run LLM-no-knowledge-base vs. scripted bot.
- [ ] Build the decision review UI (with failure categories) and `--approve`
  live mode.
- [ ] Review enough decisions to seed a puzzle set of ~100 positions, split
  dev / held-out.
- [ ] Write `scripts/triage.ts` and `docs/agent-changelog.md`; run the first
  improvement iterations on the no-knowledge-base agent.
- [ ] Transcribe with Parakeet; store word timings as gzipped JSON.
- [ ] Generate the glossary from base-game data and run correction.
- [ ] Build `knowledge.db` with FTS5, tagged topical chunks, rollups and the
  `lessons` table loaded from `knowledge/lessons.jsonl` with leak checks.
- [ ] Run the evaluation: puzzles, then seat swap, then full games.
- [ ] Decide from the numbers whether to invest in action-card automation,
  expansions, or embeddings.
