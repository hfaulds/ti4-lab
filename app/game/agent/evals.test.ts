import { describe, expect, test } from "vitest";
import { describeTurn } from "./describe";
import { EvalCase, loadCases, readLog, rebuildDecision, runCase, scanLog, trimLog } from "./evals";
import { Decision, FirstCandidatePolicy, noUsage, Policy } from "./policy";

const CASES = "evals/cases.json";
const SWAY = "evals/fixtures/2026-10-21T16-10-17-691Z-seed5-p0.json.gz";

describe("eval cases", () => {
  test("load, and every case rebuilds to its logged decision", () => {
    const { cases, logFor } = loadCases(CASES);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const log = logFor(c);
      const rebuilt = rebuildDecision(log, c.move, c.seat);
      // The decision the log recorded at this move, by the same seat.
      expect(rebuilt.logged?.player).toBe(c.seat);
      expect(rebuilt.menu.length).toBeGreaterThan(1);
    }
  });

  test("rebuild the turn, the menu and the plan the agent had", () => {
    const log = readLog(SWAY);
    const rebuilt = rebuildDecision(log, 261, 0);
    expect(rebuilt.request.turn).toBe(describeTurn(rebuilt.state, 0));
    expect(rebuilt.request.menu.map((m) => m.text)).toEqual(rebuilt.logged!.menu.map((m) => m.text));
    expect(rebuilt.drift).toEqual([]);
    // The plan written for this decision, or else the last one before it.
    const plan = rebuilt.logged!.steps.find((s) => s.tool === "plan")?.result;
    const before = log.decisions.filter((d) => d.player === 0 && d.move < 261).at(-1)!.planNote;
    expect(rebuilt.request.planNote).toBe(plan ?? before);
    expect(rebuilt.request.planNote.length).toBeGreaterThan(0);
  });

  test("refuse a move where the seat does not decide", () => {
    expect(() => rebuildDecision(readLog(SWAY), 262, 0)).toThrow(/does not decide|no choice/);
  });

  test("grade the first-candidate policy, the logged choice, and repeats", async () => {
    const { cases, logFor } = loadCases(CASES);
    const sway = cases.find((c) => c.id === "creuss-leadership-spends-sway-r3")!;
    const result = await runCase(sway, logFor(sway), new FirstCandidatePolicy(), { repeat: 2 });
    expect(result.runs).toHaveLength(2);
    // The bot skips the secondary, which keeps Sway the Council affordable.
    expect(result.passes).toBe(2);
    expect(result.runs[0].text).toMatch(/^Skip the secondary/);
    // The agent's logged choice spent the influence.
    expect(result.logged?.label).toBe("D");
    expect(result.logged?.grade?.pass).toBe(false);
    expect(result.logged?.grade?.fired[0].check).toBe("objective-budget");
  });

  test("grade options to choose or avoid, and the rationale", async () => {
    const { cases, logFor } = loadCases(CASES);
    const ntr = cases.find((c) => c.id === "creuss-tech-thinks-ntr-gone-r3")!;
    const result = await runCase(ntr, logFor(ntr), new FirstCandidatePolicy());
    expect(result.logged?.grade?.reasons.join()).toMatch(/rationale says Negotiate Trade Routes/);
    const avoid: EvalCase = { ...ntr, rationaleNot: [], avoid: ["Skip"] };
    expect((await runCase(avoid, logFor(avoid), new FirstCandidatePolicy())).passes).toBe(0);
  });

  test("with review, grade the choice made after the warning", async () => {
    const { cases, logFor } = loadCases(CASES);
    const sway = cases.find((c) => c.id === "creuss-leadership-spends-sway-r3")!;
    const choose = (label: string, rationale: string): Decision => ({
      label, rationale, planNote: "", citations: [], steps: [], usage: noUsage(),
    });
    // Takes every token at first; skips once warned.
    const policy: Policy = {
      name: "greedy",
      async decide(request) {
        return request.turn.includes("## A check on your choice")
          ? choose("A", "Sway is worth more.")
          : choose(request.menu.at(-1)!.label, "Tokens.");
      },
    };
    const raw = await runCase(sway, logFor(sway), policy);
    expect(raw.passes).toBe(0);
    const reviewed = await runCase(sway, logFor(sway), policy, { review: true });
    expect(reviewed.passes).toBe(1);
    expect(reviewed.runs[0].review?.kept).toBe(false);
  });
});

describe("fixtures and scans", () => {
  test("a trimmed log still rebuilds its last decision", () => {
    const log = readLog(SWAY);
    const trimmed = trimLog(log, 261);
    expect(trimmed.actions).toHaveLength(262);
    expect(trimmed.decisions.every((d) => d.steps.every((s) => s.tool === "plan"))).toBe(true);
    expect(rebuildDecision(trimmed, 261, 0).request.turn).toBe(rebuildDecision(log, 261, 0).request.turn);
  });

  test("a scan finds the logged choices that trip checks", () => {
    const hits = scanLog(readLog(SWAY));
    expect(hits.map((h) => h.decision.move)).toContain(261);
    const sway = hits.find((h) => h.decision.move === 261)!;
    expect(sway.menu.A).toEqual([]);
    expect(sway.menu.D).toContain("objective-budget");
  });
});
