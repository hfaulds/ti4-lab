/**
 * Thunder's Edge: expeditions, breakthroughs, action cards, relics, leaders,
 * promissory notes, technologies and legendary planets.
 */
import { PlayerId } from "~/types";
import { isShip, isStructure, technologiesById, UNIT_NAMES, UnitType } from "../../data";
import { findPayment } from "../../agent/payment";
import { GameState, SystemKey } from "../../types";
import {
  adjacentSystems,
  controlledPlanets,
  hasAnomaly,
  isHomeSystem,
  isLegendary,
  planetOf,
  planetResources,
  planetTechSpecialties,
  systemOf,
  systemsWithShips,
} from "../board";
import { checkElimination, checkVictory, gainControl, victoryPoints } from "../control";
import { pay } from "../economy";
import {
  addUnits,
  countOf,
  drawActionCards,
  ensure,
  galvanize,
  hasShips,
  log,
  playerName,
  playerOf,
  plural,
  removeUnits,
  rollDie,
  shuffle,
  totalUnits,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "../helpers";
import { leaderOf, readyLeader } from "../leaders";
import { availableStrategyCards } from "../phases";
import { gainCommandTokens, gainRelic, purgeRelic } from "../relics";
import { askSecondaries } from "../strategic";
import { describeSystem } from "../tactical";
import { research } from "../technology";
import {
  EXPEDITION_SLICES,
  exhaustBreakthrough,
  gainBreakthrough,
  hasBreakthrough,
  readyBreakthrough,
} from "../thundersEdge";
import {
  destroyUnits,
  ownPlanet,
  placeUnits,
  setTacticalFlag,
  targetPlanet,
  targetPlayer,
  targetSystem,
  targetTechnology,
} from "./helpers";
import type { EffectArea } from "./index";
import { Effect } from "./types";

const others = (state: GameState, id: PlayerId) =>
  state.seating.filter((other) => other !== id && !state.players[other].eliminated);

const ownTurnEnd = (state: GameState, id: PlayerId, context: { player?: PlayerId }) =>
  context.player === id && state.turnEnding === id;

/** At the end of the player's turn, once they have passed. */
const passingNow = (state: GameState, id: PlayerId, context: { player?: PlayerId }) =>
  ownTurnEnd(state, id, context) && state.players[id].passed;

// --- Expeditions ------------------------------------------------------------------

/** What each slice of the expedition token costs, in order. */
const SLICE_COSTS = [
  "spend 5 resources",
  "discard 2 action cards",
  "spend 5 influence",
  "discard 1 unscored secret objective",
  "exhaust a planet with a technology specialty",
  "spend 3 trade goods",
];

const specialtyPlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id).filter(
    (p) => !p.exhausted && planetTechSpecialties(state, p.name).length > 0,
  );

function payForSlice(state: GameState, id: PlayerId, slice: number, targets: Parameters<Effect["resolve"]>[2]) {
  const player = playerOf(state, id);
  switch (slice) {
    case 1:
      pay(state, id, targets.payment, "resources", 5);
      return;
    case 2: {
      const cards = targets.cards ?? [];
      ensure(cards.length === 2 && cards.every((c) => player.actionCards.includes(c)), "Discard 2 of your action cards.");
      for (const card of cards) {
        player.actionCards.splice(player.actionCards.indexOf(card), 1);
        state.decks.actionCards.discard.push(card);
      }
      return;
    }
    case 3:
      pay(state, id, targets.payment, "influence", 5);
      return;
    case 4: {
      const secret = targets.card ?? "";
      ensure(player.secretObjectives.includes(secret), "Discard 1 of your unscored secret objectives.");
      player.secretObjectives.splice(player.secretObjectives.indexOf(secret), 1);
      state.decks.secretObjectives.draw = shuffle(state, [...state.decks.secretObjectives.draw, secret]);
      return;
    }
    case 5: {
      const planet = ownPlanet(state, id, targets);
      ensure(
        !planet.exhausted && planetTechSpecialties(state, planet.name).length > 0,
        "Exhaust a ready planet with a technology specialty.",
      );
      planet.exhausted = true;
      return;
    }
    case 6:
      ensure(player.tradeGoods >= 3, "You need 3 trade goods.");
      player.tradeGoods -= 3;
      return;
  }
}

