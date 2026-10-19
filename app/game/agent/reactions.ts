/**
 * How the scripted bot uses action cards, abilities and promissory notes:
 * a few plays that are nearly always right, tried before passing.
 */
import { PlayerId } from "~/types";
import { actionCardsById } from "../data";
import { GameAction } from "../actions";
import { EffectTargets, GameState, Prompt, Reaction } from "../types";
import {
  controlledPlanets,
  planetInfluence,
  planetResources,
  planetTraits,
  systemOf,
} from "../engine/board";
import { victoryPoints } from "../engine/control";
import { countOf, hasShips, unitTypes } from "../engine/helpers";
import { componentActions, reactionAction } from "../engine/reactions";
import { findPayment } from "./payment";
import { poolsAfterGaining } from "./scriptedBot";

type Window = Extract<Prompt, { kind: "window" }>;

const cardName = (reaction: Reaction) =>
  reaction.kind === "actionCard" ? actionCardsById[reaction.id]?.name : undefined;

const homePlanet = (state: GameState, id: PlayerId) =>
  systemOf(state, state.players[id].home).planets.find(
    (p) => state.planets[p].controller === id,
  ) ?? controlledPlanets(state, id)[0]?.name;

/** The other player with the most victory points. */
function leader(state: GameState, id: PlayerId): PlayerId | undefined {
  return state.seating
    .filter((other) => other !== id && !state.players[other].eliminated)
    .sort((a, b) => victoryPoints(state, b) - victoryPoints(state, a))[0];
}

const hasDamage = (state: GameState, id: PlayerId) => {
  const tactical = state.tactical;
  if (!tactical) return false;
  const system = systemOf(state, tactical.system);
  const groups = [system.space[id], ...system.planets.map((p) => state.planets[p].units[id])];
  return groups.some((group) => unitTypes(group).some((t) => group![t]!.damaged > 0));
};

/**
 * Choices for a reaction the bot is willing to make in this window, or
 * undefined to leave it.
 */
function choose(
  state: GameState,
  id: PlayerId,
  prompt: Window,
  reaction: Reaction,
): EffectTargets | undefined {
  const name = cardName(reaction) ?? reaction.id;
  switch (name) {
    // Always worth it when offered.
    case "Shields Holding":
    case "Maneuvering Jets":
    case "Direct Hit":
    case "Courageous to the End":
    case "Intercept":
    case "Salvage":
    case "Infiltrate":
    case "Morale Boost":
    case "Bunker":
    case "Disable":
    case "Parley":
    case "Fire Team":
    case "Upgrade":
    case "Experimental Battlestation":
    case "ambush":
    case "ds":
    case "md_base":
    case "it":
    case "antivirus":
    case "tekklar":
    case "greyfire":
    case "ragh":
    case "ta":
    case "ce":
    case "ra":
    case "acq":
    case "spynet":
      return {};
    case "Emergency Repairs":
      return hasDamage(state, id) ? {} : undefined;
    case "Fighter Prototype":
      return countOf(systemOf(state, prompt.context.system!).space[id], "fighter") >= 3
        ? {}
        : undefined;
    case "munitions":
      return state.players[id].tradeGoods >= 4 ? {} : undefined;
    case "pillage":
      return { choice: "tradeGood" };
    case "Reparations": {
      const gainer = state.planets[prompt.context.planet!]?.controller;
      const theirs = controlledPlanets(state, gainer!)
        .filter((p) => !p.exhausted)
        .sort((a, b) => planetResources(state, b.name) - planetResources(state, a.name))[0];
      const mine = controlledPlanets(state, id)
        .filter((p) => p.exhausted)
        .sort((a, b) => planetResources(state, b.name) - planetResources(state, a.name))[0];
      return { planet: theirs?.name, planets: mine ? [mine.name] : [] };
    }
    case "Summit":
      return { pools: poolsAfterGaining(state, id, 2) };
    case "mitosis":
    case "ms": {
      const planet = homePlanet(state, id);
      return planet ? { planet } : undefined;
    }
    case "yso": {
      const planet = homePlanet(state, id);
      return planet ? { planet, amount: 2 } : undefined;
    }
    case "Ancient Burial Sites": {
      const target = leader(state, id);
      if (target === undefined) return undefined;
      const cultural = controlledPlanets(state, target).filter(
        (p) => !p.exhausted && planetTraits(state, p.name).includes("CULTURAL"),
      );
      return cultural.length >= 2 ? { player: target } : undefined;
    }
    case "peace_accords":
      return {};
    case "technological_singularity": {
      const owned = new Set(state.players[id].technologies);
      const tech = state.players[prompt.context.player!].technologies.find(
        (t) => !owned.has(t),
      );
      return tech ? { technology: tech } : undefined;
    }
    case "indoctrination": {
      const payment = findPayment(state, id, 2, "influence");
      return payment ? { payment } : undefined;
    }
    default:
      return undefined;
  }
}

