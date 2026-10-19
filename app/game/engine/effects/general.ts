/**
 * Action cards, abilities and promissory notes that act outside combat and
 * the agenda phase: component actions, movement, planets, the strategy and
 * status phases, and trade.
 */
import { PlayerId, Wormhole } from "~/types";
import {
  actionCardsById,
  isGroundForce,
  isShip,
  technologiesById,
  UNIT_NAMES,
} from "../../data";
import { EffectTargets, GameState, SystemKey } from "../../types";
import {
  adjacentSystems,
  areNeighbors,
  controlledPlanets,
  isHomeSystem,
  MECATOL_REX,
  otherShipOwners,
  planetOf,
  planetResources,
  planetTraits,
  systemOf,
  wormholesOf,
} from "../board";
import { enforceFleetSupply, removeExcessShips } from "../combat";
import { discardLaw } from "../agenda";
import { gainControl } from "../control";
import { pay, produce, productionCapacity, productionCost } from "../economy";
import { gainTradeGoodsFrom } from "../events";
import {
  addUnits,
  ask,
  countOf,
  drawActionCards,
  ensure,
  hasShips,
  hasTech,
  log,
  playerName,
  playerOf,
  plural,
  random,
  removeUnits,
  rollDie,
  sumCounts,
  tokensInReinforcements,
  totalUnits,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "../helpers";
import { undoLastPick, endTurnNow } from "../phases";
import { cancelPending, closeWindows, openWindow } from "../reactions";
import { unitIs } from "../units";
import { hasCommander } from "../leaders";
import { setPools } from "../strategic";
import { describeSystem } from "../tactical";
import { research } from "../technology";
import {
  canSpendStrategyToken,
  destroyUnits,
  exhaustTech,
  markUsed,
  ownPlanet,
  placeCommandToken,
  placeUnits,
  readyTech,
  setTacticalFlag,
  spendStrategyToken,
  targetPlanet,
  targetPlayer,
  targetSystem,
  targetTechnology,
} from "./helpers";
import type { EffectArea } from "./index";
import { Effect } from "./types";

const isSabotage = (card: string | undefined) =>
  card !== undefined && actionCardsById[card]?.name === "Sabotage";

const hasStrategyToken = (state: GameState, id: PlayerId) => canSpendStrategyToken(state, id);

const unitsIn = (state: GameState, id: PlayerId, key: SystemKey) => {
  const system = systemOf(state, key);
  return (
    totalUnits(system.space[id]) +
    system.planets.reduce((sum, p) => sum + totalUnits(state.planets[p].units[id]), 0)
  );
};

function requireReady(state: GameState, name: string) {
  ensure(!planetOf(state, name).exhausted, `${name} is already exhausted.`);
}

/** Players who own at least one planet in the home system of `owner`. */
const isNonHomePlanet = (state: GameState, name: string) =>
  !isHomeSystem(systemOf(state, planetOf(state, name).system));

// --- Creuss wormhole tokens -----------------------------------------------------

const CREUSS_TOKENS: Wormhole[] = ["ALPHA", "BETA"];

function placeCreussToken(state: GameState, id: PlayerId, targets: EffectTargets) {
  const wormhole = (targets.choice ?? "").toUpperCase() as Wormhole;
  ensure(CREUSS_TOKENS.includes(wormhole), 'Choose the "alpha" or "beta" wormhole token.');
  const system = targetSystem(state, targets);
  const ownsPlanet = system.planets.some((p) => state.planets[p].controller === id);
  ensure(
    ownsPlanet ||
      (!isHomeSystem(system) && otherShipOwners(system, id).length === 0),
    "Choose a system with a planet you control, or a non-home system without other players' ships.",
  );
  for (const other of Object.values(state.systems)) {
    other.addedWormholes = other.addedWormholes.filter((w) => w !== wormhole);
  }
  system.addedWormholes.push(wormhole);
  log(
    state,
    `${playerName(state, id)} placed the ${wormhole.toLowerCase()} wormhole token in ${describeSystem(state, system.key)}.`,
    { player: id },
  );
}

// --- Moving ground forces -------------------------------------------------------

/**
 * Moves ground forces to planets the player controls. `near` limits each
 * move to the same or an adjacent system (Bioplasmosis).
 */
export function transferGroundForces(
  state: GameState,
  id: PlayerId,
  targets: EffectTargets,
  options: { limit: number; near?: boolean; infantryOnly?: boolean; fromPlanets?: boolean },
) {
  const transfers = targets.transfers ?? [];
  const total = transfers.reduce((sum, t) => sum + t.count, 0);
  ensure(total <= options.limit, `Move at most ${options.limit} units.`);
  for (const transfer of transfers) {
    ensure(
      Number.isInteger(transfer.count) && transfer.count > 0,
      "Move a whole number of units.",
    );
    ensure(isGroundForce(transfer.unit), "Only ground forces can be moved this way.");
    ensure(
      !options.infantryOnly || transfer.unit === "infantry",
      "Only infantry can be moved this way.",
    );
    const destination = planetOf(state, transfer.to);
    ensure(destination.controller === id, `You do not control ${transfer.to}.`);
    const from = transfer.from;
    if (from.planet) {
      const origin = planetOf(state, from.planet);
      ensure(
        !options.fromPlanets || origin.controller === id,
        `You do not control ${from.planet}.`,
      );
    } else {
      ensure(!options.fromPlanets, "Move units from planets you control.");
    }
    const fromSystem = from.planet ? planetOf(state, from.planet).system : from.system;
    if (options.near) {
      ensure(
        fromSystem === destination.system ||
          adjacentSystems(state, fromSystem).includes(destination.system),
        `${transfer.to} is not in the same or an adjacent system.`,
      );
    }
    const forces = from.planet
      ? planetOf(state, from.planet).units
      : systemOf(state, fromSystem).space;
    removeUnits(forces, id, transfer.unit, transfer.count);
    addUnits(destination.units, id, transfer.unit, transfer.count);
  }
  if (total > 0) {
    log(state, `${playerName(state, id)} moved ${plural(total, "ground force")}.`, {
      player: id,
    });
  }
}

// --- Production outside the production step ---------------------------------------

export function produceWithin(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  targets: EffectTargets,
  options: { limit: number; maxCost?: number },
) {
  const orders = (targets.production ?? []).filter((o) => o.count > 0);
  if (orders.length === 0) return;
  if (options.maxCost !== undefined) {
    const cost = productionCost(state, id, orders);
    ensure(
      cost <= options.maxCost,
      `Those units cost ${cost}, more than the ${options.maxCost} allowed.`,
    );
  }
  produce(state, id, key, orders, targets.payment ?? { planets: [], tradeGoods: 0 }, {
    limit: options.limit,
  });
}

// --- Action cards -------------------------------------------------------------

const ACTION_CARDS: Record<string, Effect> = {
  Sabotage: {
    windows: ["actionCardPlayed"],
    usable: (state, _id, context) =>
      !isSabotage(context.card) &&
      !(context.player !== undefined && hasCommander(state, context.player, "bastioncommander")),
    resolve: (state, _id, _targets, context) => cancelPending(state, context.ref),
  },

  // Component actions
  "Cripple Defenses": {
    action: true,
    targets: ["planet"],
    play: (state, _id, targets) => {
      targetPlanet(state, targets);
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      for (const owner of Object.keys(planet.units).map(Number)) {
        destroyUnits(
          state,
          owner,
          { system: planet.system, planet: planet.name },
          "pds",
          countOf(planet.units[owner], "pds"),
          id,
        );
      }
    },
  },
  "Economic Initiative": {
    action: true,
    resolve: (state, id) => {
      for (const planet of controlledPlanets(state, id)) {
        if (planetTraits(state, planet.name).includes("CULTURAL")) planet.exhausted = false;
      }
    },
  },
  "Focused Research": {
    action: true,
    targets: ["technology", "planets"],
    usable: (state, id) =>
      state.players[id].tradeGoods >= 4 && state.players[id].faction !== "nekro",
    play: (state, id, targets) => {
      targetTechnology(targets);
      playerOf(state, id).tradeGoods -= 4;
    },
    resolve: (state, id, targets) =>
      research(state, id, {
        technology: targetTechnology(targets),
        skips: targets.planets,
      }),
  },
  "Frontline Deployment": {
    action: true,
    targets: ["planet"],
    play: (state, id, targets) => {
      ownPlanet(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "infantry", 3, { system: planet.system, planet: planet.name });
    },
  },
  "Ghost Ship": {
    action: true,
    targets: ["system"],
    usable: (state, id) => unitsAvailable(state, id, "destroyer") > 0,
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(!isHomeSystem(system), "Choose a non-home system.");
      ensure(wormholesOf(system).length > 0, "Choose a system with a wormhole.");
      ensure(
        otherShipOwners(system, id).length === 0,
        "That system contains other players' ships.",
      );
    },
    resolve: (state, id, targets) =>
      placeUnits(state, id, "destroyer", 1, { system: targetSystem(state, targets).key }),
  },
  "Industrial Initiative": {
    action: true,
    resolve: (state, id) => {
      const industrial = controlledPlanets(state, id).filter((p) =>
        planetTraits(state, p.name).includes("INDUSTRIAL"),
      ).length;
      gainTradeGoodsFrom(state, id, industrial, "Industrial Initiative");
    },
  },
  Insubordination: {
    action: true,
    targets: ["player"],
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const target = playerOf(state, targetPlayer(state, id, targets));
      if (target.pools.tactic > 0) target.pools.tactic--;
    },
  },
  "Lucky Shot": {
    action: true,
    targets: ["system", "player", "unit"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(
        system.planets.some((p) => state.planets[p].controller === id),
        "Choose a system that contains a planet you control.",
      );
      const victim = targetPlayer(state, id, targets);
      ensure(
        targets.unit === "dreadnought" ||
          targets.unit === "cruiser" ||
          targets.unit === "destroyer",
        "Choose a dreadnought, cruiser or destroyer.",
      );
      ensure(
        countOf(system.space[victim], targets.unit) > 0,
        `${playerName(state, victim)} has no ${UNIT_NAMES[targets.unit]} there.`,
      );
    },
    resolve: (state, id, targets) =>
      destroyUnits(state, targets.player!, { system: targets.system! }, targets.unit!, 1, id),
  },
  "Mining Initiative": {
    action: true,
    targets: ["planet"],
    play: (state, id, targets) => {
      ownPlanet(state, id, targets);
    },
    resolve: (state, id, targets) =>
      gainTradeGoodsFrom(
        state,
        id,
        planetResources(state, ownPlanet(state, id, targets).name),
        "Mining Initiative",
      ),
  },
  Plague: {
    action: true,
    targets: ["planet"],
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      ensure(
        planet.controller !== undefined && planet.controller !== id,
        "Choose a planet another player controls.",
      );
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      const owner = planet.controller!;
      const infantry = countOf(planet.units[owner], "infantry");
      const rolls = Array.from({ length: infantry }, () => rollDie(state));
      const hits = rolls.filter((r) => r >= 6).length;
      log(state, `Plague on ${planet.name}: rolled ${rolls.join(", ") || "nothing"}.`, {
        player: id,
      });
      destroyUnits(state, owner, { system: planet.system, planet: planet.name }, "infantry", hits, id);
    },
  },
  "Reactor Meltdown": {
    action: true,
    targets: ["planet", "system", "player"],
    play: (state, _id, targets) => {
      if (targets.planet) {
        const planet = targetPlanet(state, targets);
        ensure(isNonHomePlanet(state, planet.name), "Choose a planet outside home systems.");
        ensure(
          Object.values(planet.units).some((g) => countOf(g, "spacedock") > 0),
          "There is no space dock on that planet.",
        );
      } else {
        const system = targetSystem(state, targets);
        ensure(!isHomeSystem(system), "Choose a non-home system.");
        ensure(
          targets.player !== undefined && countOf(system.space[targets.player], "spacedock") > 0,
          "Choose a player with a space dock in that system.",
        );
      }
    },
    resolve: (state, id, targets) => {
      if (targets.planet) {
        const planet = targetPlanet(state, targets);
        const owner = Number(
          Object.keys(planet.units).find((o) => countOf(planet.units[Number(o)], "spacedock") > 0),
        );
        destroyUnits(state, owner, { system: planet.system, planet: planet.name }, "spacedock", 1, id);
      } else {
        destroyUnits(state, targets.player!, { system: targets.system! }, "spacedock", 1, id);
      }
    },
  },
  "Repeal Law": {
    action: true,
    targets: ["card"],
    usable: (state) => state.laws.length > 0,
    play: (state, _id, targets) => {
      ensure(
        state.laws.some((law) => law.id === targets.card),
        "Choose a law in play.",
      );
    },
    resolve: (state, _id, targets) => discardLaw(state, targets.card!),
  },
  "Rise of a Messiah": {
    action: true,
    resolve: (state, id) => {
      for (const planet of controlledPlanets(state, id)) {
        placeUnits(state, id, "infantry", 1, { system: planet.system, planet: planet.name });
      }
    },
  },
  "Signal Jamming": {
    action: true,
    targets: ["system", "player"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(!isHomeSystem(system), "Choose a non-home system.");
      const near = [system.key, ...adjacentSystems(state, system.key)];
      ensure(
        near.some((key) => hasShips(state.systems[key].space[id])),
        "Choose a system that contains or is next to 1 of your ships.",
      );
      targetPlayer(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const victim = targetPlayer(state, id, targets);
      if (placeCommandToken(state, victim, targets.system!)) {
        log(
          state,
          `${playerName(state, victim)} placed a command token in ${describeSystem(state, targets.system!)}.`,
        );
      }
    },
  },
  Spy: {
    action: true,
    targets: ["player"],
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
    },
    resolve: (state, id, targets) => {
      const victim = playerOf(state, targetPlayer(state, id, targets));
      if (victim.actionCards.length === 0) return;
      const [card] = victim.actionCards.splice(
        Math.floor(random(state) * victim.actionCards.length),
        1,
      );
      playerOf(state, id).actionCards.push(card);
      log(state, `${victim.name} gave ${playerName(state, id)} a random action card.`);
      drawActionCards(state, id, 0);
    },
  },
  "Tactical Bombardment": {
    action: true,
    targets: ["system"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(
        unitTypes(system.space[id]).some(
          (type) => unitOf(state, id, type)?.bombardment !== undefined,
        ),
        "Choose a system with 1 of your units that has BOMBARDMENT.",
      );
    },
    resolve: (state, id, targets) => {
      for (const name of targetSystem(state, targets).planets) {
        const planet = state.planets[name];
        if (planet.controller !== undefined && planet.controller !== id) planet.exhausted = true;
      }
    },
  },
  "Unexpected Action": {
    action: true,
    targets: ["system"],
    play: (state, id, targets) => {
      ensure(
        targetSystem(state, targets).commandTokens.includes(id),
        "You have no command token there.",
      );
    },
    resolve: (state, id, targets) => {
      const system = targetSystem(state, targets);
      system.commandTokens = system.commandTokens.filter((t) => t !== id);
    },
  },
  "Unstable Planet": {
    action: true,
    targets: ["planet"],
    play: (state, _id, targets) => {
      ensure(
        planetTraits(state, targetPlanet(state, targets).name).includes("HAZARDOUS"),
        "Choose a hazardous planet.",
      );
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      planet.exhausted = true;
      let remaining = 3;
      for (const owner of Object.keys(planet.units).map(Number)) {
        remaining -= destroyUnits(
          state,
          owner,
          { system: planet.system, planet: planet.name },
          "infantry",
          remaining,
          id,
        );
      }
    },
  },
  Uprising: {
    action: true,
    targets: ["planet"],
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      ensure(
        planet.controller !== undefined && planet.controller !== id,
        "Choose a planet another player controls.",
      );
      ensure(isNonHomePlanet(state, planet.name), "Choose a planet outside home systems.");
      requireReady(state, planet.name);
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      planet.exhausted = true;
      gainTradeGoodsFrom(state, id, planetResources(state, planet.name), "Uprising");
    },
  },
  "War Effort": {
    action: true,
    targets: ["system"],
    usable: (state, id) => unitsAvailable(state, id, "cruiser") > 0,
    play: (state, id, targets) => {
      ensure(
        hasShips(targetSystem(state, targets).space[id]),
        "Choose a system with 1 or more of your ships.",
      );
    },
    resolve: (state, id, targets) =>
      placeUnits(state, id, "cruiser", 1, { system: targetSystem(state, targets).key }),
  },

  // Strategy and status phases
  Summit: {
    windows: ["strategyStart"],
    targets: ["pools"],
    play: (_state, _id, targets) => {
      ensure(targets.pools, "Choose how to split your command tokens.");
    },
    resolve: (state, id, targets) => {
      const received = setPools(state, id, targets.pools!, 2);
      log(state, `${playerName(state, id)} gained ${plural(received, "command token")}.`, {
        player: id,
      });
    },
  },
  "Public Disgrace": {
    windows: ["afterPickStrategyCard"],
    usable: (state, id, context) =>
      state.lastPick !== undefined && context.player !== id,
    resolve: (state) => {
      const pick = state.lastPick;
      undoLastPick(state);
      if (pick) {
        log(state, `${playerName(state, pick.player)} must choose a different strategy card.`);
      }
    },
  },
  "Political Stability": {
    windows: ["returnStrategyCards"],
    usable: (state, id) => state.players[id].strategyCards.length > 0,
    resolve: (state, id) => {
      playerOf(state, id).keepsStrategyCards = true;
    },
  },

  // Tactical actions
  "Flank Speed": {
    windows: ["afterActivate"],
    usable: (state, id) => state.tactical?.player === id && state.tactical.step === "movement",
    resolve: (state, id) => setTacticalFlag(state, "flank", id),
  },
  "Lost Star Chart": {
    windows: ["afterActivate"],
    usable: (state, id) => state.tactical?.player === id && state.tactical.step === "movement",
    resolve: (state, id) => setTacticalFlag(state, "lostStar", id),
  },
  "In The Silence Of Space": {
    windows: ["afterActivate"],
    targets: ["system"],
    usable: (state, id) => state.tactical?.player === id && state.tactical.step === "movement",
    play: (state, _id, targets) => {
      targetSystem(state, targets);
    },
    resolve: (state, id, targets) => setTacticalFlag(state, `silence@${targets.system}`, id),
  },
  Upgrade: {
    windows: ["afterActivate"],
    usable: (state, id) =>
      state.tactical?.player === id &&
      countOf(systemOf(state, state.tactical.system).space[id], "cruiser") > 0 &&
      unitsAvailable(state, id, "dreadnought") > 0,
    resolve: (state, id) => {
      const key = state.tactical!.system;
      const space = systemOf(state, key).space;
      if (countOf(space[id], "cruiser") === 0) return;
      removeUnits(space, id, "cruiser", 1);
      addUnits(space, id, "dreadnought", 1);
      log(state, `${playerName(state, id)} upgraded a cruiser to a dreadnought.`, { player: id });
    },
  },
  "Experimental Battlestation": {
    windows: ["afterMove"],
    targets: ["planet", "system"],
    usable: (state, id, context) =>
      context.player !== id &&
      context.system !== undefined &&
      dockNear(state, id, context.system).length > 0,
    play: (state, id, targets, context) => {
      ensure(
        dockNear(state, id, context.system!).some(
          (dock) => dock.planet === targets.planet && dock.system === (targets.system ?? dock.system),
        ) || dockNear(state, id, context.system!).length === 1,
        "Choose 1 of your space docks in or next to the active system.",
      );
    },
    resolve: (state, id, _targets, context) => {
      const active = context.player!;
      const key = context.system!;
      if (!hasShips(systemOf(state, key).space[active])) return;
      const rolls = Array.from({ length: 3 }, () => rollDie(state));
      // Antimass Deflectors make it harder to hit.
      const modifier = state.players[active].technologies.includes("amd") ? -1 : 0;
      const hits = rolls.filter((r) => r + modifier >= 5).length;
      log(state, `Experimental Battlestation rolled ${rolls.join(", ")}: ${plural(hits, "hit")}.`, {
        player: id,
        rolls: [{ player: id, unit: "spacedock", target: 5, dice: rolls, hits }],
      });
      if (hits > 0) {
        ask(state, [
          {
            kind: "assignHits",
            player: active,
            hits,
            source: "spaceCannonOffense",
            system: key,
            from: id,
          },
        ]);
      }
    },
  },

  // Planets
  Infiltrate: {
    windows: ["afterGainControl"],
    usable: (state, id, context) =>
      context.planet !== undefined &&
      state.planets[context.planet]?.controller === id &&
      sumCounts(context.units) > 0,
    resolve: (state, id, _targets, context) => {
      const planet = planetOf(state, context.planet!);
      for (const type of ["pds", "spacedock"] as const) {
        const count = context.units?.[type] ?? 0;
        if (count > 0) placeUnits(state, id, type, count, { system: planet.system, planet: planet.name });
      }
    },
  },
  Reparations: {
    windows: ["afterGainControl"],
    targets: ["planet", "planets"],
    usable: (state, id, context) =>
      context.player === id &&
      context.planet !== undefined &&
      state.planets[context.planet]?.controller !== id,
    play: (state, id, targets, context) => {
      const gainer = state.planets[context.planet!].controller;
      if (targets.planet) {
        ensure(
          targetPlanet(state, targets).controller === gainer,
          `Choose a planet ${playerName(state, gainer!)} controls.`,
        );
      }
      for (const name of targets.planets ?? []) {
        ensure(planetOf(state, name).controller === id, `You do not control ${name}.`);
      }
      ensure((targets.planets ?? []).length <= 1, "Ready 1 planet.");
    },
    resolve: (state, _id, targets) => {
      if (targets.planet) planetOf(state, targets.planet).exhausted = true;
      for (const name of targets.planets ?? []) planetOf(state, name).exhausted = false;
    },
  },
};

