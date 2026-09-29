import { PlayerId } from "~/types";
import { strategyCardsById, UNIT_NAMES } from "../data";
import {
  ProductionOrder,
  StrategicPayload,
  StructurePlacement,
} from "../actions";
import { CommandPools, GameState, Payment, Prompt } from "../types";
import { fleetProblem, MECATOL_REX, planetOf, systemOf } from "./board";
import { victoryPoints, checkVictory } from "./control";
import { pay, paymentValue, produce, replenishCommodities } from "./economy";
import {
  addUnits,
  ask,
  clockwiseFrom,
  COMMAND_TOKEN_LIMIT,
  countOf,
  drawActionCards,
  drawSecretObjective,
  ensure,
  fail,
  log,
  playerName,
  playerOf,
  tokensInReinforcements,
  tokensOnBoard,
  totalTokens,
  unitsAvailable,
} from "./helpers";
import { scoreObjective } from "./objectives";
import { activateSystem, describeSystem } from "./tactical";
import { research } from "./technology";

export type StrategyKind = StrategicPayload["card"];

export const strategyKind = (card: string): StrategyKind =>
  strategyCardsById[card].name.toLowerCase() as StrategyKind;

const isThundersEdge = (card: string) => strategyCardsById[card].source === "te";

const INFLUENCE_PER_TOKEN = 3;
const SECOND_TECHNOLOGY_COST = 6;
const SECONDARY_TECHNOLOGY_COST = 4;

// --- Command tokens ---------------------------------------------------------

/**
 * Sets a player's pools to a new split. `gained` tokens are added from
 * reinforcements, capped by what is left there.
 */
export function setPools(
  state: GameState,
  id: PlayerId,
  pools: CommandPools,
  gained: number,
) {
  const player = playerOf(state, id);
  for (const pool of Object.values(pools)) {
    ensure(
      Number.isInteger(pool) && pool >= 0,
      "Pools need whole, non-negative token counts.",
    );
  }
  const available = Math.max(
    0,
    Math.min(gained, COMMAND_TOKEN_LIMIT - totalTokens(player) - tokensOnBoard(state, id)),
  );
  const expected = totalTokens(player) + available;
  const requested = pools.tactic + pools.fleet + pools.strategy;
  ensure(
    requested === expected,
    `Distribute exactly ${expected} command tokens between your pools.`,
  );
  const previous = player.pools.fleet;
  player.pools = { ...pools };
  if (pools.fleet < previous) {
    for (const key of Object.keys(state.systems).map(Number)) {
      const problem = fleetProblem(state, key, id);
      if (problem) {
        fail(
          `${problem} Remove ships from ${describeSystem(state, key)} first, or keep a larger fleet pool.`,
        );
      }
    }
  }
  return available;
}

// --- Structures -------------------------------------------------------------

const STRUCTURE_LIMIT: Record<StructurePlacement["type"], number> = {
  pds: 2,
  spacedock: 1,
};

export function placeStructure(
  state: GameState,
  id: PlayerId,
  { type, planet: name }: StructurePlacement,
) {
  const planet = planetOf(state, name);
  ensure(planet.controller === id, `You do not control ${name}.`);
  ensure(
    countOf(planet.units[id], type) < STRUCTURE_LIMIT[type],
    `${name} cannot hold another ${UNIT_NAMES[type]}.`,
  );
  ensure(
    unitsAvailable(state, id, type) > 0,
    `You have no ${UNIT_NAMES[type]} left in your reinforcements.`,
  );
  addUnits(planet.units, id, type, 1);
  log(state, `${playerName(state, id)} built a ${UNIT_NAMES[type]} on ${name}.`, {
    player: id,
  });
}

// --- Primary abilities ------------------------------------------------------

