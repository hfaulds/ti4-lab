/**
 * A deterministic heuristic player for the base game. It is the baseline
 * other agents must beat, the reflex tier that answers their low-stakes
 * prompts, and the policy rollouts play forward with.
 *
 * Every decision is a ranked list of candidate actions; the first one the
 * engine accepts is played. A heuristic that proposes something illegal
 * costs a little quality, never the game. If no candidate is legal the
 * test bot's move is played instead and counted as a fallback.
 */
import { PlayerId } from "~/types";
import { isGroundForce, isShip, objectivesById, technologiesById } from "../data";
import {
  CargoPickup,
  GameAction,
  ProductionOrder,
  Research,
  ShipMove,
  StrategicPayload,
  StructurePlacement,
} from "../actions";
import {
  CommandPools,
  GameState,
  Prompt,
  SystemKey,
  UnitCounts,
  UnitType,
} from "../types";
import {
  adjacentSystems,
  capacityIn,
  controlledPlanets,
  dockFighterAllowance,
  findRoute,
  MECATOL_REX,
  moveRulesFor,
  neighborsOf,
  nonFighterShips,
  otherShipOwners,
  planetInfluence,
  planetResources,
  planetTechSpecialties,
  systemsWithShips,
} from "../engine/board";
import { suggestAssignment } from "../engine/combat";
import { productionCapacity, productionCost } from "../engine/economy";
import {
  COMMAND_TOKEN_LIMIT,
  countOf,
  openPrompts,
  sumCounts,
  tokensOnBoard,
  totalTokens,
  totalUnits,
  unitOf,
  unitsAvailable,
  unitsOnBoard,
  unitTypes,
} from "../engine/helpers";
import { applyAction } from "../engine/index";
import { objectiveStatus, scorableObjectives } from "../engine/objectives";
import { spaceCombatOdds } from "../engine/odds";
import { availableStrategyCards } from "../engine/phases";
import { StrategyKind, strategyKind } from "../engine/strategic";
import {
  bombardmentTargets,
  spaceCannonOffenseShooters,
} from "../engine/tactical";
import {
  missingPrerequisites,
  researchableTechnologies,
} from "../engine/technology";
import { botMove } from "../engine/testing";
import {
  chasesPosition,
  goalsOf,
  planetGoalBonus,
  positionScore,
  techGoalBonus,
} from "./goals";
import {
  findPayment,
  objectivePayment,
  readyPlanets,
  Reservation,
  reservationFor,
  spendable,
} from "./payment";

/** Bumped whenever the bot's behaviour changes, for replay attribution. */
export const SCRIPTED_BOT_VERSION = 1;

export type ScriptedMove = {
  player: PlayerId;
  action: GameAction;
  /** No candidate was legal, so the test bot's move was used. */
  fallback: boolean;
};

const CUSTODIANS_COST = 6;
const SECOND_TECHNOLOGY_COST = 6;
const SECONDARY_TECHNOLOGY_COST = 4;
/** Lowest chance of winning a space combat the bot will start. */
const ATTACK_THRESHOLD = 0.65;
/** Below this chance of winning, the bot retreats when it can. */
const RETREAT_THRESHOLD = 0.3;
/** Smallest gain worth spending a tactic token on. */
const ACTIVATION_THRESHOLD = 2;
/** Worth of a planet the fleet will be in reach of next turn. */
const STAGING_WEIGHT = 0.4;

/** The next move for whoever the game is waiting on, if anyone. */
export function scriptedMove(state: GameState): ScriptedMove | undefined {
  if (state.phase === "finished") return undefined;
  const [prompt] = openPrompts(state);
  const [offer] = state.transactions;
  const player = prompt
    ? prompt.player
    : offer
      ? offer.to
      : state.activePlayer;
  if (player === undefined) return undefined;

  const candidates: GameAction[] = prompt
    ? answerPrompt(state, prompt)
    : offer
      ? [
          { type: "ANSWER_TRANSACTION", transaction: offer.id, accept: true },
          { type: "ANSWER_TRANSACTION", transaction: offer.id, accept: false },
        ]
      : takeTurn(state, player);
  for (const action of candidates) {
    if (applyAction(state, player, action).ok) {
      return { player, action, fallback: false };
    }
  }
  const move = botMove(state);
  if (!move) return undefined;
  const result = applyAction(state, move.player, move.action);
  if (!result.ok) {
    throw new Error(
      `Scripted bot has no legal ${move.action.type} for player ${move.player}: ${result.error}`,
    );
  }
  return { ...move, fallback: true };
}

// --- Board reading ----------------------------------------------------------

/**
 * What the bot holds back from spending: its planned objective, plus 6
 * influence for the custodians token while its ships are near Mecatol Rex.
 */
function reservationOf(state: GameState, id: PlayerId): Reservation {
  const base = reservationFor(state, id);
  const mecatol = state.planets[MECATOL_REX]?.system;
  if (!state.custodians || mecatol === undefined) return base;
  const near = systemsWithin(state, mecatol, 2).some(
    (key) => nonFighterShips(state, key, id) > 0,
  );
  if (!near) return base;
  const payment = findPayment(state, id, CUSTODIANS_COST, "influence", base);
  if (!payment) return base;
  return {
    ...base,
    planets: [...base.planets, ...payment.planets],
    tradeGoods: base.tradeGoods + payment.tradeGoods,
  };
}

/** Pays for the custodians token out of what is not held for an objective. */
const custodiansPayment = (state: GameState, id: PlayerId) =>
  findPayment(state, id, CUSTODIANS_COST, "influence", reservationFor(state, id));

function planetValue(state: GameState, id: PlayerId, name: string) {
  const specialty = planetTechSpecialties(state, name).length > 0 ? 1 : 0;
  const mecatol = name === MECATOL_REX ? 4 : 0;
  return (
    planetResources(state, name) +
    planetInfluence(state, name) +
    specialty +
    mecatol +
    planetGoalBonus(state, id, name)
  );
}

const groundForcesOf = (state: GameState, planet: string, owner: PlayerId) =>
  countOf(state.planets[planet].units[owner], "infantry") +
  countOf(state.planets[planet].units[owner], "mech");

