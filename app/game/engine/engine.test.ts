import { describe, expect, test } from "vitest";
import { unitFor } from "../data";
import { GameState } from "../types";
import {
  adjacentSystems,
  areNeighbors,
  findRoute,
  MECATOL_REX,
  moveRulesFor,
} from "./board";
import { victoryPoints } from "./control";
import { countOf, openPrompts, totalUnits } from "./helpers";
import { applyAction } from "./index";
import { objectiveStatus } from "./objectives";
import { missingPrerequisites } from "./technology";
import {
  autoplay,
  botMove,
  play,
  rejection,
  skipSetup,
  testGame,
  testMap,
} from "./testing";

const SOL = 0;
const HACAN = 1;

/** Plays the strategy phase so that player 0 acts first with Leadership. */
function toActionPhase(state: GameState) {
  let current = skipSetup(state);
  const picks = [
    "pok1leadership",
    "pok2diplomacy",
    "pok3politics",
    "pok4construction",
    "pok5trade",
    "pok6warfare",
  ];
  for (const card of picks) {
    current = play(current, current.activePlayer!, {
      type: "PICK_STRATEGY_CARD",
      card,
    });
  }
  return current;
}

const leadershipHolder = (state: GameState) =>
  state.seating.find((id) =>
    state.players[id].strategyCards.some((c) => c.id === "pok1leadership"),
  )!;

describe("setup", () => {
  test("deals each faction its starting position", () => {
    const state = testGame();
    const sol = state.players[SOL];
    expect(sol.pools).toEqual({ tactic: 3, fleet: 3, strategy: 2 });
    expect([...sol.technologies].sort()).toEqual(["amd", "nm"]);
    expect(sol.commodityLimit).toBe(4);
    expect(state.planets["Jord"].controller).toBe(SOL);
    expect(countOf(state.planets["Jord"].units[SOL], "infantry")).toBe(5);
    expect(countOf(state.planets["Jord"].units[SOL], "spacedock")).toBe(1);
    expect(countOf(state.systems[sol.home].space[SOL], "carrier")).toBe(2);
  });

  test("reveals two stage I objectives and asks for a secret objective", () => {
    const state = testGame();
    expect(state.publicObjectives).toHaveLength(10);
    expect(state.publicObjectives.filter((o) => o.revealed)).toHaveLength(2);
    expect(state.phase).toBe("setup");
    expect(openPrompts(state).map((p) => p.kind)).toEqual(
      Array(6).fill("chooseSecret"),
    );
  });

  test("keeps expansion content out of a base game", () => {
    const state = testGame();
    expect(state.players[SOL].leaders).toEqual([]);
    expect(state.decks.relics.draw).toEqual([]);
    expect(Object.values(state.systems).every((s) => !s.frontier)).toBe(true);
    expect(unitFor("sol", "mech", [], [])).toBeUndefined();
    expect(unitFor("sol", "mech", [], ["pok"])?.name).toBe("ZS Thunderbolt M2");
  });

  test("adds Prophecy of Kings components when enabled", () => {
    const state = testGame({ expansions: ["pok"] });
    expect(state.players[SOL].leaders.map((l) => l.type)).toEqual([
      "agent",
      "commander",
      "hero",
    ]);
    expect(state.decks.relics.draw.length).toBeGreaterThan(0);
    expect(state.planets["Mallice"]).toBeDefined();
    expect(Object.values(state.systems).some((s) => s.frontier)).toBe(true);
  });

  test("uses faction units and their upgrades", () => {
    expect(unitFor("sol", "carrier", [], [])?.capacity).toBe(6);
    expect(unitFor("sol", "carrier", ["ac2"], [])?.capacity).toBe(8);
    expect(unitFor("hacan", "warsun", [], [])).toBeUndefined();
    expect(unitFor("hacan", "warsun", ["ws"], [])?.combat).toBe(3);
    expect(unitFor("muaat", "warsun", [], [])).toBeDefined();
  });

  test("rejects factions from content that is switched off", () => {
    expect(() => testGame({ factions: ["sol", "hacan", "argent"] })).toThrow(
      /expansion/,
    );
  });

  test("seats Creuss off the board behind their gate", () => {
    const state = testGame({ factions: ["creuss", "sol", "hacan"] });
    const creuss = state.players[0];
    expect(state.systems[creuss.home].onBoard).toBe(false);
    const gate = Object.values(state.systems).find((s) => s.systemId === "17")!;
    expect(adjacentSystems(state, gate.key)).toContain(creuss.home);
  });
});

