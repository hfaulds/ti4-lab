/**
 * Prophecy of Kings exploration: exploration cards, relic fragments, relics
 * and the legendary planets' abilities.
 */
import { PlayerId } from "~/types";
import { isGroundForce, technologiesById } from "../../data";
import { CombatRoll, EffectTargets, GameState, SystemKey } from "../../types";
import { findPayment } from "../../agent/payment";
import {
  adjacentSystems,
  controlledPlanets,
  isHomeSystem,
  isLegendary,
  MECATOL_REX,
  MIRAGE,
  planetInfluence,
  planetOf,
  planetResources,
  systemOf,
  systemsWithShips,
} from "../board";
import { checkElimination, checkVictory, explorePlanet, victoryPoints } from "../control";
import { pay, produce, replenishCommodities } from "../economy";
import { gainTradeGoodsFrom } from "../events";
import {
  addUnits,
  countOf,
  drawActionCards,
  drawSecretObjective,
  ensure,
  hasShips,
  log,
  playerName,
  playerOf,
  plural,
  removeUnits,
  rollDie,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "../helpers";
import {
  checkFragments,
  convertCommodities,
  exhaustRelic,
  fragmentSet,
  gainCommandTokens,
  gainCommodities,
  gainRelic,
  poolChoice,
  purgeFragments,
  purgeRelic,
  readyRelic,
} from "../relics";
import { rollHits } from "../combat";
import { missingPrerequisites, research, researchableTechnologies } from "../technology";
import { destroyUnits, ownPlanet, placeUnits, setTacticalFlag, targetPlanet, targetSystem, targetTechnology } from "./helpers";
import type { EffectArea } from "./index";
import { Effect } from "./types";

const NO_PAYMENT = { planets: [], tradeGoods: 0 };

/** The planet an exploration card was drawn for. */
function exploredPlanet(state: GameState, context: { planet?: string }) {
  ensure(context.planet, "This card resolves on a planet.");
  return planetOf(state, context.planet);
}

const hasMechOn = (state: GameState, id: PlayerId, planet: string) =>
  countOf(state.planets[planet]?.units[id], "mech") > 0;

/**
 * "If you have at least 1 mech on this planet, or if you remove 1 infantry
 * from this planet": checks the condition, removing the infantry if asked.
 * Returns whether the card's reward applies.
 */
function mechOrInfantry(
  state: GameState,
  id: PlayerId,
  planet: string,
  targets: EffectTargets,
) {
  if (hasMechOn(state, id, planet)) return true;
  if (targets.unit !== "infantry") return false;
  const units = planetOf(state, planet).units;
  ensure(countOf(units[id], "infantry") > 0, `You have no infantry on ${planet}.`);
  removeUnits(units, id, "infantry", 1);
  log(state, `${playerName(state, id)} removed 1 infantry from ${planet}.`, { player: id });
  return true;
}

const mechOrInfantryBot = (state: GameState, id: PlayerId, planet: string | undefined) =>
  planet && !hasMechOn(state, id, planet) && countOf(state.planets[planet]?.units[id], "infantry") > 0
    ? { unit: "infantry" as const }
    : {};

/** A pool for gained command tokens: the bot keeps its tactic pool stocked. */
const botPool = (state: GameState, id: PlayerId) => {
  const pools = state.players[id].pools;
  return pools.tactic <= pools.fleet ? "tactic" : pools.strategy < 2 ? "strategy" : "fleet";
};

function placeWormholeToken(state: GameState, key: SystemKey | undefined, wormhole: "GAMMA") {
  if (key === undefined) return;
  const system = systemOf(state, key);
  system.addedWormholes.push(wormhole);
  log(state, `A ${wormhole.toLowerCase()} wormhole token was placed.`);
}

/** Spending 1 trade good, or a commodity if they have one. */
function spendTradeGoodOrCommodity(state: GameState, id: PlayerId) {
  const player = playerOf(state, id);
  if (player.commodities > 0) player.commodities--;
  else {
    ensure(player.tradeGoods > 0, "You have no trade goods or commodities to spend.");
    player.tradeGoods--;
  }
}

// --- Exploration cards ----------------------------------------------------------

const EXPLORATIONS: Record<string, Effect> = {
  Freelancers: {
    targets: ["production", "payment"],
    resolve: (state, id, targets, context) => {
      const orders = (targets.production ?? []).filter((o) => o.count > 0);
      if (orders.length === 0 || context.system === undefined) return;
      produce(state, id, context.system, orders, targets.payment ?? NO_PAYMENT, {
        limit: 1,
        currency: "either",
      });
    },
    bot: (state, id, context) => {
      const system = context.system !== undefined ? state.systems[context.system] : undefined;
      if (!system) return undefined;
      const blockaded = Object.keys(system.space)
        .map(Number)
        .some((other) => other !== id && hasShips(system.space[other]));
      const type = !blockaded && unitsAvailable(state, id, "destroyer") > 0 ? "destroyer" : "infantry";
      const payment = findPayment(state, id, unitOf(state, id, type)?.cost ?? 1, "resources");
      if (!payment) return undefined;
      return {
        production: [{ type, count: 1, planet: type === "infantry" ? context.planet : undefined }],
        payment,
      };
    },
  },
  "Mercenary Outfit": {
    resolve: (state, id, _targets, context) => {
      const planet = exploredPlanet(state, context);
      placeUnits(state, id, "infantry", 1, { system: planet.system, planet: planet.name });
    },
  },
  "Gamma Wormhole": {
    resolve: (state, _id, _targets, context) => placeWormholeToken(state, context.system, "GAMMA"),
  },
  "Gamma Relay": {
    resolve: (state, _id, _targets, context) => placeWormholeToken(state, context.system, "GAMMA"),
  },
  "Demilitarized Zone": {
    resolve: (state, id, _targets, context) => {
      const planet = exploredPlanet(state, context);
      const space = systemOf(state, planet.system).space;
      for (const type of unitTypes(planet.units[id])) {
        const count = countOf(planet.units[id], type);
        removeUnits(planet.units, id, type, count);
        if (isGroundForce(type)) addUnits(space, id, type, count);
      }
      log(state, `${playerName(state, id)} cleared ${planet.name} for the demilitarized zone.`, {
        player: id,
      });
    },
  },
  "Volatile Fuel Source": {
    targets: ["unit", "choice"],
    resolve: (state, id, targets, context) => {
      if (mechOrInfantry(state, id, exploredPlanet(state, context).name, targets)) {
        gainCommandTokens(state, id, 1, poolChoice(targets.choice));
      }
    },
    bot: (state, id, context) => ({
      ...mechOrInfantryBot(state, id, context.planet),
      choice: botPool(state, id),
    }),
  },
  Expedition: {
    targets: ["unit"],
    resolve: (state, id, targets, context) => {
      const planet = exploredPlanet(state, context);
      if (mechOrInfantry(state, id, planet.name, targets)) planet.exhausted = false;
    },
    bot: (state, id, context) => mechOrInfantryBot(state, id, context.planet),
  },
  "Core Mine": {
    targets: ["unit"],
    resolve: (state, id, targets, context) => {
      if (mechOrInfantry(state, id, exploredPlanet(state, context).name, targets)) {
        gainTradeGoodsFrom(state, id, 1, "Core Mine");
      }
    },
    bot: (state, id, context) => mechOrInfantryBot(state, id, context.planet),
  },
  "Abandoned Warehouses": {
    targets: ["choice"],
    resolve: (state, id, targets) => {
      if (targets.choice === "convert") convertCommodities(state, id, 2);
      else gainCommodities(state, id, 2);
    },
    bot: (state, id) => ({ choice: state.players[id].commodities > 0 ? "convert" : "commodities" }),
  },
  "Functioning Base": {
    targets: ["choice"],
    resolve: (state, id, targets) => {
      if (targets.choice === "actionCard") {
        spendTradeGoodOrCommodity(state, id);
        drawActionCards(state, id, 1);
      } else {
        gainCommodities(state, id, 1);
      }
    },
    bot: (state, id) => {
      const player = state.players[id];
      return { choice: player.commodities > 0 || player.tradeGoods > 1 ? "actionCard" : "commodity" };
    },
  },
  "Local Fabricators": {
    targets: ["choice"],
    resolve: (state, id, targets, context) => {
      if (targets.choice === "mech") {
        const planet = exploredPlanet(state, context);
        ensure(unitsAvailable(state, id, "mech") > 0, "You have no mechs in your reinforcements.");
        spendTradeGoodOrCommodity(state, id);
        placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
      } else {
        gainCommodities(state, id, 1);
      }
    },
    bot: (state, id) => {
      const player = state.players[id];
      const canPay = player.commodities > 0 || player.tradeGoods > 0;
      return { choice: canPay && unitsAvailable(state, id, "mech") > 0 ? "mech" : "commodity" };
    },
  },
  "Derelict Vessel": {
    resolve: (state, id) => drawSecretObjective(state, id),
  },
  "Enigmatic Device": {
    // Kept in the play area when drawn; used to research for 6 resources.
    action: true,
    targets: ["technology", "payment", "planets"],
    usable: (state, id) => !!state.players[id].explorationCards?.some((c) => c.startsWith("ed")),
    play: (state, id, targets) => {
      targetTechnology(targets);
      pay(state, id, targets.payment, "resources", 6);
      const player = playerOf(state, id);
      const card = player.explorationCards!.find((c) => c.startsWith("ed"))!;
      player.explorationCards = player.explorationCards!.filter((c) => c !== card);
      log(state, `${player.name} purged Enigmatic Device.`, { player: id });
    },
    resolve: (state, id, targets) =>
      research(state, id, { technology: targetTechnology(targets), skips: targets.planets }),
    bot: (state, id) => {
      const tech = researchableTechnologies(state, id).find(
        (t) => missingPrerequisites(state, id, t.id).length === 0,
      );
      const payment = findPayment(state, id, 6, "resources");
      return tech && payment ? { technology: tech.id, payment } : undefined;
    },
  },
  "Ion Storm": {
    targets: ["choice"],
    resolve: (state, _id, targets, context) => {
      if (context.system === undefined) return;
      const side = targets.choice === "beta" ? "BETA" : "ALPHA";
      for (const system of Object.values(state.systems)) {
        system.addedWormholes = system.addedWormholes.filter(
          (w) => !(state.ionStorm?.system === system.key && w === state.ionStorm.side),
        );
      }
      state.ionStorm = { system: context.system, side };
      systemOf(state, context.system).addedWormholes.push(side);
      log(state, `The ion storm was placed with its ${side.toLowerCase()} side up.`);
    },
    bot: () => ({ choice: "alpha" }),
  },
  "Lost Crew": {
    resolve: (state, id) => drawActionCards(state, id, 2),
  },
  "Merchant Station": {
    targets: ["choice"],
    resolve: (state, id, targets) => {
      if (targets.choice === "convert") convertCommodities(state, id);
      else replenishCommodities(state, id);
    },
    bot: (state, id) => {
      const player = state.players[id];
      return { choice: player.commodities >= player.commodityLimit ? "convert" : "replenish" };
    },
  },
  Mirage: {
    resolve: (state, id, _targets, context) => {
      if (context.system === undefined || state.planets[MIRAGE]) return;
      const system = systemOf(state, context.system);
      system.planets.push(MIRAGE);
      state.planets[MIRAGE] = {
        name: MIRAGE,
        system: system.key,
        controller: id,
        exhausted: false,
        units: {},
        attachments: [],
        legendaryExhausted: false,
      };
      log(state, `${playerName(state, id)} found the Mirage and took control of it.`, { player: id });
    },
  },
  "Minor Entropic Field": {
    targets: ["choice"],
    resolve: (state, id, targets) => {
      gainCommandTokens(state, id, 1, poolChoice(targets.choice));
      gainTradeGoodsFrom(state, id, 1, "Minor Entropic Field");
    },
    bot: (state, id) => ({ choice: botPool(state, id) }),
  },
  "Entropic Field": {
    targets: ["choice"],
    resolve: (state, id, targets) => {
      gainCommandTokens(state, id, 1, poolChoice(targets.choice));
      gainTradeGoodsFrom(state, id, 2, "Entropic Field");
    },
    bot: (state, id) => ({ choice: botPool(state, id) }),
  },
  "Major Entropic Field": {
    targets: ["choice"],
    resolve: (state, id, targets) => {
      gainCommandTokens(state, id, 1, poolChoice(targets.choice));
      gainTradeGoodsFrom(state, id, 3, "Major Entropic Field");
    },
    bot: (state, id) => ({ choice: botPool(state, id) }),
  },
  "Keleres Ship": {
    targets: ["choice"],
    resolve: (state, id, targets) => gainCommandTokens(state, id, 2, poolChoice(targets.choice)),
    bot: (state, id) => ({ choice: botPool(state, id) }),
  },
  "Dead World": {
    resolve: (state, id) => {
      gainRelic(state, id);
    },
  },
};

/** Purging 3 relic fragments of one type for a relic. */
const fragmentAction: Effect = {
  action: true,
  targets: ["fragments"],
  usable: (state, id) => fragmentSet(state, id, 3) !== undefined,
  play: (state, id, targets) => {
    purgeFragments(state, id, checkFragments(state, id, targets.fragments, 3));
  },
  resolve: (state, id) => {
    gainRelic(state, id);
  },
  bot: (state, id) => ({ fragments: fragmentSet(state, id, 3) }),
};

for (const name of [
  "Cultural Relic Fragment",
  "Hazardous Relic Fragment",
  "Industrial Relic Fragment",
  "Unknown Relic Fragment",
]) {
  EXPLORATIONS[name] = fragmentAction;
}

// --- Relics ---------------------------------------------------------------------

/** Units with BOMBARDMENT that a player has in a system. */
const hasBombardmentIn = (state: GameState, id: PlayerId, key: SystemKey) => {
  const system = state.systems[key];
  const groups = [system.space[id], ...system.planets.map((p) => state.planets[p].units[id])];
  return groups.some((group) =>
    unitTypes(group).some((type) => unitOf(state, id, type)?.bombardment !== undefined),
  );
};

/** Planets the Stellar Converter can destroy. */
function convertible(state: GameState, id: PlayerId) {
  return Object.values(state.planets).filter((planet) => {
    const system = state.systems[planet.system];
    if (isHomeSystem(system) || isLegendary(state, planet.name) || planet.name === MECATOL_REX) {
      return false;
    }
    return adjacentSystems(state, planet.system).some((key) => hasBombardmentIn(state, id, key));
  });
}

/** Removes a planet from the game: its units, attachments and card. */
function destroyPlanet(state: GameState, name: string, by: PlayerId) {
  const planet = planetOf(state, name);
  const where = { system: planet.system, planet: name };
  for (const owner of Object.keys(planet.units).map(Number)) {
    for (const type of unitTypes(planet.units[owner])) {
      destroyUnits(state, owner, where, type, countOf(planet.units[owner], type), by);
    }
  }
  const controller = planet.controller;
  const system = systemOf(state, planet.system);
  system.planets = system.planets.filter((p) => p !== name);
  delete state.planets[name];
  log(state, `${name} was destroyed.`);
  if (controller !== undefined) checkElimination(state, controller);
}

const RELICS: Record<string, Effect> = {
  dominusorb: {
    windows: ["afterActivate"],
    usable: (state, id, context) => context.player === id && state.tactical?.step === "movement",
    play: (state, id) => purgeRelic(state, id, "dominusorb"),
    resolve: (state, id) => setTacticalFlag(state, "dominus", id),
  },
  mawofworlds: {
    windows: ["agendaStart"],
    targets: ["technology"],
    play: (state, id, targets) => {
      const tech = targetTechnology(targets);
      ensure(
        researchableTechnologies(state, id).some((t) => t.id === tech),
        "Choose a technology you do not own.",
      );
      purgeRelic(state, id, "mawofworlds");
      for (const planet of controlledPlanets(state, id)) planet.exhausted = true;
    },
    resolve: (state, id, targets) => {
      const tech = targetTechnology(targets);
      state.players[id].technologies.push(tech);
      log(state, `${playerName(state, id)} gained ${technologiesById[tech]?.name ?? tech}.`, {
        player: id,
      });
    },
    bot: (state, id) => {
      const best = researchableTechnologies(state, id)
        .filter((t) => missingPrerequisites(state, id, t.id).length >= 2)
        .sort((a, b) => b.prerequisites.length - a.prerequisites.length)[0];
      return best ? { technology: best.id } : undefined;
    },
  },
  stellarconverter: {
    action: true,
    targets: ["planet"],
    usable: (state, id) => convertible(state, id).length > 0,
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      ensure(
        convertible(state, id).some((p) => p.name === planet.name),
        "Choose a non-home, non-legendary planet other than Mecatol Rex next to your units with BOMBARDMENT.",
      );
      purgeRelic(state, id, "stellarconverter");
    },
    resolve: (state, id, targets) => destroyPlanet(state, targetPlanet(state, targets).name, id),
    bot: (state, id) => {
      const best = convertible(state, id)
        .filter((p) => p.controller !== undefined && p.controller !== id)
        .sort(
          (a, b) =>
            planetResources(state, b.name) + planetInfluence(state, b.name) -
            (planetResources(state, a.name) + planetInfluence(state, a.name)),
        )[0];
      return best && planetResources(state, best.name) + planetInfluence(state, best.name) >= 4
        ? { planet: best.name }
        : undefined;
    },
  },
  codex: {
    action: true,
    targets: ["cards"],
    usable: (state) => state.decks.actionCards.discard.length > 0,
    play: (state, id, targets) => {
      const cards = targets.cards ?? [];
      ensure(cards.length <= 3, "Take up to 3 action cards.");
      ensure(new Set(cards).size === cards.length, "Choose different action cards.");
      for (const card of cards) {
        ensure(state.decks.actionCards.discard.includes(card), "That card is not in the discard pile.");
      }
      purgeRelic(state, id, "codex");
    },
    resolve: (state, id, targets) => {
      const cards = targets.cards ?? [];
      const discard = state.decks.actionCards.discard;
      state.decks.actionCards.discard = discard.filter((card) => !cards.includes(card));
      playerOf(state, id).actionCards.push(...cards);
      log(state, `${playerName(state, id)} took ${plural(cards.length, "action card")} from the discard pile.`, {
        player: id,
      });
    },
    bot: (state) => ({ cards: state.decks.actionCards.discard.slice(-3) }),
  },
  emphidia: {
    windows: ["afterTacticalAction", "statusEnd"],
    targets: ["planet"],
    usable: (state, id, context) => {
      if (state.phase === "status") return tombControlled(state, id);
      return context.player === id && readyRelic(state, id, "emphidia");
    },
    play: (state, id, targets) => {
      if (state.phase === "status") {
        purgeRelic(state, id, "emphidia");
        return;
      }
      ownPlanet(state, id, targets);
      exhaustRelic(state, id, "emphidia");
    },
    resolve: (state, id, targets) => {
      if (state.phase === "status") {
        state.players[id].bonusVictoryPoints += 1;
        log(state, `${playerName(state, id)} gained 1 victory point (${victoryPoints(state, id)} VP).`, {
          player: id,
        });
        checkVictory(state);
        return;
      }
      explorePlanet(state, id, ownPlanet(state, id, targets).name);
    },
    bot: (state, id) => {
      if (state.phase === "status") return {};
      const planet = controlledPlanets(state, id).find((p) => isHomeSystem(state.systems[p.system]) === false);
      return planet ? { planet: planet.name } : undefined;
    },
  },
  thalnos: {
    windows: ["afterRolls"],
    usable: (state, id) => {
      const combat = state.tactical?.groundCombat ?? state.tactical?.spaceCombat;
      return !!combat?.rolls?.some((r) => r.player === id && r.dice.some((d) => d + (r.modifier ?? 0) < r.target));
    },
    resolve: (state, id) => {
      const tactical = state.tactical!;
      const combat = tactical.groundCombat ?? tactical.spaceCombat!;
      const where = { system: tactical.system, planet: tactical.groundCombat?.planet };
      const rerolls: CombatRoll[] = [];
      for (const roll of combat.rolls ?? []) {
        if (roll.player !== id) continue;
        const modifier = roll.modifier ?? 0;
        const missed = roll.dice.filter((d) => d + modifier < roll.target);
        if (missed.length === 0) continue;
        roll.dice = roll.dice.filter((d) => d + modifier >= roll.target);
        roll.hits = rollHits(state, roll);
        // Rerolled dice get +1, so they become a roll of their own.
        const again: CombatRoll = {
          ...roll,
          dice: missed.map(() => rollDie(state)),
          modifier: modifier + 1,
        };
        again.hits = rollHits(state, again);
        rerolls.push(again);
      }
      combat.rolls = [...(combat.rolls ?? []), ...rerolls];
      for (const roll of rerolls) {
        const failed = roll.dice.filter((d) => d + roll.modifier! < roll.target).length;
        if (failed > 0) destroyUnits(state, id, where, roll.unit, failed);
      }
      log(state, `${playerName(state, id)} rerolled with The Crown of Thalnos.`, {
        player: id,
        rolls: rerolls,
      });
    },
  },
};

