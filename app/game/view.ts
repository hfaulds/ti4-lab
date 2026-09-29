import { PlayerId } from "~/types";
import { victoryPoints } from "./engine/control";
import { Deck, GameState, PlayerState, Prompt } from "./types";

export type HandSizes = {
  actionCards: number;
  secretObjectives: number;
  promissoryNotes: number;
};

export type PlayerView = PlayerState & {
  hand: HandSizes;
  victoryPoints: number;
};

type DeckView = { draw: number; discard: string[] };

/**
 * What one seat at the table can see. Hidden cards belonging to other
 * players, the order of every deck and the dice generator are left out.
 */
export type GameView = Omit<GameState, "players" | "decks" | "rng"> & {
  viewer?: PlayerId;
  players: Record<PlayerId, PlayerView>;
  decks: Record<keyof GameState["decks"], DeckView>;
};

const HIDDEN = "hidden";
const hide = (cards: unknown[]) => cards.map(() => HIDDEN);

function promptFor(prompt: Prompt, viewer?: PlayerId): Prompt {
  if (prompt.player === viewer) return prompt;
  if (prompt.kind === "chooseSecret") {
    return { ...prompt, options: hide(prompt.options) };
  }
  if (prompt.kind === "politicsAgenda") {
    return { ...prompt, cards: hide(prompt.cards) };
  }
  return prompt;
}

export function viewFor(state: GameState, viewer?: PlayerId): GameView {
  const { decks, players, ...rest } = state;
  const visible: Omit<typeof rest, "rng"> & { rng?: number } = { ...rest };
  delete visible.rng;
  const finished = state.phase === "finished";

  const playerViews = Object.fromEntries(
    Object.values(players).map((player) => {
      const own = player.id === viewer || finished;
      const view: PlayerView = {
        ...player,
        actionCards: own ? player.actionCards : hide(player.actionCards),
        secretObjectives: own
          ? player.secretObjectives
          : hide(player.secretObjectives),
        promissoryNotes: own
          ? player.promissoryNotes
          : player.promissoryNotes.map((note) => ({ ...note, id: HIDDEN })),
        hand: {
          actionCards: player.actionCards.length,
          secretObjectives: player.secretObjectives.length,
          promissoryNotes: player.promissoryNotes.length,
        },
        victoryPoints: victoryPoints(state, player.id),
      };
      return [player.id, view];
    }),
  ) as Record<PlayerId, PlayerView>;

  const deckViews = Object.fromEntries(
    (Object.entries(decks) as [keyof GameState["decks"], Deck][]).map(
      ([name, deck]) => [
        name,
        { draw: deck.draw.length, discard: deck.discard },
      ],
    ),
  ) as GameView["decks"];

  return {
    ...visible,
    viewer,
    players: playerViews,
    decks: deckViews,
    // Objectives not yet revealed stay face down.
    publicObjectives: state.publicObjectives.map((objective) =>
      objective.revealed ? objective : { ...objective, id: HIDDEN },
    ),
    prompts: state.prompts.map((prompt) => promptFor(prompt, viewer)),
    log: state.log.filter(
      (entry) =>
        !entry.visibleTo ||
        (viewer !== undefined && entry.visibleTo.includes(viewer)),
    ),
  };
}

export const isHidden = (card: string) => card === HIDDEN;

/**
 * Lets the rules queries (adjacency, unit stats, objective checks) run
 * against a view. None of them read the decks or the dice generator.
 */
export const asState = (view: GameView) => view as unknown as GameState;