describe("strategy phase", () => {
  test("players choose in speaker order, then initiative decides turns", () => {
    const state = toActionPhase(testGame());
    expect(state.phase).toBe("action");
    expect(state.activePlayer).toBe(leadershipHolder(state));
    // Imperial and Technology went unpicked and gain a trade good each.
    expect(state.strategyCardBonus).toEqual({
      pok7technology: 1,
      pok8imperial: 1,
    });
  });

  test("a card cannot be chosen twice", () => {
    let state = skipSetup(testGame());
    const first = state.activePlayer!;
    state = play(state, first, { type: "PICK_STRATEGY_CARD", card: "pok5trade" });
    expect(
      rejection(state, state.activePlayer!, {
        type: "PICK_STRATEGY_CARD",
        card: "pok5trade",
      }),
    ).toMatch(/not available/);
  });

  test("three players take two cards each", () => {
    let state = skipSetup(testGame({ factions: ["sol", "hacan", "jolnar"] }));
    for (let i = 0; i < 6; i++) {
      expect(state.phase).toBe("strategy");
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    expect(state.phase).toBe("action");
    for (const id of state.seating) {
      expect(state.players[id].strategyCards).toHaveLength(2);
    }
  });
});

describe("tactical action", () => {
  function solReady() {
    const state = toActionPhase(testGame());
    const id = state.activePlayer!;
    const home = state.players[id].home;
    const target = adjacentSystems(state, home).find(
      (key) => state.systems[key].planets.length > 0,
    )!;
    return { state, id, home, target };
  }

  test("moves a fleet, lands troops and takes the planet", () => {
    const { state: start, id, home, target } = solReady();
    const planet = start.systems[target].planets[0];
    const homePlanet = start.systems[home].planets[0];

    let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
    expect(state.players[id].pools.tactic).toBe(2);
    expect(state.systems[target].commandTokens).toEqual([id]);

    state = play(state, id, {
      type: "MOVE_SHIPS",
      moves: [{ from: home, ships: { carrier: 1 } }],
      cargo: [{ system: home, planet: homePlanet, units: { infantry: 2 } }],
    });
    expect(state.tactical?.step).toBe("commit");
    expect(countOf(state.systems[target].space[id], "infantry")).toBe(2);

    state = play(state, id, {
      type: "COMMIT_GROUND_FORCES",
      landings: [{ planet, units: { infantry: 2 } }],
    });
    expect(state.planets[planet].controller).toBe(id);
    expect(state.planets[planet].exhausted).toBe(true);
    expect(state.tactical).toBeUndefined();
    expect(state.actionsThisTurn).toBe(1);

    expect(rejection(state, id, { type: "ACTIVATE_SYSTEM", system: home })).toMatch(
      /already taken your action/,
    );
    state = play(state, id, { type: "END_TURN" });
    expect(state.activePlayer).not.toBe(id);
  });

  test("refuses to activate a system twice", () => {
    const { state: start, id, target } = solReady();
    let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    state = autoplayTurn(state, id);
    // Round the table and back.
    while (state.activePlayer !== id) {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    expect(
      rejection(state, id, { type: "ACTIVATE_SYSTEM", system: target }),
    ).toMatch(/already have a command token/);
  });

  test("ships cannot outrun their move value or carry too much", () => {
    const { state: start, id, home } = solReady();
    const far = Object.values(start.systems).find(
      (s) =>
        s.onBoard &&
        !findRoute(start, home, 1, moveRulesFor(start, id, s.key)) &&
        s.key !== home,
    )!;
    let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: far.key });
    expect(
      rejection(state, id, {
        type: "MOVE_SHIPS",
        moves: [{ from: home, ships: { carrier: 1 } }],
        cargo: [],
      }),
    ).toMatch(/cannot reach/);

    const { target } = solReady();
    state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
    expect(
      rejection(state, id, {
        type: "MOVE_SHIPS",
        moves: [{ from: home, ships: { destroyer: 1 } }],
        cargo: [{ system: home, units: { fighter: 3 } }],
      }),
    ).toMatch(/cannot carry/);
  });

  test("fleet pool limits the ships in a system", () => {
    const { state: start, id, home, target } = solReady();
    const crowded = play(start, id, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: id,
        system: home,
        unit: "cruiser",
        amount: 2,
      },
    });
    const state = play(crowded, id, { type: "ACTIVATE_SYSTEM", system: target });
    expect(
      rejection(state, id, {
        type: "MOVE_SHIPS",
        moves: [{ from: home, ships: { carrier: 2, cruiser: 2 } }],
        cargo: [],
      }),
    ).toMatch(/fleet pool supports 3/);
  });

  test("anomalies block movement", () => {
    // 41 gravity rift, 42 nebula, 43 supernova, 44 and 45 asteroid fields
    const map = testMap(6, ["43", "43", "43", "43", "43", "43"]);
    const blocked = skipSetup(testGame({ map }));
    const id = 0;
    const home = blocked.players[id].home;
    const reachable = Object.keys(blocked.systems)
      .map(Number)
      .filter(
        (key) =>
          key !== home &&
          findRoute(blocked, home, 3, moveRulesFor(blocked, id, key)),
      );
    expect(reachable).toEqual([]);
  });

  test("the custodians token must be paid for", () => {
    const { state: start, id } = solReady();
    const mecatol = start.planets[MECATOL_REX].system;
    let state = play(start, id, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: id,
        system: mecatol,
        unit: "carrier",
        amount: 1,
      },
    });
    state = play(state, id, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: id,
        system: mecatol,
        unit: "infantry",
        amount: 2,
      },
    });
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "tradeGoods", player: id, amount: 6 },
    });
    state = play(state, id, { type: "ACTIVATE_SYSTEM", system: mecatol });
    state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    const land = {
      type: "COMMIT_GROUND_FORCES" as const,
      landings: [{ planet: MECATOL_REX, units: { infantry: 2 } }],
    };
    expect(rejection(state, id, land)).toMatch(/6 are needed/);
    state = play(state, id, {
      ...land,
      custodians: { planets: [], tradeGoods: 6 },
    });
    expect(state.custodians).toBe(false);
    expect(state.planets[MECATOL_REX].controller).toBe(id);
    expect(victoryPoints(state, id)).toBe(1);
  });
});

