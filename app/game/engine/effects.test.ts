import { produce } from "immer";
import { describe, expect, test } from "vitest";
import { FactionId, PlayerId } from "~/types";
import { agendas } from "../data";
import { GameState, Prompt } from "../types";
import { adjacentSystems, fleetProblem, planetResources } from "./board";
import { FACTION_COMBAT_MODIFIERS } from "./combat";
import { victoryPoints } from "./control";
import { destroyUnits } from "./effects/helpers";
import { countOf, initiativeOrder, openPrompts } from "./helpers";
import { objectiveStatus } from "./objectives";
import { botMove, play, rejection, skipSetup, testGame } from "./testing";

/** Changes a game outside the rules, to set up a situation. */
const edit = (state: GameState, change: (draft: GameState) => void) =>
  produce(state, (draft) => {
    change(draft as GameState);
  });

/** Puts an action card in a player's hand, taking it out of the deck. */
const give = (state: GameState, id: PlayerId, card: string) =>
  edit(state, (draft) => {
    const deck = draft.decks.actionCards;
    deck.draw = deck.draw.filter((c) => c !== card);
    deck.discard = deck.discard.filter((c) => c !== card);
    draft.players[id].actionCards.push(card);
  });

/** Plays the strategy phase with each player taking the next card in order. */
function toActionPhase(state: GameState) {
  let current = skipSetup(state);
  while (current.phase === "strategy") {
    const move = botMove(current)!;
    current = play(current, move.player, move.action);
  }
  return current;
}

/**
 * Lets the bots play until `stop` holds, answering prompts as the test bot
 * does (passing every window).
 */
function until(state: GameState, stop: (s: GameState) => boolean, limit = 3000) {
  let current = state;
  for (let i = 0; i < limit && !stop(current); i++) {
    const move = botMove(current);
    if (!move) break;
    current = play(current, move.player, move.action);
  }
  expect(stop(current), `stopped in ${current.phase}, ${current.tactical?.step ?? ""} ${JSON.stringify(openPrompts(current)[0] ?? null)}`).toBe(true);
  return current;
}

const windowFor = (state: GameState, id: PlayerId, window: string) =>
  openPrompts(state).find(
    (p): p is Extract<Prompt, { kind: "window" }> =>
      p.kind === "window" && p.player === id && p.window === window,
  );

/** A tactical action against an enemy fleet next to the active player's home. */
function battle(seed: number, factions?: FactionId[]) {
  let state = toActionPhase(testGame({ seed, factions }));
  const id = state.activePlayer!;
  const enemy = state.seating.find((other) => other !== id)!;
  const home = state.players[id].home;
  const target = adjacentSystems(state, home).find(
    (key) => state.systems[key].planets.length > 0,
  )!;
  const planet = state.systems[target].planets[0];
  state = edit(state, (draft) => {
    draft.systems[target].space[enemy] = { cruiser: { count: 3, damaged: 0 } };
    draft.systems[target].space[id] = { dreadnought: { count: 3, damaged: 0 } };
    draft.planets[planet].controller = enemy;
    draft.planets[planet].units[enemy] = { infantry: { count: 2, damaged: 0 } };
  });
  return { state, id, enemy, home, target, planet };
}