/** The cheapest expedition slice a bot could pay for, with the choices it needs. */
function botSlice(state: GameState, id: PlayerId) {
  const open = (slice: number) => state.expedition?.[slice - 1] === null;
  const player = state.players[id];
  if (open(6) && player.tradeGoods >= 4) return { choice: "6" };
  if (open(2) && player.actionCards.length >= 4) return { choice: "2", cards: player.actionCards.slice(0, 2) };
  const specialty = specialtyPlanets(state, id)[0];
  if (open(5) && specialty) return { choice: "5", planet: specialty.name };
  for (const [slice, currency] of [[1, "resources"], [3, "influence"]] as const) {
    if (!open(slice)) continue;
    const payment = findPayment(state, id, 5, currency);
    if (payment) return { choice: String(slice), payment };
  }
  return undefined;
}

const EXPEDITION: Effect = {
  windows: ["turnEnd"],
  targets: ["choice", "payment", "cards", "card", "planet"],
  usable: (state, id, context) => ownTurnEnd(state, id, context) && !!state.expedition?.includes(null),
  play: (state, id, targets) => {
    const slice = Number(targets.choice);
    ensure(
      Number.isInteger(slice) && slice >= 1 && slice <= EXPEDITION_SLICES && state.expedition?.[slice - 1] === null,
      `Choose an unclaimed slice: ${SLICE_COSTS.map((c, i) => `${i + 1} (${c})`).join(", ")}.`,
    );
    payForSlice(state, id, slice, targets);
  },
  resolve: (state, id, targets) => {
    const slice = Number(targets.choice);
    state.expedition![slice - 1] = id;
    log(state, `${playerName(state, id)} claimed expedition slice ${slice}.`, { player: id });
    gainBreakthrough(state, id);
    if (!state.expedition!.includes(null)) {
      log(state, "The expedition is complete: Thunder's Edge is placed on the board by hand.");
    }
  },
  // Bots go on an expedition for their breakthrough, then stop.
  bot: (state, id) => (hasBreakthrough(state, id) ? undefined : botSlice(state, id)),
};

// --- Breakthroughs ----------------------------------------------------------------

