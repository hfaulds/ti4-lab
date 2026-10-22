import { describe, expect, test } from "vitest";
import { GameState } from "../types";
import { neighborsOf } from "../engine/board";
import { strategyKind } from "../engine/strategic";
import { play, testGame } from "../engine/testing";
import { playAgentGame } from "./harness";
import OpenAI from "openai";
import { ChatPolicy, Decision, DecisionRequest, noUsage, Policy } from "./policy";
import { scriptedMove } from "./scriptedBot";
import { setupFor } from "./setups";
import { TableTalk, TRUCE_WORTH, WORD_WORTH } from "./talk";
import { parseDealArgs, parsePostMessage, parseProposeDeal, runTalkTool } from "./tools";

const newGame = (seed: number) => testGame({ seed, ...setupFor(seed) });

/** Plays the scripted bot forward, keeping the table's deals, until `until` holds. */
function advance(state: GameState, until: (s: GameState) => boolean, talk = new TableTalk()) {
  let current = state;
  for (let i = 0; i < 5000 && !until(current); i++) {
    const move = scriptedMove(current, talk)!;
    talk.observe(current, move.player, move.action);
    current = play(current, move.player, move.action);
    talk.settle(current);
  }
  return current;
}

/** An action-phase turn start for a player with a neighbour. */
const turnWithNeighbour = (s: GameState) =>
  s.phase === "action" &&
  s.prompts.length === 0 &&
  s.transactions.length === 0 &&
  s.actionsThisTurn === 0 &&
  s.activePlayer !== undefined &&
  neighborsOf(s, s.activePlayer).length > 0;

describe("talk tools", () => {
  test("parse messages, deals and deal numbers", () => {
    expect(parsePostMessage('{"text":" hello "}')).toEqual({ ok: true, value: { text: "hello" } });
    expect(parsePostMessage('{"text":"psst","to":"P3"}')).toEqual({ ok: true, value: { text: "psst", to: 3 } });
    expect(parsePostMessage('{"text":"x","to":"everyone"}').ok).toBe(false);
    expect(parsePostMessage('{"to":"P1"}').ok).toBe(false);

    expect(
      parseProposeDeal(
        '{"to":"p2","text":"Refresh for a TG","refresh":"them","payer":"them","trade_goods":1,"due_round":3}',
      ),
    ).toEqual({
      ok: true,
      value: { to: 2, text: "Refresh for a TG", refresh: "them", payer: "them", trade_goods: 1, due_round: 3 },
    });
    expect(parseProposeDeal('{"to":"P2","text":"Peace","truce":true}')).toEqual({
      ok: true,
      value: { to: 2, text: "Peace", truce: true },
    });
    expect(parseProposeDeal('{"to":"P2","text":"x","payer":"them"}').ok).toBe(false);
    expect(parseProposeDeal('{"to":"P2","text":"x","refresh":"us"}').ok).toBe(false);
    expect(parseProposeDeal('{"to":"P2","text":"x","payer":"me","trade_goods":0}').ok).toBe(false);
    expect(parseProposeDeal('{"to":"P2","text":"x","due_round":2}').ok).toBe(false);
    expect(parseProposeDeal('{"text":"x"}').ok).toBe(false);

    expect(parseDealArgs('{"deal":"#4","reason":"changed my mind"}')).toEqual({
      ok: true,
      value: { deal: 4, reason: "changed my mind" },
    });
    expect(parseDealArgs('{"deal":"four"}').ok).toBe(false);
  });

  test("run against the table, and a bot answers a proposal at once", () => {
    const state = advance(newGame(2), (s) => s.phase === "action");
    const [seat, other] = state.seating;
    const talk = new TableTalk([seat]);
    let tools = talk.toolsFor(state, seat);
    expect(runTalkTool(tools, "post_message", '{"text":"Hello table"}')).toBe("Message posted to the table.");
    expect(runTalkTool(tools, "post_message", `{"text":"Just us","to":"P${other}"}`)).toBe(
      `Message sent to P${other}.`,
    );
    expect(runTalkTool(tools, "post_message", '{"text":"x","to":"P9"}')).toMatch(/no other player/);
    // A gift pays, so the bot takes it; a text-only deal it cannot check.
    // (A decision allows a few talk calls, so this is the next one's.)
    tools = talk.toolsFor(state, seat);
    expect(
      runTalkTool(tools, "propose_deal", `{"to":"P${other}","text":"A gift","payer":"me","trade_goods":1}`),
    ).toMatch(/accepted it/);
    expect(runTalkTool(tools, "propose_deal", `{"to":"P${other}","text":"Be nice"}`)).toMatch(/declined it/);
    expect(runTalkTool(tools, "propose_deal", `{"to":"P${other}","text":"Pay me","payer":"them","trade_goods":1}`)).toMatch(
      /does not pay/,
    );
    expect(runTalkTool(tools, "accept_deal", '{"deal":1}')).toMatch(/not proposed to you/);
    expect(runTalkTool(tools, "drop_deal", '{"deal":1}')).toMatch(/counts it as broken by you/);
    expect(talk.record(seat)).toEqual({ kept: 0, broken: 1 });

    // The turn block shows messages, records and, privately, whispers.
    const block = talk.describeFor(state, seat);
    expect(block).toMatch(/Hello table/);
    expect(block).toMatch(/Just us/);
    expect(block).toMatch(new RegExp(`P${seat} \\([^)]+\\) kept 0, broke 1`));
    const third = state.seating[2];
    expect(talk.describeFor(state, third)).not.toMatch(/Just us/);
  });
});

