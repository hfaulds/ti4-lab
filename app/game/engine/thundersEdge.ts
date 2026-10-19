/**
 * Thunder's Edge: breakthroughs, synergy and expeditions.
 */
import { PlayerId } from "~/types";
import { breakthroughsById, TechColor } from "../data";
import { GameState } from "../types";
import { ensure, log, playerName, rollDie } from "./helpers";

const ALL_COLORS: TechColor[] = ["BIOTIC", "CYBERNETIC", "PROPULSION", "WARFARE"];

/** Slices of the expedition token; the 6th places Thunder's Edge. */
export const EXPEDITION_SLICES = 6;

export const hasBreakthrough = (state: GameState, id: PlayerId) =>
  !!state.players[id]?.breakthrough?.unlocked;

/** The player's breakthrough, if they have gained it and it is ready. */
export const readyBreakthrough = (state: GameState, id: PlayerId, breakthrough: string) => {
  const own = state.players[id]?.breakthrough;
  return !!own?.unlocked && own.id === breakthrough && !own.exhausted;
};

export function exhaustBreakthrough(state: GameState, id: PlayerId, breakthrough: string) {
  ensure(readyBreakthrough(state, id, breakthrough), "Your breakthrough is exhausted.");
  state.players[id].breakthrough!.exhausted = true;
}

/**
 * Gives a player their breakthrough and makes the breakthrough roll; on a 1
 * or a 10 The Fracture would enter play.
 */
export function gainBreakthrough(state: GameState, id: PlayerId) {
  const own = state.players[id]?.breakthrough;
  if (!own || own.unlocked) return;
  own.unlocked = true;
  const name = breakthroughsById[own.id]?.name ?? own.id;
  const roll = rollDie(state);
  log(state, `${playerName(state, id)} gained their breakthrough, ${name} (breakthrough roll ${roll}).`, {
    player: id,
  });
  if ((roll === 1 || roll === 10) && !state.fracture) {
    state.fracture = true;
    log(state, "The Fracture enters play.");
  }
}

/**
 * Technology colors that can stand in for one another for a player: those
 * of their breakthrough's synergy, or every color with The Quantumcore.
 */
export function synergyColors(state: GameState, id: PlayerId): TechColor[] {
  const player = state.players[id];
  if (!player) return [];
  if (player.relics.includes("quantumcore")) return ALL_COLORS;
  if (!player.breakthrough?.unlocked) return [];
  return breakthroughsById[player.breakthrough.id]?.synergy ?? [];
}

/**
 * Uses synergy to cover missing prerequisites with spare technologies of the
 * other color in the pair. `owned` holds the technologies not yet used.
 */
export function applySynergy(
  state: GameState,
  id: PlayerId,
  owned: Partial<Record<TechColor, number>>,
  missing: TechColor[],
) {
  const flexible = synergyColors(state, id);
  for (const color of [...missing]) {
    if (!flexible.includes(color)) continue;
    const spare = flexible.find((other) => other !== color && (owned[other] ?? 0) > 0);
    if (!spare) continue;
    owned[spare]!--;
    missing.splice(missing.indexOf(color), 1);
  }
}
