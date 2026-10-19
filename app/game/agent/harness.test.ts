import { describe, expect, test } from "vitest";
import OpenAI from "openai";
import { GameState } from "../types";
import { objectivesById } from "../data";
import { objectiveStatus } from "../engine/objectives";
import { play, testGame } from "../engine/testing";
import { describeGame, describeTurn } from "./describe";
import {
  agentBoundaryProblem,
  agentToMove,
  BLOCKED,
  buildMenu,
  playAgentGame,
} from "./harness";
import { ChatPolicy, DecisionRequest, FirstCandidatePolicy } from "./policy";
import { scriptedMove } from "./scriptedBot";
import { setupFor } from "./setups";
import { lookup, parseChoose } from "./tools";

const newGame = (seed: number) => testGame({ seed, ...setupFor(seed) });

/** Plays the scripted bot forward until `until` holds. */
function advance(state: GameState, until: (s: GameState) => boolean) {
  let current = state;
  for (let i = 0; i < 5000 && !until(current); i++) {
    const move = scriptedMove(current)!;
    current = play(current, move.player, move.action);
  }
  return current;
}

describe("agent harness", () => {
  test("an agent that takes the bot's top candidate plays the bot's game", async () => {
    const moves = 400;
    const mirrored: number[] = [];
    const log = await playAgentGame({
      state: newGame(3),
      agentSeats: [0],
      policy: new FirstCandidatePolicy(),
      maxMoves: moves,
      onMove: async (_, after) => {
        mirrored.push(after.version);
      },
    });
    let state = newGame(3);
    const scripted = [];
    for (let i = 0; i < moves; i++) {
      const move = scriptedMove(state)!;
      scripted.push({ player: move.player, action: move.action });
      state = play(state, move.player, move.action);
    }
    expect(log.actions).toEqual(scripted);
    // Every move is handed on, in order, with the state it produced.
    expect(mirrored).toHaveLength(moves);
    expect(mirrored.at(-1)).toBe(state.version);
    expect(log.decisions.length).toBeGreaterThan(10);
  });

  test("agent decisions are strategy picks, turns and prompts with real choices", () => {
    const state = advance(newGame(2), (s) => s.phase === "action" && s.prompts.length === 0);
    const seat = state.activePlayer!;
    expect(agentToMove(state, [seat])).toBe(seat);
    expect(agentToMove(state, [(seat + 1) % 6])).toBe(undefined);
  });

  test("menus offer legal, labelled moves and nothing blocked", () => {
    let state = newGame(4);
    for (let i = 0; i < 600; i++) {
      const seat = agentToMove(state, state.seating);
      if (seat !== undefined) {
        const menu = buildMenu(state, seat);
        expect(new Set(menu.map((c) => c.label)).size).toBe(menu.length);
        for (const candidate of menu) {
          expect(BLOCKED.has(candidate.action.type)).toBe(false);
          expect(candidate.text.length).toBeGreaterThan(0);
        }
      }
      const move = scriptedMove(state);
      if (!move) break;
      state = play(state, move.player, move.action);
    }
  });

  test("the boundary rejects rule bypasses, manual objectives and note trades", () => {
    const state = advance(newGame(5), (s) => s.phase === "action");
    const seat = state.activePlayer!;
    const adjust = {
      type: "ADJUST" as const,
      adjustment: { type: "victoryPoints" as const, player: seat, amount: 10 },
    };
    expect(agentBoundaryProblem(state, seat, adjust)).toMatch(/not available/);

    const manual = Object.keys(objectivesById).find(
      (o) => objectiveStatus(state, seat, o).met === "manual",
    )!;
    expect(
      agentBoundaryProblem(state, seat, { type: "SCORE_OBJECTIVE", objective: manual }),
    ).toMatch(/cannot check/);

    const note = state.players[seat].promissoryNotes[0];
    expect(
      agentBoundaryProblem(state, seat, {
        type: "PROPOSE_TRANSACTION",
        to: (seat + 1) % 6,
        give: { promissoryNotes: [note] },
        receive: {},
      }),
    ).toMatch(/trade goods and commodities only/);
  });

  test("the turn description shows no other player's hidden cards", () => {
    const state = advance(newGame(6), (s) => s.round === 2 && s.phase === "action");
    const seat = state.seating[0];
    const text = describeTurn(state, seat);
    for (const other of state.seating.filter((id) => id !== seat)) {
      for (const secret of state.players[other].secretObjectives) {
        if (state.players[seat].secretObjectives.includes(secret)) continue;
        expect(text).not.toContain(objectivesById[secret].name);
      }
    }
    for (const secret of state.players[seat].secretObjectives) {
      expect(text).toContain(objectivesById[secret].name);
    }
  });
});

