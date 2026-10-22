import { describe, expect, test } from "vitest";
import { testGame } from "../engine/testing";
import { readLog, rebuildDecision } from "./evals";
import { playAgentGame } from "./harness";
import { Decision, DecisionRequest, noUsage, Policy } from "./policy";
import { reviewChoice } from "./review";
import { setupFor } from "./setups";

const answer = (label: string, rationale: string): Decision => ({
  label,
  rationale,
  planNote: "",
  citations: [],
  steps: [{ tool: "choose", arguments: label, result: "" }],
  usage: { ...noUsage(), requests: 1, inputTokens: 10 },
});

const warned = (request: DecisionRequest) => request.turn.includes("## A check on your choice");

describe("the review step", () => {
  // Creuss's round-2 build at home, with no ships there to carry infantry.
  const rebuilt = rebuildDecision(readLog("evals/fixtures/2026-10-21T15-16-16-185Z-seed5-p0.json.gz"), 223, 0);
  const stranding = rebuilt.menu.find((c) => c.text.startsWith("Build 4 infantry on Creuss, 1 destroyer"))!;
  const withCarrier = rebuilt.menu.find((c) => c.text.includes("1 carrier"))!;
  const nothing = rebuilt.menu.find((c) => c.text === "Build nothing")!;
  const review = (first: Decision, again: (request: DecisionRequest) => Decision) => {
    const asked: DecisionRequest[] = [];
    const result = reviewChoice(rebuilt.state, 0, rebuilt.menu, rebuilt.request, first, async (request) => {
      asked.push(request);
      return again(request);
    });
    return { result, asked };
  };

  test("asks again with the warning, and plays the changed choice", async () => {
    const { result, asked } = review(answer(stranding.label, "More infantry."), () =>
      answer(withCarrier.label, "A carrier to move them."),
    );
    const { decision, review: record } = await result;
    expect(asked).toHaveLength(1);
    expect(asked[0].turn).toContain(rebuilt.request.turn);
    expect(asked[0].turn).toMatch(/You chose .*Build 4 infantry[\s\S]*4 cannot move until a carrier comes[\s\S]*Keep it, or choose again\?/);
    expect(decision.label).toBe(withCarrier.label);
    expect(decision.rationale).toBe("A carrier to move them.");
    expect(decision.usage.requests).toBe(2);
    expect(decision.steps).toHaveLength(2);
    expect(record).toMatchObject({
      first: stranding.label,
      firstRationale: "More infantry.",
      kept: false,
      rationale: "A carrier to move them.",
    });
    expect(record!.fired.map((f) => f.check)).toContain("stranded-ground-forces");
  });

  test("lets the agent keep its choice and say why", async () => {
    const { result } = review(answer(stranding.label, "More infantry."), () =>
      answer(stranding.label, "They guard home; the carrier comes next turn."),
    );
    const { decision, review: record } = await result;
    expect(decision.label).toBe(stranding.label);
    expect(record).toMatchObject({ kept: true, rationale: "They guard home; the carrier comes next turn." });
  });

  test("keeps the first choice when asking again fails", async () => {
    const first = answer(stranding.label, "More infantry.");
    const { result } = review(first, () => ({ ...answer("Z", ""), label: undefined, error: "No choice." }));
    const { decision, review: record } = await result;
    expect(decision.label).toBe(stranding.label);
    expect(record).toMatchObject({ kept: true, error: "No choice." });
  });

  test("does not ask when no check fires", async () => {
    const { result, asked } = review(answer(nothing.label, "Save the trade goods."), () => {
      throw new Error("asked");
    });
    const { decision, review: record } = await result;
    expect(asked).toHaveLength(0);
    expect(record).toBeUndefined();
    expect(decision.label).toBe(nothing.label);
  });
});

describe("review in play", () => {
  /** Stalls whenever it can, and takes the bot's pick once warned. */
  const staller = (): Policy & { warnings: number } => ({
    name: "staller",
    warnings: 0,
    async decide(request) {
      if (warned(request)) {
        this.warnings++;
        return answer(request.menu[0].label, "Warned off stalling.");
      }
      const stall = request.menu.find((m) => m.text.startsWith("Stall:"));
      return answer((stall ?? request.menu[0]).label, "Stalling.");
    },
  });
  const game = (policy: Policy, review?: boolean) =>
    playAgentGame({
      state: testGame({ seed: 3, ...setupFor(3) }),
      agentSeats: [0],
      policy,
      review,
      until: (s) => s.round > 1,
    });

  test("records what fired and the changed move", async () => {
    const policy = staller();
    const log = await game(policy);
    const reviewed = log.decisions.filter((d) => d.review);
    expect(reviewed.length).toBeGreaterThan(0);
    expect(reviewed.length).toBe(policy.warnings);
    for (const d of reviewed) {
      expect(d.review!.fired.map((f) => f.check)).toContain("early-stall");
      expect(d.review!.kept).toBe(false);
      expect(d.chosen).not.toBe(d.review!.first);
      expect(d.menu.find((m) => m.label === d.chosen)?.text.startsWith("Stall:")).toBe(false);
      expect(d.rationale).toBe("Warned off stalling.");
    }
  });

  test("is skipped when turned off", async () => {
    const policy = staller();
    const log = await game(policy, false);
    expect(policy.warnings).toBe(0);
    expect(log.decisions.some((d) => d.review)).toBe(false);
    expect(log.decisions.some((d) => d.stall)).toBe(true);
  });
});
