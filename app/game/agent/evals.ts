/**
 * Evals: decisions rebuilt exactly from replay logs, asked of a policy
 * again, and graded by the checks. A case names a logged decision (a log,
 * a move, a seat) and the checks its choice must not trip; it may also
 * name menu options to choose or avoid, and rationale patterns that mark a
 * misreading ("Negotiate Trade Routes is gone").
 *
 * Rebuilding replays the log's actions from its initial state up to the
 * move, with the table talk the bots kept, so the menu is the one the
 * current code would offer there. The menu may differ from the logged one
 * when the menu text or the bot has changed since; the drift is reported.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { PlayerId } from "~/types";
import { GameState } from "../types";
import { applyAction } from "../engine/index";
import { TableTalk } from "./talk";
import { CheckId, checksById, Finding, runChecks } from "./checks";
import { describeGame, describeTurn } from "./describe";
import { agentToMove, buildMenu, Candidate, DecisionRecord, ReplayLog } from "./harness";
import { Decision, DecisionRequest, noUsage, Policy, Usage } from "./policy";
import { addUsage, reviewChoice, ReviewRecord } from "./review";
import { lookup } from "./tools";

export type EvalCase = {
  id: string;
  description: string;
  /** The replay log, relative to the cases file; gzipped when it ends in .gz. */
  log: string;
  /** The index of the action the decision chose, as in its DecisionRecord. */
  move: number;
  seat: PlayerId;
  /** Checks the chosen move must not trip. */
  checks: CheckId[];
  /** Menu options (by a piece of their text) to choose one of, or to avoid. */
  choose?: string[];
  avoid?: string[];
  /** Patterns (regular expressions, case-insensitive) the rationale must not match. */
  rationaleNot?: string[];
  /** The lesson this case relates to, by id, when there is one. */
  lesson?: string;
};

/** Reads a replay log, gzipped or not. */
export function readLog(path: string): ReplayLog {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as ReplayLog;
}

/**
 * Reads a cases file, checking each case names known checks, and gives a
 * reader for each case's log (relative to the file), read once per log.
 */
