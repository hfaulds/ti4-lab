/**
 * Relics and relic fragments (Prophecy of Kings): gaining and losing relics,
 * with the victory points and limits some of them bring.
 */
import { PlayerId } from "~/types";
import { ExplorationDeck, explorationsById, relicsById } from "../data";
import { CommandPools, GameState } from "../types";
import { checkVictory, victoryPoints } from "./control";
import { gainBreakthrough } from "./thundersEdge";
import { unitIs } from "./units";
import {
  addUnits,
  unitsAvailable,
  draw,
  drawSecretObjective,
  ensure,
  log,
  playerName,
  playerOf,
  plural,
  tokensInReinforcements,
} from "./helpers";

export const relicName = (id: string) => relicsById[id]?.name ?? id;

export const ownsRelic = (state: GameState, id: PlayerId, relic: string) =>
  !!state.players[id]?.relics.includes(relic);

export const readyRelic = (state: GameState, id: PlayerId, relic: string) =>
  ownsRelic(state, id, relic) && !state.players[id].exhaustedRelics.includes(relic);

export function exhaustRelic(state: GameState, id: PlayerId, relic: string) {
  ensure(readyRelic(state, id, relic), `${relicName(relic)} is exhausted.`);
  state.players[id].exhaustedRelics.push(relic);
}

/**
 * Gives a player a relic, drawing the top of the relic deck when none is
 * named. Returns the relic gained, if any.
 */
export function gainRelic(state: GameState, id: PlayerId, relic?: string) {
  const player = playerOf(state, id);
  const card = relic ?? draw(state, state.decks.relics);
  if (!card) {
    log(state, "The relic deck is empty.");
    return undefined;
  }
  state.decks.relics.draw = state.decks.relics.draw.filter((r) => r !== card);
  player.relics.push(card);
  log(state, `${player.name} gained ${relicName(card)}.`, { player: id });
  if (card === "shard") {
    player.bonusVictoryPoints += 1;
    log(state, `${player.name} gained 1 victory point (${victoryPoints(state, id)} VP).`, {
      player: id,
    });
    checkVictory(state);
  }
  if (card === "obsidian") drawSecretObjective(state, id);
  if (card === "dynamiscore") player.commodityLimit += 2;
  if (card === "quantumcore") gainBreakthrough(state, id);
  for (const other of state.seating) {
    if (other === id || !unitIs(state, other, "mech", "naalu_mech_te")) continue;
    const home = state.systems[state.players[other].home].planets.find(
      (p) => state.planets[p].controller === other,
    );
    if (home && unitsAvailable(state, other, "mech") > 0) {
      addUnits(state.planets[home].units, other, "mech", 1);
      log(state, `${playerName(state, other)} deployed an Iconoclast.`, { player: other });
    }
  }
  return card;
}

/** Removes a relic from a player, purged or passed on. */
export function loseRelic(state: GameState, id: PlayerId, relic: string) {
  const player = playerOf(state, id);
  const index = player.relics.indexOf(relic);
  if (index < 0) return;
  player.relics.splice(index, 1);
  player.exhaustedRelics = player.exhaustedRelics.filter((r) => r !== relic);
  if (relic === "shard") player.bonusVictoryPoints -= 1;
  if (relic === "dynamiscore") {
    player.commodityLimit -= 2;
    player.commodities = Math.min(player.commodities, player.commodityLimit);
  }
}

export function purgeRelic(state: GameState, id: PlayerId, relic: string) {
  loseRelic(state, id, relic);
  log(state, `${playerName(state, id)} purged ${relicName(relic)}.`, { player: id });
}

/** Moves a relic from one player to another (Shard of the Throne). */
export function transferRelic(state: GameState, from: PlayerId, to: PlayerId, relic: string) {
  if (!ownsRelic(state, from, relic)) return;
  loseRelic(state, from, relic);
  gainRelic(state, to, relic);
}

// --- Relic fragments -------------------------------------------------------------

