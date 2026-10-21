/**
 * Who a player could trade with this round: neighbors now, and players
 * one ship move away from becoming neighbors, by either side.
 */
import { PlayerId } from "~/types";
import { GameState, SystemKey } from "../types";
import {
  adjacentSystems,
  findRoute,
  moveRulesFor,
  neighborsOf,
  presence,
} from "../engine/board";
import { hasTech, unitOf, unitTypes } from "../engine/helpers";
import { moveBonus } from "../engine/tactical";

/**
 * A system `mover` could move a ship to in one move that would make them
 * neighbors of `other`: empty, and in or next to one of `other`'s systems.
 */
export function neighborlyMove(state: GameState, mover: PlayerId, other: PlayerId) {
  const ships = Object.values(state.systems)
    .filter((system) => !system.commandTokens.includes(mover))
    .flatMap((origin) =>
      unitTypes(origin.space[mover]).flatMap((type) => {
        const move = unitOf(state, mover, type)?.move;
        if (!move) return [];
        const bonus = moveBonus(state, mover, origin.key) + (hasTech(state, mover, "gd") ? 1 : 0);
        return [{ from: origin.key, move: move + bonus }];
      }),
    );
  // Systems with anyone else in them would mean a fight, not a neighbor.
  const occupied = new Set(
    state.seating.filter((id) => id !== mover).flatMap((id) => presence(state, id)),
  );
  const theirs = presence(state, other);
  return [...new Set(theirs.flatMap((k) => adjacentSystems(state, k)))]
    .filter((k) => !occupied.has(k))
    .find((target) =>
      ships.some(
        ({ from, move }) =>
          from === target || !!findRoute(state, from, move, moveRulesFor(state, mover, target)),
      ),
    );
}

/**
 * The ships `mover` could bring into `target` with one tactical action,
 * from systems without its command token, by type.
 */
export function shipsReaching(state: GameState, mover: PlayerId, target: SystemKey) {
  const rules = moveRulesFor(state, mover, target);
  const ships: Partial<Record<string, number>> = {};
  for (const origin of Object.values(state.systems)) {
    if (origin.key === target || origin.commandTokens.includes(mover)) continue;
    for (const type of unitTypes(origin.space[mover])) {
      const move = unitOf(state, mover, type)?.move;
      if (!move || type === "fighter") continue;
      const reach = move + moveBonus(state, mover, origin.key) + (hasTech(state, mover, "gd") ? 1 : 0);
      if (!findRoute(state, origin.key, reach, rules)) continue;
      ships[type] = (ships[type] ?? 0) + (origin.space[mover]![type]?.count ?? 0);
    }
  }
  return ships;
}

/** Neighbors, then players either side could neighbor with one move. */
export function tradePartners(state: GameState, id: PlayerId): PlayerId[] {
  const neighbors = neighborsOf(state, id);
  const near = state.seating.filter(
    (other) =>
      other !== id &&
      !neighbors.includes(other) &&
      !state.players[other].eliminated &&
      (neighborlyMove(state, id, other) !== undefined ||
        neighborlyMove(state, other, id) !== undefined),
  );
  return [...neighbors, ...near];
}
