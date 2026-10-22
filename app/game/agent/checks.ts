/**
 * Rule-based checks that flag known mistakes in a chosen move: predicates
 * over (state, seat, action), each returning a plain-English warning when
 * it fires. They serve two purposes:
 *
 * - review in play: when the agent's choice trips a check, it is asked
 *   once more with the warning, and may keep its move or change it;
 * - evals: a case passes when the policy's choice trips none of the case's
 *   checks (see evals.ts).
 *
 * Checks are warnings, never vetoes: each mistake has exceptions a check
 * cannot see, so the agent decides.
 */
import { PlayerId } from "~/types";
import { isGroundForce, objectivesById } from "../data";
import { CargoPickup, GameAction, ProductionOrder } from "../actions";
import { GameState, SystemKey, UnitType } from "../types";
import {
  findRoute,
  hasAnomaly,
  MECATOL_REX,
  moveRulesFor,
  planetInfluence,
  planetResources,
  riftsExited,
} from "../engine/board";
import { totalUnits, unitOf } from "../engine/helpers";
import { applyAction } from "../engine/index";
import { objectiveStatus } from "../engine/objectives";
import { strategyKind } from "../engine/strategic";
import { moveBonus } from "../engine/tactical";
import { isStall, playerLabel, systemLabel, systemRef } from "./describe";
import { liftAfter } from "./lift";
import { shipsReaching } from "./reach";
import { bestPlan } from "./scriptedBot";

export type CheckId =
  | "stranded-ground-forces"
  | "objective-budget"
  | "empty-planet-threat"
  | "imperial-to-mecatol-holder"
  | "early-stall"
  | "gravity-rift-cargo";

export type Check = {
  id: CheckId;
  /** What the check looks for, for reports. */
  description: string;
  /** The warning when the move trips the check, or undefined. */
  run: (state: GameState, seat: PlayerId, action: GameAction) => string | undefined;
};

export type Finding = { check: CheckId; warning: string };

/** Bumped when a check changes, since checks change how the agent plays. */
export const CHECKS_VERSION = 1;

/** Ground forces left without a ride before a build counts as stranding them. */
const STRANDED_MIN = 2;
/** Rounds in which a do-nothing activation wastes a token better spent expanding. */
const EARLY_ROUNDS = 3;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const objectiveName = (id: string) => objectivesById[id]?.name ?? id;

/** What a move builds, and where, for any move that produces. */
function production(state: GameState, seat: PlayerId, action: GameAction) {
  const home = state.players[seat].home;
  if (action.type === "PRODUCE") {
    return { key: state.tactical?.system ?? home, units: action.units };
  }
  const payload =
    action.type === "RESOLVE_SECONDARY" || action.type === "STRATEGIC_ACTION" ? action.payload : undefined;
  if (payload?.card === "warfare" && payload.production) {
    return { key: home, units: payload.production.units };
  }
  return undefined;
}

const builtOf = (units: ProductionOrder[], type: UnitType) =>
  units.filter((u) => u.type === type).reduce((n, u) => n + u.count, 0);

/**
 * A build whose new ground forces the ships there cannot carry, so they sit
 * where they were built until a carrier comes; or a carrier built where
 * there is nothing for it to carry.
 */
function strandedGroundForces(state: GameState, seat: PlayerId, action: GameAction) {
  const order = production(state, seat, action);
  if (!order) return undefined;
  const lift = liftAfter(state, seat, order.key, order.units);
  const free = Math.max(0, lift.room - lift.aboard);
  const stranded = lift.built - free;
  const where = systemLabel(state, order.key);
  if (lift.built > 0 && stranded >= STRANDED_MIN) {
    return `Your build adds ${plural(lift.built, "ground force")} in ${where}, but your ships there would have room for ` +
      `${free} more, so ${stranded} cannot move until a carrier comes for them.`;
  }
  const carriers = builtOf(order.units, "carrier");
  if (carriers > 0 && lift.ground === 0) {
    return `Your build adds ${plural(carriers, "carrier")} in ${where}, where you have no ground forces for it to carry.`;
  }
  return undefined;
}

