import { PlayerId } from "~/types";
import {
  attachmentsById,
  ExplorationDeck,
  explorationsById,
  isStructure,
  objectivesById,
} from "../data";
import { GameState, SystemKey } from "../types";
import {
  isLegendary,
  MALLICE,
  planetOf,
  planetTechSpecialties,
  planetTraits,
  systemOf,
  WORMHOLE_NEXUS_ID,
} from "./board";
import {
  ask,
  draw,
  hasShips,
  initiativeOrder,
  log,
  playerName,
  playerOf,
  totalUnits,
  unitTypes,
} from "./helpers";

// --- Victory ----------------------------------------------------------------

export function victoryPoints(state: GameState, id: PlayerId) {
  const player = state.players[id];
  const publics = state.publicObjectives
    .filter((o) => o.scoredBy.includes(id))
    .reduce((sum, o) => sum + (objectivesById[o.id]?.points ?? 0), 0);
  const secrets = player.scoredSecrets.reduce(
    (sum, secret) => sum + (objectivesById[secret]?.points ?? 1),
    0,
  );
  return publics + secrets + player.bonusVictoryPoints;
}

export const scoredObjectives = (state: GameState, id: PlayerId) =>
  state.publicObjectives.filter((o) => o.scoredBy.includes(id)).length +
  state.players[id].scoredSecrets.length;

/** Ends the game once a player reaches the victory point goal (LRR 98.7). */
export function checkVictory(state: GameState) {
  if (state.phase === "finished") return;
  const winners = initiativeOrder(state).filter(
    (id) => victoryPoints(state, id) >= state.options.victoryPoints,
  );
  if (winners.length === 0) return;
  finishGame(state, winners[0]);
}

export function finishGame(state: GameState, winner: PlayerId) {
  state.phase = "finished";
  state.winner = winner;
  state.prompts = [];
  state.tactical = undefined;
  state.strategic = undefined;
  state.activePlayer = undefined;
  log(
    state,
    `${playerName(state, winner)} wins with ${victoryPoints(state, winner)} victory points.`,
  );
}

/** Heroes unlock at three scored objectives (LRR 51.10). */
export function unlockLeaders(state: GameState) {
  for (const id of state.seating) {
    const player = state.players[id];
    const hero = player.leaders.find((l) => l.type === "hero");
    if (hero?.status === "locked" && scoredObjectives(state, id) >= 3) {
      hero.status = "ready";
      log(state, `${player.name} unlocked their hero.`, { player: id });
    }
  }
}

// --- Exploration ------------------------------------------------------------

const RESEARCH_FACILITIES = ["biotic", "cybernetic", "propulsion", "warfare"];

export function explore(
  state: GameState,
  id: PlayerId,
  deck: ExplorationDeck,
  target: { planet?: string; system?: SystemKey },
) {
  const player = playerOf(state, id);
  const cardId = draw(state, state.decks[deck]);
  if (!cardId) return;
  const card = explorationsById[cardId];
  const where = target.planet ?? "the frontier";
  log(state, `${player.name} explored ${where}: ${card.name}.`, { player: id });

  if (card.resolution === "fragment") {
    player.relicFragments.push(card.id);
    return;
  }

  if (card.resolution === "attach" && target.planet && card.attachmentId) {
    const planet = planetOf(state, target.planet);
    // A research facility on a planet that already has a specialty gives
    // +1 resource and +1 influence instead.
    const alreadySpecialised =
      RESEARCH_FACILITIES.includes(card.attachmentId) &&
      planetTechSpecialties(state, target.planet).length > 0;
    const attachment = alreadySpecialised
      ? `${card.attachmentId}stat`
      : card.attachmentId;
    if (attachmentsById[attachment]) planet.attachments.push(attachment);
    // Attachments with further instructions still need the table's attention.
    if (attachmentsById[attachment] && !/return|destroy|cannot/i.test(card.text)) {
      return;
    }
  } else {
    state.decks[deck].discard.push(card.id);
  }

  ask(state, [
    {
      kind: "resolve",
      player: id,
      title: `Exploration: ${card.name}`,
      text: card.text,
      card: card.id,
    },
  ]);
}

