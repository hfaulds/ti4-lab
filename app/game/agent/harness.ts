/**
 * Plays games with agent seats: routes each decision to the agent's policy
 * or the scripted bot, builds the agent's menu, and records a replay log.
 */
import { createHash } from "node:crypto";
import { PlayerId } from "~/types";
import { GameAction, GameActionType } from "../actions";
import { MoveNote } from "../history";
import { GameState, Prompt } from "../types";
import { victoryPoints } from "../engine/control";
import { openPrompts, totalUnits } from "../engine/helpers";
import { applyAction } from "../engine/index";
import { objectiveStatus } from "../engine/objectives";
import { strategyKind } from "../engine/strategic";
import {
  describeAction,
  describeGame,
  describeTurn,
  isStall,
  stallChoice,
  stallLabel,
} from "./describe";
import { Decision, MenuEntry, noUsage, Plan, Policy, Usage } from "./policy";
import { SYSTEM_PROMPT } from "./rules";
import {
  SCRIPTED_BOT_VERSION,
  scriptedCandidates,
  scriptedMove,
  withWiderChoices,
  secondaryChoices,
  secondarySkipReason,
  productionChoices,
} from "./scriptedBot";
import { lookup, SEARCH_GUIDES_TOOL, SEARCH_LESSONS_TOOL, TOOLS } from "./tools";
import { guideSearch } from "./guides";
import { newTableMemory, remember, TableMemory } from "./conventions";
import type { KnowledgeBase } from "~/knowledge/search";

/** Actions an agent may never take: they bypass the rules. */
export const BLOCKED: ReadonlySet<GameActionType> = new Set<GameActionType>([
  "ADJUST",
  "SET_EXHAUSTED",
  "SET_LEADER",
  "SET_BREAKTHROUGH",
  "COMPONENT_ACTION",
  "RETURN_PROMISSORY_NOTE",
]);

/** Why an agent's action is not allowed, beyond the engine's own rules. */
export function agentBoundaryProblem(
  state: GameState,
  player: PlayerId,
  action: GameAction,
): string | undefined {
  if (BLOCKED.has(action.type)) return `${action.type} is not available to agents.`;
  const claims =
    action.type === "SCORE_OBJECTIVES"
      ? [action.publicObjective, action.secretObjective]
      : action.type === "SCORE_OBJECTIVE"
        ? [action.objective]
        : [];
  for (const objective of claims) {
    if (objective && objectiveStatus(state, player, objective).met === "manual") {
      return "Objectives the engine cannot check may not be claimed.";
    }
  }
  if (action.type === "PROPOSE_TRANSACTION") {
    const sides = [action.give, action.receive];
    if (sides.some((s) => s.promissoryNotes?.length || s.actionCards?.length || s.relicFragments?.length)) {
      return "Agents trade trade goods and commodities only.";
    }
  }
  return undefined;
}

// --- Routing --------------------------------------------------------------------

/** Prompts with real choices in them; the rest go to the scripted bot. */
const AGENT_PROMPTS: ReadonlySet<Prompt["kind"]> = new Set<Prompt["kind"]>([
  "chooseSecret",
  "secondary",
  "scoreObjectives",
  "announceRetreat",
]);

export const ROUTING_VERSION = 3;

/** The agent seat that must decide now, or undefined if the bot plays. */
export function agentToMove(state: GameState, seats: PlayerId[]): PlayerId | undefined {
  if (state.phase === "finished") return undefined;
  const [prompt] = openPrompts(state);
  if (prompt) {
    return seats.includes(prompt.player) && AGENT_PROMPTS.has(prompt.kind)
      ? prompt.player
      : undefined;
  }
  if (state.transactions.length > 0) return undefined;
  const active = state.activePlayer;
  if (active === undefined || !seats.includes(active)) return undefined;
  if (state.phase === "strategy") return active;
  // The agent decides its own builds once its ships have moved.
  if (state.phase === "action" && state.tactical?.player === active && state.tactical.step === "production") {
    return active;
  }
  if (state.phase === "action" && !state.tactical && state.actionsThisTurn === 0) {
    return active;
  }
  return undefined;
}

// --- Menu -----------------------------------------------------------------------