type Cost = { resources?: number; influence?: number; tradeGoods?: number };

/** Public objectives the seat could score now, met and paid for from what is ready. */
function scorable(state: GameState, seat: PlayerId) {
  return state.publicObjectives
    .filter((o) => o.revealed && !o.scoredBy.includes(seat))
    .filter((o) => objectiveStatus(state, seat, o.id).met === true)
    .map((o) => o.id);
}

/**
 * Whether an objective is paid in resources, influence or trade goods.
 * Token costs (Lead From the Front) are left out: nearly every move spends
 * a token, so warning about them would warn about everything.
 */
const paidInGoods = (state: GameState, seat: PlayerId, id: string) => {
  const cost = (objectiveStatus(state, seat, id).cost ?? {}) as Cost;
  return !!(cost.resources || cost.influence || cost.tradeGoods);
};

/**
 * Public objectives the seat can still score this round: one in the status
 * phase, and one more with Imperial's primary if it holds Imperial unplayed.
 */
const slots = (state: GameState, seat: PlayerId) =>
  1 + (state.players[seat].strategyCards.some((c) => strategyKind(c.id) === "imperial" && !c.exhausted) ? 1 : 0);

/** What the seat has ready towards a cost, by currency. */
function readyFor(state: GameState, seat: PlayerId, cost: Cost) {
  const ready = Object.values(state.planets).filter((p) => p.controller === seat && !p.exhausted);
  const tradeGoods = state.players[seat].tradeGoods;
  const parts: string[] = [];
  if (cost.resources) {
    parts.push(`${ready.reduce((n, p) => n + planetResources(state, p.name), 0) + tradeGoods} resources`);
  }
  if (cost.influence) {
    parts.push(`${ready.reduce((n, p) => n + planetInfluence(state, p.name), 0) + tradeGoods} influence`);
  }
  if (cost.tradeGoods) parts.push(`${tradeGoods} trade goods`);
  return parts.join(" and ");
}

/**
 * A move that spends what a public objective needs at this round's status
 * phase, when the seat could pay for it now: spend objectives are paid from
 * planets still ready then, plus trade goods. Since a player scores one
 * public objective per status phase, a move is not flagged while it leaves
 * as many scorable as the seat can score, or makes another scorable in
 * place of the one it costs.
 */
function objectiveBudget(state: GameState, seat: PlayerId, action: GameAction) {
  if (state.phase !== "strategy" && state.phase !== "action") return undefined;
  const before = scorable(state, seat);
  if (before.length === 0) return undefined;
  const result = applyAction(state, seat, action);
  if (!result.ok) return undefined;
  const after = scorable(result.state, seat);
  const lost = before.filter(
    (id) =>
      !after.includes(id) &&
      paidInGoods(state, seat, id) &&
      !result.state.publicObjectives.find((o) => o.id === id)?.scoredBy.includes(seat),
  );
  if (lost.length === 0 || after.some((id) => !before.includes(id))) return undefined;
  if (after.length >= Math.min(before.length, slots(state, seat))) return undefined;
  const reasons = lost.map((id) => {
    const cost = (objectiveStatus(state, seat, id).cost ?? {}) as Cost;
    const needs = Object.entries(cost).map(([k, v]) => `${v} ${k === "tradeGoods" ? "trade goods" : k}`).join(", ");
    return `${objectiveName(id)} (needs ${needs}; you would have ${readyFor(result.state, seat, cost)} ready, down from ${readyFor(state, seat, cost)})`;
  });
  const left = after.length ? ` You could still score ${after.map(objectiveName).join(" or ")}.` : "";
  return `Your move leaves you unable to pay for ${reasons.join(" and ")} in this round's status phase: ` +
    `objectives are paid before planets ready again, and other players scoring one does not stop you.${left}`;
}

