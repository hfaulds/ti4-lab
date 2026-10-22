import { describe, expect, test } from "vitest";
import { GameAction } from "../actions";
import { GameState } from "../types";
import { adjacentSystems, MECATOL_REX } from "../engine/board";
import { totalUnits } from "../engine/helpers";
import { strategyKind } from "../engine/strategic";
import { play, testGame } from "../engine/testing";
import { CHECKS, CheckId, emptiedPlanetWarning, runChecks } from "./checks";
import { isStall, systemRef } from "./describe";
import { loggedChoice, readLog, rebuildDecision } from "./evals";
import { bestPlan, scriptedMove } from "./scriptedBot";
import { setupFor } from "./setups";

const newGame = (seed: number) => testGame({ seed, ...setupFor(seed) });

function advance(state: GameState, until: (s: GameState) => boolean) {
  let current = state;
  for (let i = 0; i < 5000 && !until(current); i++) {
    const move = scriptedMove(current)!;
    current = play(current, move.player, move.action);
  }
  return current;
}

const actionPhase = (seed: number) =>
  advance(newGame(seed), (s) => s.phase === "action" && s.prompts.length === 0);

const fired = (state: GameState, seat: number, action: GameAction, check: CheckId) =>
  runChecks(state, seat, action, [check]).map((f) => f.warning);

/** A decision rebuilt from a fixture log, with the option the log played. */
function fixture(file: string, move: number, seat: number) {
  const log = readLog(`evals/fixtures/${file}`);
  const rebuilt = rebuildDecision(log, move, seat);
  return { ...rebuilt, played: loggedChoice(log, rebuilt)! };
}

describe("checks", () => {
  test("each has a distinct id and a description", () => {
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
    for (const check of CHECKS) expect(check.description.length).toBeGreaterThan(0);
  });
});

describe("stranded ground forces", () => {
  const base = actionPhase(1);
  const seat = base.activePlayer!;
  const home = base.players[seat].home;
  const planet = base.systems[home].planets[0];
  const build = (units: { type: "infantry" | "carrier"; count: number }[]): GameAction => ({
    type: "PRODUCE",
    units: units.map((u) => ({ ...u, planet: u.type === "infantry" ? planet : undefined })),
    payment: { planets: [], tradeGoods: 0 },
  });

  test("fire when the ships there cannot carry what is built", () => {
    const state = structuredClone(base);
    state.systems[home].space[seat] = {};
    const [warning] = fired(state, seat, build([{ type: "infantry", count: 4 }]), "stranded-ground-forces");
    expect(warning).toMatch(/adds 4 ground forces .* room for 0 more, so 4 cannot move/);
  });

  test("do not fire when a carrier there has room, or for one infantry too many", () => {
    const state = structuredClone(base);
    state.systems[home].space[seat] = { carrier: { count: 1, damaged: 0 } };
    expect(fired(state, seat, build([{ type: "infantry", count: 4 }]), "stranded-ground-forces")).toEqual([]);
    expect(fired(state, seat, build([{ type: "infantry", count: 5 }]), "stranded-ground-forces")).toEqual([]);
    expect(fired(state, seat, build([{ type: "infantry", count: 6 }]), "stranded-ground-forces")).toHaveLength(1);
    // A carrier built with them carries them.
    state.systems[home].space[seat] = {};
    expect(
      fired(state, seat, build([{ type: "carrier", count: 1 }, { type: "infantry", count: 4 }]), "stranded-ground-forces"),
    ).toEqual([]);
  });

  test("fire for a carrier built where there is nothing to carry", () => {
    const state = structuredClone(base);
    state.systems[home].space[seat] = {};
    for (const p of state.systems[home].planets) {
      const units = state.planets[p].units[seat];
      if (units) state.planets[p].units[seat] = { ...units, infantry: undefined, mech: undefined };
    }
    const [warning] = fired(state, seat, build([{ type: "carrier", count: 1 }]), "stranded-ground-forces");
    expect(warning).toMatch(/adds 1 carrier .* no ground forces for it to carry/);
  });

  test("fire on the logged builds that stranded infantry", () => {
    const creuss = fixture("2026-10-21T15-16-16-185Z-seed5-p0.json.gz", 223, 0);
    expect(fired(creuss.state, 0, creuss.played.action, "stranded-ground-forces")[0]).toMatch(/4 cannot move/);
    const nekro = fixture("2026-10-21T21-07-44-470Z-seed2-all.json.gz", 468, 3);
    expect(fired(nekro.state, 3, nekro.played.action, "stranded-ground-forces")[0]).toMatch(/adds 6 ground forces/);
    // The bot's own build there, 2 infantry, does not.
    expect(fired(nekro.state, 3, nekro.menu[0].action, "stranded-ground-forces")).toEqual([]);
  });
});

