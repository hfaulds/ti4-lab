import { produce } from "immer";
import { describe, expect, test } from "vitest";
import { FactionId, PlayerId } from "~/types";
import { GameState } from "../types";
import { isGravityRift, MIRAGE } from "./board";
import { victoryPoints } from "./control";
import { destroyUnits } from "./effects/helpers";
import { countOf, openPrompts, unitsAvailable } from "./helpers";
import { hasGroundForcesFor } from "./units";
import { botMove, play, rejection, skipSetup, testGame } from "./testing";

const POK = ["pok"] as const;

/** Changes a game outside the rules, to set up a situation. */
const edit = (state: GameState, change: (draft: GameState) => void) =>
  produce(state, (draft) => {
    change(draft as GameState);
  });

/** A game with Prophecy of Kings, played up to the first action. */
function pokGame(factions: FactionId[], seed = 1) {
  let state = skipSetup(testGame({ seed, factions, expansions: [...POK] }));
  while (state.phase === "strategy") {
    const move = botMove(state)!;
    state = play(state, move.player, move.action);
  }
  return state;
}

const seatOf = (state: GameState, faction: FactionId): PlayerId =>
  state.seating.find((id) => state.players[id].faction === faction)!;

/** Puts a card on top of an exploration or relic deck. */
const stack = (state: GameState, deck: keyof GameState["decks"], card: string) =>
  edit(state, (draft) => {
    const d = draft.decks[deck];
    d.draw = [card, ...d.draw.filter((c) => c !== card)];
    d.discard = d.discard.filter((c) => c !== card);
  });

const homePlanet = (state: GameState, id: PlayerId) =>
  state.systems[state.players[id].home].planets[0];

describe("exploration", () => {
  test("an exploration card resolves on the planet explored", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    const planet = homePlanet(state, id);
    state = edit(state, (draft) => {
      draft.planets[planet].units[id] = {};
    });
    state = stack(state, "cultural", "mo1");
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "explore", player: id, planet, deck: "cultural" },
    });
    expect(countOf(state.planets[planet].units[id], "infantry")).toBe(1);
  });

  test("3 relic fragments of a type buy a relic", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    state = stack(state, "relics", "codex");
    state = edit(state, (draft) => {
      draft.players[id].relicFragments = ["crf1", "crf2", "urf1"];
    });
    state = play(state, id, {
      type: "USE_ABILITY",
      source: "exploration",
      ability: "crf1",
      targets: { fragments: ["crf1", "crf2", "urf1"] },
    });
    expect(state.players[id].relics).toEqual(["codex"]);
    expect(state.players[id].relicFragments).toEqual([]);
  });

  test("the Mirage appears in the frontier system it is found in", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    const frontier = Object.values(state.systems).find((s) => s.frontier && s.onBoard)!;
    state = stack(state, "frontier", "mirage");
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "explore", player: id, system: frontier.key, deck: "frontier" },
    });
    expect(state.systems[frontier.key].planets).toContain(MIRAGE);
    expect(state.planets[MIRAGE].controller).toBe(id);
  });

  test("Distant Suns lets the Naaz-Rokha choose between 2 cards", () => {
    let state = pokGame(["naazrokha", "hacan", "xxcha"]);
    const id = seatOf(state, "naazrokha");
    const planet = homePlanet(state, id);
    state = edit(state, (draft) => {
      draft.planets[planet].units[id] = { mech: { count: 1, damaged: 0 } };
      const deck = draft.decks.cultural;
      deck.draw = ["crf1", "mo1", ...deck.draw.filter((c) => c !== "crf1" && c !== "mo1")];
    });
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "explore", player: id, planet, deck: "cultural" },
    });
    const [prompt] = openPrompts(state);
    expect(prompt.kind).toBe("effect");
    state = play(state, id, { type: "RESOLVE_EFFECT", promptId: prompt.id, targets: { card: "crf1" } });
    expect(state.players[id].relicFragments).toContain("crf1");
    expect(state.decks.cultural.discard).toContain("mo1");
  });
});

describe("relics", () => {
  test("the Shard of the Throne is worth a point", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    const before = victoryPoints(state, id);
    state = stack(state, "relics", "shard");
    state = edit(state, (draft) => {
      draft.players[id].relicFragments = ["hrf1", "hrf2", "hrf3"];
    });
    state = play(state, id, {
      type: "USE_ABILITY",
      source: "exploration",
      ability: "hrf1",
      targets: { fragments: ["hrf1", "hrf2", "hrf3"] },
    });
    expect(victoryPoints(state, id)).toBe(before + 1);
  });
});

