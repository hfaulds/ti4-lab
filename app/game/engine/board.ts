import { systemData } from "~/data/systemData";
import {
  Anomaly,
  Map as TiMap,
  Planet,
  PlayerId,
  System,
  TechSpecialty,
  Wormhole,
} from "~/types";
import { buildHexGraph, getPositionsWithinDistance } from "~/utils/hexDistance";
import { attachmentsById, isShip } from "../data";
import {
  GameError,
  GameState,
  PlanetState,
  SystemKey,
  SystemState,
} from "../types";
import {
  countOf,
  hasShips,
  hasTech,
  playersWith,
  totalUnits,
  unitOf,
  unitTypes,
} from "./helpers";

export const MECATOL_REX = "Mecatol Rex";
export const CREUSS_GATE_ID = "17";
export const WORMHOLE_NEXUS_ID = "82";
export const MALLICE = "Mallice";
export const OFF_BOARD = 1000;

/** Systems the draft tool has no tile for but the game needs. */
const EXTRA_SYSTEMS: Record<string, System> = {
  [CREUSS_GATE_ID]: {
    id: CREUSS_GATE_ID,
    planets: [],
    type: "GREEN",
    anomalies: [],
    wormholes: ["DELTA"],
    totalSpend: { resources: 0, influence: 0 },
    optimalSpend: { resources: 0, influence: 0, flex: 0 },
  },
};

export const systemInfo = (systemId: string): System | undefined =>
  systemData[systemId] ?? EXTRA_SYSTEMS[systemId];

export const infoOf = (system: SystemState) => systemInfo(system.systemId);

export function systemOf(state: GameState, key: SystemKey): SystemState {
  const system = state.systems[key];
  if (!system) throw new GameError("That system is not on the board.");
  return system;
}

export function planetOf(state: GameState, name: string): PlanetState {
  const planet = state.planets[name];
  if (!planet) throw new GameError(`Unknown planet ${name}.`);
  return planet;
}

export function planetInfo(state: GameState, name: string): Planet | undefined {
  const planet = state.planets[name];
  if (!planet) return undefined;
  return infoOf(state.systems[planet.system])?.planets.find(
    (p) => p.name === name,
  );
}

const attachmentsOf = (planet: PlanetState) =>
  planet.attachments.map((id) => attachmentsById[id]).filter(Boolean);

export function planetResources(state: GameState, name: string) {
  const base = planetInfo(state, name)?.resources ?? 0;
  return attachmentsOf(state.planets[name]).reduce(
    (sum, a) => sum + a.resources,
    base,
  );
}

export function planetInfluence(state: GameState, name: string) {
  const base = planetInfo(state, name)?.influence ?? 0;
  return attachmentsOf(state.planets[name]).reduce(
    (sum, a) => sum + a.influence,
    base,
  );
}

export function planetTechSpecialties(
  state: GameState,
  name: string,
): TechSpecialty[] {
  return [
    ...(planetInfo(state, name)?.tech ?? []),
    ...attachmentsOf(state.planets[name]).flatMap((a) => a.techSpecialty),
  ];
}

export const planetTraits = (state: GameState, name: string) =>
  planetInfo(state, name)?.trait ?? [];

export const isLegendary = (state: GameState, name: string) =>
  !!planetInfo(state, name)?.legendary ||
  attachmentsOf(state.planets[name]).some((a) => a.legendary);

export const isHomeSystem = (system: SystemState) =>
  system.homeOf !== undefined;

export const controlledPlanets = (state: GameState, player: PlayerId) =>
  Object.values(state.planets).filter((p) => p.controller === player);

export const anomaliesOf = (system: SystemState): Anomaly[] =>
  infoOf(system)?.anomalies ?? [];

export const hasAnomaly = (system: SystemState, anomaly: Anomaly) =>
  anomaliesOf(system).includes(anomaly);

export function wormholesOf(system: SystemState): Wormhole[] {
  const printed = (infoOf(system)?.wormholes ?? []).filter(
    (w) => !system.inactiveWormholes.includes(w),
  );
  return [...new Set([...printed, ...system.addedWormholes])];
}