export function strategicAction(
  state: GameState,
  id: PlayerId,
  payload: StrategicPayload,
) {
  const player = playerOf(state, id);
  const held = player.strategyCards.find(
    (card) => strategyKind(card.id) === payload.card,
  );
  ensure(held, "You do not hold that strategy card.");
  ensure(!held.exhausted, "You have already used that strategy card.");

  const card = strategyCardsById[held.id];
  log(state, `${player.name} played ${card.name}.`, { player: id });
  state.strategic = { player: id, card: held.id };

  let secondaryFor = clockwiseFrom(state, id).filter((other) => other !== id);
  let free: PlayerId[] = [];

  switch (payload.card) {
    case "leadership": {
      const spent = paymentValue(state, payload.influence, "influence");
      if (payload.influence) {
        pay(state, id, payload.influence, "influence", 0);
      }
      const gained = 3 + Math.floor(spent / INFLUENCE_PER_TOKEN);
      const received = setPools(state, id, payload.pools, gained);
      log(state, `${player.name} gained ${received} command tokens.`, {
        player: id,
      });
      break;
    }
    case "diplomacy": {
      if (payload.system !== undefined) {
        const system = systemOf(state, payload.system);
        ensure(
          !system.planets.includes(MECATOL_REX),
          "Diplomacy cannot target the Mecatol Rex system.",
        );
        ensure(
          system.planets.some((p) => state.planets[p].controller === id),
          "Choose a system that contains a planet you control.",
        );
        for (const other of secondaryFor) {
          if (system.commandTokens.includes(other)) continue;
          const target = state.players[other];
          if (tokensInReinforcements(state, other) <= 0) {
            const pool = (["tactic", "strategy", "fleet"] as const).find(
              (p) => target.pools[p] > 0,
            );
            if (!pool) continue;
            target.pools[pool]--;
          }
          system.commandTokens.push(other);
        }
        log(
          state,
          `Every other player placed a command token in ${describeSystem(state, payload.system)}.`,
        );
      }
      readyPlanets(state, id, payload.ready);
      break;
    }
    case "politics": {
      if (payload.speaker !== undefined) {
        ensure(
          payload.speaker !== state.speaker,
          "Choose a player other than the current speaker.",
        );
        ensure(state.players[payload.speaker], "Unknown player.");
        state.speaker = payload.speaker;
        log(state, `${playerName(state, payload.speaker)} is now the speaker.`);
      }
      drawActionCards(state, id, 2);
      const cards = state.decks.agendas.draw.slice(0, 2);
      if (cards.length > 0) {
        ask(state, [{ kind: "politicsAgenda", player: id, cards }]);
      }
      break;
    }
    case "construction": {
      const structures = payload.structures;
      if (isThundersEdge(held.id)) {
        ensure(structures.length <= 2, "Construction places up to 2 structures.");
        if (payload.production) {
          ensure(
            structures.length <= 1,
            "Produce at a space dock or place a first structure, not both.",
          );
          produce(
            state,
            id,
            payload.production.system,
            payload.production.units,
            payload.production.payment,
            { docksOnly: true },
          );
        }
      } else {
        ensure(structures.length <= 2, "Construction places up to 2 structures.");
        ensure(
          structures.filter((s) => s.type === "spacedock").length <= 1,
          "Construction places at most 1 space dock.",
        );
      }
      for (const structure of structures) placeStructure(state, id, structure);
      break;
    }
    case "trade": {
      player.tradeGoods += 3;
      log(state, `${player.name} gained 3 trade goods.`, { player: id });
      replenishCommodities(state, id);
      free = (payload.allow ?? []).filter((other) => secondaryFor.includes(other));
      break;
    }
    case "warfare": {
      if (isThundersEdge(held.id)) {
        if (payload.pools) setPools(state, id, payload.pools, 0);
        ensure(
          payload.removeFrom !== undefined,
          "Choose a system for the tactical action.",
        );
        state.strategic = undefined;
        held.exhausted = true;
        activateSystem(state, id, payload.removeFrom, { free: true });
        // The secondary is offered once the tactical action is under way.
        askSecondaries(state, id, held.id, secondaryFor, []);
        return;
      }
      let gained = 0;
      if (payload.removeFrom !== undefined) {
        const system = systemOf(state, payload.removeFrom);
        ensure(
          system.commandTokens.includes(id),
          "You have no command token in that system.",
        );
        system.commandTokens = system.commandTokens.filter((t) => t !== id);
        gained = 1;
        log(
          state,
          `${player.name} removed their command token from ${describeSystem(state, payload.removeFrom)}.`,
          { player: id },
        );
      }
      setPools(
        state,
        id,
        payload.pools ?? { ...player.pools, tactic: player.pools.tactic + gained },
        gained,
      );
      break;
    }
    case "technology": {
      if (payload.research) research(state, id, payload.research);
      if (payload.second) {
        pay(
          state,
          id,
          payload.second.payment,
          "resources",
          SECOND_TECHNOLOGY_COST,
        );
        research(state, id, payload.second);
      }
      break;
    }
    case "imperial": {
      if (payload.objective) {
        ensure(
          state.publicObjectives.some(
            (o) => o.id === payload.objective && o.revealed,
          ),
          "Imperial scores a public objective.",
        );
        scoreObjective(state, id, payload.objective, payload.payment);
      }
      if (state.phase === "finished") return;
      if (state.planets[MECATOL_REX]?.controller === id) {
        player.bonusVictoryPoints += 1;
        log(
          state,
          `${player.name} gained 1 victory point for holding Mecatol Rex (${victoryPoints(state, id)} VP).`,
          { player: id },
        );
        checkVictory(state);
        if ((state.phase as string) === "finished") return;
      } else {
        drawSecretObjective(state, id);
      }
      break;
    }
  }

  // Secondaries wait behind anything the primary itself is waiting on.
  secondaryFor = secondaryFor.filter((other) => !state.players[other].eliminated);
  askSecondaries(state, id, held.id, secondaryFor, free);
}