/** Finishes whatever the player has started and ends their turn. */
function autoplayTurn(state: GameState, id: number) {
  let current = state;
  while (current.activePlayer === id && current.phase === "action") {
    const move = botMove(current)!;
    current = play(current, move.player, move.action);
    if (move.action.type === "END_TURN" || move.action.type === "PASS") break;
  }
  return current;
}

describe("combat", () => {
  function battle(seed: number) {
    let state = toActionPhase(testGame({ seed }));
    const id = state.activePlayer!;
    const enemy = state.seating.find((other) => other !== id)!;
    const home = state.players[id].home;
    const target = adjacentSystems(state, home).find(
      (key) => state.systems[key].planets.length > 0,
    )!;
    const planet = state.systems[target].planets[0];
    const place = (
      player: number,
      unit: "cruiser" | "infantry" | "dreadnought",
      amount: number,
      onPlanet?: string,
    ) => {
      state = play(state, id, {
        type: "ADJUST",
        adjustment: {
          type: "units",
          player,
          system: target,
          planet: onPlanet,
          unit,
          amount,
        },
      });
    };
    place(enemy, "cruiser", 2);
    place(enemy, "infantry", 2, planet);
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "planetControl", planet, player: enemy },
    });
    place(id, "dreadnought", 2);
    return { state, id, enemy, home, target, planet };
  }

  test("a space combat runs until one side is gone", () => {
    const { state: start, id, enemy, target } = battle(7);
    let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    let guard = 0;
    while (state.tactical?.step === "spaceCombat" && guard++ < 200) {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    const space = state.systems[target].space;
    const survivors = [id, enemy].filter((p) => totalUnits(space[p]) > 0);
    expect(survivors.length).toBeLessThanOrEqual(1);
    expect(state.log.some((entry) => /space combat/i.test(entry.text))).toBe(true);
  });

  test("hits must be assigned in full", () => {
    const { state: start, id, target } = battle(3);
    let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    let guard = 0;
    while (!openPrompts(state).some((p) => p.kind === "assignHits")) {
      const move = botMove(state);
      if (!move || guard++ > 50) break;
      state = play(state, move.player, move.action);
    }
    const prompt = openPrompts(state).find((p) => p.kind === "assignHits");
    expect(prompt).toBeDefined();
    expect(
      rejection(state, prompt!.player, {
        type: "ASSIGN_HITS",
        promptId: prompt!.id,
        assignment: { sustain: [], destroy: {} },
      }),
    ).toMatch(/Assign all/);
  });

  test("is reproducible from the same seed", () => {
    const run = (seed: number) => {
      const { state: start, id, target } = battle(seed);
      let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
      state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
      return autoplay(state, 40).log.map((entry) => entry.text);
    };
    expect(run(11)).toEqual(run(11));
    expect(run(11)).not.toEqual(run(12));
  });
});