describe("objective budget", () => {
  test("fires when a secondary spends the influence Sway the Council needs", () => {
    const { state, menu, played } = fixture("2026-10-21T16-10-17-691Z-seed5-p0.json.gz", 261, 0);
    const [warning] = fired(state, 0, played.action, "objective-budget");
    expect(warning).toMatch(/unable to pay for Sway the Council \(needs 8 influence; you would have 2 influence ready/);
    const skip = menu.find((c) => c.text.startsWith("Skip"))!;
    expect(fired(state, 0, skip.action, "objective-budget")).toEqual([]);
  });

  test("does not fire when the spending meets another objective in its place", () => {
    const { state, menu, played } = fixture("2026-10-21T16-10-17-691Z-seed5-p0.json.gz", 292, 0);
    // Dimensional Splicer meets Diversify Research.
    expect(played.text).toMatch(/Dimensional Splicer/);
    expect(fired(state, 0, played.action, "objective-budget")).toEqual([]);
    const other = menu.find((c) => c.text.includes("Neural Motivator"))!;
    expect(fired(state, 0, other.action, "objective-budget")[0]).toMatch(/Negotiate Trade Routes/);
  });
});

describe("empty planet under threat", () => {
  // Seed 2's first player to act lifts both infantry off Maaluuk, its home planet.
  const base = actionPhase(2);
  const seat = base.activePlayer!;
  const home = base.players[seat].home;
  const activate: GameAction = { type: "ACTIVATE_SYSTEM", system: 9 };

  test("does not fire with no one in reach", () => {
    expect(totalUnits(base.planets.Maaluuk.units[seat])).toBeGreaterThan(0);
    expect(fired(base, seat, activate, "empty-planet-threat")).toEqual([]);
  });

  test("fires when another player's carrier can reach the emptied planet", () => {
    const state = structuredClone(base);
    const other = state.seating.find((id) => id !== seat)!;
    const next = adjacentSystems(state, home).find(
      (k) => k !== 9 && state.systems[k].onBoard && state.seating.every((id) => !totalUnits(state.systems[k].space[id])),
    )!;
    state.systems[next].space[other] = { carrier: { count: 1, damaged: 0 } };
    // The bot keeps a garrison once it sees the carrier, so lift what it
    // planned without it, as an agent's own choice might.
    const cargo = bestPlan(base, seat, 9)!.cargo;
    const warning = emptiedPlanetWarning(state, seat, cargo);
    expect(warning).toMatch(
      new RegExp(`leaves Maaluuk with no ground forces, while P${other} \\(1 carrier\\) can reach ${systemRef(state, home)}`),
    );
    expect(warning).toMatch(/anyone who lands there takes the planet/);
    expect(emptiedPlanetWarning(base, seat, cargo)).toBeUndefined();
  });
});

describe("Imperial to the Mecatol Rex holder", () => {
  const base = advance(newGame(1), (s) => s.phase === "strategy");
  const seat = base.activePlayer!;
  const later = base.seating[(base.seating.indexOf(seat) + 1) % base.seating.length];
  const imperial = base.strategyCards.find((c) => strategyKind(c) === "imperial")!;
  const other = base.strategyCards.find((c) => strategyKind(c) !== "imperial")!;
  const pick = (card: string): GameAction => ({ type: "PICK_STRATEGY_CARD", card });
  const held = (holder: number) => {
    const state = structuredClone(base);
    state.planets[MECATOL_REX].controller = holder;
    return state;
  };

  test("fires when a pick leaves Imperial to a holder yet to pick", () => {
    const [warning] = fired(held(later), seat, pick(other), "imperial-to-mecatol-holder");
    expect(warning).toMatch(new RegExp(`P${later} .* holds Mecatol Rex and has yet to pick`));
  });

  test("does not fire for taking Imperial, holding Mecatol, or a holder who has picked", () => {
    expect(fired(held(later), seat, pick(imperial), "imperial-to-mecatol-holder")).toEqual([]);
    expect(fired(held(seat), seat, pick(other), "imperial-to-mecatol-holder")).toEqual([]);
    expect(fired(base, seat, pick(other), "imperial-to-mecatol-holder")).toEqual([]);
    const picked = held(later);
    picked.players[later].strategyCards = [{ id: other, exhausted: false }];
    expect(fired(picked, seat, pick(other), "imperial-to-mecatol-holder")).toEqual([]);
  });
});

describe("early stall", () => {
  const base = actionPhase(1);
  const seat = base.activePlayer!;
  const key = Object.values(base.systems).find(
    (s) => s.onBoard && totalUnits(s.space[seat]) === 0 && isStall(base, seat, s.key),
  )!.key;
  const stall: GameAction = { type: "ACTIVATE_SYSTEM", system: key };

  test("fires for a do-nothing activation in the first three rounds", () => {
    expect(fired(base, seat, stall, "early-stall")[0]).toMatch(/is a stall:.* In round 1/);
  });

  test("does not fire later, or for a move that does something", () => {
    expect(fired({ ...base, round: 4 }, seat, stall, "early-stall")).toEqual([]);
    expect(fired(base, seat, { type: "ACTIVATE_SYSTEM", system: base.players[seat].home }, "early-stall")).toEqual([]);
  });
});

describe("gravity rift cargo", () => {
  test("fires for ground forces carried through a rift with a way around", () => {
    const { state, menu, played } = fixture("2026-10-21T21-07-44-470Z-seed2-all.json.gz", 477, 4);
    const [warning] = fired(state, 4, played.action, "gravity-rift-cargo");
    expect(warning).toMatch(/carries 1 ground force from #51 through the gravity rift at #41 .* takes 3 moves/);
    const others = menu.filter((c) => c !== played && !c.text.includes("gravity rift"));
    for (const option of others) expect(fired(state, 4, option.action, "gravity-rift-cargo")).toEqual([]);
  });
});