const MAX_ACTIVATIONS = 6;
const MAX_CANDIDATES = 12;
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type Candidate = MenuEntry & {
  action: GameAction;
  /** For the one "Stall" option: every stall on offer, the first played by default. */
  stalls?: GameAction[];
};

/**
 * On the seat's own turn, systems it could activate to stall, which the
 * planner never proposes: empty ones first, so nothing gets locked down.
 */
function stallsFor(state: GameState, seat: PlayerId, offered: GameAction[]): GameAction[] {
  const player = state.players[seat];
  if (
    state.phase !== "action" ||
    state.tactical ||
    state.activePlayer !== seat ||
    openPrompts(state).length > 0 ||
    player.pools.tactic === 0
  ) {
    return [];
  }
  const taken = new Set(
    offered.flatMap((a) => (a.type === "ACTIVATE_SYSTEM" ? [a.system] : [])),
  );
  // Nobody's units first: activating those costs nothing beyond the token.
  const anyone = (s: GameState["systems"][number]) =>
    state.seating.reduce(
      (sum, id) => sum + totalUnits(s.space[id]) + s.planets.reduce((n, p) => n + totalUnits(state.planets[p].units[id]), 0),
      0,
    );
  const systems = Object.values(state.systems)
    .filter((s) => s.onBoard && !s.commandTokens.includes(seat) && !taken.has(s.key))
    .sort(
      (a, b) =>
        totalUnits(a.space[seat]) - totalUnits(b.space[seat]) || anyone(a) - anyone(b) || a.key - b.key,
    );
  const stalls: GameAction[] = [];
  for (const system of systems) {
    if (stalls.length >= MAX_STALLS) break;
    const action: GameAction = { type: "ACTIVATE_SYSTEM", system: system.key };
    if (agentBoundaryProblem(state, seat, action)) continue;
    if (!applyAction(state, seat, action).ok || !isStall(state, seat, system.key)) continue;
    stalls.push(action);
  }
  return stalls;
}

/** Times a model may answer without a usable choice before the bot plays. */
const MODEL_ATTEMPTS = 3;
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 300_000;

const errorText = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

/**
 * Whether a failure is the world rather than the model: the laptop slept,
 * the network dropped, the provider is overloaded. Those are waited out.
 * An API that rejected the request (a 4xx other than timeouts and limits)
 * would only reject it again.
 */
function outage(failure: unknown) {
  const status = (failure as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") return status >= 500 || [408, 409, 429].includes(status);
  if (failure instanceof Error) return true;
  return /timed out|stopped: error|fetch failed|ECONN|socket|terminated|network|overloaded/i.test(String(failure));
}

/**
 * Asks the policy until it answers. Outages are waited out however long
 * they last, with growing pauses, so a game resumes after the laptop
 * wakes; a model that answers without a usable choice gets a few tries.
 */
async function untilAnswered<T extends { error?: string }>(
  ask: () => Promise<T>,
  usable: (answer: T) => boolean,
  onWait?: (ms: number, why: string) => void,
  firstWait = FIRST_WAIT_MS,
): Promise<{ answer?: T; error?: string }> {
  let wait = firstWait;
  let tries = 0;
  for (;;) {
    let answer: T | undefined;
    let why: string;
    try {
      answer = await ask();
      if (usable(answer)) return { answer };
      why = answer.error ?? "No usable answer.";
      if (!outage(why) && ++tries >= MODEL_ATTEMPTS) return { answer, error: why };
      if (!outage(why)) continue;
    } catch (thrown) {
      why = errorText(thrown);
      if (!outage(thrown)) return { error: why };
    }
    onWait?.(wait, why);
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, LONGEST_WAIT_MS);
  }
}

/** Shorter planning replies are not plans, so the previous plan stands. */
const MIN_PLAN_LENGTH = 200;

/** Places offered when the agent chooses to stall. */
const MAX_STALLS = 4;

/**
 * Where to stall, the first stall on the menu first (so taking the first
 * option plays the bot's game), then systems holding nothing of the
 * seat's, whose activation locks nothing down.
 */
