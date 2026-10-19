/**
 * Leaders (Prophecy of Kings): who may use which agent, commander and hero,
 * spending them, and unlocking commanders when their conditions are met.
 */
import { PlayerId } from "~/types";
import { leadersById } from "../data";
import { GameState, LeaderState } from "../types";
import {
  anomaliesOf,
  controlledPlanets,
  isHomeSystem,
  MECATOL_REX,
  neighborsOf,
  nonFighterShips,
  planetInfluence,
  planetResources,
  systemsWithUnits,
  wormholesOf,
  adjacentSystems,
} from "./board";
import {
  countOf,
  ensure,
  hasGroundForces,
  log,
  playerName,
  totalUnits,
  unitOf,
  unitsOnBoard,
} from "./helpers";
import { openWindow } from "./reactions";

export const leaderName = (id: string) => leadersById[id]?.name ?? id;

/** The player who owns a leader card, if it is in the game. */
export function leaderOwner(state: GameState, leader: string): PlayerId | undefined {
  return state.seating.find((id) =>
    state.players[id].leaders.some((l) => l.id === leader),
  );
}

export function leaderOf(
  state: GameState,
  id: PlayerId,
  leader: string,
): LeaderState | undefined {
  return state.players[id]?.leaders.find((l) => l.id === leader);
}

const isUnlocked = (leader: LeaderState | undefined) =>
  !!leader && leader.status !== "locked" && leader.status !== "purged";

/**
 * Players whose unlocked commander this player may use: their own, those
 * whose Alliance note is in their play area, and, for the Mahact, those whose
 * command tokens are in their fleet pool (Imperia).
 */
export function commanderSources(state: GameState, id: PlayerId): PlayerId[] {
  const player = state.players[id];
  const sources = new Set<PlayerId>([id]);
  for (const note of player.promissoryNotesInPlay) {
    if (note.id === "an" && note.owner !== id) sources.add(note.owner);
  }
  if (player.faction === "mahact") {
    for (const other of player.edictTokens ?? []) sources.add(other);
  }
  return [...sources].filter((source) => !state.players[source].eliminated);
}

/** Commanders a player may use, by leader id. */
export function commandersFor(state: GameState, id: PlayerId): string[] {
  return commanderSources(state, id).flatMap((source) =>
    state.players[source].leaders
      .filter((l) => l.type === "commander" && isUnlocked(l))
      .map((l) => l.id),
  );
}

/** Whether a player can use a commander's ability right now. */
export const hasCommander = (state: GameState, id: PlayerId, commander: string) =>
  commandersFor(state, id).includes(commander);

/** Agents of other players the Yssaril can copy with Ssruu. */
function ssruuAgents(state: GameState, id: PlayerId): string[] {
  const ssruu = leaderOf(state, id, "yssarilagent");
  if (ssruu?.status !== "ready") return [];
  return state.seating
    .filter((other) => other !== id)
    .flatMap((other) =>
      state.players[other].leaders.filter((l) => l.type === "agent").map((l) => l.id),
    );
}

/** Leaders whose abilities a player may use, by leader id. */
export function usableLeaders(state: GameState, id: PlayerId): string[] {
  const own = state.players[id].leaders
    .filter((l) => l.type !== "commander" && l.status === "ready")
    .map((l) => l.id);
  return [...new Set([...own, ...commandersFor(state, id), ...ssruuAgents(state, id)])];
}

/**
 * Pays for using a leader: agents are exhausted (Ssruu in place of a copied
 * agent) and heroes purged. Commanders cost nothing.
 */
export function spendLeader(state: GameState, id: PlayerId, leader: string) {
  const data = leadersById[leader];
  if (!data || data.type === "commander") return;
  const own = leaderOf(state, id, leader);
  if (data.type === "hero") {
    ensure(own?.status === "ready", `${data.name} cannot be used.`);
    own.status = "purged";
    log(state, `${playerName(state, id)} purged ${data.name}.`, { player: id });
    return;
  }
  const card = own ?? leaderOf(state, id, "yssarilagent");
  ensure(card?.status === "ready", `${data.name} is exhausted.`);
  card.status = "exhausted";
  // Temporal Command Suite
  openWindow(state, "afterAgentExhausted", { player: id, card: card.id });
}

/** Readies an exhausted agent, paying out what Artuno holds. */
export function readyLeader(state: GameState, owner: PlayerId, leader: string) {
  const card = leaderOf(state, owner, leader);
  if (!card || card.status !== "exhausted") return;
  card.status = "ready";
  if (card.tradeGoods) {
    state.players[owner].tradeGoods += card.tradeGoods;
    log(state, `${playerName(state, owner)} gained ${card.tradeGoods} trade goods from ${leaderName(leader)}.`, {
      player: owner,
    });
    card.tradeGoods = 0;
  }
}

