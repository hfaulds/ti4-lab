import { PlayerId } from "~/types";
import {
  isGroundForce,
  isShip,
  isStructure,
  UNIT_NAMES,
} from "../data";
import { ProductionOrder } from "../actions";
import { GameState, Payment, SystemKey } from "../types";
import {
  fleetProblem,
  otherShipOwners,
  planetInfluence,
  planetOf,
  planetResources,
  systemOf,
} from "./board";
import {
  addUnits,
  countOf,
  ensure,
  fail,
  hasTech,
  log,
  playerOf,
  requireUnit,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "./helpers";

export type Currency = "resources" | "influence";

const valueOf = (state: GameState, planet: string, currency: Currency) =>
  currency === "resources"
    ? planetResources(state, planet)
    : planetInfluence(state, planet);

export function paymentValue(
  state: GameState,
  payment: Payment | undefined,
  currency: Currency,
  allowTradeGoods = true,
) {
  if (!payment) return 0;
  const planets = payment.planets.reduce(
    (sum, name) => sum + valueOf(state, name, currency),
    0,
  );
  return planets + (allowTradeGoods ? payment.tradeGoods : 0);
}

/** Exhausts the planets and spends the trade goods in a payment. */
export function pay(
  state: GameState,
  id: PlayerId,
  payment: Payment | undefined,
  currency: Currency,
  cost: number,
  options: { allowTradeGoods?: boolean } = {},
) {
  const allowTradeGoods = options.allowTradeGoods ?? true;
  const player = playerOf(state, id);
  const spend: Payment = payment ?? { planets: [], tradeGoods: 0 };
  ensure(
    new Set(spend.planets).size === spend.planets.length,
    "A planet can only be exhausted once.",
  );
  for (const name of spend.planets) {
    const planet = state.planets[name];
    ensure(planet, `Unknown planet ${name}.`);
    ensure(planet.controller === id, `You do not control ${name}.`);
    ensure(!planet.exhausted, `${name} is already exhausted.`);
  }
  ensure(spend.tradeGoods >= 0, "Trade goods cannot be negative.");
  ensure(
    allowTradeGoods || spend.tradeGoods === 0,
    "Trade goods cannot be spent on this.",
  );
  ensure(
    spend.tradeGoods <= player.tradeGoods,
    "You do not have that many trade goods.",
  );
  const value = paymentValue(state, spend, currency, allowTradeGoods);
  ensure(
    value >= cost,
    `That pays ${value} ${currency}, but ${cost} ${cost === 1 ? "is" : "are"} needed.`,
  );
  for (const name of spend.planets) state.planets[name].exhausted = true;
  player.tradeGoods -= spend.tradeGoods;
  return value;
}

export function replenishCommodities(state: GameState, id: PlayerId) {
  const player = playerOf(state, id);
  player.commodities = player.commodityLimit;
  log(state, `${player.name} replenished commodities.`, { player: id });
}

// --- Production -------------------------------------------------------------

/** Combined PRODUCTION value of a player's units in a system. */
export function productionCapacity(
  state: GameState,
  key: SystemKey,
  id: PlayerId,
  options: { docksOnly?: boolean; excludeDocks?: boolean } = {},
) {
  const system = systemOf(state, key);
  let capacity = 0;
  const valueOfUnit = (type: Parameters<typeof unitOf>[2], resources: number) => {
    const unit = unitOf(state, id, type);
    if (!unit) return 0;
    if (unit.productionPlusResources !== undefined) {
      return unit.productionPlusResources + resources;
    }
    return unit.production ?? 0;
  };
  for (const name of system.planets) {
    const planet = state.planets[name];
    for (const type of unitTypes(planet.units[id])) {
      if (options.docksOnly && type !== "spacedock") continue;
      if (options.excludeDocks && type === "spacedock") continue;
      capacity +=
        valueOfUnit(type, planetResources(state, name)) *
        countOf(planet.units[id], type);
    }
  }
  for (const type of unitTypes(system.space[id])) {
    if (options.docksOnly && type !== "spacedock") continue;
    if (options.excludeDocks && type === "spacedock") continue;
    capacity += valueOfUnit(type, 0) * countOf(system.space[id], type);
  }
  return capacity;
}

export function productionCost(
  state: GameState,
  id: PlayerId,
  orders: ProductionOrder[],
) {
  let cost = 0;
  for (const order of orders) {
    const unit = requireUnit(state, id, order.type);
    if (unit.cost === undefined) fail(`${UNIT_NAMES[order.type]} cannot be produced.`);
    cost += Math.ceil(order.count / unit.producedPerCost) * unit.cost;
  }
  // Sarween Tools
  if (cost > 0 && hasTech(state, id, "st")) cost -= 1;
  return Math.max(0, cost);
}

/**
 * Produces units in a system using the PRODUCTION of the player's units
 * there, charging the player for them.
 */
export function produce(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  orders: ProductionOrder[],
  payment: Payment,
  options: { docksOnly?: boolean; limit?: number } = {},
) {
  const system = systemOf(state, key);
  const player = playerOf(state, id);
  const units = orders.filter((o) => o.count > 0);
  ensure(units.length > 0, "Choose at least one unit to produce.");

  const total = units.reduce((sum, o) => sum + o.count, 0);
  const capacity =
    options.limit ?? productionCapacity(state, key, id, options);
  ensure(
    total <= capacity,
    `Your units there can produce ${capacity} units, not ${total}.`,
  );

  const blockaded = otherShipOwners(system, id).length > 0;
  // Arborec space docks cannot produce infantry (LRR 68.1d), so their
  // infantry must fit within the PRODUCTION of their other units.
  const infantryLimit =
    player.faction === "arborec"
      ? productionCapacity(state, key, id, { excludeDocks: true })
      : Infinity;
  const infantry = units
    .filter((o) => o.type === "infantry")
    .reduce((sum, o) => sum + o.count, 0);
  ensure(
    infantry <= infantryLimit,
    "Arborec space docks cannot produce infantry.",
  );

  const needed: Partial<Record<string, number>> = {};
  for (const order of units) {
    ensure(Number.isInteger(order.count), "Unit counts must be whole numbers.");
    ensure(
      !isStructure(order.type),
      "Structures are built with Construction, not produced.",
    );
    needed[order.type] = (needed[order.type] ?? 0) + order.count;
    if (isShip(order.type)) {
      ensure(!order.planet, "Ships are produced in the space area.");
      ensure(
        !blockaded,
        "Ships cannot be produced while another player's ships blockade the system.",
      );
    }
    if (isGroundForce(order.type)) {
      if (order.planet) {
        const planet = planetOf(state, order.planet);
        ensure(planet.system === key, `${order.planet} is not in that system.`);
        ensure(
          planet.controller === id,
          `You do not control ${order.planet}.`,
        );
      }
    }
  }
  for (const [type, count] of Object.entries(needed)) {
    const available = unitsAvailable(state, id, type as ProductionOrder["type"]);
    ensure(
      (count ?? 0) <= available,
      `You only have ${available} ${UNIT_NAMES[type as ProductionOrder["type"]]} left in your reinforcements.`,
    );
  }

  const cost = productionCost(state, id, units);
  pay(state, id, payment, "resources", cost);

  for (const order of units) {
    if (order.planet) {
      addUnits(state.planets[order.planet].units, id, order.type, order.count);
    } else {
      addUnits(system.space, id, order.type, order.count);
    }
  }
  const problem = fleetProblem(state, key, id);
  if (problem) fail(problem);

  log(
    state,
    `${player.name} produced ${units
      .map((o) => `${o.count} ${UNIT_NAMES[o.type]}`)
      .join(", ")} for ${cost} resources.`,
    { player: id },
  );
}