// --- Adjacency ------------------------------------------------------------

const physicalCache = new Map<string, Map<number, number[]>>();

/** Tiles that touch, or are joined by hyperlanes. */
function physicalNeighbors(map: TiMap): Map<number, number[]> {
  const cacheKey = map
    .map((t) => (t.type === "SYSTEM" ? `${t.systemId}@${t.rotation ?? 0}` : "-"))
    .join(",");
  const cached = physicalCache.get(cacheKey);
  if (cached) return cached;

  const graph = buildHexGraph(map);
  const isSystem = (idx: number) => {
    const tile = map[idx];
    return (
      tile?.type === "SYSTEM" && systemInfo(tile.systemId)?.type !== "HYPERLANE"
    );
  };
  const neighbors = new Map<number, number[]>();
  map.forEach((_, idx) => {
    if (!isSystem(idx)) return;
    const reachable = getPositionsWithinDistance(graph, idx, 1);
    neighbors.set(
      idx,
      [...reachable.keys()].filter((other) => other !== idx && isSystem(other)),
    );
  });

  if (physicalCache.size > 50) physicalCache.clear();
  physicalCache.set(cacheKey, neighbors);
  return neighbors;
}

export function adjacentSystems(state: GameState, key: SystemKey): SystemKey[] {
  const system = state.systems[key];
  if (!system) return [];
  const adjacent = new Set<SystemKey>(
    system.onBoard ? (physicalNeighbors(state.map).get(key) ?? []) : [],
  );
  const wormholes = wormholesOf(system);
  if (wormholes.length > 0) {
    for (const other of Object.values(state.systems)) {
      if (other.key === key) continue;
      if (wormholesOf(other).some((w) => wormholes.includes(w))) {
        adjacent.add(other.key);
      }
    }
  }
  return [...adjacent].filter((k) => state.systems[k]);
}

export const areAdjacent = (state: GameState, a: SystemKey, b: SystemKey) =>
  adjacentSystems(state, a).includes(b);

/** A tile with at least one side not touching another tile (LRR 39.2). */
export function isOnEdge(state: GameState, key: SystemKey) {
  const system = state.systems[key];
  if (!system) return false;
  if (!system.onBoard) return true;
  const position = state.map[key]?.position;
  if (!position) return false;
  const offsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
  ];
  return offsets.some(([dx, dy]) => {
    const tile = state.map.find(
      (t) => t.position.x === position.x + dx && t.position.y === position.y + dy,
    );
    return !tile || tile.type !== "SYSTEM";
  });
}

export function systemsWithUnits(state: GameState, player: PlayerId) {
  return Object.values(state.systems).filter(
    (system) =>
      totalUnits(system.space[player]) > 0 ||
      system.planets.some((p) => totalUnits(state.planets[p].units[player]) > 0),
  );
}

export const systemsWithShips = (state: GameState, player: PlayerId) =>
  Object.values(state.systems).filter((s) => hasShips(s.space[player]));

/** Systems where a player has a unit or controls a planet (for neighbors). */
function presence(state: GameState, player: PlayerId): SystemKey[] {
  return Object.values(state.systems)
    .filter(
      (system) =>
        totalUnits(system.space[player]) > 0 ||
        system.planets.some((p) => {
          const planet = state.planets[p];
          return (
            planet.controller === player || totalUnits(planet.units[player]) > 0
          );
        }),
    )
    .map((s) => s.key);
}

export function areNeighbors(state: GameState, a: PlayerId, b: PlayerId) {
  if (a === b) return false;
  const theirs = new Set(presence(state, b));
  return presence(state, a).some(
    (key) =>
      theirs.has(key) || adjacentSystems(state, key).some((k) => theirs.has(k)),
  );
}

export const neighborsOf = (state: GameState, player: PlayerId) =>
  state.seating.filter(
    (other) =>
      !state.players[other].eliminated && areNeighbors(state, player, other),
  );

