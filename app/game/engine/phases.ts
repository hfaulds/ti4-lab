import { PlayerId } from "~/types";
import { strategyCardsById } from "../data";
import { CommandPools, GameState } from "../types";


import { finishGame, victoryPoints } from "./control";
import {
  activePlayers,
  ask,
  clockwiseFrom,
  drawActionCards,
  ensure,
  hasTech,
  initiativeOrder,
  log,
  playerName,
  playerOf,
  plural,
} from "./helpers";
import { ObjectivePayment } from "../actions";
import { applyNextStrategyEffects, startAgendaPhase } from "./agenda";
import { afterGainingTradeGoods, startTurn, statusEndEffects } from "./events";
import { requireObjectivePhase, scoreObjective } from "./objectives";
import { openWindow, ownsAbility } from "./reactions";
import { setPools } from "./strategic";
import { achieve } from "./effects/helpers";
import { readyLeader, unlockCommander } from "./leaders";

/**
 * Extreme Duress: a player whose next action is not strategic discards their
 * action cards and hands over their trade goods.
 */
export function breakDuress(state: GameState, id: PlayerId, strategic = false) {
  const duress = state.duress;
  if (!duress || duress.player !== id) return;
  state.duress = undefined;
  if (strategic) return;
  const player = state.players[id];
  state.decks.actionCards.discard.push(...player.actionCards);
  player.actionCards = [];
  state.players[duress.by].tradeGoods += player.tradeGoods;
  log(state, `Extreme Duress: ${player.name} discarded their action cards and gave up ${player.tradeGoods} trade goods.`, {
    player: id,
  });
  player.tradeGoods = 0;
}

// --- Strategy phase ---------------------------------------------------------

/** Three- and four-player games give everyone two strategy cards. */
export const cardsPerPlayer = (state: GameState) =>
  state.seating.length <= 4 ? 2 : 1;

export function startStrategyPhase(state: GameState) {
  state.phase = "strategy";
  state.tactical = undefined;
  state.strategic = undefined;
  state.agenda = undefined;
  state.statusStep = undefined;
  state.zeroToken = undefined;
  state.lastPick = undefined;
  state.disgraced = undefined;
  state.strategyEnding = false;
  for (const id of state.seating) {
    const player = state.players[id];
    // Political Stability keeps last round's cards, ready to use again.
    if (player.keepsStrategyCards) {
      for (const card of player.strategyCards) card.exhausted = false;
    } else {
      player.strategyCards = [];
    }
    player.passed = player.eliminated;
    player.used = [];
  }
  log(state, `Round ${state.round}: strategy phase.`);
  applyNextStrategyEffects(state);
  // Council Patronage
  for (const id of activePlayers(state)) {
    if (!ownsAbility(state, id, "council_patronage")) continue;
    const player = state.players[id];
    player.commodities = player.commodityLimit;
    player.tradeGoods++;
    log(state, `Council Patronage: ${player.name} replenished commodities and gained 1 trade good.`, {
      player: id,
    });
  }
  const first = nextPicker(state);
  if (first === undefined) {
    endStrategyPhase(state);
    return;
  }
  state.activePlayer = first;
  openWindow(state, "strategyStart", {}, clockwiseFrom(state, state.speaker));
}

export function availableStrategyCards(state: GameState) {
  const taken = new Set(
    state.seating.flatMap((id) =>
      state.players[id].strategyCards.map((card) => card.id),
    ),
  );
  return state.strategyCards.filter((card) => !taken.has(card));
}

/** The next player to choose a strategy card, in speaker order. */
function nextPicker(state: GameState): PlayerId | undefined {
  const order = clockwiseFrom(state, state.speaker);
  const perPlayer = cardsPerPlayer(state);
  return Array.from({ length: perPlayer }, (_, round) => round + 1)
    .flatMap((round) =>
      order.filter(
        (p) =>
          !state.players[p].keepsStrategyCards &&
          state.players[p].strategyCards.length < round,
      ),
    )
    .at(0);
}

