/**
 * The agent's choices at reaction windows and in the agenda phase: each
 * card, ability and note it could use there, with the targets worth
 * naming, its votes, and the speaker's tie-breaks. The scripted bot's own
 * choice always comes first, so taking the first option plays its game.
 */
import { PlayerId } from "~/types";
import {
  abilitiesById,
  actionCardsById,
  agendasById,
  promissoryNotesById,
  strategyCardsById,
  technologiesById,
  UNIT_NAMES,
  unitsById,
  UnitType,
} from "../data";
import { GameAction } from "../actions";
import { EffectTargets, GameState, Prompt, Reaction, WindowId } from "../types";
import { agendaOutcomes, playerByName, tallyVotes } from "../engine/agenda";
import { controlledPlanets, planetInfluence, planetResources } from "../engine/board";
import { victoryPoints } from "../engine/control";
import { openPrompts, totalUnits } from "../engine/helpers";
import { applyAction } from "../engine/index";
import { effectFor, reactionAction, reactionName } from "../engine/reactions";
import { playerLabel, systemLabel } from "./describe";

/** Prompts the agent answers when they hold more than one real choice. */
export const CHOICE_PROMPTS: ReadonlySet<Prompt["kind"]> = new Set<Prompt["kind"]>([
  "window",
  "vote",
  "breakTie",
  "research",
]);

type Window = Extract<Prompt, { kind: "window" }>;

/** Target sets tried per card or ability, and how many of them are kept. */
const MAX_TRIES = 30;
const MAX_PER_REACTION = 4;
/** Outcomes offered for a vote or a rider; the rest are left out. */
const MAX_OUTCOMES = 5;

const UNIT_TYPES = Object.keys(UNIT_NAMES) as UnitType[];

/**
 * The prompt's moves for the agent: the bot's choice, then its other
 * candidates, then everything else the agent could do. Only the bot's
 * candidates may be illegal; the menu drops those.
 */
export function withPromptChoices(
  state: GameState,
  prompt: Prompt,
  botActions: GameAction[],
): GameAction[] {
  const top = botActions.find((a) => applyAction(state, prompt.player, a).ok);
  if (!top) return botActions;
  const rest = botActions.filter((a) => a !== top);
  switch (prompt.kind) {
    case "window":
      return [top, ...rest, ...windowChoices(state, prompt)];
    case "vote":
      return [top, ...rest, ...voteChoices(state, prompt.player)];
    case "breakTie": {
      const outcomes = rankedOutcomes(state, prompt.player, prompt.outcomes);
      return [top, ...outcomes.map((outcome): GameAction => ({ type: "BREAK_TIE", outcome }))];
    }
    default:
      return [top, ...rest];
  }
}

// --- Reactions ------------------------------------------------------------------

/**
 * Whether a play works out if nobody cancels it: it is accepted, and so is
 * every other player passing on cancelling it.
 */
function settles(state: GameState, id: PlayerId, action: GameAction) {
  try {
    let result = applyAction(state, id, action);
    for (let i = 0; i < 12 && result.ok; i++) {
      const [cancel] = openPrompts(result.state).filter(
        (p) => p.kind === "window" && p.window === "actionCardPlayed",
      );
      if (!cancel) return true;
      result = applyAction(result.state, cancel.player, { type: "PASS_WINDOW", promptId: cancel.id });
    }
    return false;
  } catch {
    return false;
  }
}

const unique = <T>(values: (T | undefined)[]) =>
  [...new Set(values.filter((v): v is T => v !== undefined))];