// --- Fleets ---------------------------------------------------------------

export const otherShipOwners = (system: SystemState, player: PlayerId) =>
  playersWith(system.space, hasShips).filter((id) => id !== player);

export function capacityIn(state: GameState, key: SystemKey, player: PlayerId) {
  const system = systemOf(state, key);
  let capacity = 0;
  for (const type of unitTypes(system.space[player])) {
    capacity +=
      (unitOf(state, player, type)?.capacity ?? 0) *
      countOf(system.space[player], type);
  }
  return capacity;
}

/** Fighters that space docks in the system hold without using capacity. */
export function dockFighterAllowance(
  state: GameState,
  key: SystemKey,
  player: PlayerId,
) {
  const system = systemOf(state, key);
  const docks =
    system.planets.reduce(
      (sum, p) => sum + countOf(state.planets[p].units[player], "spacedock"),
      0,
    ) + countOf(system.space[player], "spacedock");
  return docks * 3;
}

export function nonFighterShips(
  state: GameState,
  key: SystemKey,
  player: PlayerId,
) {
  const group = systemOf(state, key).space[player];
  return totalUnits(group, (type) => isShip(type) && type !== "fighter");
}

/**
 * Describes why a player's units in a system break fleet supply or capacity,
 * or returns undefined when the fleet is legal.
 */
export function fleetProblem(
  state: GameState,
  key: SystemKey,
  player: PlayerId,
): string | undefined {
  const system = systemOf(state, key);
  const group = system.space[player];
  const fighters = countOf(group, "fighter");
  const groundForces = countOf(group, "infantry") + countOf(group, "mech");
  const capacity = capacityIn(state, key, player);
  const uncounted = Math.min(fighters, dockFighterAllowance(state, key, player));
  let excess = Math.max(0, fighters - uncounted + groundForces - capacity);

  // Upgraded fighters may fly without a carrier, counting against the fleet
  // pool instead (LRR Fighter II).
  let fleet = nonFighterShips(state, key, player);
  if (excess > 0 && unitOf(state, player, "fighter")?.move) {
    const freeFighters = Math.min(excess, fighters - uncounted);
    fleet += freeFighters;
    excess -= freeFighters;
  }
  if (excess > 0) {
    return `That leaves ${excess} more fighters and ground forces than your ships can carry.`;
  }
  const limit = state.players[player].pools.fleet;
  if (fleet > limit) {
    return `That is ${fleet} ships in one system, but your fleet pool supports ${limit}.`;
  }
  return undefined;
}

// --- Movement -------------------------------------------------------------

export type MoveRules = {
  player: PlayerId;
  destination: SystemKey;
  /** Ships may pass through other players' fleets (Light/Wave Deflector). */
  ignoreBlockades: boolean;
  /** Ships may enter asteroid fields (Antimass Deflectors). */
  enterAsteroids: boolean;
};

export function moveRulesFor(
  state: GameState,
  player: PlayerId,
  destination: SystemKey,
): MoveRules {
  return {
    player,
    destination,
    ignoreBlockades: hasTech(state, player, "lwd"),
    enterAsteroids: hasTech(state, player, "amd"),
  };
}

function canEnter(state: GameState, key: SystemKey, rules: MoveRules) {
  const system = state.systems[key];
  if (!system) return false;
  if (hasAnomaly(system, "SUPERNOVA")) return false;
  if (hasAnomaly(system, "ASTEROID_FIELD") && !rules.enterAsteroids) {
    return false;
  }
  // A nebula can only be entered as the active system.
  if (hasAnomaly(system, "NEBULA") && key !== rules.destination) return false;
  return true;
}

function canLeave(state: GameState, key: SystemKey, rules: MoveRules) {
  if (key === rules.destination) return true;
  const system = state.systems[key];
  return rules.ignoreBlockades || otherShipOwners(system, rules.player).length === 0;
}

export type Route = { path: SystemKey[]; rifts: number };

