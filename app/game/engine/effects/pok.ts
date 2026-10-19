/**
 * Prophecy of Kings action cards, faction abilities, technologies, units and
 * promissory notes.
 */
import { PlayerId } from "~/types";
import {
  actionCardsById,
  agendasById,
  ExplorationDeck,
  explorationsById,
  isShip,
  isStructure,
  technologiesById,
  UNIT_NAMES,
  unitsById,
  UnitType,
} from "../../data";
import { findPayment } from "../../agent/payment";
import { GameState, SystemKey } from "../../types";
import { agendaOutcomes, canVote, playerByName } from "../agenda";
import {
  adjacentSystems,
  anomaliesOf,
  areNeighbors,
  controlledPlanets,
  isHomeSystem,
  MECATOL_REX,
  planetInfluence,
  planetOf,
  planetResources,
  planetTechSpecialties,
  planetTraits,
  systemOf,
  systemsWithShips,
} from "../board";
import { combatFlag, currentCombat, enforceFleetSupply, removeExcessCargo, setCombatFlag } from "../combat";
import { explorePlanet, exploreFrontier, resolveExploration } from "../control";
import { pay, produce } from "../economy";
import {
  addUnits,
  ask,
  countOf,
  draw,
  ensure,
  log,
  playerName,
  playerOf,
  plural,
  removeUnits,
  shuffle,
  tokensInReinforcements,
  totalUnits,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "../helpers";
import { availableStrategyCards, endTurnNow } from "../phases";
import { cancelPending } from "../reactions";
import { checkFragments, fragmentSet, gainCommandTokens, gainRelic, poolChoice, purgeFragments } from "../relics";
import { describeSystem } from "../tactical";
import { missingPrerequisites, research, researchableTechnologies } from "../technology";
import { receiveNote } from "../transactions";
import { holdsUnit, unitIs } from "../units";
import { readyLeader } from "../leaders";
import { KELERES_RIDERS } from "./agenda";
import { transferGroundForces } from "./general";
import {
  exhaustTech,
  ownPlanet,
  placeCommandToken,
  placeUnits,
  readyTech,
  setTacticalFlag,
  targetPlanet,
  targetPlayer,
  targetSystem,
  targetTechnology,
} from "./helpers";
import type { EffectArea } from "./index";
import { Effect } from "./types";

const NO_PAYMENT = { planets: [], tradeGoods: 0 };

const others = (state: GameState, id: PlayerId) =>
  state.seating.filter((other) => other !== id && !state.players[other].eliminated);

/** Whether a player has units in a system, in space or on its planets. */
const hasUnitsIn = (state: GameState, id: PlayerId, key: SystemKey) => {
  const system = systemOf(state, key);
  return (
    totalUnits(system.space[id]) > 0 ||
    system.planets.some((p) => totalUnits(state.planets[p].units[id]) > 0)
  );
};

const activeSystem = (state: GameState) =>
  state.tactical ? systemOf(state, state.tactical.system) : undefined;

/** Hands a random promissory note from one player to another, if they have one. */
export function takeNote(state: GameState, from: PlayerId, to: PlayerId) {
  const giver = playerOf(state, from);
  const eligible = giver.promissoryNotes.filter(
    // Hubris: nobody gives the Mahact their Alliance.
    (note) => !(note.id === "an" && state.players[to].faction === "mahact"),
  );
  if (eligible.length === 0) return;
  const [note] = shuffle(state, eligible);
  giver.promissoryNotes = giver.promissoryNotes.filter((n) => n !== note);
  receiveNote(state, to, note);
  log(state, `${giver.name} gave a promissory note to ${playerName(state, to)}.`);
}

// --- Action cards ---------------------------------------------------------------

const ACTION_CARDS: Record<string, Effect> = {
  "Archaeological Expedition": {
    action: true,
    targets: ["choice"],
    play: (state, id, targets) => {
      const deck = targets.choice as ExplorationDeck;
      ensure(
        controlledPlanets(state, id).some((p) =>
          planetTraits(state, p.name).some((t) => t.toLowerCase() === deck),
        ),
        "Choose the exploration deck of a planet trait you control.",
      );
    },
    resolve: (state, id, targets) => {
      const deck = targets.choice as ExplorationDeck;
      const player = playerOf(state, id);
      let fragments = 0;
      for (let i = 0; i < 3; i++) {
        const card = draw(state, state.decks[deck]);
        if (!card) break;
        if (explorationsById[card]?.resolution === "fragment") {
          player.relicFragments.push(card);
          fragments++;
        } else {
          state.decks[deck].discard.push(card);
        }
      }
      log(state, `${player.name} found ${plural(fragments, "relic fragment")}.`, { player: id });
    },
    bot: (state, id) => {
      const counts = new Map<string, number>();
      for (const planet of controlledPlanets(state, id)) {
        for (const trait of planetTraits(state, planet.name)) {
          counts.set(trait.toLowerCase(), (counts.get(trait.toLowerCase()) ?? 0) + 1);
        }
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best ? { choice: best[0] } : undefined;
    },
  },
  "Confounding Legal Text": {
    windows: ["whenElected"],
    usable: (state, id) => {
      const elected = playerByName(state, state.agenda?.result);
      return elected !== undefined && elected !== id;
    },
    resolve: (state, id) => {
      state.agenda!.result = state.players[id].name;
      log(state, `${playerName(state, id)} is elected instead.`);
    },
    bot: () => ({}),
  },
  "Coup d'Etat": {
    windows: ["beforeStrategicAction"],
    usable: (state, id, context) =>
      context.player !== undefined && context.player !== id && !!state.queuedStrategic,
    resolve: (state, _id, _targets, context) => {
      state.queuedStrategic = undefined;
      log(state, `${playerName(state, context.player!)}'s turn ends.`);
      endTurnNow(state, context.player!);
    },
  },
  "Deadly Plot": {
    windows: ["whenOutcomeResolved"],
    usable: (state, id) => {
      const agenda = state.agenda;
      if (!agenda?.card || agenda.result === undefined) return false;
      return (
        agenda.votes.some((v) => v.player === id && v.outcome !== agenda.result && v.votes > 0) ||
        !!agenda.predictions?.some((p) => p.player === id && p.outcome !== agenda.result)
      );
    },
    resolve: (state, id) => {
      const agenda = state.agenda!;
      if (agenda.step !== "outcome" || !agenda.card) return;
      state.decks.agendas.discard.push(agenda.card);
      log(state, `${agendasById[agenda.card]?.name ?? agenda.card} was discarded with no effect.`);
      agenda.result = undefined;
      agenda.step = "done";
      for (const planet of controlledPlanets(state, id)) planet.exhausted = true;
    },
  },
  "Decoy Operation": {
    windows: ["afterActivate"],
    targets: ["transfers"],
    usable: (state, id, context) => {
      if (context.player === id || context.system === undefined) return false;
      const system = systemOf(state, context.system);
      return system.planets.some(
        (p) =>
          totalUnits(state.planets[p].units[id], isStructure) > 0 &&
          state.planets[p].controller === id,
      );
    },
    play: (state, id, targets, context) => {
      for (const transfer of targets.transfers ?? []) {
        ensure(
          planetOf(state, transfer.to).system === context.system,
          "Place them on a planet you control in the active system.",
        );
      }
    },
    resolve: (state, id, targets) => transferGroundForces(state, id, targets, { limit: 2 }),
  },
  "Diplomatic Pressure": {
    windows: ["agendaRevealed"],
    targets: ["player"],
    play: (state, id, targets) => {
      targetPlayer(state, id, targets);
    },
    resolve: (state, id, targets) => takeNote(state, targetPlayer(state, id, targets), id),
    bot: (state, id) => {
      const target = others(state, id).sort(
        (a, b) => state.players[b].promissoryNotes.length - state.players[a].promissoryNotes.length,
      )[0];
      return target !== undefined && state.players[target].promissoryNotes.length > 0
        ? { player: target }
        : undefined;
    },
  },
  "Divert Funding": {
    action: true,
    targets: ["card", "technology", "planets"],
    play: (state, id, targets) => {
      const returned = technologiesById[targets.card ?? ""];
      ensure(
        returned && state.players[id].technologies.includes(returned.id),
        "Choose a technology you own to return.",
      );
      ensure(
        !returned.unitUpgrade && !returned.faction,
        "Return a non-unit upgrade, non-faction technology.",
      );
      targetTechnology(targets);
    },
    resolve: (state, id, targets) => {
      const player = playerOf(state, id);
      player.technologies = player.technologies.filter((t) => t !== targets.card);
      player.exhaustedTechnologies = player.exhaustedTechnologies.filter((t) => t !== targets.card);
      log(state, `${player.name} returned ${technologiesById[targets.card!].name}.`, { player: id });
      research(state, id, { technology: targetTechnology(targets), skips: targets.planets });
    },
  },
  "Exploration Probe": {
    action: true,
    targets: ["system"],
    usable: (state, id) => probeTargets(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(
        probeTargets(state, id).includes(targetSystem(state, targets).key),
        "Choose a frontier token in or next to a system with your ships.",
      );
    },
    resolve: (state, id, targets) => exploreFrontier(state, id, targetSystem(state, targets).key),
    bot: (state, id) => {
      const [system] = probeTargets(state, id);
      return system !== undefined ? { system } : undefined;
    },
  },
  "Manipulate Investments": {
    windows: ["strategyStart"],
    targets: ["cards"],
    play: (state, _id, targets) => {
      const cards = targets.cards ?? [];
      ensure(cards.length === 5, "Place 5 trade goods.");
      ensure(new Set(cards).size >= 3, "Place them on at least 3 different strategy cards.");
      const open = availableStrategyCards(state);
      ensure(cards.every((c) => open.includes(c)), "Place them on strategy cards nobody holds.");
    },
    resolve: (state, _id, targets) => {
      for (const card of targets.cards ?? []) {
        state.strategyCardBonus[card] = (state.strategyCardBonus[card] ?? 0) + 1;
      }
    },
    bot: (state) => {
      const open = availableStrategyCards(state);
      if (open.length < 3) return undefined;
      return { cards: [open[0], open[0], open[1], open[1], open[2]] };
    },
  },
  "Nav Suite": {
    windows: ["afterActivate"],
    usable: (state, id, context) => context.player === id && state.tactical?.step === "movement",
    resolve: (state, id) => setTacticalFlag(state, "navsuite", id),
  },
  "Refit Troops": {
    action: true,
    targets: ["planets"],
    usable: (state, id) =>
      unitsAvailable(state, id, "mech") > 0 &&
      controlledPlanets(state, id).some((p) => countOf(p.units[id], "infantry") > 0),
    play: (state, id, targets) => {
      const planets = targets.planets ?? [];
      ensure(planets.length >= 1 && planets.length <= 2, "Choose 1 or 2 infantry.");
      ensure(unitsAvailable(state, id, "mech") >= planets.length, "You do not have that many mechs.");
      for (const name of new Set(planets)) {
        const needed = planets.filter((p) => p === name).length;
        ensure(
          countOf(planetOf(state, name).units[id], "infantry") >= needed,
          `You do not have ${needed} infantry on ${name}.`,
        );
      }
    },
    resolve: (state, id, targets) => {
      for (const name of targets.planets ?? []) {
        const planet = planetOf(state, name);
        if (countOf(planet.units[id], "infantry") === 0 || unitsAvailable(state, id, "mech") === 0) continue;
        removeUnits(planet.units, id, "infantry", 1);
        addUnits(planet.units, id, "mech", 1);
      }
      log(state, `${playerName(state, id)} refit infantry into mechs.`, { player: id });
    },
    bot: (state, id) => {
      const planets = controlledPlanets(state, id)
        .filter((p) => countOf(p.units[id], "infantry") > 0)
        .map((p) => p.name)
        .slice(0, Math.min(2, unitsAvailable(state, id, "mech")));
      return planets.length > 0 ? { planets } : undefined;
    },
  },
  "Reveal Prototype": {
    windows: ["combatStart"],
    targets: ["technology", "payment"],
    usable: (state, id) => {
      const combat = currentCombat(state);
      return (
        !!combat && (combat.attacker === id || combat.defender === id) && prototypes(state, id).length > 0
      );
    },
    play: (state, id, targets) => {
      ensure(prototypes(state, id).includes(targetTechnology(targets)), "Choose a unit upgrade for a unit in this combat.");
      pay(state, id, targets.payment, "resources", 4);
    },
    resolve: (state, id, targets) => research(state, id, { technology: targetTechnology(targets) }),
    bot: (state, id) => {
      const [technology] = prototypes(state, id);
      const payment = findPayment(state, id, 4, "resources");
      return technology && payment ? { technology, payment } : undefined;
    },
  },
  "Reverse Engineer": {
    windows: ["afterActionCardDiscarded"],
    usable: (state, id, context) =>
      context.player !== id &&
      !!context.card &&
      !!actionCardsById[context.card]?.componentAction &&
      state.decks.actionCards.discard.includes(context.card),
    resolve: (state, id, _targets, context) => {
      const discard = state.decks.actionCards.discard;
      const index = discard.lastIndexOf(context.card!);
      if (index < 0) return;
      discard.splice(index, 1);
      playerOf(state, id).actionCards.push(context.card!);
    },
    bot: () => ({}),
  },
  Rout: {
    windows: ["announceRetreats"],
    usable: (state, id) => state.tactical?.spaceCombat?.defender === id,
    resolve: (state, id) => setCombatFlag(state.tactical!.spaceCombat!, "r.rout", id),
  },
  Scuttle: {
    action: true,
    targets: ["system", "units"],
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      const ships = Object.entries(targets.units ?? {}) as [UnitType, number][];
      const total = ships.reduce((sum, [, n]) => sum + n, 0);
      ensure(total >= 1 && total <= 2, "Choose 1 or 2 ships.");
      for (const [type, count] of ships) {
        ensure(isShip(type) && type !== "fighter", "Choose non-fighter ships.");
        ensure(countOf(system.space[id], type) >= count, `You do not have that many ${UNIT_NAMES[type]} there.`);
      }
    },
    resolve: (state, id, targets) => {
      const system = targetSystem(state, targets);
      let value = 0;
      for (const [type, count] of Object.entries(targets.units ?? {}) as [UnitType, number][]) {
        const removed = Math.min(count, countOf(system.space[id], type));
        if (removed <= 0) continue;
        removeUnits(system.space, id, type, removed);
        value += (unitOf(state, id, type)?.cost ?? 0) * removed;
      }
      removeExcessCargo(state, system.key, id);
      playerOf(state, id).tradeGoods += value;
      log(state, `${playerName(state, id)} scuttled ships for ${plural(value, "trade good")}.`, { player: id });
    },
  },
  "Seize Artifact": {
    action: true,
    targets: ["player", "fragments"],
    usable: (state, id) => seizable(state, id).length > 0,
    play: (state, id, targets) => {
      const victim = targetPlayer(state, id, targets);
      ensure(seizable(state, id).includes(victim), "Choose a neighbor with a relic fragment.");
      const [fragment] = targets.fragments ?? [];
      ensure(
        fragment === undefined || state.players[victim].relicFragments.includes(fragment),
        "Choose one of their relic fragments.",
      );
    },
    resolve: (state, id, targets) => {
      const victim = playerOf(state, targetPlayer(state, id, targets));
      const fragment = targets.fragments?.[0] ?? victim.relicFragments[0];
      if (!fragment || !victim.relicFragments.includes(fragment)) return;
      victim.relicFragments.splice(victim.relicFragments.indexOf(fragment), 1);
      playerOf(state, id).relicFragments.push(fragment);
      log(state, `${playerName(state, id)} took a relic fragment from ${victim.name}.`, { player: id });
    },
    bot: (state, id) => {
      const [player] = seizable(state, id);
      return player !== undefined ? { player } : undefined;
    },
  },
  Waylay: {
    windows: ["beforeAfb"],
    usable: (state, id) => !!state.tactical?.spaceCombat && !combatFlag(state.tactical.spaceCombat, "waylay", id),
    resolve: (state, id) => setCombatFlag(state.tactical!.spaceCombat!, "waylay", id),
  },
};

/** Frontier tokens in or next to a system with the player's ships. */
function probeTargets(state: GameState, id: PlayerId): SystemKey[] {
  const keys = new Set<SystemKey>();
  for (const system of systemsWithShips(state, id)) {
    for (const key of [system.key, ...adjacentSystems(state, system.key)]) {
      if (state.systems[key]?.frontier) keys.add(key);
    }
  }
  return [...keys];
}

/** Unit upgrades for unit types the player has in the current combat. */
function prototypes(state: GameState, id: PlayerId): string[] {
  const tactical = state.tactical;
  if (!tactical) return [];
  const group = tactical.groundCombat
    ? state.planets[tactical.groundCombat.planet].units[id]
    : systemOf(state, tactical.system).space[id];
  const types = unitTypes(group);
  return researchableTechnologies(state, id)
    .filter((tech) => {
      if (!tech.unitUpgrade || missingPrerequisites(state, id, tech.id).length > 0) return false;
      return types.some((type) => unitOf(state, id, type)?.upgradesToUnitId && tech.id === upgradeTechFor(state, id, type));
    })
    .map((tech) => tech.id);
}

const upgradeTechFor = (state: GameState, id: PlayerId, type: UnitType) => {
  const unit = unitOf(state, id, type);
  return unit?.upgradesToUnitId ? unitsById[unit.upgradesToUnitId]?.requiredTechId : undefined;
};

const seizable = (state: GameState, id: PlayerId) =>
  others(state, id).filter(
    (other) => state.players[other].relicFragments.length > 0 && areNeighbors(state, id, other),
  );

// --- Abilities, technologies and units -------------------------------------------

const sleeperCount = (state: GameState) =>
  Object.values(state.planets).filter((p) => p.sleeper).length;

/** Planets in the active system with sleeper tokens. */
const sleepersHere = (state: GameState) =>
  (activeSystem(state)?.planets ?? []).filter((p) => state.planets[p].sleeper);

const ABILITIES: Record<string, Effect> = {
  // Naaz-Rokha: choose 1 of the 2 cards drawn; the other is discarded.
  distant_suns: {
    targets: ["card"],
    resolve: (state, id, targets, context) => {
      const cards = context.cards ?? [];
      const chosen = targets.card ?? cards[0];
      ensure(cards.includes(chosen), "Choose 1 of the cards you drew.");
      for (const card of cards) {
        if (card === chosen) continue;
        state.decks[explorationsById[card].deck].discard.push(card);
      }
      resolveExploration(state, id, chosen, { planet: context.planet, system: context.system });
    },
    bot: (_state, _id, context) => {
      const cards = context.cards ?? [];
      // Relic fragments and attachments are worth more than most instant cards.
      const best =
        cards.find((c) => explorationsById[c]?.resolution === "attach") ??
        cards.find((c) => explorationsById[c]?.resolution === "fragment") ??
        cards[0];
      return { card: best };
    },
  },
  fabrication: {
    action: true,
    targets: ["fragments", "choice"],
    usable: (state, id) => state.players[id].relicFragments.length > 0,
    play: (state, id, targets) => {
      const count = targets.fragments?.length === 2 ? 2 : 1;
      purgeFragments(state, id, checkFragments(state, id, targets.fragments, count));
    },
    resolve: (state, id, targets) => {
      if (targets.fragments?.length === 2) gainRelic(state, id);
      else gainCommandTokens(state, id, 1, poolChoice(targets.choice));
    },
    bot: (state, id) => {
      const pair = fragmentSet(state, id, 2);
      return pair ? { fragments: pair } : undefined;
    },
  },

  // Titans
  terragenesis: {
    windows: ["afterExplore"],
    usable: (state, _id, context) =>
      !!context.planet && !state.planets[context.planet]?.sleeper,
    resolve: (state, id, _targets, context) => {
      if (sleeperCount(state) >= 5) {
        // All 5 are out: move one here.
        const from = Object.values(state.planets).find((p) => p.sleeper);
        if (from) from.sleeper = false;
      }
      state.planets[context.planet!].sleeper = true;
      log(state, `${playerName(state, id)} placed a sleeper token on ${context.planet}.`, { player: id });
    },
    bot: (state) => (sleeperCount(state) < 5 ? {} : undefined),
  },
  awaken: {
    windows: ["afterActivate"],
    usable: (state, id, context) =>
      context.player === id && sleepersHere(state).length > 0 && unitsAvailable(state, id, "pds") > 0,
    resolve: (state, id) => {
      const tactical = state.tactical!;
      for (const name of sleepersHere(state)) {
        const planet = state.planets[name];
        planet.sleeper = false;
        if (placeUnits(state, id, "pds", 1, { system: planet.system, planet: name }) === 0) continue;
        // Coalescence: Hel-Titans placed beside other players' ground forces fight them.
        const hostile = Object.keys(planet.units)
          .map(Number)
          .some((owner) => owner !== id && totalUnits(planet.units[owner], (t) => t === "infantry" || t === "mech") > 0);
        if (hostile && !tactical.invaded.includes(name)) tactical.invaded.push(name);
      }
    },
    bot: () => ({}),
  },
  titans_flagship: {
    windows: ["afterActivate"],
    targets: ["planet"],
    usable: (state, id, context) =>
      context.player === id &&
      unitIs(state, id, "flagship", "titans_flagship") &&
      unitsAvailable(state, id, "flagship") > 0 &&
      (activeSystem(state)?.planets ?? []).some((p) => countOf(state.planets[p].units[id], "pds") > 0),
    play: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      ensure(
        planet.system === state.tactical!.system && countOf(planet.units[id], "pds") > 0,
        "Choose a planet in the active system with your PDS.",
      );
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      removeUnits(planet.units, id, "pds", 1);
      addUnits(systemOf(state, planet.system).space, id, "flagship", 1);
      log(state, `${playerName(state, id)} deployed Ouranos.`, { player: id });
    },
    bot: (state, id) => {
      const planet = (activeSystem(state)?.planets ?? []).find((p) => countOf(state.planets[p].units[id], "pds") > 0);
      return planet ? { planet } : undefined;
    },
  },

  // Empyrean
  aetherpassage: {
    windows: ["afterActivate"],
    usable: (_state, id, context) => context.player !== undefined && context.player !== id,
    resolve: (state, id, _targets, context) => setTacticalFlag(state, `aether@${id}`, context.player!),
  },
  as: {
    windows: ["afterActivate"],
    usable: (state, id, context) => {
      if (context.player === undefined || context.system === undefined || !readyTech(state, id, "as")) return false;
      if (context.player !== id && !areNeighbors(state, id, context.player)) return false;
      return adjacentSystems(state, context.system).some((k) => anomaliesOf(state.systems[k]).length > 0);
    },
    play: (state, id) => exhaustTech(state, id, "as"),
    resolve: (state, _id, _targets, context) => setTacticalFlag(state, "aetherstream", context.player!),
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  empyrean_mech: {
    windows: ["actionCardPlayed"],
    usable: (state, id, context) =>
      context.player !== undefined && context.player !== id && watcherNear(state, id, context.player) !== undefined,
    resolve: (state, id, _targets, context) => {
      const where = watcherNear(state, id, context.player!);
      if (!where) return;
      const forces = where.planet ? state.planets[where.planet].units : systemOf(state, where.system).space;
      removeUnits(forces, id, "mech", 1);
      cancelPending(state, context.ref);
      log(state, `${playerName(state, id)} removed a Watcher to cancel the card.`, { player: id });
    },
  },
  empyrean_flagship: {
    windows: ["afterSustainAny"],
    targets: ["payment"],
    usable: (state, id, context) => {
      if (context.system === undefined || !unitIs(state, id, "flagship", "empyrean_flagship")) return false;
      return [context.system, ...adjacentSystems(state, context.system)].some(
        (k) => countOf(state.systems[k].space[id], "flagship") > 0,
      );
    },
    play: (state, id, targets) => pay(state, id, targets.payment, "influence", 2),
    resolve: (state, _id, _targets, context) => {
      const owner = context.player!;
      const space = systemOf(state, context.system!).space[owner];
      const ground = state.tactical?.groundCombat
        ? state.planets[state.tactical.groundCombat.planet].units[owner]
        : undefined;
      const stack = space?.[context.unit!] ?? ground?.[context.unit!];
      if (stack && stack.damaged > 0) stack.damaged--;
      log(state, `Dynamo repaired ${playerName(state, owner)}'s ${UNIT_NAMES[context.unit!]}.`);
    },
    bot: (state, id, context) => {
      if (context.player !== id) return undefined;
      const payment = findPayment(state, id, 2, "influence");
      return payment ? { payment } : undefined;
    },
  },

  // Mahact
  gr: {
    windows: ["beforeVote"],
    targets: ["player", "outcome"],
    usable: (state, id) => readyTech(state, id, "gr") && !!state.agenda?.card,
    play: (state, id, targets) => {
      const voter = targetPlayer(state, id, targets);
      ensure(canVote(state, voter), "That player cannot vote on this agenda.");
      ensure(
        agendaOutcomes(state, state.agenda!.card!).includes(targets.outcome ?? ""),
        "Choose an outcome of this agenda.",
      );
      exhaustTech(state, id, "gr");
    },
    resolve: (state, id, targets) => {
      const voter = targetPlayer(state, id, targets);
      (state.agenda!.recombination ??= []).push({ player: voter, outcome: targets.outcome! });
      log(state, `${playerName(state, voter)} must vote for ${targets.outcome} or lose a fleet token.`);
    },
  },
  mahact_mech: {
    windows: ["afterActivate"],
    usable: (state, id, context) => {
      const active = context.player;
      if (active === undefined || active === id || context.system === undefined) return false;
      if (!(state.players[id].edictTokens ?? []).includes(active)) return false;
      return hasMechIn(state, id, context.system) && unitIs(state, id, "mech", "mahact_mech");
    },
    resolve: (state, id, _targets, context) => {
      const active = context.player!;
      const mahact = playerOf(state, id);
      mahact.edictTokens = (mahact.edictTokens ?? []).filter((t, i, all) => !(t === active && all.indexOf(t) === i));
      // A smaller fleet pool may leave too many ships somewhere.
      enforceFleetSupply(state, id);
      const player = playerOf(state, active);
      player.pools.tactic++;
      log(state, `Starlancer: ${mahact.name} ended ${player.name}'s turn.`, { player: id });
      endTurnNow(state, active);
    },
    bot: () => ({}),
  },

  // Naaz-Rokha
  sc: {
    windows: ["roundStart"],
    usable: (state, id) => {
      const combat = currentCombat(state);
      return !!combat && (combat.attacker === id || combat.defender === id) && readyTech(state, id, "sc");
    },
    play: (state, id) => exhaustTech(state, id, "sc"),
    resolve: (state, id) => {
      const combat = currentCombat(state)!;
      combat.roundModifiers = { ...combat.roundModifiers, [id]: (combat.roundModifiers?.[id] ?? 0) + 1 };
    },
    bot: () => ({}),
  },

  // Vuil'raith
  vtx: {
    action: true,
    targets: ["player", "unit"],
    usable: (state, id) => readyTech(state, id, "vtx") && vortexTargets(state, id).length > 0,
    play: (state, id, targets) => {
      const victim = targetPlayer(state, id, targets);
      ensure(
        vortexTargets(state, id).some((t) => t.player === victim && t.unit === targets.unit),
        "Choose a unit of theirs next to one of your space docks.",
      );
      exhaustTech(state, id, "vtx");
    },
    resolve: (state, id, targets) => {
      const victim = targetPlayer(state, id, targets);
      const type = targets.unit!;
      if (unitsAvailable(state, victim, type) <= 0) return;
      const captured = (playerOf(state, id).captured ??= []);
      const existing = captured.find((c) => c.owner === victim && c.type === type);
      if (existing) existing.count++;
      else captured.push({ owner: victim, type, count: 1 });
      log(state, `${playerName(state, id)} captured a ${UNIT_NAMES[type]} of ${playerName(state, victim)}.`, {
        player: id,
      });
    },
    bot: (state, id) => {
      const best = vortexTargets(state, id).sort(
        (a, b) => (unitOf(state, b.player, b.unit)?.cost ?? 0) - (unitOf(state, a.player, a.unit)?.cost ?? 0),
      )[0];
      return best ? { player: best.player, unit: best.unit } : undefined;
    },
  },

  // Technologies
  sr: {
    action: true,
    targets: ["system", "production", "payment"],
    usable: (state, id) => readyTech(state, id, "sr"),
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(dockIn(state, id, system.key), "Choose a system with your space dock.");
      const orders = (targets.production ?? []).filter((o) => o.count > 0);
      ensure(orders.length === 1 && orders[0].count === 1 && isShip(orders[0].type), "Produce 1 ship.");
      exhaustTech(state, id, "sr");
    },
    resolve: (state, id, targets) =>
      produce(state, id, targetSystem(state, targets).key, targets.production!, targets.payment ?? NO_PAYMENT, {
        limit: 1,
      }),
    bot: (state, id) => {
      const home = state.players[id].home;
      const type = unitsAvailable(state, id, "cruiser") > 0 ? "cruiser" : "destroyer";
      const payment = findPayment(state, id, unitOf(state, id, type)?.cost ?? 2, "resources");
      if (!payment || !dockIn(state, id, home)) return undefined;
      return { system: home, production: [{ type, count: 1 }], payment };
    },
  },
  pa: {
    windows: ["turnEnd"],
    targets: ["planets"],
    usable: (state, id, context) => context.player === id && specialtyPlanets(state, id).length > 0,
    play: (state, id, targets) => {
      for (const name of targets.planets ?? []) {
        ensure(specialtyPlanets(state, id).includes(name), `${name} cannot be exhausted for a trade good.`);
      }
    },
    resolve: (state, id, targets) => {
      const planets = targets.planets ?? [];
      for (const name of planets) state.planets[name].exhausted = true;
      playerOf(state, id).tradeGoods += planets.length;
      if (planets.length > 0) {
        log(state, `${playerName(state, id)} gained ${plural(planets.length, "trade good")} from Psychoarchaeology.`, {
          player: id,
        });
      }
    },
    // Only once there is nothing left this round to spend them on.
    bot: (state, id) => (state.players[id].passed ? { planets: specialtyPlanets(state, id) } : undefined),
  },
  bs: {
    windows: ["turnEnd"],
    targets: ["planet", "technology"],
    usable: (state, id, context) => context.player === id && readyTech(state, id, "bs"),
    play: (state, id, targets) => {
      if (targets.planet) {
        const planet = ownPlanet(state, id, targets);
        ensure(planetTechSpecialties(state, planet.name).length > 0, "Choose a planet with a technology specialty.");
      } else {
        const tech = targetTechnology(targets);
        ensure(tech !== "bs" && state.players[id].exhaustedTechnologies.includes(tech), "Choose another exhausted technology.");
      }
      exhaustTech(state, id, "bs");
    },
    resolve: (state, id, targets) => {
      if (targets.planet) planetOf(state, targets.planet).exhausted = false;
      else {
        const player = playerOf(state, id);
        player.exhaustedTechnologies = player.exhaustedTechnologies.filter((t) => t !== targets.technology);
      }
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id)
        .filter((p) => p.exhausted && planetTechSpecialties(state, p.name).length > 0)
        .sort((a, b) => planetResources(state, b.name) - planetResources(state, a.name))[0];
      if (planet && !state.players[id].passed) return { planet: planet.name };
      const tech = state.players[id].exhaustedTechnologies.find((t) => t !== "bs");
      return tech ? { technology: tech } : undefined;
    },
  },
  sar: {
    windows: ["afterProduce"],
    targets: ["planet"],
    usable: (state, id, context) =>
      context.player === id &&
      readyTech(state, id, "sar") &&
      unitsAvailable(state, id, "mech") > 0 &&
      context.system !== undefined &&
      systemOf(state, context.system).planets.some((p) => state.planets[p].controller === id),
    play: (state, id, targets, context) => {
      ensure(ownPlanet(state, id, targets).system === context.system, "Choose a planet you control in that system.");
      exhaustTech(state, id, "sar");
    },
    resolve: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
    },
    bot: (state, id, context) => {
      const planet = systemOf(state, context.system!).planets.find((p) => state.planets[p].controller === id);
      return planet ? { planet } : undefined;
    },
  },
  sdn: {
    windows: ["afterActivate"],
    targets: ["planet"],
    usable: (state, id, context) => context.player === id && scanTargets(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(scanTargets(state, id).includes(targetPlanet(state, targets).name), "Choose a planet with your units in the active system.");
    },
    resolve: (state, id, targets) => explorePlanet(state, id, targetPlanet(state, targets).name),
    bot: (state, id) => {
      const [planet] = scanTargets(state, id);
      return planet ? { planet } : undefined;
    },
  },
  pi: {
    windows: ["turnEnd"],
    usable: (state, id, context) => context.player === id && readyTech(state, id, "pi"),
    play: (state, id) => exhaustTech(state, id, "pi"),
    resolve: (state, id) => ask(state, [{ kind: "redistribute", player: id, gained: 0 }]),
  },
  tcs: {
    windows: ["afterAgentExhausted"],
    usable: (state, id, context) => readyTech(state, id, "tcs") && context.card !== undefined,
    play: (state, id) => exhaustTech(state, id, "tcs"),
    resolve: (state, _id, _targets, context) => {
      const owner = state.seating.find((p) => state.players[p].leaders.some((l) => l.id === context.card));
      if (owner !== undefined) readyLeader(state, owner, context.card!);
      log(state, "Temporal Command Suite readied the agent.");
    },
    bot: (_state, id, context) => (context.player === id ? {} : undefined),
  },
  aida: {
    windows: ["productionStart"],
    usable: (state, id, context) =>
      context.player === id &&
      readyTech(state, id, "aida") &&
      state.players[id].technologies.some((t) => technologiesById[t]?.unitUpgrade),
    play: (state, id) => exhaustTech(state, id, "aida"),
    resolve: (state, id) => setTacticalFlag(state, "aida", id),
    bot: (state, id) =>
      state.players[id].technologies.filter((t) => technologiesById[t]?.unitUpgrade).length >= 2 ? {} : undefined,
  },

  // Mechs of the base factions
  ghost_mech: {
    windows: ["afterActivate"],
    targets: ["system", "choice"],
    usable: (state, id) => unitIs(state, id, "mech", "ghost_mech") && mechSystems(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(mechSystems(state, id).includes(targetSystem(state, targets).key), "Choose a system with your mech.");
      ensure(targets.choice === "alpha" || targets.choice === "beta", 'Choose the "alpha" or "beta" token.');
    },
    resolve: (state, id, targets) => {
      const system = targetSystem(state, targets);
      const forces = hasMechIn(state, id, system.key, "space")
        ? system.space
        : state.planets[system.planets.find((p) => countOf(state.planets[p].units[id], "mech") > 0)!].units;
      removeUnits(forces, id, "mech", 1);
      const wormhole = targets.choice === "beta" ? "BETA" : "ALPHA";
      for (const other of Object.values(state.systems)) {
        other.addedWormholes = other.addedWormholes.filter((w) => w !== wormhole);
      }
      system.addedWormholes.push(wormhole);
      log(state, `${playerName(state, id)} moved the ${wormhole.toLowerCase()} wormhole token to ${describeSystem(state, system.key)}.`, {
        player: id,
      });
    },
  },
  letnev_mech: {
    windows: ["roundStart"],
    targets: ["payment"],
    usable: (state, id) => {
      const ground = state.tactical?.groundCombat;
      if (!ground || (ground.attacker !== id && ground.defender !== id)) return false;
      return (
        unitIs(state, id, "mech", "letnev_mech") &&
        unitsAvailable(state, id, "mech") > 0 &&
        countOf(state.planets[ground.planet].units[id], "infantry") > 0
      );
    },
    play: (state, id, targets) => pay(state, id, targets.payment, "resources", 2),
    resolve: (state, id) => {
      const units = state.planets[state.tactical!.groundCombat!.planet].units;
      if (countOf(units[id], "infantry") === 0) return;
      removeUnits(units, id, "infantry", 1);
      addUnits(units, id, "mech", 1);
      log(state, `${playerName(state, id)} deployed a Dunlain Reaper.`, { player: id });
    },
    bot: (state, id) => {
      const payment = findPayment(state, id, 2, "resources");
      return payment ? { payment } : undefined;
    },
  },
  saar_mech: {
    windows: ["afterGainControl"],
    usable: (state, id, context) =>
      !!context.planet &&
      state.planets[context.planet]?.controller === id &&
      unitIs(state, id, "mech", "saar_mech") &&
      unitsAvailable(state, id, "mech") > 0 &&
      state.players[id].tradeGoods > 0,
    play: (state, id) => {
      playerOf(state, id).tradeGoods--;
    },
    resolve: (state, id, _targets, context) => {
      const planet = planetOf(state, context.planet!);
      placeUnits(state, id, "mech", 1, { system: planet.system, planet: planet.name });
    },
    bot: () => ({}),
  },
  winnu_mech: {
    windows: ["afterTacticalAction"],
    targets: ["planet", "choice"],
    usable: (state, id, context) => context.player === id && reclaimable(state, id, context.cards).length > 0,
    play: (state, id, targets, context) => {
      ensure(reclaimable(state, id, context.cards).includes(targetPlanet(state, targets).name), "Choose a planet you just took with your mech on it.");
      ensure(targets.choice === "pds" || targets.choice === "spacedock", 'Choose "pds" or "spacedock".');
    },
    resolve: (state, id, targets) => {
      const planet = targetPlanet(state, targets);
      placeUnits(state, id, targets.choice as UnitType, 1, { system: planet.system, planet: planet.name });
    },
    bot: (state, id, context) => {
      const [planet] = reclaimable(state, id, context.cards);
      if (!planet) return undefined;
      const choice = unitsAvailable(state, id, "spacedock") > 0 ? "spacedock" : "pds";
      return { planet, choice };
    },
  },

  // Agendas that elect a player who then chooses.
  grant_reallocation: {
    targets: ["technology"],
    play: (state, id, targets) => {
      const tech = targetTechnology(targets);
      ensure(researchableTechnologies(state, id).some((t) => t.id === tech), "Choose a technology you do not own.");
    },
    resolve: (state, id, targets) => {
      const tech = technologiesById[targetTechnology(targets)];
      const player = playerOf(state, id);
      player.technologies.push(tech.id);
      const lost = Math.min(tech.prerequisites.length, player.pools.fleet);
      player.pools.fleet -= lost;
      enforceFleetSupply(state, id);
      log(state, `${player.name} gained ${tech.name} and returned ${plural(lost, "fleet token")}.`, { player: id });
    },
    bot: (state, id) => {
      const fleet = state.players[id].pools.fleet;
      const tech = researchableTechnologies(state, id)
        .filter((t) => t.prerequisites.length <= Math.max(0, fleet - 2))
        .sort((a, b) => b.prerequisites.length - a.prerequisites.length)[0];
      return tech ? { technology: tech.id } : { technology: researchableTechnologies(state, id)[0]?.id };
    },
  },
};

