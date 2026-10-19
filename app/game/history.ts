/**
 * Rebuilds earlier points of a game from the state it began in and the moves
 * played since. The engine is deterministic, dice included, so replaying the
 * same moves always reaches the same states.
 */
import { PlayerId } from "~/types";
import { GameAction } from "./actions";
import { applyAction } from "./engine";
import { GameState, LogEntry, Phase } from "./types";

/** Why an agent chose a move, from the decision it was asked to make. */
export type MoveNote = {
  /** The option taken, as it was put to the agent. */
  chosen: string;
  rationale: string;
  /** The agent's running plan once it had decided. */
  plan?: string;
  /** Every option the agent was offered. */
  options: string[];
  /** Why the agent's choice was not used, if the bot's top option was played instead. */
  fallback?: string;
};

export type RecordedMove = {
  /** The game's version once the move was applied. */
  version: number;
  player: PlayerId;
  action: GameAction;
  note?: MoveNote;
};

/** One point in a game's history, as the timeline lists it. */
export type HistoryStep = {
  version: number;
  round: number;
  phase: Phase;
  /** Who moved to reach this point; absent for the starting state. */
  player?: PlayerId;
  action?: GameAction["type"];
  /**
   * What the move added to the game log, as the viewer may read it; for the
   * starting state, the log it began with.
   */
  events: string[];
  /** Why the player chose the move, if they said, and the viewer may read it. */
  note?: MoveNote;
};

export class GameHistory {
  /** Every state from the start, one per move. */
  readonly states: GameState[];
  readonly moves: RecordedMove[] = [];

  constructor(initial: GameState) {
    this.states = [initial];
  }

  get latest() {
    return this.states[this.states.length - 1];
  }

  /** Plays further moves, which must follow on from the latest state. */
  extend(moves: RecordedMove[]) {
    for (const move of moves) {
      const result = applyAction(this.latest, move.player, move.action);
      if (!result.ok) {
        throw new Error(
          `Move ${move.version} (${move.action.type} by P${move.player}) no longer replays: ${result.error}`,
        );
      }
      if (result.state.version !== move.version) {
        throw new Error(
          `Move ${move.version} replayed to version ${result.state.version}.`,
        );
      }
      this.states.push(result.state);
      this.moves.push(move);
    }
  }

  stateAt(version: number): GameState | undefined {
    return this.states[version - this.states[0].version];
  }

  /**
   * Every point of the game, from the start to the latest move. A move's
   * note can mention its player's hidden cards, so only they read it until
   * everything is revealed, or notes are revealed on their own (in games
   * with no human players).
   */
  timeline(
    viewer: PlayerId | undefined,
    revealAll: boolean,
    revealNotes = revealAll,
  ): HistoryStep[] {
    const readable = (entry: LogEntry) =>
      revealAll ||
      !entry.visibleTo ||
      (viewer !== undefined && entry.visibleTo.includes(viewer));
    return this.states.map((state, index) => {
      const move = this.moves[index - 1];
      const previous = this.states[index - 1];
      const after = previous?.log[previous.log.length - 1]?.id ?? -1;
      return {
        version: state.version,
        round: state.round,
        phase: state.phase,
        player: move?.player,
        action: move?.action.type,
        note:
          move?.note && (revealNotes || move.player === viewer)
            ? move.note
            : undefined,
        events: state.log
          .filter((entry) => entry.id > after && readable(entry))
          .map((entry) => entry.text),
      };
    });
  }
}