describe("bots and deals", () => {
  test("pay a small debt but not one that costs more than their word is worth", () => {
    const state = advance(newGame(1), turnWithNeighbour);
    const id = state.activePlayer!;
    const other = neighborsOf(state, id)[0];
    const talk = new TableTalk();
    const owe = (amount: number) => {
      const deal = talk.propose(state, other, id, "a payment", { payment: { from: id, to: other, amount } });
      talk.accept(state, deal.id, id);
      return deal;
    };
    const small = owe(WORD_WORTH);
    expect(talk.willPay(state, id, other)).toBe(WORD_WORTH);
    talk.drop(state, small.id, other);
    owe(WORD_WORTH + 1);
    expect(talk.willPay(state, id, other)).toBe(0);
  });

  test("do not pay, or deal with, a player who broke a deal", () => {
    const state = advance(newGame(1), (s) => s.phase === "action");
    const [a, b, c] = state.seating;
    const talk = new TableTalk();
    const debt = talk.propose(state, b, a, "a payment", { payment: { from: a, to: b, amount: 1 } });
    talk.accept(state, debt.id, a);
    expect(talk.willPay(state, a, b)).toBe(1);
    // b backs out of another deal, so a stops paying and c will not deal.
    const other = talk.propose(state, c, b, "a gift", { payment: { from: c, to: b, amount: 1 } });
    talk.accept(state, other.id, b);
    talk.drop(state, other.id, b);
    expect(talk.trusted(b)).toBe(false);
    expect(talk.willPay(state, a, b)).toBe(0);
    const offer = talk.propose(state, b, c, "a gift", { payment: { from: b, to: c, amount: 1 } });
    expect(talk.botAnswer(state, offer)).toMatchObject({ accept: false });
  });

  test("hold a truce unless breaking it is worth more", () => {
    const state = advance(newGame(1), (s) => s.phase === "action");
    const [a, b] = state.seating;
    const talk = new TableTalk();
    const truce = talk.propose(state, a, b, "Stay out of each other's slice", { truce: true });
    expect(talk.botAnswer(state, truce).accept).toBe(true);
    talk.accept(state, truce.id, b);
    const home = state.players[a].home;
    expect(talk.holdsBack(state, b, home, TRUCE_WORTH)).toBe(true);
    expect(talk.holdsBack(state, b, home, TRUCE_WORTH + 1)).toBe(false);
    talk.observe(state, b, { type: "ACTIVATE_SYSTEM", system: home });
    expect(truce).toMatchObject({ status: "broken", by: b });
  });

  test("a debt nobody had the chance to pay lapses at the end of its round", () => {
    let state = advance(newGame(1), (s) => s.phase === "action");
    const [a, b] = state.seating;
    const talk = new TableTalk();
    talk.settle(state);
    const deal = talk.propose(state, a, b, "1 trade good next round", {
      payment: { from: b, to: a, amount: 1, dueRound: state.round + 5 },
    });
    talk.accept(state, deal.id, b);
    state = { ...state, round: state.round + 6 };
    talk.settle(state);
    expect(deal).toMatchObject({ status: "dropped" });
    expect(talk.trusted(b)).toBe(true);
  });
});

/**
 * An agent that plays the bot's game, except that it takes Trade, and when
 * it plays Trade, first strikes a refresh-for-a-trade-good deal, payable
 * next round, with each player it lets replenish.
 */
class DealingPolicy implements Policy {
  readonly name = "dealing";
  proposed: string[] = [];