function askSecondaries(
  state: GameState,
  from: PlayerId,
  card: string,
  players: PlayerId[],
  free: PlayerId[],
) {
  const group = state.nextId++;
  state.prompts.push(
    ...players.map(
      (player) =>
        ({
          id: state.nextId++,
          group,
          kind: "secondary",
          player,
          card,
          from,
          free: free.includes(player) || undefined,
        }) as Prompt,
    ),
  );
}

export function finishStrategic(state: GameState) {
  const strategic = state.strategic;
  if (!strategic) return;
  const held = state.players[strategic.player].strategyCards.find(
    (card) => card.id === strategic.card,
  );
  if (held) held.exhausted = true;
  state.strategic = undefined;
  state.actionsThisTurn++;
}

function readyPlanets(state: GameState, id: PlayerId, planets: string[]) {
  ensure(planets.length <= 2, "Diplomacy readies up to 2 planets.");
  for (const name of planets) {
    const planet = planetOf(state, name);
    ensure(planet.controller === id, `You do not control ${name}.`);
    planet.exhausted = false;
  }
  if (planets.length > 0) {
    log(state, `${playerName(state, id)} readied ${planets.join(" and ")}.`, {
      player: id,
    });
  }
}

// --- Secondary abilities ----------------------------------------------------

export function resolveSecondary(
  state: GameState,
  id: PlayerId,
  prompt: Extract<Prompt, { kind: "secondary" }>,
  payload?: StrategicPayload,
) {
  const player = playerOf(state, id);
  const card = strategyCardsById[prompt.card];
  if (!payload) {
    log(state, `${player.name} passed on ${card.name}.`, { player: id });
    return;
  }
  const kind = strategyKind(prompt.card);
  ensure(payload.card === kind, "That does not match the strategy card played.");

  // Leadership's secondary is free; Trade's is when the active player says so.
  const costsToken = kind !== "leadership" && !prompt.free;
  if (costsToken) {
    ensure(player.pools.strategy > 0, "Your strategy pool is empty.");
    player.pools.strategy--;
  }
  log(state, `${player.name} used the secondary of ${card.name}.`, {
    player: id,
  });

  switch (payload.card) {
    case "leadership": {
      const spent = paymentValue(state, payload.influence, "influence");
      pay(state, id, payload.influence, "influence", 0);
      const gained = Math.floor(spent / INFLUENCE_PER_TOKEN);
      ensure(gained > 0, "Spend at least 3 influence to gain a command token.");
      setPools(state, id, payload.pools, gained);
      break;
    }
    case "diplomacy":
      readyPlanets(state, id, payload.ready);
      break;
    case "politics":
      drawActionCards(state, id, 2);
      break;
    case "construction": {
      const [structure] = payload.structures;
      ensure(
        structure && payload.structures.length === 1,
        "Construction's secondary places 1 structure.",
      );
      if (!isThundersEdge(prompt.card)) {
        // The spent token lands in the structure's system.
        const system = systemOf(state, planetOf(state, structure.planet).system);
        if (!system.commandTokens.includes(id)) system.commandTokens.push(id);
      }
      placeStructure(state, id, structure);
      break;
    }
    case "trade":
      replenishCommodities(state, id);
      break;
    case "warfare": {
      ensure(payload.production, "Choose units to produce.");
      secondaryProduction(
        state,
        id,
        payload.production.units,
        payload.production.payment,
        isThundersEdge(prompt.card),
      );
      break;
    }
    case "technology": {
      ensure(payload.research, "Choose a technology to research.");
      pay(state, id, payload.payment, "resources", SECONDARY_TECHNOLOGY_COST);
      research(state, id, payload.research);
      break;
    }
    case "imperial":
      drawSecretObjective(state, id);
      break;
  }
}

function secondaryProduction(
  state: GameState,
  id: PlayerId,
  units: ProductionOrder[],
  payment: Payment,
  allUnits: boolean,
) {
  const home = state.players[id].home;
  produce(state, id, home, units, payment, { docksOnly: !allUnits });
}

export function orderAgendas(
  state: GameState,
  cards: string[],
  top: string[],
  bottom: string[],
) {
  const chosen = [...top, ...bottom];
  ensure(
    chosen.length === cards.length && cards.every((c) => chosen.includes(c)),
    "Place each of the agendas on the top or the bottom of the deck.",
  );
  const deck = state.decks.agendas;
  deck.draw = deck.draw.filter((card) => !cards.includes(card));
  deck.draw = [...top, ...deck.draw, ...bottom];
}