/** Space docks of a player in or next to a system. */
function dockNear(state: GameState, id: PlayerId, key: SystemKey) {
  const docks: { system: SystemKey; planet?: string }[] = [];
  for (const near of [key, ...adjacentSystems(state, key)]) {
    const system = state.systems[near];
    if (countOf(system.space[id], "spacedock") > 0) docks.push({ system: near });
    for (const planet of system.planets) {
      if (countOf(state.planets[planet].units[id], "spacedock") > 0) {
        docks.push({ system: near, planet });
      }
    }
  }
  return docks;
}

// --- Abilities ----------------------------------------------------------------

const warSunSystems = (state: GameState, id: PlayerId) =>
  Object.values(state.systems).filter((s) => countOf(s.space[id], "warsun") > 0);

const flagshipSystem = (state: GameState, id: PlayerId) =>
  Object.values(state.systems).find((s) => countOf(s.space[id], "flagship") > 0);

const ABILITIES: Record<string, Effect> = {
  // Instinct Training (Xxcha)
  it: {
    windows: ["actionCardPlayed"],
    usable: (state, id) => readyTech(state, id, "it") && hasStrategyToken(state, id),
    play: (state, id) => {
      exhaustTech(state, id, "it");
      spendStrategyToken(state, id);
    },
    resolve: (state, _id, _targets, context) => cancelPending(state, context.ref),
  },

  // Muaat
  star_forge: {
    action: true,
    targets: ["system", "choice"],
    usable: (state, id) => hasStrategyToken(state, id) && warSunSystems(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(
        countOf(targetSystem(state, targets).space[id], "warsun") > 0,
        "Choose a system with 1 of your war suns.",
      );
      ensure(
        targets.choice === "fighters" || targets.choice === "destroyer",
        'Choose "fighters" or "destroyer".',
      );
      spendStrategyToken(state, id);
    },
    resolve: (state, id, targets) => {
      const key = targetSystem(state, targets).key;
      if (targets.choice === "destroyer") placeUnits(state, id, "destroyer", 1, { system: key });
      else placeUnits(state, id, "fighter", 2, { system: key });
      // Ember Colossus: an infantry with each mech in or next to the system.
      if (!unitIs(state, id, "mech", "muaat_mech")) return;
      for (const near of [key, ...adjacentSystems(state, key)]) {
        const system = state.systems[near];
        if (countOf(system.space[id], "mech") > 0) {
          placeUnits(state, id, "infantry", countOf(system.space[id], "mech"), { system: near });
        }
        for (const planet of system.planets) {
          const mechs = countOf(state.planets[planet].units[id], "mech");
          if (mechs > 0) placeUnits(state, id, "infantry", mechs, { system: near, planet });
        }
      }
    },
  },
  muaat_flagship: {
    action: true,
    usable: (state, id) =>
      hasStrategyToken(state, id) &&
      flagshipSystem(state, id) !== undefined &&
      unitsAvailable(state, id, "cruiser") > 0,
    play: (state, id) => spendStrategyToken(state, id),
    resolve: (state, id) => {
      const system = flagshipSystem(state, id);
      if (system) placeUnits(state, id, "cruiser", 1, { system: system.key });
    },
  },

  // Sol
  orbital_drop: {
    action: true,
    targets: ["planet", "choice", "payment"],
    usable: (state, id) => hasStrategyToken(state, id),
    play: (state, id, targets) => {
      ownPlanet(state, id, targets);
      spendStrategyToken(state, id);
      // ZS Thunderbolt M2: 3 resources for a mech as well.
      if (targets.choice === "mech") {
        ensure(unitIs(state, id, "mech", "sol_mech"), "You cannot deploy a mech this way.");
        pay(state, id, targets.payment, "resources", 3);
      }
    },
    resolve: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "infantry", 2, { system: planet.system, planet: planet.name });
      if (targets.choice === "mech") {
        placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
      }
    },
  },

  // Yssaril
  stall_tactics: {
    action: true,
    targets: ["card", "planet"],
    usable: (state, id) => state.players[id].actionCards.length > 0,
    play: (state, id, targets) => {
      const player = playerOf(state, id);
      const index = player.actionCards.indexOf(targets.card ?? "");
      ensure(index >= 0, "Choose an action card from your hand.");
      if (targets.planet) {
        ownPlanet(state, id, targets);
        ensure(unitIs(state, id, "mech", "yssaril_mech"), "You cannot deploy a mech this way.");
      }
      player.actionCards.splice(index, 1);
      state.decks.actionCards.discard.push(targets.card!);
      // Reverse Engineer
      openWindow(state, "afterActionCardDiscarded", { player: id, card: targets.card });
    },
    resolve: (state, id, targets) => {
      // Blackshade Infiltrator
      if (!targets.planet) return;
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
    },
  },

  // Arborec
  mitosis: {
    windows: ["statusStart"],
    targets: ["planet", "choice"],
    usable: (state, id) => controlledPlanets(state, id).length > 0,
    play: (state, id, targets) => {
      if (targets.choice !== "mech") {
        ownPlanet(state, id, targets);
        return;
      }
      // Letani Behemoth: replace 1 infantry with a mech instead.
      const planet = targetPlanet(state, targets);
      ensure(unitIs(state, id, "mech", "arborec_mech"), "You cannot deploy a mech this way.");
      ensure(countOf(planet.units[id], "infantry") > 0, `You have no infantry on ${planet.name}.`);
      ensure(unitsAvailable(state, id, "mech") > 0, "You have no mechs in your reinforcements.");
    },
    resolve: (state, id, targets) => {
      if (targets.choice === "mech") {
        const planet = targetPlanet(state, targets);
        removeUnits(planet.units, id, "infantry", 1);
        placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
        return;
      }
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "infantry", 1, { system: planet.system, planet: planet.name });
    },
  },
  arborec_flagship: {
    windows: ["afterActivate"],
    targets: ["production", "payment"],
    usable: (state, id) =>
      state.tactical?.player === id &&
      countOf(systemOf(state, state.tactical.system).space[id], "flagship") > 0,
    resolve: (state, id, targets) =>
      produceWithin(state, id, state.tactical!.system, targets, { limit: 5 }),
  },

  // Naalu
  foresight: {
    windows: ["afterMove"],
    targets: ["system"],
    usable: (state, id, context) =>
      context.player !== id &&
      context.system !== undefined &&
      hasStrategyToken(state, id) &&
      hasShips(systemOf(state, context.system).space[id]),
    play: (state, id, targets, context) => {
      const system = targetSystem(state, targets);
      ensure(
        adjacentSystems(state, context.system!).includes(system.key),
        "Choose a system next to the active system.",
      );
      ensure(
        otherShipOwners(system, id).length === 0,
        "That system contains other players' ships.",
      );
      spendStrategyToken(state, id);
    },
    resolve: (state, id, targets, context) => {
      const from = systemOf(state, context.system!);
      const to = targetSystem(state, targets);
      if (!to.commandTokens.includes(id)) to.commandTokens.push(id);
      for (const type of unitTypes(from.space[id])) {
        const stack = from.space[id][type]!;
        addUnits(to.space, id, type, stack.count, stack.damaged);
      }
      delete from.space[id];
      removeExcessShips(state, to.key, id);
      log(
        state,
        `Foresight: ${playerName(state, id)} withdrew to ${describeSystem(state, to.key)}.`,
        { player: id },
      );
    },
  },

  // Xxcha
  peace_accords: {
    windows: ["afterStrategicAction"],
    targets: ["planet"],
    usable: (state, id, context) =>
      context.player === id && context.card === "diplomacy" && peaceAccordsPlanets(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(
        peaceAccordsPlanets(state, id).includes(targetPlanet(state, targets).name),
        "Choose a planet with no units, other than Mecatol Rex, next to a planet you control.",
      );
    },
    resolve: (state, id, targets) => gainControl(state, id, targetPlanet(state, targets).name),
  },

  // Mentak
  pillage: {
    windows: ["afterGainTradeGoods"],
    targets: ["choice"],
    usable: (state, id, context) => {
      const victim = context.player;
      if (victim === undefined || victim === id) return false;
      const target = state.players[victim];
      return (
        target.tradeGoods >= 3 &&
        areNeighbors(state, id, victim) &&
        !target.promissoryNotesInPlay.some((n) => n.id === "pop" && n.owner === id)
      );
    },
    play: (_state, _id, targets) => {
      ensure(
        targets.choice === undefined ||
          targets.choice === "tradeGood" ||
          targets.choice === "commodity",
        'Choose "tradeGood" or "commodity".',
      );
    },
    resolve: (state, id, targets, context) => {
      const victim = playerOf(state, context.player!);
      const takeCommodity = targets.choice === "commodity" && victim.commodities > 0;
      if (takeCommodity) victim.commodities--;
      else if (victim.tradeGoods > 0) victim.tradeGoods--;
      else return;
      // A commodity taken this way becomes a trade good.
      playerOf(state, id).tradeGoods++;
      log(
        state,
        `Pillage: ${playerName(state, id)} took 1 ${takeCommodity ? "commodity" : "trade good"} from ${victim.name}.`,
        { player: id },
      );
      openWindow(state, "afterPillage", { player: context.player });
    },
  },

  // Technologies
  x89_base: {
    action: true,
    targets: ["planet"],
    usable: (state, id) => readyTech(state, id, "x89_base"),
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      const system = systemOf(state, planet.system);
      ensure(
        unitTypes(system.space[id]).some(
          (type) => isShip(type) && unitOf(state, id, type)?.bombardment !== undefined,
        ),
        "Choose a planet in a system with your ships that have BOMBARDMENT.",
      );
      exhaustTech(state, id, "x89_base");
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      for (const owner of Object.keys(planet.units).map(Number)) {
        destroyUnits(
          state,
          owner,
          { system: planet.system, planet: planet.name },
          "infantry",
          countOf(planet.units[owner], "infantry"),
          id,
        );
      }
    },
  },
  td: {
    windows: ["turnStart"],
    targets: ["transfers"],
    usable: (state, id, context) => context.player === id && readyTech(state, id, "td"),
    play: (state, id) => exhaustTech(state, id, "td"),
    resolve: (state, id, targets) =>
      transferGroundForces(state, id, targets, { limit: 4 }),
  },
  ie: {
    windows: ["afterGainControl"],
    targets: ["production", "payment"],
    usable: (state, id, context) =>
      context.planet !== undefined && state.planets[context.planet]?.controller === id,
    resolve: (state, id, targets, context) => {
      const planet = planetOf(state, context.planet!);
      for (const order of targets.production ?? []) {
        ensure(
          !order.planet || order.planet === planet.name,
          `Integrated Economy produces on ${planet.name}.`,
        );
      }
      produceWithin(state, id, planet.system, targets, {
        limit: Infinity,
        maxCost: planetResources(state, planet.name),
      });
    },
  },
  cm: {
    windows: ["turnStart"],
    targets: ["system", "production", "payment"],
    usable: (state, id, context) => context.player === id,
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(
        productionCapacity(state, system.key, id) > 0,
        "Choose a system with 1 of your units that has PRODUCTION.",
      );
      ensure(
        (targets.production ?? []).reduce((sum, o) => sum + o.count, 0) <= 1,
        "Chaos Mapping produces 1 unit.",
      );
    },
    resolve: (state, id, targets) =>
      produceWithin(state, id, targets.system!, targets, { limit: 1 }),
  },
  qdn: {
    windows: ["strategyEnd"],
    targets: ["player", "card", "choice"],
    usable: (state, id) =>
      hasStrategyToken(state, id) &&
      state.players[id].tradeGoods >= 3 &&
      state.players[id].strategyCards.length > 0,
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
      spendStrategyToken(state, id);
      playerOf(state, id).tradeGoods -= 3;
      other.tradeGoods += 3;
    },
    resolve: (state, id, targets) => {
      const me = playerOf(state, id);
      const other = playerOf(state, targets.player!);
      const mine = me.strategyCards.find((c) => c.id === targets.card)!;
      const theirs = other.strategyCards.find((c) => c.id === targets.choice)!;
      me.strategyCards = me.strategyCards.map((c) => (c === mine ? theirs : c));
      other.strategyCards = other.strategyCards.map((c) => (c === theirs ? mine : c));
      log(state, `${me.name} swapped strategy cards with ${other.name}.`, { player: id });
    },
  },
  scc: {
    windows: ["afterActivate"],
    usable: (state, id) =>
      state.tactical?.player === id &&
      state.tactical.step === "movement" &&
      readyTech(state, id, "scc") &&
      unitsIn(state, id, state.tactical.system) > 0,
    play: (state, id) => exhaustTech(state, id, "scc"),
    resolve: (state, id) => setTacticalFlag(state, "scc", id),
  },
  lgf: {
    action: true,
    usable: (state, id) =>
      readyTech(state, id, "lgf") && state.planets[MECATOL_REX]?.controller === id,
    play: (state, id) => exhaustTech(state, id, "lgf"),
    resolve: (state, id) =>
      placeUnits(state, id, "infantry", 1, {
        system: state.planets[MECATOL_REX].system,
        planet: MECATOL_REX,
      }),
  },
  mi: {
    action: true,
    targets: ["player", "card"],
    usable: (state, id) => readyTech(state, id, "mi"),
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
      exhaustTech(state, id, "mi");
    },
    resolve: (state, id, targets) => takeCard(state, id, targets.player!, targets.card),
  },
  bio: {
    windows: ["statusEnd"],
    targets: ["transfers"],
    usable: (state, id) => hasTech(state, id, "bio"),
    resolve: (state, id, targets) =>
      transferGroundForces(state, id, targets, {
        limit: Infinity,
        near: true,
        infantryOnly: true,
        fromPlanets: true,
      }),
  },
  pm: {
    action: true,
    targets: ["player"],
    usable: (state, id) => readyTech(state, id, "pm") && hasStrategyToken(state, id),
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
      exhaustTech(state, id, "pm");
      spendStrategyToken(state, id);
    },
    resolve: (state, id, targets) => {
      gainTradeGoodsFrom(state, id, 4, "Production Biomes");
      gainTradeGoodsFrom(state, targets.player!, 2, "Production Biomes");
    },
  },
  wg: {
    action: true,
    targets: ["system", "choice"],
    usable: (state, id) => readyTech(state, id, "wg"),
    play: (state, id, targets) => {
      exhaustTech(state, id, "wg");
      targetSystem(state, targets);
    },
    resolve: (state, id, targets) => placeCreussToken(state, id, targets),
  },
  nf: {
    windows: ["afterActivate"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.system !== undefined &&
      hasShips(systemOf(state, context.system).space[id]) &&
      readyTech(state, id, "nf") &&
      hasStrategyToken(state, id),
    play: (state, id) => {
      exhaustTech(state, id, "nf");
      spendStrategyToken(state, id);
    },
    resolve: (state, id, _targets, context) => {
      log(state, `Nullification Field: ${playerName(state, context.player!)}'s turn ends.`, {
        player: id,
      });
      closeWindows(state, ["afterActivate"]);
      state.tactical = undefined;
      endTurnNow(state, context.player!);
    },
  },
  htp: {
    windows: ["afterActivate"],
    targets: ["planet"],
    usable: (state, id) => state.tactical?.player === id && readyTech(state, id, "htp"),
    play: (state, id, targets) => {
      ownPlanet(state, id, targets);
      exhaustTech(state, id, "htp");
    },
    resolve: (state, id, targets) => setTacticalFlag(state, `htp@${targets.planet}`, id),
  },
  yso: {
    windows: ["afterProduce"],
    targets: ["planet", "system", "amount"],
    usable: (state, id, context) => context.player === id && hasTech(state, id, "yso"),
    play: (state, id, targets) => {
      if (targets.planet) ownPlanet(state, id, targets);
      else
        ensure(
          hasShips(targetSystem(state, targets).space[id]),
          "Choose a planet you control or a space area with your ships.",
        );
    },
    resolve: (state, id, targets) => {
      const count = Math.max(0, Math.min(2, targets.amount ?? 2));
      if (targets.planet) {
        const planet = ownPlanet(state, id, targets);
        placeUnits(state, id, "infantry", count, { system: planet.system, planet: planet.name });
      } else {
        placeUnits(state, id, "infantry", count, { system: targets.system! });
      }
    },
  },
};