function defendersOn(state: GameState, planet: string, id: PlayerId) {
  return Object.keys(state.planets[planet].units)
    .map(Number)
    .filter((owner) => owner !== id)
    .reduce((sum, owner) => sum + groundForcesOf(state, planet, owner), 0);
}

/** Systems within `range` adjacency steps, including the start. */
function systemsWithin(state: GameState, start: SystemKey, range: number) {
  const seen = new Set([start]);
  let frontier = [start];
  for (let step = 0; step < range; step++) {
    const next: SystemKey[] = [];
    for (const key of frontier) {
      for (const neighbor of adjacentSystems(state, key)) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return [...seen];
}

const enemyShipsNear = (
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  range: number,
) =>
  systemsWithin(state, key, range).some(
    (k) => otherShipOwners(state.systems[k], id).length > 0,
  );

const shipsOf = (state: GameState, key: SystemKey, id: PlayerId): UnitCounts => {
  const group = state.systems[key].space[id];
  const units: UnitCounts = {};
  for (const type of unitTypes(group)) {
    if (isShip(type)) units[type] = countOf(group, type);
  }
  return units;
};

const addCounts = (a: UnitCounts, b: UnitCounts): UnitCounts => {
  const sum: UnitCounts = { ...a };
  for (const [type, count] of Object.entries(b) as [UnitType, number][]) {
    sum[type] = (sum[type] ?? 0) + count;
  }
  return sum;
};

/** Chance the player wins a space combat between these fleets. */
function winChance(
  state: GameState,
  id: PlayerId,
  ours: UnitCounts,
  enemy: PlayerId,
  theirs: UnitCounts,
  attacking: boolean,
  key: SystemKey,
) {
  const side = (owner: PlayerId, units: UnitCounts) => ({
    faction: state.players[owner].faction,
    technologies: state.players[owner].technologies,
    units,
  });
  const enemyCannon: UnitCounts = {};
  for (const shooter of spaceCannonOffenseShooters(state, enemy, key)) {
    enemyCannon[shooter.type] = (enemyCannon[shooter.type] ?? 0) + shooter.count;
  }
  const options = { expansions: state.options.expansions };
  if (attacking) {
    const odds = spaceCombatOdds(
      side(id, ours),
      { ...side(enemy, theirs), support: enemyCannon },
      options,
    );
    return odds.attackerWins;
  }
  return spaceCombatOdds(side(enemy, theirs), side(id, ours), options)
    .defenderWins;
}

// --- Prompts ----------------------------------------------------------------

function answerPrompt(state: GameState, prompt: Prompt): GameAction[] {
  const id = prompt.player;
  const player = state.players[id];
  switch (prompt.kind) {
    case "chooseSecret": {
      // Prefer secrets the engine can check, since manual ones never score.
      const options = [...prompt.options].sort(
        (a, b) =>
          Number(objectiveStatus(state, id, a).met === "manual") -
          Number(objectiveStatus(state, id, b).met === "manual"),
      );
      return options.map((keep) => ({ type: "CHOOSE_SECRET", keep }));
    }
    case "chooseStartingTech":
      return [
        {
          type: "CHOOSE_STARTING_TECH",
          technologies: prompt.options.slice(0, prompt.count),
        },
      ];
    case "placeStartingUnits":
      return [{ type: "PLACE_STARTING_UNITS", placement: prompt.suggested }];
    case "secondary":
      return [
        ...secondaryPayloads(state, id, prompt).map(
          (payload): GameAction => ({
            type: "RESOLVE_SECONDARY",
            promptId: prompt.id,
            payload,
          }),
        ),
        { type: "RESOLVE_SECONDARY", promptId: prompt.id },
      ];
    case "politicsAgenda":
      return [{ type: "ORDER_AGENDAS", top: prompt.cards, bottom: [] }];
    case "spaceCannon":
      return [{ type: "FIRE_SPACE_CANNON", promptId: prompt.id, fire: true }];
    case "assignHits":
      return [
        {
          type: "ASSIGN_HITS",
          promptId: prompt.id,
          assignment: suggestAssignment(state, prompt),
        },
      ];
    case "announceRetreat":
      return [...retreats(state, id, prompt), { type: "ANNOUNCE_RETREAT" }];
    case "scoreObjectives":
      return scoringActions(state, id);
    case "redistribute":
      return [
        {
          type: "REDISTRIBUTE",
          pools: poolsAfterGaining(state, id, prompt.gained),
        },
      ];
    case "discardActionCards":
      return [
        {
          type: "DISCARD_ACTION_CARDS",
          cards: player.actionCards.slice(0, prompt.count),
        },
      ];
    case "returnSecret": {
      const manualFirst = [...player.secretObjectives].sort(
        (a, b) =>
          Number(objectiveStatus(state, id, b).met === "manual") -
          Number(objectiveStatus(state, id, a).met === "manual"),
      );
      return manualFirst.map((objective) => ({ type: "RETURN_SECRET", objective }));
    }
    case "vote":
      return [{ type: "CAST_VOTES", planets: [] }];
    case "breakTie": {
      const outcomes = prompt.outcomes.length > 0 ? prompt.outcomes : ["For"];
      return outcomes.map((outcome) => ({ type: "BREAK_TIE", outcome }));
    }
    case "resolve":
      return [{ type: "RESOLVE", promptId: prompt.id }];
  }
}

function retreats(
  state: GameState,
  id: PlayerId,
  prompt: Extract<Prompt, { kind: "announceRetreat" }>,
): GameAction[] {
  const combat = state.tactical?.spaceCombat;
  if (!combat || prompt.options.length === 0) return [];
  const enemy = combat.attacker === id ? combat.defender : combat.attacker;
  const chance = winChance(
    state,
    id,
    shipsOf(state, prompt.system, id),
    enemy,
    shipsOf(state, prompt.system, enemy),
    combat.attacker === id,
    prompt.system,
  );
  if (chance >= RETREAT_THRESHOLD) return [];
  const options = [...prompt.options].sort(
    (a, b) =>
      totalUnits(state.systems[b].space[id]) -
        totalUnits(state.systems[a].space[id]) || a - b,
  );
  return options.map((to) => ({ type: "ANNOUNCE_RETREAT", to }));
}

function scoringActions(state: GameState, id: PlayerId): GameAction[] {
  const player = state.players[id];
  const homeHeld = state.systems[player.home].planets.every(
    (p) => state.planets[p].controller === id,
  );
  const scorable = scorableObjectives(state, id, "status").filter(
    (o) => objectiveStatus(state, id, o).met === true,
  );
  const byPoints = (a: string, b: string) =>
    (objectivesById[b]?.points ?? 0) - (objectivesById[a]?.points ?? 0) ||
    a.localeCompare(b);
  const publics = homeHeld
    ? scorable.filter((o) => !player.secretObjectives.includes(o)).sort(byPoints)
    : [];
  const secrets = scorable
    .filter((o) => player.secretObjectives.includes(o))
    .sort(byPoints);
  const isFree = (o: string) => !objectiveStatus(state, id, o).cost;

  const actions: GameAction[] = [];
  for (const publicObjective of publics) {
    const payment = objectivePayment(state, id, publicObjective);
    if (!payment) continue;
    const secret = secrets.find(isFree);
    if (secret) {
      actions.push({
        type: "SCORE_OBJECTIVES",
        publicObjective,
        secretObjective: secret,
        payment,
      });
    }
    actions.push({ type: "SCORE_OBJECTIVES", publicObjective, payment });
  }
  for (const secretObjective of secrets) {
    const payment = objectivePayment(state, id, secretObjective);
    if (payment) actions.push({ type: "SCORE_OBJECTIVES", secretObjective, payment });
  }
  actions.push({ type: "SCORE_OBJECTIVES" });
  return actions;
}

// --- Command tokens ---------------------------------------------------------

const tokenRoom = (state: GameState, id: PlayerId) =>
  Math.max(
    0,
    COMMAND_TOKEN_LIMIT - totalTokens(state.players[id]) - tokensOnBoard(state, id),
  );

/**
 * Pools after adding tokens: one strategy token for secondaries, a fleet pool
 * that grows with the game, then tactic tokens.
 */
function poolsAfterGaining(
  state: GameState,
  id: PlayerId,
  gained: number,
): CommandPools {
  const pools = { ...state.players[id].pools };
  const fleetTarget = state.round <= 2 ? 3 : state.round <= 4 ? 4 : 5;
  const received = Math.min(gained, tokenRoom(state, id));
  for (let i = 0; i < received; i++) {
    if (pools.strategy < 1) pools.strategy++;
    else if (pools.fleet < fleetTarget) pools.fleet++;
    else if (pools.tactic < 3) pools.tactic++;
    else if (pools.strategy < 2) pools.strategy++;
    else pools.tactic++;
  }
  return pools;
}

// --- Strategy phase ---------------------------------------------------------

const CARD_PRIORITY: Record<StrategyKind, number> = {
  technology: 8,
  leadership: 7,
  imperial: 6,
  trade: 6,
  warfare: 5,
  construction: 5,
  politics: 4,
  diplomacy: 3,
};

function strategyCardScore(state: GameState, id: PlayerId, card: string) {
  const kind = strategyKind(card);
  let score = CARD_PRIORITY[kind] + (state.strategyCardBonus[card] ?? 0);
  if (kind === "imperial") {
    if (state.planets[MECATOL_REX]?.controller === id) score += 4;
    const met = scorableObjectives(state, id, "status").some(
      (o) => objectiveStatus(state, id, o).met === true,
    );
    if (met) score += 2;
  }
  if (kind === "construction" && state.round <= 2) score += 2;
  if (
    kind === "construction" &&
    goalsOf(state, id).some((goal) => goal === "eap" || goal === "fwm")
  ) {
    score += 3;
  }
  if (kind === "trade" && state.players[id].faction === "hacan") score += 3;
  if (kind === "technology" && spendable(state, id, "resources") >= 6) score += 1;
  return score;
}

function pickStrategyCard(state: GameState, id: PlayerId): GameAction[] {
  return availableStrategyCards(state)
    .map((card) => ({ card, score: strategyCardScore(state, id, card) }))
    .sort((a, b) => b.score - a.score || a.card.localeCompare(b.card))
    .map(({ card }) => ({ type: "PICK_STRATEGY_CARD", card }));
}

// --- Action phase -----------------------------------------------------------

/** Cards worth playing before the bot has spent its tactic tokens. */
const PLAY_EARLY: StrategyKind[] = [
  "technology",
  "leadership",
  "construction",
  "trade",
  "politics",
  "diplomacy",
];

function takeTurn(state: GameState, id: PlayerId): GameAction[] {
  if (state.phase === "strategy") return pickStrategyCard(state, id);
  if (state.phase !== "action") return [];
  if (state.tactical) return tacticalStep(state, id);
  if (state.actionsThisTurn > 0) return [{ type: "END_TURN" }];

  const player = state.players[id];
  const card = player.strategyCards.find((c) => !c.exhausted);
  const strategic = (): GameAction[] =>
    card
      ? primaryPayloads(state, id, card.id).map((payload) => ({
          type: "STRATEGIC_ACTION",
          payload,
        }))
      : [];

  const actions: GameAction[] = [...commodityTrades(state, id)];
  if (card && PLAY_EARLY.includes(strategyKind(card.id))) {
    actions.push(...strategic());
  }
  actions.push(...activations(state, id));
  actions.push(...strategic());
  actions.push({ type: "PASS" });
  return actions;
}

/**
 * Offers each neighbor a swap of commodities, which both sides receive as
 * trade goods. Only offers the neighbor can accept are made, so an offer
 * never comes back round unanswered.
 */
function commodityTrades(state: GameState, id: PlayerId): GameAction[] {
  const mine = state.players[id].commodities;
  if (mine === 0) return [];
  for (const other of neighborsOf(state, id)) {
    const theirs = state.players[other].commodities;
    if (theirs === 0 || state.tradedWith.includes(other)) continue;
    const action: GameAction = {
      type: "PROPOSE_TRANSACTION",
      to: other,
      give: { commodities: mine },
      receive: { commodities: theirs },
    };
    const proposed = applyAction(state, id, action);
    if (!proposed.ok) continue;
    const offer = proposed.state.transactions.at(-1)!;
    const accepted = applyAction(proposed.state, other, {
      type: "ANSWER_TRANSACTION",
      transaction: offer.id,
      accept: true,
    });
    if (accepted.ok) return [action];
  }
  return [];
}

/** Systems worth a tactic token, best first. */
function activations(state: GameState, id: PlayerId): GameAction[] {
  const player = state.players[id];
  const reserved = reservationOf(state, id);
  const tokensLeft = player.pools.tactic + player.pools.strategy - 1;
  if (player.pools.tactic === 0 || tokensLeft < reserved.tokens) return [];

  const targets = Object.values(state.systems)
    .filter((system) => !system.commandTokens.includes(id))
    .map((system) => ({
      key: system.key,
      value: bestPlan(state, id, system.key)?.value ?? 0,
    }))
    .filter((t) => t.value >= ACTIVATION_THRESHOLD)
    .sort((a, b) => b.value - a.value || a.key - b.key);

  const build = productionTargets(state, id, reserved);
  // With one token left, building beats a small expansion.
  const lastToken = player.pools.tactic === 1;
  const ordered =
    lastToken && build.length > 0 && (targets[0]?.value ?? 0) < 6
      ? [...build, ...targets.map((t) => t.key)]
      : [...targets.map((t) => t.key), ...build];
  return [...new Set(ordered)].map((system) => ({
    type: "ACTIVATE_SYSTEM",
    system,
  }));
}

/** Systems with the bot's space docks that it can afford to build in. */
function productionTargets(
  state: GameState,
  id: PlayerId,
  reserved: Reservation,
) {
  if (spendable(state, id, "resources", reserved) < 3) return [];
  return Object.values(state.systems)
    .filter(
      (system) =>
        !system.commandTokens.includes(id) &&
        otherShipOwners(system, id).length === 0 &&
        productionCapacity(state, system.key, id) > 0,
    )
    .sort(
      (a, b) =>
        productionCapacity(state, b.key, id) -
          productionCapacity(state, a.key, id) || a.key - b.key,
    )
    .map((system) => system.key);
}

// --- Movement planning ------------------------------------------------------

type MovementPlan = {
  moves: ShipMove[];
  cargo: CargoPickup[];
  /** Ships arriving, not counting those already in the system. */
  ships: UnitCounts;
  groundForces: number;
};

const shipStrength = (state: GameState, id: PlayerId, type: UnitType) => {
  const unit = unitOf(state, id, type);
  if (!unit?.combat) return 0;
  const dice = unit.combatDice ?? 1;
  return dice * (11 - unit.combat) * (unit.sustainDamage ? 1.5 : 1);
};

/**
 * Ships and cargo to bring into `target`. An invasion brings ships with
 * capacity and the ground forces they can lift; an attack brings every
 * warship that can reach, up to the fleet pool.
 */
function planMovement(
  state: GameState,
  id: PlayerId,
  target: SystemKey,
  intent: { attack: boolean; groundForces: number },
): MovementPlan {
  const player = state.players[id];
  const rules = moveRulesFor(state, id, target);
  let room = Math.max(0, player.pools.fleet - nonFighterShips(state, target, id));
  const homeThreatened = enemyShipsNear(state, id, player.home, 2);
  const plan: MovementPlan = { moves: [], cargo: [], ships: {}, groundForces: 0 };
  let wanted = intent.groundForces;

  // Nearest fleets first.
  const distance = (key: SystemKey) =>
    findRoute(state, key, 4, rules)?.path.length ?? Infinity;
  const origins = systemsWithShips(state, id)
    .filter((s) => s.key !== target && !s.commandTokens.includes(id))
    .map((s) => ({ system: s, distance: distance(s.key) }))
    .sort((a, b) => a.distance - b.distance || a.system.key - b.system.key)
    .map((o) => o.system);

  for (const origin of origins) {
    if (room === 0) break;
    if (!intent.attack && wanted <= 0) break;
    const group = origin.space[id];
    const types = unitTypes(group).filter((type) => {
      const unit = unitOf(state, id, type);
      return (
        isShip(type) &&
        type !== "fighter" &&
        !!unit?.move &&
        !!findRoute(state, origin.key, unit.move, rules)
      );
    });
    const capacityOf = (type: UnitType) => unitOf(state, id, type)?.capacity ?? 0;
    types.sort((a, b) =>
      intent.attack
        ? shipStrength(state, id, b) - shipStrength(state, id, a) ||
          capacityOf(b) - capacityOf(a)
        : capacityOf(b) - capacityOf(a) ||
          shipStrength(state, id, b) - shipStrength(state, id, a),
    );

    // Keep the strongest ship at home while enemies are close.
    const guard =
      origin.key === player.home && homeThreatened
        ? [...types].sort(
            (a, b) => shipStrength(state, id, b) - shipStrength(state, id, a),
          )[0]
        : undefined;
    const ships: UnitCounts = {};
    let capacity = 0;
    for (const type of types) {
      const free = countOf(group, type) - (type === guard ? 1 : 0);
      const unitCapacity = capacityOf(type);
      if (!intent.attack && unitCapacity === 0) continue;
      let count = 0;
      while (count < free && room > 0) {
        if (!intent.attack && capacity >= wanted) break;
        count++;
        room--;
        capacity += unitCapacity;
      }
      if (count > 0) ships[type] = count;
    }
    if (Object.keys(ships).length === 0) continue;

    plan.moves.push({ from: origin.key, ships });
    plan.ships = addCounts(plan.ships, ships);

    // Cargo: ground forces in space, then from planets, then fighters.
    let lift = capacity;
    const take = (pickup: CargoPickup, count: number) => {
      if (count <= 0) return;
      plan.cargo.push(pickup);
      lift -= count;
    };
    for (const type of ["infantry", "mech"] as UnitType[]) {
      const count = Math.min(lift, countOf(group, type));
      take({ system: origin.key, units: { [type]: count } }, count);
      plan.groundForces += count;
      wanted -= count;
    }
    const guarded = origin.key === player.home && homeThreatened;
    for (const name of origin.planets) {
      if (state.planets[name].controller !== id) continue;
      for (const type of ["infantry", "mech"] as UnitType[]) {
        const present = countOf(state.planets[name].units[id], type);
        const garrison = guarded && type === "infantry" ? 1 : 0;
        const count = Math.min(lift, Math.max(0, wanted), present - garrison);
        if (count <= 0) continue;
        take({ system: origin.key, planet: name, units: { [type]: count } }, count);
        plan.groundForces += count;
        wanted -= count;
      }
    }
    const fighters = countOf(group, "fighter");
    const staying = dockFighterAllowance(state, origin.key, id);
    const fighterLift = Math.min(lift, intent.attack ? fighters : Math.max(0, fighters - staying));
    if (fighterLift > 0) {
      take({ system: origin.key, units: { fighter: fighterLift } }, fighterLift);
      plan.ships = addCounts(plan.ships, { fighter: fighterLift });
    }
  }

  plan.groundForces += totalUnits(state.systems[target].space[id], isGroundForce);
  return plan;
}

type TargetPlan = {
  value: number;
  plan: MovementPlan;
  /** Planets to land on, with how many ground forces each needs. */
  landings: { planet: string; need: number }[];
};

/** What a tactical action in `key` would gain, or undefined if nothing. */
function targetValue(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
): TargetPlan | undefined {
  const system = state.systems[key];
  const enemies = otherShipOwners(system, id);
  if (enemies.length > 1) return undefined;
  const custodians = canPayCustodians(state, id);

  const wanted = invasionTargets(state, id, key, custodians);
  const groundNeeded = wanted.reduce((sum, w) => sum + w.need, 0);
  const attack = enemies.length === 1;
  const onward = enemies.length === 0 ? onwardTargets(state, id, key, custodians) : [];
  if (!attack && groundNeeded === 0 && onward.length === 0) return undefined;

  const plan = planMovement(state, id, key, {
    attack,
    groundForces: groundNeeded + Math.min(3, Math.max(1, onward.length)),
  });
  const arriving = sumCounts(plan.ships);
  if (arriving === 0 && plan.groundForces === 0) return undefined;

  let value = 0;
  if (attack) {
    const enemy = enemies[0];
    const theirs = shipsOf(state, key, enemy);
    const ours = addCounts(shipsOf(state, key, id), plan.ships);
    const chance = winChance(state, id, ours, enemy, theirs, true, key);
    if (chance < ATTACK_THRESHOLD) return undefined;
    value += totalUnits(state.systems[key].space[enemy], (t) => isShip(t) && t !== "fighter") * 1.5;
  }

  let available = plan.groundForces;
  const landings: { planet: string; need: number }[] = [];
  for (const { planet, need, defenders } of wanted) {
    if (available < need) continue;
    available -= need;
    landings.push({ planet, need });
    value += planetValue(state, id, planet) + (defenders > 0 || state.planets[planet].controller !== undefined ? 1 : 0);
  }
  // Ground forces left aboard can take planets next door next turn.
  if (arriving > 0) {
    value +=
      STAGING_WEIGHT *
      onward.slice(0, available).reduce((sum, planet) => sum + planetValue(state, id, planet), 0);
  }
  if (value === 0) return undefined;
  return { value, plan, landings };
}

const canPayCustodians = (state: GameState, id: PlayerId) =>
  !state.custodians || !!custodiansPayment(state, id);

/** Planets in a system the player could invade, best value per unit first. */
function invasionTargets(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  custodians: boolean,
) {
  return state.systems[key].planets
    .filter((name) => state.planets[name].controller !== id)
    .filter((name) => name !== MECATOL_REX || custodians)
    .map((name) => {
      const defenders = defendersOn(state, name, id);
      return { planet: name, need: defenders === 0 ? 1 : defenders + 2, defenders };
    })
    .sort(
      (a, b) =>
        planetValue(state, id, b.planet) / b.need -
          planetValue(state, id, a.planet) / a.need || a.planet.localeCompare(b.planet),
    );
}

/** Undefended planets one system beyond `key`, best first. */
function onwardTargets(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  custodians: boolean,
) {
  return adjacentSystems(state, key)
    .filter((k) => otherShipOwners(state.systems[k], id).length === 0)
    .flatMap((k) =>
      invasionTargets(state, id, k, custodians)
        .filter((t) => t.defenders === 0)
        .map((t) => t.planet),
    )
    .sort(
      (a, b) => planetValue(state, id, b) - planetValue(state, id, a) || a.localeCompare(b),
    );
}

type Plan = { value: number; moves: ShipMove[]; cargo: CargoPickup[] };

/** The most valuable tactical action in `key`: an invasion or a position. */
function bestPlan(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
): Plan | undefined {
  const invasion = targetValue(state, id, key);
  const position = positionPlan(state, id, key);
  const options: Plan[] = [];
  if (invasion) {
    options.push({
      value: invasion.value,
      moves: invasion.plan.moves,
      cargo: invasion.plan.cargo,
    });
  }
  if (position) options.push(position);
  return options.sort((a, b) => b.value - a.value)[0];
}

/**
 * Moves one cheap ship into an empty system when that brings a positional
 * objective closer, such as fleets next to Mecatol Rex.
 */
function positionPlan(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
): Plan | undefined {
  if (!chasesPosition(state, id)) return undefined;
  const system = state.systems[key];
  if (otherShipOwners(system, id).length > 0) return undefined;
  if (totalUnits(system.space[id], isShip) > 0) return undefined;

  const fleets = systemsWithShips(state, id).map((s) => s.key);
  const before = positionScore(state, id, fleets);
  const rules = moveRulesFor(state, id, key);
  let best: { gain: number; cost: number; from: SystemKey; type: UnitType } | undefined;

  for (const origin of systemsWithShips(state, id)) {
    if (origin.key === key || origin.commandTokens.includes(id)) continue;
    const group = origin.space[id];
    const cargo =
      countOf(group, "fighter") + countOf(group, "infantry") + countOf(group, "mech");
    const leaves = nonFighterShips(state, origin.key, id) === 1;
    // A lone ship leaving would strand its fighters and ground forces.
    if (leaves && cargo > 0) continue;
    const after = [...fleets.filter((k) => k !== origin.key || !leaves), key];
    const gain = positionScore(state, id, after) - before;
    if (gain <= 0) continue;

    for (const type of unitTypes(group)) {
      const unit = unitOf(state, id, type);
      if (!isShip(type) || type === "fighter" || !unit?.move) continue;
      const capacity = unit.capacity ?? 0;
      const spare =
        capacityIn(state, origin.key, id) +
        dockFighterAllowance(state, origin.key, id) -
        capacity;
      if (capacity > 0 && cargo > spare) continue;
      if (!findRoute(state, origin.key, unit.move, rules)) continue;
      const cost = unit.cost ?? 0;
      if (
        !best ||
        gain > best.gain ||
        (gain === best.gain && cost < best.cost)
      ) {
        best = { gain, cost, from: origin.key, type };
      }
    }
  }
  if (!best) return undefined;
  return {
    value: best.gain,
    moves: [{ from: best.from, ships: { [best.type]: 1 } }],
    cargo: [],
  };
}

// --- Tactical action steps --------------------------------------------------

function tacticalStep(state: GameState, id: PlayerId): GameAction[] {
  const tactical = state.tactical!;
  switch (tactical.step) {
    case "movement": {
      const plan = bestPlan(state, id, tactical.system);
      const empty: GameAction = { type: "MOVE_SHIPS", moves: [], cargo: [] };
      if (!plan) return [empty];
      return [
        { type: "MOVE_SHIPS", moves: plan.moves, cargo: plan.cargo },
        { type: "MOVE_SHIPS", moves: plan.moves, cargo: [] },
        empty,
      ];
    }
    case "bombardment":
      return [...bombardments(state, id), { type: "BOMBARD", targets: [] }];
    case "commit":
      return [...landings(state, id), { type: "COMMIT_GROUND_FORCES", landings: [] }];
    case "production": {
      const reserved = reservationOf(state, id);
      return [
        ...productionActions(state, id, tactical.system, reserved),
        { type: "PRODUCE", units: [], payment: { planets: [], tradeGoods: 0 } },
      ];
    }
    default:
      return [];
  }
}

function bombardments(state: GameState, id: PlayerId): GameAction[] {
  const system = state.systems[state.tactical!.system];
  const [planet] = bombardmentTargets(state, id).sort(
    (a, b) => defendersOn(state, b, id) - defendersOn(state, a, id) || a.localeCompare(b),
  );
  if (!planet) return [];
  const targets = unitTypes(system.space[id])
    .filter((type) => unitOf(state, id, type)?.bombardment !== undefined)
    .map((unit) => ({ unit, planet, count: countOf(system.space[id], unit) }));
  return targets.length > 0 ? [{ type: "BOMBARD", targets }] : [];
}

function landings(state: GameState, id: PlayerId): GameAction[] {
  const key = state.tactical!.system;
  const space = state.systems[key].space[id];
  const pool: UnitCounts = {
    infantry: countOf(space, "infantry"),
    mech: countOf(space, "mech"),
  };
  const custodians = state.custodians ? custodiansPayment(state, id) : undefined;

  const targets = state.systems[key].planets
    .filter((name) => state.planets[name].controller !== id)
    .filter((name) => name !== MECATOL_REX || !state.custodians || custodians)
    .map((name) => {
      const defenders = defendersOn(state, name, id);
      return { planet: name, need: defenders === 0 ? 1 : defenders + 2 };
    })
    .sort(
      (a, b) =>
        planetValue(state, id, b.planet) - planetValue(state, id, a.planet) ||
        a.planet.localeCompare(b.planet),
    );

  const take = (count: number): UnitCounts => {
    const units: UnitCounts = {};
    for (const type of ["infantry", "mech"] as UnitType[]) {
      const used = Math.min(count, pool[type] ?? 0);
      if (used === 0) continue;
      units[type] = used;
      pool[type]! -= used;
      count -= used;
    }
    return units;
  };
  const left = () => (pool.infantry ?? 0) + (pool.mech ?? 0);

  const chosen: { planet: string; units: UnitCounts }[] = [];
  for (const { planet, need } of targets) {
    if (left() < need) continue;
    chosen.push({ planet, units: take(need) });
  }
  if (chosen.length === 0) return [];
  // Spare ground forces stay aboard for the next system, or else reinforce
  // the most valuable landing.
  const onward = onwardTargets(state, id, key, !state.custodians || !!custodians);
  if (left() > 0 && onward.length === 0) {
    const first = chosen[0];
    first.units = addCounts(first.units, take(left()));
  }
  const landsOnMecatol = chosen.some((l) => l.planet === MECATOL_REX);
  const action: GameAction = {
    type: "COMMIT_GROUND_FORCES",
    landings: chosen,
    custodians: landsOnMecatol && state.custodians ? custodians : undefined,
  };
  const withoutMecatol: GameAction = {
    type: "COMMIT_GROUND_FORCES",
    landings: chosen.filter((l) => l.planet !== MECATOL_REX),
  };
  return [action, withoutMecatol];
}

// --- Production ---------------------------------------------------------------

const unitCost = (state: GameState, id: PlayerId, type: UnitType) => {
  const unit = unitOf(state, id, type);
  return unit?.cost === undefined ? Infinity : unit.cost / unit.producedPerCost;
};

/**
 * Units to build in a system: carriers until there are enough to expand
 * with, infantry to fill them, then warships, then fighters.
 */
function productionOrders(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  budget: number,
  options: { docksOnly?: boolean } = {},
): ProductionOrder[] {
  const player = state.players[id];
  const system = state.systems[key];
  let slots = productionCapacity(state, key, id, options);
  let room = player.pools.fleet - nonFighterShips(state, key, id);
  const space = system.space[id];
  let freeCapacity =
    capacityIn(state, key, id) +
    dockFighterAllowance(state, key, id) -
    countOf(space, "fighter") -
    countOf(space, "infantry") -
    countOf(space, "mech");
  const dockPlanet = system.planets.find(
    (name) =>
      state.planets[name].controller === id &&
      countOf(state.planets[name].units[id], "spacedock") > 0,
  );
  const threatened = enemyShipsNear(state, id, key, 2);
  const carrierTarget = state.round <= 2 ? 2 : 3;
  const groundForcesHere =
    countOf(space, "infantry") +
    system.planets.reduce(
      (sum, name) => sum + groundForcesOf(state, name, id),
      0,
    );

  // Hold back a resource when Sarween Tools will refund one anyway.
  let remaining = budget + (state.players[id].technologies.includes("st") ? 1 : 0);
  const orders: ProductionOrder[] = [];
  const counts: UnitCounts = {};
  const add = (type: UnitType, count: number, planet?: string) => {
    const cost = unitCost(state, id, type) * count;
    if (cost > remaining || count > slots) return false;
    if ((counts[type] ?? 0) + count > unitsAvailable(state, id, type)) return false;
    if (isShip(type) && type !== "fighter") {
      if (room <= 0) return false;
      room--;
    }
    if (type === "fighter" || (isGroundForce(type) && !planet)) {
      if (freeCapacity < count) return false;
      freeCapacity -= count;
    }
    remaining -= cost;
    slots -= count;
    counts[type] = (counts[type] ?? 0) + count;
    const existing = orders.find((o) => o.type === type && o.planet === planet);
    if (existing) existing.count += count;
    else orders.push(planet ? { type, count, planet } : { type, count });
    return true;
  };

  let infantryBuilt = 0;
  for (let guard = 0; guard < 20 && slots > 0 && remaining > 0; guard++) {
    const carriers = unitsOnBoard(state, id, "carrier") + (counts.carrier ?? 0);
    if (carriers < carrierTarget && add("carrier", 1)) continue;
    if (
      dockPlanet &&
      groundForcesHere + infantryBuilt < 4 &&
      add("infantry", 2, dockPlanet)
    ) {
      infantryBuilt += 2;
      continue;
    }
    const warship = threatened || state.round <= 2
      ? ["cruiser", "destroyer", "dreadnought"]
      : ["dreadnought", "cruiser", "destroyer"];
    if (warship.some((type) => add(type as UnitType, 1))) continue;
    if (add("fighter", 2)) continue;
    if (dockPlanet && add("infantry", 2, dockPlanet)) {
      infantryBuilt += 2;
      continue;
    }
    break;
  }
  return orders;
}

function productionActions(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  reserved: Reservation,
): GameAction[] {
  const budget = spendable(state, id, "resources", reserved);
  const orders = productionOrders(state, id, key, budget);
  if (orders.length === 0) return [];
  const payment = findPayment(
    state,
    id,
    productionCost(state, id, orders),
    "resources",
    reserved,
  );
  return payment ? [{ type: "PRODUCE", units: orders, payment }] : [];
}

// --- Technology -------------------------------------------------------------

const TECH_PRIORITY: Record<string, number> = {
  nm: 9,
  st: 8,
  amd: 8,
  gd: 7,
  ps: 6,
  hm: 6,
  dn2: 6,
  cv2: 6,
  fl: 5,
  dxa: 5,
  inf2: 5,
  gls: 4,
  cr2: 4,
  dd2: 4,
  ff2: 4,
  asc: 4,
  ws: 4,
  da: 3,
  pds2: 3,
  sd2: 3,
  td: 3,
  ie: 3,
  lwd: 3,
};

function techScore(state: GameState, id: PlayerId, tech: string) {
  const data = technologiesById[tech];
  let score = TECH_PRIORITY[tech] ?? 2;
  if (data?.faction === state.players[id].faction) score += data.unitUpgrade ? 4 : 2;
  return score + techGoalBonus(state, id, tech);
}

/** Technologies the player can research now, best first. */
function researchOptions(
  state: GameState,
  id: PlayerId,
  exclude: string[] = [],
): Research[] {
  const ready = readyPlanets(state, id).filter((name) => !exclude.includes(name));
  const options: { research: Research; score: number }[] = [];
  for (const tech of researchableTechnologies(state, id)) {
    const missing = missingPrerequisites(state, id, tech.id);
    const skips: string[] = [];
    for (const color of missing) {
      const planet = ready.find(
        (name) =>
          !skips.includes(name) &&
          planetTechSpecialties(state, name).includes(color),
      );
      if (!planet) break;
      skips.push(planet);
    }
    if (skips.length < missing.length) continue;
    options.push({
      research: skips.length > 0 ? { technology: tech.id, skips } : { technology: tech.id },
      score: techScore(state, id, tech.id),
    });
  }
  return options
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.research.technology.localeCompare(b.research.technology),
    )
    .map((o) => o.research);
}

/** The same state with one more technology owned, for planning a second. */
function withTechnology(state: GameState, id: PlayerId, tech: string): GameState {
  const player = state.players[id];
  return {
    ...state,
    players: {
      ...state.players,
      [id]: { ...player, technologies: [...player.technologies, tech] },
    },
  };
}

// --- Strategy cards -----------------------------------------------------------

function structurePlacements(state: GameState, id: PlayerId): StructurePlacement[][] {
  const player = state.players[id];
  const planets = controlledPlanets(state, id).map((p) => p.name);
  const hasDock = (system: SystemKey) =>
    state.systems[system].planets.some(
      (name) => countOf(state.planets[name].units[id], "spacedock") > 0,
    );
  const dockSite = planets
    .filter((name) => {
      const system = state.planets[name].system;
      return system !== player.home && !hasDock(system);
    })
    .sort(
      (a, b) =>
        planetResources(state, b) - planetResources(state, a) || a.localeCompare(b),
    )[0];
  const pdsSites = [...planets].sort(
    (a, b) =>
      countOf(state.planets[a].units[id], "pds") -
        countOf(state.planets[b].units[id], "pds") ||
      Number(state.planets[b].system === player.home) -
        Number(state.planets[a].system === player.home) ||
      planetValue(state, id, b) - planetValue(state, id, a) ||
      a.localeCompare(b),
  );
  const options: StructurePlacement[][] = [];
  if (dockSite && pdsSites[0]) {
    options.push([
      { type: "spacedock", planet: dockSite },
      { type: "pds", planet: pdsSites[0] },
    ]);
  }
  if (dockSite) options.push([{ type: "spacedock", planet: dockSite }]);
  if (pdsSites[0] && pdsSites[1]) {
    options.push([
      { type: "pds", planet: pdsSites[0] },
      { type: "pds", planet: pdsSites[1] },
    ]);
  }
  if (pdsSites[0]) options.push([{ type: "pds", planet: pdsSites[0] }]);
  return options;
}

function primaryPayloads(
  state: GameState,
  id: PlayerId,
  card: string,
): StrategicPayload[] {
  const reserved = reservationOf(state, id);
  const kind = strategyKind(card);
  switch (kind) {
    case "leadership": {
      const spare = spendable(state, id, "influence", reserved);
      const amount = Math.min(6, Math.floor(spare / 3) * 3);
      const influence = findPayment(state, id, amount, "influence", reserved);
      const payloads: StrategicPayload[] = [];
      if (influence && amount > 0) {
        const spent = influence.planets.reduce(
          (sum, name) => sum + planetInfluence(state, name),
          influence.tradeGoods,
        );
        payloads.push({
          card: kind,
          influence,
          pools: poolsAfterGaining(state, id, 3 + Math.floor(spent / 3)),
        });
      }
      payloads.push({ card: kind, pools: poolsAfterGaining(state, id, 3) });
      return payloads;
    }
    case "diplomacy": {
      const exhausted = controlledPlanets(state, id)
        .filter((p) => p.exhausted)
        .map((p) => p.name)
        .sort((a, b) => planetValue(state, id, b) - planetValue(state, id, a) || a.localeCompare(b));
      return [{ card: kind, ready: exhausted.slice(0, 2) }, { card: kind, ready: [] }];
    }
    case "politics":
      return state.speaker !== id
        ? [{ card: kind, speaker: id }, { card: kind }]
        : [{ card: kind }];
    case "construction":
      return [
        ...structurePlacements(state, id).map((structures) => ({
          card: kind,
          structures,
        })),
        { card: kind, structures: [] },
      ];
    case "trade":
      return [{ card: kind }];
    case "warfare": {
      const withShips = Object.values(state.systems)
        .filter((s) => s.commandTokens.includes(id))
        .sort(
          (a, b) =>
            Number(b.key === state.players[id].home) -
              Number(a.key === state.players[id].home) ||
            nonFighterShips(state, b.key, id) - nonFighterShips(state, a.key, id) ||
            a.key - b.key,
        );
      return [
        ...withShips.slice(0, 1).map((s) => ({ card: kind, removeFrom: s.key })),
        { card: kind },
      ];
    }
    case "technology": {
      const [first] = researchOptions(state, id);
      if (!first) return [{ card: kind }];
      const payloads: StrategicPayload[] = [];
      const spare = spendable(state, id, "resources", {
        ...reserved,
        planets: [...reserved.planets, ...(first.skips ?? [])],
      });
      if (spare >= SECOND_TECHNOLOGY_COST + 2) {
        const held = { ...reserved, planets: [...reserved.planets, ...(first.skips ?? [])] };
        const payment = findPayment(state, id, SECOND_TECHNOLOGY_COST, "resources", held);
        const after = withTechnology(state, id, first.technology);
        const [second] = researchOptions(after, id, [
          ...held.planets,
          ...(payment?.planets ?? []),
        ]).filter((r) => r.technology !== first.technology);
        if (payment && second) {
          payloads.push({ card: kind, research: first, second: { ...second, payment } });
        }
      }
      payloads.push({ card: kind, research: first }, { card: kind });
      return payloads;
    }
    case "imperial": {
      const objectives = state.publicObjectives
        .filter((o) => o.revealed && !o.scoredBy.includes(id))
        .map((o) => o.id)
        .filter((o) => objectiveStatus(state, id, o).met === true)
        .sort(
          (a, b) =>
            (objectivesById[b]?.points ?? 0) - (objectivesById[a]?.points ?? 0) ||
            a.localeCompare(b),
        );
      const payloads: StrategicPayload[] = [];
      for (const objective of objectives) {
        const payment = objectivePayment(state, id, objective);
        if (payment) payloads.push({ card: kind, objective, payment });
      }
      payloads.push({ card: kind });
      return payloads;
    }
  }
}

function secondaryPayloads(
  state: GameState,
  id: PlayerId,
  prompt: Extract<Prompt, { kind: "secondary" }>,
): StrategicPayload[] {
  const player = state.players[id];
  const kind = strategyKind(prompt.card);
  const reserved = reservationOf(state, id);
  const hasToken = player.pools.strategy > 0 || prompt.free;
  switch (kind) {
    case "leadership": {
      const spare = spendable(state, id, "influence", reserved);
      const amount = Math.min(6, Math.floor(spare / 3) * 3);
      if (amount < 3 || tokenRoom(state, id) === 0) return [];
      const influence = findPayment(state, id, amount, "influence", reserved);
      if (!influence) return [];
      const spent = influence.planets.reduce(
        (sum, name) => sum + planetInfluence(state, name),
        influence.tradeGoods,
      );
      return [
        {
          card: kind,
          influence,
          pools: poolsAfterGaining(state, id, Math.floor(spent / 3)),
        },
      ];
    }
    case "technology": {
      if (!hasToken) return [];
      if (spendable(state, id, "resources", reserved) < SECONDARY_TECHNOLOGY_COST + 1) {
        return [];
      }
      const payment = findPayment(
        state,
        id,
        SECONDARY_TECHNOLOGY_COST,
        "resources",
        reserved,
      );
      if (!payment) return [];
      return researchOptions(state, id, [...reserved.planets, ...payment.planets])
        .slice(0, 3)
        .map((research) => ({ card: kind, research, payment }));
    }
    case "warfare": {
      if (!hasToken) return [];
      const budget = spendable(state, id, "resources", reserved);
      if (budget < 3) return [];
      const orders = productionOrders(state, id, player.home, budget, {
        docksOnly: true,
      });
      if (orders.length === 0) return [];
      const payment = findPayment(
        state,
        id,
        productionCost(state, id, orders),
        "resources",
        reserved,
      );
      return payment
        ? [{ card: kind, production: { units: orders, payment } }]
        : [];
    }
    case "trade": {
      // Fresh commodities are worth trading away to neighbors.
      const missing = player.commodityLimit - player.commodities;
      const worthIt = prompt.free || (player.pools.strategy >= 2 && missing >= 2);
      return worthIt ? [{ card: kind }] : [];
    }
    case "imperial": {
      const secrets = player.secretObjectives.length + player.scoredSecrets.length;
      return hasToken && secrets < 3 ? [{ card: kind }] : [];
    }
    default:
      return [];
  }
}