export function pickStrategyCard(state: GameState, id: PlayerId, card: string) {
  ensure(state.phase === "strategy", "It is not the strategy phase.");
  ensure(state.prompts.length === 0, "Other players still have decisions to make.");
  ensure(
    !state.strategyEnding && !state.lastPick && state.activePlayer === id,
    "It is not your turn to choose.",
  );
  const available = availableStrategyCards(state);
  ensure(available.includes(card), "That strategy card is not available.");
  ensure(
    !(
      state.disgraced?.player === id &&
      state.disgraced.card === card &&
      available.length > 1
    ),
    "Public Disgrace: choose a different strategy card.",
  );
  const player = playerOf(state, id);
  player.strategyCards.push({ id: card, exhausted: false });
  const bonus = state.strategyCardBonus[card] ?? 0;
  player.tradeGoods += bonus;
  delete state.strategyCardBonus[card];
  log(
    state,
    `${player.name} chose ${strategyCardsById[card].name}${bonus > 0 ? ` and gained ${plural(bonus, "trade good")}` : ""}.`,
    { player: id },
  );
  state.lastPick = { player: id, card, bonus };
  openWindow(
    state,
    "afterPickStrategyCard",
    { player: id, card },
    clockwiseFrom(state, id).filter((other) => other !== id),
  );
}

/** Takes back the last strategy card chosen (Public Disgrace). */
export function undoLastPick(state: GameState) {
  const pick = state.lastPick;
  if (!pick) return;
  const player = state.players[pick.player];
  player.strategyCards = player.strategyCards.filter((c) => c.id !== pick.card);
  player.tradeGoods -= pick.bonus;
  if (pick.bonus > 0) state.strategyCardBonus[pick.card] = pick.bonus;
  state.lastPick = undefined;
  state.disgraced = { player: pick.player, card: pick.card };
  state.activePlayer = pick.player;
}

function finishPick(state: GameState) {
  const pick = state.lastPick!;
  state.lastPick = undefined;
  if (pick.bonus > 0) afterGainingTradeGoods(state, pick.player);
  const next = nextPicker(state);
  if (next !== undefined) {
    state.activePlayer = next;
    return;
  }
  for (const unpicked of availableStrategyCards(state)) {
    state.strategyCardBonus[unpicked] =
      (state.strategyCardBonus[unpicked] ?? 0) + 1;
  }
  state.strategyEnding = true;
  state.activePlayer = undefined;
  openWindow(state, "strategyEnd", {}, clockwiseFrom(state, state.speaker));
}

function endStrategyPhase(state: GameState) {
  state.strategyEnding = false;
  state.disgraced = undefined;
  // Telepathic: the Naalu go first unless they gave the token away.
  const naalu = state.seating.find(
    (id) =>
      !state.players[id].eliminated &&
      ownsAbility(state, id, "telepathic") &&
      !state.players[id].used?.includes("telepathic"),
  );
  if (state.zeroToken === undefined && naalu !== undefined) {
    state.zeroToken = naalu;
    log(state, `${playerName(state, naalu)} placed the "0" token on their strategy card.`, {
      player: naalu,
    });
  }
  for (const id of state.seating) {
    state.players[id].keepsStrategyCards = undefined;
  }
  startActionPhase(state);
}

/** Moves the strategy phase on once nobody is still deciding. */
export function continueStrategyPhase(state: GameState): boolean {
  if (state.phase !== "strategy") return false;
  if (state.lastPick) {
    finishPick(state);
    return true;
  }
  if (state.strategyEnding) {
    endStrategyPhase(state);
    return true;
  }
  return false;
}

// --- Action phase -----------------------------------------------------------

export function startActionPhase(state: GameState) {
  state.phase = "action";
  state.actionsThisTurn = 0;
  state.tradedWith = [];
  state.activePlayer = initiativeOrder(state)[0];
  log(state, `Round ${state.round}: action phase.`);
  startTurn(state, state.activePlayer);
}

export const actionsAllowed = (state: GameState, id: PlayerId) =>
  hasTech(state, id, "fl") ? 2 : 1;

export function requireTurn(state: GameState, id: PlayerId) {
  ensure(state.phase === "action", "It is not the action phase.");
  ensure(state.activePlayer === id, "It is not your turn.");
  ensure(!state.players[id].passed, "You have already passed.");
}

