/**
 * Prophecy of Kings leaders: agents, commanders and heroes, by leader id.
 * Using an agent exhausts it and using a hero purges it unless the effect
 * keeps the card; commanders work for as long as they are unlocked.
 */
import { PlayerId } from "~/types";
import {
  actionCardsById,
  isGroundForce,
  isShip,
  isStructure,
  technologiesById,
  UNIT_NAMES,
  UnitType,
} from "../../data";
import { findPayment } from "../../agent/payment";
import { GameState, SystemKey, SystemState } from "../../types";
import {
  adjacentSystems,
  controlledPlanets,
  isGravityRift,
  isHomeSystem,
  MECATOL_REX,
  otherShipOwners,
  planetInfluence,
  planetOf,
  planetResources,
  planetTechSpecialties,
  planetTraits,
  systemOf,
  systemsWithShips,
  wormholesOf,
  WORMHOLE_NEXUS_ID,
} from "../board";
import { currentCombat, removeExcessShips, setCombatFlag } from "../combat";
import { checkElimination, explorePlanet, exploreFrontier } from "../control";
import { replenishCommodities } from "../economy";
import {
  addUnits,
  countOf,
  draw,
  drawActionCards,
  ensure,
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
import { leaderOf } from "../leaders";
import { gainCommandTokens, gainRelic } from "../relics";
import { askSecondaries } from "../strategic";
import { activateSystem, describeSystem } from "../tactical";
import { researchableTechnologies } from "../technology";
import { produceWithin, transferGroundForces } from "./general";
import {
  destroyUnits,
  markUsed,
  placeUnits,
  setTacticalFlag,
  targetPlanet,
  targetPlayer,
  targetSystem,
  targetTechnology,
} from "./helpers";
import type { EffectArea } from "./index";
import { takeNote } from "./pok";
import { Effect } from "./types";

const others = (state: GameState, id: PlayerId) =>
  state.seating.filter((other) => other !== id && !state.players[other].eliminated);

const ownTurnEnd = (state: GameState, id: PlayerId, context: { player?: PlayerId }) =>
  context.player === id && state.turnEnding === id;

const unitsIn = (state: GameState, id: PlayerId, system: SystemState) =>
  totalUnits(system.space[id]) +
  system.planets.reduce((sum, p) => sum + totalUnits(state.planets[p].units[id]), 0);

/** The participants of the combat in progress. */
const combatants = (state: GameState) => {
  const combat = currentCombat(state);
  return combat ? [combat.attacker, combat.defender] : [];
};

/** Replaces 1 of a player's infantry in a system with a mech, planets first. */
function infantryToMech(state: GameState, id: PlayerId, key: SystemKey) {
  const system = systemOf(state, key);
  const planet = system.planets.find((p) => countOf(state.planets[p].units[id], "infantry") > 0);
  const forces = planet ? state.planets[planet].units : system.space;
  if (countOf(forces[id], "infantry") === 0 || unitsAvailable(state, id, "mech") === 0) return;
  removeUnits(forces, id, "infantry", 1);
  addUnits(forces, id, "mech", 1);
  log(state, `${playerName(state, id)} replaced 1 infantry with a mech.`, { player: id });
}

const hasInfantryIn = (state: GameState, id: PlayerId, key: SystemKey) => {
  const system = systemOf(state, key);
  return (
    countOf(system.space[id], "infantry") > 0 ||
    system.planets.some((p) => countOf(state.planets[p].units[id], "infantry") > 0)
  );
};

const NON_FIGHTER_SHIPS: UnitType[] = ["destroyer", "cruiser", "carrier", "dreadnought", "flagship", "warsun"];

function capture(state: GameState, captor: PlayerId, owner: PlayerId, type: UnitType, count = 1) {
  const captured = (playerOf(state, captor).captured ??= []);
  const existing = captured.find((c) => c.owner === owner && c.type === type);
  if (existing) existing.count += count;
  else captured.push({ owner, type, count });
  log(state, `${playerName(state, captor)} captured ${count} ${UNIT_NAMES[type]} of ${playerName(state, owner)}.`, {
    player: captor,
  });
}

/** Cancels 1 hit waiting to be assigned. */
function cancelOneHit(state: GameState, ref: number | undefined) {
  const prompt = state.prompts.find((p) => p.id === ref);
  if (prompt?.kind !== "assignHits") return;
  prompt.hits--;
  log(state, `1 hit against ${playerName(state, prompt.player)} was cancelled.`);
  if (prompt.hits <= 0) state.prompts = state.prompts.filter((p) => p.id !== ref);
}

// --- Agents ---------------------------------------------------------------------

const AGENTS: Record<string, Effect> = {
  arborecagent: {
    action: true,
    targets: ["player", "system", "unit", "choice"],
    play: (state, id, targets) => {
      const owner = targetPlayer(state, id, targets, { other: false });
      const system = targetSystem(state, targets);
      const old = targets.unit;
      ensure(old && isShip(old) && old !== "fighter", "Choose a non-fighter ship.");
      ensure(countOf(system.space[owner], old) > 0, "They have no such ship there.");
      const replacement = targets.choice as UnitType;
      const oldCost = unitOf(state, owner, old)?.cost ?? 0;
      const newUnit = unitOf(state, owner, replacement);
      ensure(
        newUnit && isShip(replacement) && replacement !== "fighter" && (newUnit.cost ?? 99) <= oldCost + 2,
        "Choose a ship that costs up to 2 more.",
      );
      ensure(unitsAvailable(state, owner, replacement) > 0, "They have none of those in reinforcements.");
    },
    resolve: (state, id, targets) => {
      const owner = targetPlayer(state, id, targets, { other: false });
      const system = targetSystem(state, targets);
      removeUnits(system.space, owner, targets.unit!, 1);
      addUnits(system.space, owner, targets.choice as UnitType, 1);
      removeExcessShips(state, system.key, owner);
      log(state, `${playerName(state, owner)} replaced a ${UNIT_NAMES[targets.unit!]} with a ${UNIT_NAMES[targets.choice as UnitType]}.`);
    },
    bot: (state, id) => {
      for (const [from, to] of [["cruiser", "dreadnought"], ["destroyer", "carrier"], ["destroyer", "cruiser"]] as const) {
        if (unitsAvailable(state, id, to) === 0) continue;
        const system = Object.values(state.systems).find((s) => countOf(s.space[id], from) > 0);
        if (system) return { player: id, system: system.key, unit: from, choice: to };
      }
      return undefined;
    },
  },
  argentagent: {
    windows: ["productionStart"],
    resolve: (state, _id, _targets, context) => setTacticalFlag(state, "trilossa", context.player!),
  },
  cabalagent: {
    windows: ["afterReplenish"],
    targets: ["unit"],
    usable: (state, id, context) => context.player !== undefined && context.player !== id,
    play: (state, _id, targets, context) => {
      const victim = context.player!;
      const type = targets.unit;
      ensure(type && !isStructure(type), "Choose a unit.");
      ensure(
        (unitOf(state, victim, type)?.cost ?? 99) <= state.players[victim].commodities,
        "Choose a unit that costs no more than their commodities.",
      );
    },
    resolve: (state, id, targets, context) => {
      const victim = playerOf(state, context.player!);
      victim.tradeGoods += victim.commodities;
      victim.commodities = 0;
      if (targets.unit && unitsAvailable(state, victim.id, targets.unit) > 0) {
        capture(state, id, victim.id, targets.unit);
      }
    },
    bot: (state, _id, context) => {
      const victim = context.player!;
      const budget = state.players[victim].commodities;
      const unit = (["dreadnought", "carrier", "cruiser", "destroyer", "fighter"] as UnitType[]).find(
        (type) => (unitOf(state, victim, type)?.cost ?? 99) <= budget && unitsAvailable(state, victim, type) > 0,
      );
      return unit && budget >= 2 ? { unit } : undefined;
    },
  },
  ghostagent: {
    windows: ["afterActivate"],
    usable: (state, _id, context) =>
      context.system !== undefined &&
      wormholesOf(systemOf(state, context.system)).some((w) => w !== "DELTA"),
    resolve: (state, _id, _targets, context) => setTacticalFlag(state, "taivra", context.player!),
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  empyreanagent: {
    windows: ["afterMove"],
    usable: (state, _id, context) =>
      context.system !== undefined && systemOf(state, context.system).planets.length === 0,
    resolve: (state, _id, _targets, context) => {
      gainCommandTokens(state, context.player!, 1);
    },
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  hacanagent: {
    windows: ["turnEnd"],
    targets: ["choice", "player"],
    usable: (state, id, context) => ownTurnEnd(state, id, context),
    resolve: (state, id, targets) => {
      if (targets.choice === "replenish" && targets.player !== undefined) {
        replenishCommodities(state, targetPlayer(state, id, targets));
        return;
      }
      const player = playerOf(state, id);
      player.commodities = Math.min(player.commodityLimit, player.commodities + 2);
      log(state, `${player.name} gained 2 commodities.`, { player: id });
    },
    bot: (state, id) =>
      state.players[id].commodities + 2 <= state.players[id].commodityLimit ? { choice: "gain" } : undefined,
  },
  keleresagent: {
    windows: ["turnEnd"],
    targets: ["player"],
    usable: (state, id, context) => ownTurnEnd(state, id, context),
    resolve: (state, id, targets) => {
      const player = playerOf(state, targets.player ?? id);
      player.tradeGoods += player.commodities;
      log(state, `${player.name} may spend ${plural(player.commodities, "commodity")} as trade goods.`);
      player.commodities = 0;
    },
    bot: (state, id) => (state.players[id].commodities >= 2 ? { player: id } : undefined),
  },
  l1z1xagent: {
    windows: ["afterActivate"],
    usable: (state, _id, context) =>
      context.player !== undefined &&
      context.system !== undefined &&
      unitsAvailable(state, context.player, "mech") > 0 &&
      hasInfantryIn(state, context.player, context.system),
    resolve: (state, _id, _targets, context) => infantryToMech(state, context.player!, context.system!),
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  letnevagent: {
    windows: ["roundStart"],
    targets: ["player", "unit"],
    usable: (state) => !!state.tactical?.spaceCombat,
    play: (state, id, targets) => {
      const owner = targetPlayer(state, id, targets, { other: false });
      ensure(
        targets.unit && countOf(systemOf(state, state.tactical!.system).space[owner], targets.unit) > 0,
        "Choose a ship in the active system.",
      );
    },
    resolve: (state, id, targets) =>
      setCombatFlag(state.tactical!.spaceCombat!, `r.die@${targets.unit}`, targets.player ?? id),
    bot: (state, id) => {
      if (!combatants(state).includes(id)) return undefined;
      const space = systemOf(state, state.tactical!.system).space[id];
      const unit = (["warsun", "flagship", "dreadnought", "cruiser", "destroyer"] as UnitType[]).find(
        (type) => countOf(space, type) > 0,
      );
      return unit ? { player: id, unit } : undefined;
    },
  },
  mentakagent: {
    windows: ["afterPillage"],
    resolve: (state, id, _targets, context) => {
      drawActionCards(state, id, 1);
      if (context.player !== undefined) drawActionCards(state, context.player, 1);
    },
    bot: () => ({}),
  },
  muaatagent: {
    action: true,
    targets: ["system", "production", "payment"],
    usable: (state, id) => forgeSystems(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(forgeSystems(state, id).includes(targetSystem(state, targets).key), "Choose a system with your war sun or flagship.");
      for (const order of targets.production ?? []) {
        ensure((unitOf(state, id, order.type)?.cost ?? 99) <= 4, "Each unit must cost 4 or less.");
      }
    },
    resolve: (state, id, targets) =>
      produceWithin(state, id, targetSystem(state, targets).key, targets, { limit: 2 }),
    bot: (state, id) => {
      const [system] = forgeSystems(state, id);
      const payment = findPayment(state, id, 4, "resources");
      if (system === undefined || !payment || unitsAvailable(state, id, "cruiser") < 2) return undefined;
      return { system, production: [{ type: "cruiser", count: 2 }], payment };
    },
  },
  naaluagent: {
    action: true,
    targets: ["system"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(!isHomeSystem(system), "Choose a non-home system.");
    },
    resolve: (state, id, targets) => {
      // The tactical action is this action; it is counted when it finishes.
      state.actionsThisTurn--;
      activateSystem(state, id, targetSystem(state, targets).key, { free: true });
    },
  },
  naazagent: {
    windows: ["turnEnd"],
    targets: ["planet"],
    usable: (state, _id, context) =>
      context.player !== undefined && explorable(state, context.player).length > 0,
    play: (state, _id, targets, context) => {
      ensure(explorable(state, context.player!).includes(targetPlanet(state, targets).name), "Choose a planet they control.");
    },
    resolve: (state, _id, targets, context) =>
      explorePlanet(state, context.player!, targetPlanet(state, targets).name),
    bot: (state, id, context) => {
      if (context.player !== id) return undefined;
      const [planet] = explorable(state, id);
      return planet ? { planet } : undefined;
    },
  },
  nekroagent: {
    windows: ["turnEnd"],
    targets: ["choice", "card"],
    usable: (state, id, context) => ownTurnEnd(state, id, context),
    play: (state, id, targets) => {
      const player = playerOf(state, id);
      if (targets.choice === "token") {
        ensure(player.pools.tactic + player.pools.strategy + player.pools.fleet > 0, "You have no command tokens.");
        const pool = (["tactic", "strategy", "fleet"] as const).find((p) => player.pools[p] > 0)!;
        player.pools[pool]--;
      } else {
        const index = player.actionCards.indexOf(targets.card ?? "");
        ensure(index >= 0, "Choose an action card to discard.");
        player.actionCards.splice(index, 1);
        state.decks.actionCards.discard.push(targets.card!);
      }
    },
    resolve: (state, id) => {
      playerOf(state, id).tradeGoods += 2;
      log(state, `${playerName(state, id)} gained 2 trade goods.`, { player: id });
    },
    bot: (state, id) => {
      const hand = state.players[id].actionCards;
      return hand.length >= 5 ? { choice: "discard", card: hand[0] } : undefined;
    },
  },
  nomadagentartuno: {
    windows: ["afterGainTradeGoods"],
    usable: (_state, id, context) => context.player === id && (context.amount ?? 0) > 0,
    resolve: (state, id, _targets, context) => {
      const card = leaderOf(state, id, "nomadagentartuno");
      if (!card) return;
      card.tradeGoods = (card.tradeGoods ?? 0) + (context.amount ?? 0);
      log(state, `${playerName(state, id)} placed ${plural(context.amount ?? 0, "trade good")} on Artuno the Betrayer.`, {
        player: id,
      });
    },
    bot: (_state, _id, context) => ((context.amount ?? 0) >= 2 ? {} : undefined),
  },
  nomadagentmercer: {
    windows: ["turnEnd"],
    targets: ["transfers"],
    usable: (state, _id, context) => context.player !== undefined && state.lastActivated !== undefined,
    play: (state, _id, targets) => {
      for (const transfer of targets.transfers ?? []) {
        ensure(
          planetOf(state, transfer.to).system === state.lastActivated,
          "Place them on planets in the active system.",
        );
      }
    },
    resolve: (state, _id, targets, context) =>
      transferGroundForces(state, context.player!, targets, { limit: 2 }),
  },
  nomadagentthundarian: {
    windows: ["afterRolls"],
    usable: (state) => !!currentCombat(state)?.rolls,
    resolve: (state) => {
      const combat = currentCombat(state)!;
      combat.rolls = undefined;
      combat.stage = "roll";
      log(state, "The Thundarian: the combat round's dice are rolled again.");
    },
    bot: (state, id) => {
      const combat = currentCombat(state);
      if (!combat?.rolls || !combatants(state).includes(id)) return undefined;
      const hits = (player: PlayerId) =>
        combat.rolls!.filter((r) => r.player === player).reduce((sum, r) => sum + r.hits, 0);
      const opponent = combat.attacker === id ? combat.defender : combat.attacker;
      return hits(id) < hits(opponent) ? {} : undefined;
    },
  },
  sardakkagent: {
    windows: ["afterTacticalAction"],
    targets: ["planet"],
    usable: (state, _id, context) =>
      context.player !== undefined &&
      context.system !== undefined &&
      systemOf(state, context.system).planets.some((p) => state.planets[p]?.controller === context.player),
    play: (state, _id, targets, context) => {
      const planet = targetPlanet(state, targets);
      ensure(
        planet.system === context.system && planet.controller === context.player,
        "Choose a planet they control in the active system.",
      );
    },
    resolve: (state, _id, targets, context) => {
      const planet = targetPlanet(state, targets);
      placeUnits(state, context.player!, "infantry", 2, { system: planet.system, planet: planet.name });
    },
    bot: (state, id, context) => {
      if (context.player !== id) return undefined;
      const planet = systemOf(state, context.system!).planets.find((p) => state.planets[p]?.controller === id);
      return planet ? { planet } : undefined;
    },
  },
  saaragent: {
    windows: ["afterActivate"],
    resolve: (state, _id, _targets, context) => setTacticalFlag(state, "mendosa", context.player!),
  },
  solagent: {
    windows: ["roundStart"],
    targets: ["player", "unit"],
    usable: (state) => !!state.tactical?.groundCombat,
    play: (state, id, targets) => {
      const owner = targetPlayer(state, id, targets, { other: false });
      ensure(
        targets.unit &&
          isGroundForce(targets.unit) &&
          countOf(state.planets[state.tactical!.groundCombat!.planet].units[owner], targets.unit) > 0,
        "Choose a ground force in the combat.",
      );
    },
    resolve: (state, id, targets) =>
      setCombatFlag(state.tactical!.groundCombat!, `r.die@${targets.unit}`, targets.player ?? id),
    bot: (state, id) => {
      if (!combatants(state).includes(id)) return undefined;
      const units = state.planets[state.tactical!.groundCombat!.planet].units[id];
      const unit = countOf(units, "mech") > 0 ? "mech" : countOf(units, "infantry") > 0 ? "infantry" : undefined;
      return unit ? { player: id, unit } : undefined;
    },
  },
  titansagent: {
    windows: ["beforeHits"],
    usable: (state, _id, context) =>
      state.prompts.some((p) => p.id === context.ref && p.kind === "assignHits" && p.hits > 0),
    resolve: (state, _id, _targets, context) => cancelOneHit(state, context.ref),
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  winnuagent: {
    windows: ["productionStart"],
    resolve: (state, _id, _targets, context) => setTacticalFlag(state, "berekar", context.player!),
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  xxchaagent: {
    action: true,
    targets: ["planet", "choice"],
    play: (state, _id, targets) => {
      targetPlanet(state, targets);
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      planet.exhausted = false;
      log(state, `${planet.name} was readied.`);
      if (targets.choice !== "remove") return;
      const near = adjacentSystems(state, planet.system).some((key) =>
        systemOf(state, key).planets.some((p) => state.planets[p].controller === id),
      );
      const owner = Object.keys(planet.units)
        .map(Number)
        .find((o) => o !== id && countOf(planet.units[o], "infantry") > 0);
      if (near && owner !== undefined) {
        removeUnits(planet.units, owner, "infantry", 1);
        log(state, `${playerName(state, owner)}'s infantry on ${planet.name} was returned.`);
      }
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id)
        .filter((p) => p.exhausted)
        .sort((a, b) => planetResources(state, b.name) - planetResources(state, a.name))[0];
      return planet && planetResources(state, planet.name) >= 3 ? { planet: planet.name } : undefined;
    },
  },
  yinagent: {
    windows: ["unitDestroyedInCombat"],
    usable: (state, _id, context) => context.player !== undefined && context.unit !== undefined,
    resolve: (state, _id, _targets, context) => {
      const owner = context.player!;
      if (isShip(context.unit!)) {
        placeUnits(state, owner, "fighter", 2, { system: context.system! });
      } else if (context.planet) {
        placeUnits(state, owner, "infantry", 2, { system: context.system!, planet: context.planet });
      }
    },
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
};

const forgeSystems = (state: GameState, id: PlayerId) =>
  Object.values(state.systems)
    .filter((s) => countOf(s.space[id], "warsun") > 0 || countOf(s.space[id], "flagship") > 0)
    .map((s) => s.key);

const explorable = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id)
    .filter((p) => planetTraits(state, p.name).length > 0)
    .map((p) => p.name);

// --- Commanders -------------------------------------------------------------------

const COMMANDERS: Record<string, Effect> = {
  arboreccommander: {
    windows: ["afterActivate"],
    targets: ["production", "payment"],
    usable: (state, id, context) => {
      if (context.player === id || context.system === undefined) return false;
      const system = systemOf(state, context.system);
      const groups = [system.space[id], ...system.planets.map((p) => state.planets[p].units[id])];
      return groups.some((group) => unitTypes(group).some((type) => unitOf(state, id, type)?.production !== undefined || type === "spacedock"));
    },
    resolve: (state, id, targets, context) =>
      produceWithin(state, id, context.system!, targets, { limit: 1 }),
    bot: (state, id, context) => {
      const planet = systemOf(state, context.system!).planets.find((p) => state.planets[p].controller === id);
      const payment = findPayment(state, id, 1, "resources");
      return planet && payment ? { production: [{ type: "infantry", count: 1, planet }], payment } : undefined;
    },
  },
  empyreancommander: {
    windows: ["afterMove"],
    usable: (state, id, context) =>
      context.player !== id &&
      context.system !== undefined &&
      systemOf(state, context.system).commandTokens.includes(id),
    resolve: (state, id, _targets, context) => {
      const system = systemOf(state, context.system!);
      system.commandTokens = system.commandTokens.filter((t) => t !== id);
      log(state, `${playerName(state, id)} returned their command token from ${describeSystem(state, system.key)}.`, {
        player: id,
      });
    },
    bot: () => ({}),
  },
  mentakcommander: {
    windows: ["afterCombat"],
    usable: (state, _id, context) =>
      context.player !== undefined && state.players[context.player].promissoryNotes.length > 0,
    resolve: (state, id, _targets, context) => takeNote(state, context.player!, id),
    bot: () => ({}),
  },
  naazcommander: {
    windows: ["afterGainControl"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      !!context.planet &&
      state.planets[context.planet]?.controller === id &&
      planetTraits(state, context.planet).length > 0,
    resolve: (state, id, _targets, context) => explorePlanet(state, id, context.planet!),
    bot: () => ({}),
  },
  nekrocommander: {
    windows: ["afterResearch"],
    usable: (_state, id, context) => context.player === id,
    resolve: (state, id) => drawActionCards(state, id, 1),
    bot: () => ({}),
  },
  solcommander: {
    windows: ["groundCombatStart"],
    usable: (state, id) => {
      const ground = state.tactical?.groundCombat;
      return (
        !!ground &&
        ground.defender === id &&
        state.planets[ground.planet].controller === id &&
        unitsAvailable(state, id, "infantry") > 0
      );
    },
    resolve: (state, id) => {
      const planet = planetOf(state, state.tactical!.groundCombat!.planet);
      placeUnits(state, id, "infantry", 1, { system: planet.system, planet: planet.name });
    },
    bot: () => ({}),
  },
};

// --- Heroes ---------------------------------------------------------------------

/** Systems in or next to a dimensional tear. */
function nearTears(state: GameState, id: PlayerId) {
  const tears = Object.values(state.systems).filter(
    (s) => isGravityRift(state, s) && (countOf(s.space[id], "spacedock") > 0 || s.planets.some((p) => countOf(state.planets[p].units[id], "spacedock") > 0)),
  );
  return [...new Set(tears.flatMap((s) => [s.key, ...adjacentSystems(state, s.key)]))];
}

/** Systems whose positions Riftwalker Meian can swap. */
function swappable(state: GameState, id: PlayerId) {
  return Object.values(state.systems).filter(
    (s) =>
      s.onBoard &&
      s.systemId !== WORMHOLE_NEXUS_ID &&
      !(isHomeSystem(s) && state.players[s.homeOf!]?.faction === "creuss") &&
      (wormholesOf(s).length > 0 || unitsIn(state, id, s) > 0),
  );
}

/** Swaps the contents of two board positions, as if the tiles changed places. */
function swapSystems(state: GameState, a: SystemKey, b: SystemKey) {
  const first = state.systems[a];
  const second = state.systems[b];
  const tileA = state.map[a];
  const tileB = state.map[b];
  state.map[a] = { ...tileB, idx: tileA.idx, position: tileA.position } as typeof tileA;
  state.map[b] = { ...tileA, idx: tileB.idx, position: tileB.position } as typeof tileB;
  state.systems[a] = { ...second, key: a };
  state.systems[b] = { ...first, key: b };
  for (const name of state.systems[a].planets) state.planets[name].system = a;
  for (const name of state.systems[b].planets) state.planets[name].system = b;
  for (const id of state.seating) {
    const player = state.players[id];
    if (player.home === a) player.home = b;
    else if (player.home === b) player.home = a;
  }
}

/** Planets the Nekro hero can strip: a technology specialty, in a system with Nekro units. */
const flayeshTargets = (state: GameState, id: PlayerId) =>
  Object.values(state.planets).filter(
    (p) => planetTechSpecialties(state, p.name).length > 0 && unitsIn(state, id, state.systems[p.system]) > 0,
  );

const HEROES: Record<string, Effect> = {
  arborechero: {
    action: true,
    targets: ["system", "production", "payment"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(
        countOf(system.space[id], "infantry") + countOf(system.space[id], "mech") > 0 ||
          system.planets.some((p) => totalUnits(state.planets[p].units[id], isGroundForce) > 0),
        "Choose a system with your ground forces.",
      );
    },
    resolve: (state, id, targets) =>
      produceWithin(state, id, targetSystem(state, targets).key, targets, { limit: Infinity }),
  },
  argenthero: {
    action: true,
    targets: ["systems", "system"],
    play: (state, id, targets) => {
      const to = targetSystem(state, targets);
      ensure(
        to.commandTokens.includes(id) && otherShipOwners(to, id).length === 0,
        "Choose a system with your command token and no other players' ships.",
      );
    },
    resolve: (state, id, targets) => {
      const to = targetSystem(state, targets);
      let moved = 0;
      for (const from of targets.systems ?? []) {
        const origin = state.systems[from];
        if (!origin || from === to.key) continue;
        for (const type of unitTypes(origin.space[id])) {
          const stack = origin.space[id][type]!;
          addUnits(to.space, id, type, stack.count, stack.damaged);
          if (isShip(type)) moved += stack.count;
        }
        delete origin.space[id];
      }
      removeExcessShips(state, to.key, id);
      log(state, `${playerName(state, id)} moved ${plural(moved, "ship")} to ${describeSystem(state, to.key)}.`, { player: id });
    },
  },
  keleresheroodlynn: {
    windows: ["afterAgendaRevealed"],
    targets: ["outcome"],
    usable: (state) => !!state.agenda?.card,
    play: (state, _id, targets) => {
      ensure(targets.outcome !== undefined, "Predict an outcome.");
    },
    resolve: (state, id, targets) => {
      const agenda = state.agenda!;
      (agenda.predictions ??= []).push({ player: id, card: "Odlynn Myrr", outcome: targets.outcome! });
      agenda.votes.push({ player: id, outcome: targets.outcome!, votes: 6 });
      log(state, `${playerName(state, id)} cast 6 votes for ${targets.outcome}.`, { player: id });
    },
  },
  cabalhero: {
    action: true,
    usable: (state, id) => nearTears(state, id).length > 0,
    resolve: (state, id) => {
      for (const key of nearTears(state, id)) {
        const system = systemOf(state, key);
        for (const other of others(state, id)) {
          for (const type of NON_FIGHTER_SHIPS) {
            const count = countOf(system.space[other], type);
            let captured = 0;
            for (let i = 0; i < count; i++) if (rollDie(state) <= 3) captured++;
            if (captured === 0) continue;
            removeUnits(system.space, other, type, captured);
            capture(state, id, other, type, captured);
          }
          // Cargo with nothing left to carry it is captured too.
          const before = { fighter: countOf(system.space[other], "fighter"), infantry: countOf(system.space[other], "infantry"), mech: countOf(system.space[other], "mech") };
          removeExcessShips(state, key, other);
          for (const type of ["fighter", "infantry", "mech"] as UnitType[]) {
            const lost = before[type as keyof typeof before] - countOf(system.space[other], type);
            if (lost > 0) capture(state, id, other, type, lost);
          }
        }
      }
    },
    bot: (state, id) =>
      nearTears(state, id).some((key) => others(state, id).some((o) => hasShips(state.systems[key].space[o])))
        ? {}
        : undefined,
  },
  empyreanhero: {
    action: true,
    resolve: (state, id) => {
      for (const system of Object.values(state.systems)) {
        if (system.planets.length === 0 && !isHomeSystem(system)) system.frontier = true;
      }
      for (const system of systemsWithShips(state, id)) {
        if (system.frontier) exploreFrontier(state, id, system.key);
      }
    },
    bot: (state, id) =>
      systemsWithShips(state, id).filter((s) => s.planets.length === 0).length >= 2 ? {} : undefined,
  },
  ghosthero: {
    action: true,
    targets: ["systems"],
    play: (state, id, targets) => {
      const [a, b] = targets.systems ?? [];
      const allowed = swappable(state, id).map((s) => s.key);
      ensure(a !== undefined && b !== undefined && a !== b, "Choose 2 systems.");
      ensure(allowed.includes(a) && allowed.includes(b), "Choose systems with wormholes or your units.");
    },
    resolve: (state, _id, targets) => {
      const [a, b] = targets.systems!;
      swapSystems(state, a, b);
      log(state, `${describeSystem(state, a)} and ${describeSystem(state, b)} swapped places.`);
    },
  },
  hacanhero: {
    windows: ["productionStart"],
    usable: (_state, id, context) => context.player === id,
    resolve: (state, id) => setTacticalFlag(state, "gefhara", id),
    bot: (state, id, context) => {
      const system = context.system !== undefined ? state.systems[context.system] : undefined;
      if (!system) return undefined;
      const docks = system.planets.filter((p) => countOf(state.planets[p].units[id], "spacedock") > 0);
      return docks.some((p) => planetResources(state, p) >= 3) ? {} : undefined;
    },
  },
  jolnarhero: {
    action: true,
    targets: ["cards"],
    play: (state, id, targets) => {
      for (const pair of targets.cards ?? []) {
        const [from, to] = pair.split(">");
        const old = technologiesById[from];
        const replacement = technologiesById[to];
        ensure(old && state.players[id].technologies.includes(from) && !old.unitUpgrade, "Replace your own non-unit upgrade technologies.");
        ensure(
          replacement && replacement.color === old.color && researchableTechnologies(state, id).some((t) => t.id === to),
          "Replace each technology with another of the same color.",
        );
      }
    },
    resolve: (state, id, targets) => {
      const player = playerOf(state, id);
      for (const pair of targets.cards ?? []) {
        const [from, to] = pair.split(">");
        player.technologies = player.technologies.map((t) => (t === from ? to : t));
        player.exhaustedTechnologies = player.exhaustedTechnologies.filter((t) => t !== from);
      }
      log(state, `${player.name} replaced ${plural((targets.cards ?? []).length, "technology", )}.`, { player: id });
    },
  },
  keleresherokuuasi: {
    windows: ["roundStart"],
    targets: ["units"],
    usable: (state, id) =>
      !!state.tactical?.spaceCombat &&
      systemOf(state, state.tactical.system).planets.some((p) => state.planets[p].controller === id),
    play: (_state, _id, targets) => {
      const units = targets.units ?? {};
      ensure(
        Object.keys(units).every((t) => t === "cruiser" || t === "destroyer") &&
          (units.cruiser ?? 0) + (units.destroyer ?? 0) <= 2,
        "Choose up to 2 cruisers and destroyers.",
      );
    },
    resolve: (state, id, targets) => {
      const key = state.tactical!.system;
      placeUnits(state, id, "flagship", 1, { system: key });
      for (const [type, count] of Object.entries(targets.units ?? {}) as [UnitType, number][]) {
        placeUnits(state, id, type, count, { system: key });
      }
    },
    bot: () => ({ units: { cruiser: 2 } }),
  },
  keleresheroharka: {
    action: true,
    resolve: (state, id) => {
      const deck = state.decks.actionCards;
      const drawn: string[] = [];
      const passed: string[] = [];
      while (drawn.length < 3) {
        const card = draw(state, deck);
        if (!card) break;
        if (actionCardsById[card]?.componentAction) drawn.push(card);
        else passed.push(card);
      }
      deck.draw = shuffle(state, [...deck.draw, ...passed]);
      playerOf(state, id).actionCards.push(...drawn);
      log(state, `${playerName(state, id)} drew ${plural(drawn.length, "action card")}.`, { player: id });
    },
    bot: () => ({}),
  },
  l1z1xhero: {
    action: true,
    targets: ["system"],
    play: (state, id, targets) => {
      ensure(otherShipOwners(targetSystem(state, targets), id).length === 0, "Choose a system without other players' ships.");
    },
    resolve: (state, id, targets) => {
      const to = targetSystem(state, targets);
      for (const system of Object.values(state.systems)) {
        if (system.key === to.key) continue;
        for (const type of ["flagship", "dreadnought"] as UnitType[]) {
          const stack = system.space[id]?.[type];
          if (!stack) continue;
          addUnits(to.space, id, type, stack.count, stack.damaged);
          removeUnits(system.space, id, type, stack.count);
        }
        removeExcessShips(state, system.key, id);
      }
      removeExcessShips(state, to.key, id);
      log(state, `${playerName(state, id)} gathered their dreadnoughts in ${describeSystem(state, to.key)}.`, { player: id });
    },
  },
  letnevhero: {
    action: true,
    resolve: (state, id) => {
      markUsed(state, id, "darktalon");
      log(state, `${playerName(state, id)}'s fleets are not limited by their fleet pool this round.`, { player: id });
    },
  },
  mentakhero: {
    windows: ["combatStart"],
    usable: (state, id) => !!state.tactical?.spaceCombat && combatants(state).includes(id),
    resolve: (state, id) => setCombatFlag(state.tactical!.spaceCombat!, "ipswitch", id),
    bot: () => ({}),
  },
  muaathero: {
    windows: ["afterMove"],
    usable: (state, id, context) => {
      if (context.player !== id || context.system === undefined) return false;
      const system = systemOf(state, context.system);
      return (
        !isHomeSystem(system) &&
        !system.planets.includes(MECATOL_REX) &&
        countOf(system.space[id], "warsun") > 0
      );
    },
    resolve: (state, id, _targets, context) => {
      const system = systemOf(state, context.system!);
      const where = { system: system.key };
      for (const other of others(state, id)) {
        for (const type of unitTypes(system.space[other])) {
          destroyUnits(state, other, where, type, countOf(system.space[other], type), id);
        }
        for (const planet of system.planets) {
          for (const type of unitTypes(state.planets[planet].units[other])) {
            destroyUnits(state, other, { ...where, planet }, type, countOf(state.planets[planet].units[other], type), id);
          }
        }
      }
      const lost = system.planets.map((p) => state.planets[p].controller).filter((c) => c !== undefined);
      for (const planet of system.planets) delete state.planets[planet];
      system.planets = [];
      system.systemId = "80";
      const tile = state.map[system.key];
      if (tile?.type === "SYSTEM") state.map[system.key] = { ...tile, systemId: "80" };
      for (const owner of new Set(lost)) checkElimination(state, owner!);
      log(state, `${playerName(state, id)} turned ${describeSystem(state, system.key)} into a supernova.`, { player: id });
    },
    bot: (state, id, context) => {
      const system = systemOf(state, context.system!);
      const value = system.planets.reduce(
        (sum, p) => sum + (state.planets[p].controller !== id ? planetResources(state, p) + planetInfluence(state, p) : -10),
        0,
      );
      const enemies = others(state, id).some((o) => unitsIn(state, o, system) > 0);
      return value >= 0 && enemies ? {} : undefined;
    },
  },
  naaluhero: {
    windows: ["statusEnd"],
    resolve: (state, id) => {
      for (const other of others(state, id)) takeNote(state, other, id);
    },
    bot: () => ({}),
  },
  naazhero: {
    action: true,
    targets: ["cards"],
    play: (state, _id, targets) => {
      const cards = targets.cards ?? [];
      ensure(cards.length <= 2, "Choose up to 2 strategy cards.");
      const readied = state.strategyCards.filter(
        (card) =>
          !state.seating.some((p) =>
            state.players[p].strategyCards.some((held) => held.id === card && held.exhausted),
          ),
      );
      ensure(cards.every((c) => readied.includes(c)), "Choose readied or unchosen strategy cards.");
    },
    resolve: (state, id, targets) => {
      gainRelic(state, id);
      for (const card of targets.cards ?? []) askSecondaries(state, id, card, [id], [id]);
    },
    bot: (state) => ({ cards: state.strategyCards.slice(2, 4) }),
  },
  nekrohero: {
    action: true,
    targets: ["planet", "technology"],
    usable: (state, id) => flayeshTargets(state, id).length > 0,
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      ensure(flayeshTargets(state, id).some((p) => p.name === planet.name), "Choose a planet with a technology specialty where you have units.");
      const tech = technologiesById[targetTechnology(targets)];
      ensure(
        tech?.color !== undefined && planetTechSpecialties(state, planet.name).includes(tech.color),
        "Choose a technology of the planet's specialty.",
      );
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      for (const owner of Object.keys(planet.units).map(Number)) {
        if (owner === id) continue;
        for (const type of unitTypes(planet.units[owner])) {
          destroyUnits(state, owner, { system: planet.system, planet: planet.name }, type, countOf(planet.units[owner], type), id);
        }
      }
      const value = planetResources(state, planet.name) + planetInfluence(state, planet.name);
      const player = playerOf(state, id);
      player.tradeGoods += value;
      const tech = targetTechnology(targets);
      if (!player.technologies.includes(tech)) player.technologies.push(tech);
      log(state, `${player.name} gained ${plural(value, "trade good")} and ${technologiesById[tech].name}.`, { player: id });
    },
    bot: (state, id) => {
      for (const planet of flayeshTargets(state, id)) {
        const color = planetTechSpecialties(state, planet.name)[0];
        const tech = researchableTechnologies(state, id).find((t) => t.color === color);
        if (tech) return { planet: planet.name, technology: tech.id };
      }
      return undefined;
    },
  },
  nomadhero: {
    action: true,
    resolve: (state, id) => {
      markUsed(state, id, "siven");
      log(state, `${playerName(state, id)}'s flagship may leave systems with their command tokens this round.`, { player: id });
    },
  },
  saarhero: {
    action: true,
    targets: ["system"],
    usable: (state, id) => gurnoTargets(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(gurnoTargets(state, id).includes(targetSystem(state, targets).key), "Choose a system next to your space dock.");
    },
    resolve: (state, id, targets) => {
      const system = targetSystem(state, targets);
      for (const other of others(state, id)) {
        for (const type of ["infantry", "fighter"] as UnitType[]) {
          destroyUnits(state, other, { system: system.key }, type, countOf(system.space[other], type), id);
          for (const planet of system.planets) {
            destroyUnits(state, other, { system: system.key, planet }, type, countOf(state.planets[planet].units[other], type), id);
          }
        }
      }
    },
    bot: (state, id) => {
      const best = gurnoTargets(state, id)
        .map((key) => {
          const system = state.systems[key];
          const count = others(state, id).reduce(
            (sum, o) =>
              sum +
              countOf(system.space[o], "fighter") +
              countOf(system.space[o], "infantry") +
              system.planets.reduce((n, p) => n + countOf(state.planets[p].units[o], "infantry"), 0),
            0,
          );
          return { key, count };
        })
        .sort((a, b) => b.count - a.count)[0];
      return best && best.count >= 4 ? { system: best.key } : undefined;
    },
  },
  solhero: {
    action: true,
    resolve: (state, id) => {
      let returned = 0;
      for (const system of Object.values(state.systems)) {
        if (!system.commandTokens.includes(id)) continue;
        system.commandTokens = system.commandTokens.filter((t) => t !== id);
        returned++;
      }
      log(state, `${playerName(state, id)} returned ${plural(returned, "command token")} to their reinforcements.`, { player: id });
    },
    bot: (state, id) =>
      Object.values(state.systems).filter((s) => s.commandTokens.includes(id)).length >= 5 ? {} : undefined,
  },
  titanshero: {
    action: true,
    usable: (state, id) => state.planets.Elysium?.controller === id,
    resolve: (state) => {
      const elysium = state.planets.Elysium;
      elysium.exhausted = false;
      elysium.attachments.push("titanshero");
      log(state, "Ul the Progenitor awakened Elysium.");
    },
    bot: () => ({}),
  },
  yssarilhero: {
    action: true,
    resolve: (state, id) => {
      for (const other of others(state, id)) {
        const hand = state.players[other].actionCards;
        if (hand.length === 0) continue;
        const [card] = shuffle(state, hand);
        hand.splice(hand.indexOf(card), 1);
        playerOf(state, id).actionCards.push(card);
      }
      log(state, `${playerName(state, id)} took an action card from each other player.`, { player: id });
    },
    bot: (state, id) =>
      others(state, id).filter((o) => state.players[o].actionCards.length > 0).length >= 3 ? {} : undefined,
  },
};

/** Systems next to the Saar's space docks. */
function gurnoTargets(state: GameState, id: PlayerId): SystemKey[] {
  const docks = Object.values(state.systems).filter(
    (s) =>
      countOf(s.space[id], "spacedock") > 0 ||
      s.planets.some((p) => countOf(state.planets[p].units[id], "spacedock") > 0),
  );
  return [...new Set(docks.flatMap((s) => adjacentSystems(state, s.key)))];
}

export const LEADER_EFFECTS: EffectArea = {
  actionCards: {},
  abilities: {},
  notes: {},
  leaders: { ...AGENTS, ...COMMANDERS, ...HEROES },
};
