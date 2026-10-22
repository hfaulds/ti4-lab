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
import {
  isGroundForce,
  isShip,
  objectivesById,
  strategyCardsById,
  technologiesById,
} from "../data";
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
  Payment,
  Prompt,
  SystemKey,
  TransactionSide,
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
  presence,
  nonFighterShips,
  otherShipOwners,
  planetInfluence,
  planetResources,
  planetTechSpecialties,
  systemsWithShips,
  fleetLimit,
} from "../engine/board";
import { suggestAssignment } from "../engine/combat";
import { productionCapacity, productionCost } from "../engine/economy";
import {
  COMMAND_TOKEN_LIMIT,
  countOf,
  hasTech,
  movesAsShip,
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
import { fleetPoolLimit, StrategyKind, strategyKind } from "../engine/strategic";
import {
  bombardmentTargets,
  moveBonus,
  spaceCannonOffenseShooters,
} from "../engine/tactical";
import {
  missingPrerequisites,
  researchableTechnologies,
} from "../engine/technology";
import { botMove } from "../engine/testing";
import { effectAnswers } from "../engine/reactions";
import { TableTalk, worth } from "./talk";
import { tradePartners } from "./reach";
import { componentPlays, reactions } from "./reactions";
import {
  chasesPosition,
  goalsOf,
  planetGoalBonus,
  positionScore,
  techGoalBonus,
} from "./goals";
import {
  findPayment,
  NO_RESERVATION,
  objectivePayment,
  readyPlanets,
  Reservation,
  reservationFor,
  spendable,
} from "./payment";

/** Bumped whenever the bot's behaviour changes, for replay attribution. */
export const SCRIPTED_BOT_VERSION = 9;

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

/**
 * The bot's ranked candidate actions for whoever the game is waiting on,
 * before any legality check, or undefined if nobody is to move.
 */
export function scriptedCandidates(
  state: GameState,
  talk?: TableTalk,
): { player: PlayerId; actions: GameAction[] } | undefined {
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
          ...(acceptsOffer(offer.give, offer.receive, talk?.willPay(state, offer.to, offer.from))
            ? [{ type: "ANSWER_TRANSACTION", transaction: offer.id, accept: true } as const]
            : []),
          { type: "ANSWER_TRANSACTION", transaction: offer.id, accept: false },
        ]
      : takeTurn(state, player, talk);
  return { player, actions: candidates };
}