export function requireAction(state: GameState, id: PlayerId) {
  requireTurn(state, id);
  ensure(
    !state.tactical && !state.strategic && !state.queuedStrategic,
    "Finish the action in progress first.",
  );
  ensure(state.prompts.length === 0, "Other players still have decisions to make.");
  ensure(
    state.actionsThisTurn < actionsAllowed(state, id),
    "You have already taken your action this turn.",
  );
}

/** Ends a player's turn at once, as Nullification Field does. */
export function endTurnNow(state: GameState, id: PlayerId) {
  state.tactical = undefined;
  state.strategic = undefined;
  nextTurn(state, id);
}

function nextTurn(state: GameState, from: PlayerId) {
  const order = initiativeOrder(state);
  const start = order.indexOf(from);
  const rotation = [...order.slice(start + 1), ...order.slice(0, start + 1)];
  let next = rotation.find((id) => !state.players[id].passed);
  // Crisis: the next player's turn is skipped.
  if (state.skipTurn && next !== undefined) {
    state.skipTurn = undefined;
    const after = rotation.filter((id) => !state.players[id].passed && id !== next)[0];
    log(state, `${playerName(state, next)}'s turn is skipped.`);
    if (after !== undefined) next = after;
  }
  state.actionsThisTurn = 0;
  state.tradedWith = [];
  for (const id of state.seating) state.players[id].achievements = undefined;
  if (next === undefined) {
    startStatusPhase(state);
    return;
  }
  state.activePlayer = next;
  startTurn(state, next);
}

export function endTurn(state: GameState, id: PlayerId) {
  requireTurn(state, id);
  ensure(
    !state.tactical && !state.strategic,
    "Finish the action in progress first.",
  );
  ensure(state.prompts.length === 0, "Other players still have decisions to make.");
  ensure(state.actionsThisTurn > 0, "Take an action or pass.");
  beginTurnEnd(state, id);
}

/** Offers end-of-turn abilities; the next turn starts once they are settled. */
function beginTurnEnd(state: GameState, id: PlayerId) {
  state.turnEnding = id;
  openWindow(state, "turnEnd", { player: id }, clockwiseFrom(state, id));
}

/** Moves on to the next turn once end-of-turn abilities are settled. */
export function continueTurnEnd(state: GameState): boolean {
  const id = state.turnEnding;
  if (id === undefined || state.phase !== "action") return false;
  state.turnEnding = undefined;
  nextTurn(state, id);
  return true;
}

export function pass(state: GameState, id: PlayerId) {
  requireTurn(state, id);
  ensure(
    !state.tactical && !state.strategic && state.prompts.length === 0,
    "Finish the action in progress first.",
  );
  ensure(state.actionsThisTurn === 0, "You have already taken an action this turn.");
  const player = playerOf(state, id);
  ensure(
    player.strategyCards.every((card) => card.exhausted),
    "You must use your strategy card before you can pass.",
  );
  player.passed = true;
  log(state, `${player.name} passed.`, { player: id });
  breakDuress(state, id);
  // Prove Endurance: the last player to pass.
  if (activePlayers(state).every((other) => state.players[other].passed)) {
    achieve(state, id, "pe");
    // Watchful Ojz unlocks for the last to pass.
    if (player.faction === "ralnel") unlockCommander(state, id);
  }
  beginTurnEnd(state, id);
}

// --- Status phase -----------------------------------------------------------

export function startStatusPhase(state: GameState) {
  state.phase = "status";
  state.activePlayer = undefined;
  state.statusStep = "score";
  log(state, `Round ${state.round}: status phase.`);
  // Scoring happens in initiative order, one player at a time.
  for (const id of [...initiativeOrder(state)].reverse()) {
    ask(state, [{ kind: "scoreObjectives", player: id }]);
  }
  openWindow(state, "statusStart", {}, initiativeOrder(state));
}

export function scoreStatusObjectives(
  state: GameState,
  id: PlayerId,
  publicObjective?: string,
  secretObjective?: string,
  payment?: ObjectivePayment,
) {
  if (publicObjective) {
    requireObjectivePhase(publicObjective, "status");
    ensure(
      state.publicObjectives.some((o) => o.id === publicObjective),
      "That is not a public objective.",
    );
    scoreObjective(state, id, publicObjective, payment);
  }
  if (secretObjective && state.phase !== "finished") {
    requireObjectivePhase(secretObjective, "status");
    ensure(
      state.players[id].secretObjectives.includes(secretObjective),
      "That is not one of your secret objectives.",
    );
    scoreObjective(state, id, secretObjective, publicObjective ? undefined : payment);
  }
  if (!publicObjective && !secretObjective) {
    log(state, `${playerName(state, id)} scored no objectives.`, { player: id });
  }
}