const hasMechIn = (state: GameState, id: PlayerId, key: SystemKey, only?: "space") => {
  const system = systemOf(state, key);
  if (countOf(system.space[id], "mech") > 0) return true;
  return only !== "space" && system.planets.some((p) => countOf(state.planets[p].units[id], "mech") > 0);
};

const mechSystems = (state: GameState, id: PlayerId) =>
  Object.values(state.systems)
    .filter((s) => hasMechIn(state, id, s.key))
    .map((s) => s.key);

/** A Watcher in or next to a system holding another player's units. */
function watcherNear(state: GameState, id: PlayerId, other: PlayerId) {
  if (!unitIs(state, id, "mech", "empyrean_mech")) return undefined;
  for (const key of mechSystems(state, id)) {
    if (![key, ...adjacentSystems(state, key)].some((k) => hasUnitsIn(state, other, k))) continue;
    const system = systemOf(state, key);
    if (countOf(system.space[id], "mech") > 0) return { system: key };
    const planet = system.planets.find((p) => countOf(state.planets[p].units[id], "mech") > 0);
    if (planet) return { system: key, planet };
  }
  return undefined;
}

const dockIn = (state: GameState, id: PlayerId, key: SystemKey) => {
  const system = systemOf(state, key);
  return (
    countOf(system.space[id], "spacedock") > 0 ||
    system.planets.some((p) => countOf(state.planets[p].units[id], "spacedock") > 0)
  );
};

