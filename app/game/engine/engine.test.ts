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
import { rollAbility } from "./combat";
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

/** A system with nothing in it, so a move there involves no combat or landing. */
const isEmptySystem = (state: GameState, key: number) =>
  state.systems[key].planets.length === 0 &&
  Object.values(state.systems[key].space).every((units) => totalUnits(units) === 0);

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

  test("reveals two stage I objectives and asks everyone for their setup decisions at once", () => {
    const state = testGame();
    expect(state.publicObjectives).toHaveLength(10);
    expect(state.publicObjectives.filter((o) => o.revealed)).toHaveLength(2);
    expect(state.phase).toBe("setup");
    const open = openPrompts(state);
    expect(open).toHaveLength(state.prompts.length);
    expect(open.filter((p) => p.kind === "chooseSecret")).toHaveLength(6);
    // Hacan, Jol-Nar, Xxcha and Letnev have more than one home planet.
    expect(
      open
        .filter((p) => p.kind === "placeStartingUnits")
        .map((p) => state.players[p.player].faction)
        .sort(),
    ).toEqual(["barony", "hacan", "jolnar", "xxcha"]);
  });

  test("players with several home planets place their own ground forces and structures", () => {
    let state = testGame();
    const prompt = openPrompts(state).find(
      (p) => p.player === HACAN && p.kind === "placeStartingUnits",
    )!;
    expect(prompt).toMatchObject({
      planets: expect.arrayContaining(["Arretze", "Hercant", "Kamdorn"]),
      units: { infantry: 4, spacedock: 1 },
    });
    // Ships are already in place; the rest waits on the player.
    const hacan = state.players[HACAN];
    expect(countOf(state.systems[hacan.home].space[HACAN], "carrier")).toBe(2);
    expect(countOf(state.planets["Arretze"].units[HACAN], "spacedock")).toBe(0);

    expect(
      rejection(state, HACAN, {
        type: "PLACE_STARTING_UNITS",
        placement: { Kamdorn: { infantry: 3, spacedock: 1 } },
      }),
    ).toMatch(/exactly 4/);
    expect(
      rejection(state, HACAN, {
        type: "PLACE_STARTING_UNITS",
        placement: { Jord: { infantry: 4, spacedock: 1 } },
      }),
    ).toMatch(/not one of your home planets/);

    state = play(state, HACAN, {
      type: "PLACE_STARTING_UNITS",
      placement: { Kamdorn: { infantry: 4, spacedock: 1 } },
    });
    expect(countOf(state.planets["Kamdorn"].units[HACAN], "infantry")).toBe(4);
    expect(countOf(state.planets["Kamdorn"].units[HACAN], "spacedock")).toBe(1);
    expect(countOf(state.planets["Arretze"].units[HACAN], "infantry")).toBe(0);
  });

  test("suggests infantry spread evenly and the space dock on the best resource planet", () => {
    const state = testGame();
    const suggestion = (faction: string) =>
      openPrompts(state).find(
        (p) =>
          p.kind === "placeStartingUnits" &&
          state.players[p.player].faction === faction,
      )!;
    // Arretze 2/0, Hercant 1/1, Kamdorn 0/1: the spare infantry goes to
    // the planet with the most resources.
    expect(suggestion("hacan")).toMatchObject({
      suggested: {
        Arretze: { infantry: 2, spacedock: 1 },
        Hercant: { infantry: 1 },
        Kamdorn: { infantry: 1 },
      },
    });
    // Nar 2/3 beats Jol 1/2; the PDS stay where the faction sheet puts them.
    expect(suggestion("jolnar")).toMatchObject({
      suggested: {
        Nar: { infantry: 1, spacedock: 1, pds: 1 },
        Jol: { infantry: 1, pds: 1 },
      },
    });
  });

  test("Council Keleres choose 2 non-faction technologies owned by other players", () => {
    let state = testGame({
      factions: ["keleres", "sol", "hacan"],
      expansions: ["pok", "codex3"],
    });
    const KELERES = 0;
    expect(state.players[KELERES].technologies).toEqual([]);
    // Everyone else's setup comes first, as Keleres choose from what they own.
    while (openPrompts(state).every((p) => p.kind !== "chooseStartingTech")) {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    const prompt = openPrompts(state)[0];
    expect(prompt).toMatchObject({ player: KELERES, count: 2 });
    expect(
      prompt.kind === "chooseStartingTech" && [...prompt.options].sort(),
    ).toEqual(["amd", "nm", "st"]);
    state = play(state, KELERES, {
      type: "CHOOSE_STARTING_TECH",
      technologies: ["nm", "st"],
    });
    expect(state.players[KELERES].technologies).toEqual(["nm", "st"]);
    expect(state.phase).toBe("strategy");
  });

  test("Mahact purge their Alliance promissory note", () => {
    const state = testGame({
      factions: ["mahact", "sol", "hacan"],
      expansions: ["pok"],
    });
    const notes = (id: number) =>
      state.players[id].promissoryNotes.map((n) => n.id);
    expect(notes(0)).not.toContain("an");
    expect(notes(1)).toContain("an");
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
  test("a Floating Factory moves like a ship and produces where it arrives", () => {
    const start = toActionPhase(testGame({ factions: ["saar", "hacan", "jolnar", "xxcha", "barony", "yin"] }));
    const id = start.activePlayer!;
    const home = start.players[id].home;
    const target = adjacentSystems(start, home).find(
      (key) => isEmptySystem(start, key),
    )!;
    let state = play(start, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, {
      type: "MOVE_SHIPS",
      moves: [{ from: home, ships: { spacedock: 1 } }],
      cargo: [],
    });
    expect(countOf(state.systems[target].space[id], "spacedock")).toBe(1);
    expect(countOf(state.systems[home].space[id], "spacedock")).toBe(0);
    expect(state.tactical?.step).toBe("production");
  });

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

  test("a retreat into a full system removes ships over the fleet pool", () => {
    const { state: start, id, enemy, home, target } = battle(1);
    const refuge = adjacentSystems(start, target).find(
      (key) =>
        key !== home &&
        start.systems[key].onBoard &&
        Object.keys(start.systems[key].space).length === 0,
    )!;
    // The defender's fleet pool is already full in the refuge.
    let state = play(start, id, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: enemy,
        system: refuge,
        unit: "destroyer",
        amount: start.players[enemy].pools.fleet,
      },
    });
    state = play(state, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, { type: "MOVE_SHIPS", moves: [], cargo: [] });

    let guard = 0;
    while (state.tactical && guard++ < 100) {
      const [prompt] = openPrompts(state);
      if (prompt?.kind === "announceRetreat" && prompt.player === enemy) {
        state = play(state, enemy, { type: "ANNOUNCE_RETREAT", to: refuge });
        continue;
      }
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }

    expect(state.log.some((e) => /retreated/.test(e.text))).toBe(true);
    expect(
      totalUnits(state.systems[refuge].space[enemy], (t) => t !== "fighter"),
    ).toBeLessThanOrEqual(state.players[enemy].pools.fleet);
    expect(state.log.some((e) => /over their fleet pool/.test(e.text))).toBe(true);
    // The cheapest ships go first, so the cruisers that fought survive.
    expect(countOf(state.systems[refuge].space[enemy], "cruiser")).toBeGreaterThan(0);
  });

  test("ground forces are lost with the carrier space cannon destroys", () => {
    let state = toActionPhase(testGame({ seed: 2 }));
    const id = state.activePlayer!;
    const enemy = state.seating.find((other) => other !== id)!;
    const home = state.players[id].home;
    const target = adjacentSystems(state, home).find(
      (key) => state.systems[key].planets.length > 0,
    )!;
    const planet = state.systems[target].planets[0];
    state = play(state, id, {
      type: "ADJUST",
      adjustment: { type: "planetControl", planet, player: enemy },
    });
    state = play(state, id, {
      type: "ADJUST",
      adjustment: {
        type: "units",
        player: enemy,
        system: target,
        planet,
        unit: "pds",
        amount: 2,
      },
    });
    const homePlanet = state.systems[home].planets.find(
      (p) => countOf(state.planets[p].units[id], "infantry") >= 2,
    )!;
    state = play(state, id, { type: "ACTIVATE_SYSTEM", system: target });
    state = play(state, id, {
      type: "MOVE_SHIPS",
      moves: [{ from: home, ships: { carrier: 1 } }],
      cargo: [{ system: home, planet: homePlanet, units: { infantry: 2 } }],
    });
    let guard = 0;
    while (openPrompts(state).length > 0 && guard++ < 20) {
      const move = botMove(state)!;
      state = play(state, move.player, move.action);
    }
    const space = state.systems[target].space[id];
    expect(countOf(space, "carrier")).toBe(0);
    expect(countOf(space, "infantry")).toBe(0);
    expect(state.log.some((e) => /nothing left to carry them/.test(e.text))).toBe(true);
  });

  test("Sardakk N'orr add 1 and Jol-Nar subtract 1 from combat rolls", () => {
    const state = testGame({ factions: ["sardakk", "jolnar", "sol"] });
    const roll = (
      id: number,
      ability: "combat" | "spaceCannon",
      type: "cruiser" | "pds",
    ) => {
      const shooters = [{ type, count: 20 }];
      return rollAbility(structuredClone(state), id, shooters, ability).rolls[0];
    };
    const hitsWith = (r: { dice: number[]; target: number }, modifier: number) =>
      r.dice.filter((d) => d + modifier >= r.target).length;

    const sardakk = roll(0, "combat", "cruiser");
    const jolnar = roll(1, "combat", "cruiser");
    const sol = roll(2, "combat", "cruiser");
    // Dice on the boundary make the modifier visible in the hit count.
    expect(sardakk.dice).toContain(sardakk.target - 1);
    expect(jolnar.dice).toContain(jolnar.target);
    expect(sardakk.hits).toBe(hitsWith(sardakk, 1));
    expect(jolnar.hits).toBe(hitsWith(jolnar, -1));
    expect(sol.hits).toBe(hitsWith(sol, 0));
    // Only combat rolls: SPACE CANNON is unmodified.
    const cannon = roll(0, "spaceCannon", "pds");
    expect(cannon.hits).toBe(hitsWith(cannon, 0));
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
    // Action-phase secrets are checked against what happened this turn.
    expect(objectiveStatus(state, SOL, "dtgs").met).toBe(false);
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
    // Players holding agenda-phase cards are asked first; they pass here.
    while (openPrompts(state)[0]?.kind === "window") {
      const [prompt] = openPrompts(state);
      state = play(state, prompt.player, { type: "PASS_WINDOW", promptId: prompt.id });
    }

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
