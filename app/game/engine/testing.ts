/**
 * Fixtures for exercising the rules engine: a ready-made six-player board
 * and a simple automatic player that always has a legal move to make.
 */
import { draftConfig } from "~/draft";
import { FactionId, Map as TiMap, PlayerId } from "~/types";
import { generateEmptyMap } from "~/utils/map";
import { isGroundForce, isShip, strategyCardsById } from "../data";
import { GameAction, StrategicPayload } from "../actions";
import { Expansion, GameState, Prompt, UnitCounts } from "../types";
import {
  adjacentSystems,
  findRoute,
  MECATOL_REX,
  moveRulesFor,
  nonFighterShips,
  systemsWithShips,
} from "./board";
import { suggestAssignment } from "./combat";
import {
  COMMAND_TOKEN_LIMIT,
  countOf,
  openPrompts,
  tokensOnBoard,
  totalTokens,
  unitOf,
  unitTypes,
} from "./helpers";
import { applyAction, createGame, settle } from "./index";
import { objectiveStatus, scorableObjectives } from "./objectives";
import { availableStrategyCards } from "./phases";
import { strategyKind } from "./strategic";

const TEST_SYSTEMS = [
  "19", "20", "21", "22", "23", "24", "25", "26", "27", "28",
  "29", "30", "31", "32", "33", "34", "35", "36", "37", "38",
  "39", "40", "41", "42", "43", "44", "45", "46", "47", "48",
];

export const TEST_FACTIONS: FactionId[] = [
  "sol",
  "hacan",
  "jolnar",
  "xxcha",
  "barony",
  "yin",
];

export function testMap(
  players: number,
  systems: string[] = TEST_SYSTEMS,
): TiMap {
  let next = 0;
  return generateEmptyMap(draftConfig.milty).map((tile) => {
    if (tile.type === "HOME") {
      const seat = tile.seat ?? 0;
      return seat < players ? { ...tile, playerId: seat } : tile;
    }
    if (tile.type !== "OPEN") return tile;
    return {
      idx: tile.idx,
      position: tile.position,
      type: "SYSTEM" as const,
      systemId: systems[next++ % systems.length],
    };
  });
}

export function testGame(
  options: {
    factions?: FactionId[];
    expansions?: Expansion[];
    seed?: number;
    victoryPoints?: number;
    map?: TiMap;
  } = {},
): GameState {
  const factions = options.factions ?? TEST_FACTIONS;
  return settle(
    createGame({
      players: factions.map((faction, id) => ({
        id,
        name: `Player ${id + 1}`,
        faction,
        factionVariant: faction === "keleres" ? "mentak" : undefined,
        speakerOrder: id,
      })),
      map: options.map ?? testMap(factions.length),
      options: {
        expansions: options.expansions ?? [],
        victoryPoints: options.victoryPoints ?? 10,
      },
      seed: options.seed ?? 1,
    }),
  );
}

/** Applies an action that is expected to be legal. */
export function play(
  state: GameState,
  player: PlayerId,
  action: GameAction,
): GameState {
  const result = applyAction(state, player, action);
  if (!result.ok) {
    throw new Error(`${action.type} by player ${player}: ${result.error}`);
  }
  return result.state;
}

export function rejection(
  state: GameState,
  player: PlayerId,
  action: GameAction,
): string | undefined {
  const result = applyAction(state, player, action);
  return result.ok ? undefined : result.error;
}

/** Answers every open setup decision so the game reaches round one. */
export function skipSetup(state: GameState): GameState {
  let current = state;
  while (current.phase === "setup") {
    const move = botMove(current);
    if (!move) break;
    current = play(current, move.player, move.action);
  }
  return current;
}

// --- Automatic player -------------------------------------------------------

export type BotMove = { player: PlayerId; action: GameAction };

function poolsAfterGaining(state: GameState, id: PlayerId, gained: number) {
  const player = state.players[id];
  const room =
    COMMAND_TOKEN_LIMIT - totalTokens(player) - tokensOnBoard(state, id);
  const received = Math.max(0, Math.min(gained, room));
  return { ...player.pools, tactic: player.pools.tactic + received };
}