/** Units of other players that Vortex can capture: types they have next to the Vuil'raith's docks. */
function vortexTargets(state: GameState, id: PlayerId) {
  const docks = Object.values(state.systems).filter((s) => dockIn(state, id, s.key));
  const near = new Set(docks.flatMap((s) => adjacentSystems(state, s.key)));
  const found: { player: PlayerId; unit: UnitType }[] = [];
  for (const key of near) {
    const system = systemOf(state, key);
    for (const other of others(state, id)) {
      const groups = [system.space[other], ...system.planets.map((p) => state.planets[p].units[other])];
      for (const type of groups.flatMap((g) => unitTypes(g))) {
        if (isStructure(type) || unitsAvailable(state, other, type) <= 0) continue;
        if (!found.some((f) => f.player === other && f.unit === type)) found.push({ player: other, unit: type });
      }
    }
  }
  return found;
}

const specialtyPlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id)
    .filter((p) => !p.exhausted && planetTechSpecialties(state, p.name).length > 0)
    .map((p) => p.name);

/** Planets in the active system with the player's units that can be explored. */
const scanTargets = (state: GameState, id: PlayerId) =>
  (activeSystem(state)?.planets ?? []).filter(
    (p) => totalUnits(state.planets[p].units[id]) > 0 && planetTraits(state, p).length > 0,
  );

