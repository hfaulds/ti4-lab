import { PlayerId } from "~/types";
import {
  isGroundForce,
  isShip,
  isStructure,
  technologiesById,
  UNIT_NAMES,
} from "../data";
import { hasCommander, unlockCommander } from "./leaders";

/** A player's breakthrough, once gained. */
const breakthroughOf = (state: GameState, id: PlayerId) => {
  const own = state.players[id]?.breakthrough;
  return own?.unlocked ? own.id : undefined;
};
import { ProductionOrder } from "../actions";
import { GameState, Payment, SystemKey } from "../types";
import { afterProducing } from "./events";
import {
  adjacentSystems,
  fleetProblem,
  hasAnomaly,
  isDemilitarized,
  neighborsOf,
  otherShipOwners,
  planetInfluence,
  planetOf,
  planetResources,
  systemOf,
  wormholesOf,
} from "./board";
import { openWindow } from "./reactions";
import {
  addUnits,
  countOf,
  ensure,
  fail,
  hasShips,
  hasTech,
  tokensInReinforcements,
  log,
  playerOf,
  requireUnit,
  totalUnits,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "./helpers";

/** "either" spends each planet for the better of its resources and influence. */
export type Currency = "resources" | "influence" | "either";

const valueOf = (state: GameState, planet: string, currency: Currency) =>
  currency === "resources"
    ? planetResources(state, planet)
    : currency === "influence"
      ? planetInfluence(state, planet)
      : Math.max(planetResources(state, planet), planetInfluence(state, planet));

/** Worth of a trade good when spent: 2 with Mirror Computing. */
export const tradeGoodValue = (state: GameState, id: PlayerId | undefined) =>
  id !== undefined && hasTech(state, id, "mc") ? 2 : 1;

export function paymentValue(
  state: GameState,
  payment: Payment | undefined,
  currency: Currency,
  allowTradeGoods = true,
  payer?: PlayerId,
) {
  if (!payment) return 0;
  const planets = payment.planets.reduce(
    (sum, name) => sum + valueOf(state, name, currency),
    0,
  );
  return (
    planets +
    (allowTradeGoods ? payment.tradeGoods * tradeGoodValue(state, payer) : 0)
  );
}

/** Exhausts the planets and spends the trade goods in a payment. */
export function pay(
  state: GameState,
  id: PlayerId,
  payment: Payment | undefined,
  requested: Currency,
  cost: number,
  options: { allowTradeGoods?: boolean } = {},
) {
  // Archon's Gift: influence and resources are interchangeable.
  const currency: Currency = breakthroughOf(state, id) === "xxchabt" ? "either" : requested;
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
  const value = paymentValue(state, spend, currency, allowTradeGoods, id);
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
  if (state.laws.some((law) => law.id === "minister_commerce" && law.owner === id)) {
    const neighbors = neighborsOf(state, id).length;
    player.tradeGoods += neighbors;
    log(state, `Minister of Commerce: ${player.name} gained ${neighbors} trade goods.`, {
      player: id,
    });
  }
  openWindow(state, "afterReplenish", { player: id });
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
  // Hegemonic Trade Policy swaps a planet's values for this production.
  const resourcesOf = (name: string) =>
    state.tactical?.flags?.includes(`htp@${name}:${id}`)
      ? planetInfluence(state, name)
      : planetResources(state, name);
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
    if (planet.attachments.includes("holy_planet_of_ixth")) continue;
    for (const type of unitTypes(planet.units[id])) {
      if (options.docksOnly && type !== "spacedock") continue;
      if (options.excludeDocks && type === "spacedock") continue;
      capacity +=
        valueOfUnit(type, resourcesOf(name)) * countOf(planet.units[id], type);
    }
  }
  for (const type of unitTypes(system.space[id])) {
    if (options.docksOnly && type !== "spacedock") continue;
    if (options.excludeDocks && type === "spacedock") continue;
    capacity += valueOfUnit(type, 0) * countOf(system.space[id], type);
  }
  // Magmus Reactor: a supernova with the player's units produces 5.
  if (
    !options.docksOnly &&
    hasTech(state, id, "mr") &&
    hasAnomaly(system, "SUPERNOVA") &&
    totalUnits(system.space[id]) > 0
  ) {
    capacity += 5;
  }
  // Particle Synthesis: each wormhole where the Creuss have ships produces 1.
  if (!options.docksOnly && breakthroughOf(state, id) === "ghostbt" && hasShips(system.space[id])) {
    capacity += wormholesOf(system).length;
  }
  // Aerie Hololattice: each planet with the Argent's structures produces 1.
  if (!options.docksOnly && hasTech(state, id, "ah")) {
    capacity += system.planets.filter(
      (name) => totalUnits(state.planets[name].units[id], isStructure) > 0,
    ).length;
  }
  return capacity;
}