/** Number of gravity rifts a path moves out of or through. */
export const riftsExited = (state: GameState, path: SystemKey[]) =>
  path
    .slice(0, -1)
    .filter((key) => hasAnomaly(state.systems[key], "GRAVITY_RIFT")).length;

/**
 * Checks a path a ship intends to fly. `path` starts at the origin and ends
 * in the active system.
 */
export function routeProblem(
  state: GameState,
  path: SystemKey[],
  move: number,
  rules: MoveRules,
): string | undefined {
  if (path.length < 2) return "A route needs an origin and a destination.";
  if (path[path.length - 1] !== rules.destination) {
    return "Ships must end their movement in the active system.";
  }
  const origin = state.systems[path[0]];
  let allowance = hasAnomaly(origin, "NEBULA") ? 1 : move;
  allowance += riftsExited(state, path);
  if (path.length - 1 > allowance) return "That ship cannot move that far.";

  for (let i = 1; i < path.length; i++) {
    if (!areAdjacent(state, path[i - 1], path[i])) {
      return "That route passes between systems that are not adjacent.";
    }
    if (!canEnter(state, path[i], rules)) {
      return "That route enters a system ships cannot move into.";
    }
    const isLast = i === path.length - 1;
    if (!isLast && !canLeave(state, path[i], rules)) {
      return "That route passes through another player's ships.";
    }
  }
  return undefined;
}

/**
 * Finds the best route to the active system for a ship with the given move
 * value, preferring routes that avoid gravity rifts and then shorter ones.
 */
export function findRoute(
  state: GameState,
  from: SystemKey,
  move: number,
  rules: MoveRules,
): Route | undefined {
  const origin = state.systems[from];
  if (!origin) return undefined;
  const baseMove = hasAnomaly(origin, "NEBULA") ? 1 : move;
  const maxRifts = 3;

  type Node = { key: SystemKey; path: SystemKey[]; rifts: number };
  let best: Route | undefined;
  const seen = new Map<string, number>();
  let frontier: Node[] = [{ key: from, path: [from], rifts: 0 }];

  while (frontier.length > 0) {
    const next: Node[] = [];
    for (const node of frontier) {
      const steps = node.path.length - 1;
      if (node.key === rules.destination && steps > 0) {
        if (
          !best ||
          node.rifts < best.rifts ||
          (node.rifts === best.rifts && node.path.length < best.path.length)
        ) {
          best = { path: node.path, rifts: node.rifts };
        }
      }
      if (steps > 0 && !canLeave(state, node.key, rules)) continue;

      const rifts =
        node.rifts +
        (hasAnomaly(state.systems[node.key], "GRAVITY_RIFT") ? 1 : 0);
      if (rifts > maxRifts) continue;
      if (steps + 1 > baseMove + rifts) continue;

      for (const neighbor of adjacentSystems(state, node.key)) {
        if (!canEnter(state, neighbor, rules)) continue;
        const stateKey = `${neighbor}:${rifts}`;
        const previous = seen.get(stateKey);
        if (previous !== undefined && previous <= steps + 1) continue;
        seen.set(stateKey, steps + 1);
        next.push({ key: neighbor, path: [...node.path, neighbor], rifts });
      }
    }
    frontier = next;
  }
  return best;
}

/** Systems a retreating fleet may withdraw to (LRR 78.7). */
export function retreatOptions(
  state: GameState,
  key: SystemKey,
  player: PlayerId,
): SystemKey[] {
  return adjacentSystems(state, key).filter((other) => {
    const system = state.systems[other];
    if (otherShipOwners(system, player).length > 0) return false;
    if (hasAnomaly(system, "SUPERNOVA")) return false;
    if (hasAnomaly(system, "ASTEROID_FIELD") && !hasTech(state, player, "amd")) {
      return false;
    }
    const hasUnits =
      totalUnits(system.space[player]) > 0 ||
      system.planets.some((p) => totalUnits(state.planets[p].units[player]) > 0);
    const hasPlanet = system.planets.some(
      (p) => state.planets[p].controller === player,
    );
    return hasUnits || hasPlanet;
  });
}
