import { describe, expect, test } from "vitest";
import { scriptedMove } from "./agent/scriptedBot";
import { setupFor } from "./agent/setups";
import { play, testGame } from "./engine/testing";
import { GameHistory, RecordedMove } from "./history";
import { GameState } from "./types";

/** A bot game of `count` moves, with every state it passed through. */
function botGame(count: number) {
  let state = testGame({ seed: 4, ...setupFor(4) });
  const states: GameState[] = [state];
  const moves: RecordedMove[] = [];
  for (let i = 0; i < count; i++) {
    const move = scriptedMove(state)!;
    state = play(state, move.player, move.action);
    states.push(state);
    moves.push({ ...move, version: state.version });
  }
  return { states, moves };
}

describe("game history", () => {
  test("replaying the moves reaches every state the game passed through", () => {
    const { states, moves } = botGame(300);
    const history = new GameHistory(states[0]);
    history.extend(moves.slice(0, 120));
    history.extend(moves.slice(120));
    for (const state of states) {
      expect(history.stateAt(state.version)).toEqual(state);
    }
    expect(history.stateAt(states[0].version - 1)).toBeUndefined();
  });

  test("a move that no longer follows on is refused", () => {
    const { states, moves } = botGame(5);
    const history = new GameHistory(states[0]);
    expect(() => history.extend([moves[1]])).toThrow(
      /no longer replays|version/,
    );
  });

  test("the timeline lists each move with what it added to the log", () => {
    const { states, moves } = botGame(300);
    const history = new GameHistory(states[0]);
    history.extend(moves);
    const steps = history.timeline(undefined, false);
    expect(steps).toHaveLength(states.length);
    expect(steps[0].version).toBe(states[0].version);
    expect(steps[0].player).toBeUndefined();
    steps.slice(1).forEach((step, i) => {
      expect(step.player).toBe(moves[i].player);
      expect(step.action).toBe(moves[i].action.type);
    });

    const final = states[states.length - 1];
    const written = steps.flatMap((step) => step.events);
    const publicEntries = final.log.filter((entry) => !entry.visibleTo);
    // Everything public in the (capped) log was reported by the move that
    // wrote it, or by the start.
    expect(written.slice(-publicEntries.length)).toEqual(
      publicEntries.map((entry) => entry.text),
    );
  });

  test("a move's note is read by its player, or by anyone once revealed", () => {
    const { states, moves } = botGame(20);
    const noted = moves.map((move, i) =>
      i === 10
        ? {
            ...move,
            note: {
              chosen: "A. Pass",
              rationale: "Nothing better.",
              options: ["A. Pass"],
            },
          }
        : move,
    );
    const history = new GameHistory(states[0]);
    history.extend(noted);
    const player = noted[10].player;
    const other = player === 0 ? 1 : 0;
    expect(history.timeline(player, false)[11].note?.rationale).toBe(
      "Nothing better.",
    );
    expect(history.timeline(other, false)[11].note).toBeUndefined();
    expect(history.timeline(undefined, false)[11].note).toBeUndefined();
    expect(history.timeline(undefined, true)[11].note?.rationale).toBe(
      "Nothing better.",
    );
    // With no human players, notes are shown to everyone while hidden log
    // entries stay hidden.
    const notesOnly = history.timeline(undefined, false, true);
    expect(notesOnly[11].note?.rationale).toBe("Nothing better.");
    expect(notesOnly.map((s) => s.events)).toEqual(
      history.timeline(undefined, false).map((s) => s.events),
    );
  });
});