describe("leaders", () => {
  test("a commander unlocks once its condition is met", () => {
    let state = pokGame(["hacan", "sol", "xxcha"]);
    const id = seatOf(state, "hacan");
    state = edit(state, (draft) => {
      draft.players[id].tradeGoods = 10;
    });
    const move = botMove(state)!;
    state = play(state, move.player, move.action);
    expect(state.players[id].leaders.find((l) => l.type === "commander")?.status).toBe("ready");
  });

  test("an agent is exhausted when used", () => {
    let state = pokGame(["xxcha", "sol", "hacan"]);
    const id = seatOf(state, "xxcha");
    state = edit(state, (draft) => {
      draft.activePlayer = id;
      draft.planets[homePlanet(draft as GameState, id)].exhausted = true;
    });
    const planet = homePlanet(state, id);
    state = play(state, id, {
      type: "USE_ABILITY",
      source: "leader",
      ability: "xxchaagent",
      targets: { planet },
    });
    expect(state.planets[planet].exhausted).toBe(false);
    expect(state.players[id].leaders.find((l) => l.id === "xxchaagent")?.status).toBe("exhausted");
  });

  test("a hero is purged once used", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = seatOf(state, "sol");
    const elsewhere = Object.values(state.systems).find((s) => s.onBoard && s.key !== state.players[id].home)!;
    state = edit(state, (draft) => {
      draft.activePlayer = id;
      draft.players[id].leaders.find((l) => l.type === "hero")!.status = "ready";
      draft.systems[elsewhere.key].commandTokens.push(id);
    });
    state = play(state, id, { type: "USE_ABILITY", source: "leader", ability: "solhero" });
    expect(state.systems[elsewhere.key].commandTokens).not.toContain(id);
    expect(state.players[id].leaders.find((l) => l.type === "hero")?.status).toBe("purged");
  });
});

describe("factions", () => {
  test("Devour captures what the Vuil'raith destroy in combat", () => {
    let state = pokGame(["vulraith", "sol", "hacan"]);
    const cabal = seatOf(state, "vulraith");
    const sol = seatOf(state, "sol");
    const key = state.players[sol].home;
    state = edit(state, (draft) => {
      draft.tactical = {
        player: cabal,
        system: key,
        step: "spaceCombat",
        invaded: [],
        resolved: [],
        bombarded: false,
        spaceCombat: { attacker: cabal, defender: sol, round: 1, stage: "assign" },
      };
      draft.systems[key].space[sol] = { cruiser: { count: 2, damaged: 0 } };
      destroyUnits(draft as GameState, sol, { system: key }, "cruiser", 1, cabal);
    });
    expect(state.players[cabal].captured).toEqual([{ owner: sol, type: "cruiser", count: 1 }]);
    // 8 cruisers: 1 still on the board and 1 held captive.
    expect(unitsAvailable(state, sol, "cruiser")).toBe(6);
  });

  test("a Vuil'raith space dock makes its system a gravity rift", () => {
    const state = pokGame(["vulraith", "sol", "hacan"]);
    const cabal = seatOf(state, "vulraith");
    expect(isGravityRift(state, state.systems[state.players[cabal].home])).toBe(true);
  });

  test("Titans PDS count as ground forces", () => {
    const state = pokGame(["titans", "sol", "hacan"]);
    const titans = seatOf(state, "titans");
    expect(hasGroundForcesFor(state, titans, { pds: { count: 1, damaged: 0 } })).toBe(true);
    expect(hasGroundForcesFor(state, seatOf(state, "sol"), { pds: { count: 1, damaged: 0 } })).toBe(false);
  });
});

describe("action cards and agendas", () => {
  test("Refit Troops turns infantry into mechs", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    const planet = homePlanet(state, id);
    state = edit(state, (draft) => {
      draft.planets[planet].units[id] = { infantry: { count: 2, damaged: 0 } };
      draft.players[id].actionCards.push("refit");
    });
    state = play(state, id, { type: "PLAY_ACTION_CARD", card: "refit", targets: { planets: [planet, planet] } });
    expect(countOf(state.planets[planet].units[id], "mech")).toBe(2);
    expect(countOf(state.planets[planet].units[id], "infantry")).toBe(0);
  });

  test("Political Censure stops its owner playing action cards", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    state = edit(state, (draft) => {
      draft.laws.push({ id: "censure", outcome: draft.players[id].name, owner: id });
      draft.players[id].actionCards.push("refit");
    });
    expect(rejection(state, id, { type: "PLAY_ACTION_CARD", card: "refit", targets: { planets: [] } })).toMatch(
      /cannot use/i,
    );
  });

  test("Prove Endurance scores for the last player to pass", () => {
    let state = pokGame(["sol", "hacan", "xxcha"]);
    const id = state.activePlayer!;
    state = edit(state, (draft) => {
      for (const other of draft.seating) if (other !== id) draft.players[other].passed = true;
      for (const card of draft.players[id].strategyCards) card.exhausted = true;
      draft.players[id].secretObjectives.push("pe");
    });
    state = play(state, id, { type: "PASS" });
    while (openPrompts(state).some((p) => p.kind === "window")) {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    expect(state.players[id].scoredSecrets).toContain("pe");
  });
});