describe("lookup", () => {
  test("finds every strategy card in the game, whichever set it comes from", () => {
    const state = newGame(1);
    for (const id of ["Diplomacy", "Construction (4)", "construction", "Leadership"]) {
      expect(lookup(state, { kind: "strategy_card", id })).toMatch(/initiative \d\)\./);
    }
    expect(lookup(state, { kind: "strategy_card", id: "Bureaucracy" })).toMatch(
      /Cards in this game: .*Diplomacy/,
    );
  });

  test("the game block describes the strategy cards in play", () => {
    const text = describeGame(newGame(1), 0);
    expect(text).toMatch(/- Diplomacy \(initiative 2\)\. Primary: .+ Secondary: /);
  });
});

describe("tool arguments", () => {
  test("choose needs a listed candidate and a rationale", () => {
    expect(parseChoose('{"candidate":"b","rationale":"x","plan_note":""}', ["A", "B"])).toMatchObject({
      ok: true,
      value: { candidate: "B" },
    });
    expect(parseChoose('{"candidate":"Z","rationale":"x"}', ["A", "B"]).ok).toBe(false);
    expect(parseChoose('{"candidate":"A"}', ["A"]).ok).toBe(false);
    expect(parseChoose("not json", ["A"]).ok).toBe(false);
  });
});