const BREAKTHROUGHS: Record<string, Effect> = {
  arborecbt: {
    action: true,
    targets: ["system"],
    usable: (state, id) => readyBreakthrough(state, id, "arborecbt"),
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(system.commandTokens.length > 0, "Choose a system with a command token.");
      const infantry =
        countOf(system.space[id], "infantry") +
        system.planets.reduce((sum, p) => sum + countOf(state.planets[p].units[id], "infantry"), 0);
      ensure(infantry > 0, "Choose a system with your infantry.");
      exhaustBreakthrough(state, id, "arborecbt");
    },
    resolve: (state, id, targets) => {
      const system = targetSystem(state, targets);
      const token = system.commandTokens.includes(id) ? id : system.commandTokens[0];
      system.commandTokens = system.commandTokens.filter((t) => t !== token);
      const planet = system.planets.find((p) => countOf(state.planets[p].units[id], "infantry") > 0);
      placeUnits(state, id, "infantry", 1, { system: system.key, planet });
      log(state, `Psychospore removed a command token from ${describeSystem(state, system.key)}.`, { player: id });
    },
    bot: (state, id) => {
      const system = Object.values(state.systems).find(
        (s) =>
          s.commandTokens.includes(id) &&
          s.planets.some((p) => countOf(state.planets[p].units[id], "infantry") > 0),
      );
      return system ? { system: system.key } : undefined;
    },
  },
  mahactbt: {
    action: true,
    targets: ["technology"],
    usable: (state, id) => readyBreakthrough(state, id, "mahactbt"),
    play: (state, id, targets) => {
      const tech = targetTechnology(targets);
      ensure(state.players[id].technologies.includes(tech), "Purge one of your technologies.");
      exhaustBreakthrough(state, id, "mahactbt");
    },
    resolve: (state, id, targets) => {
      const player = playerOf(state, id);
      player.technologies = player.technologies.filter((t) => t !== targets.technology);
      log(state, `${player.name} purged ${technologiesById[targets.technology!]?.name}.`, { player: id });
      gainRelic(state, id);
    },
  },
  saarbt: {
    action: true,
    targets: ["planet", "payment"],
    usable: (state, id) => readyBreakthrough(state, id, "saarbt"),
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      const fields = systemsWithShips(state, id).filter((s) => hasAnomaly(s, "ASTEROID_FIELD"));
      const near = (key: SystemKey) =>
        fields.some(
          (f) =>
            f.key === key ||
            adjacentSystems(state, f.key).some((k) => k === key || adjacentSystems(state, k).includes(key)),
        );
      ensure(near(planet.system), "Choose a planet within 2 systems of an asteroid field with your ships.");
      exhaustBreakthrough(state, id, "saarbt");
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      const spent = (targets.payment?.planets ?? []).reduce((sum, p) => sum + planetResources(state, p), 0) +
        (targets.payment?.tradeGoods ?? 0);
      pay(state, id, targets.payment, "resources", spent);
      const hits = Array.from({ length: spent }, () => rollDie(state)).filter((d) => d >= 4).length;
      let remaining = hits;
      for (const owner of Object.keys(planet.units).map(Number)) {
        if (owner === id) continue;
        for (const type of ["infantry", "mech"] as UnitType[]) {
          remaining -= destroyUnits(state, owner, { system: planet.system, planet: planet.name }, type, Math.min(remaining, countOf(planet.units[owner], type)), id);
        }
      }
      log(state, `Deorbit Barrage: ${plural(hits, "hit")} on ${planet.name}.`, { player: id });
    },
  },
  nomadbt: {
    windows: ["turnStart"],
    targets: ["card"],
    usable: (state, id) =>
      state.players[id].leaders.some((l) => l.type === "agent" && l.status === "ready") &&
      state.seating.some((p) => state.players[p].leaders.some((l) => l.type === "agent" && l.status === "exhausted")),
    play: (state, id, targets) => {
      const own = state.players[id].leaders.find((l) => l.type === "agent" && l.status === "ready")!;
      ensure(targets.card && targets.card !== own.id, "Choose another agent to ready.");
      own.status = "exhausted";
    },
    resolve: (state, _id, targets) => {
      const owner = state.seating.find((p) => leaderOf(state, p, targets.card!));
      if (owner !== undefined) readyLeader(state, owner, targets.card!);
    },
  },
  sardakkbt: {
    windows: ["afterCombat"],
    targets: ["choice", "technology"],
    resolve: (state, id, targets) => {
      if (targets.choice === "research" && targets.technology) {
        const tech = technologiesById[targets.technology];
        ensure(tech?.unitUpgrade, "Research a unit upgrade technology.");
        research(state, id, { technology: tech.id });
      } else {
        gainCommandTokens(state, id, 1);
      }
    },
    bot: () => ({ choice: "token" }),
  },
};

// --- Action cards -----------------------------------------------------------------