/** Plays worth making in a window, best first. */
export function reactions(state: GameState, prompt: Window): GameAction[] {
  const actions: GameAction[] = [];
  for (const reaction of prompt.options) {
    const targets = choose(state, prompt.player, prompt, reaction);
    if (targets === undefined) continue;
    if (reaction.id === "peace_accords") {
      // The most valuable planet Peace Accords can take.
      for (const planet of peaceAccordsTargets(state, prompt.player)) {
        actions.push(reactionAction(reaction, { planet }, prompt.id));
      }
      continue;
    }
    actions.push(reactionAction(reaction, targets, prompt.id));
  }
  return actions;
}

function peaceAccordsTargets(state: GameState, id: PlayerId) {
  return Object.values(state.planets)
    .filter((p) => p.controller !== id)
    .sort(
      (a, b) =>
        planetResources(state, b.name) +
        planetInfluence(state, b.name) -
        planetResources(state, a.name) -
        planetInfluence(state, a.name),
    )
    .slice(0, 5)
    .map((p) => p.name);
}

/** Component actions worth taking on the bot's turn, best first. */
export function componentPlays(state: GameState, id: PlayerId): GameAction[] {
  const actions: GameAction[] = [];
  const planets = controlledPlanets(state, id);
  const home = homePlanet(state, id);
  for (const reaction of componentActions(state, id)) {
    const name = cardName(reaction) ?? reaction.id;
    const play = (targets: EffectTargets = {}) =>
      actions.push(reactionAction(reaction, targets));
    switch (name) {
      case "Mining Initiative": {
        const best = [...planets].sort(
          (a, b) => planetResources(state, b.name) - planetResources(state, a.name),
        )[0];
        if (best && planetResources(state, best.name) >= 2) play({ planet: best.name });
        break;
      }
      case "Industrial Initiative":
        if (planets.filter((p) => planetTraits(state, p.name).includes("INDUSTRIAL")).length >= 2) {
          play();
        }
        break;
      case "Economic Initiative":
        if (
          planets.filter(
            (p) => p.exhausted && planetTraits(state, p.name).includes("CULTURAL"),
          ).length >= 2
        ) {
          play();
        }
        break;
      case "Rise of a Messiah":
        if (planets.length >= 3) play();
        break;
      case "Frontline Deployment":
        if (home) play({ planet: home });
        break;
      case "War Effort": {
        const system = state.systems[state.players[id].home];
        if (hasShips(system.space[id])) play({ system: system.key });
        break;
      }
      case "Insubordination": {
        const target = leader(state, id);
        if (target !== undefined && state.players[target].pools.tactic > 0) {
          play({ player: target });
        }
        break;
      }
      case "Spy": {
        const target = state.seating
          .filter((other) => other !== id && !state.players[other].eliminated)
          .sort(
            (a, b) =>
              state.players[b].actionCards.length - state.players[a].actionCards.length,
          )[0];
        if (target !== undefined && state.players[target].actionCards.length > 0) {
          play({ player: target });
        }
        break;
      }
      case "orbital_drop":
        if (home && state.players[id].pools.strategy >= 2) play({ planet: home });
        break;
      case "star_forge": {
        const system = Object.values(state.systems).find(
          (s) => countOf(s.space[id], "warsun") > 0,
        );
        if (system && state.players[id].pools.strategy >= 2) {
          play({ system: system.key, choice: "destroyer" });
        }
        break;
      }
      case "pm": {
        const other = state.seating.find(
          (p) => p !== id && !state.players[p].eliminated,
        );
        if (other !== undefined && state.players[id].pools.strategy >= 2) play({ player: other });
        break;
      }
    }
  }
  return actions;
}