describe("action cards", () => {
  test("a component action resolves and uses the player's action", () => {
    let state = toActionPhase(testGame());
    const id = state.activePlayer!;
    state = give(state, id, "mining_initiative");
    const planet = state.systems[state.players[id].home].planets[0];
    const before = state.players[id].tradeGoods;

    state = play(state, id, {
      type: "PLAY_ACTION_CARD",
      card: "mining_initiative",
      targets: { planet },
    });
    expect(state.players[id].tradeGoods).toBe(before + planetResources(state, planet));
    expect(state.players[id].actionCards).not.toContain("mining_initiative");
    expect(state.decks.actionCards.discard).toContain("mining_initiative");
    expect(state.actionsThisTurn).toBe(1);
  });

  test("cards that wait for a moment cannot be played as actions", () => {
    let state = toActionPhase(testGame());
    const id = state.activePlayer!;
    state = give(state, id, "mb1");
    expect(rejection(state, id, { type: "PLAY_ACTION_CARD", card: "mb1" })).toMatch(
      /particular moment/,
    );
  });

  test("Sabotage cancels a card, which stays spent", () => {
    let state = toActionPhase(testGame());
    const id = state.activePlayer!;
    const other = state.seating.find((p) => p !== id)!;
    state = give(state, id, "mining_initiative");
    state = give(state, other, "sabo1");
    const planet = state.systems[state.players[id].home].planets[0];
    const before = state.players[id].tradeGoods;

    state = play(state, id, {
      type: "PLAY_ACTION_CARD",
      card: "mining_initiative",
      targets: { planet },
    });
    const window = windowFor(state, other, "actionCardPlayed");
    expect(window?.options).toEqual([{ kind: "actionCard", id: "sabo1" }]);
    state = play(state, other, {
      type: "PLAY_ACTION_CARD",
      card: "sabo1",
      promptId: window!.id,
    });
    expect(state.players[id].tradeGoods).toBe(before);
    expect(state.prompts).toHaveLength(0);
    expect(state.actionsThisTurn).toBe(1);
    expect(state.log.some((entry) => /was cancelled/.test(entry.text))).toBe(true);
  });

  test("Morale Boost adds 1 to every roll in the round", () => {
    const setup = battle(7);
    const { id, target } = setup;
    let state = give(setup.state, id, "mb1");
    state = play(state, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    state = until(state, (s) => !!windowFor(s, id, "roundStart"));
    const window = windowFor(state, id, "roundStart")!;
    state = play(state, id, { type: "PLAY_ACTION_CARD", card: "mb1", promptId: window.id });
    expect(state.tactical?.spaceCombat?.roundModifiers?.[id]).toBe(1);
    const round = (s: GameState) =>
      s.log.find((entry) => entry.text.startsWith("Space combat round 1"));
    state = until(state, (s) => !!round(s));
    const rolls = round(state)!.rolls!.filter((r) => r.player === id);
    expect(rolls.length).toBeGreaterThan(0);
    // Fragile or Unrelenting still apply on top.
    const faction = FACTION_COMBAT_MODIFIERS[state.players[id].faction] ?? 0;
    expect(rolls.every((r) => r.modifier === faction + 1)).toBe(true);
  });

  test("Shields Holding cancels up to 2 hits before they are assigned", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const setup = battle(seed);
      const { id, enemy, target } = setup;
      let state = give(setup.state, enemy, "sh1");
      state = play(state, id, { type: "ACTIVATE_SYSTEM", system: target });
      state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
      state = until(
        state,
        (s) => !!windowFor(s, enemy, "beforeCombatHits") || !s.tactical?.spaceCombat,
      );
      const window = windowFor(state, enemy, "beforeCombatHits");
      if (!window) continue;
      const hits = state.prompts.find((p) => p.id === window.context.ref);
      expect(hits?.kind).toBe("assignHits");
      const before = hits?.kind === "assignHits" ? hits.hits : 0;
      state = play(state, enemy, {
        type: "PLAY_ACTION_CARD",
        card: "sh1",
        promptId: window.id,
      });
      const after = state.prompts.find((p) => p.id === window.context.ref);
      expect(after?.kind === "assignHits" ? after.hits : 0).toBe(Math.max(0, before - 2));
      return;
    }
    throw new Error("No seed produced hits against the defender.");
  });
});

describe("faction abilities", () => {
  test("Orbital Drop places 2 infantry for a strategy token", () => {
    let state = toActionPhase(testGame({ factions: ["sol", "hacan", "jolnar", "xxcha", "barony", "yin"] }));
    state = until(state, (s) => s.activePlayer === 0 && s.actionsThisTurn === 0 && s.prompts.length === 0);
    const planet = "Jord";
    const infantry = countOf(state.planets[planet].units[0], "infantry");
    const tokens = state.players[0].pools.strategy;
    state = play(state, 0, { type: "USE_ABILITY", ability: "orbital_drop", targets: { planet } });
    expect(countOf(state.planets[planet].units[0], "infantry")).toBe(infantry + 2);
    expect(state.players[0].pools.strategy).toBe(tokens - 1);
    expect(state.actionsThisTurn).toBe(1);
  });

  test("Telepathic puts the Naalu first in initiative order", () => {
    const state = toActionPhase(
      testGame({ factions: ["sol", "hacan", "jolnar", "naalu", "barony", "yin"] }),
    );
    const naalu = state.seating.find((id) => state.players[id].faction === "naalu")!;
    expect(state.zeroToken).toBe(naalu);
    expect(initiativeOrder(state)[0]).toBe(naalu);
    expect(state.activePlayer).toBe(naalu);
  });

  test("Armada lets the Letnev keep 2 more ships than their fleet pool", () => {
    const state = toActionPhase(
      testGame({ factions: ["barony", "sol", "hacan", "jolnar", "xxcha", "yin"] }),
    );
    const letnev = state.seating.find((p) => state.players[p].faction === "barony")!;
    const key = state.players[letnev].home;
    const fleet = state.players[letnev].pools.fleet;
    const withDestroyers = (count: number) =>
      edit(state, (draft) => {
        draft.systems[key].space[letnev] = { destroyer: { count, damaged: 0 } };
      });
    expect(fleetProblem(withDestroyers(fleet + 2), key, letnev)).toBeUndefined();
    expect(fleetProblem(withDestroyers(fleet + 3), key, letnev)).toBeDefined();
  });

  test("Scheming draws an extra action card and discards one", () => {
    let state = toActionPhase(
      testGame({ factions: ["yssaril", "sol", "hacan", "jolnar", "xxcha", "barony"] }),
    );
    const yssaril = state.seating.find((p) => state.players[p].faction === "yssaril")!;
    state = play(state, yssaril, {
      type: "ADJUST",
      adjustment: { type: "drawActionCards", player: yssaril, count: 1 },
    });
    expect(state.players[yssaril].actionCards).toHaveLength(2);
    const [prompt] = openPrompts(state);
    expect(prompt).toMatchObject({ kind: "discardActionCards", player: yssaril, count: 1 });
  });
});

