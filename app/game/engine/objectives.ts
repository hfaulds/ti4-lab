import { PlayerId, PlanetTrait } from "~/types";
import { isShip, isStructure, objectivesById, technologiesById } from "../data";
import { ObjectivePayment } from "../actions";
import { GameState, SystemState } from "../types";
import {
  adjacentSystems,
  anomaliesOf,
  controlledPlanets,
  isHomeSystem,
  isLegendary,
  isOnEdge,
  MECATOL_REX,
  neighborsOf,
  nonFighterShips,
  planetInfluence,
  planetResources,
  planetTechSpecialties,
  planetTraits,
  systemsWithShips,
  systemsWithUnits,
  WORMHOLE_NEXUS_ID,
  wormholesOf,
} from "./board";
import { checkVictory, unlockLeaders, victoryPoints } from "./control";
import { pay, productionCapacity } from "./economy";
import {
  countOf,
  ensure,
  fail,
  log,
  playerOf,
  totalUnits,
  unitsOnBoard,
} from "./helpers";
import { ownedColors } from "./technology";

type Cost = {
  resources?: number;
  influence?: number;
  tradeGoods?: number;
  tokens?: number;
  actionCards?: number;
  relicFragments?: number;
};

type Requirement =
  | { check: (state: GameState, id: PlayerId) => boolean }
  | { cost: Cost }
  /** Depends on events the engine does not track; the player vouches for it. */
  | { manual: true };

const planetsWithTrait = (state: GameState, id: PlayerId, trait: PlanetTrait) =>
  controlledPlanets(state, id).filter((p) =>
    planetTraits(state, p.name).includes(trait),
  ).length;

const mostOfOneTrait = (state: GameState, id: PlayerId) =>
  Math.max(
    ...(["CULTURAL", "HAZARDOUS", "INDUSTRIAL"] as PlanetTrait[]).map((trait) =>
      planetsWithTrait(state, id, trait),
    ),
  );

const nonHomePlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id).filter(
    (p) => !isHomeSystem(state.systems[p.system]),
  ).length;

const techSpecialtyPlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id).filter(
    (p) => planetTechSpecialties(state, p.name).length > 0,
  ).length;

const attachedPlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id).filter((p) => p.attachments.length > 0).length;

const unitUpgrades = (state: GameState, id: PlayerId) =>
  state.players[id].technologies.filter(
    (tech) => technologiesById[tech]?.unitUpgrade,
  ).length;

const colorsWithAtLeast = (state: GameState, id: PlayerId, count: number) =>
  Object.values(ownedColors(state, id)).filter((owned) => owned >= count).length;

function structures(state: GameState, id: PlayerId) {
  return (
    unitsOnBoard(state, id, "pds") + unitsOnBoard(state, id, "spacedock")
  );
}

const planetsWithStructuresAway = (state: GameState, id: PlayerId) =>
  Object.values(state.planets).filter(
    (p) =>
      state.systems[p.system].homeOf !== id &&
      totalUnits(p.units[id], isStructure) > 0,
  ).length;

const systemsWhere = (
  state: GameState,
  id: PlayerId,
  test: (system: SystemState) => boolean,
) => systemsWithUnits(state, id).filter(test).length;

const isNotable = (state: GameState, system: SystemState) =>
  anomaliesOf(system).length > 0 ||
  system.planets.some(
    (p) => p === MECATOL_REX || isLegendary(state, p),
  );

const largestFleet = (state: GameState, id: PlayerId) =>
  Math.max(
    0,
    ...Object.keys(state.systems).map((key) =>
      nonFighterShips(state, Number(key), id),
    ),
  );

const mecatolSystem = (state: GameState) =>
  state.planets[MECATOL_REX]?.system;

const capitalShipsIn = (state: GameState, id: PlayerId, system: SystemState) =>
  countOf(system.space[id], "flagship") + countOf(system.space[id], "warsun");

