import { describe, expect, test } from "vitest";
import { GameState } from "../types";
import { openPrompts } from "../engine/helpers";
import { play, testGame } from "../engine/testing";
import { agentToMove, buildMenu, playAgentGame } from "./harness";
import { describeMoment } from "./choices";
import { newTableMemory, remember } from "./conventions";
import { FirstCandidatePolicy } from "./policy";
import { scriptedMove } from "./scriptedBot";
import { setupFor } from "./setups";

const newGame = (seed: number) => testGame({ seed, ...setupFor(seed) });

/** Every state of a bot game up to its end, with the move that left it. */
function botGame(seed: number) {
  let state = newGame(seed);
  const states: GameState[] = [];
  for (let i = 0; i < 20000 && state.phase !== "finished"; i++) {
    states.push(state);
    const move = scriptedMove(state)!;
    state = play(state, move.player, move.action);
  }
  return states;
}

const states = botGame(5);
const openKind = (s: GameState) => openPrompts(s)[0]?.kind;

describe("reactions and votes", () => {
  test("go to the agent only when it has more than one thing to do", () => {
    let routed = 0;
    for (const state of states.filter((s) => openKind(s) === "window")) {
      const [prompt] = openPrompts(state);
      const menu = buildMenu(state, prompt.player);
      expect(agentToMove(state, [prompt.player])).toBe(menu.length > 1 ? prompt.player : undefined);
      if (menu.length > 1) routed++;
    }
    expect(routed).toBeGreaterThan(5);

    // With nothing left to use, a window is the bot's to pass.
    const window = states.find(
      (s) => openKind(s) === "window" && agentToMove(s, [openPrompts(s)[0].player]) !== undefined,
    )!;
    const emptied = structuredClone(window);
    const [prompt] = openPrompts(emptied);
    if (prompt.kind === "window") prompt.options = [];
    expect(agentToMove(emptied, [prompt.player])).toBe(undefined);
  });

  test("menus put the bot's choice first, then Pass, then each usable play", () => {
    for (const state of states.filter((s) => openKind(s) === "window")) {
      const [prompt] = openPrompts(state);
      const menu = buildMenu(state, prompt.player);
      if (menu.length < 2) continue;
      expect(menu[0].action).toEqual(scriptedMove(state)!.action);
      expect(menu.some((c) => c.action.type === "PASS_WINDOW")).toBe(true);
      for (const c of menu.filter((c) => c.action.type !== "PASS_WINDOW")) {
        expect(c.text).toMatch(/^Play .+: \S/);
      }
      expect(describeMoment(state, prompt.player)).toMatch(/Reaction window/);
    }
  });

  test("vote menus offer abstaining first and votes for real outcomes", () => {
    const votes = states.filter((s) => openKind(s) === "vote");
    expect(votes.length).toBeGreaterThan(0);
    let offered = 0;
    for (const state of votes) {
      const [prompt] = openPrompts(state);
      const menu = buildMenu(state, prompt.player);
      expect(menu[0].action).toEqual({ type: "CAST_VOTES", planets: [] });
      expect(menu[0].text).toMatch(/^Abstain/);
      for (const c of menu.slice(1)) {
        if (c.action.type !== "CAST_VOTES") throw new Error("Not a vote.");
        expect(c.action.outcome).toBeDefined();
        expect(c.action.planets.length).toBeGreaterThan(0);
        expect(c.text).toMatch(/^Vote with \d+ votes, exhausting .+ stay exhausted through the next round/);
        offered++;
      }
      const moment = describeMoment(state, prompt.player);
      expect(moment).toContain(`Agenda ${state.agenda!.number} of 2`);
      expect(moment).toMatch(/speaker \(P\d\) chooses/);
    }
    expect(offered).toBeGreaterThan(0);
  });

  test("tie-breaks offer the speaker each outcome, the bot's first", () => {
    const ties = states.filter((s) => openKind(s) === "breakTie");
    expect(ties.length).toBeGreaterThan(0);
    for (const state of ties) {
      const [prompt] = openPrompts(state);
      const menu = buildMenu(state, prompt.player);
      expect(menu[0].action).toEqual(scriptedMove(state)!.action);
      if (prompt.kind !== "breakTie") throw new Error("Not a tie.");
      expect(menu.length).toBe(Math.min(new Set(prompt.outcomes).size, 12));
      expect(menu.every((c) => c.action.type === "BREAK_TIE")).toBe(true);
    }
  });

  test(
    "an agent at every seat that takes the first option plays the bot's whole game",
    async () => {
      const log = await playAgentGame({
        state: newGame(5),
        agentSeats: [0, 1, 2, 3, 4, 5],
        policy: new FirstCandidatePolicy(),
      });
      let state = newGame(5);
      const memory = newTableMemory();
      const scripted = [];
      while (state.phase !== "finished") {
        const move = scriptedMove(state, memory)!;
        scripted.push({ player: move.player, action: move.action });
        remember(memory, state, move.player, move.action);
        state = play(state, move.player, move.action);
      }
      expect(log.result.phase).toBe("finished");
      expect(log.actions).toEqual(scripted);
      expect(log.decisions.filter((d) => d.fallback)).toEqual([]);
      const prompts = log.decisions.map((d) => d.menu[0].text);
      expect(prompts.some((t) => t.startsWith("Abstain"))).toBe(true);
      expect(log.decisions.some((d) => d.menu.some((m) => m.text.startsWith("Pass: ")))).toBe(true);
    },
    300_000,
  );
});
