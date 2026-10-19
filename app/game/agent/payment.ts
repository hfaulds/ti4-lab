/**
 * Choosing which planets and trade goods to spend, and what to hold back for
 * the objective a player means to score this round.
 */
import { PlayerId } from "~/types";
import { ObjectivePayment } from "../actions";
import { GameState, Payment } from "../types";
import {
  controlledPlanets,
  planetInfluence,
  planetResources,
} from "../engine/board";
import { Currency } from "../engine/economy";
import { objectiveStatus, scorableObjectives } from "../engine/objectives";
import { objectivesById } from "../data";

/** Planets and trade goods that are spoken for. */
export type Reservation = {
  planets: string[];
  tradeGoods: number;
  /** Tactic and strategy tokens to keep for an objective. */
  tokens: number;
};

export const NO_RESERVATION: Reservation = { planets: [], tradeGoods: 0, tokens: 0 };

const valueOf = (state: GameState, name: string, currency: Currency) =>
  currency === "resources"
    ? planetResources(state, name)
    : planetInfluence(state, name);

const otherCurrency = (currency: Currency): Currency =>
  currency === "resources" ? "influence" : "resources";

export const readyPlanets = (state: GameState, id: PlayerId) =>
  controlledPlanets(state, id)
    .filter((p) => !p.exhausted)
    .map((p) => p.name)
    .sort();

/** Ready planets and trade goods worth spending, after a reservation. */
export function spendable(
  state: GameState,
  id: PlayerId,
  currency: Currency,
  reserved: Reservation = NO_RESERVATION,
) {
  const planets = readyPlanets(state, id)
    .filter((name) => !reserved.planets.includes(name))
    .reduce((sum, name) => sum + valueOf(state, name, currency), 0);
  return planets + Math.max(0, state.players[id].tradeGoods - reserved.tradeGoods);
}

/**
 * A payment worth at least `amount`, spending planets that are good at this
 * currency and poor at the other one first, then trade goods for the rest.
 */
export function findPayment(
  state: GameState,
  id: PlayerId,
  amount: number,
  currency: Currency,
  reserved: Reservation = NO_RESERVATION,
): Payment | undefined {
  if (amount <= 0) return { planets: [], tradeGoods: 0 };
  const value = (name: string) => valueOf(state, name, currency);
  const other = (name: string) => valueOf(state, name, otherCurrency(currency));
  const candidates = readyPlanets(state, id)
    .filter((name) => !reserved.planets.includes(name) && value(name) > 0)
    .sort(
      (a, b) =>
        value(b) - other(b) - (value(a) - other(a)) ||
        value(b) - value(a) ||
        a.localeCompare(b),
    );

  const chosen: string[] = [];
  let total = 0;
  for (const name of candidates) {
    if (total >= amount) break;
    chosen.push(name);
    total += value(name);
  }
  // Give back planets the payment turned out not to need, smallest first.
  for (const name of [...chosen].sort((a, b) => value(a) - value(b))) {
    if (total - value(name) >= amount) {
      chosen.splice(chosen.indexOf(name), 1);
      total -= value(name);
    }
  }

  const tradeGoods = Math.max(0, state.players[id].tradeGoods - reserved.tradeGoods);
  const short = Math.max(0, amount - total);
  if (short > tradeGoods) return undefined;
  return { planets: chosen, tradeGoods: short };
}

const combine = (a: Reservation, payment: Payment): Reservation => ({
  planets: [...a.planets, ...payment.planets],
  tradeGoods: a.tradeGoods + payment.tradeGoods,
  tokens: a.tokens,
});

/** Pays an objective's cost, or returns undefined if it cannot be paid. */
export function objectivePayment(
  state: GameState,
  id: PlayerId,
  objective: string,
  reserved: Reservation = NO_RESERVATION,
): ObjectivePayment | undefined {
  const cost = objectiveStatus(state, id, objective).cost;
  if (!cost) return {};
  const player = state.players[id];
  const payment: ObjectivePayment = {};
  let held: Reservation = {
    ...reserved,
    tradeGoods: reserved.tradeGoods + (cost.tradeGoods ?? 0),
  };
  if (cost.tradeGoods) {
    if (player.tradeGoods < held.tradeGoods) return undefined;
    payment.tradeGoods = cost.tradeGoods;
  }
  if (cost.resources) {
    const resources = findPayment(state, id, cost.resources, "resources", held);
    if (!resources) return undefined;
    payment.resources = resources;
    held = combine(held, resources);
  }
  if (cost.influence) {
    const influence = findPayment(state, id, cost.influence, "influence", held);
    if (!influence) return undefined;
    payment.influence = influence;
    held = combine(held, influence);
  }
  if (cost.tokens) {
    const tactic = Math.min(player.pools.tactic, cost.tokens);
    const strategy = cost.tokens - tactic;
    if (strategy > player.pools.strategy) return undefined;
    payment.tokens = { tactic, strategy };
  }
  if (cost.actionCards) {
    if (player.actionCards.length < cost.actionCards) return undefined;
    payment.actionCards = player.actionCards.slice(0, cost.actionCards);
  }
  if (cost.relicFragments) return undefined;
  return payment;
}

/**
 * The public objective a player plans to score in the coming status phase,
 * and what to hold back to pay for it. An objective the engine can check and
 * the player already meets needs nothing held back.
 */
export function plannedObjective(
  state: GameState,
  id: PlayerId,
): { objective: string; reserved: Reservation } | undefined {
  const publics = scorableObjectives(state, id, "status")
    .filter((o) => objectivesById[o]?.kind !== "secret")
    .sort(
      (a, b) =>
        (objectivesById[b]?.points ?? 0) - (objectivesById[a]?.points ?? 0) ||
        a.localeCompare(b),
    );

  const free = publics.find((o) => {
    const status = objectiveStatus(state, id, o);
    return status.met === true && !status.cost;
  });
  if (free) return { objective: free, reserved: NO_RESERVATION };

  for (const objective of publics) {
    const status = objectiveStatus(state, id, objective);
    if (status.met !== true || !status.cost) continue;
    const payment = objectivePayment(state, id, objective);
    if (!payment) continue;
    return {
      objective,
      reserved: {
        planets: [
          ...(payment.resources?.planets ?? []),
          ...(payment.influence?.planets ?? []),
        ],
        tradeGoods:
          (payment.tradeGoods ?? 0) +
          (payment.resources?.tradeGoods ?? 0) +
          (payment.influence?.tradeGoods ?? 0),
        tokens: status.cost.tokens ?? 0,
      },
    };
  }
  return undefined;
}

/**
 * What to hold back: the planned objective's payment, plus trade goods saved
 * toward a revealed trade goods objective the player cannot pay for yet.
 */
export function reservationFor(state: GameState, id: PlayerId): Reservation {
  const planned = plannedObjective(state, id)?.reserved ?? NO_RESERVATION;
  const saving = Math.max(
    0,
    ...state.publicObjectives
      .filter((o) => o.revealed && !o.scoredBy.includes(id))
      .map((o) => objectiveStatus(state, id, o.id))
      .filter((status) => status.met === false)
      .map((status) => status.cost?.tradeGoods ?? 0),
  );
  const tradeGoods = Math.max(
    planned.tradeGoods,
    Math.min(state.players[id].tradeGoods, saving),
  );
  return { ...planned, tradeGoods };
}