const REQUIREMENTS: Record<string, Requirement> = {
  // Stage I
  corner: { check: (s, id) => mostOfOneTrait(s, id) >= 4 },
  develop: { check: (s, id) => unitUpgrades(s, id) >= 2 },
  diversify: { check: (s, id) => colorsWithAtLeast(s, id, 2) >= 2 },
  monument: { cost: { resources: 8 } },
  expand_borders: { check: (s, id) => nonHomePlanets(s, id) >= 6 },
  research_outposts: { check: (s, id) => techSpecialtyPlanets(s, id) >= 3 },
  intimidate: {
    check: (s, id) => {
      const mecatol = mecatolSystem(s);
      if (mecatol === undefined) return false;
      const adjacent = adjacentSystems(s, mecatol);
      return (
        systemsWithShips(s, id).filter((sys) => adjacent.includes(sys.key))
          .length >= 2
      );
    },
  },
  lead: { cost: { tokens: 3 } },
  trade_routes: { cost: { tradeGoods: 5 } },
  sway_council: { cost: { influence: 8 } },
  amass_wealth: { cost: { influence: 3, resources: 3, tradeGoods: 3 } },
  build_defenses: { check: (s, id) => structures(s, id) >= 4 },
  lost_outposts: { check: (s, id) => attachedPlanets(s, id) >= 2 },
  engineer_marvel: {
    check: (s, id) =>
      unitsOnBoard(s, id, "flagship") + unitsOnBoard(s, id, "warsun") > 0,
  },
  deep_space: {
    check: (s, id) => systemsWhere(s, id, (sys) => sys.planets.length === 0) >= 3,
  },
  infrastructure: { check: (s, id) => planetsWithStructuresAway(s, id) >= 3 },
  make_history: {
    check: (s, id) => systemsWhere(s, id, (sys) => isNotable(s, sys)) >= 2,
  },
  outer_rim: {
    check: (s, id) =>
      systemsWhere(s, id, (sys) => sys.homeOf !== id && isOnEdge(s, sys.key)) >=
      3,
  },
  push_boundaries: {
    check: (s, id) => {
      const mine = controlledPlanets(s, id).length;
      return (
        neighborsOf(s, id).filter(
          (other) => controlledPlanets(s, other).length < mine,
        ).length >= 2
      );
    },
  },
  raise_fleet: { check: (s, id) => largestFleet(s, id) >= 5 },

  // Stage II
  centralize_trade: { cost: { tradeGoods: 10 } },
  conquer: {
    check: (s, id) =>
      controlledPlanets(s, id).some((p) => {
        const home = s.systems[p.system].homeOf;
        return home !== undefined && home !== id;
      }),
  },
  brain_trust: { check: (s, id) => techSpecialtyPlanets(s, id) >= 5 },
  golden_age: { cost: { resources: 16 } },
  galvanize: { cost: { tokens: 6 } },
  manipulate_law: { cost: { influence: 16 } },
  master_science: { check: (s, id) => colorsWithAtLeast(s, id, 2) >= 4 },
  revolutionize: { check: (s, id) => unitUpgrades(s, id) >= 3 },
  subdue: { check: (s, id) => nonHomePlanets(s, id) >= 11 },
  unify_colonies: { check: (s, id) => mostOfOneTrait(s, id) >= 6 },
  supremacy: {
    check: (s, id) =>
      Object.values(s.systems).some(
        (sys) =>
          capitalShipsIn(s, id, sys) > 0 &&
          (sys.key === mecatolSystem(s) ||
            (sys.homeOf !== undefined && sys.homeOf !== id)),
      ),
  },
  become_legend: {
    check: (s, id) => systemsWhere(s, id, (sys) => isNotable(s, sys)) >= 4,
  },
  command_armada: { check: (s, id) => largestFleet(s, id) >= 8 },
  massive_cities: { check: (s, id) => structures(s, id) >= 7 },
  control_borderlands: {
    check: (s, id) =>
      systemsWhere(s, id, (sys) => sys.homeOf !== id && isOnEdge(s, sys.key)) >=
      5,
  },
  vast_reserves: { cost: { influence: 6, resources: 6, tradeGoods: 6 } },
  vast_territories: {
    check: (s, id) => systemsWhere(s, id, (sys) => sys.planets.length === 0) >= 5,
  },
  protect_border: { check: (s, id) => planetsWithStructuresAway(s, id) >= 5 },
  ancient_monuments: { check: (s, id) => attachedPlanets(s, id) >= 3 },
  distant_lands: {
    check: (s, id) => {
      const homes = new Set<PlayerId>();
      for (const planet of controlledPlanets(s, id)) {
        const nearby = [planet.system, ...adjacentSystems(s, planet.system)];
        const owner = nearby
          .map((key) => s.systems[key].homeOf)
          .find((o) => o !== undefined && o !== id && !homes.has(o));
        if (owner !== undefined) homes.add(owner);
      }
      return homes.size >= 2;
    },
  },

  // Secret objectives
  ans: {
    check: (s, id) =>
      s.players[id].technologies.filter(
        (tech) =>
          technologiesById[tech]?.faction &&
          !technologiesById[tech].name.startsWith("Valefar Assimilator"),
      ).length >= 2,
  },
  btgk: {
    check: (s, id) => {
      const fleets = systemsWithShips(s, id);
      return (
        fleets.some((sys) => wormholesOf(sys).includes("ALPHA")) &&
        fleets.some((sys) => wormholesOf(sys).includes("BETA"))
      );
    },
  },
  ctr: { check: (s, id) => systemsWithShips(s, id).length >= 6 },
  csl: {
    check: (s, id) =>
      systemsWithShips(s, id).some((sys) =>
        s.seating.some(
          (other) =>
            other !== id &&
            (countOf(sys.space[other], "spacedock") > 0 ||
              sys.planets.some(
                (p) => countOf(s.planets[p].units[other], "spacedock") > 0,
              )),
        ),
      ),
  },
  dtgs: { manual: true },
  eap: { check: (s, id) => unitsOnBoard(s, id, "pds") >= 4 },
  faa: { check: (s, id) => planetsWithTrait(s, id, "CULTURAL") >= 4 },
  fsn: { cost: { actionCards: 5 } },
  fwm: { check: (s, id) => unitsOnBoard(s, id, "spacedock") >= 3 },
  gamf: { check: (s, id) => unitsOnBoard(s, id, "dreadnought") >= 5 },
  lsc: {
    check: (s, id) =>
      systemsWithShips(s, id).filter((sys) =>
        adjacentSystems(s, sys.key).some(
          (key) => anomaliesOf(s.systems[key]).length > 0,
        ),
      ).length >= 3,
  },
  mew: { manual: true },
  mlp: { check: (s, id) => colorsWithAtLeast(s, id, 4) >= 1 },
  mrm: { check: (s, id) => planetsWithTrait(s, id, "HAZARDOUS") >= 4 },
  mp: { check: (s, id) => planetsWithTrait(s, id, "INDUSTRIAL") >= 4 },
  ose: {
    check: (s, id) => {
      const mecatol = s.planets[MECATOL_REX];
      if (mecatol?.controller !== id) return false;
      return totalUnits(s.systems[mecatol.system].space[id], isShip) >= 3;
    },
  },
  sar: { manual: true },
  te: {
    check: (s, id) =>
      systemsWithShips(s, id).some((sys) =>
        adjacentSystems(s, sys.key).some((key) => {
          const home = s.systems[key].homeOf;
          return home !== undefined && home !== id;
        }),
      ),
  },
  ttfd: { manual: true },
  uf: { manual: true },
  bam: { manual: true },
  baf: { manual: true },
  btv: { manual: true },
  dts: { manual: true },
  dfat: {
    check: (s, id) =>
      systemsWithUnits(s, id).some((sys) => sys.systemId === WORMHOLE_NEXUS_ID),
  },
  dyp: { manual: true },
  dhw: { cost: { relicFragments: 2 } },
  dp: { check: (s) => s.laws.length >= 3 },
  dtd: { manual: true },
  eh: {
    check: (s, id) =>
      controlledPlanets(s, id).reduce(
        (sum, p) => sum + planetInfluence(s, p.name),
        0,
      ) >= 12,
  },
  fwp: { manual: true },
  fc: {
    check: (s, id) => {
      const others = s.seating.filter(
        (other) => other !== id && !s.players[other].eliminated,
      );
      const neighbors = neighborsOf(s, id);
      return others.every((other) => neighbors.includes(other));
    },
  },
  hrm: {
    check: (s, id) =>
      controlledPlanets(s, id).reduce(
        (sum, p) => sum + planetResources(s, p.name),
        0,
      ) >= 12,
  },
  mtm: {
    check: (s, id) =>
      Object.values(s.planets).filter((p) => countOf(p.units[id], "mech") > 0)
        .length >= 4,
  },
  otf: {
    check: (s, id) =>
      Object.values(s.planets).some(
        (p) =>
          countOf(p.units[id], "spacedock") === 0 &&
          countOf(p.units[id], "infantry") + countOf(p.units[id], "mech") >= 9,
      ),
  },
  pem: {
    check: (s, id) =>
      Object.keys(s.systems).some(
        (key) => productionCapacity(s, Number(key), id) >= 8,
      ),
  },
  pe: { manual: true },
  sai: {
    check: (s, id) =>
      controlledPlanets(s, id).some((p) => isLegendary(s, p.name)),
  },
  syc: {
    check: (s, id) =>
      controlledPlanets(s, id).some((p) =>
        s.systems[p.system].planets.some((other) => {
          const controller = s.planets[other].controller;
          return controller !== undefined && controller !== id;
        }),
      ),
  },
  sb: {
    check: (s, id) =>
      s.players[id].promissoryNotesInPlay.some((note) => note.owner !== id),
  },
};

