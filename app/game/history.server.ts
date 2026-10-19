/**
 * Keeps the replayed history of recently viewed games in memory, so stepping
 * through a game does not replay it from the start for every step. States
 * from consecutive moves share most of their structure, so a long game is
 * far smaller than its move count suggests.
 */
import { gameMovesSince, initialGameState } from "~/drizzle/game.server";
import { GameHistory } from "./history";

const CACHED_GAMES = 4;
const cache = new Map<string, GameHistory>();

/**
 * The game's history up to `version`, or undefined for a game saved before
 * moves were recorded.
 */
export function historyOf(gameId: string, version: number) {
  let history = cache.get(gameId);
  if (!history) {
    const initial = initialGameState(gameId);
    if (!initial) return undefined;
    history = new GameHistory(initial);
  }
  if (history.latest.version < version) {
    history.extend(gameMovesSince(gameId, history.latest.version));
  }
  // Most recently used last, so the oldest is first to go.
  cache.delete(gameId);
  cache.set(gameId, history);
  if (cache.size > CACHED_GAMES) cache.delete(cache.keys().next().value!);
  return history;
}
