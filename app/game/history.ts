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
  /** Only one move was on offer; the rationale says why. */
  forced?: boolean;
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
  /**
   * The version of the first step of the action this move was part of, so
   * moves made while resolving someone's action (secondaries of a strategy
   * card, hits assigned in combat) group under it.
   */
  section: number;
  /** Whose turn it was, when the move was made on someone's turn. */
  turn?: PlayerId;
};

/** Moves that finish a player's turn, so whatever follows begins another. */
const TURN_ENDING = new Set<GameAction["type"]>([
  "END_TURN",
  "PASS",
  "PICK_STRATEGY_CARD",
]);

/** Where in the game a move was made: on whose turn, or which agenda. */
const momentOf = (state: GameState) =>
  `${state.round}/${state.phase}/${state.activePlayer ?? ""}/${state.agenda?.number ?? ""}`;

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
    let section = this.states[0].version;
    return this.states.map((state, index) => {
      const move = this.moves[index - 1];
      const previous = this.states[index - 1];
      const after = previous?.log[previous.log.length - 1]?.id ?? -1;
      if (index > 0) {
        const lastMove = this.moves[index - 2];
        if (
          !lastMove ||
          TURN_ENDING.has(lastMove.action.type) ||
          momentOf(previous) !== momentOf(this.states[index - 2])
        ) {
          section = state.version;
        }
      }
      return {
        version: state.version,
        round: state.round,
        phase: state.phase,
        player: move?.player,
        action: move?.action.type,
        section,
        turn: previous?.activePlayer,
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