  async decide(request: DecisionRequest): Promise<Decision> {
    const decided = (label: string): Decision => ({
      label,
      rationale: "Test.",
      planNote: "",
      citations: [],
      steps: [],
      usage: noUsage(),
    });
    const trade = request.menu.find((m) => /^Pick Trade\b/.test(m.text));
    if (trade) return decided(trade.label);
    const refresh = request.menu.find((m) => /may replenish theirs without spending a token/.test(m.text));
    if (refresh && request.talk) {
      const round = Number(/^Round (\d+)/.exec(request.turn)![1]);
      const partners = /; (P\d+(?:, P\d+)*) may replenish/.exec(refresh.text)![1].split(", ");
      for (const partner of partners) {
        this.proposed.push(
          request.talk.propose({
            to: Number(partner.slice(1)),
            text: "A free refresh now for 1 trade good next round",
            refresh: "them",
            payer: "them",
            trade_goods: 1,
            due_round: round + 1,
          }),
        );
      }
      return decided(refresh.label);
    }
    return decided(request.menu[0].label);
  }
}

describe("table talk in a game", () => {
  test("an agent strikes a refresh-for-a-trade-good deal in one round and collects it in a later one", async () => {
    const policy = new DealingPolicy();
    const notes: { round: number; talk: string[] }[] = [];
    const log = await playAgentGame({
      state: newGame(2),
      agentSeats: [0],
      policy,
      until: (s) => s.round > 3,
      onMove: async (move, after) => {
        if (move.note?.talk) notes.push({ round: after.round, talk: move.note.talk });
      },
    });
    expect(policy.proposed.some((r) => /accepted it/.test(r))).toBe(true);
    const deals = log.talk!.deals.filter((d) => d.from === 0 && d.terms.payment?.dueRound !== undefined);
    const kept = deals.find((d) => d.status === "kept");
    expect(kept).toBeDefined();
    // Struck in one round, collected in a later one, and the history shows both.
    const events = log.talk!.events;
    const struck = events.find((e) => e.text.startsWith(`Deal #${kept!.id} accepted`))!;
    const paid = events.find((e) => new RegExp(`paid .* towards deal #${kept!.id} `).test(e.text))!;
    expect(paid.round).toBeGreaterThan(struck.round);
    const said = notes.flatMap((n) => n.talk);
    expect(said).toContain(struck.text);
    expect(said).toContain(paid.text);
    expect(said).toContain(`Deal #${kept!.id} kept.`);
    // The agent's turn block lists its deals.
    expect(policy.proposed.length).toBeGreaterThan(0);
  });

  test("the Trade holder's free refresh comes with the standard deal", () => {
    const talk = new TableTalk();
    const state = advance(
      newGame(2),
      (s) =>
        s.phase === "action" &&
        s.prompts.some((p) => p.kind === "secondary" && p.free && strategyKind(p.card) === "trade"),
      talk,
    );
    const [deal] = talk.deals;
    expect(deal.terms).toMatchObject({ refresh: deal.to, payment: { from: deal.to, to: deal.from, amount: 1 } });
    expect(state.prompts.length).toBeGreaterThan(0);
  });
});

describe("chat policy talk", () => {
  test("offers the talk tools, and talking does not end the decision", async () => {
    const replies = [
      { name: "post_message", args: '{"text":"Hello"}' },
      { name: "choose", args: '{"candidate":"A","rationale":"Safe.","plan_note":""}' },
    ];
    const offered: string[][] = [];
    let i = 0;
    const client = {
      chat: {
        completions: {
          create: async (body: { tools?: { function: { name: string } }[] }) => {
            offered.push((body.tools ?? []).map((t) => t.function.name));
            const call = replies[i++];
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: `c${i}`, type: "function", function: { name: call.name, arguments: call.args } }],
                  },
                },
              ],
            };
          },
        },
      },
    } as unknown as Pick<OpenAI, "chat">;
    const state = newGame(2);
    const talk = new TableTalk([0]);
    const decision = await new ChatPolicy({ model: "m", apiKey: "k", client }).decide({
      game: "GAME",
      turn: "TURN",
      planNote: "",
      menu: [{ label: "A", text: "Pass" }],
      lookup: () => "",
      talk: talk.toolsFor(state, 0),
    });
    expect(offered[0]).toEqual(["lookup", "post_message", "propose_deal", "accept_deal", "drop_deal", "choose"]);
    expect(decision.label).toBe("A");
    expect(decision.steps.map((s) => s.tool)).toEqual(["post_message", "choose"]);
    expect(talk.messages).toMatchObject([{ from: 0, text: "Hello" }]);
  });
});
