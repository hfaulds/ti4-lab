import { produce as immer } from "immer";
import { PlayerId } from "~/types";
import {
  actionCardsById,
  leadersById,
  objectivesById,
  technologiesById,
} from "../data";
import { GameAction } from "../actions";
import { GameError, GameState } from "../types";
import { adjust } from "./adjust";
import { applyHits } from "./combat";
import {
  ensure,
  log,
  MAX_SECRET_OBJECTIVES,
  playerOf,
  shuffle,
  takePrompt,
} from "./helpers";
import { requireObjectivePhase, scoreObjective } from "./objectives";
import {
  castVotes,
  continueAgendaPhase,
  continueStatusPhase,
  endTurn,
  pass,
  pickStrategyCard,
  redistribute,
  requireAction,
  resolveAgenda,
  scoreStatusObjectives,
  startStrategyPhase,
} from "./phases";
import {
  finishStrategic,
  orderAgendas,
  resolveSecondary,
  strategicAction,
} from "./strategic";
import {
  activateSystem,
  announceRetreat,
  bombard,
  commitGroundForces,
  continueTactical,
  fireSpaceCannon,
  moveShips,
  produceUnits,
} from "./tactical";
import {
  answerTransaction,
  playPromissoryNote,
  proposeTransaction,
  returnPromissoryNote,
} from "./transactions";

export { createGame, setupProblem } from "./setup";
export type { GameSetup, GamePlayerSetup } from "./setup";

/** Guards against a rules bug spinning the engine forever. */
const MAX_AUTOMATIC_STEPS = 200;

/**
 * Carries the game forward through everything that needs no decision,
 * stopping as soon as a player has something to do.
 */
function advance(state: GameState) {
  for (let step = 0; step < MAX_AUTOMATIC_STEPS; step++) {
    if (state.phase === "finished") return;
    if (state.prompts.length > 0) return;

    if (state.phase === "setup") {
      startStrategyPhase(state);
      continue;
    }
    if (state.tactical) {
      if (continueTactical(state)) continue;
      return;
    }
    if (state.strategic) {
      finishStrategic(state);
      continue;
    }
    if (continueStatusPhase(state)) continue;
    if (continueAgendaPhase(state)) continue;
    return;
  }
  throw new Error("The game did not settle; this is a bug in the rules engine.");
}

