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
import { draftConfig } from "~/draft/draftConfig";

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

/**
 * A seat's slice on the six-player Milty map: the systems on either side of
 * its home and the two in front, which it is expected to own, and the
 * equidistant it shares with a neighbour. Placement offsets follow Milty's
 * slice order: left, front, right, equidistant, far front.
 */
export function sliceOf(state: GameState, seat: PlayerId) {
  // Player ids are seat numbers on the map, so the home tile is the seat's
  // home position (for the Ghosts, the Creuss Gate).
  const config = draftConfig.milty;
  const home = state.map.find((t) => t.idx === config.homeIdxInMapString[seat]);
  if (!home) return { own: [], equidistant: [] };
  const offsets = config.seatTilePlacement[seat] ?? [];
  const at = ([x, y]: [number, number]) =>
    state.map.find((t) => t.position.x === home.position.x + x && t.position.y === home.position.y + y);
  const keys = offsets.map((offset) => at(offset)?.idx).map((idx) =>
    idx !== undefined && state.systems[idx] ? idx : undefined,
  );
  const present = (k: SystemKey | undefined): k is SystemKey => k !== undefined;
  return { own: [keys[0], keys[1], keys[2], keys[4]].filter(present), equidistant: [keys[3]].filter(present) };
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