/** The type of a relic fragment; "frontier" fragments count as any type. */
export const fragmentType = (fragment: string): ExplorationDeck =>
  explorationsById[fragment]?.deck ?? "frontier";

/**
 * Checks a set of fragments a player wants to purge: all theirs, and all of
 * one type (unknown fragments fill in for any type).
 */
export function checkFragments(
  state: GameState,
  id: PlayerId,
  fragments: string[] | undefined,
  count: number,
  options: { sameType?: boolean } = { sameType: true },
) {
  const chosen = fragments ?? [];
  ensure(chosen.length === count, `Choose ${plural(count, "relic fragment")}.`);
  ensure(new Set(chosen).size === chosen.length, "Choose different relic fragments.");
  const held = state.players[id].relicFragments;
  for (const fragment of chosen) {
    ensure(held.includes(fragment), "You do not hold that relic fragment.");
  }
  if (options.sameType) {
    const types = new Set(chosen.map(fragmentType).filter((t) => t !== "frontier"));
    ensure(types.size <= 1, "Choose relic fragments of the same type.");
  }
  return chosen;
}

export function purgeFragments(state: GameState, id: PlayerId, fragments: string[]) {
  const player = playerOf(state, id);
  player.relicFragments = player.relicFragments.filter((f) => !fragments.includes(f));
  log(state, `${player.name} purged ${plural(fragments.length, "relic fragment")}.`, {
    player: id,
  });
}

/**
 * Picks fragments a player could purge together: `count` of one type, using
 * unknown fragments to make up the numbers. Returns undefined if there are none.
 */
export function fragmentSet(
  state: GameState,
  id: PlayerId,
  count: number,
): string[] | undefined {
  const held = state.players[id].relicFragments;
  const unknown = held.filter((f) => fragmentType(f) === "frontier");
  for (const type of ["cultural", "hazardous", "industrial"] as ExplorationDeck[]) {
    const ofType = held.filter((f) => fragmentType(f) === type);
    if (ofType.length + unknown.length >= count) {
      return [...ofType, ...unknown].slice(0, count);
    }
  }
  return unknown.length >= count ? unknown.slice(0, count) : undefined;
}

// --- Command tokens and commodities ------------------------------------------------

/** Gains command tokens from reinforcements into a pool (tactic by default). */
export function gainCommandTokens(
  state: GameState,
  id: PlayerId,
  count: number,
  pool: keyof CommandPools = "tactic",
) {
  const gained = Math.max(0, Math.min(count, tokensInReinforcements(state, id)));
  if (gained <= 0) return 0;
  state.players[id].pools[pool] += gained;
  log(state, `${playerName(state, id)} gained ${plural(gained, "command token")}.`, {
    player: id,
  });
  return gained;
}

export const POOLS: (keyof CommandPools)[] = ["tactic", "fleet", "strategy"];

/** The pool named in a choice, or the tactic pool. */
export const poolChoice = (choice: string | undefined): keyof CommandPools =>
  POOLS.includes(choice as keyof CommandPools) ? (choice as keyof CommandPools) : "tactic";

export function gainCommodities(state: GameState, id: PlayerId, count: number) {
  const player = playerOf(state, id);
  const gained = Math.max(0, Math.min(count, player.commodityLimit - player.commodities));
  player.commodities += gained;
  if (gained > 0) {
    log(state, `${player.name} gained ${plural(gained, "commodity")}.`, { player: id });
  }
  return gained;
}

/** Converts commodities to trade goods; all of them when no count is given. */
export function convertCommodities(state: GameState, id: PlayerId, count?: number) {
  const player = playerOf(state, id);
  const converted = Math.min(count ?? player.commodities, player.commodities);
  if (converted <= 0) return 0;
  player.commodities -= converted;
  player.tradeGoods += converted;
  log(
    state,
    `${player.name} converted ${plural(converted, "commodity")} to trade goods.`,
    { player: id },
  );
  return converted;
}