describe("strategy cards", () => {
  test("Leadership converts influence into command tokens", () => {
    const state = toActionPhase(testGame());
    const id = leadershipHolder(state);
    const home = state.systems[state.players[id].home];
    const planet = home.planets[0];
    expect(
      rejection(state, id, {
        type: "STRATEGIC_ACTION",
        payload: {
          card: "leadership",
          pools: { tactic: 8, fleet: 3, strategy: 2 },
        },
      }),
    ).toMatch(/exactly 11/);

    let next = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "tradeGoods", player: id, amount: 1 },
    });
    next = play(next, id, {
      type: "STRATEGIC_ACTION",
      payload: {
        card: "leadership",
        influence: { planets: [planet], tradeGoods: 1 },
        pools: { tactic: 7, fleet: 3, strategy: 2 },
      },
    });
    expect(next.players[id].pools.tactic).toBe(7);
    expect(next.planets[planet].exhausted).toBe(true);
    expect(openPrompts(next).every((p) => p.kind === "secondary")).toBe(true);
    expect(openPrompts(next)).toHaveLength(5);
  });

  test("the card is exhausted once every secondary is answered", () => {
    let state = toActionPhase(testGame());
    const id = leadershipHolder(state);
    state = play(state, id, {
      type: "STRATEGIC_ACTION",
      payload: { card: "leadership", pools: { tactic: 6, fleet: 3, strategy: 2 } },
    });
    expect(rejection(state, id, { type: "END_TURN" })).toMatch(/in progress/);
    for (const prompt of openPrompts(state)) {
      state = play(state, prompt.player, {
        type: "RESOLVE_SECONDARY",
        promptId: prompt.id,
      });
    }
    expect(state.players[id].strategyCards[0].exhausted).toBe(true);
    expect(rejection(state, id, { type: "PASS" })).toMatch(/already taken an action/);
    state = play(state, id, { type: "END_TURN" });
    expect(state.activePlayer).not.toBe(id);
  });

  test("a player cannot pass before using their strategy card", () => {
    const state = toActionPhase(testGame());
    expect(rejection(state, state.activePlayer!, { type: "PASS" })).toMatch(
      /strategy card/,
    );
  });
});

describe("technology", () => {
  test("prerequisites are counted by color", () => {
    const state = testGame();
    // Sol owns Antimass Deflectors (blue) and Neural Motivator (green).
    expect(missingPrerequisites(state, SOL, "gd")).toEqual([]);
    expect(missingPrerequisites(state, SOL, "fl")).toEqual(["PROPULSION"]);
    expect(missingPrerequisites(state, SOL, "ff2")).toEqual([]);
    expect(missingPrerequisites(state, SOL, "ws")).toHaveLength(4);
  });
});

describe("objectives", () => {
  test("spend objectives report what they cost", () => {
    const state = testGame();
    expect(objectiveStatus(state, SOL, "monument").cost).toEqual({
      resources: 8,
    });
    expect(objectiveStatus(state, SOL, "develop").met).toBe(false);
    expect(objectiveStatus(state, SOL, "dtgs").met).toBe("manual");
  });

  test("neighbors are found across adjacent systems", () => {
    const state = testGame();
    expect(areNeighbors(state, SOL, HACAN)).toBe(false);
    const hacanHome = state.players[HACAN].home;
    const beside = adjacentSystems(state, hacanHome)[0];
    const next = play(state, SOL, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: SOL,
        system: beside,
        unit: "destroyer",
        amount: 1,
      },
    });
    expect(areNeighbors(next, SOL, HACAN)).toBe(true);
  });
});