export type ObjectiveStatus = {
  /** "manual" when the engine cannot verify the requirement itself. */
  met: boolean | "manual";
  cost?: Cost;
};

export function objectiveStatus(
  state: GameState,
  id: PlayerId,
  objective: string,
): ObjectiveStatus {
  const requirement = REQUIREMENTS[objective];
  if (!requirement || "manual" in requirement) return { met: "manual" };
  if ("cost" in requirement) {
    return { met: canAfford(state, id, requirement.cost), cost: requirement.cost };
  }
  return { met: requirement.check(state, id) };
}

function canAfford(state: GameState, id: PlayerId, cost: Cost) {
  const player = state.players[id];
  const ready = controlledPlanets(state, id).filter((p) => !p.exhausted);
  // A planet pays resources or influence, never both, so check the two
  // totals against every planet being put to its better use.
  const resources = ready.reduce(
    (sum, p) => sum + planetResources(state, p.name),
    0,
  );
  const influence = ready.reduce(
    (sum, p) => sum + planetInfluence(state, p.name),
    0,
  );
  const tradeGoods = player.tradeGoods - (cost.tradeGoods ?? 0);
  if (tradeGoods < 0) return false;
  if ((cost.tokens ?? 0) > player.pools.tactic + player.pools.strategy) {
    return false;
  }
  if ((cost.actionCards ?? 0) > player.actionCards.length) return false;
  if ((cost.relicFragments ?? 0) > player.relicFragments.length) return false;
  const needResources = cost.resources ?? 0;
  const needInfluence = cost.influence ?? 0;
  if (needResources > 0 && needInfluence > 0) {
    const best = ready.reduce(
      (sum, p) =>
        sum +
        Math.max(
          planetResources(state, p.name),
          planetInfluence(state, p.name),
        ),
      0,
    );
    return best + tradeGoods >= needResources + needInfluence;
  }
  return (
    resources + tradeGoods >= needResources &&
    influence + tradeGoods >= needInfluence
  );
}