function stallMenu(state: GameState, seat: PlayerId, stalls: GameAction[]): Candidate[] {
  const system = (a: GameAction) => (a.type === "ACTIVATE_SYSTEM" ? a.system : 0);
  const [first, ...rest] = stalls;
  const empty = (a: GameAction) => totalUnits(state.systems[system(a)].space[seat]) === 0;
  const ordered = [first, ...rest.filter(empty), ...rest.filter((a) => !empty(a))];
  return ordered.slice(0, MAX_STALLS).map((action, i) => ({
    label: LABELS[i],
    text: stallLabel(state, seat, system(action)),
    action,
  }));
}

/**
 * The legal moves on offer, in the scripted bot's order (its favourite
 * first), without duplicates or blocked actions.
 */
export function buildMenu(
  state: GameState,
  player: PlayerId,
  memory?: TableMemory,
): Candidate[] {
  const ranked = scriptedCandidates(state, memory);
  if (!ranked || ranked.player !== player) return [];
  const seen = new Set<string>();
  const legal: GameAction[] = [];
  let activations = 0;
  const offer = (candidates: GameAction[]) => {
    for (const action of candidates) {
      if (legal.length >= MAX_CANDIDATES) return;
      const key = JSON.stringify(action);
      if (seen.has(key)) continue;
      seen.add(key);
      if (agentBoundaryProblem(state, player, action)) continue;
      if (action.type === "ACTIVATE_SYSTEM" && activations >= MAX_ACTIVATIONS) continue;
      if (!applyAction(state, player, action).ok) continue;
      if (action.type === "ACTIVATE_SYSTEM") activations++;
      legal.push(action);
    }
  };
  offer(withEverySecondary(state, player, ranked.actions));
  // With nothing of its own legal, the bot's fallback plays the move.
  if (legal.length === 0) return [];
  // What the bot's reservations and threshold hide comes after its own picks.
  const wider = withWiderChoices(() => scriptedCandidates(state, memory));
  offer(wider?.actions ?? []);
  if (state.tactical?.step === "production" && state.tactical.player === player) {
    offer(
      productionChoices(state, player, state.tactical.system).map(
        (build): GameAction => ({ type: "PRODUCE", ...build }),
      ),
    );
  }
  legal.push(...stallsFor(state, player, legal));
  // Activations that do nothing are one "Stall" option, where the first was.
  const stalls = legal.filter(
    (a) => a.type === "ACTIVATE_SYSTEM" && isStall(state, player, a.system),
  );
  const entries = legal.filter((a) => !stalls.includes(a) || a === stalls[0]);
  return entries.map((action, i) => ({
    label: LABELS[i],
    ...(action === stalls[0]
      ? { text: stallChoice(stalls.length), stalls }
      : { text: describeAction(state, player, action) }),
    action,
  }));
}

/**
 * For a secondary, every use the player can pay for, not only the bot's
 * picks. The bot's choices come first, so the first option is still what
 * the bot would do (skipping, if it would skip), then the rest.
 */
function withEverySecondary(state: GameState, player: PlayerId, actions: GameAction[]) {
  const [prompt] = openPrompts(state);
  if (prompt?.kind !== "secondary" || prompt.player !== player) return actions;
  const isSkip = (a: GameAction) => a.type === "RESOLVE_SECONDARY" && !a.payload;
  const payloads = secondaryChoices(state, player, prompt);
  // Warfare's secondary builds at home: offer the same builds as a tactical action.
  if (strategyKind(prompt.card) === "warfare" && payloads.length > 0) {
    const home = state.players[player].home;
    for (const production of productionChoices(state, player, home, { docksOnly: true })) {
      payloads.push({ card: "warfare", production });
    }
  }
  const others = payloads.map(
    (payload): GameAction => ({ type: "RESOLVE_SECONDARY", promptId: prompt.id, payload }),
  );
  const picks = actions.filter((a) => !isSkip(a));
  const skip = actions.filter(isSkip);
  // Duplicates of the bot's picks are dropped when the menu is built.
  return picks.length > 0 ? [...picks, ...others, ...skip] : [...skip, ...others];
}

// --- Replay log ---------------------------------------------------------------