describe("units and objectives", () => {
  test("Infantry II come back at the start of their owner's next turn", () => {
    let state = toActionPhase(testGame({ seed: 9 }));
    const id = state.activePlayer!;
    const planet = state.systems[state.players[id].home].planets[0];
    state = edit(state, (draft) => {
      draft.players[id].technologies.push("inf2");
      draft.planets[planet].units[id] = { infantry: { count: 30, damaged: 0 } };
      destroyUnits(draft, id, { system: draft.players[id].home, planet }, "infantry", 30);
    });
    const reviving = state.players[id].revivingInfantry ?? 0;
    expect(reviving).toBeGreaterThan(0);
    // Their next turn starts once everyone else has had one.
    state = play(state, id, { type: "ADJUST", adjustment: { type: "note", text: "wait" } });
    state = edit(state, (draft) => {
      draft.actionsThisTurn = 1;
    });
    state = play(state, id, { type: "END_TURN" });
    state = until(state, (s) => s.activePlayer === id || s.phase !== "action");
    expect(state.activePlayer).toBe(id);
    expect(countOf(state.planets[planet].units[id], "infantry")).toBe(reviving);
  });

  test("destroying a war sun scores Destroy Their Greatest Ship", () => {
    let state = toActionPhase(testGame());
    const id = state.activePlayer!;
    const enemy = state.seating.find((p) => p !== id)!;
    const key = state.players[enemy].home;
    state = edit(state, (draft) => {
      draft.players[enemy].technologies.push("ws");
      draft.systems[key].space[enemy] = { warsun: { count: 1, damaged: 0 } };
      draft.players[id].secretObjectives.push("dtgs");
      destroyUnits(draft, enemy, { system: key }, "warsun", 1, id);
    });
    expect(objectiveStatus(state, id, "dtgs").met).toBe(true);
    const points = victoryPoints(state, id);
    state = play(state, id, { type: "SCORE_OBJECTIVE", objective: "dtgs" });
    expect(victoryPoints(state, id)).toBe(points + 1);
  });
});

describe("agendas", () => {
  /** Puts an agenda on top of the deck and plays to the agenda phase. */
  function toAgenda(agenda: string) {
    let state = toActionPhase(testGame({ seed: 3 }));
    state = edit(state, (draft) => {
      draft.custodians = false;
      const deck = draft.decks.agendas;
      deck.draw = [agenda, ...deck.draw.filter((card) => card !== agenda)];
    });
    return until(state, (s) => s.phase === "agenda");
  }

  test("an outcome takes effect: Economic Equality gives everyone 5 trade goods", () => {
    let state = toAgenda("economic_equality");
    state = until(state, (s) => s.phase === "strategy");
    for (const id of state.seating) expect(state.players[id].tradeGoods).toBe(5);
    expect(state.decks.agendas.discard).toContain("economic_equality");
  });

  test("a correct rider pays out", () => {
    let state = toAgenda("economic_equality");
    const id = state.speaker;
    state = give(state, id, "trade_rider");
    state = until(state, (s) => !!windowFor(s, id, "afterAgendaRevealed"));
    const window = windowFor(state, id, "afterAgendaRevealed")!;
    state = play(state, id, {
      type: "PLAY_ACTION_CARD",
      card: "trade_rider",
      targets: { outcome: "For" },
      promptId: window.id,
    });
    expect(state.agenda?.barred).toContain(id);
    state = until(state, (s) => s.phase === "strategy");
    // 5 from the agenda, then 5 from the rider.
    expect(state.players[id].tradeGoods).toBe(10);
  });

  test("every base agenda resolves without breaking the game", () => {
    const start = toAgenda("economic_equality");
    for (const agenda of agendas.filter((a) => a.source === "base")) {
      // The speaker breaks the tie: the first outcome, then the last.
      for (const last of [false, true]) {
        let state = edit(start, (draft) => {
          const deck = draft.decks.agendas;
          deck.draw = [agenda.id, ...deck.draw.filter((card) => card !== agenda.id)];
          draft.agenda!.step = "start";
        });
        for (let i = 0; i < 500 && state.phase === "agenda"; i++) {
          const [prompt] = openPrompts(state);
          const outcome = prompt?.kind === "breakTie" ? prompt.outcomes.at(-1) : undefined;
          const move =
            last && outcome !== undefined
              ? { player: prompt.player, action: { type: "BREAK_TIE" as const, outcome } }
              : botMove(state)!;
          state = play(state, move.player, move.action);
        }
        expect(state.agenda, agenda.name).toBeUndefined();
        const mentioned = state.log.some(
          (entry) =>
            entry.text.startsWith(`${agenda.name} resolved`) ||
            entry.text.startsWith(`${agenda.name} was discarded`),
        );
        expect(mentioned, agenda.name).toBe(true);
      }
    }
  });

  test("laws stay in play and change the rules", () => {
    let state = toAgenda("sanctions");
    state = until(state, (s) => s.phase === "strategy");
    expect(state.laws.map((law) => law.id)).toContain("sanctions");
  });
});