function payCost(
  state: GameState,
  id: PlayerId,
  cost: Cost,
  payment: ObjectivePayment = {},
) {
  const player = playerOf(state, id);
  if (cost.resources) {
    pay(state, id, payment.resources, "resources", cost.resources);
  }
  if (cost.influence) {
    pay(state, id, payment.influence, "influence", cost.influence);
  }
  if (cost.tradeGoods) {
    ensure(
      (payment.tradeGoods ?? 0) === cost.tradeGoods,
      `Spend ${cost.tradeGoods} trade goods.`,
    );
    ensure(
      player.tradeGoods >= cost.tradeGoods,
      "You do not have enough trade goods.",
    );
    player.tradeGoods -= cost.tradeGoods;
  }
  if (cost.tokens) {
    const tokens = payment.tokens ?? { tactic: 0, strategy: 0 };
    ensure(
      tokens.tactic >= 0 &&
        tokens.strategy >= 0 &&
        tokens.tactic + tokens.strategy === cost.tokens,
      `Spend ${cost.tokens} tokens from your tactic and strategy pools.`,
    );
    ensure(
      tokens.tactic <= player.pools.tactic &&
        tokens.strategy <= player.pools.strategy,
      "You do not have those command tokens.",
    );
    player.pools.tactic -= tokens.tactic;
    player.pools.strategy -= tokens.strategy;
  }
  if (cost.actionCards) {
    const cards = payment.actionCards ?? [];
    ensure(
      cards.length === cost.actionCards && new Set(cards).size === cards.length,
      `Discard ${cost.actionCards} action cards.`,
    );
    for (const card of cards) {
      const index = player.actionCards.indexOf(card);
      ensure(index >= 0, "You do not hold that action card.");
      player.actionCards.splice(index, 1);
      state.decks.actionCards.discard.push(card);
    }
  }
  if (cost.relicFragments) {
    const fragments = payment.relicFragments ?? [];
    ensure(
      fragments.length === cost.relicFragments &&
        new Set(fragments).size === fragments.length,
      `Purge ${cost.relicFragments} relic fragments.`,
    );
    for (const fragment of fragments) {
      const index = player.relicFragments.indexOf(fragment);
      ensure(index >= 0, "You do not hold that relic fragment.");
      player.relicFragments.splice(index, 1);
    }
  }
}