export function explorePlanet(state: GameState, id: PlayerId, name: string) {
  if (!state.options.expansions.includes("pok")) return;
  const traits = planetTraits(state, name);
  if (traits.length === 0) return;
  // Planets with several traits let the player choose; the first is taken
  // here and the table can redraw from another deck by hand.
  explore(state, id, traits[0].toLowerCase() as ExplorationDeck, {
    planet: name,
  });
}

export function exploreFrontier(state: GameState, id: PlayerId, key: SystemKey) {
  const system = systemOf(state, key);
  if (!system.frontier) return;
  system.frontier = false;
  explore(state, id, "frontier", { system: key });
}

// --- Control ----------------------------------------------------------------

export function activateNexus(state: GameState) {
  const nexus = Object.values(state.systems).find(
    (s) => s.systemId === WORMHOLE_NEXUS_ID,
  );
  if (!nexus || nexus.inactiveWormholes.length === 0) return;
  nexus.inactiveWormholes = [];
  log(state, "The wormhole nexus is now active.");
}

export function gainControl(
  state: GameState,
  id: PlayerId,
  name: string,
  options: { exhaust?: boolean; explore?: boolean } = {},
) {
  const planet = planetOf(state, name);
  if (planet.controller === id) return;
  const player = playerOf(state, id);
  const previous = planet.controller;

  // Structures belonging to anyone else do not survive the takeover.
  for (const owner of Object.keys(planet.units).map(Number)) {
    if (owner === id) continue;
    for (const type of unitTypes(planet.units[owner])) {
      if (isStructure(type)) delete planet.units[owner][type];
    }
    if (unitTypes(planet.units[owner]).length === 0) delete planet.units[owner];
  }

  planet.controller = id;
  planet.exhausted = options.exhaust ?? true;
  log(
    state,
    previous === undefined
      ? `${player.name} took control of ${name}.`
      : `${player.name} took ${name} from ${playerName(state, previous)}.`,
    { player: id },
  );

  if (name === MALLICE) activateNexus(state);
  if (isLegendary(state, name)) planet.legendaryExhausted = previous !== undefined
    ? planet.legendaryExhausted
    : false;
  if (previous === undefined && (options.explore ?? true)) {
    explorePlanet(state, id, name);
  }
  if (previous !== undefined) checkElimination(state, previous);
}

/**
 * Removes a player who has no ground forces, no unit with PRODUCTION and no
 * planets from the game (LRR 33).
 */
export function checkElimination(state: GameState, id: PlayerId) {
  const player = state.players[id];
  if (!player || player.eliminated) return;
  const hasGroundForces =
    Object.values(state.planets).some(
      (p) =>
        totalUnits(p.units[id], (t) => t === "infantry" || t === "mech") > 0,
    ) ||
    Object.values(state.systems).some(
      (s) =>
        totalUnits(s.space[id], (t) => t === "infantry" || t === "mech") > 0,
    );
  const hasProduction =
    Object.values(state.planets).some(
      (p) => totalUnits(p.units[id], (t) => t === "spacedock") > 0,
    ) ||
    Object.values(state.systems).some(
      (s) => totalUnits(s.space[id], (t) => t === "spacedock") > 0,
    );
  const hasPlanets = Object.values(state.planets).some(
    (p) => p.controller === id,
  );
  if (hasGroundForces || hasProduction || hasPlanets) return;

  player.eliminated = true;
  player.passed = true;
  for (const system of Object.values(state.systems)) {
    delete system.space[id];
    system.commandTokens = system.commandTokens.filter((t) => t !== id);
  }
  state.decks.actionCards.discard.push(...player.actionCards);
  player.actionCards = [];
  state.decks.secretObjectives.draw.push(
    ...player.secretObjectives,
    ...player.scoredSecrets,
  );
  player.secretObjectives = [];
  player.strategyCards = [];
  state.laws = state.laws.filter((law) => law.owner !== id);
  state.prompts = state.prompts.filter((p) => p.player !== id);
  if (state.speaker === id) {
    const seats = state.seating.filter((s) => !state.players[s].eliminated);
    const index = state.seating.indexOf(id);
    state.speaker =
      state.seating
        .slice(index + 1)
        .concat(state.seating.slice(0, index))
        .find((s) => seats.includes(s)) ?? state.speaker;
  }
  log(state, `${player.name} has been eliminated.`, { player: id });
}

export const shipsPresent = (state: GameState, key: SystemKey, id: PlayerId) =>
  hasShips(systemOf(state, key).space[id]);