const tombControlled = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id).some((p) => p.attachments.includes("tombofemphidia"));

// --- Legendary planets ------------------------------------------------------------

const atTurnEnd = (state: GameState, id: PlayerId, context: { player?: PlayerId }) =>
  context.player === id && state.turnEnding === id;

const LEGENDARY: Record<string, Effect> = {
  Primor: {
    windows: ["turnEnd"],
    targets: ["planet"],
    usable: atTurnEnd,
    play: (state, id, targets) => {
      ownPlanet(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "infantry", 2, { system: planet.system, planet: planet.name });
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id).find((p) => isHomeSystem(state.systems[p.system]));
      return planet ? { planet: planet.name } : undefined;
    },
  },
  "Hope's End": {
    windows: ["turnEnd"],
    targets: ["choice", "planet"],
    usable: atTurnEnd,
    play: (state, id, targets) => {
      if (targets.choice === "mech") ownPlanet(state, id, targets);
    },
    resolve: (state, id, targets) => {
      if (targets.choice === "mech") {
        const planet = ownPlanet(state, id, targets);
        placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
      } else {
        drawActionCards(state, id, 1);
      }
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id).find((p) => p.name === "Hope's End");
      return unitsAvailable(state, id, "mech") > 0 && planet
        ? { choice: "mech", planet: planet.name }
        : { choice: "actionCard" };
    },
  },
  Mallice: {
    windows: ["turnEnd"],
    targets: ["choice"],
    usable: atTurnEnd,
    resolve: (state, id, targets) => {
      if (targets.choice === "convert") convertCommodities(state, id);
      else gainTradeGoodsFrom(state, id, 2, "Mallice");
    },
    bot: (state, id) => ({ choice: state.players[id].commodities > 2 ? "convert" : "tradeGoods" }),
  },
  [MIRAGE]: {
    windows: ["turnEnd"],
    targets: ["system"],
    usable: (state, id, context) =>
      atTurnEnd(state, id, context) && unitsAvailable(state, id, "fighter") > 0,
    play: (state, id, targets) => {
      ensure(hasShips(targetSystem(state, targets).space[id]), "Choose a system with your ships.");
    },
    resolve: (state, id, targets) =>
      placeUnits(state, id, "fighter", 2, { system: targetSystem(state, targets).key }),
    bot: (state, id) => {
      const system = systemsWithShips(state, id).sort(
        (a, b) =>
          (unitOf(state, id, "carrier") ? countOf(b.space[id], "carrier") - countOf(a.space[id], "carrier") : 0),
      )[0];
      return system ? { system: system.key } : undefined;
    },
  },
};

export const EXPLORATION_EFFECTS: EffectArea = {
  actionCards: {},
  abilities: {},
  notes: {},
  explorations: EXPLORATIONS,
  relics: RELICS,
  planets: LEGENDARY,
};