export function scoreObjective(
  state: GameState,
  id: PlayerId,
  objective: string,
  payment?: ObjectivePayment,
) {
  const player = playerOf(state, id);
  const data = objectivesById[objective];
  ensure(data, "Unknown objective.");

  const isSecret = data.kind === "secret";
  const revealed = state.publicObjectives.find(
    (o) => o.id === objective && o.revealed,
  );
  if (isSecret && !revealed) {
    ensure(
      player.secretObjectives.includes(objective),
      "That is not one of your secret objectives.",
    );
  } else {
    ensure(revealed, "That objective has not been revealed.");
    ensure(!revealed.scoredBy.includes(id), "You already scored that objective.");
    const home = state.systems[player.home];
    ensure(
      home.planets.every((p) => state.planets[p].controller === id),
      "You cannot score public objectives without every planet in your home system.",
    );
  }

  const requirement = REQUIREMENTS[objective];
  if (requirement && "check" in requirement) {
    ensure(requirement.check(state, id), `You do not meet "${data.name}".`);
  }
  if (requirement && "cost" in requirement) {
    payCost(state, id, requirement.cost, payment);
  }

  if (revealed) {
    revealed.scoredBy.push(id);
  } else {
    player.secretObjectives.splice(
      player.secretObjectives.indexOf(objective),
      1,
    );
    player.scoredSecrets.push(objective);
  }
  log(
    state,
    `${player.name} scored ${isSecret ? "secret objective " : ""}"${data.name}" (${victoryPoints(state, id)} VP).`,
    { player: id },
  );
  unlockLeaders(state);
  checkVictory(state);
}

/** Objectives a player may try to score in the given phase. */
export function scorableObjectives(
  state: GameState,
  id: PlayerId,
  phase: "status" | "action" | "agenda",
) {
  const player = state.players[id];
  const publics = state.publicObjectives
    .filter((o) => o.revealed && !o.scoredBy.includes(id))
    .map((o) => o.id);
  return [...publics, ...player.secretObjectives].filter(
    (objective) => objectivesById[objective]?.phase === phase,
  );
}

export function requireObjectivePhase(
  objective: string,
  phase: "status" | "action" | "agenda",
) {
  const data = objectivesById[objective];
  if (!data) fail("Unknown objective.");
  ensure(
    data.phase === phase,
    `"${data.name}" is scored during the ${data.phase} phase.`,
  );
}
