import { PlayerId } from "~/types";
import { agendasById, strategyCardsById } from "../data";
import { CommandPools, GameState } from "../types";
import {
  controlledPlanets,
  MECATOL_REX,
  planetInfluence,
  planetTraits,
} from "./board";
import { finishGame, victoryPoints } from "./control";
import {
  activePlayers,
  ask,
  clockwiseFrom,
  draw,
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
import { requireObjectivePhase, scoreObjective } from "./objectives";
import { setPools } from "./strategic";

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
  for (const id of state.seating) {
    const player = state.players[id];
    player.strategyCards = [];
    player.passed = player.eliminated;
  }
  state.activePlayer = clockwiseFrom(state, state.speaker)[0];
  log(state, `Round ${state.round}: strategy phase.`);
}

export function availableStrategyCards(state: GameState) {
  const taken = new Set(
    state.seating.flatMap((id) =>
      state.players[id].strategyCards.map((card) => card.id),
    ),
  );
  return state.strategyCards.filter((card) => !taken.has(card));
}

export function pickStrategyCard(state: GameState, id: PlayerId, card: string) {
  ensure(state.phase === "strategy", "It is not the strategy phase.");
  ensure(state.activePlayer === id, "It is not your turn to choose.");
  ensure(
    availableStrategyCards(state).includes(card),
    "That strategy card is not available.",
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

  const order = clockwiseFrom(state, state.speaker);
  const perPlayer = cardsPerPlayer(state);
  const next = Array.from({ length: perPlayer }, (_, round) => round + 1)
    .flatMap((round) =>
      order.filter((p) => state.players[p].strategyCards.length < round),
    )
    .at(0);
  if (next !== undefined) {
    state.activePlayer = next;
    return;
  }

  for (const unpicked of availableStrategyCards(state)) {
    state.strategyCardBonus[unpicked] =
      (state.strategyCardBonus[unpicked] ?? 0) + 1;
  }
  startActionPhase(state);
}

// --- Action phase -----------------------------------------------------------

export function startActionPhase(state: GameState) {
  state.phase = "action";
  state.actionsThisTurn = 0;
  state.tradedWith = [];
  state.activePlayer = initiativeOrder(state)[0];
  log(state, `Round ${state.round}: action phase.`);
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
    !state.tactical && !state.strategic,
    "Finish the action in progress first.",
  );
  ensure(state.prompts.length === 0, "Other players still have decisions to make.");
  ensure(
    state.actionsThisTurn < actionsAllowed(state, id),
    "You have already taken your action this turn.",
  );
}

function nextTurn(state: GameState, from: PlayerId) {
  const order = initiativeOrder(state);
  const start = order.indexOf(from);
  const rotation = [...order.slice(start + 1), ...order.slice(0, start + 1)];
  const next = rotation.find((id) => !state.players[id].passed);
  state.actionsThisTurn = 0;
  state.tradedWith = [];
  if (next === undefined) {
    startStatusPhase(state);
    return;
  }
  state.activePlayer = next;
}

