/**
 * Action cards, abilities, promissory notes and laws used around the agenda
 * phase, and the laws whose owners choose when to use them.
 */
import { PlayerId } from "~/types";
import { agendasById } from "../../data";
import { GameState, WindowContext } from "../../types";
import {
  addVotes,
  agendaOutcomes,
  discardLaw,
  playerByName,
  replaceAgenda,
} from "../agenda";
import { controlledPlanets, planetTraits, systemOf } from "../board";
import { produce, productionCapacity } from "../economy";
import { ensure, log, playerName, playerOf, totalUnits } from "../helpers";
import { endTurnNow } from "../phases";
import { closeWindows } from "../reactions";
import { describeSystem } from "../tactical";
import { spendStrategyToken, targetPlayer, targetSystem } from "./helpers";
import type { EffectArea } from "./index";
import { Effect } from "./types";

const agendaOf = (state: GameState) => state.agenda;

const currentCard = (state: GameState) => agendaOf(state)?.card;

const electsPlayer = (state: GameState) => {
  const card = currentCard(state);
  return card !== undefined && agendasById[card]?.target === "player";
};

function bar(state: GameState, id: PlayerId) {
  const agenda = agendaOf(state)!;
  agenda.barred = [...(agenda.barred ?? []), id];
}

/** A rider: predict an outcome, give up voting, collect if right. */
const rider = (name: string): Effect => ({
  windows: ["afterAgendaRevealed"],
  targets: ["outcome", "planet", "system"],
  usable: (state, id) =>
    currentCard(state) !== undefined &&
    !agendaOf(state)!.predictions?.some((p) => p.player === id && p.card === name),
  play: (state, _id, targets) => {
    const outcomes = agendaOutcomes(state, currentCard(state)!);
    ensure(
      targets.outcome !== undefined && (outcomes.length === 0 || outcomes.includes(targets.outcome)),
      "Predict 1 of this agenda's outcomes.",
    );
  },
  resolve: (state, id, targets) => {
    const agenda = agendaOf(state);
    if (!agenda) return;
    bar(state, id);
    (agenda.predictions ??= []).push({
      player: id,
      card: name,
      outcome: targets.outcome!,
      planet: targets.planet,
      system: targets.system,
    });
  },
});

/** The Keleres Rider promissory notes predict like a rider. */
export const KELERES_RIDERS: Record<string, Effect> = Object.fromEntries(
  ["rider", "ridera", "riderm", "riderx"].map((id) => [id, rider("Keleres Rider")]),
);

const ACTION_CARDS: Record<string, Effect> = {
  "Ancient Burial Sites": {
    windows: ["agendaStart"],
    targets: ["player"],
    play: (state, id, targets) => {
      targetPlayer(state, id, targets, { other: false });
    },
    resolve: (state, id, targets) => {
      const victim = targetPlayer(state, id, targets, { other: false });
      for (const planet of controlledPlanets(state, victim)) {
        if (planetTraits(state, planet.name).includes("CULTURAL")) planet.exhausted = true;
      }
    },
  },
  "Assassinate Representative": {
    windows: ["afterAgendaRevealed"],
    targets: ["player"],
    usable: (state) => currentCard(state) !== undefined,
    play: (state, id, targets) => {
      targetPlayer(state, id, targets, { other: false });
    },
    resolve: (state, id, targets) => {
      const victim = targetPlayer(state, id, targets, { other: false });
      bar(state, victim);
      log(state, `${playerName(state, victim)} cannot vote on this agenda.`);
    },
  },
  Bribery: {
    windows: ["afterSpeakerVotes"],
    targets: ["amount"],
    usable: (state, id) =>
      state.players[id].tradeGoods > 0 &&
      !!agendaOf(state)?.votes.some((v) => v.player === id),
    play: (state, id, targets) => {
      const amount = targets.amount ?? 0;
      ensure(
        Number.isInteger(amount) && amount > 0 && amount <= state.players[id].tradeGoods,
        "Spend a whole number of trade goods you have.",
      );
      playerOf(state, id).tradeGoods -= amount;
    },
    resolve: (state, id, targets) => addVotes(state, id, targets.amount!),
  },
  "Distinguished Councilor": {
    windows: ["afterVote"],
    usable: (state, id) => !!agendaOf(state)?.votes.some((v) => v.player === id),
    resolve: (state, id) => addVotes(state, id, 5),
  },
  "Confusing Legal Text": {
    windows: ["whenElected"],
    targets: ["player"],
    usable: (state, id) => playerByName(state, agendaOf(state)?.result) === id,
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const other = targetPlayer(state, id, targets);
      agendaOf(state)!.result = state.players[other].name;
      log(state, `${playerName(state, other)} is elected instead.`);
    },
  },
  Veto: {
    windows: ["agendaRevealed"],
    usable: (state) => currentCard(state) !== undefined,
    resolve: (state) => replaceAgenda(state),
  },
  "Construction Rider": rider("Construction Rider"),
  "Diplomacy Rider": rider("Diplomacy Rider"),
  "Imperial Rider": rider("Imperial Rider"),
  "Leadership Rider": rider("Leadership Rider"),
  "Politics Rider": rider("Politics Rider"),
  "Technology Rider": rider("Technology Rider"),
  "Trade Rider": rider("Trade Rider"),
  "Warfare Rider": rider("Warfare Rider"),
};