export function unlockCommander(state: GameState, id: PlayerId) {
  const commander = state.players[id]?.leaders.find((l) => l.type === "commander");
  if (!commander || commander.status !== "locked") return;
  commander.status = "ready";
  log(state, `${playerName(state, id)} unlocked their commander, ${leaderName(commander.id)}.`, {
    player: id,
  });
}

const groundForcesOnOwnPlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id).reduce(
    (sum, p) => sum + countOf(p.units[id], "infantry") + countOf(p.units[id], "mech"),
    0,
  );

function unitsWithAbilities(state: GameState, id: PlayerId) {
  let total = 0;
  const count = (group: Parameters<typeof totalUnits>[0]) =>
    totalUnits(group, (type) => {
      const unit = unitOf(state, id, type);
      return (
        unit?.afb !== undefined ||
        unit?.spaceCannon !== undefined ||
        unit?.bombardment !== undefined
      );
    });
  for (const system of Object.values(state.systems)) total += count(system.space[id]);
  for (const planet of Object.values(state.planets)) total += count(planet.units[id]);
  return total;
}

const mechSystems = (state: GameState, id: PlayerId) =>
  Object.values(state.systems).filter(
    (s) =>
      countOf(s.space[id], "mech") > 0 ||
      s.planets.some((p) => countOf(state.planets[p].units[id], "mech") > 0),
  ).length;

/** Commander unlock conditions that depend only on the board, by faction. */
const UNLOCKS: Record<string, (state: GameState, id: PlayerId) => boolean> = {
  arborec: (s, id) => groundForcesOnOwnPlanets(s, id) >= 12,
  argent: (s, id) => unitsWithAbilities(s, id) >= 6,
  vulraith: (s, id) =>
    systemsWithUnits(s, id).filter((sys) => anomaliesOf(sys).includes("GRAVITY_RIFT"))
      .length >= 3,
  creuss: (s, id) =>
    systemsWithUnits(s, id).filter((sys) =>
      wormholesOf(sys).some((w) => w === "ALPHA" || w === "BETA"),
    ).length >= 3,
  empyrean: (s, id) =>
    s.seating.every(
      (other) =>
        other === id || s.players[other].eliminated || neighborsOf(s, id).includes(other),
    ),
  hacan: (s, id) => s.players[id].tradeGoods >= 10,
  jolnar: (s, id) => s.players[id].technologies.length >= 8,
  l1z1x: (s, id) => unitsOnBoard(s, id, "dreadnought") >= 4,
  barony: (s, id) =>
    Object.keys(s.systems).some((key) => nonFighterShips(s, Number(key), id) >= 5),
  mahact: (s, id) => new Set(s.players[id].edictTokens ?? []).size >= 2,
  mentak: (s, id) => unitsOnBoard(s, id, "cruiser") >= 4,
  naalu: (s, id) => {
    const mecatol = s.planets[MECATOL_REX]?.system;
    if (mecatol === undefined) return false;
    return [mecatol, ...adjacentSystems(s, mecatol)].some((key) => {
      const system = s.systems[key];
      return (
        hasGroundForces(system.space[id]) ||
        system.planets.some((p) => hasGroundForces(s.planets[p].units[id]))
      );
    });
  },
  naazrokha: (s, id) => mechSystems(s, id) >= 3,
  nekro: (s, id) =>
    s.players[id].technologies.filter((t) => t !== "vax" && t !== "vay").length >= 3,
  nomad: (s, id) => s.players[id].scoredSecrets.length >= 1,
  saar: (s, id) => unitsOnBoard(s, id, "spacedock") >= 3,
  sardakk: (s, id) =>
    controlledPlanets(s, id).filter((p) => !isHomeSystem(s.systems[p.system])).length >= 5,
  sol: (s, id) =>
    controlledPlanets(s, id).reduce((sum, p) => sum + planetResources(s, p.name), 0) >= 12,
  titans: (s, id) => unitsOnBoard(s, id, "pds") + unitsOnBoard(s, id, "spacedock") >= 5,
  winnu: (s, id) => s.planets[MECATOL_REX]?.controller === id,
  xxcha: (s, id) =>
    controlledPlanets(s, id).reduce((sum, p) => sum + planetInfluence(s, p.name), 0) >= 12,
  yssaril: (s, id) => s.players[id].actionCards.length >= 7,
  bastion: (s, id) => {
    let galvanized = 0;
    for (const forces of [...Object.values(s.systems).map((x) => x.space), ...Object.values(s.planets).map((p) => p.units)]) {
      for (const stack of Object.values(forces[id] ?? {})) galvanized += stack.galvanized ?? 0;
    }
    return galvanized >= 3;
  },
};

/** Unlocks every commander whose condition is now met. */
export function checkCommanderUnlocks(state: GameState) {
  if (!state.options.expansions.includes("pok")) return;
  for (const id of state.seating) {
    const player = state.players[id];
    if (player.eliminated) continue;
    const commander = player.leaders.find((l) => l.type === "commander");
    if (commander?.status !== "locked") continue;
    if (UNLOCKS[player.faction]?.(state, id)) unlockCommander(state, id);
  }
}