export type DecisionRecord = {
  move: number;
  round: number;
  phase: GameState["phase"];
  player: PlayerId;
  menu: MenuEntry[];
  chosen: string;
  /** The bot's top candidate was played because the policy failed. */
  fallback: boolean;
  /** Only one move was legal, so the policy was not asked. */
  forced: boolean;
  rationale: string;
  planNote: string;
  /** Guide passages and lessons the agent cited, as readable labels. */
  citations: string[];
  /** Where the agent stalled, when it chose the Stall option. */
  stall?: { menu: MenuEntry[]; chosen: string; rationale: string };
  steps: Decision["steps"];
  usage: Usage;
  error?: string;
  ms: number;
};

/**
 * What a decision tells a spectator about its move. Moves with only one
 * legal option have nothing to explain.
 */
export function moveNote(record: DecisionRecord): MoveNote | undefined {
  // A move with one option has nothing to explain, unless the harness said
  // why there was only one.
  if (record.forced && !record.rationale) return undefined;
  const option = (label: string) =>
    `${label}. ${record.menu.find((m) => m.label === label)?.text ?? ""}`;
  const where = record.stall?.menu.find((m) => m.label === record.stall?.chosen);
  return {
    chosen: option(record.chosen) + (where ? ` Chose: ${where.text}.` : ""),
    rationale: [record.rationale, record.stall?.rationale].filter(Boolean).join(" "),
    plan: record.planNote || undefined,
    options: record.menu.map((m) => option(m.label)),
    fallback: record.fallback ? (record.error ?? "No choice was made.") : undefined,
    forced: record.forced || undefined,
    citations: record.citations.length > 0 ? record.citations : undefined,
  };
}

/**
 * Why a decision had only one option, where that is worth saying: skipping
 * a secondary the player could not, or the planner would not, use.
 */
function forcedReason(state: GameState, seat: PlayerId, menu: Candidate[]) {
  const [prompt] = openPrompts(state);
  const onlySkip =
    menu.length === 1 &&
    menu[0].action.type === "RESOLVE_SECONDARY" &&
    !menu[0].action.payload;
  if (!onlySkip || prompt?.kind !== "secondary" || prompt.player !== seat) return "";
  return secondarySkipReason(state, seat, prompt);
}

/** Player ids in order, so per-player arrays index by id (seating may differ). */
const playerIds = (state: GameState) =>
  Object.keys(state.players).map(Number).sort((a, b) => a - b);

export type ReplayLog = {
  agentVersion: string;
  policy: string;
  botVersion: number;
  seed?: number;
  /** By player id. */
  factions: string[];
  agentSeats: PlayerId[];
  startedAt: string;
  /** The state the actions are played from; missing in older logs. */
  initialState?: GameState;
  actions: { player: PlayerId; action: GameAction }[];
  decisions: DecisionRecord[];
  result: {
    phase: GameState["phase"];
    round: number;
    winner?: PlayerId;
    /** By player id. */
    vp: number[];
    moves: number;
  };
};

/** A hash of everything that changes how the agent plays. */
export function agentVersion(
  policy: Policy,
  knowledge?: KnowledgeBase,
  briefing = false,
  planning = false,
) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      policy: policy.name,
      prompt: SYSTEM_PROMPT,
      tools: [
        ...TOOLS,
        ...(knowledge ? [SEARCH_GUIDES_TOOL] : []),
        ...(knowledge?.activeLessons ? [SEARCH_LESSONS_TOOL] : []),
      ],
      knowledge: knowledge?.version ?? null,
      briefing,
      planning,
      routing: ROUTING_VERSION,
      bot: SCRIPTED_BOT_VERSION,
      menu: [MAX_ACTIVATIONS, MAX_CANDIDATES],
    }),
  );
  return hash.digest("hex").slice(0, 12);
}