const ACTION_CARDS: Record<string, Effect> = {
  Strategize: {
    action: true,
    targets: ["card"],
    play: (state, _id, targets) => {
      ensure(readiedCards(state).includes(targets.card ?? ""), "Choose a readied or unchosen strategy card.");
    },
    resolve: (state, id, targets) => askSecondaries(state, id, targets.card!, [id], []),
    bot: (state, id) => {
      const card = readiedCards(state).find((c) => !state.players[id].strategyCards.some((h) => h.id === c));
      return card && state.players[id].pools.strategy > 0 ? { card } : undefined;
    },
  },
  Brilliance: {
    action: true,
    targets: ["planet", "player"],
    play: (state, id, targets) => {
      if (targets.player !== undefined) {
        targetPlayer(state, id, targets, { other: false });
        return;
      }
      const planet = ownPlanet(state, id, targets);
      ensure(planetTechSpecialties(state, planet.name).length > 0, "Choose a planet with a technology specialty.");
    },
    resolve: (state, id, targets) => {
      if (targets.player !== undefined) gainBreakthrough(state, targets.player);
      else targetPlanet(state, targets).exhausted = false;
    },
    bot: (state, id) => (hasBreakthrough(state, id) ? undefined : { player: id }),
  },
  Rescue: {
    windows: ["afterMove"],
    targets: ["system", "unit"],
    usable: (state, id, context) =>
      context.player !== id && context.system !== undefined && hasShips(systemOf(state, context.system).space[id]),
    play: (state, id, targets) => {
      const from = targetSystem(state, targets);
      ensure(!from.commandTokens.includes(id), "Choose a system without your command token.");
      ensure(targets.unit && isShip(targets.unit) && countOf(from.space[id], targets.unit) > 0, "Choose 1 of your ships there.");
    },
    resolve: (state, id, targets, context) => {
      const from = targetSystem(state, targets);
      const to = systemOf(state, context.system!);
      removeUnits(from.space, id, targets.unit!, 1);
      addUnits(to.space, id, targets.unit!, 1);
      log(state, `${playerName(state, id)} moved a ${UNIT_NAMES[targets.unit!]} to the rescue.`, { player: id });
    },
  },
  Crisis: {
    windows: ["turnEnd"],
    usable: (state) => state.seating.filter((p) => !state.players[p].passed && !state.players[p].eliminated).length >= 2,
    resolve: (state) => {
      state.skipTurn = true;
      log(state, "Crisis: the next player's turn is skipped.");
    },
  },
  "Extreme Duress": {
    windows: ["turnStart"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      state.players[context.player].strategyCards.some((c) => !c.exhausted),
    resolve: (state, id, _targets, context) => {
      state.duress = { player: context.player!, by: id };
    },
  },
};

const readiedCards = (state: GameState) => [
  ...availableStrategyCards(state),
  ...state.seating.flatMap((p) => state.players[p].strategyCards.filter((c) => !c.exhausted).map((c) => c.id)),
];

// --- Relics -------------------------------------------------------------------------

const RELICS: Record<string, Effect> = {
  thesilverflame: {
    action: true,
    play: (state, id) => purgeRelic(state, id, "thesilverflame"),
    resolve: (state, id) => {
      const roll = rollDie(state);
      const player = playerOf(state, id);
      if (roll === 10) {
        player.bonusVictoryPoints += 1;
        log(state, `${player.name} rolled 10 with The Silver Flame and gained 1 victory point (${victoryPoints(state, id)} VP).`, {
          player: id,
        });
        checkVictory(state);
        return;
      }
      // The home system is lost, and with it the right to score publics.
      const home = systemOf(state, player.home);
      for (const owner of Object.keys(home.space).map(Number)) {
        for (const type of unitTypes(home.space[owner])) destroyUnits(state, owner, { system: home.key }, type, countOf(home.space[owner], type));
      }
      for (const name of home.planets) {
        const planet = state.planets[name];
        for (const owner of Object.keys(planet.units).map(Number)) {
          for (const type of unitTypes(planet.units[owner])) {
            destroyUnits(state, owner, { system: home.key, planet: name }, type, countOf(planet.units[owner], type));
          }
        }
        delete state.planets[name];
      }
      home.planets = [];
      player.noPublicObjectives = true;
      state.fracture = true;
      log(state, `${player.name} rolled ${roll} with The Silver Flame and lost their home system.`, { player: id });
      checkElimination(state, id);
    },
  },
};

// --- Leaders --------------------------------------------------------------------------

const LEADERS: Record<string, Effect> = {
  bastionagent: {
    windows: ["unitDestroyedInCombat"],
    usable: (state, _id, context) => {
      if (context.player === undefined || context.system === undefined) return false;
      const system = systemOf(state, context.system);
      return unitTypes(system.space[context.player]).length > 0;
    },
    resolve: (state, _id, _targets, context) => {
      const system = systemOf(state, context.system!);
      const group = system.space[context.player!];
      const type = unitTypes(group).find((t) => (group?.[t]?.galvanized ?? 0) < (group?.[t]?.count ?? 0));
      if (type) galvanize(group, type);
    },
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  ralnelagent: {
    action: true,
    targets: ["player"],
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const player = playerOf(state, id);
      const before = player.actionCards.length;
      drawActionCards(state, id, 2);
      const drawn = player.actionCards.slice(before);
      const given = drawn[0];
      if (given) {
        player.actionCards.splice(player.actionCards.indexOf(given), 1);
        playerOf(state, targetPlayer(state, id, targets)).actionCards.push(given);
      }
    },
    bot: (state, id) => ({ player: others(state, id)[0] }),
  },
  ralnelhero: {
    windows: ["turnEnd"],
    usable: (state, id, context) =>
      ownTurnEnd(state, id, context) && state.seating.every((p) => state.players[p].passed),
    resolve: (state, id) => {
      const player = playerOf(state, id);
      player.passed = false;
      gainCommandTokens(state, id, 2);
      drawActionCards(state, id, 1);
      log(state, `${player.name} is no longer passed.`, { player: id });
    },
    bot: () => ({}),
  },
  "xxchahero-te": {
    action: true,
    targets: ["planets"],
    play: (state, id, targets) => {
      const planets = targets.planets ?? [];
      ensure(planets.length >= 1 && planets.length <= 4, "Choose up to 4 planets.");
      for (const name of planets) ensure(state.planets[name]?.controller === id, `You do not control ${name}.`);
    },
    resolve: (state, id, targets) => {
      for (const name of targets.planets ?? []) {
        const planet = planetOf(state, name);
        const type = unitsAvailable(state, id, "mech") > 0 ? "mech" : "pds";
        placeUnits(state, id, type, 1, { system: planet.system, planet: name });
        planet.exhausted = false;
      }
    },
    bot: (state, id) => ({
      planets: controlledPlanets(state, id)
        .sort((a, b) => planetResources(state, b.name) - planetResources(state, a.name))
        .slice(0, 4)
        .map((p) => p.name),
    }),
  },
  "naaluagent-te": {
    windows: ["afterActivate"],
    usable: (state, id, context) => context.player !== undefined && context.player !== id && context.system !== undefined,
    resolve: (state, _id, _targets, context) => {
      const system = systemOf(state, context.system!);
      system.commandTokens = system.commandTokens.filter((t) => t !== context.player);
      log(state, `Z'eu returned ${playerName(state, context.player!)}'s command token.`);
    },
  },
  crimsoncommander: {
    windows: ["combatEnd"],
    resolve: (state, id) => {
      const player = playerOf(state, id);
      if (player.commodities > 0) {
        player.commodities--;
        player.tradeGoods++;
      } else if (player.commodities < player.commodityLimit) {
        player.commodities++;
      }
    },
    bot: () => ({}),
  },
};

// --- Faction abilities, notes and technologies ---------------------------------------

const ABILITIES: Record<string, Effect> = {
  expedition: EXPEDITION,
  ...BREAKTHROUGHS,
  // Last Bastion: galvanize a unit that fought.
  phoenixstandard: {
    windows: ["combatEnd"],
    usable: (_state, id, context) => !!context.players?.includes(id),
    resolve: (state, id) => galvanizeOne(state, id),
    bot: () => ({}),
  },
  // Ral Nel: ships rush in from next door.
  survivalinstinct: {
    windows: ["afterActivate"],
    targets: ["transfers"],
    usable: (state, id, context) =>
      context.player !== id && context.system !== undefined && hasShips(systemOf(state, context.system).space[id]),
    play: (state, id, targets, context) => {
      const moves = targets.transfers ?? [];
      ensure(moves.reduce((sum, m) => sum + m.count, 0) <= 2, "Move up to 2 ships.");
      for (const move of moves) {
        const from = systemOf(state, move.from.system);
        ensure(adjacentSystems(state, context.system!).includes(from.key), "Move ships from adjacent systems.");
        ensure(!from.commandTokens.includes(id), "Not from systems with your command tokens.");
        ensure(isShip(move.unit) && countOf(from.space[id], move.unit) >= move.count, "You do not have those ships there.");
      }
    },
    resolve: (state, id, targets, context) => {
      const to = systemOf(state, context.system!);
      for (const move of targets.transfers ?? []) {
        removeUnits(systemOf(state, move.from.system).space, id, move.unit, move.count);
        addUnits(to.space, id, move.unit, move.count);
      }
    },
  },
  nanomachines: {
    action: true,
    targets: ["choice", "planet", "card"],
    usable: (state, id) => !state.players[id].exhaustedTechnologies.includes("nanomachines"),
    play: (state, id, targets) => {
      if (targets.choice === "pds") ownPlanet(state, id, targets);
      if (targets.choice === "cards") {
        const player = playerOf(state, id);
        ensure(player.actionCards.includes(targets.card ?? ""), "Discard 1 of your action cards.");
      }
      playerOf(state, id).exhaustedTechnologies.push("nanomachines");
    },
    resolve: (state, id, targets) => {
      const player = playerOf(state, id);
      if (targets.choice === "pds") {
        const planet = ownPlanet(state, id, targets);
        placeUnits(state, id, "pds", 1, { system: planet.system, planet: planet.name });
      } else if (targets.choice === "cards") {
        player.actionCards.splice(player.actionCards.indexOf(targets.card!), 1);
        state.decks.actionCards.discard.push(targets.card!);
        drawActionCards(state, id, 1);
      } else {
        for (const forces of [
          ...Object.values(state.systems).map((s) => s.space),
          ...Object.values(state.planets).map((p) => p.units),
        ]) {
          for (const stack of Object.values(forces[id] ?? {})) stack.damaged = 0;
        }
        log(state, `${player.name} repaired all of their units.`, { player: id });
      }
    },
  },
  "parasite-firm": {
    windows: ["statusStart"],
    targets: ["planet"],
    play: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      ensure(planet.system === state.players[id].home, "Choose a planet in your home system.");
    },
    resolve: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "infantry", 1, { system: planet.system, planet: planet.name });
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id).find((p) => p.system === state.players[id].home);
      return planet ? { planet: planet.name } : undefined;
    },
  },
};