/** Other players whose ships that could carry ground forces reach `key` in one move. */
function invaders(state: GameState, seat: PlayerId, key: SystemKey) {
  return state.seating.flatMap((other) => {
    if (other === seat || state.players[other].eliminated) return [];
    const ships = Object.entries(shipsReaching(state, other, key)).filter(
      ([type, n]) => n && (unitOf(state, other, type as UnitType)?.capacity ?? 0) > 0,
    );
    return ships.length ? [`P${other} (${ships.map(([t, n]) => `${n} ${t}`).join(", ")})`] : [];
  });
}

/**
 * A tactical action that lifts the last ground forces off a planet of the
 * seat's while another player's ships that could carry ground forces can
 * reach that planet's system: anyone who lands there takes it.
 */
function emptyPlanetThreat(state: GameState, seat: PlayerId, action: GameAction) {
  if (action.type !== "ACTIVATE_SYSTEM") return undefined;
  return emptiedPlanetWarning(state, seat, bestPlan(state, seat, action.system)?.cargo ?? []);
}

/**
 * The warning for lifting `cargo`, when it empties a planet another
 * player could invade. Apart from the check so a test can set the cargo:
 * the bot's own plans already keep a garrison where it sees enemy ships.
 */
export function emptiedPlanetWarning(state: GameState, seat: PlayerId, cargo: CargoPickup[]) {
  const lifted = new Map<string, number>();
  for (const pickup of cargo) {
    if (pickup.planet === undefined) continue;
    const ground = Object.entries(pickup.units)
      .filter(([type]) => isGroundForce(type as UnitType))
      .reduce((n, [, count]) => n + (count ?? 0), 0);
    lifted.set(pickup.planet, (lifted.get(pickup.planet) ?? 0) + ground);
  }
  const warnings: string[] = [];
  for (const [planet, count] of lifted) {
    const left = totalUnits(state.planets[planet].units[seat], isGroundForce) - count;
    if (count === 0 || left > 0 || state.planets[planet].controller !== seat) continue;
    const key = state.planets[planet].system;
    const threats = invaders(state, seat, key);
    if (threats.length) {
      warnings.push(`${planet} with no ground forces, while ${threats.join(" and ")} can reach ${systemRef(state, key)}`);
    }
  }
  return warnings.length
    ? `Your move leaves ${warnings.join("; and ")}: anyone who lands there takes the planet.`
    : undefined;
}

/**
 * A strategy pick that leaves Imperial to the player holding Mecatol Rex,
 * who has yet to pick: its primary gives them a point on top of an
 * objective.
 */
function imperialToMecatolHolder(state: GameState, seat: PlayerId, action: GameAction) {
  if (state.phase !== "strategy" || action.type !== "PICK_STRATEGY_CARD") return undefined;
  if (strategyKind(action.card) === "imperial") return undefined;
  const imperial = state.strategyCards.find((c) => strategyKind(c) === "imperial");
  const holder = state.planets[MECATOL_REX]?.controller;
  if (!imperial || holder === undefined || holder === seat) return undefined;
  // With four or fewer players, each picks two cards.
  const picks = state.seating.length <= 4 ? 2 : 1;
  if (state.players[holder].strategyCards.length >= picks) return undefined;
  if (!applyAction(state, seat, { type: "PICK_STRATEGY_CARD", card: imperial }).ok) return undefined;
  return `${playerLabel(state, holder)} holds Mecatol Rex and has yet to pick: leaving Imperial lets them take it, ` +
    `scoring an objective and a point for Mecatol Rex with its primary. You could take Imperial yourself to deny it.`;
}

/** An activation that moves and builds nothing, early on, when tokens build the empire. */
function earlyStall(state: GameState, seat: PlayerId, action: GameAction) {
  if (action.type !== "ACTIVATE_SYSTEM" || state.round > EARLY_ROUNDS) return undefined;
  if (!isStall(state, seat, action.system)) return undefined;
  return `Your move is a stall: it moves nothing and builds nothing, and spends a tactic token. ` +
    `In round ${state.round} a token is worth more to expansion or production; passing later, or acting now, usually serves better.`;
}