export type PlayOptions = {
  state: GameState;
  agentSeats: PlayerId[];
  policy: Policy;
  /** The strategy guides, searchable by the agent; without it, no search tool. */
  knowledge?: KnowledgeBase;
  /**
   * Search the guides before the agent's strategy pick and its first
   * action-phase decision each round, and put the passages in its prompt,
   * for models that seldom search for themselves.
   */
  briefing?: boolean;
  /**
   * Before each of its own turns (the strategy pick and each action-phase
   * turn), the agent plans in a separate call, then chooses its move with
   * that plan in front of it. Needs a policy that can plan.
   */
  planning?: boolean;
  /** Told when a policy call failed for reasons outside the model and is retried. */
  onWait?: (ms: number, why: string) => void;
  /** The first pause before asking again after an outage, doubling after. */
  firstWaitMs?: number;
  seed?: number;
  maxMoves?: number;
  /** Stops the game early, before the first move made once this holds. */
  until?: (state: GameState) => boolean;
  /** Called after each agent decision, e.g. to print progress. */
  onDecision?: (record: DecisionRecord, state: GameState) => void;
  /**
   * Called after every move with the state it produced, and awaited before
   * the next move, e.g. to mirror the game into the web app.
   */
  onMove?: (
    move: { player: PlayerId; action: GameAction; note?: MoveNote },
    state: GameState,
  ) => Promise<void>;
};