describe("whole games", () => {
  test.each([
    { name: "base game", expansions: [] as const, factions: undefined },
    {
      name: "Prophecy of Kings",
      expansions: ["pok", "codex1", "codex2", "codex3", "codex4"] as const,
      factions: ["argent", "nomad", "titans", "sol", "naazrokha", "keleres"] as const,
    },
    {
      name: "Thunder's Edge",
      expansions: ["pok", "te"] as const,
      factions: ["bastion", "ralnel", "crimson", "dws", "firmament", "sol"] as const,
    },
  ])("$name plays for rounds without breaking", ({ expansions, factions }) => {
    for (const seed of [1, 2, 3]) {
      const start = testGame({
        seed,
        expansions: [...expansions],
        factions: factions ? [...factions] : undefined,
      });
      const end = autoplay(start, 1500);
      expect(end.round).toBeGreaterThan(2);
      for (const id of end.seating) {
        const player = end.players[id];
        expect(player.tradeGoods).toBeGreaterThanOrEqual(0);
        expect(Object.values(player.pools).every((pool) => pool >= 0)).toBe(true);
        expect(player.actionCards.length).toBeLessThanOrEqual(7);
      }
    }
  });

  test("an illegal action leaves the game untouched", () => {
    const state = testGame();
    const result = applyAction(state, SOL, { type: "PASS" });
    expect(result.ok).toBe(false);
    expect(state.version).toBe(0);
  });
});

describe("production and research", () => {
  test("a space dock produces up to its limit and charges resources", () => {
    const state = toActionPhase(testGame());
    const id = state.activePlayer!;
    const home = state.players[id].home;
    const planet = state.systems[home].planets[0];
    let next = play(state, id, { type: "ACTIVATE_SYSTEM", system: home });
    next = play(next, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    expect(next.tactical?.step).toBe("production");

    expect(
      rejection(next, id, {
        type: "PRODUCE",
        units: [{ type: "cruiser", count: 1 }],
        payment: { planets: [], tradeGoods: 0 },
      }),
    ).toMatch(/pays 0 resources/);
    expect(
      rejection(next, id, {
        type: "PRODUCE",
        units: [{ type: "fighter", count: 20 }],
        payment: { planets: [planet], tradeGoods: 0 },
      }),
    ).toMatch(/can produce/);

    // Sol already has three ships here, which is all its fleet pool allows.
    expect(
      rejection(next, id, {
        type: "PRODUCE",
        units: [{ type: "cruiser", count: 1 }],
        payment: { planets: [planet], tradeGoods: 0 },
      }),
    ).toMatch(/fleet pool supports 3/);

    const before = countOf(next.planets[planet].units[id], "infantry");
    next = play(next, id, {
      type: "PRODUCE",
      units: [
        { type: "fighter", count: 2 },
        { type: "infantry", count: 2, planet },
      ],
      payment: { planets: [planet], tradeGoods: 0 },
    });
    expect(countOf(next.planets[planet].units[id], "infantry")).toBe(before + 2);
    expect(next.planets[planet].exhausted).toBe(true);
    expect(next.tactical).toBeUndefined();
  });

  test("a pair of infantry split into two orders costs one pair", () => {
    let state = toActionPhase(testGame());
    const id = state.activePlayer!;
    const home = state.players[id].home;
    const planet = state.systems[home].planets[0];
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "tradeGoods", player: id, amount: 2 },
    });
    let next = play(state, id, { type: "ACTIVATE_SYSTEM", system: home });
    next = play(next, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });
    expect(next.tactical?.step).toBe("production");

    const before = countOf(next.planets[planet].units[id], "infantry");
    const tradeGoods = next.players[id].tradeGoods;
    next = play(next, id, {
      type: "PRODUCE",
      units: [
        { type: "infantry", count: 1, planet },
        { type: "infantry", count: 1, planet },
      ],
      payment: { planets: [], tradeGoods: 1 },
    });
    expect(countOf(next.planets[planet].units[id], "infantry")).toBe(before + 2);
    expect(next.players[id].tradeGoods).toBe(tradeGoods - 1);
  });

  test("Technology researches only what prerequisites allow", () => {
    let state = skipSetup(testGame());
    // Give the first player to act the Technology card.
    const first = state.activePlayer!;
    state = play(state, first, {
      type: "PICK_STRATEGY_CARD",
      card: "pok7technology",
    });
    while (state.phase === "strategy") {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    while (state.activePlayer !== first) {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    const owned = state.players[first].technologies;
    expect(
      rejection(state, first, {
        type: "STRATEGIC_ACTION",
        payload: { card: "technology", research: { technology: "ws" } },
      }),
    ).toMatch(/prerequisite/);
    expect(state.players[first].technologies).toEqual(owned);

    const next = play(state, first, {
      type: "STRATEGIC_ACTION",
      payload: { card: "technology", research: { technology: "gd" } },
    });
    expect(next.players[first].technologies).toContain("gd");
  });
});

