/**
 * What a build leaves a system able to move: its ground forces, and how
 * many of them the seat's ships there could carry. Shared by the menu text
 * and the checks, so both say the same thing.
 */
import { PlayerId } from "~/types";
import { isGroundForce } from "../data";
import { GameState, SystemKey, UnitType } from "../types";
import { capacityIn, dockFighterAllowance } from "../engine/board";
import { countOf, totalUnits, unitOf } from "../engine/helpers";

export type Lift = {
  /** Ground forces in the system afterwards, in space and on its planets. */
  ground: number;
  /** Ground forces built by the order. */
  built: number;
  /** Ground forces already aboard ships there, which use some of the room. */
  aboard: number;
  /** Capacity left for ground forces once fighters past the docks' allowance are aboard. */
  room: number;
};

/** Ground forces in `key` after building `units`, and room for them aboard. */
export function liftAfter(
  state: GameState,
  seat: PlayerId,
  key: SystemKey,
  units: { type: string; count: number }[],
): Lift {
  const system = state.systems[key];
  const builtOf = (type: string) => units.filter((u) => u.type === type).reduce((n, u) => n + u.count, 0);
  const built = builtOf("infantry") + builtOf("mech");
  const aboard = totalUnits(system.space[seat], isGroundForce);
  const ground =
    aboard +
    system.planets.reduce((n, p) => n + totalUnits(state.planets[p].units[seat], isGroundForce), 0) +
    built;
  const capacity =
    capacityIn(state, key, seat) +
    units.reduce((n, u) => n + (unitOf(state, seat, u.type as UnitType)?.capacity ?? 0) * u.count, 0);
  const fighters = countOf(system.space[seat], "fighter") + builtOf("fighter");
  const room = Math.max(0, capacity - Math.max(0, fighters - dockFighterAllowance(state, key, seat)));
  return { ground, built, aboard, room };
}