const ABILITIES: Record<string, Effect> = {
  // Xxcha
  quash: {
    windows: ["agendaRevealed"],
    usable: (state, id) => currentCard(state) !== undefined && state.players[id].pools.strategy > 0,
    play: (state, id) => spendStrategyToken(state, id),
    resolve: (state) => replaceAgenda(state),
  },
  // Nekro
  galactic_threat: {
    windows: ["afterAgendaRevealed"],
    targets: ["outcome"],
    usable: (state, id) =>
      currentCard(state) !== undefined &&
      !state.players[id].used?.includes("galactic_threat"),
    play: (state, id, targets) => {
      const outcomes = agendaOutcomes(state, currentCard(state)!);
      ensure(
        targets.outcome !== undefined && (outcomes.length === 0 || outcomes.includes(targets.outcome)),
        "Predict 1 of this agenda's outcomes.",
      );
      (playerOf(state, id).used ??= []).push("galactic_threat");
    },
    resolve: (state, id, targets) => {
      const agenda = agendaOf(state);
      if (!agenda) return;
      (agenda.predictions ??= []).push({
        player: id,
        card: "Galactic Threat",
        outcome: targets.outcome!,
      });
    },
  },

  // Laws whose owners choose when to use them
  committee: {
    windows: ["afterAgendaRevealed"],
    targets: ["player"],
    usable: (state) => electsPlayer(state) && agendaOf(state)?.result === undefined,
    play: (state, id, targets) => {
      targetPlayer(state, id, targets, { other: false });
    },
    resolve: (state, id, targets) => {
      const chosen = targetPlayer(state, id, targets, { other: false });
      discardLaw(state, "committee");
      agendaOf(state)!.result = state.players[chosen].name;
      log(state, `Committee Formation: ${playerName(state, chosen)} is elected without a vote.`);
    },
  },
  arbiter: {
    windows: ["strategyEnd"],
    targets: ["player", "card", "choice"],
    usable: (state, id) => state.players[id].strategyCards.length > 0,
    play: (state, id, targets) => {
      const other = playerOf(state, targetPlayer(state, id, targets));
      ensure(
        state.players[id].strategyCards.some((c) => c.id === targets.card),
        "Choose 1 of your strategy cards to give.",
      );
      ensure(
        other.strategyCards.some((c) => c.id === targets.choice),
        `Choose 1 of ${other.name}'s strategy cards to take.`,
      );
    },
    resolve: (state, id, targets) => {
      const me = playerOf(state, id);
      const other = playerOf(state, targets.player!);
      const mine = me.strategyCards.find((c) => c.id === targets.card);
      const theirs = other.strategyCards.find((c) => c.id === targets.choice);
      if (!mine || !theirs) return;
      me.strategyCards = me.strategyCards.map((c) => (c === mine ? theirs : c));
      other.strategyCards = other.strategyCards.map((c) => (c === theirs ? mine : c));
      discardLaw(state, "arbiter");
      log(state, `Imperial Arbiter: ${me.name} swapped strategy cards with ${other.name}.`);
    },
  },
  minister_peace: {
    windows: ["afterActivate"],
    usable: (state, _id, context: WindowContext) => {
      const active = context.player;
      if (active === undefined || context.system === undefined) return false;
      const system = systemOf(state, context.system);
      const others = new Set<PlayerId>();
      for (const owner of Object.keys(system.space).map(Number)) {
        if (owner !== active && totalUnits(system.space[owner]) > 0) others.add(owner);
      }
      for (const planet of system.planets) {
        for (const owner of Object.keys(state.planets[planet].units).map(Number)) {
          if (owner !== active && totalUnits(state.planets[planet].units[owner]) > 0) {
            others.add(owner);
          }
        }
      }
      return others.size > 0;
    },
    resolve: (state, _id, _targets, context) => {
      discardLaw(state, "minister_peace");
      log(state, `Minister of Peace ends ${playerName(state, context.player!)}'s turn.`);
      closeWindows(state, ["afterActivate"]);
      endTurnNow(state, context.player!);
    },
  },
  minister_war: {
    windows: ["afterAction"],
    targets: ["system"],
    usable: (state, id) => state.activePlayer === id && state.actionsThisTurn > 0,
    play: (state, id, targets) => {
      if (targets.system !== undefined) {
        ensure(
          targetSystem(state, targets).commandTokens.includes(id),
          "You have no command token there.",
        );
      }
    },
    resolve: (state, id, targets) => {
      if (targets.system !== undefined) {
        const system = targetSystem(state, targets);
        system.commandTokens = system.commandTokens.filter((t) => t !== id);
        log(state, `${playerName(state, id)} took back their token from ${describeSystem(state, system.key)}.`, {
          player: id,
        });
      }
      discardLaw(state, "minister_war");
      state.actionsThisTurn--;
    },
  },
  minister_industry: {
    windows: ["afterPlaceDock"],
    targets: ["production", "payment"],
    usable: (_state, _id, context) => context.system !== undefined,
    resolve: (state, id, targets, context) => {
      const orders = (targets.production ?? []).filter((o) => o.count > 0);
      if (orders.length === 0) return;
      produce(state, id, context.system!, orders, targets.payment ?? { planets: [], tradeGoods: 0 }, {
        limit: productionCapacity(state, context.system!, id),
      });
    },
  },
};