/** Steps 2 to 5 of the status phase, up to redistributing command tokens. */
export function continueStatusPhase(state: GameState): boolean {
  if (state.phase !== "status") return false;

  if (state.statusStep === "score") {
    const next = state.publicObjectives.find((o) => !o.revealed);
    if (!next) {
      // Nothing left to reveal: the game ends (LRR 61.15).
      const leader = [...initiativeOrder(state)].sort(
        (a, b) => victoryPoints(state, b) - victoryPoints(state, a),
      )[0];
      finishGame(state, leader);
      return true;
    }
    next.revealed = true;
    log(state, `A new public objective was revealed.`);

    for (const id of initiativeOrder(state)) {
      drawActionCards(state, id, hasTech(state, id, "nm") ? 2 : 1);
    }
    for (const system of Object.values(state.systems)) {
      system.commandTokens = [];
    }
    state.statusStep = "redistribute";
    const prompts = state.prompts;
    state.prompts = [];
    ask(
      state,
      activePlayers(state).map((id) => ({
        kind: "redistribute" as const,
        player: id,
        gained:
          (hasTech(state, id, "hm") ? 3 : 2) +
          // Versatile
          (ownsAbility(state, id, "versatile") ? 1 : 0),
      })),
    );
    // Hands over the limit are trimmed before tokens are dealt with.
    state.prompts = [...prompts, ...state.prompts];
    openWindow(state, "gainStatusTokens", {}, initiativeOrder(state));
    return true;
  }

  if (state.statusStep === "redistribute") {
    for (const id of state.seating) {
      const player = state.players[id];
      player.exhaustedTechnologies = [];
      player.exhaustedRelics = [];
      if (player.breakthrough) player.breakthrough.exhausted = false;
      for (const leader of player.leaders) readyLeader(state, id, leader.id);
    }
    for (const planet of Object.values(state.planets)) {
      planet.exhausted = false;
      planet.legendaryExhausted = false;
      for (const group of Object.values(planet.units)) {
        for (const stack of Object.values(group)) stack.damaged = 0;
      }
    }
    for (const system of Object.values(state.systems)) {
      for (const group of Object.values(system.space)) {
        for (const stack of Object.values(group)) stack.damaged = 0;
      }
    }
    state.statusStep = "return";
    openWindow(state, "returnStrategyCards", {}, initiativeOrder(state));
    return true;
  }

  if (state.statusStep === "return") {
    for (const id of state.seating) {
      const player = state.players[id];
      if (!player.keepsStrategyCards) player.strategyCards = [];
      player.passed = player.eliminated;
    }
    state.statusStep = "end";
    for (const loan of state.borrowedTechnologies ?? []) {
      const player = state.players[loan.player];
      player.technologies = player.technologies.filter((t) => t !== loan.technology);
    }
    state.borrowedTechnologies = undefined;
    state.severed = undefined;
    statusEndEffects(state);
    openWindow(state, "statusEnd", {}, initiativeOrder(state));
    return true;
  }

  if (state.statusStep === "end") {
    state.statusStep = undefined;
    if (state.custodians) {
      state.round++;
      startStrategyPhase(state);
    } else {
      startAgendaPhase(state);
    }
    return true;
  }
  return false;
}

export function redistribute(
  state: GameState,
  id: PlayerId,
  gained: number,
  pools: CommandPools,
) {
  const received = setPools(state, id, pools, gained);
  log(
    state,
    `${playerName(state, id)} gained ${plural(received, "command token")} and set their pools to ${pools.tactic}/${pools.fleet}/${pools.strategy}.`,
    { player: id },
  );
}

// --- Agenda phase -----------------------------------------------------------

export {
  agendaOutcomes,
  castVotes,
  continueAgendaPhase,
  resolveAgenda,
  startAgendaPhase,
  tallyVotes,
} from "./agenda";
