/**
 * Mirrors a headless game into the web app so it can be watched live. The
 * game is saved to the app's database, then every move is sent through the
 * same endpoint human players use, which saves it, with the agent's reasoning
 * for its own moves, and tells open browsers.
 */
import { PlayerId } from "~/types";
import { createSavedGame } from "~/drizzle/game.server";
import { GameAction } from "../actions";
import { MoveNote } from "../history";
import { GameState } from "../types";

export type Spectating = {
  url: string;
  /** Sends a move to the server; stops mirroring if the copies disagree. */
  onMove: (
    move: { player: PlayerId; action: GameAction; note?: MoveNote },
    state: GameState,
  ) => Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  let mirroring = true;
  return {
    url: `${server}/game/${urlName}`,
    async onMove({ player, action, note }, next) {
      if (!mirroring) return;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player, action, note }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        view?: { version: number };
      };
      // The engine is deterministic, so the server's copy should match.
      if (!body.success || body.view?.version !== next.version) {
        mirroring = false;
        console.warn(
          `Stopped mirroring to the web app: ${body.error ?? `server is at version ${body.view?.version}, local at ${next.version}`}. ` +
            "The game carries on locally.",
        );
        return;
      }
      if (options.paceMs > 0) await sleep(options.paceMs);
    },
  };
}