const NOTES: Record<string, Effect> = {
  ps: {
    windows: ["agendaRevealed"],
    usable: (state, id) => {
      const owner = state.players[id].promissoryNotes.find((n) => n.id === "ps")?.owner;
      return owner !== undefined && owner !== id && currentCard(state) !== undefined;
    },
    resolve: (state, _id, _targets, context) => {
      const agenda = agendaOf(state);
      const owner = context.noteOwner;
      if (!agenda || owner === undefined) return;
      agenda.silenced = [...(agenda.silenced ?? []), owner];
      log(state, `${playerName(state, owner)} cannot vote, play action cards or use faction abilities on this agenda.`);
    },
  },
  favor: {
    windows: ["agendaRevealed"],
    usable: (state, id) => {
      const owner = state.players[id].promissoryNotes.find((n) => n.id === "favor")?.owner;
      return owner !== undefined && owner !== id && currentCard(state) !== undefined;
    },
    resolve: (state, _id, _targets, context) => {
      const owner = context.noteOwner;
      if (owner !== undefined && state.players[owner].pools.strategy > 0) {
        state.players[owner].pools.strategy--;
      }
      replaceAgenda(state);
    },
  },
};

export const AGENDA_EFFECTS: EffectArea = {
  actionCards: ACTION_CARDS,
  abilities: ABILITIES,
  notes: NOTES,
};