/** Galvanizes 1 of a player's units in the active system, the strongest first. */
function galvanizeOne(state: GameState, id: PlayerId) {
  const tactical = state.tactical;
  const groups = tactical
    ? [systemOf(state, tactical.system).space[id], ...systemOf(state, tactical.system).planets.map((p) => state.planets[p].units[id])]
    : [];
  for (const type of ["warsun", "flagship", "dreadnought", "mech", "cruiser", "carrier", "destroyer", "infantry", "fighter"] as UnitType[]) {
    for (const group of groups) {
      if (galvanize(group, type) > 0) {
        log(state, `${playerName(state, id)} galvanized a ${UNIT_NAMES[type]}.`, { player: id });
        return;
      }
    }
  }
}

const NOTES: Record<string, Effect> = {
  raisethestandard: {
    windows: ["combatEnd"],
    usable: (_state, id, context) => !!context.players?.includes(id),
    resolve: (state, id) => galvanizeOne(state, id),
    bot: () => ({}),
  },
  sever: {
    action: true,
    targets: ["system"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(
        totalUnits(system.space[id]) > 0 || system.planets.some((p) => totalUnits(state.planets[p].units[id]) > 0),
        "Choose a system with your units.",
      );
    },
    resolve: (state, _id, targets) => {
      state.severed = [...(state.severed ?? []), targetSystem(state, targets).key];
    },
  },
  shareknowledge: {
    action: true,
    targets: ["technology"],
    play: (state, id, targets, context) => {
      const tech = technologiesById[targetTechnology(targets)];
      const owner = context.noteOwner!;
      ensure(
        tech && !tech.faction && !tech.unitUpgrade && state.players[owner].technologies.includes(tech.id) &&
          !state.players[id].technologies.includes(tech.id),
        "Choose a non-faction, non-unit upgrade technology the Deepwrought own and you do not.",
      );
    },
    resolve: (state, id, targets) => {
      playerOf(state, id).technologies.push(targets.technology!);
      (state.borrowedTechnologies ??= []).push({ player: id, technology: targets.technology! });
    },
  },
  nanolink: {
    windows: ["afterActivate"],
    targets: ["transfers"],
    usable: (_state, id, context) => context.player === id,
    play: (state, id, targets, context) => {
      for (const move of targets.transfers ?? []) {
        ensure(isStructure(move.unit), "Move structures.");
        const from = move.from.planet ? planetOf(state, move.from.planet).system : move.from.system;
        ensure(adjacentSystems(state, context.system!).includes(from), "Move them from adjacent systems.");
        ensure(!systemOf(state, from).commandTokens.includes(id), "Not from systems with your command tokens.");
        ensure(planetOf(state, move.to).system === context.system, "Place them in the active system.");
      }
    },
    resolve: (state, id, targets) => {
      for (const move of targets.transfers ?? []) {
        const origin = move.from.planet ? planetOf(state, move.from.planet).units : systemOf(state, move.from.system).space;
        removeUnits(origin, id, move.unit, move.count);
        addUnits(planetOf(state, move.to).units, id, move.unit, move.count);
      }
    },
  },
};

