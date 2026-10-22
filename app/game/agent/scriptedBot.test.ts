import { describe, expect, test } from "vitest";
import { GameState } from "../types";
import {
  controlledPlanets,
  neighborsOf,
  planetResources,
} from "../engine/board";
import { victoryPoints } from "../engine/control";
import { play, testGame } from "../engine/testing";
import { findPayment, readyPlanets } from "./payment";
import { scriptedMove } from "./scriptedBot";
import { TableTalk } from "./talk";

function playOut(state: GameState, until: (s: GameState) => boolean = () => false) {
  let current = state;
  let fallbacks = 0;
  for (let i = 0; i < 20000 && !until(current); i++) {
    const move = scriptedMove(current);
    if (!move) break;
    if (move.fallback) fallbacks++;
    current = play(current, move.player, move.action);
  }
  return { state: current, fallbacks };
}

describe("payments", () => {
  const start = playOut(testGame(), (s) => s.phase === "action").state;
  const id = start.activePlayer!;
  const resources = readyPlanets(start, id).reduce(
    (sum, name) => sum + planetResources(start, name),
    0,
  );

  test("pay at least the amount without spending planets it does not need", () => {
    const payment = findPayment(start, id, 1, "resources")!;
    const paid = payment.planets.reduce(
      (sum, name) => sum + planetResources(start, name),
      payment.tradeGoods,
    );
    expect(paid).toBeGreaterThanOrEqual(1);
    for (const name of payment.planets) {
      expect(paid - planetResources(start, name)).toBeLessThan(1);
    }
  });

  test("leave reserved planets alone", () => {
    const [kept] = readyPlanets(start, id);
    const payment = findPayment(start, id, 1, "resources", {
      planets: [kept],
      tradeGoods: 0,
      tokens: 0,
    });
    expect(payment?.planets ?? []).not.toContain(kept);
  });

  test("refuse a payment the player cannot make", () => {
    const tradeGoods = start.players[id].tradeGoods;
    expect(findPayment(start, id, resources + tradeGoods + 1, "resources")).toBe(
      undefined,
    );
  });
});

describe("scripted bot", () => {
  test("expands in the first round", () => {
    const { state } = playOut(testGame({ seed: 3 }), (s) => s.round > 1);
    const outside = state.seating.map(
      (id) =>
        controlledPlanets(state, id).filter(
          (p) => state.systems[p.system].homeOf !== id,
        ).length,
    );
    expect(outside.filter((count) => count > 0).length).toBeGreaterThanOrEqual(4);
  });

  test("plays a whole game with legal moves of its own", () => {
    const { state, fallbacks } = playOut(testGame({ seed: 2 }));
    expect(state.phase).toBe("finished");
    expect(fallbacks).toBeLessThanOrEqual(2);
    const best = Math.max(...state.seating.map((id) => victoryPoints(state, id)));
    expect(best).toBeGreaterThanOrEqual(7);
  });

  test("plays the same game from the same seed", () => {
    const first = playOut(testGame({ seed: 4 }), (s) => s.round > 2).state;
    const second = playOut(testGame({ seed: 4 }), (s) => s.round > 2).state;
    expect(second.version).toBe(first.version);
    expect(second.log.map((l) => l.text)).toEqual(first.log.map((l) => l.text));
  });

  test("turns down offers that take more than they give", () => {
    const hasNeighbor = (s: GameState) =>
      s.phase === "action" &&
      s.prompts.length === 0 &&
      s.transactions.length === 0 &&
      s.activePlayer !== undefined &&
      neighborsOf(s, s.activePlayer).length > 0;
    let state = playOut(testGame(), hasNeighbor).state;
    const id = state.activePlayer!;
    const other = state.seating.find((p) => neighborsOf(state, id).includes(p))!;
    for (const player of [id, other]) {
      state = play(state, id, {
        type: "ADJUST",
        adjustment: { type: "tradeGoods", player, amount: 4 },
      });
    }
    type Side = { tradeGoods?: number };
    const answer = (give: Side, receive: Side) => {
      const offered = play(state, id, {
        type: "PROPOSE_TRANSACTION",
        to: other,
        give,
        receive,
      });
      return scriptedMove(offered)!;
    };

    const greedy = answer({}, { tradeGoods: 4 });
    expect(greedy.player).toBe(other);
    expect(greedy.action).toMatchObject({ type: "ANSWER_TRANSACTION", accept: false });
    const fair = answer({ tradeGoods: 2 }, { tradeGoods: 2 });
    expect(fair.action).toMatchObject({ type: "ANSWER_TRANSACTION", accept: true });
  });

  test("give one back to the Trade holder who refreshed them, once", () => {
    const hasNeighbor = (s: GameState) =>
      s.phase === "action" &&
      s.prompts.length === 0 &&
      s.transactions.length === 0 &&
      s.activePlayer !== undefined &&
      neighborsOf(s, s.activePlayer).length > 0;
    let state = playOut(testGame(), hasNeighbor).state;
    const id = state.activePlayer!;
    const other = state.seating.find((p) => neighborsOf(state, id).includes(p))!;
    for (const player of [id, other]) {
      state = play(state, id, {
        type: "ADJUST",
        adjustment: { type: "tradeGoods", player, amount: 4 },
      });
    }
    // The standard deal: a free refresh, taken, for a trade good.
    const talk = new TableTalk();
    const deal = talk.propose(state, id, other, "a refresh for a trade good", {
      refresh: other,
      payment: { from: other, to: id, amount: 1 },
    });
    talk.accept(state, deal.id, other);
    deal.refreshed = true;
    type Side = { tradeGoods?: number };
    const offer = (give: Side, receive: Side) =>
      play(state, id, { type: "PROPOSE_TRANSACTION", to: other, give, receive });
    const accepts = (offered: GameState) =>
      (scriptedMove(offered, talk)!.action as { accept?: boolean }).accept;

    const oneShort = offer({ tradeGoods: 2 }, { tradeGoods: 3 });
    expect(accepts(oneShort)).toBe(true);
    expect(accepts(offer({ tradeGoods: 1 }, { tradeGoods: 3 }))).toBe(false);
    // Without the refresh, one short is too much.
    expect(scriptedMove(oneShort)!.action).toMatchObject({ accept: false });

    // Accepting repays the debt, so the next one-short offer is refused.
    talk.observe(oneShort, other, scriptedMove(oneShort, talk)!.action);
    expect(deal.status).toBe("kept");
    expect(accepts(oneShort)).toBe(false);
  });
});