describe("status and agenda phases", () => {
  /** Plays on until the given phase starts. */
  function until(state: GameState, phase: GameState["phase"], limit = 2000) {
    let current = state;
    for (let i = 0; i < limit && current.phase !== phase; i++) {
      const move = botMove(current);
      if (!move) break;
      current = play(current, move.player, move.action);
    }
    expect(current.phase).toBe(phase);
    return current;
  }

  test("the status phase readies the table for the next round", () => {
    const state = until(toActionPhase(testGame()), "status");
    const next = until(state, "strategy");
    expect(next.round).toBe(2);
    expect(next.publicObjectives.filter((o) => o.revealed)).toHaveLength(3);
    for (const id of next.seating) {
      const player = next.players[id];
      expect(player.strategyCards).toEqual([]);
      expect(player.actionCards.length).toBeGreaterThanOrEqual(1);
      expect(player.passed).toBe(false);
    }
    expect(
      Object.values(next.systems).every((s) => s.commandTokens.length === 0),
    ).toBe(true);
    expect(Object.values(next.planets).every((p) => !p.exhausted)).toBe(true);
  });

  test("agendas are voted on once the custodians are gone", () => {
    let state = toActionPhase(testGame());
    state = play(state, SOL, {
      type: "ADJUST",
      adjustment: { type: "custodians", present: false },
    });
    state = until(state, "agenda");
    expect(state.agenda?.number).toBe(1);

    // The player left of the speaker votes first, the speaker last.
    const order = openPrompts(state).map((p) => p.player);
    expect(order).toHaveLength(1);
    const speakerSeat = state.seating.indexOf(state.speaker);
    expect(order[0]).toBe(state.seating[(speakerSeat + 1) % 6]);

    const voter = order[0];
    const planet = Object.values(state.planets).find(
      (p) => p.controller === voter,
    )!;
    expect(
      rejection(state, voter, {
        type: "CAST_VOTES",
        outcome: "Not an outcome",
        planets: [planet.name],
      }),
    ).toBeDefined();

    const next = until(state, "strategy");
    expect(next.round).toBe(2);
    expect(next.agenda).toBeUndefined();
  });

  test("whole games reach the agenda phase and keep going", () => {
    let state = toActionPhase(testGame({ expansions: ["pok"], seed: 5 }));
    state = play(state, SOL, {
      type: "ADJUST",
      adjustment: { type: "custodians", present: false },
    });
    const end = autoplay(state, 2500);
    expect(end.round).toBeGreaterThan(3);
  });
});

describe("transactions", () => {
  test("neighbors trade, and commodities become trade goods", () => {
    let state = toActionPhase(testGame());
    const id = state.activePlayer!;
    const other = state.seating.find((p) => p !== id)!;
    const give = { commodities: 2 };
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "commodities", player: id, amount: 2 },
    });
    expect(
      rejection(state, id, {
        type: "PROPOSE_TRANSACTION",
        to: other,
        give,
        receive: {},
      }),
    ).toMatch(/not neighbors/);

    state = play(state, id, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: id,
        system: state.players[other].home,
        unit: "destroyer",
        amount: 1,
      },
    });
    state = play(state, id, {
      type: "PROPOSE_TRANSACTION",
      to: other,
      give,
      receive: {},
    });
    const [offer] = state.transactions;
    expect(rejection(state, id, {
      type: "ANSWER_TRANSACTION",
      transaction: offer.id,
      accept: true,
    })).toMatch(/not made to you/);
    state = play(state, other, {
      type: "ANSWER_TRANSACTION",
      transaction: offer.id,
      accept: true,
    });
    expect(state.players[id].commodities).toBe(0);
    expect(state.players[other].tradeGoods).toBe(2);
    expect(state.transactions).toEqual([]);
  });
});

describe("hidden information", () => {
  test("a seat sees its own cards and nobody else's", async () => {
    const { viewFor } = await import("../view");
    const state = skipSetup(testGame());
    const view = viewFor(state, SOL);
    expect(view.players[SOL].secretObjectives).toEqual(
      state.players[SOL].secretObjectives,
    );
    expect(view.players[HACAN].secretObjectives).toEqual(["hidden"]);
    expect(view.players[HACAN].hand.secretObjectives).toBe(1);
    expect(view.decks.actionCards.draw).toBe(
      state.decks.actionCards.draw.length,
    );
    expect(JSON.stringify(view)).not.toContain(
      state.players[HACAN].secretObjectives[0],
    );
    expect("rng" in view).toBe(false);
    expect(
      view.publicObjectives.filter((o) => o.id === "hidden"),
    ).toHaveLength(8);
  });
});