/**
 * Cost reductions chosen during the production step: Berekar Berekon,
 * Harrugh Gefhara and AI Development Algorithm.
 */
export function productionOptions(state: GameState, id: PlayerId) {
  const flags = state.tactical?.flags ?? [];
  const upgrades = state.players[id].technologies.filter(
    (tech) => technologiesById[tech]?.unitUpgrade,
  ).length;
  return {
    discount:
      2 * flags.filter((flag) => flag === `berekar:${id}`).length +
      (flags.includes(`aida:${id}`) ? upgrades : 0),
    free: flags.includes(`gefhara:${id}`),
  };
}

export function productionCost(
  state: GameState,
  id: PlayerId,
  orders: ProductionOrder[],
) {
  // Units that come two for one cost are priced by the type's total, so a
  // pair split across planets (two orders) still costs a single unit price.
  const counts = new Map<ProductionOrder["type"], number>();
  for (const order of orders) {
    counts.set(order.type, (counts.get(order.type) ?? 0) + order.count);
  }
  let cost = 0;
  for (const [type, count] of counts) {
    const unit = requireUnit(state, id, type);
    if (unit.cost === undefined) fail(`${UNIT_NAMES[type]} cannot be produced.`);
    // Regulated Conscription: fighters and infantry come one at a time.
    const perCost = state.laws.some(
      (law) => law.id === "conscription" && law.outcome !== "Against",
    )
      ? 1
      : unit.producedPerCost;
    cost += Math.ceil(count / perCost) * unit.cost;
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
  options: {
    docksOnly?: boolean;
    limit?: number;
    /** Freelancers: influence may be spent as if it were resources. */
    currency?: Currency;
    /** Cost already reduced, such as by Berekar Berekon. */
    discount?: number;
    /** The units cost nothing (Harrugh Gefhara). */
    free?: boolean;
  } = {},
) {
  const system = systemOf(state, key);
  const player = playerOf(state, id);
  const units = orders.filter((o) => o.count > 0);
  ensure(units.length > 0, "Choose at least one unit to produce.");

  const total = units.reduce((sum, o) => sum + o.count, 0);
  // Bellum Gloriosum: cargo for the produced ships does not count.
  const carried =
    breakthroughOf(state, id) === "solbt"
      ? Math.min(
          units.filter((o) => isShip(o.type)).reduce((sum, o) => sum + (unitOf(state, id, o.type)?.capacity ?? 0) * o.count, 0),
          units.filter((o) => o.type === "fighter" || isGroundForce(o.type)).reduce((sum, o) => sum + o.count, 0),
        )
      : 0;
  // That Which Molds Flesh: 2 fighters or infantry do not count.
  const molded = carried + (hasCommander(state, id, "cabalcommander")
    ? Math.min(
        2,
        units
          .filter((o) => o.type === "fighter" || o.type === "infantry")
          .reduce((sum, o) => sum + o.count, 0),
      )
    : 0);
  const capacity =
    options.limit ?? productionCapacity(state, key, id, options);
  ensure(
    total - molded <= capacity,
    `Your units there can produce ${capacity} units, not ${total - molded}.`,
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
        ensure(
          !isDemilitarized(planet),
          `${order.planet} is a demilitarized zone.`,
        );
        const trilossa = !!state.tactical?.flags?.includes(`trilossa:${id}`);
        ensure(
          planet.system === key ||
            (trilossa && adjacentSystems(state, key).includes(planet.system)),
          `${order.planet} is not in that system.`,
        );
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

  // Particle Synthesis: 1 cheaper for each wormhole in the system.
  const wormholeDiscount = breakthroughOf(state, id) === "ghostbt" ? wormholesOf(system).length : 0;
  const cost = options.free
    ? 0
    : Math.max(
        0,
        productionCost(state, id, units) -
          (options.discount ?? 0) -
          wormholeDiscount -
          freeUnitsDiscount(state, id, units),
      );
  pay(state, id, payment, options.currency ?? "resources", cost);
  // Auto-Factories: 3 or more non-fighter ships bring a fleet token.
  const capitalShips = units.filter((o) => isShip(o.type) && o.type !== "fighter").reduce((sum, o) => sum + o.count, 0);
  if (capitalShips >= 3 && breakthroughOf(state, id) === "hacanbt" && tokensInReinforcements(state, id) > 0) {
    player.pools.fleet++;
    log(state, `Auto-Factories: ${player.name} gained a fleet token.`, { player: id });
  }

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
  // Prophecy of Ixth is kept only by producing 2 or more fighters.
  const prophecy = state.laws.find((law) => law.id === "prophecy" && law.owner === id);
  const fighters = units
    .filter((o) => o.type === "fighter")
    .reduce((sum, o) => sum + o.count, 0);
  if (prophecy && fighters < 2) {
    state.laws = state.laws.filter((law) => law !== prophecy);
    state.decks.agendas.discard.push(prophecy.id);
    log(state, `${player.name} discarded Prophecy of Ixth.`, { player: id });
  }
  // Magmus unlocks when the Muaat produce a war sun.
  if (units.some((o) => o.type === "warsun") && player.faction === "muaat") {
    unlockCommander(state, id);
  }
  // Tungstantus
  if (hasCommander(state, id, "titanscommander")) {
    player.tradeGoods++;
    log(state, `Tungstantus: ${player.name} gained 1 trade good.`, { player: id });
  }
  afterProducing(state, id, key, units);
}

/**
 * Units that cost nothing: the flagship with Navarch Feng, and units the
 * Vuil'raith pay for by returning a captured unit of the type (Amalgamation).
 */
function freeUnitsDiscount(state: GameState, id: PlayerId, orders: ProductionOrder[]) {
  const player = state.players[id];
  let discount = 0;
  const produced = (type: ProductionOrder["type"]) =>
    orders.filter((o) => o.type === type).reduce((sum, o) => sum + o.count, 0);
  if (produced("flagship") > 0 && hasCommander(state, id, "nomadcommander")) {
    discount += unitOf(state, id, "flagship")?.cost ?? 0;
  }
  if (player.faction === "vulraith" && (player.captured ?? []).length > 0) {
    for (const type of [...new Set(orders.map((o) => o.type))]) {
      const unit = unitOf(state, id, type);
      if (!unit?.cost) continue;
      const returned = returnCaptured(state, id, type, produced(type));
      // Units bought two at a time are worth half their cost each.
      discount += Math.floor((returned * unit.cost) / unit.producedPerCost);
    }
  }
  return discount;
}

/** Gives up to `count` captured units of a type back to their owners. */
export function returnCaptured(state: GameState, id: PlayerId, type: ProductionOrder["type"], count: number) {
  const player = state.players[id];
  let returned = 0;
  for (const capture of player.captured ?? []) {
    if (capture.type !== type || returned >= count) continue;
    const taken = Math.min(capture.count, count - returned);
    capture.count -= taken;
    returned += taken;
  }
  player.captured = (player.captured ?? []).filter((c) => c.count > 0);
  if (returned > 0) {
    log(state, `${player.name} returned ${returned} captured ${UNIT_NAMES[type]}.`, { player: id });
  }
  return returned;
}
