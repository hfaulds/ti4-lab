# Agent changelog

Changes to how the agent plays, newest first. See "The loop" in
`docs/agent-play-plan.md`: each change should come from a reviewed failure
and say whether it helped.

## Format

```
## YYYY-MM-DD: short title

- Version: the agentVersion hash from the replay logs after the change
  (and before, if known).
- Failure: the failure type it addresses (board misread, rule error, menu
  missing the right move, bad advice, judgment, routing), with an example
  game file and move.
- Change: what changed, in a sentence or two, and the commit.
- Numbers: before and after, on the same seeds where possible (VP share,
  VP after round 6, wins, free-form and fallback rates, cost per game,
  citation rate). "Not measured" is an honest answer.
```

Lessons added or retired count as changes: name their ids.

## Before this log

The entries below were reconstructed from the commit history; versions and
numbers were not recorded at the time.

### 2026-10: lessons (milestone 4)

- `knowledge/lessons.jsonl`, the `lessons` table, the `search_lessons` tool,
  lesson citations and lessons in briefings; `scripts/lessons.ts` to draft,
  activate and retire. Seeded with lessons L1 to L11 from this month's
  reviews.

### 2026-10: planning, standings and the slice

- The agent plans in a separate call before each of its own turns, and plans
  too short to use keep the previous one (8bcf5b7, 500bed9).
- Outages are waited out instead of falling back to the bot (f20af7a).
- The turn shows standings and the agent's slice; the prompt says never to
  let the Mecatol Rex holder take Imperial (2723e57).
- Objectives scored by others are no longer treated as gone (500bed9).

### 2026-10: building, stalling and Warfare

- The agent decides its own builds (2975a19) and stalling is one menu choice
  with costs shown (a1b39b4).
- Warfare's double expansion is supported (6ebf978).
- The turn shows objective progress, threats and lift; the agent keeps its
  secret objective (ef295c1).

### 2026-10: the strategy guides

- The knowledge base is indexed for search with shorthand expansion and
  concepts (2d8689f, d4d3349); the agent searches the guides and cites them
  (d436a7b), checks guide defaults against the board (72049b5), is told what
  to look up (e65c583), and is briefed from the guides before strategic
  decisions (9f6e6ce). Lookups per decision went up to 50 (5a81739).

### 2026-10: Claude and the board

- A Claude policy through the Claude Agent SDK (0f8f5ef).
- Games are played on seeded Milty drafts (991b170).
- The turn names systems by tile number (f4f32a1), shows what a move risks
  (57cbff6), forces and fighter space (41bd80b), spend objective progress and
  planned landings (d4c3936); public objectives are not first come, first
  served (21315b0).
- The menu offers what the bot's reservations hide (84a4e6d), trade ships
  (cd1e6f5) and every affordable secondary (46087dc).

### Earlier: the harness

- The harness, menu, `choose` and `lookup` (f92a42a); basic strategy advice
  (2174f0f); timeouts and retries (3a88a84); a limit on lookups instead of
  choosing (4e66bea); reasoning shown to spectators (31a3a15); skipped
  secondaries explained (ca940bf).