export function endTurn(state: GameState, id: PlayerId) {
  requireTurn(state, id);
  ensure(
    !state.tactical && !state.strategic,
    "Finish the action in progress first.",
  );
  ensure(state.prompts.length === 0, "Other players still have decisions to make.");
  ensure(state.actionsThisTurn > 0, "Take an action or pass.");
  nextTurn(state, id);
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
  nextTurn(state, id);
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
        gained: hasTech(state, id, "hm") ? 3 : 2,
      })),
    );
    // Hands over the limit are trimmed before tokens are dealt with.
    state.prompts = [...prompts, ...state.prompts];
    return true;
  }

  if (state.statusStep === "redistribute") {
    for (const id of state.seating) {
      const player = state.players[id];
      player.exhaustedTechnologies = [];
      player.exhaustedRelics = [];
      if (player.breakthrough) player.breakthrough.exhausted = false;
      for (const leader of player.leaders) {
        if (leader.status === "exhausted") leader.status = "ready";
      }
      player.strategyCards = [];
      player.passed = player.eliminated;
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

export function startAgendaPhase(state: GameState) {
  state.phase = "agenda";
  log(state, `Round ${state.round}: agenda phase.`);
  revealAgenda(state, 1);
}

function revealAgenda(state: GameState, number: number) {
  const card = draw(state, state.decks.agendas);
  state.agenda = { number, card, votes: [], voted: [] };
  if (!card) {
    finishAgenda(state);
    return;
  }
  const agenda = agendasById[card];
  log(state, `Agenda ${number}: ${agenda.name} (${agenda.type}).`);
  // Voting starts left of the speaker, who votes last.
  const order = clockwiseFrom(state, state.speaker);
  const voters = [...order.slice(1), order[0]];
  for (const id of [...voters].reverse()) {
    ask(state, [{ kind: "vote", player: id }]);
  }
}

/** Outcomes that can be voted for on an agenda. */
export function agendaOutcomes(state: GameState, card: string): string[] {
  const agenda = agendasById[card];
  const planets = Object.values(state.planets).filter(
    (p) => p.controller !== undefined,
  );
  const withTrait = (trait: string) =>
    planets
      .filter((p) => planetTraits(state, p.name).includes(trait as never))
      .map((p) => p.name);
  switch (agenda.target) {
    case "forAgainst":
      return ["For", "Against"];
    case "player":
      return activePlayers(state).map((id) => state.players[id].name);
    case "planet":
      return planets.map((p) => p.name);
    case "nonHomePlanet":
      return planets
        .filter(
          (p) =>
            p.name !== MECATOL_REX &&
            state.systems[p.system].homeOf === undefined,
        )
        .map((p) => p.name);
    case "culturalPlanet":
      return withTrait("CULTURAL");
    case "hazardousPlanet":
      return withTrait("HAZARDOUS");
    case "industrialPlanet":
      return withTrait("INDUSTRIAL");
    case "law":
      return state.laws.map((law) => agendasById[law.id].name);
    case "strategyCard":
      return state.strategyCards.map((id) => strategyCardsById[id].name);
    case "scoredSecret":
      return state.seating.flatMap((id) => state.players[id].scoredSecrets);
    default:
      return [];
  }
}

export function castVotes(
  state: GameState,
  id: PlayerId,
  outcome: string | undefined,
  planets: string[],
  extraVotes = 0,
) {
  const agenda = state.agenda;
  ensure(agenda?.card, "There is no agenda to vote on.");
  const player = playerOf(state, id);
  agenda.voted.push(id);

  if (outcome === undefined || (planets.length === 0 && extraVotes === 0)) {
    log(state, `${player.name} abstained.`, { player: id });
    return;
  }
  const outcomes = agendaOutcomes(state, agenda.card);
  ensure(
    outcomes.length === 0 || outcomes.includes(outcome),
    "That is not an outcome of this agenda.",
  );
  ensure(
    new Set(planets).size === planets.length,
    "A planet can only be exhausted once.",
  );
  ensure(
    Number.isInteger(extraVotes) && extraVotes >= 0,
    "Extra votes must be a whole number.",
  );
  let votes = extraVotes;
  for (const name of planets) {
    const planet = state.planets[name];
    ensure(planet?.controller === id, `You do not control ${name}.`);
    ensure(!planet.exhausted, `${name} is already exhausted.`);
    votes += planetInfluence(state, name);
    planet.exhausted = true;
  }
  agenda.votes.push({ player: id, outcome, votes });
  log(state, `${player.name} cast ${plural(votes, "vote")} for ${outcome}.`, {
    player: id,
  });
}

export function tallyVotes(state: GameState) {
  const totals = new Map<string, number>();
  for (const vote of state.agenda?.votes ?? []) {
    totals.set(vote.outcome, (totals.get(vote.outcome) ?? 0) + vote.votes);
  }
  return totals;
}

export function resolveAgenda(state: GameState, outcome: string) {
  const agenda = state.agenda!;
  const card = agendasById[agenda.card!];
  agenda.result = outcome;
  log(state, `${card.name} resolved: ${outcome}.`);

  const against = outcome === "Against";
  const staysInPlay = card.type === "law" && !against;
  if (staysInPlay) {
    const owner = state.seating.find(
      (id) => state.players[id].name === outcome,
    );
    state.laws.push({ id: card.id, outcome, owner });
  } else {
    state.decks.agendas.discard.push(card.id);
  }

  const text =
    card.target === "forAgainst"
      ? against
        ? card.text2
        : card.text1
      : [card.text1, card.text2].filter(Boolean).join("\n");
  ask(state, [
    {
      kind: "resolve",
      player: state.speaker,
      title: `${card.name}: ${outcome}`,
      text,
      card: card.id,
    },
  ]);
}

export function continueAgendaPhase(state: GameState): boolean {
  if (state.phase !== "agenda") return false;
  const agenda = state.agenda;
  if (!agenda) return false;

  if (agenda.card && agenda.result === undefined) {
    const totals = tallyVotes(state);
    const most = Math.max(0, ...totals.values());
    const leaders = [...totals.entries()]
      .filter(([, votes]) => votes === most && votes > 0)
      .map(([outcome]) => outcome);
    if (leaders.length === 1) {
      resolveAgenda(state, leaders[0]);
    } else {
      // A tie, or nobody voted: the speaker decides (LRR 8.19).
      const outcomes =
        leaders.length > 1 ? leaders : agendaOutcomes(state, agenda.card);
      ask(state, [{ kind: "breakTie", player: state.speaker, outcomes }]);
    }
    return true;
  }
  finishAgenda(state);
  return true;
}

function finishAgenda(state: GameState) {
  const agenda = state.agenda!;
  if (agenda.number === 1) {
    revealAgenda(state, 2);
    return;
  }
  for (const id of state.seating) {
    for (const planet of controlledPlanets(state, id)) planet.exhausted = false;
  }
  state.agenda = undefined;
  state.round++;
  startStrategyPhase(state);
}