function answer(state: GameState, prompt: Prompt): GameAction {
  const id = prompt.player;
  const player = state.players[id];
  switch (prompt.kind) {
    case "chooseSecret":
      return { type: "CHOOSE_SECRET", keep: prompt.options[0] };
    case "chooseStartingTech":
      return {
        type: "CHOOSE_STARTING_TECH",
        technologies: prompt.options.slice(0, prompt.count),
      };
    case "secondary":
      return { type: "RESOLVE_SECONDARY", promptId: prompt.id };
    case "politicsAgenda":
      return { type: "ORDER_AGENDAS", top: prompt.cards, bottom: [] };
    case "spaceCannon":
      return { type: "FIRE_SPACE_CANNON", promptId: prompt.id, fire: true };
    case "assignHits":
      return {
        type: "ASSIGN_HITS",
        promptId: prompt.id,
        assignment: suggestAssignment(state, prompt),
      };
    case "announceRetreat":
      return { type: "ANNOUNCE_RETREAT" };
    case "scoreObjectives": {
      const free = scorableObjectives(state, id, "status").filter((o) => {
        const status = objectiveStatus(state, id, o);
        return status.met === true && !status.cost;
      });
      const secrets = free.filter((o) => player.secretObjectives.includes(o));
      const publics = free.filter((o) => !secrets.includes(o));
      const homeHeld = state.systems[player.home].planets.every(
        (p) => state.planets[p].controller === id,
      );
      return {
        type: "SCORE_OBJECTIVES",
        publicObjective: homeHeld ? publics[0] : undefined,
        secretObjective: secrets[0],
      };
    }
    case "redistribute":
      return {
        type: "REDISTRIBUTE",
        pools: poolsAfterGaining(state, id, prompt.gained),
      };
    case "discardActionCards":
      return {
        type: "DISCARD_ACTION_CARDS",
        cards: player.actionCards.slice(0, prompt.count),
      };
    case "returnSecret":
      return { type: "RETURN_SECRET", objective: player.secretObjectives[0] };
    case "vote":
      return { type: "CAST_VOTES", planets: [] };
    case "breakTie":
      return { type: "BREAK_TIE", outcome: prompt.outcomes[0] ?? "For" };
    case "resolve":
      return { type: "RESOLVE", promptId: prompt.id };
  }
}

function strategicPayload(state: GameState, id: PlayerId): StrategicPayload {
  const card = state.players[id].strategyCards.find((c) => !c.exhausted)!;
  const kind = strategyKind(card.id);
  switch (kind) {
    case "leadership":
      return { card: kind, pools: poolsAfterGaining(state, id, 3) };
    case "diplomacy":
      return { card: kind, ready: [] };
    case "politics":
      return { card: kind };
    case "construction":
      return { card: kind, structures: [] };
    case "trade":
      return { card: kind };
    case "warfare":
      return strategyCardsById[card.id].source === "te"
        ? { card: kind, removeFrom: state.players[id].home }
        : { card: kind };
    case "technology":
      return { card: kind };
    case "imperial":
      return { card: kind };
  }
}

