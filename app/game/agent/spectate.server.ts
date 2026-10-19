/**
 * Plays a headless game through the web app so it can be watched live. The
 * game is saved to the app's database, then every move is sent through the
 * same endpoint human players use, which saves it, with the agent's reasoning
 * for its own moves, and tells open browsers. The app's copy is the one that
 * counts: the game only moves on once the app has accepted each move.
 */
import { createSavedGame } from "~/drizzle/game.server";
import { GameState } from "../types";
import { mirrorMoves, Move } from "./mirror";

export type Spectating = {
  url: string;
  /** Plays a move through the app, waiting while the app is unavailable. */
  onMove: (move: Move, state: GameState) => Promise<void>;
};

export async function startSpectating(
  state: GameState,
  options: { server: string; paceMs: number },
): Promise<Spectating> {
  const server = options.server.replace(/\/$/, "");
  // Only agents and bots play these games.
  const { urlName } = await createSavedGame(state, undefined, undefined, {
    botOnly: true,
  });
  const endpoint = `${server}/api/game/${urlName}`;
  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `The web app at ${server} cannot load the saved game (${error instanceof Error ? error.message : error}). ` +
        "Start it with `yarn dev`, using the same TI4_LAB_DATABASE_PATH.",
    );
  }
  return {
    url: `${server}/game/${urlName}`,
    onMove: mirrorMoves({ endpoint, paceMs: options.paceMs }),
  };
}