/** Planets taken this tactical action that hold a Reclaimer. */
const reclaimable = (state: GameState, id: PlayerId, gained: string[] | undefined) =>
  (gained ?? []).filter(
    (p) =>
      state.planets[p]?.controller === id && holdsUnit(state, id, state.planets[p].units[id], "mech", "winnu_mech"),
  );

// --- Promissory notes -------------------------------------------------------------

const NOTES: Record<string, Effect> = {
  // Placed in the play area when played; they work from there.
  blood_pact: { action: true, resolve: () => {} },
  dark_pact: { action: true, resolve: () => {} },
  scepter: {
    windows: ["strategyStart"],
    targets: ["system"],
    usable: (state, id, context) => scepterPlayers(state, id, context.noteOwner).length > 0,
    play: (state, id, targets) => {
      const system = targetSystem(state, targets);
      ensure(!isHomeSystem(system) && hasUnitsIn(state, id, system.key), "Choose a non-home system with your units.");
    },
    resolve: (state, id, targets, context) => {
      const key = targetSystem(state, targets).key;
      for (const other of scepterPlayers(state, id, context.noteOwner)) placeCommandToken(state, other, key);
    },
    bot: (state, id) => {
      const system = Object.values(state.systems).find(
        (s) => !isHomeSystem(s) && hasUnitsIn(state, id, s.key),
      );
      return system ? { system: system.key } : undefined;
    },
  },
  bmf: {
    action: true,
    targets: ["fragments"],
    usable: (state, id) => fragmentSet(state, id, 2) !== undefined,
    play: (state, id, targets) => purgeFragments(state, id, checkFragments(state, id, targets.fragments, 2)),
    resolve: (state, id) => {
      gainRelic(state, id);
    },
    bot: (state, id) => ({ fragments: fragmentSet(state, id, 2) }),
  },
  cavalry: {
    windows: ["combatStart"],
    targets: ["unit"],
    usable: (state, id, context) =>
      !!state.tactical?.spaceCombat &&
      [state.tactical.spaceCombat.attacker, state.tactical.spaceCombat.defender].includes(id) &&
      context.player !== context.noteOwner,
    play: (state, id, targets) => {
      const type = targets.unit;
      ensure(
        type && isShip(type) && type !== "fighter" && countOf(systemOf(state, state.tactical!.system).space[id], type) > 0,
        "Choose 1 of your non-fighter ships in this combat.",
      );
    },
    resolve: (state, id, targets) => setCombatFlag(state.tactical!.spaceCombat!, `cavalry@${targets.unit}`, id),
    bot: (state, id) => {
      const space = systemOf(state, state.tactical!.system).space[id];
      const unit = (["destroyer", "cruiser", "carrier", "dreadnought"] as UnitType[]).find((t) => countOf(space, t) > 0);
      return unit ? { unit } : undefined;
    },
  },
  crucible: {
    windows: ["afterActivate"],
    usable: (_state, id, context) => context.player === id,
    resolve: (state, id) => setTacticalFlag(state, "crucible", id),
  },
  terraform: {
    action: true,
    targets: ["planet"],
    play: (state, id, targets) => {
      const planet = ownPlanet(state, id, targets);
      ensure(
        !isHomeSystem(systemOf(state, planet.system)) && planet.name !== MECATOL_REX,
        "Choose a non-home planet other than Mecatol Rex.",
      );
    },
    resolve: (state, id, targets, context) => {
      const planet = ownPlanet(state, id, targets);
      planet.attachments.push("titanspn");
      const player = playerOf(state, id);
      player.promissoryNotesInPlay = player.promissoryNotesInPlay.filter(
        (n) => !(n.id === "terraform" && n.owner === context.noteOwner),
      );
      log(state, `${player.name} terraformed ${planet.name}.`, { player: id });
    },
    bot: (state, id) => {
      const planet = controlledPlanets(state, id)
        .filter((p) => !isHomeSystem(state.systems[p.system]) && p.name !== MECATOL_REX)
        .sort(
          (a, b) =>
            planetResources(state, b.name) + planetInfluence(state, b.name) -
            planetResources(state, a.name) - planetInfluence(state, a.name),
        )[0];
      return planet ? { planet: planet.name } : undefined;
    },
  },
};

/** Players with a token on the Mahact player's command sheet, other than the holder. */
const scepterPlayers = (state: GameState, id: PlayerId, mahact: PlayerId | undefined) =>
  mahact === undefined
    ? []
    : [...new Set(state.players[mahact].edictTokens ?? [])].filter(
        (other) => other !== id && tokensInReinforcements(state, other) > 0,
      );

export const POK_EFFECTS: EffectArea = {
  actionCards: ACTION_CARDS,
  abilities: ABILITIES,
  notes: { ...NOTES, ...KELERES_RIDERS },
};