function movement(state: GameState, id: PlayerId): GameAction {
  const tactical = state.tactical!;
  const rules = moveRulesFor(state, id, tactical.system);
  const fleet = state.players[id].pools.fleet;
  const present = nonFighterShips(state, tactical.system, id);

  for (const origin of systemsWithShips(state, id)) {
    if (origin.key === tactical.system) continue;
    if (origin.commandTokens.includes(id)) continue;
    const ships: UnitCounts = {};
    let capacity = 0;
    let moving = 0;
    for (const type of unitTypes(origin.space[id])) {
      const unit = unitOf(state, id, type);
      if (!isShip(type) || type === "fighter" || !unit?.move) continue;
      if (!findRoute(state, origin.key, unit.move, rules)) continue;
      const count = Math.min(
        countOf(origin.space[id], type),
        Math.max(0, fleet - present - moving),
      );
      if (count === 0) continue;
      ships[type] = count;
      moving += count;
      capacity += (unit.capacity ?? 0) * count;
    }
    if (moving === 0) continue;

    const cargo = [];
    for (const name of origin.planets) {
      const infantry = countOf(state.planets[name].units[id], "infantry");
      // Leave a garrison behind.
      const lifted = Math.min(capacity, Math.max(0, infantry - 1));
      if (lifted === 0) continue;
      cargo.push({
        system: origin.key,
        planet: name,
        units: { infantry: lifted },
      });
      capacity -= lifted;
    }
    return { type: "MOVE_SHIPS", moves: [{ from: origin.key, ships }], cargo };
  }
  return { type: "MOVE_SHIPS", moves: [], cargo: [] };
}

function landing(state: GameState, id: PlayerId): GameAction {
  const system = state.systems[state.tactical!.system];
  const units: UnitCounts = {};
  for (const type of unitTypes(system.space[id])) {
    if (isGroundForce(type)) units[type] = countOf(system.space[id], type);
  }
  const planet = system.planets.find(
    (name) =>
      state.planets[name].controller !== id &&
      !(name === MECATOL_REX && state.custodians),
  );
  return {
    type: "COMMIT_GROUND_FORCES",
    landings: planet ? [{ planet, units }] : [],
  };
}

function chooseTarget(state: GameState, id: PlayerId) {
  const candidates = new Set<number>();
  for (const system of systemsWithShips(state, id)) {
    if (system.commandTokens.includes(id)) continue;
    for (const key of adjacentSystems(state, system.key)) {
      if (!state.systems[key].commandTokens.includes(id)) candidates.add(key);
    }
  }
  const options = [...candidates].sort((a, b) => a - b);
  if (options.length === 0) return undefined;
  return options[state.version % options.length];
}

/** The next move for whoever the game is waiting on, if anyone. */
export function botMove(state: GameState): BotMove | undefined {
  if (state.phase === "finished") return undefined;
  const [prompt] = openPrompts(state);
  if (prompt) return { player: prompt.player, action: answer(state, prompt) };

  const id = state.activePlayer;
  if (id === undefined) return undefined;
  const player = state.players[id];

  if (state.phase === "strategy") {
    const cards = availableStrategyCards(state);
    return {
      player: id,
      action: {
        type: "PICK_STRATEGY_CARD",
        card: cards[state.version % cards.length],
      },
    };
  }
  if (state.phase !== "action") return undefined;

  if (state.tactical) {
    switch (state.tactical.step) {
      case "movement":
        return { player: id, action: movement(state, id) };
      case "bombardment":
        return { player: id, action: { type: "BOMBARD", targets: [] } };
      case "commit":
        return { player: id, action: landing(state, id) };
      case "production":
        return {
          player: id,
          action: {
            type: "PRODUCE",
            units: [],
            payment: { planets: [], tradeGoods: 0 },
          },
        };
      default:
        return undefined;
    }
  }

  if (state.actionsThisTurn > 0) {
    return { player: id, action: { type: "END_TURN" } };
  }
  const target =
    player.pools.tactic > 0 && state.version % 3 !== 0
      ? chooseTarget(state, id)
      : undefined;
  if (target !== undefined) {
    return { player: id, action: { type: "ACTIVATE_SYSTEM", system: target } };
  }
  if (player.strategyCards.some((card) => !card.exhausted)) {
    return {
      player: id,
      action: { type: "STRATEGIC_ACTION", payload: strategicPayload(state, id) },
    };
  }
  return { player: id, action: { type: "PASS" } };
}

/** Plays automatically until the game ends or the move budget runs out. */
export function autoplay(state: GameState, moves: number): GameState {
  let current = state;
  for (let i = 0; i < moves; i++) {
    const move = botMove(current);
    if (!move) return current;
    current = play(current, move.player, move.action);
  }
  return current;
}