/** The next move for whoever the game is waiting on, if anyone. */
export function scriptedMove(
  state: GameState,
  talk?: TableTalk,
): ScriptedMove | undefined {
  const ranked = scriptedCandidates(state, talk);
  if (!ranked) return undefined;
  const { player, actions: candidates } = ranked;
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
/**
 * While set, the bot holds nothing back and considers every activation
 * worth anything. Its reservations and threshold are its own plan, not
 * rules, so an agent's menu also offers what they would hide.
 */
let widened = false;

/**
 * Runs `plan` as if the bot held nothing back for objectives or custodians
 * and would take any activation that gains something.
 */
export function withWiderChoices<T>(plan: () => T): T {
  const was = widened;
  widened = true;
  try {
    return plan();
  } finally {
    widened = was;
  }
}

function reservationOf(state: GameState, id: PlayerId): Reservation {
  if (widened) return NO_RESERVATION;
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
      return [
        ...retreats(state, id, prompt),
        ...(prompt.required
          ? prompt.options.map((to): GameAction => ({ type: "ANNOUNCE_RETREAT", to }))
          : [{ type: "ANNOUNCE_RETREAT" } as GameAction]),
      ];
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
    case "effect":
      return effectAnswers(state, prompt);
    case "window":
      return [...reactions(state, prompt), { type: "PASS_WINDOW", promptId: prompt.id }];
    case "research": {
      // The best option, then the best one after it for a second research.
      const [first] = researchOptions(state, id);
      if (!first) return [{ type: "RESEARCH", promptId: prompt.id, research: [] }];
      const picks: Research[] = [first];
      if (prompt.count > 1) {
        const [second] = researchOptions(
          withTechnology(state, id, first.technology),
          id,
          first.skips ?? [],
        );
        if (second) picks.push(second);
      }
      return [
        { type: "RESEARCH", promptId: prompt.id, research: picks },
        { type: "RESEARCH", promptId: prompt.id, research: [first] },
        { type: "RESEARCH", promptId: prompt.id, research: [] },
      ];
    }
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
export function poolsAfterGaining(
  state: GameState,
  id: PlayerId,
  gained: number,
): CommandPools {
  const pools = { ...state.players[id].pools };
  const limit = fleetPoolLimit(state);
  const fleetTarget = Math.min(limit, state.round <= 2 ? 3 : state.round <= 4 ? 4 : 5);
  // Fleet Regulations may have left too many tokens in the fleet pool.
  if (pools.fleet > limit) {
    pools.tactic += pools.fleet - limit;
    pools.fleet = limit;
  }
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

function takeTurn(state: GameState, id: PlayerId, talk?: TableTalk): GameAction[] {
  if (state.phase === "strategy") return pickStrategyCard(state, id);
  if (state.phase !== "action") return [];
  if (state.tactical) return tacticalStep(state, id);
  if (state.actionsThisTurn > 0) return [{ type: "END_TURN" }];

  const player = state.players[id];
  const card = player.strategyCards.find((c) => !c.exhausted);
  const strategic = (): GameAction[] =>
    card
      ? primaryPayloads(state, id, card.id, talk).map((payload) => ({
          type: "STRATEGIC_ACTION",
          payload,
        }))
      : [];

  const actions: GameAction[] = [...commodityTrades(state, id, talk)];
  if (card && PLAY_EARLY.includes(strategyKind(card.id))) {
    actions.push(...strategic());
  }
  actions.push(...activations(state, id, talk));
  actions.push(...strategic());
  actions.push(...componentPlays(state, id));
  actions.push({ type: "PASS" });
  return actions;
}

const onlyGoods = (side: TransactionSide) =>
  !side.promissoryNotes?.length &&
  !side.actionCards?.length &&
  !side.relicFragments?.length;
/**
 * Whether the bot, on the receiving end of an offer, takes it: trade goods
 * and commodities only, and at least as much coming in as going out, or
 * up to `owes` short when it means to pay the proposer what a deal says
 * (see talk.ts). `give` is what the proposer gives, so it is what the bot
 * receives.
 */
function acceptsOffer(give: TransactionSide, receive: TransactionSide, owes = 0) {
  const short = worth(receive) - worth(give);
  return (
    onlyGoods(give) &&
    onlyGoods(receive) &&
    (worth(give) > 0 || (owes > 0 && worth(receive) > 0)) &&
    short <= owes
  );
}

/**
 * Offers each neighbor an even swap of commodities, which both sides receive
 * as trade goods. When a deal says one side pays the other (see talk.ts),
 * the payer gives X commodities for X less what it owes, or trade goods
 * when it has no commodities. Only offers the neighbor will legally accept
 * are made, so an offer never comes back round unanswered.
 */
function commodityTrades(state: GameState, id: PlayerId, talk?: TableTalk): GameAction[] {
  const mine = state.players[id].commodities;
  for (const other of neighborsOf(state, id)) {
    if (state.tradedWith.includes(other)) continue;
    const theirs = state.players[other].commodities;
    const toMe = theirs > 0 ? (talk?.willPay(state, other, id) ?? 0) : 0;
    const fromMe = toMe === 0 ? (talk?.willPay(state, id, other) ?? 0) : 0;
    const iOwe = fromMe > 0 && (mine > 0 || state.players[id].tradeGoods > 0);
    let give: TransactionSide;
    let receive: TransactionSide;
    if (toMe > 0) {
      const swap = Math.min(theirs, mine + toMe);
      give = swap > toMe ? { commodities: swap - toMe } : {};
      receive = { commodities: swap };
    } else if (iOwe && mine === 0) {
      give = { tradeGoods: Math.min(fromMe, state.players[id].tradeGoods) };
      receive = {};
    } else if (iOwe) {
      const swap = Math.min(mine, theirs + fromMe);
      give = { commodities: swap };
      receive = swap > fromMe ? { commodities: swap - fromMe } : {};
    } else {
      const swap = Math.min(mine, theirs);
      if (swap === 0) continue;
      give = { commodities: swap };
      receive = { commodities: swap };
    }
    // An offer the bot pays more into is its own debt, so it takes it.
    if (!iOwe && !acceptsOffer(give, receive, toMe)) continue;
    const action: GameAction = {
      type: "PROPOSE_TRANSACTION",
      to: other,
      give,
      receive,
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
function activations(state: GameState, id: PlayerId, talk?: TableTalk): GameAction[] {
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
    .filter((t) => t.value >= (widened ? Number.MIN_VALUE : ACTIVATION_THRESHOLD))
    // A truce holds unless breaking it gains more than it is worth (see talk.ts).
    .filter((t) => !talk?.holdsBack(state, id, t.key, t.value))
    .sort((a, b) => b.value - a.value || a.key - b.key);

  const build = productionTargets(state, id, reserved).filter((key) => !talk?.holdsBack(state, id, key, 0));
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
/**
 * How a ship gets from `origin` to the active system: on its own move
 * (with bonuses such as Slipstream), only with Gravity Drive's +1, or not
 * at all.
 */
function reachBy(
  state: GameState,
  id: PlayerId,
  origin: SystemKey,
  type: UnitType,
  rules: ReturnType<typeof moveRulesFor>,
): "move" | "gravityDrive" | undefined {
  const move = unitOf(state, id, type)?.move;
  if (!move) return undefined;
  const reach = move + moveBonus(state, id, origin);
  if (findRoute(state, origin, reach, rules)) return "move";
  if (hasTech(state, id, "gd") && findRoute(state, origin, reach + 1, rules)) {
    return "gravityDrive";
  }
  return undefined;
}

/** A move for a mobile dock (Floating Factory) that can reach `key`, if any. */
function mobileDockFor(state: GameState, id: PlayerId, key: SystemKey): ShipMove | undefined {
  const rules = moveRulesFor(state, id, key);
  for (const origin of systemsWithShips(state, id).concat(
    Object.values(state.systems).filter((s) => countOf(s.space[id], "spacedock") > 0),
  )) {
    if (origin.key === key || origin.commandTokens.includes(id)) continue;
    if (countOf(origin.space[id], "spacedock") === 0 || !movesAsShip(state, id, "spacedock")) continue;
    const how = reachBy(state, id, origin.key, "spacedock", rules);
    if (how === "move") return { from: origin.key, ships: { spacedock: 1 } };
  }
  return undefined;
}

/** Worth of bringing a mobile dock forward, to produce where it arrives. */
const FACTORY_VALUE = 2;

/** Infantry kept at a home space dock for the next carrier built there. */
const HOME_INFANTRY = 2;

function planMovement(
  state: GameState,
  id: PlayerId,
  target: SystemKey,
  /** `spare` is how many of `groundForces` are extra, for onward expansion. */
  intent: { attack: boolean; groundForces: number; spare?: number },
): MovementPlan {
  const player = state.players[id];
  const rules = moveRulesFor(state, id, target);
  let room = Math.max(0, fleetLimit(state, id) - nonFighterShips(state, target, id));
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

  // Gravity Drive lifts one ship per tactical action.
  let gravityUsed = false;
  for (const origin of origins) {
    if (room === 0) break;
    if (!intent.attack && wanted <= 0) break;
    const group = origin.space[id];
    // Mobile docks (Floating Factories) travel with invasions, not attacks:
    // they cannot fight, and are lost if blockaded.
    const moves = (type: UnitType) =>
      type !== "fighter" &&
      (isShip(type) || (!intent.attack && movesAsShip(state, id, type)));
    const reach = new Map(
      unitTypes(group)
        .filter(moves)
        .map((type) => [type, reachBy(state, id, origin.key, type, rules)]),
    );
    const types = unitTypes(group).filter((type) => {
      const how = reach.get(type);
      return how === "move" || (how === "gravityDrive" && !gravityUsed);
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
    const boosted: UnitCounts = {};
    let capacity = 0;
    for (const type of types) {
      const lifted = reach.get(type) === "gravityDrive";
      if (lifted && gravityUsed) continue;
      const free = Math.min(
        countOf(group, type) - (type === guard ? 1 : 0),
        lifted ? 1 : Infinity,
      );
      const unitCapacity = capacityOf(type);
      if (!intent.attack && unitCapacity === 0) continue;
      let count = 0;
      while (count < free && room > 0) {
        if (!intent.attack && capacity >= wanted) break;
        count++;
        room--;
        capacity += unitCapacity;
      }
      if (count === 0) continue;
      if (lifted) {
        boosted[type] = count;
        gravityUsed = true;
      } else {
        ships[type] = count;
      }
    }
    const moving = addCounts(ships, boosted);
    if (Object.keys(moving).length === 0) continue;

    if (Object.keys(ships).length > 0) plan.moves.push({ from: origin.key, ships });
    if (Object.keys(boosted).length > 0) {
      plan.moves.push({ from: origin.key, ships: boosted, gravityDrive: true });
    }
    plan.ships = addCounts(plan.ships, moving);

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
    // Planets enemy ships could reach keep one infantry, so a neighbor
    // cannot just land and take them.
    const exposed = origin.key !== player.home && enemyShipsNear(state, id, origin.key, 2);
    const mine = origin.planets.filter((name) => state.planets[name].controller === id);
    const garrisonOf = (type: UnitType) => ((guarded || exposed) && type === "infantry" ? 1 : 0);
    // Spare infantry stay at a home dock, HOME_INFANTRY across the system
    // (garrisons included), to fill the next carrier built there; unless
    // an unplayed Warfare can free this carrier to take a second system now.
    const warfareToCome = player.strategyCards.some(
      (c) => !c.exhausted && strategyKind(c.id) === "warfare",
    );
    let spareHome =
      origin.key === player.home && productionCapacity(state, origin.key, id) > 0 && !warfareToCome
        ? Math.max(
            0,
            mine.reduce((sum, name) => sum + countOf(state.planets[name].units[id], "infantry"), 0) -
              HOME_INFANTRY,
          )
        : Infinity;
    for (const name of mine) {
      for (const type of ["infantry", "mech"] as UnitType[]) {
        const present = countOf(state.planets[name].units[id], type);
        const garrison = garrisonOf(type);
        const needed = Math.max(0, wanted - (intent.spare ?? 0));
        const spare = type === "infantry" ? spareHome : Infinity;
        const count = Math.min(
          lift,
          Math.max(0, wanted),
          present - garrison,
          Math.max(needed, Math.min(spare, present - garrison)),
        );
        if (count <= 0) continue;
        take({ system: origin.key, planet: name, units: { [type]: count } }, count);
        plan.groundForces += count;
        wanted -= count;
        if (type === "infantry") spareHome -= count;
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

  const spare = Math.min(3, Math.max(1, onward.length));
  const plan = planMovement(state, id, key, {
    attack,
    groundForces: groundNeeded + spare,
    spare,
  });
  const arriving = sumCounts(plan.ships);
  if (arriving === 0 && plan.groundForces === 0) return undefined;
  // A mobile dock brought along can produce here in this same tactical
  // action; it stays out of reach of enemy ships, since a blockade sinks it.
  if (!attack && key !== state.players[id].home && !plan.ships.spacedock && !enemyShipsNear(state, id, key, 1)) {
    const dock = mobileDockFor(state, id, key);
    if (dock) {
      plan.moves.push(dock);
      plan.ships = addCounts(plan.ships, { spacedock: 1 });
    }
  }
  const factory =
    key !== state.players[id].home && (plan.ships.spacedock ?? 0) > 0 ? FACTORY_VALUE : 0;

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
  value += factory;
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

export type Plan = {
  value: number;
  moves: ShipMove[];
  cargo: CargoPickup[];
  /** Planets an invasion means to take, with the ground forces each gets. */
  landings?: { planet: string; need: number }[];
};

/** The most valuable tactical action in `key`: an invasion or a position. */
export function bestPlan(
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
      landings: invasion.landings,
    });
  }
  if (position) options.push(position);
  const trade = tradeShipPlan(state, id, key);
  if (trade) options.push(trade);
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
  return oneShipMove(state, id, key, (origin, leaves) => {
    const after = [...fleets.filter((k) => k !== origin || !leaves), key];
    return positionScore(state, id, after) - before;
  });
}

/**
 * Moves one cheap ship into an empty system next to a player who is not
 * yet a neighbor, so the two can trade, when the bot has commodities or
 * an unplayed Trade card.
 */
function tradeShipPlan(state: GameState, id: PlayerId, key: SystemKey): Plan | undefined {
  const player = state.players[id];
  const holdsTrade = player.strategyCards.some(
    (c) => !c.exhausted && strategyKind(c.id) === "trade",
  );
  if (player.commodities === 0 && !holdsTrade) return undefined;
  if (presence(state, id).includes(key)) return undefined;
  const others = state.seating.filter((other) => other !== id);
  if (others.some((other) => presence(state, other).includes(key))) return undefined;
  const neighbors = neighborsOf(state, id);
  const near = new Set([key, ...adjacentSystems(state, key)]);
  const partners = others.filter(
    (other) =>
      !neighbors.includes(other) &&
      !state.players[other].eliminated &&
      presence(state, other).some((k) => near.has(k)),
  );
  if (partners.length === 0) return undefined;
  // Worth about the commodities it turns into trade goods.
  const commodities = holdsTrade ? player.commodityLimit : player.commodities;
  return oneShipMove(state, id, key, () => 0.6 * commodities + 0.5 * (partners.length - 1));
}

/**
 * The cheapest single ship that can move to `key` without stranding cargo,
 * among the origins where `gainOf` is positive, and the best gain.
 */
function oneShipMove(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  gainOf: (origin: SystemKey, leaves: boolean) => number,
): Plan | undefined {
  const rules = moveRulesFor(state, id, key);
  let best:
    | { gain: number; cost: number; from: SystemKey; type: UnitType; gravityDrive: boolean }
    | undefined;

  for (const origin of systemsWithShips(state, id)) {
    if (origin.key === key || origin.commandTokens.includes(id)) continue;
    const group = origin.space[id];
    const cargo =
      countOf(group, "fighter") + countOf(group, "infantry") + countOf(group, "mech");
    const leaves = nonFighterShips(state, origin.key, id) === 1;
    // A lone ship leaving would strand its fighters and ground forces.
    if (leaves && cargo > 0) continue;
    const gain = gainOf(origin.key, leaves);
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
      const how = reachBy(state, id, origin.key, type, rules);
      if (!how) continue;
      const cost = unit.cost ?? 0;
      if (
        !best ||
        gain > best.gain ||
        (gain === best.gain && cost < best.cost)
      ) {
        best = { gain, cost, from: origin.key, type, gravityDrive: how === "gravityDrive" };
      }
    }
  }
  if (!best) return undefined;
  return {
    value: best.gain,
    moves: [
      {
        from: best.from,
        ships: { [best.type]: 1 },
        ...(best.gravityDrive ? { gravityDrive: true } : {}),
      },
    ],
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
/** What a recipe can do: add units, within the system's limits and budget. */
type OrderBuilder = {
  add: (type: UnitType, count: number, planet?: string) => boolean;
  /** The planet with the space dock, where ground forces are placed. */
  dockPlanet?: string;
};

/** Build recipes the agent chooses between, besides the bot's own build. */
export const BUILD_RECIPES: { name: string; build: (b: OrderBuilder) => void }[] = [
  {
    name: "a carrier filled with infantry",
    build: (b) => {
      if (!b.add("carrier", 1)) return;
      for (let i = 0; i < 2 && b.add("infantry", 2, b.dockPlanet); i++);
    },
  },
  {
    name: "ground forces",
    build: (b) => {
      for (let i = 0; i < 5 && b.add("infantry", 2, b.dockPlanet); i++);
    },
  },
  {
    name: "warships",
    build: (b) => {
      for (let i = 0; i < 5 && ["cruiser", "destroyer"].some((t) => b.add(t as UnitType, 1)); i++);
    },
  },
  {
    name: "fighters",
    build: (b) => {
      for (let i = 0; i < 5 && b.add("fighter", 2); i++);
    },
  },
];

function productionOrders(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  budget: number,
  options: { docksOnly?: boolean; recipe?: (b: OrderBuilder) => void } = {},
): ProductionOrder[] {
  const system = state.systems[key];
  let slots = productionCapacity(state, key, id, options);
  let room = fleetLimit(state, id) - nonFighterShips(state, key, id);
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

  if (options.recipe) {
    options.recipe({ add, dockPlanet });
    return orders;
  }

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

/**
 * Builds to choose from in `key`: each recipe, paid with planets first and,
 * where trade goods alone cover it, with trade goods (so planets stay ready
 * for an objective). For the Warfare secondary, only docks produce.
 */
export function productionChoices(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  options: { docksOnly?: boolean } = {},
): { units: ProductionOrder[]; payment: Payment }[] {
  const budget = spendable(state, id, "resources");
  const choices: { units: ProductionOrder[]; payment: Payment }[] = [];
  const keepPlanets: Reservation = { ...NO_RESERVATION, planets: readyPlanets(state, id) };
  for (const recipe of BUILD_RECIPES) {
    const units = productionOrders(state, id, key, budget, { ...options, recipe: recipe.build });
    if (units.length === 0) continue;
    const cost = productionCost(state, id, units);
    for (const reserved of [NO_RESERVATION, keepPlanets]) {
      const payment = findPayment(state, id, cost, "resources", reserved);
      if (!payment) continue;
      if (choices.some((c) => JSON.stringify(c) === JSON.stringify({ units, payment }))) continue;
      choices.push({ units, payment });
    }
  }
  return choices;
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
  talk?: TableTalk,
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
    case "trade": {
      // Partners refreshed for free owe one back, as the deal that comes
      // with it says (see talk.ts); those who broke a deal are left out,
      // and those promised a refresh are let in.
      const partners = [
        ...new Set([
          ...tradePartners(state, id).filter((p) => talk?.trusted(p) ?? true),
          ...(talk?.promisedRefreshes(id) ?? []),
        ]),
      ];
      return partners.length > 0 ? [{ card: kind, allow: partners }, { card: kind }] : [{ card: kind }];
    }
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
        // Thunder's Edge Warfare is a tactical action: the home system will do.
        ...(strategyCardsById[card]?.source === "te"
          ? [{ card: kind, removeFrom: state.players[id].home }]
          : [{ card: kind }]),
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

/**
 * Every use of a secondary the player can pay for, whatever the bot would
 * do: unlike `secondaryPayloads`, nothing is held back for objectives and no
 * use is judged not worth it. For an agent to choose between. The engine
 * still decides what is legal.
 */
export function secondaryChoices(
  state: GameState,
  id: PlayerId,
  prompt: Extract<Prompt, { kind: "secondary" }>,
): StrategicPayload[] {
  const player = state.players[id];
  const kind = strategyKind(prompt.card);
  const hasToken = player.pools.strategy > 0 || prompt.free;
  if (kind !== "leadership" && !hasToken) return [];
  switch (kind) {
    case "leadership": {
      if (tokenRoom(state, id) === 0) return [];
      const spare = spendable(state, id, "influence");
      const choices: StrategicPayload[] = [];
      const gains = new Set<number>();
      for (const amount of [3, 6, 9]) {
        if (amount > spare) break;
        const influence = findPayment(state, id, amount, "influence");
        if (!influence) break;
        const spent = influence.planets.reduce(
          (sum, name) => sum + planetInfluence(state, name),
          influence.tradeGoods,
        );
        const gained = Math.floor(spent / 3);
        if (gains.has(gained)) continue;
        gains.add(gained);
        choices.push({ card: kind, influence, pools: poolsAfterGaining(state, id, gained) });
      }
      return choices;
    }
    case "diplomacy": {
      const exhausted = controlledPlanets(state, id)
        .filter((p) => p.exhausted)
        .map((p) => p.name)
        .sort((a, b) => planetValue(state, id, b) - planetValue(state, id, a) || a.localeCompare(b));
      return exhausted.length > 0 ? [{ card: kind, ready: exhausted.slice(0, 2) }] : [];
    }
    case "politics":
    case "trade":
      return [{ card: kind }];
    case "construction": {
      const seen = new Set<string>();
      const choices: StrategicPayload[] = [];
      for (const structure of structurePlacements(state, id).flat()) {
        const key = `${structure.type}:${structure.planet}`;
        if (seen.has(key)) continue;
        seen.add(key);
        choices.push({ card: kind, structures: [structure] });
      }
      return choices;
    }
    case "warfare": {
      const budget = spendable(state, id, "resources");
      const orders = productionOrders(state, id, player.home, budget, { docksOnly: true });
      if (orders.length === 0) return [];
      const payment = findPayment(state, id, productionCost(state, id, orders), "resources");
      return payment ? [{ card: kind, production: { units: orders, payment } }] : [];
    }
    case "technology": {
      const payment = findPayment(state, id, SECONDARY_TECHNOLOGY_COST, "resources");
      if (!payment) return [];
      return researchOptions(state, id, payment.planets)
        .slice(0, 4)
        .map((research) => ({ card: kind, research, payment }));
    }
    case "imperial": {
      const secrets = player.secretObjectives.length + player.scoredSecrets.length;
      return secrets < 3 ? [{ card: kind }] : [];
    }
  }
}

/**
 * Why a player has nothing to do with a secondary but skip it, in their own
 * terms. Mirrors `secondaryChoices`.
 */
export function secondarySkipReason(
  state: GameState,
  id: PlayerId,
  prompt: Extract<Prompt, { kind: "secondary" }>,
): string {
  const player = state.players[id];
  const kind = strategyKind(prompt.card);
  const name = strategyCardsById[prompt.card]?.name ?? prompt.card;
  const hasToken = player.pools.strategy > 0 || prompt.free;
  if (secondaryChoices(state, id, prompt).length > 0) {
    return `None of the ways to use the ${name} secondary were legal here.`;
  }
  if (kind !== "leadership" && !hasToken) {
    return `You have no strategy token to pay for the ${name} secondary.`;
  }
  switch (kind) {
    case "leadership":
      return tokenRoom(state, id) === 0
        ? "All your command tokens are already in use, so Leadership's secondary would gain nothing."
        : `Leadership's secondary costs 3 influence per command token; you have ${spendable(state, id, "influence")} ready.`;
    case "technology": {
      const resources = spendable(state, id, "resources");
      return resources < SECONDARY_TECHNOLOGY_COST
        ? `Technology's secondary costs ${SECONDARY_TECHNOLOGY_COST} resources; you have ${resources} ready.`
        : "No technology can be researched with the prerequisites and planets you have.";
    }
    case "warfare":
      return `Nothing you can afford can be built at your home space dock (${spendable(state, id, "resources")} resources ready).`;
    case "diplomacy":
      return "None of your planets are exhausted, so there is nothing to ready.";
    case "construction":
      return "There is nowhere to place a PDS or space dock, or none are left in your reinforcements.";
    case "imperial": {
      const secrets = player.secretObjectives.length + player.scoredSecrets.length;
      return `You already have ${secrets} secret objectives, the most allowed.`;
    }
    default:
      return `The ${name} secondary cannot be used here.`;
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
