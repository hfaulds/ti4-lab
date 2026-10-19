import { systemData } from "~/data/systemData";
import {
  Anomaly,
  Map as TiMap,
  Planet,
  PlanetTrait,
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
  UnitGroup,
  UnitType,
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

export const MIRAGE = "Mirage";

/** Planets that arrive during play rather than printed on a tile. */
const EXTRA_PLANETS: Record<string, Planet> = {
  [MIRAGE]: {
    name: MIRAGE,
    resources: 1,
    influence: 2,
    legendary: true,
    legendaryTitle: "Mirage Flight Academy",
    legendaryDescription:
      "You may exhaust this card at the end of your turn to place up to 2 fighters from your reinforcements in any system that contains 1 or more of your ships.",
    trait: ["CULTURAL"],
  },
};

export function planetInfo(state: GameState, name: string): Planet | undefined {
  const planet = state.planets[name];
  if (!planet) return undefined;
  return (
    infoOf(state.systems[planet.system])?.planets.find((p) => p.name === name) ??
    EXTRA_PLANETS[name]
  );
}

const attachmentsOf = (planet: PlanetState) =>
  planet.attachments.map((id) => attachmentsById[id]).filter(Boolean);

/** Laws attached to planets that change their values. */
const LAW_ATTACHMENTS: Record<string, { resources: number; influence: number }> = {
  core_mining: { resources: 2, influence: 0 },
  senate_sanctuary: { resources: 0, influence: 2 },
  terraforming_initiative: { resources: 1, influence: 1 },
};

const lawBonus = (planet: PlanetState, key: "resources" | "influence") =>
  planet.attachments.reduce((sum, a) => sum + (LAW_ATTACHMENTS[a]?.[key] ?? 0), 0);

/** 4X41C "Helios": +1 resource on its planet, or +2 once upgraded. */
function heliosBonus(state: GameState, name: string) {
  const planet = state.planets[name];
  for (const owner of Object.keys(planet?.units ?? {}).map(Number)) {
    if (countOf(planet.units[owner], "spacedock") === 0) continue;
    const dock = unitOf(state, owner, "spacedock")?.id;
    if (dock === "bastion_spacedock2") return 2;
    if (dock === "bastion_spacedock") return 1;
  }
  return 0;
}

export function planetResources(state: GameState, name: string) {
  const base = (planetInfo(state, name)?.resources ?? 0) + heliosBonus(state, name);
  return attachmentsOf(state.planets[name]).reduce(
    (sum, a) => sum + a.resources,
    base + lawBonus(state.planets[name], "resources"),
  );
}

export function planetInfluence(state: GameState, name: string) {
  const base = planetInfo(state, name)?.influence ?? 0;
  return attachmentsOf(state.planets[name]).reduce(
    (sum, a) => sum + a.influence,
    base + lawBonus(state.planets[name], "influence"),
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

/** Attachments that give a planet every trait (Terraform). */
const ALL_TRAITS = ["titanspn"];

export const planetTraits = (state: GameState, name: string): PlanetTrait[] =>
  state.planets[name]?.attachments.some((a) => ALL_TRAITS.includes(a))
    ? ["CULTURAL", "HAZARDOUS", "INDUSTRIAL"]
    : (planetInfo(state, name)?.trait ?? []);

export const isLegendary = (state: GameState, name: string) =>
  !!planetInfo(state, name)?.legendary ||
  attachmentsOf(state.planets[name]).some((a) => a.legendary);

export const isHomeSystem = (system: SystemState) =>
  system.homeOf !== undefined;

/** The Demilitarized Zone law or exploration card is attached. */
export const isDemilitarized = (planet: PlanetState) =>
  planet.attachments.includes("demilitarized_zone") || planet.attachments.includes("dmz");

export const controlledPlanets = (state: GameState, player: PlayerId) =>
  Object.values(state.planets).filter((p) => p.controller === player);

export const anomaliesOf = (system: SystemState): Anomaly[] =>
  infoOf(system)?.anomalies ?? [];

export const hasAnomaly = (system: SystemState, anomaly: Anomaly) =>
  anomaliesOf(system).includes(anomaly);

/** Owners of a Vuil'raith dimensional tear (space dock) in a system. */
export function tearOwners(state: GameState, system: SystemState): PlayerId[] {
  return state.seating.filter(
    (id) =>
      state.players[id].faction === "vulraith" &&
      (countOf(system.space[id], "spacedock") > 0 ||
        system.planets.some((p) => countOf(state.planets[p]?.units[id], "spacedock") > 0)),
  );
}

/** A gravity rift, printed or made by a dimensional tear. */
export const isGravityRift = (state: GameState, system: SystemState) =>
  hasAnomaly(system, "GRAVITY_RIFT") || tearOwners(state, system).length > 0;

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

/** Systems whose tiles touch or are joined by a hyperlane. */
export const physicallyAdjacent = (state: GameState, a: SystemKey, b: SystemKey) =>
  !!state.systems[a]?.onBoard && !!physicalNeighbors(state.map).get(a)?.includes(b);

const lawInForce = (state: GameState, law: string) =>
  state.laws.some((l) => l.id === law && l.outcome !== "Against");

/**
 * Wormholes in a system, including the delta wormhole the Creuss flagship
 * carries and the alpha and beta wormholes Lazax Gate Folding lends Mecatol
 * Rex during the Winnu's tactical actions.
 */
export function wormholesIn(
  state: GameState,
  system: SystemState,
  mover?: PlayerId,
): Wormhole[] {
  const wormholes = wormholesOf(system);
  const extra: Wormhole[] = [];
  for (const owner of Object.keys(system.space).map(Number)) {
    if (
      countOf(system.space[owner], "flagship") > 0 &&
      unitOf(state, owner, "flagship")?.id === "ghost_flagship"
    ) {
      extra.push("DELTA");
    }
  }
  if (
    mover !== undefined &&
    state.tactical?.player === mover &&
    system.planets.includes(MECATOL_REX) &&
    state.planets[MECATOL_REX]?.controller !== mover &&
    hasTech(state, mover, "lgf")
  ) {
    extra.push("ALPHA", "BETA");
  }
  return extra.length > 0 ? [...new Set([...wormholes, ...extra])] : wormholes;
}

const ALPHA_BETA: Wormhole[] = ["ALPHA", "BETA"];

/**
 * Systems adjacent to `key`. With `mover`, also the adjacency that only a
 * moving player enjoys: Quantum Entanglement, Lost Star Chart, Spatial
 * Conduit Cylinder, and the Enforced Travel Ban law cutting alpha and beta
 * wormholes during movement.
 */
export function adjacentSystems(
  state: GameState,
  key: SystemKey,
  mover?: PlayerId,
): SystemKey[] {
  const system = state.systems[key];
  if (!system) return [];
  const adjacent = new Set<SystemKey>(
    system.onBoard ? (physicalNeighbors(state.map).get(key) ?? []) : [],
  );
  const flag = (name: string) =>
    mover !== undefined && !!state.tactical?.flags?.includes(`${name}:${mover}`);
  const entangled =
    mover !== undefined &&
    factionOf(state, mover) === "creuss";
  const travelBan = mover !== undefined && lawInForce(state, "travel_ban");
  const linked =
    lawInForce(state, "wormhole_recon") || entangled || flag("lostStar");

  const sovereignty = mover !== undefined && lawInForce(state, "nexus");
  const sundered = mover !== undefined && state.players[mover]?.faction === "crimson";
  const usable = (wormholes: Wormhole[], of: SystemState) => {
    if (mover !== undefined && state.severed?.includes(of.key)) return [];
    if (sundered) return wormholes.filter((w) => w === "EPSILON");
    return (travelBan && !entangled) || (sovereignty && of.systemId === WORMHOLE_NEXUS_ID)
      ? wormholes.filter((w) => !ALPHA_BETA.includes(w))
      : wormholes;
  };
  const wormholes = usable(wormholesIn(state, system, mover), system);
  if (wormholes.length > 0) {
    const alphaOrBeta = linked && wormholes.some((w) => ALPHA_BETA.includes(w));
    for (const other of Object.values(state.systems)) {
      if (other.key === key) continue;
      const theirs = usable(wormholesIn(state, other, mover), other);
      if (
        theirs.some((w) => wormholes.includes(w)) ||
        (alphaOrBeta && theirs.some((w) => ALPHA_BETA.includes(w)))
      ) {
        adjacent.add(other.key);
      }
    }
  }
  // Emissary Taivra joins the active system to every system with a wormhole.
  if (mover !== undefined && flag("taivra") && state.tactical) {
    const active = state.tactical.system;
    if (key === active) {
      for (const other of Object.values(state.systems)) {
        if (other.key !== key && wormholesIn(state, other, mover).length > 0) adjacent.add(other.key);
      }
    } else if (wormholesIn(state, system, mover).length > 0) {
      adjacent.add(active);
    }
  }
  // Spatial Conduit Cylinder joins the active system to every system with
  // the player's units.
  if (mover !== undefined && flag("scc") && state.tactical) {
    const active = state.tactical.system;
    const hasUnits = (k: SystemKey) =>
      totalUnits(state.systems[k].space[mover]) > 0 ||
      state.systems[k].planets.some(
        (p) => totalUnits(state.planets[p].units[mover]) > 0,
      );
    if (key === active) {
      for (const other of Object.values(state.systems)) {
        if (other.key !== key && hasUnits(other.key)) adjacent.add(other.key);
      }
    } else if (hasUnits(key)) {
      adjacent.add(active);
    }
  }
  return [...adjacent].filter((k) => state.systems[k]);
}

const factionOf = (state: GameState, id: PlayerId) => state.players[id]?.faction;

export const areAdjacent = (
  state: GameState,
  a: SystemKey,
  b: SystemKey,
  mover?: PlayerId,
) => adjacentSystems(state, a, mover).includes(b);

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
  // Dimensional tears hold 6 fighters, or 12 once upgraded.
  const dock = unitOf(state, player, "spacedock")?.id;
  const perDock = dock === "cabal_spacedock2" ? 12 : dock === "cabal_spacedock" ? 6 : 3;
  return docks * perDock;
}

/** Aerie Sentinels ride for free with ships that have capacity. */
export const freeRiders = (state: GameState, player: PlayerId, group: UnitGroup | undefined) =>
  unitOf(state, player, "mech")?.id === "argent_mech" &&
  !state.laws.some((law) => law.id === "articles_war" && law.outcome !== "Against")
    ? countOf(group, "mech")
    : 0;

export function nonFighterShips(
  state: GameState,
  key: SystemKey,
  player: PlayerId,
) {
  const group = systemOf(state, key).space[player];
  return totalUnits(group, (type) => isShip(type) && type !== "fighter");
}

/** Non-fighter ships a player may have in one system (Armada adds 2). */
export const fleetLimit = (state: GameState, player: PlayerId) =>
  state.players[player].used?.includes("darktalon")
    ? Infinity
    : state.players[player].pools.fleet +
      (state.players[player].edictTokens?.length ?? 0) +
      (state.players[player].faction === "barony" ? 2 : 0);

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
  const capacity = capacityIn(state, key, player);
  const groundForces =
    countOf(group, "infantry") +
    countOf(group, "mech") -
    (capacity > 0 ? freeRiders(state, player, group) : 0);
  const uncounted = Math.min(fighters, dockFighterAllowance(state, key, player));
  let excess = Math.max(0, fighters - uncounted + groundForces - capacity);

  // Upgraded fighters may fly without a carrier, counting against the fleet
  // pool instead (LRR Fighter II).
  let fleet = nonFighterShips(state, key, player);
  const fighter = unitOf(state, player, "fighter");
  if (excess > 0 && fighter?.move) {
    const freeFighters = Math.min(excess, fighters - uncounted);
    // Hybrid Crystal Fighter II counts as half a ship.
    fleet +=
      fighter.id === "naalu_fighter2" ? Math.ceil(freeFighters / 2) : freeFighters;
    excess -= freeFighters;
  }
  if (excess > 0) {
    return `That leaves ${excess} more fighters and ground forces than your ships can carry.`;
  }
  const limit = fleetLimit(state, player);
  if (fleet > limit) {
    return `That is ${fleet} ships in one system, but your fleet pool supports ${limit}.`;
  }
  return undefined;
}

// --- Movement -------------------------------------------------------------

export type MoveRules = {
  player: PlayerId;
  destination: SystemKey;
  /** Nebulae do not slow or stop these ships (Voidborn, Nav Suite). */
  ignoreNebulae?: boolean;
  /** Gravity rifts neither help nor roll for these ships (Nav Suite). */
  ignoreRifts?: boolean;
  /** Ships of these players do not block movement (Aetherpassage). */
  passThrough?: PlayerId[];
  /** Systems the moving ships count as adjacent to (Memoria and the Nomad's mechs). */
  extraAdjacent?: SystemKey[];
  /** Ships may pass through other players' fleets (Light/Wave Deflector). */
  ignoreBlockades: boolean;
  /** Ships may enter asteroid fields (Antimass Deflectors). */
  enterAsteroids: boolean;
  /** Ships may move through and into supernovas (Gashlai Physiology, Magmus Reactor). */
  enterSupernovas?: boolean;
  /** Ships may move through nebulae (Shared Research). */
  throughNebulae?: boolean;
};

/**
 * How a player's ships may move this tactical action. `ships` and `origin`
 * narrow it to one group: the Yssaril flagship and In the Silence of Space
 * let only some ships pass through other fleets.
 */
export function moveRulesFor(
  state: GameState,
  player: PlayerId,
  destination: SystemKey,
  group: { origin?: SystemKey; ships?: UnitType[] } = {},
): MoveRules {
  const silenced =
    group.origin !== undefined &&
    !!state.tactical?.flags?.includes(`silence@${group.origin}:${player}`);
  const flagshipOnly = (unitId: string) =>
    !!group.ships?.length &&
    group.ships.every(
      (type) => type === "flagship" && unitOf(state, player, type)?.id.startsWith(unitId),
    );
  const flagged = (flag: string) => !!state.tactical?.flags?.includes(`${flag}:${player}`);
  const navSuite = flagged("navsuite");
  // Memoria counts as adjacent to every system with the Nomad's mechs.
  const mechSystems = flagshipOnly("nomad_flagship")
    ? Object.values(state.systems)
        .filter(
          (s) =>
            countOf(s.space[player], "mech") > 0 ||
            s.planets.some((p) => countOf(state.planets[p].units[player], "mech") > 0),
        )
        .map((s) => s.key)
    : undefined;
  return {
    player,
    destination,
    ignoreBlockades:
      hasTech(state, player, "lwd") || silenced || flagshipOnly("yssaril_flagship"),
    enterAsteroids: hasTech(state, player, "amd") || navSuite,
    enterSupernovas:
      state.players[player]?.faction === "muaat" || hasTech(state, player, "mr") || navSuite,
    throughNebulae: state.laws.some(
      (l) => l.id === "shared_research" && l.outcome !== "Against",
    ),
    ignoreNebulae: navSuite || state.players[player]?.faction === "empyrean",
    ignoreRifts: navSuite,
    passThrough: state.seating.filter((other) => flagged(`aether@${other}`)),
    extraAdjacent: mechSystems,
  };
}

function canEnter(state: GameState, key: SystemKey, rules: MoveRules) {
  const system = state.systems[key];
  if (!system) return false;
  if (hasAnomaly(system, "SUPERNOVA") && !rules.enterSupernovas) return false;
  if (hasAnomaly(system, "ASTEROID_FIELD") && !rules.enterAsteroids) {
    return false;
  }
  // A nebula can only be entered as the active system.
  if (
    hasAnomaly(system, "NEBULA") &&
    key !== rules.destination &&
    !rules.throughNebulae &&
    !rules.ignoreNebulae
  ) {
    return false;
  }
  return true;
}

function canLeave(state: GameState, key: SystemKey, rules: MoveRules) {
  if (key === rules.destination) return true;
  const system = state.systems[key];
  // Aerie Hololattice: no passing through systems with the Argent's structures.
  const hololattice = state.seating.some(
    (other) =>
      other !== rules.player &&
      hasTech(state, other, "ah") &&
      system.planets.some((p) =>
        unitTypes(state.planets[p].units[other]).some((t) => t === "pds" || t === "spacedock"),
      ),
  );
  if (hololattice) return false;
  const blockers = otherShipOwners(system, rules.player).filter(
    (other) => !rules.passThrough?.includes(other),
  );
  return rules.ignoreBlockades || blockers.length === 0;
}

/** Systems a ship can step to next: adjacent ones, and any the rules add. */
const nextSteps = (state: GameState, key: SystemKey, rules: MoveRules) => [
  ...new Set([...adjacentSystems(state, key, rules.player), ...(rules.extraAdjacent ?? [])]),
];

export type Route = { path: SystemKey[]; rifts: number };

/** Number of gravity rifts a path moves out of or through. */
export const riftsExited = (state: GameState, path: SystemKey[], rules?: MoveRules) =>
  rules?.ignoreRifts
    ? 0
    : path.slice(0, -1).filter((key) => isGravityRift(state, state.systems[key])).length;

/**
 * Gravity rifts a player's ships roll for on a path: not the Vuil'raith's own
 * dimensional tears, and none at all with the Crucible or Nav Suite.
 */
export function riftRolls(state: GameState, path: SystemKey[], rules: MoveRules) {
  const player = rules.player;
  if (rules.ignoreRifts || state.tactical?.flags?.includes(`crucible:${player}`)) return 0;
  return path.slice(0, -1).filter((key) => {
    const system = state.systems[key];
    if (hasAnomaly(system, "GRAVITY_RIFT")) return true;
    const tears = tearOwners(state, system);
    return tears.length > 0 && !tears.includes(player);
  }).length;
}

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
  let allowance = hasAnomaly(origin, "NEBULA") && !rules.ignoreNebulae ? 1 : move;
  allowance += riftsExited(state, path, rules);
  if (path.length - 1 > allowance) return "That ship cannot move that far.";

  for (let i = 1; i < path.length; i++) {
    if (!nextSteps(state, path[i - 1], rules).includes(path[i])) {
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
  const baseMove = hasAnomaly(origin, "NEBULA") && !rules.ignoreNebulae ? 1 : move;
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
        (!rules.ignoreRifts && isGravityRift(state, state.systems[node.key]) ? 1 : 0);
      if (rifts > maxRifts) continue;
      if (steps + 1 > baseMove + rifts) continue;

      for (const neighbor of nextSteps(state, node.key, rules)) {
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
    if (
      hasAnomaly(system, "SUPERNOVA") &&
      !(state.players[player].faction === "muaat" || hasTech(state, player, "mr"))
    ) {
      return false;
    }
    if (hasAnomaly(system, "ASTEROID_FIELD") && !hasTech(state, player, "amd")) {
      return false;
    }
    const hasUnits =
      totalUnits(system.space[player]) > 0 ||
      system.planets.some((p) => totalUnits(state.planets[p].units[player]) > 0);
    const hasPlanet = system.planets.some(
      (p) => state.planets[p].controller === player,
    );
    // Dark Energy Tap: any adjacent system without other players' units.
    const empty =
      hasTech(state, player, "det") &&
      Object.keys(system.space).every((o) => Number(o) === player || totalUnits(system.space[Number(o)]) === 0) &&
      system.planets.every((p) =>
        Object.keys(state.planets[p].units).every(
          (o) => Number(o) === player || totalUnits(state.planets[p].units[Number(o)]) === 0,
        ),
      );
    return hasUnits || hasPlanet || empty;
  });
}
