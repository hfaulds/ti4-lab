import { produce } from "immer";
import { describe, expect, test } from "vitest";
import { FactionId, PlayerId } from "~/types";
import { GameState } from "../types";
import { galvanize, openPrompts } from "./helpers";
import { missingPrerequisites } from "./technology";
import { botMove, play, skipSetup, testGame } from "./testing";

const edit = (state: GameState, change: (draft: GameState) => void) =>
  produce(state, (draft) => {
    change(draft as GameState);
  });

function teGame(factions: FactionId[], seed = 1) {
  let state = skipSetup(testGame({ seed, factions, expansions: ["pok", "te"] }));
  while (state.phase === "strategy") {
    const move = botMove(state)!;
    state = play(state, move.player, move.action);
  }
  return state;
}

const seatOf = (state: GameState, faction: FactionId): PlayerId =>
  state.seating.find((id) => state.players[id].faction === faction)!;

describe("expeditions and breakthroughs", () => {
  test("claiming an expedition slice gains the breakthrough", () => {
    let state = teGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    state = edit(state, (draft) => {
      draft.players[id].tradeGoods = 3;
      draft.actionsThisTurn = 1;
    });
    state = play(state, id, { type: "END_TURN" });
    const window = openPrompts(state).find((p) => p.kind === "window" && p.player === id);
    expect(window).toBeDefined();
    state = play(state, id, {
      type: "USE_ABILITY",
      ability: "expedition",
      targets: { choice: "6" },
      promptId: window!.id,
    });
    expect(state.players[id].tradeGoods).toBe(0);
    expect(state.players[id].breakthrough?.unlocked).toBe(true);
    expect(state.expedition?.[5]).toBe(id);
  });

  test("synergy lets one color stand in for the other", () => {
    let state = teGame(["sol", "hacan", "xxcha"]);
    const sol = seatOf(state, "sol");
    // Sol's synergy pairs biotic and cybernetic.
    state = edit(state, (draft) => {
      draft.players[sol].technologies = ["nm", "st"];
    });
    const before = missingPrerequisites(state, sol, "hm");
    state = edit(state, (draft) => {
      draft.players[sol].breakthrough!.unlocked = true;
    });
    expect(before.length).toBe(1);
    expect(missingPrerequisites(state, sol, "hm")).toEqual([]);
  });
});

describe("galvanize", () => {
  test("galvanized units keep their tokens while some remain", () => {
    const group = { infantry: { count: 3, damaged: 0 } };
    expect(galvanize(group, "infantry", 2)).toBe(2);
    expect(galvanize(group, "infantry", 5)).toBe(1);
    expect(group.infantry).toEqual({ count: 3, damaged: 0, galvanized: 3 });
  });
});