function peaceAccordsPlanets(state: GameState, id: PlayerId): string[] {
  const mine = new Set(controlledPlanets(state, id).map((p) => p.system));
  return Object.values(state.planets)
    .filter(
      (p) =>
        p.name !== MECATOL_REX &&
        p.controller !== id &&
        Object.values(p.units).every((g) => totalUnits(g) === 0) &&
        state.systems[p.system]?.onBoard &&
        [p.system, ...adjacentSystems(state, p.system)].some((key) => mine.has(key)),
    )
    .map((p) => p.name);
}

/** Moves a card from another player's hand: the one named, or a random one. */
function takeCard(state: GameState, id: PlayerId, from: PlayerId, card?: string) {
  const victim = playerOf(state, from);
  if (victim.actionCards.length === 0) return;
  const index =
    card && victim.actionCards.includes(card)
      ? victim.actionCards.indexOf(card)
      : Math.floor(random(state) * victim.actionCards.length);
  const [taken] = victim.actionCards.splice(index, 1);
  playerOf(state, id).actionCards.push(taken);
  log(state, `${playerName(state, id)} took an action card from ${victim.name}.`, {
    player: id,
  });
  drawActionCards(state, id, 0);
}

// --- Promissory notes -----------------------------------------------------------

/** The note's owner is "the <color> player" in its text. */
const NOTES: Record<string, Effect> = {
  cf: {
    windows: ["afterActivate"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.system !== undefined &&
      unitsIn(state, id, context.system) > 0 &&
      context.noteOwner === context.player,
    resolve: (state, _id, _targets, context) =>
      setTacticalFlag(state, "ceasefire", context.player!),
  },
  ta: {
    windows: ["afterReplenish"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.noteOwner === context.player,
    resolve: (state, id, _targets, context) => {
      const owner = playerOf(state, context.player!);
      const amount = owner.commodities;
      owner.commodities = 0;
      gainTradeGoodsFrom(state, id, amount, `Trade Agreement with ${owner.name}`);
    },
  },
  fires: {
    action: true,
    resolve: (state, id, _targets, context) => {
      const owner = context.noteOwner;
      if (owner !== undefined && state.players[owner].pools.fleet > 0) {
        state.players[owner].pools.fleet--;
        enforceFleetSupply(state, owner);
      }
      const player = playerOf(state, id);
      if (!player.technologies.includes("ws")) {
        player.technologies.push("ws");
        log(state, `${player.name} gained ${technologiesById.ws.name}.`, { player: id });
      }
    },
  },
  convoys: { action: true, resolve: () => {} },
  pop: { action: true, resolve: () => {} },
  ms: {
    windows: ["turnStart"],
    targets: ["planet"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.noteOwner === context.player,
    play: (state, id, targets) => {
      if (targets.planet) ownPlanet(state, id, targets);
    },
    resolve: (state, id, targets, context) => {
      const sol = playerOf(state, context.player!);
      if (sol.pools.strategy > 0) sol.pools.strategy--;
      if (targets.planet) {
        const planet = ownPlanet(state, id, targets);
        placeUnits(state, id, "infantry", 2, { system: planet.system, planet: planet.name });
      }
    },
  },
  iff: {
    windows: ["turnStart"],
    targets: ["system", "choice"],
    usable: (_state, id, context) => context.player === id,
    play: (state, _id, targets) => {
      targetSystem(state, targets);
    },
    resolve: (state, id, targets) => placeCreussToken(state, id, targets),
  },
  ce: {
    windows: ["gainStatusTokens"],
    usable: (state, id) =>
      state.prompts.some((p) => p.kind === "redistribute" && p.player === id),
    resolve: (state, id) => {
      const prompt = state.prompts.find((p) => p.kind === "redistribute" && p.player === id);
      if (prompt?.kind === "redistribute") prompt.gained++;
    },
  },
  gift: {
    windows: ["strategyEnd"],
    usable: (state, id) => state.zeroToken === undefined && state.players[id].strategyCards.length > 0,
    resolve: (state, id) => {
      state.zeroToken = id;
      const naalu = state.seating.find((p) => state.players[p].faction === "naalu");
      if (naalu !== undefined) markUsed(state, naalu, "telepathic");
      log(state, `${playerName(state, id)} placed the Naalu "0" token on their strategy card.`, {
        player: id,
      });
    },
  },
  ra: {
    windows: ["afterResearch"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.card !== undefined &&
      !technologiesById[context.card]?.faction &&
      !state.players[id].technologies.includes(context.card) &&
      context.noteOwner === context.player,
    resolve: (state, id, _targets, context) => {
      const player = playerOf(state, id);
      if (player.technologies.includes(context.card!)) return;
      player.technologies.push(context.card!);
      log(state, `${player.name} gained ${technologiesById[context.card!].name}.`, {
        player: id,
      });
    },
  },
  acq: {
    windows: ["afterStrategicAction"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.noteOwner === context.player &&
      state.prompts.some((p) => p.kind === "secondary" && p.player === id),
    resolve: (state, id) => {
      for (const prompt of state.prompts) {
        if (prompt.kind === "secondary" && prompt.player === id) {
          prompt.free = true;
        }
      }
    },
  },
  spynet: {
    windows: ["turnStart"],
    targets: ["card"],
    usable: (_state, id, context) => context.player === id,
    resolve: (state, id, targets, context) => {
      if (context.noteOwner !== undefined) takeCard(state, id, context.noteOwner, targets.card);
    },
  },
  stymie: {
    windows: ["afterMove"],
    targets: ["system"],
    usable: (state, id, context) =>
      context.player !== undefined &&
      context.player !== id &&
      context.system !== undefined &&
      unitsIn(state, id, context.system) > 0 &&
      tokensInReinforcements(state, context.player) > 0,
    play: (state, _id, targets) => {
      ensure(!isHomeSystem(targetSystem(state, targets)), "Choose a non-home system.");
    },
    resolve: (state, _id, targets, context) => {
      if (placeCommandToken(state, context.player!, targets.system!)) {
        log(
          state,
          `${playerName(state, context.player!)} placed a command token in ${describeSystem(state, targets.system!)}.`,
        );
      }
    },
  },
};

export const GENERAL_EFFECTS: EffectArea = {
  actionCards: ACTION_CARDS,
  abilities: ABILITIES,
  notes: NOTES,
};
