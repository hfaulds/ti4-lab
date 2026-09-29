import { Wormhole } from "~/types";
import {
  agendasById,
  attachmentsById,
  ExplorationDeck,
  relicsById,
  technologiesById,
  UNIT_NAMES,
} from "../data";
import { Adjustment } from "../actions";
import { GameState } from "../types";
import { planetOf, planetTraits, systemOf } from "./board";
import {
  checkElimination,
  checkVictory,
  explore,
  gainControl,
  unlockLeaders,
} from "./control";
import {
  actionCardName,
  addUnits,
  draw,
  drawActionCards,
  drawSecretObjective,
  ensure,
  log,
  playerName,
  playerOf,
  removeUnits,
} from "./helpers";
import { describeSystem } from "./tactical";

const signed = (amount: number) => (amount >= 0 ? `+${amount}` : `${amount}`);
const WORMHOLES: Wormhole[] = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON"];

/**
 * Applies a change by hand. This is how card text, faction abilities and
 * anything else the engine does not resolve itself reach the board; every
 * change is recorded in the log as a manual one.
 */
export function adjust(state: GameState, by: number, adjustment: Adjustment) {
  const note = (text: string) =>
    log(state, `${playerName(state, by)} adjusted: ${text}`, {
      player: by,
      manual: true,
    });

  switch (adjustment.type) {
    case "tradeGoods": {
      const player = playerOf(state, adjustment.player);
      ensure(
        player.tradeGoods + adjustment.amount >= 0,
        "Trade goods cannot go below 0.",
      );
      player.tradeGoods += adjustment.amount;
      note(`${player.name} ${signed(adjustment.amount)} trade goods.`);
      break;
    }
    case "commodities": {
      const player = playerOf(state, adjustment.player);
      ensure(
        player.commodities + adjustment.amount >= 0,
        "Commodities cannot go below 0.",
      );
      player.commodities += adjustment.amount;
      note(`${player.name} ${signed(adjustment.amount)} commodities.`);
      break;
    }
    case "commandTokens": {
      const player = playerOf(state, adjustment.player);
      ensure(
        player.pools[adjustment.pool] + adjustment.amount >= 0,
        "A pool cannot go below 0.",
      );
      player.pools[adjustment.pool] += adjustment.amount;
      note(
        `${player.name} ${signed(adjustment.amount)} ${adjustment.pool} tokens.`,
      );
      break;
    }
    case "victoryPoints": {
      const player = playerOf(state, adjustment.player);
      player.bonusVictoryPoints += adjustment.amount;
      note(`${player.name} ${signed(adjustment.amount)} victory points.`);
      checkVictory(state);
      break;
    }
    case "units": {
      const player = playerOf(state, adjustment.player);
      const forces = adjustment.planet
        ? planetOf(state, adjustment.planet).units
        : systemOf(state, adjustment.system).space;
      if (adjustment.amount > 0) {
        addUnits(forces, player.id, adjustment.unit, adjustment.amount);
      } else {
        removeUnits(forces, player.id, adjustment.unit, -adjustment.amount);
      }
      note(
        `${player.name} ${signed(adjustment.amount)} ${UNIT_NAMES[adjustment.unit]} ${
          adjustment.planet
            ? `on ${adjustment.planet}`
            : `in ${describeSystem(state, adjustment.system)}`
        }.`,
      );
      checkElimination(state, player.id);
      break;
    }
    case "damage": {
      const forces = adjustment.planet
        ? planetOf(state, adjustment.planet).units
        : systemOf(state, adjustment.system).space;
      const stack = forces[adjustment.player]?.[adjustment.unit];
      ensure(stack, "There are no such units there.");
      ensure(
        adjustment.damaged >= 0 && adjustment.damaged <= stack.count,
        "That is more units than are there.",
      );
      stack.damaged = adjustment.damaged;
      note(
        `${playerName(state, adjustment.player)} has ${adjustment.damaged} damaged ${UNIT_NAMES[adjustment.unit]}.`,
      );
      break;
    }
    case "planetControl": {
      const planet = planetOf(state, adjustment.planet);
      if (adjustment.player === undefined) {
        const previous = planet.controller;
        planet.controller = undefined;
        note(`${planet.name} is uncontrolled.`);
        if (previous !== undefined) checkElimination(state, previous);
      } else {
        gainControl(state, adjustment.player, adjustment.planet, {
          explore: false,
        });
        note(
          `${playerName(state, adjustment.player)} controls ${planet.name}.`,
        );
      }
      break;
    }
    case "planetExhausted": {
      planetOf(state, adjustment.planet).exhausted = adjustment.exhausted;
      note(
        `${adjustment.planet} ${adjustment.exhausted ? "exhausted" : "readied"}.`,
      );
      break;
    }
    case "attachment": {
      const planet = planetOf(state, adjustment.planet);
      const data = attachmentsById[adjustment.attachment];
      ensure(data, "Unknown attachment.");
      planet.attachments = planet.attachments.filter(
        (a) => a !== adjustment.attachment,
      );
      if (adjustment.attached) planet.attachments.push(adjustment.attachment);
      note(
        `${data.name} ${adjustment.attached ? "attached to" : "removed from"} ${planet.name}.`,
      );
      break;
    }
    case "systemToken": {
      const system = systemOf(state, adjustment.system);
      system.commandTokens = system.commandTokens.filter(
        (t) => t !== adjustment.player,
      );
      if (adjustment.present) system.commandTokens.push(adjustment.player);
      note(
        `${playerName(state, adjustment.player)} command token ${adjustment.present ? "placed in" : "removed from"} ${describeSystem(state, adjustment.system)}.`,
      );
      break;
    }
    case "frontier": {
      systemOf(state, adjustment.system).frontier = adjustment.present;
      note(
        `Frontier token ${adjustment.present ? "placed in" : "removed from"} ${describeSystem(state, adjustment.system)}.`,
      );
      break;
    }
    case "wormhole": {
      const system = systemOf(state, adjustment.system);
      const wormhole = adjustment.wormhole.toUpperCase() as Wormhole;
      ensure(WORMHOLES.includes(wormhole), "Unknown wormhole type.");
      system.addedWormholes = system.addedWormholes.filter(
        (w) => w !== wormhole,
      );
      if (adjustment.present) system.addedWormholes.push(wormhole);
      note(
        `${wormhole.toLowerCase()} wormhole ${adjustment.present ? "added to" : "removed from"} ${describeSystem(state, adjustment.system)}.`,
      );
      break;
    }
    case "technology": {
      const player = playerOf(state, adjustment.player);
      const tech = technologiesById[adjustment.technology];
      ensure(tech, "Unknown technology.");
      player.technologies = player.technologies.filter((t) => t !== tech.id);
      if (adjustment.owned) player.technologies.push(tech.id);
      note(
        `${player.name} ${adjustment.owned ? "gained" : "lost"} ${tech.name}.`,
      );
      break;
    }
    case "drawActionCards": {
      ensure(adjustment.count > 0, "Draw at least 1 card.");
      drawActionCards(state, adjustment.player, adjustment.count);
      break;
    }
    case "discardActionCard": {
      const player = playerOf(state, adjustment.player);
      const index = player.actionCards.indexOf(adjustment.card);
      ensure(index >= 0, "That card is not in their hand.");
      player.actionCards.splice(index, 1);
      state.decks.actionCards.discard.push(adjustment.card);
      note(`${player.name} discarded ${actionCardName(adjustment.card)}.`);
      break;
    }
    case "drawSecret":
      drawSecretObjective(state, adjustment.player);
      break;
    case "relic": {
      const player = playerOf(state, adjustment.player);
      if (adjustment.owned) {
        const relic = adjustment.relic ?? draw(state, state.decks.relics);
        ensure(relic, "The relic deck is empty.");
        state.decks.relics.draw = state.decks.relics.draw.filter(
          (r) => r !== relic,
        );
        player.relics.push(relic);
        note(`${player.name} gained ${relicsById[relic]?.name ?? relic}.`);
      } else {
        ensure(adjustment.relic, "Choose a relic.");
        player.relics = player.relics.filter((r) => r !== adjustment.relic);
        note(
          `${player.name} purged ${relicsById[adjustment.relic]?.name ?? adjustment.relic}.`,
        );
      }
      break;
    }
    case "relicFragment": {
      const player = playerOf(state, adjustment.player);
      if (adjustment.owned) {
        player.relicFragments.push(adjustment.fragment);
      } else {
        const index = player.relicFragments.indexOf(adjustment.fragment);
        ensure(index >= 0, "They do not hold that relic fragment.");
        player.relicFragments.splice(index, 1);
      }
      note(
        `${player.name} ${adjustment.owned ? "gained" : "purged"} a relic fragment.`,
      );
      break;
    }
    case "speaker": {
      playerOf(state, adjustment.player);
      state.speaker = adjustment.player;
      note(`${playerName(state, adjustment.player)} is the speaker.`);
      break;
    }
    case "law": {
      const agenda = agendasById[adjustment.agenda];
      ensure(agenda, "Unknown agenda.");
      state.laws = state.laws.filter((law) => law.id !== agenda.id);
      if (adjustment.inPlay) {
        state.laws.push({ id: agenda.id, outcome: adjustment.outcome });
      } else {
        state.decks.agendas.discard.push(agenda.id);
      }
      note(`${agenda.name} ${adjustment.inPlay ? "is in play" : "was discarded"}.`);
      break;
    }
    case "custodians": {
      state.custodians = adjustment.present;
      note(
        `Custodians token ${adjustment.present ? "returned to" : "removed from"} Mecatol Rex.`,
      );
      break;
    }
    case "scorePublic": {
      const objective = state.publicObjectives.find(
        (o) => o.id === adjustment.objective,
      );
      ensure(objective, "Unknown objective.");
      objective.scoredBy = objective.scoredBy.filter(
        (id) => id !== adjustment.player,
      );
      if (adjustment.scored) objective.scoredBy.push(adjustment.player);
      note(
        `${playerName(state, adjustment.player)} ${adjustment.scored ? "scored" : "unscored"} a public objective.`,
      );
      unlockLeaders(state);
      checkVictory(state);
      break;
    }
    case "explore": {
      const traits = adjustment.planet
        ? planetTraits(state, adjustment.planet)
        : [];
      const deck = (adjustment.deck ??
        (adjustment.planet
          ? traits[0]?.toLowerCase()
          : "frontier")) as ExplorationDeck;
      ensure(
        ["cultural", "hazardous", "industrial", "frontier"].includes(deck),
        "Choose an exploration deck.",
      );
      explore(state, adjustment.player, deck, {
        planet: adjustment.planet,
        system: adjustment.system,
      });
      break;
    }
    case "note": {
      ensure(adjustment.text.trim().length > 0, "Write a note.");
      ensure(adjustment.text.length <= 500, "Keep notes under 500 characters.");
      log(state, `${playerName(state, by)}: ${adjustment.text.trim()}`, {
        player: by,
        manual: true,
      });
      break;
    }
  }
}