/** Moves long enough to find any way around a rift, over several turns. */
const LONG_WAY = 8;

/**
 * Ground forces carried through a gravity rift, where each ship is lost on
 * a roll of 1-3 with what it carries, when a route around it exists (if
 * one that takes another turn).
 */
function gravityRiftCargo(state: GameState, seat: PlayerId, action: GameAction) {
  if (action.type !== "ACTIVATE_SYSTEM") return undefined;
  const plan = bestPlan(state, seat, action.system);
  if (!plan) return undefined;
  const warnings: string[] = [];
  for (const move of plan.moves) {
    const carriers = Object.keys(move.ships).filter(
      (t) => (unitOf(state, seat, t as UnitType)?.capacity ?? 0) > 0,
    );
    const cargo = plan.cargo
      .filter((c) => c.system === move.from)
      .reduce(
        (n, c) =>
          n +
          Object.entries(c.units)
            .filter(([type]) => isGroundForce(type as UnitType))
            .reduce((sum, [, count]) => sum + (count ?? 0), 0),
        0,
      );
    if (carriers.length === 0 || cargo === 0) continue;
    const speeds = Object.keys(move.ships).map((t) => unitOf(state, seat, t as UnitType)?.move ?? 0);
    const reach = Math.min(...speeds) + moveBonus(state, seat, move.from) + (move.gravityDrive ? 1 : 0);
    const rules = moveRulesFor(state, seat, action.system);
    const route = move.path
      ? { path: move.path, rifts: riftsExited(state, move.path) }
      : findRoute(state, move.from, reach, rules);
    if (!route || route.rifts === 0) continue;
    const around = findRoute(state, move.from, LONG_WAY, rules);
    if (!around || around.rifts > 0) continue;
    const via = route.path
      .slice(0, -1)
      .filter((k) => hasAnomaly(state.systems[k], "GRAVITY_RIFT"))
      .map((k) => systemRef(state, k));
    const loss = Math.round((1 - 0.7 ** route.rifts) * 100);
    warnings.push(
      `${plural(cargo, "ground force")} from ${systemRef(state, move.from)} through the gravity rift at ${via.join(" and ")} ` +
        `(each ship has a ${loss}% chance to be lost, with its cargo), when a route around it ` +
        `${around.path.length - 1 <= reach ? "exists" : `takes ${around.path.length - 1} moves`}`,
    );
  }
  return warnings.length ? `Your move carries ${warnings.join("; and ")}.` : undefined;
}

export const CHECKS: Check[] = [
  {
    id: "stranded-ground-forces",
    description: "A build leaves new ground forces without ship space to carry them, or builds a carrier with nothing to carry.",
    run: strandedGroundForces,
  },
  {
    id: "objective-budget",
    description: "A move spends what a public objective the seat could score this round needs at the status phase.",
    run: objectiveBudget,
  },
  {
    id: "empty-planet-threat",
    description: "A tactical action leaves a planet with no ground forces while another player's ships can reach it.",
    run: emptyPlanetThreat,
  },
  {
    id: "imperial-to-mecatol-holder",
    description: "A strategy pick leaves Imperial to the Mecatol Rex holder when the seat could take it.",
    run: imperialToMecatolHolder,
  },
  {
    id: "early-stall",
    description: "A do-nothing activation in rounds 1-3.",
    run: earlyStall,
  },
  {
    id: "gravity-rift-cargo",
    description: "Ground forces carried through a gravity rift when a route around it exists.",
    run: gravityRiftCargo,
  },
];

export const checksById = Object.fromEntries(CHECKS.map((c) => [c.id, c])) as Record<CheckId, Check>;

/** The warnings a move trips, from every check or the ones named. */
export function runChecks(
  state: GameState,
  seat: PlayerId,
  action: GameAction,
  ids: CheckId[] = CHECKS.map((c) => c.id),
): Finding[] {
  return ids.flatMap((id) => {
    const warning = checksById[id].run(state, seat, action);
    return warning ? [{ check: id, warning }] : [];
  });
}