describe("chat policy", () => {
  type Reply = {
    content?: string;
    calls?: { name: string; args: string }[];
    /** Fail the request with this error instead of replying. */
    fail?: Error;
    /** Never answer, until the request is aborted. */
    hang?: boolean;
  };

  /** A fake chat API that replies with a fixed script and records requests. */
  function fakeClient(replies: Reply[]) {
    const requests: unknown[] = [];
    let i = 0;
    const client = {
      chat: {
        completions: {
          create: async (body: unknown, options?: { signal?: AbortSignal }) => {
            requests.push(JSON.parse(JSON.stringify(body)));
            const reply = replies[Math.min(i++, replies.length - 1)];
            if (reply.fail) throw reply.fail;
            if (reply.hang) {
              await new Promise((_, reject) =>
                options?.signal?.addEventListener("abort", () => reject(options.signal!.reason)),
              );
            }
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: reply.content ?? null,
                    tool_calls: reply.calls?.map((c, n) => ({
                      id: `call_${i}_${n}`,
                      type: "function",
                      function: { name: c.name, arguments: c.args },
                    })),
                  },
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                prompt_cache_hit_tokens: 80,
              },
            };
          },
        },
      },
    } as unknown as Pick<OpenAI, "chat">;
    return { client, requests };
  }

  const request: DecisionRequest = {
    game: "GAME",
    turn: "TURN",
    planNote: "",
    menu: [
      { label: "A", text: "Pass" },
      { label: "B", text: "Build" },
    ],
    lookup: (args) => `data for ${args.id}`,
  };

  test("looks things up, then chooses", async () => {
    const { client, requests } = fakeClient([
      { calls: [{ name: "lookup", args: '{"kind":"planet","id":"Lodor"}' }] },
      { calls: [{ name: "choose", args: '{"candidate":"B","rationale":"More ships.","plan_note":"Build up."}' }] },
    ]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client });
    const decision = await policy.decide(request);
    expect(decision).toMatchObject({ label: "B", planNote: "Build up." });
    expect(decision.steps.map((s) => s.tool)).toEqual(["lookup", "choose"]);
    expect(decision.steps[0].result).toBe("data for Lodor");
    expect(decision.usage).toMatchObject({ requests: 2, inputTokens: 200, cachedInputTokens: 160 });
    // The system prompt and game block lead every request, so they cache.
    const messages = (requests[1] as { messages: { role: string; content: string }[] }).messages;
    expect(messages.slice(0, 2).map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1].content).toBe("GAME");
  });

  test("asks again when the model answers without choosing, then gives up", async () => {
    const { client } = fakeClient([{ content: "I would build." }]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client });
    const decision = await policy.decide(request);
    expect(decision.label).toBe(undefined);
    expect(decision.error).toMatch(/No valid choice/);
    expect(decision.usage.requests).toBe(2);
  });

  test("returns invalid arguments to the model as an error", async () => {
    const { client } = fakeClient([
      { calls: [{ name: "choose", args: '{"candidate":"Q","rationale":"?"}' }] },
      { calls: [{ name: "choose", args: '{"candidate":"A","rationale":"Safe.","plan_note":""}' }] },
    ]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client });
    const decision = await policy.decide(request);
    expect(decision.label).toBe("A");
    expect(decision.steps[0].result).toMatch(/Error: candidate must be one of A, B/);
  });

  const choose = {
    calls: [{ name: "choose", args: '{"candidate":"A","rationale":"Safe.","plan_note":""}' }],
  };

  test("sends a request again when the connection drops", async () => {
    const { client, requests } = fakeClient([{ fail: new TypeError("terminated") }, choose]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client });
    const decision = await policy.decide(request);
    expect(decision.label).toBe("A");
    expect(decision.usage).toMatchObject({ requests: 1, retries: 1 });
    expect(requests).toHaveLength(2);
  });

  test("abandons a request that takes too long, then tries once more", async () => {
    const { client } = fakeClient([{ hang: true }, choose]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client, requestTimeoutMs: 20 });
    const decision = await policy.decide(request);
    expect(decision.label).toBe("A");
    expect(decision.usage.retries).toBe(1);

    const stuck = fakeClient([{ hang: true }]);
    const patient = new ChatPolicy({ model: "m", apiKey: "k", client: stuck.client, requestTimeoutMs: 20 });
    await expect(patient.decide(request)).rejects.toThrow();
    expect(stuck.requests).toHaveLength(2);
  });

  test("does not resend a request the API rejected", async () => {
    const rejected = new OpenAI.BadRequestError(400, undefined, "bad request", new Headers());
    const { client, requests } = fakeClient([{ fail: rejected }, choose]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client });
    await expect(policy.decide(request)).rejects.toThrow("bad request");
    expect(requests).toHaveLength(1);
  });

  test("stops lookups at the limit and leaves only choose on the last request", async () => {
    const lookupCall = { calls: [{ name: "lookup", args: '{"kind":"planet","id":"Lodor"}' }] };
    const { client, requests } = fakeClient([lookupCall, lookupCall, lookupCall, choose]);
    const policy = new ChatPolicy({ model: "m", apiKey: "k", client, maxLookups: 2 });
    const decision = await policy.decide(request);
    expect(decision.label).toBe("A");
    expect(decision.steps.map((s) => s.result)).toEqual([
      "data for Lodor",
      "data for Lodor",
      "Lookup limit reached for this decision. Call choose now.",
      "Move recorded.",
    ]);
    type Body = { tools: { function: { name: string } }[] };
    const toolNames = (body: unknown) => (body as Body).tools.map((t) => t.function.name);
    expect(toolNames(requests[0])).toEqual(["lookup", "choose"]);
    expect(toolNames(requests[3])).toEqual(["choose"]);
  });
});