/** Values worth trying for one kind of target, or undefined if it cannot be guessed. */
function targetValues(
  state: GameState,
  id: PlayerId,
  prompt: Window,
  reaction: Reaction,
  kind: keyof EffectTargets,
): EffectTargets[] | undefined {
  const context = prompt.context;
  const player = state.players[id];
  switch (kind) {
    case "player": {
      const others = state.seating
        .filter((p) => p !== id && !state.players[p].eliminated)
        .sort((a, b) => victoryPoints(state, b) - victoryPoints(state, a));
      return [...others, id].map((p) => ({ player: p }));
    }
    case "outcome":
      if (!state.agenda?.card) return undefined;
      return rankedOutcomes(state, id, agendaOutcomes(state, state.agenda.card))
        .slice(0, MAX_OUTCOMES)
        .map((outcome) => ({ outcome }));
    case "planet": {
      const own = [...controlledPlanets(state, id)]
        .sort((a, b) => planetValue(state, b.name) - planetValue(state, a.name))
        .map((p) => p.name);
      const here = context.system !== undefined ? state.systems[context.system]?.planets ?? [] : [];
      return unique([context.planet, ...here, ...own]).slice(0, 5).map((planet) => ({ planet }));
    }
    case "system": {
      const ships = Object.values(state.systems)
        .filter((s) => totalUnits(s.space[id]) > 0)
        .map((s) => s.key);
      return unique([context.system, state.tactical?.system, player.home, ...ships])
        .slice(0, 5)
        .map((system) => ({ system }));
    }
    case "amount":
      return unique([1, 2, 3, player.tradeGoods])
        .filter((n) => n > 0)
        .map((amount) => ({ amount }));
    case "technology": {
      if (context.player === undefined) return undefined;
      const owned = new Set(player.technologies);
      return state.players[context.player].technologies
        .filter((t) => !owned.has(t))
        .slice(0, 4)
        .map((technology) => ({ technology }));
    }
    case "unit":
      return UNIT_TYPES.map((unit) => ({ unit }));
    case "choice": {
      const choices: Record<string, string[]> = {
        pillage: ["tradeGood", "commodity"],
        iff: ["alpha", "beta"],
      };
      return choices[reaction.id]?.map((choice) => ({ choice }));
    }
    default:
      return undefined;
  }
}

/**
 * Each usable card, ability and note in a window with target sets the
 * engine accepts. Ones whose choices cannot be guessed (payments, units to
 * move or build) are left to the bot's own plays.
 */
function windowChoices(state: GameState, prompt: Window): GameAction[] {
  const id = prompt.player;
  const actions: GameAction[] = [];
  for (const reaction of prompt.options) {
    const name = reactionName(reaction);
    // A rider's reward goes where the engine would put it; only the prediction matters.
    const kinds = name.endsWith(" Rider") ? ["outcome" as const] : effectFor(reaction)?.targets ?? [];
    const values = kinds.map((kind) => targetValues(state, id, prompt, reaction, kind));
    if (values.some((v) => v === undefined || v.length === 0)) continue;
    let combos: EffectTargets[] = [{}];
    for (const options of values as EffectTargets[][]) {
      combos = combos.flatMap((combo) => options.map((option) => ({ ...combo, ...option })));
    }
    let kept = 0;
    for (const targets of combos.slice(0, MAX_TRIES)) {
      if (kept >= MAX_PER_REACTION) break;
      const action = reactionAction(reaction, targets, prompt.id);
      if (!settles(state, id, action)) continue;
      actions.push(action);
      kept++;
    }
  }
  return actions;
}

// --- Agenda -----------------------------------------------------------------------

const planetValue = (state: GameState, name: string) =>
  planetResources(state, name) + planetInfluence(state, name);

/**
 * Outcomes in the order worth offering them to a player: for and against,
 * the player, then the others; their own planets, then the most valuable.
 */
