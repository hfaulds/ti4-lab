/**
 * The review step: after the agent chooses and before the move is played,
 * the checks look at its choice. If any fire, the agent is asked once more
 * with the warnings, and may keep its move (saying why) or choose again.
 * Warnings, never vetoes.
 */
import { PlayerId } from "~/types";
import { GameAction } from "../actions";
import { GameState } from "../types";
import { Finding, runChecks } from "./checks";
import { Decision, DecisionRequest, MenuEntry, Usage } from "./policy";

export type ReviewRecord = {
  /** The checks the first choice tripped, with their warnings. */
  fired: Finding[];
  /** The label first chosen, and why. */
  first: string;
  firstRationale: string;
  /** Whether the agent kept its first choice once warned. */
  kept: boolean;
  /** Why it kept or changed its choice; empty if asking again failed. */
  rationale: string;
  error?: string;
};

/** Adds one call's usage to another's. */
export function addUsage(into: Usage, from: Usage) {
  for (const k of ["inputTokens", "cachedInputTokens", "outputTokens", "requests", "retries"] as const) {
    into[k] += from[k];
  }
  if (from.costUsd) into.costUsd = (into.costUsd ?? 0) + from.costUsd;
}

/** The turn text for asking again: the position, then what the checks found. */
export function reviewTurn(turn: string, chosen: MenuEntry, fired: Finding[]) {
  return [
    turn,
    "",
    "## A check on your choice",
    `You chose ${chosen.label}. ${chosen.text}`,
    "Before it is played, the checks warn:",
    ...fired.map((f) => `- ${f.warning}`),
    "",
    "These are warnings, not rules: they cannot see everything. Keep it, or choose again? " +
      "Choose the same option to keep it and say in your rationale why the warning does not apply, " +
      "or choose another option.",
  ].join("\n");
}

/**
 * Runs the checks on a decision's choice and, if any fire, asks again with
 * the warnings. Returns the decision to play (the second one, with both
 * calls' steps and usage, when the agent changed its mind) and what the
 * review found. `ask` answers a request, or undefined if the policy failed.
 */
export async function reviewChoice(
  state: GameState,
  seat: PlayerId,
  menu: (MenuEntry & { action: GameAction })[],
  request: DecisionRequest,
  decision: Decision,
  ask: (request: DecisionRequest) => Promise<Decision | undefined>,
): Promise<{ decision: Decision; review?: ReviewRecord }> {
  const picked = menu.find((c) => c.label === decision.label);
  if (!picked) return { decision };
  const fired = runChecks(state, seat, picked.action);
  if (fired.length === 0) return { decision };
  const again = await ask({ ...request, turn: reviewTurn(request.turn, picked, fired) });
  const second = again && menu.find((c) => c.label === again.label);
  const review: ReviewRecord = {
    fired,
    first: picked.label,
    firstRationale: decision.rationale,
    kept: !second || second === picked,
    rationale: second ? again.rationale : "",
    ...(second ? {} : { error: again?.error ?? "No usable answer when asked again." }),
  };
  if (!again) return { decision, review };
  const usage = { ...decision.usage };
  addUsage(usage, again.usage);
  const steps = [...decision.steps, ...again.steps];
  if (!second) return { decision: { ...decision, usage, steps }, review };
  // The answer when warned stands, kept or changed, with its rationale.
  return {
    decision: {
      ...again,
      citations: [...new Set([...decision.citations, ...again.citations])],
      planNote: again.planNote || decision.planNote,
      usage,
      steps,
    },
    review,
  };
}