/** Plays a game to the end (or the move budget) and returns its replay log. */
export async function playAgentGame(options: PlayOptions): Promise<ReplayLog> {
  const { agentSeats, policy } = options;
  let state = options.state;
  const planNotes = new Map<PlayerId, string>();
  const memory = newTableMemory();
  const games = new Map<PlayerId, string>();
  // Seat, round and phase of each briefing given, so each is given once.
  const briefed = new Set<string>();
  const log: ReplayLog = {
    agentVersion: agentVersion(
      policy,
      options.knowledge,
      !!options.briefing,
      !!options.planning && !!policy.plan,
    ),
    policy: policy.name,
    botVersion: SCRIPTED_BOT_VERSION,
    seed: options.seed,
    factions: playerIds(state).map((id) => state.players[id].faction),
    agentSeats,
    startedAt: new Date().toISOString(),
    initialState: state,
    actions: [],
    decisions: [],
    result: { phase: state.phase, round: state.round, vp: [], moves: 0 },
  };

  const maxMoves = options.maxMoves ?? 20000;
  for (let move = 0; move < maxMoves; move++) {
    if (options.until?.(state)) break;
    let player: PlayerId;
    let action: GameAction;
    let note: MoveNote | undefined;

    const seat = agentToMove(state, agentSeats);
    const menu = seat !== undefined ? buildMenu(state, seat, memory) : [];
    if (seat !== undefined && menu.length > 0) {
      player = seat;
      const started = Date.now();
      let decision: Decision | undefined;
      let planning: Plan | undefined;
      let error: string | undefined;
      const guides = options.knowledge && guideSearch(options.knowledge, state);
      if (menu.length > 1) {
        if (!games.has(seat)) games.set(seat, describeGame(state, seat));
        const step = state.phase === "strategy" || state.phase === "action" ? state.phase : undefined;
        const key = `${seat}:${state.round}:${step}`;
        const briefing =
          options.briefing && guides && step && !briefed.has(key)
            ? guides.briefing(seat, step)
            : undefined;
        if (briefing) briefed.add(key);
        const request = {
          game: games.get(seat)!,
          turn: describeTurn(state, seat),
          planNote: planNotes.get(seat) ?? "",
          menu: menu.map(({ label, text }) => ({ label, text })),
          lookup: (args: Parameters<typeof lookup>[1]) => lookup(state, args),
          searchGuides: guides?.search,
          searchLessons: guides?.searchLessons,
          briefing,
        };
        // The agent plans before each of its own turns, then moves.
        const ownTurn =
          openPrompts(state).length === 0 &&
          (state.phase === "strategy" || (state.phase === "action" && !state.tactical));
        if (options.planning && policy.plan && ownTurn) {
          const planned = await untilAnswered(
            () => policy.plan!(request),
            (plan) => plan.text.length >= MIN_PLAN_LENGTH,
            options.onWait,
            options.firstWaitMs,
          );
          planning = planned.answer;
          if (planned.error) error = `Planning failed: ${planned.error}`;
          // A reply too short to be a plan ("see above") keeps the last one.
          if (planning?.text && planning.text.length < MIN_PLAN_LENGTH) {
            planning = { ...planning, text: "", error: `Plan too short to use: "${planning.text}"` };
          }
          if (planning?.text) {
            planNotes.set(seat, planning.text);
            request.planNote = planning.text;
            // The planner had the briefing; the plan carries what mattered.
            request.briefing = undefined;
          }
        }
        const decided = await untilAnswered(
          () => policy.decide(request),
          (answer) => menu.some((c) => c.label === answer.label),
          options.onWait,
          options.firstWaitMs,
        );
        decision = decided.answer;
        error = decided.error ?? decision?.error ?? error;
      }
      const picked = menu.find((c) => c.label === decision?.label);
      const chosen = picked ?? menu[0];
      action = chosen.action;
      // Choosing to stall leads to choosing where.
      let stall: DecisionRecord["stall"];
      if (decision && picked?.stalls && picked.stalls.length > 1) {
        const spots = stallMenu(state, seat, picked.stalls);
        const where = (
          await untilAnswered(
            () =>
              policy.decide({
                game: games.get(seat)!,
                turn: `${describeTurn(state, seat)}\n\nYou chose to stall: ${decision!.rationale}\nNow choose where.`,
                planNote: decision!.planNote || (planNotes.get(seat) ?? ""),
                menu: spots.map(({ label, text }) => ({ label, text })),
                lookup: (args) => lookup(state, args),
              }),
            (answer) => spots.some((o) => o.label === answer.label),
            options.onWait,
            options.firstWaitMs,
          )
        ).answer;
        const spot = spots.find((o) => o.label === where?.label) ?? spots[0];
        action = spot.action;
        stall = {
          menu: spots.map(({ label, text }) => ({ label, text })),
          chosen: spot.label,
          rationale: where?.rationale ?? "",
        };
        if (where) {
          decision.steps.push(...where.steps);
          for (const k of ["inputTokens", "cachedInputTokens", "outputTokens", "requests", "retries"] as const) {
            decision.usage[k] += where.usage[k];
          }
          if (where.usage.costUsd) decision.usage.costUsd = (decision.usage.costUsd ?? 0) + where.usage.costUsd;
        }
      }
      // A plan written this turn stands; otherwise the move's note updates it.
      if (decision?.planNote && !planning?.text) planNotes.set(seat, decision.planNote);
      const steps = [
        ...(planning?.steps ?? []),
        ...(planning?.text ? [{ tool: "plan", arguments: "", result: planning.text }] : []),
        ...(decision?.steps ?? []),
      ];
      const usage = decision?.usage ?? noUsage();
      if (planning) {
        for (const k of ["inputTokens", "cachedInputTokens", "outputTokens", "requests", "retries"] as const) {
          usage[k] += planning.usage[k];
        }
        if (planning.usage.costUsd) usage.costUsd = (usage.costUsd ?? 0) + planning.usage.costUsd;
      }
      const cited = [...new Set([...(planning?.citations ?? []), ...(decision?.citations ?? [])])];
      const record: DecisionRecord = {
        move,
        round: state.round,
        phase: state.phase,
        player: seat,
        menu: menu.map(({ label, text }) => ({ label, text })),
        chosen: chosen.label,
        fallback: menu.length > 1 && !picked,
        forced: menu.length === 1,
        rationale: decision?.rationale ?? forcedReason(state, seat, menu),
        planNote: planNotes.get(seat) ?? "",
        citations: cited.map((id) => guides?.label(id) ?? id),
        stall,
        steps,
        usage,
        error,
        ms: Date.now() - started,
      };
      log.decisions.push(record);
      note = moveNote(record);
      options.onDecision?.(record, state);
    } else {
      const scripted = scriptedMove(state, memory);
      if (!scripted) break;
      player = scripted.player;
      action = scripted.action;
    }

    remember(memory, state, player, action);
    const result = applyAction(state, player, action);
    if (!result.ok) {
      throw new Error(`${action.type} by P${player} was rejected: ${result.error}`);
    }
    state = result.state;
    log.actions.push({ player, action });
    await options.onMove?.({ player, action, note }, state);
  }

  log.result = {
    phase: state.phase,
    round: state.round,
    winner: state.winner,
    vp: playerIds(state).map((id) => victoryPoints(state, id)),
    moves: log.actions.length,
  };
  return log;
}
