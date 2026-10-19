/**
 * Faction units whose printed abilities change the general rules: Titans
 * PDS that are also ground forces, mechs that lose their abilities under
 * Articles of War, and the like.
 */
import { PlayerId } from "~/types";
import { isGroundForce } from "../data";
import { GameState, UnitGroup, UnitType } from "../types";
import { countOf, totalUnits, unitOf } from "./helpers";

/** Articles of War strips mechs of their printed abilities. */
export const mechAbilitiesActive = (state: GameState) =>
  !state.laws.some((law) => law.id === "articles_war" && law.outcome !== "Against");

/**
 * Whether a player's unit of a type is the named faction unit, with its
 * ability in force.
 */
export function unitIs(
  state: GameState,
  id: PlayerId,
  type: UnitType,
  ...unitIds: string[]
) {
  const unit = unitOf(state, id, type);
  if (!unit || !unitIds.includes(unit.id)) return false;
  return type !== "mech" || mechAbilitiesActive(state);
}

/** Titans PDS (Hel-Titans) are ground forces as well as structures. */
export const isGroundForceFor = (state: GameState, id: PlayerId, type: UnitType) =>
  isGroundForce(type) || (type === "pds" && state.players[id]?.faction === "titans");

export const groundForcesIn = (state: GameState, id: PlayerId, group: UnitGroup | undefined) =>
  totalUnits(group, (type) => isGroundForceFor(state, id, type));

export const hasGroundForcesFor = (state: GameState, id: PlayerId, group: UnitGroup | undefined) =>
  groundForcesIn(state, id, group) > 0;

/** Whether a group holds a faction unit (with its ability in force). */
export const holdsUnit = (
  state: GameState,
  id: PlayerId,
  group: UnitGroup | undefined,
  type: UnitType,
  ...unitIds: string[]
) => countOf(group, type) > 0 && unitIs(state, id, type, ...unitIds);
