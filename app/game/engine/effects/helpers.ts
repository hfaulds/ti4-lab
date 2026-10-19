/** Checks and steps shared by many cards and abilities. */
import { PlayerId } from "~/types";
import {
  factionSetupFor,
  isShip,
  isStructure,
  technologiesById,
  UNIT_NAMES,
  UnitType,
} from "../../data";
import { holdsUnit } from "../units";
import { EffectTargets, GameState, PlanetState, SystemState } from "../../types";
import { planetOf, systemOf } from "../board";
import { removeExcessCargo, removeExcessShips } from "../combat";
import { hasCommander } from "../leaders";
import {
  addUnits,
  countOf,
  ensure,
  hasTech,
  log,
  playerName,
  playerOf,
  plural,
  removeUnits,
  rollDie,
  tokensInReinforcements,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "../helpers";

export function targetPlayer(
  state: GameState,
  id: PlayerId,
  targets: EffectTargets,
  options: { other?: boolean } = {},
): PlayerId {
  const target = targets.player;
  ensure(target !== undefined, "Choose a player.");
  const player = state.players[target];
  ensure(player && !player.eliminated, "Choose a player in the game.");
  if (options.other ?? true) ensure(target !== id, "Choose another player.");
  return target;
}

export function targetPlanet(state: GameState, targets: EffectTargets): PlanetState {
  ensure(targets.planet, "Choose a planet.");
  return planetOf(state, targets.planet);
}

export function ownPlanet(
  state: GameState,
  id: PlayerId,
  targets: EffectTargets,
): PlanetState {
  const planet = targetPlanet(state, targets);
  ensure(planet.controller === id, `You do not control ${planet.name}.`);
  return planet;
}

export function targetSystem(state: GameState, targets: EffectTargets): SystemState {
  ensure(targets.system !== undefined, "Choose a system.");
  return systemOf(state, targets.system);
}

export function targetTechnology(targets: EffectTargets): string {
  ensure(
    targets.technology && technologiesById[targets.technology],
    "Choose a technology.",
  );
  return targets.technology;
}

/** The Scepter of Emelpar can stand in for a strategy token. */
const emelparReady = (state: GameState, id: PlayerId) => {
  const player = state.players[id];
  return (
    player.relics.includes("emelpar") &&
    !player.exhaustedRelics.includes("emelpar") &&
    tokensInReinforcements(state, id) > 0
  );
};

/** Whether a player could spend a token from their strategy pool. */
export const canSpendStrategyToken = (state: GameState, id: PlayerId) =>
  state.players[id].pools.strategy > 0 || emelparReady(state, id);

/**
 * Spends a token from the strategy pool, as many abilities ask. The Scepter
 * of Emelpar is used in its place while it is ready.
 */
export function spendStrategyToken(state: GameState, id: PlayerId) {
  const player = playerOf(state, id);
  if (emelparReady(state, id)) {
    player.exhaustedRelics.push("emelpar");
    log(state, `${player.name} spent a token from their reinforcements with the Scepter of Emelpar.`, {
      player: id,
    });
    return;
  }
  ensure(player.pools.strategy > 0, "Your strategy pool is empty.");
  player.pools.strategy--;
  // Magmus
  if (hasCommander(state, id, "muaatcommander")) {
    player.tradeGoods++;
    log(state, `Magmus: ${player.name} gained 1 trade good.`, { player: id });
  }
}

export const isExhausted = (state: GameState, id: PlayerId, tech: string) =>
  state.players[id].exhaustedTechnologies.includes(tech);

export const readyTech = (state: GameState, id: PlayerId, tech: string) =>
  hasTech(state, id, tech) && !isExhausted(state, id, tech);

export function exhaustTech(state: GameState, id: PlayerId, tech: string) {
  ensure(readyTech(state, id, tech), `${technologiesById[tech]?.name ?? tech} is exhausted.`);
  state.players[id].exhaustedTechnologies.push(tech);
}

/** Places units from reinforcements, up to what is left there. */
export function placeUnits(
  state: GameState,
  id: PlayerId,
  type: UnitType,
  count: number,
  where: { system: number; planet?: string },
): number {
  const placed = Math.min(count, unitsAvailable(state, id, type));
  if (placed <= 0) return 0;
  const forces = where.planet
    ? planetOf(state, where.planet).units
    : systemOf(state, where.system).space;
  addUnits(forces, id, type, placed);
  // Ships placed beyond the fleet pool, or cargo beyond capacity, are removed.
  if (!where.planet) removeExcessShips(state, where.system, id);
  log(
    state,
    `${playerName(state, id)} placed ${placed} ${UNIT_NAMES[type]} ${where.planet ? `on ${where.planet}` : "in space"}.`,
    { player: id },
  );
  return placed;
}

/**
 * Places a player's command token in a system from their reinforcements,
 * if they have one left. Returns whether it was placed.
 */
export function placeCommandToken(state: GameState, id: PlayerId, key: number) {
  const system = systemOf(state, key);
  if (system.commandTokens.includes(id)) return false;
  if (tokensInReinforcements(state, id) <= 0) return false;
  system.commandTokens.push(id);
  return true;
}

export function gainTradeGoods(state: GameState, id: PlayerId, amount: number) {
  if (amount <= 0) return;
  playerOf(state, id).tradeGoods += amount;
  log(state, `${playerName(state, id)} gained ${plural(amount, "trade good")}.`, {
    player: id,
  });
}

/**
 * Destroys a player's units in one place, with the abilities that trigger
 * when units are destroyed: Infantry II coming back, Destroy Their Greatest
 * Ship, and the Yin flagship. `by` is the player responsible, if any.
 * Returns the number destroyed.
 */
export function destroyUnits(
  state: GameState,
  owner: PlayerId,
  where: { system: number; planet?: string },
  type: UnitType,
  count: number,
  by?: PlayerId,
): number {
  const forces = where.planet
    ? planetOf(state, where.planet).units
    : systemOf(state, where.system).space;
  const destroyed = Math.min(count, countOf(forces[owner], type));
  if (destroyed <= 0) return 0;
  removeUnits(forces, owner, type, destroyed);
  // Outside a space combat there, cargo without a ship to carry it is lost.
  const fighting =
    state.tactical?.system === where.system && state.tactical.spaceCombat !== undefined;
  if (!where.planet && isShip(type) && !fighting) {
    removeExcessCargo(state, where.system, owner);
  }

  const unit = unitOf(state, owner, type);
  if (type === "infantry" && unit?.ability?.startsWith("After this unit is destroyed")) {
    const needed = unit.id === "sol_infantry2" ? 5 : 6;
    const rolls = Array.from({ length: destroyed }, () => rollDie(state));
    const saved = rolls.filter((roll) => roll >= needed).length;
    if (saved > 0) {
      const player = playerOf(state, owner);
      player.revivingInfantry = (player.revivingInfantry ?? 0) + saved;
      log(
        state,
        `${player.name}'s ${unit.name} rolled ${rolls.join(", ")}: ${plural(saved, "unit")} will return.`,
        { player: owner },
      );
    }
  }
  if (by !== undefined && by !== owner && (type === "warsun" || type === "flagship")) {
    achieve(state, by, "dtgs");
  }
  captureDestroyed(state, owner, where, type, destroyed, by);
  // Ipswitch, Loose Cannon
  const ipswitch = state.tactical?.spaceCombat?.flags
    ?.filter((flag) => flag.startsWith("ipswitch:"))
    .map((flag) => Number(flag.split(":")[1]))
    .find((mentak) => mentak !== owner);
  if (ipswitch !== undefined && isShip(type) && !where.planet) {
    placeUnits(state, ipswitch, type, destroyed, { system: where.system });
  }
  if (type === "infantry" && unit?.id.startsWith("mahact_infantry")) {
    // Crimson Legionnaire: a commodity, or one converted, per unit lost.
    const player = playerOf(state, owner);
    for (let i = 0; i < destroyed; i++) {
      if (player.commodities > 0) {
        player.commodities--;
        player.tradeGoods++;
      } else if (player.commodities < player.commodityLimit) {
        player.commodities++;
      }
    }
    if (unit.id === "mahact_infantry2") {
      player.revivingLegionnaires = (player.revivingLegionnaires ?? 0) + destroyed;
    }
  }
  // Self-Assembly Routines
  if (type === "mech" && hasTech(state, owner, "sar")) {
    playerOf(state, owner).tradeGoods += destroyed;
    log(state, `Self-Assembly Routines: ${playerName(state, owner)} gained ${plural(destroyed, "trade good")}.`, {
      player: owner,
    });
  }
  if (type === "flagship" && unit?.id === "yin_flagship" && !where.planet) {
    // Van Hauge takes every ship in the system with it.
    const system = systemOf(state, where.system);
    for (const other of Object.keys(system.space).map(Number)) {
      for (const shipType of unitTypes(system.space[other]).filter(isShip)) {
        destroyUnits(state, other, where, shipType, countOf(system.space[other], shipType), owner);
      }
    }
    log(state, `Van Hauge destroyed every ship in the system.`, { player: owner });
  }
  return destroyed;
}

/**
 * Vuil'raith captures: Devour takes what they destroy in combat, The Terror
 * Between takes everything destroyed in its system, and Reanimator keeps
 * their own infantry.
 */
function captureDestroyed(
  state: GameState,
  owner: PlayerId,
  where: { system: number; planet?: string },
  type: UnitType,
  count: number,
  by?: PlayerId,
) {
  if (isStructure(type)) return;
  const inCombat = !!(state.tactical?.spaceCombat || state.tactical?.groundCombat);
  const system = systemOf(state, where.system);
  const captor = state.seating.find((id) => {
    if (state.players[id].faction !== "vulraith") return false;
    if (id !== owner && id === by && inCombat && ownsAbilityId(state, id, "devour")) return true;
    if (holdsUnit(state, id, system.space[id], "flagship", "cabal_flagship") && !(id === owner && type === "flagship")) {
      return true;
    }
    return (
      id === owner &&
      type === "infantry" &&
      where.planet !== undefined &&
      holdsUnit(state, id, state.planets[where.planet]?.units[id], "mech", "cabal_mech")
    );
  });
  if (captor === undefined) return;
  const player = playerOf(state, captor);
  const captured = (player.captured ??= []);
  const existing = captured.find((c) => c.owner === owner && c.type === type);
  if (existing) existing.count += count;
  else captured.push({ owner, type, count });
  log(state, `${player.name} captured ${count} ${UNIT_NAMES[type]}.`, { player: captor });
}

const ownsAbilityId = (state: GameState, id: PlayerId, ability: string) =>
  !!factionSetupFor(state.players[id].faction, state.players[id].factionVariant)?.abilities.includes(
    ability,
  );

/** Records an event that an action-phase secret objective asks for. */
export function achieve(state: GameState, id: PlayerId, objective: string) {
  const player = playerOf(state, id);
  player.achievements ??= [];
  if (!player.achievements.includes(objective)) player.achievements.push(objective);
}

/** Marks a limited ability as used ("once per combat" and the like). */
export function markUsed(state: GameState, id: PlayerId, key: string) {
  const player = playerOf(state, id);
  (player.used ??= []).push(key);
}

export const wasUsed = (state: GameState, id: PlayerId, key: string) =>
  !!state.players[id].used?.includes(key);

/** Flags set on the tactical action ("flank:3"). */
export const tacticalFlag = (state: GameState, flag: string, id: PlayerId) =>
  !!state.tactical?.flags?.includes(`${flag}:${id}`);

export function setTacticalFlag(state: GameState, flag: string, id: PlayerId) {
  const tactical = state.tactical;
  ensure(tactical, "No tactical action is in progress.");
  (tactical.flags ??= []).push(`${flag}:${id}`);
}