function rankedOutcomes(state: GameState, id: PlayerId, outcomes: string[]) {
  const rank = (outcome: string) => {
    const player = playerByName(state, outcome);
    if (player !== undefined) return player === id ? -100 : -victoryPoints(state, player);
    const planet = state.planets[outcome];
    if (planet) return (planet.controller === id ? -100 : 0) - planetValue(state, outcome);
    return 0;
  };
  return outcomes
    .map((outcome, i) => ({ outcome, i, rank: rank(outcome) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((o) => o.outcome);
}

const representativeGovernment = (state: GameState) =>
  state.laws.some((l) => l.id === "representative_government" && l.outcome !== "Against");

/** Ready planets that give votes, the cheapest to lose first. */
function votingPlanets(state: GameState, id: PlayerId) {
  return controlledPlanets(state, id)
    .filter((p) => !p.exhausted && planetInfluence(state, p.name) > 0)
    .map((p) => p.name)
    .sort(
      (a, b) =>
        planetValue(state, a) - planetValue(state, b) ||
        planetInfluence(state, b) - planetInfluence(state, a) ||
        a.localeCompare(b),
    );
}

/**
 * Votes for each outcome: the fewest planets that would put it ahead of
 * the votes cast so far, and every planet the player has ready.
 */
function voteChoices(state: GameState, id: PlayerId): GameAction[] {
  const card = state.agenda?.card;
  if (!card) return [];
  const outcomes = rankedOutcomes(state, id, agendaOutcomes(state, card)).slice(0, MAX_OUTCOMES);
  if (representativeGovernment(state)) {
    return outcomes.map((outcome): GameAction => ({ type: "CAST_VOTES", outcome, planets: [] }));
  }
  const planets = votingPlanets(state, id);
  if (planets.length === 0) return [];
  const totals = tallyVotes(state);
  const actions: GameAction[] = [];
  for (const outcome of outcomes) {
    const rival = Math.max(0, ...[...totals].filter(([o]) => o !== outcome).map(([, v]) => v));
    const needed = Math.max(1, rival + 1 - (totals.get(outcome) ?? 0));
    const fewest: string[] = [];
    let votes = 0;
    for (const planet of planets) {
      if (votes >= needed) break;
      fewest.push(planet);
      votes += planetInfluence(state, planet);
    }
    actions.push({ type: "CAST_VOTES", outcome, planets: fewest });
    if (fewest.length < planets.length) {
      actions.push({ type: "CAST_VOTES", outcome, planets: [...planets] });
    }
  }
  return actions;
}

/**
 * What an outcome of a For/Against agenda does, from its card. An elected
 * outcome does the same whoever is elected, so the agenda says it once.
 */
function outcomeEffect(card: string, outcome: string) {
  const agenda = agendasById[card];
  if (agenda?.target !== "forAgainst") return "";
  return (outcome === "Against" ? agenda.text2 : agenda.text1).replace(/^(For|Against):\s*/, "");
}

/** An outcome by name, with whose it is when it is a player or a planet. */
function outcomeLabel(state: GameState, outcome: string) {
  const player = playerByName(state, outcome);
  if (player !== undefined) return `${outcome} (${playerLabel(state, player)})`;
  const planet = state.planets[outcome];
  if (planet) {
    const owner = planet.controller !== undefined ? `P${planet.controller}'s` : "nobody's";
    return `${outcome} (${owner}, ${planetResources(state, outcome)}/${planetInfluence(state, outcome)})`;
  }
  return outcome;
}

// --- Menu text ---------------------------------------------------------------------

/** What a card, ability or note says, on one line. */
const reactionText = (state: GameState, reaction: Reaction) =>
  cardText(state, reaction).replace(/\s*\n\s*/g, " ");

function cardText(state: GameState, reaction: Reaction) {
  switch (reaction.kind) {
    case "actionCard":
      return actionCardsById[reaction.id]?.text ?? "";
    case "promissoryNote":
      return (promissoryNotesById[reaction.id]?.text ?? "").replace(/<color>/g, `P${reaction.owner}`);
    case "ability":
      return (
        abilitiesById[reaction.id]?.text ??
        technologiesById[reaction.id]?.text ??
        unitsById[reaction.id]?.ability ??
        agendasById[reaction.id]?.text1 ??
        ""
      );
  }
}

function reactionKind(reaction: Reaction) {
  switch (reaction.kind) {
    case "actionCard":
      return "action card";
    case "promissoryNote":
      return `P${reaction.owner}'s promissory note`;
    case "ability":
      return abilitiesById[reaction.id]
        ? "faction ability"
        : technologiesById[reaction.id]
          ? "technology"
          : unitsById[reaction.id]
            ? "unit ability"
            : "law";
  }
}

function targetsText(state: GameState, targets: EffectTargets | undefined) {
  if (!targets) return "";
  const parts = [
    targets.player !== undefined ? `targeting ${playerLabel(state, targets.player)}` : "",
    targets.outcome ? `predicting ${outcomeLabel(state, targets.outcome)}` : "",
    targets.planet ? `on ${targets.planet}` : "",
    targets.planets?.length ? `with ${targets.planets.join(", ")}` : "",
    targets.system !== undefined ? `in ${systemLabel(state, targets.system)}` : "",
    targets.technology ? `taking ${technologiesById[targets.technology]?.name ?? targets.technology}` : "",
    targets.unit ? `choosing a ${UNIT_NAMES[targets.unit] ?? targets.unit}` : "",
    targets.amount !== undefined ? `amount ${targets.amount}` : "",
    targets.choice ? `choosing ${targets.choice}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(", ")}` : "";
}

const readyValue = (state: GameState, id: PlayerId, without: string[]) => {
  const ready = controlledPlanets(state, id).filter((p) => !p.exhausted && !without.includes(p.name));
  return {
    resources: ready.reduce((sum, p) => sum + planetResources(state, p.name), 0),
    influence: ready.reduce((sum, p) => sum + planetInfluence(state, p.name), 0),
  };
};

/** Menu text for the moves this module offers, or undefined for any other move. */
export function describeChoice(
  state: GameState,
  seat: PlayerId,
  action: GameAction,
): string | undefined {
  const [prompt] = openPrompts(state);
  if (!prompt || prompt.player !== seat || !CHOICE_PROMPTS.has(prompt.kind)) return undefined;
  const play = (reaction: Reaction, targets?: EffectTargets) =>
    `Play ${reactionName(reaction)} (${reactionKind(reaction)})${targetsText(state, targets)}: ` +
    reactionText(state, reaction);
  switch (action.type) {
    case "PLAY_ACTION_CARD":
      return play({ kind: "actionCard", id: action.card }, action.targets);
    case "USE_ABILITY":
      return play({ kind: "ability", id: action.ability }, action.targets);
    case "PLAY_PROMISSORY_NOTE":
      return play({ kind: "promissoryNote", id: action.note, owner: action.owner }, action.targets);
    case "PASS_WINDOW":
      return "Pass: use nothing now";
    case "CAST_VOTES": {
      const card = state.agenda?.card;
      if (action.outcome === undefined || !card) return "Abstain: cast no votes and keep your planets ready";
      const effect = outcomeEffect(card, action.outcome);
      const outcome = `${outcomeLabel(state, action.outcome)}${effect ? `. Outcome: ${effect}` : ""}`;
      if (action.planets.length === 0) return `Vote with your 1 vote (Representative Government) for ${outcome}`;
      const votes = action.planets.reduce((sum, p) => sum + planetInfluence(state, p), 0);
      const left = readyValue(state, seat, action.planets);
      return `Vote with ${votes} votes, exhausting ${action.planets
        .map((p) => `${p} ${planetResources(state, p)}/${planetInfluence(state, p)}`)
        .join(", ")} (they stay exhausted through the next round; ` +
        `${left.resources} resources and ${left.influence} influence stay ready), for ${outcome}`;
    }
    case "BREAK_TIE": {
      const card = state.agenda?.card;
      const effect = card ? outcomeEffect(card, action.outcome) : "";
      return `Choose ${outcomeLabel(state, action.outcome)} as the outcome${effect ? `: ${effect}` : ""}`;
    }
    case "RESEARCH":
      return action.research.length === 0
        ? "Research nothing"
        : `Research ${action.research
            .map((r) => technologiesById[r.technology]?.name ?? r.technology)
            .join(" and ")} for free`;
    default:
      return undefined;
  }
}

// --- The moment -------------------------------------------------------------------

const WINDOW_TEXT: Record<WindowId, string> = {
  actionCardPlayed: "an action card was just played and may be cancelled",
  turnStart: "the start of a turn",
  afterActivate: "a system was just activated",
  afterMove: "ships just moved",
  beforeSpaceCannonHits: "space cannon hits are about to be assigned",
  combatStart: "a combat is starting",
  roundStart: "a combat round is starting",
  afterRolls: "combat dice were just rolled",
  beforeCombatHits: "combat hits are about to be assigned",
  afterSustain: "a ship just used Sustain Damage",
  afterShipDestroyed: "a ship was just destroyed",
  afterUnitDestroyed: "a unit was just destroyed",
  roundEnd: "a combat round just ended",
  afterRetreat: "a retreat was just announced",
  afterCombat: "a combat just ended",
  invasionStart: "an invasion is starting",
  afterCommit: "ground forces were just committed",
  groundCombatStart: "a ground combat is starting",
  afterGainControl: "a planet just changed hands",
  afterProduce: "units were just produced",
  afterPlaceDock: "a space dock was just placed",
  afterTacticalAction: "a tactical action just ended",
  afterAction: "an action just ended",
  afterGainTradeGoods: "a player just gained trade goods",
  afterReplenish: "a player just replenished commodities",
  afterStrategicAction: "a strategic action just ended",
  afterResearch: "a technology was just researched",
  strategyStart: "the strategy phase is starting",
  afterPickStrategyCard: "a strategy card was just picked",
  strategyEnd: "the strategy phase is ending",
  statusStart: "the status phase is starting",
  returnStrategyCards: "strategy cards are about to be returned",
  gainStatusTokens: "command tokens are about to be gained in the status phase",
  statusEnd: "the status phase is ending",
  agendaStart: "the agenda phase is starting",
  agendaRevealed: "an agenda was just revealed",
  afterAgendaRevealed: "an agenda was revealed and voting has not started",
  afterSpeakerVotes: "the speaker has voted, before votes are counted",
  afterVote: "you just voted",
  whenElected: "you were just elected",
};

/** A card or other thing a window names, by its name. */
const cardLabel = (card: string) =>
  actionCardsById[card]?.name ??
  agendasById[card]?.name ??
  strategyCardsById[card]?.name ??
  technologiesById[card]?.name ??
  card;

function windowLines(state: GameState, prompt: Window): string[] {
  const context = prompt.context;
  const parts = [
    context.player !== undefined ? `player ${playerLabel(state, context.player)}` : "",
    context.system !== undefined ? `system ${systemLabel(state, context.system)}` : "",
    context.planet ? `planet ${context.planet}` : "",
    context.card ? `card ${cardLabel(context.card)}` : "",
  ].filter(Boolean);
  const lines = [
    `Reaction window: ${WINDOW_TEXT[prompt.window]}${parts.length ? ` (${parts.join(", ")})` : ""}.`,
  ];
  if (prompt.window === "actionCardPlayed" && context.card && context.player !== undefined) {
    lines.push(`${playerLabel(state, context.player)} played ${cardLabel(context.card)}: ${actionCardsById[context.card]?.text ?? ""}`);
  }
  lines.push(
    "You can use these now (each is on your menu where the engine can carry it out):",
    ...prompt.options.map(
      (r) => `- ${reactionName(r)} (${reactionKind(r)}): ${reactionText(state, r)}`,
    ),
  );
  return lines;
}

function agendaLines(state: GameState, seat: PlayerId): string[] {
  const agenda = state.agenda;
  const card = agenda?.card ? agendasById[agenda.card] : undefined;
  if (!agenda || !card) return [];
  const lines = [
    `Agenda ${agenda.number} of 2: ${card.name} (${card.type}). ${card.targetText}.`,
  ];
  if (card.target === "forAgainst") {
    lines.push(`- ${card.text1}`, `- ${card.text2}`);
  } else {
    lines.push(`- Outcome: ${card.text1}`);
  }
  const votes = agenda.votes.map((v) => `P${v.player} ${v.votes} for ${v.outcome}`);
  const abstained = agenda.voted.filter((p) => !agenda.votes.some((v) => v.player === p));
  lines.push(
    `Votes so far: ${votes.join("; ") || "none"}${abstained.length ? `. Abstained: ${abstained.map((p) => `P${p}`).join(", ")}` : ""}.`,
  );
  for (const p of agenda.predictions ?? []) {
    lines.push(`P${p.player} predicted ${p.outcome} with ${p.card}.`);
  }
  const ready = votingPlanets(state, seat).reduce((sum, p) => sum + planetInfluence(state, p), 0);
  lines.push(
    `The outcome with the most votes wins; on a tie, or if nobody votes, the speaker (P${state.speaker}) chooses. ` +
      `You have ${ready} votes in ready planets' influence. Planets exhausted to vote stay exhausted until the next ` +
      "status phase, so they pay for nothing next round (builds, technology, command tokens or spend objectives).",
  );
  return lines;
}

/**
 * What the agent is deciding at a window, a vote or a tie-break: the
 * moment, the agenda, and the cards it holds. Empty for any other decision.
 */
export function describeMoment(state: GameState, seat: PlayerId): string {
  const [prompt] = openPrompts(state);
  if (!prompt || prompt.player !== seat || !CHOICE_PROMPTS.has(prompt.kind)) return "";
  const lines = ["## This decision"];
  if (prompt.kind === "window") lines.push(...windowLines(state, prompt));
  if (prompt.kind === "vote") lines.push("Cast your votes on the agenda, or abstain.");
  if (prompt.kind === "breakTie") lines.push("As speaker, choose the outcome: the vote was tied, or nobody voted.");
  if (prompt.kind === "research") lines.push(`Research up to ${prompt.count} technology for free.`);
  if (state.phase === "agenda") lines.push(...agendaLines(state, seat));
  const hand = state.players[seat].actionCards;
  lines.push(
    `Your action cards: ${hand.map((c) => `${actionCardsById[c]?.name ?? c} (${actionCardsById[c]?.text ?? ""})`).join("; ") || "none"}.`,
  );
  return lines.join("\n");
}