// --- Legendary planets ----------------------------------------------------------------

const LEGENDARY: Record<string, Effect> = {
  Faunus: {
    windows: ["turnEnd"],
    targets: ["planet"],
    usable: passingNow,
    play: (state, _id, targets) => {
      const planet = targetPlanet(state, targets);
      ensure(
        !isHomeSystem(state.systems[planet.system]) &&
          !isLegendary(state, planet.name) &&
          planet.attachments.length === 0 &&
          Object.values(planet.units).every((group) => totalUnits(group) === 0),
        "Choose a non-home, non-legendary planet with no units and no attachments.",
      );
    },
    resolve: (state, id, targets) => gainControl(state, id, targetPlanet(state, targets).name),
    bot: (state, id) => {
      const planet = Object.values(state.planets).find(
        (p) =>
          p.controller !== id &&
          !isHomeSystem(state.systems[p.system]) &&
          !isLegendary(state, p.name) &&
          p.attachments.length === 0 &&
          Object.values(p.units).every((group) => totalUnits(group) === 0),
      );
      return planet ? { planet: planet.name } : undefined;
    },
  },
  Garbozia: {
    windows: ["turnEnd"],
    targets: ["card"],
    usable: (state, id, context) => passingNow(state, id, context) && state.decks.actionCards.discard.length > 0,
    play: (state, _id, targets) => {
      ensure(state.decks.actionCards.discard.includes(targets.card ?? ""), "Choose a card from the discard pile.");
    },
    resolve: (state, id, targets) => {
      const discard = state.decks.actionCards.discard;
      discard.splice(discard.lastIndexOf(targets.card!), 1);
      playerOf(state, id).actionCards.push(targets.card!);
    },
    bot: (state) => ({ card: state.decks.actionCards.discard.at(-1) }),
  },
  Emelpar: {
    windows: ["turnEnd"],
    targets: ["planet", "technology"],
    usable: ownTurnEnd,
    resolve: (state, id, targets) => {
      if (targets.planet) {
        ownPlanet(state, id, targets).exhausted = false;
      } else if (targets.technology) {
        const player = playerOf(state, id);
        player.exhaustedTechnologies = player.exhaustedTechnologies.filter((t) => t !== targets.technology);
      }
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id)
        .filter((p) => p.exhausted && p.name !== "Emelpar")
        .sort((a, b) => planetResources(state, b.name) - planetResources(state, a.name))[0];
      return planet ? { planet: planet.name } : undefined;
    },
  },
  Tempesta: {
    windows: ["afterActivate"],
    usable: (_state, id, context) => context.player === id,
    resolve: (state, id) => setTacticalFlag(state, "tempesta", id),
  },
  Industrex: {
    windows: ["turnEnd"],
    targets: ["system", "unit"],
    usable: passingNow,
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(hasShips(system.space[id]), "Choose a system with your ships.");
      const unit = unitOf(state, id, targets.unit!);
      ensure(
        unit?.requiredTechId && isShip(targets.unit!) && unitsAvailable(state, id, targets.unit!) > 0,
        "Choose a ship type you have upgraded.",
      );
    },
    resolve: (state, id, targets) => placeUnits(state, id, targets.unit!, 1, { system: targetSystem(state, targets).key }),
    bot: (state, id) => {
      const unit = (["dreadnought", "cruiser", "carrier", "destroyer"] as UnitType[]).find(
        (t) => unitOf(state, id, t)?.requiredTechId && unitsAvailable(state, id, t) > 0,
      );
      const system = systemsWithShips(state, id)[0];
      return unit && system ? { unit, system: system.key } : undefined;
    },
  },
};

export const TE_EFFECTS: EffectArea = {
  actionCards: ACTION_CARDS,
  abilities: ABILITIES,
  notes: NOTES,
  leaders: LEADERS,
  relics: RELICS,
  planets: LEGENDARY,
};