function perform(state: GameState, id: PlayerId, action: GameAction) {
  const player = playerOf(state, id);
  ensure(state.phase !== "finished", "The game is over.");
  ensure(
    !player.eliminated || action.type === "ADJUST",
    "You have been eliminated.",
  );

  switch (action.type) {
    // --- Setup ---
    case "CHOOSE_SECRET": {
      const prompt = takePrompt(state, id, "chooseSecret");
      ensure(prompt.options.includes(action.keep), "Choose one of the two dealt.");
      player.secretObjectives.push(action.keep);
      const deck = state.decks.secretObjectives;
      deck.draw = shuffle(state, [
        ...deck.draw,
        ...prompt.options.filter((option) => option !== action.keep),
      ]);
      log(state, `${player.name} chose a secret objective.`, { player: id });
      return;
    }
    case "CHOOSE_STARTING_TECH": {
      const prompt = takePrompt(state, id, "chooseStartingTech");
      const chosen = [...new Set(action.technologies)];
      ensure(
        chosen.length === prompt.count &&
          chosen.every((tech) => prompt.options.includes(tech)),
        `Choose ${prompt.count} of the starting technologies on offer.`,
      );
      player.technologies.push(...chosen);
      log(
        state,
        `${player.name} starts with ${chosen
          .map((tech) => technologiesById[tech].name)
          .join(" and ")}.`,
        { player: id },
      );
      return;
    }

    // --- Strategy phase ---
    case "PICK_STRATEGY_CARD":
      pickStrategyCard(state, id, action.card);
      return;

    // --- Actions ---
    case "ACTIVATE_SYSTEM":
      requireAction(state, id);
      activateSystem(state, id, action.system);
      return;
    case "MOVE_SHIPS":
      ensure(state.prompts.length === 0, "Other players still have decisions to make.");
      moveShips(state, id, action.moves, action.cargo);
      return;
    case "FIRE_SPACE_CANNON": {
      const prompt = takePrompt(state, id, "spaceCannon", action.promptId);
      fireSpaceCannon(state, id, prompt, action.fire);
      return;
    }
    case "ASSIGN_HITS": {
      const prompt = takePrompt(state, id, "assignHits", action.promptId);
      applyHits(state, prompt, action.assignment);
      return;
    }
    case "ANNOUNCE_RETREAT": {
      const prompt = takePrompt(state, id, "announceRetreat");
      announceRetreat(state, id, prompt.options, action.to);
      return;
    }
    case "BOMBARD":
      ensure(state.prompts.length === 0, "Other players still have decisions to make.");
      bombard(state, id, action.targets);
      return;
    case "COMMIT_GROUND_FORCES":
      ensure(state.prompts.length === 0, "Other players still have decisions to make.");
      commitGroundForces(state, id, action.landings, action.custodians);
      return;
    case "PRODUCE":
      ensure(state.prompts.length === 0, "Other players still have decisions to make.");
      produceUnits(state, id, action.units, action.payment);
      return;
    case "STRATEGIC_ACTION":
      requireAction(state, id);
      strategicAction(state, id, action.payload);
      return;
    case "RESOLVE_SECONDARY": {
      const prompt = takePrompt(state, id, "secondary", action.promptId);
      resolveSecondary(state, id, prompt, action.payload);
      return;
    }
    case "ORDER_AGENDAS": {
      const prompt = takePrompt(state, id, "politicsAgenda");
      orderAgendas(state, prompt.cards, action.top, action.bottom);
      log(state, `${player.name} looked at the top of the agenda deck.`, {
        player: id,
      });
      return;
    }
    case "PLAY_ACTION_CARD": {
      const index = player.actionCards.indexOf(action.card);
      ensure(index >= 0, "You do not hold that action card.");
      const card = actionCardsById[action.card];
      if (card.componentAction) requireAction(state, id);
      player.actionCards.splice(index, 1);
      state.decks.actionCards.discard.push(action.card);
      if (card.componentAction) state.actionsThisTurn++;
      log(state, `${player.name} played ${card.name}. ${card.window}: ${card.text}`, {
        player: id,
      });
      return;
    }
    case "COMPONENT_ACTION": {
      requireAction(state, id);
      const description = action.description.trim();
      ensure(description.length > 0, "Describe the action.");
      ensure(description.length <= 300, "Keep the description under 300 characters.");
      state.actionsThisTurn++;
      log(state, `${player.name} took a component action: ${description}`, {
        player: id,
      });
      return;
    }
    case "PASS":
      pass(state, id);
      return;
    case "END_TURN":
      endTurn(state, id);
      return;

    // --- Objectives ---
    case "SCORE_OBJECTIVES": {
      takePrompt(state, id, "scoreObjectives");
      scoreStatusObjectives(
        state,
        id,
        action.publicObjective,
        action.secretObjective,
        action.payment,
      );
      return;
    }
    case "SCORE_OBJECTIVE": {
      const phase = state.phase;
      ensure(
        phase === "action" || phase === "agenda",
        "Status phase objectives are scored during the status phase.",
      );
      requireObjectivePhase(action.objective, phase);
      ensure(
        objectivesById[action.objective].kind === "secret",
        "Public objectives are scored in the status phase or with Imperial.",
      );
      scoreObjective(state, id, action.objective, action.payment);
      return;
    }

    // --- Status phase ---
    case "REDISTRIBUTE": {
      const prompt = takePrompt(state, id, "redistribute");
      redistribute(state, id, prompt.gained, action.pools);
      return;
    }
    case "DISCARD_ACTION_CARDS": {
      const prompt = takePrompt(state, id, "discardActionCards");
      const cards = action.cards;
      ensure(
        cards.length === prompt.count && new Set(cards).size === cards.length,
        `Discard ${prompt.count} action cards.`,
      );
      for (const card of cards) {
        const index = player.actionCards.indexOf(card);
        ensure(index >= 0, "You do not hold that action card.");
        player.actionCards.splice(index, 1);
        state.decks.actionCards.discard.push(card);
      }
      log(state, `${player.name} discarded down to their hand limit.`, {
        player: id,
      });
      return;
    }
    case "RETURN_SECRET": {
      takePrompt(state, id, "returnSecret");
      const index = player.secretObjectives.indexOf(action.objective);
      ensure(index >= 0, "Return one of your unscored secret objectives.");
      player.secretObjectives.splice(index, 1);
      const deck = state.decks.secretObjectives;
      deck.draw = shuffle(state, [...deck.draw, action.objective]);
      ensure(
        player.secretObjectives.length + player.scoredSecrets.length <=
          MAX_SECRET_OBJECTIVES,
        "You still hold too many secret objectives.",
      );
      return;
    }

    // --- Agenda phase ---
    case "CAST_VOTES":
      takePrompt(state, id, "vote");
      castVotes(state, id, action.outcome, action.planets, action.extraVotes);
      return;
    case "BREAK_TIE": {
      const prompt = takePrompt(state, id, "breakTie");
      ensure(
        prompt.outcomes.length === 0 || prompt.outcomes.includes(action.outcome),
        "Choose one of the tied outcomes.",
      );
      resolveAgenda(state, action.outcome);
      return;
    }

    // --- Any time ---
    case "RESOLVE":
      takePrompt(state, id, "resolve", action.promptId);
      return;
    case "PROPOSE_TRANSACTION":
      proposeTransaction(state, id, action.to, action.give, action.receive);
      return;
    case "ANSWER_TRANSACTION":
      answerTransaction(state, id, action.transaction, action.accept);
      return;
    case "PLAY_PROMISSORY_NOTE":
      playPromissoryNote(state, id, { id: action.note, owner: action.owner });
      return;
    case "RETURN_PROMISSORY_NOTE":
      returnPromissoryNote(state, id, { id: action.note, owner: action.owner });
      return;
    case "SET_LEADER": {
      const leader = player.leaders.find((l) => l.id === action.leader);
      ensure(leader, "That is not one of your leaders.");
      leader.status = action.status;
      log(
        state,
        `${player.name}'s ${leader.type} ${leadersById[leader.id]?.name ?? ""} is now ${action.status}.`,
        { player: id },
      );
      return;
    }
    case "SET_EXHAUSTED": {
      if (action.kind === "breakthrough") {
        ensure(player.breakthrough, "You have no breakthrough.");
        player.breakthrough.exhausted = action.exhausted;
        return;
      }
      const owned =
        action.kind === "technology" ? player.technologies : player.relics;
      ensure(owned.includes(action.id), "You do not own that.");
      const key =
        action.kind === "technology"
          ? "exhaustedTechnologies"
          : "exhaustedRelics";
      player[key] = player[key].filter((entry) => entry !== action.id);
      if (action.exhausted) player[key].push(action.id);
      log(
        state,
        `${player.name} ${action.exhausted ? "exhausted" : "readied"} ${
          action.kind === "technology"
            ? technologiesById[action.id]?.name
            : action.id
        }.`,
        { player: id },
      );
      return;
    }
    case "SET_BREAKTHROUGH":
      ensure(player.breakthrough, "You have no breakthrough.");
      player.breakthrough.unlocked = action.unlocked;
      log(
        state,
        `${player.name} ${action.unlocked ? "unlocked" : "locked"} their breakthrough.`,
        { player: id },
      );
      return;
    case "ADJUST":
      adjust(state, id, action.adjustment);
      return;
  }
  action satisfies never;
}

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };

/**
 * Applies a player's action. The state passed in is never modified; an
 * action the rules do not allow leaves the game exactly as it was.
 */
export function applyAction(
  state: GameState,
  player: PlayerId,
  action: GameAction,
): ActionResult {
  try {
    const next = immer(state, (draft) => {
      perform(draft as GameState, player, action);
      advance(draft as GameState);
      draft.version++;
    });
    return { ok: true, state: next };
  } catch (error) {
    if (error instanceof GameError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Settles a freshly created game so that it is waiting on its players. */
export function settle(state: GameState): GameState {
  return immer(state, (draft) => advance(draft as GameState));
}