export function loadCases(path: string) {
  const cases = JSON.parse(readFileSync(path, "utf8")) as EvalCase[];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Case ${c.id} appears twice.`);
    ids.add(c.id);
    for (const check of c.checks) {
      if (!checksById[check]) throw new Error(`Case ${c.id} names an unknown check: ${check}.`);
    }
  }
  const logs = new Map<string, ReplayLog>();
  const logFor = (c: EvalCase) => {
    const file = resolve(dirname(path), c.log);
    if (!logs.has(file)) logs.set(file, readLog(file));
    return logs.get(file)!;
  };
  return { cases, logFor };
}

/**
 * A log cut down to what cases up to move `through` need, for a fixture:
 * the actions to replay, through the one chosen there, and the decisions
 * before it, keeping only their plans among the tool calls.
 */
export function trimLog(log: ReplayLog, through: number): ReplayLog {
  return {
    ...log,
    actions: log.actions.slice(0, through + 1),
    decisions: log.decisions
      .filter((d) => d.move <= through)
      .map((d) => ({ ...d, steps: d.steps.filter((s) => s.tool === "plan") })),
  };
}

export type RebuiltDecision = {
  state: GameState;
  seat: PlayerId;
  menu: Candidate[];
  request: DecisionRequest;
  talk: TableTalk;
  /** The decision as logged, if the log has it. */
  logged?: DecisionRecord;
  /** Logged menu lines the rebuilt menu does not have, word for word. */
  drift: string[];
};

/** The state before action `move`, and the table talk the bots kept to then. */
export function replayTo(log: ReplayLog, move: number) {
  if (!log.initialState) throw new Error("The log has no initial state, so it cannot be replayed.");
  if (move > log.actions.length) throw new Error(`The log has only ${log.actions.length} actions.`);
  let state = log.initialState;
  const talk = new TableTalk(log.agentSeats);
  for (const [i, { player, action }] of log.actions.slice(0, move).entries()) {
    talk.move = i;
    talk.observe(state, player, action);
    const result = applyAction(state, player, action);
    if (!result.ok) throw new Error(`${action.type} by P${player} was rejected on replay: ${result.error}`);
    state = result.state;
    talk.settle(state);
  }
  talk.move = move;
  return { state, talk };
}

/**
 * The decision at `move`, as the agent would be asked it now: the turn
 * text, the menu, the game block (from the seat's first decision, as in
 * play) and the plan the agent had then. A plan written for this very
 * decision is used as it was, rather than planned again.
 */
export function rebuildDecision(log: ReplayLog, move: number, seat: PlayerId): RebuiltDecision {
  const { state, talk } = replayTo(log, move);
  if (agentToMove(state, [seat]) !== seat) {
    throw new Error(`P${seat} does not decide at move ${move}.`);
  }
  const menu = buildMenu(state, seat, talk);
  if (menu.length < 2) throw new Error(`P${seat} has no choice at move ${move}.`);
  const mine = log.decisions.filter((d) => d.player === seat && d.move <= move);
  const logged = mine.find((d) => d.move === move);
  const first = mine.find((d) => !d.forced) ?? logged;
  const gameState = first && first.move < move ? replayTo(log, first.move).state : state;
  const plan = logged?.steps.find((s) => s.tool === "plan")?.result;
  const before = mine.filter((d) => d.move < move).at(-1);
  const texts = new Set(menu.map((c) => c.text));
  return {
    state,
    seat,
    menu,
    talk,
    logged,
    drift: (logged?.menu ?? []).map((m) => m.text).filter((text) => !texts.has(text)),
    request: {
      game: describeGame(gameState, seat),
      turn: describeTurn(state, seat),
      planNote: plan ?? before?.planNote ?? "",
      menu: menu.map(({ label, text }) => ({ label, text })),
      lookup: (args) => lookup(state, args),
    },
  };
}

export type Grade = { pass: boolean; fired: Finding[]; reasons: string[] };

/** Whether a choice passes a case: no check fired, the option allowed, the rationale sound. */
export function grade(evalCase: EvalCase, rebuilt: RebuiltDecision, chosen: Candidate, rationale = ""): Grade {
  const fired = runChecks(rebuilt.state, rebuilt.seat, chosen.action, evalCase.checks);
  const reasons = fired.map((f) => `${f.check}: ${f.warning}`);
  if (evalCase.choose?.length && !evalCase.choose.some((t) => chosen.text.includes(t))) {
    reasons.push(`chose none of: ${evalCase.choose.join("; ")}`);
  }
  for (const text of evalCase.avoid ?? []) {
    if (chosen.text.includes(text)) reasons.push(`chose an option to avoid: ${text}`);
  }
  for (const pattern of evalCase.rationaleNot ?? []) {
    if (new RegExp(pattern, "i").test(rationale)) reasons.push(`the rationale says ${pattern}`);
  }
  return { pass: reasons.length === 0, fired, reasons };
}

export type EvalRun = {
  label?: string;
  text?: string;
  rationale: string;
  grade?: Grade;
  review?: ReviewRecord;
  usage: Usage;
  error?: string;
};

export type EvalResult = {
  case: EvalCase;
  runs: EvalRun[];
  passes: number;
  /** The logged choice, graded the same way. */
  logged?: { label: string; text: string; grade?: Grade };
  drift: string[];
  usage: Usage;
};

/**
 * Asks the policy a case's decision `repeat` times and grades each answer.
 * With `review`, the answer graded is the one after the review step, so
 * the eval measures play as it is with the checks warning the agent.
 */
export async function runCase(
  evalCase: EvalCase,
  log: ReplayLog,
  policy: Policy,
  options: { repeat?: number; review?: boolean } = {},
): Promise<EvalResult> {
  const rebuilt = rebuildDecision(log, evalCase.move, evalCase.seat);
  const usage = noUsage();
  const runs: EvalRun[] = [];
  for (let i = 0; i < (options.repeat ?? 1); i++) {
    let decision: Decision | undefined;
    let review: ReviewRecord | undefined;
    let error: string | undefined;
    try {
      decision = await policy.decide(rebuilt.request);
      if (options.review && decision.label) {
        const reviewed = await reviewChoice(
          rebuilt.state,
          rebuilt.seat,
          rebuilt.menu,
          rebuilt.request,
          decision,
          (again) => policy.decide(again),
        );
        decision = reviewed.decision;
        review = reviewed.review;
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const chosen = rebuilt.menu.find((c) => c.label === decision?.label);
    const run: EvalRun = {
      label: chosen?.label,
      text: chosen?.text,
      rationale: decision?.rationale ?? "",
      grade: chosen && grade(evalCase, rebuilt, chosen, decision?.rationale),
      review,
      usage: decision?.usage ?? noUsage(),
      error: error ?? decision?.error ?? (chosen ? undefined : "No choice from the menu."),
    };
    addUsage(usage, run.usage);
    runs.push(run);
  }
  const logged = rebuilt.logged;
  const played = loggedChoice(log, rebuilt);
  return {
    case: evalCase,
    runs,
    passes: runs.filter((r) => r.grade?.pass).length,
    logged: logged && {
      label: logged.chosen,
      text: logged.menu.find((m) => m.label === logged.chosen)?.text ?? "",
      grade: played && grade(evalCase, rebuilt, played, logged.rationale),
    },
    drift: rebuilt.drift,
    usage,
  };
}

/** The rebuilt menu's option for the move the log played, found by its action. */
export function loggedChoice(log: ReplayLog, rebuilt: Pick<RebuiltDecision, "logged" | "menu">) {
  const action = JSON.stringify(log.actions[rebuilt.logged?.move ?? -1]?.action);
  return rebuilt.menu.find(
    (c) => JSON.stringify(c.action) === action || c.stalls?.some((s) => JSON.stringify(s) === action),
  );
}

export type ScanHit = {
  decision: DecisionRecord;
  chosen: Candidate;
  fired: Finding[];
  /** The checks each option on the rebuilt menu trips, by label. */
  menu: Record<string, CheckId[]>;
};

/**
 * Every logged choice that trips a check, found by playing the log once:
 * where to look for new eval cases.
 */
export function scanLog(log: ReplayLog, ids?: CheckId[]): ScanHit[] {
  if (!log.initialState) throw new Error("The log has no initial state, so it cannot be replayed.");
  const decisions = new Map(log.decisions.filter((d) => !d.forced).map((d) => [d.move, d]));
  const hits: ScanHit[] = [];
  let state = log.initialState;
  const talk = new TableTalk(log.agentSeats);
  for (const [move, { player, action }] of log.actions.entries()) {
    talk.move = move;
    const decision = decisions.get(move);
    if (decision) {
      const menu = buildMenu(state, decision.player, talk);
      const chosen = loggedChoice(log, { logged: decision, menu });
      const fired = chosen ? runChecks(state, decision.player, chosen.action, ids) : [];
      if (chosen && fired.length > 0) {
        hits.push({
          decision,
          chosen,
          fired,
          menu: Object.fromEntries(
            menu.map((c) => [c.label, runChecks(state, decision.player, c.action, ids).map((f) => f.check)]),
          ),
        });
      }
    }
    talk.observe(state, player, action);
    const result = applyAction(state, player, action);
    if (!result.ok) throw new Error(`${action.type} by P${player} was rejected on replay: ${result.error}`);
    state = result.state;
    talk.settle(state);
  }
  return hits;
}
