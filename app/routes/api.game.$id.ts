import { ActionFunctionArgs, data, LoaderFunctionArgs } from "react-router";
import { gameByUrlName, saveGame } from "~/drizzle/game.server";
import { GameAction } from "~/game/actions";
import { applyAction } from "~/game/engine";
import { viewFor } from "~/game/view";
import { broadcastGameUpdate } from "~/websocket/broadcast.server";

const SAVE_ATTEMPTS = 3;

function parsePlayer(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const player = Number(value);
  return Number.isInteger(player) ? player : undefined;
}

/** The game as seen from one seat, or by a spectator. */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const game = await gameByUrlName(params.id!);
  if (!game) throw new Response("Game not found", { status: 404 });
  const viewer = parsePlayer(new URL(request.url).searchParams.get("player"));
  return data({
    view: viewFor(
      game.state,
      viewer !== undefined && game.state.players[viewer] ? viewer : undefined,
    ),
  });
}

/** Applies one player's action to the game. */
export async function action({ request, params }: ActionFunctionArgs) {
  const body = (await request.json()) as {
    player?: number;
    action?: GameAction;
  };
  const player = parsePlayer(body.player);
  if (player === undefined || !body.action?.type) {
    return data(
      { success: false, error: "A player and an action are required." },
      { status: 400 },
    );
  }

  // Two players acting at once both read the same version; the loser of the
  // write retries against the newer state.
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const game = await gameByUrlName(params.id!);
    if (!game) {
      return data({ success: false, error: "Game not found." }, { status: 404 });
    }
    if (!game.state.players[player]) {
      return data(
        { success: false, error: "That player is not in this game." },
        { status: 400 },
      );
    }

    let result;
    try {
      result = applyAction(game.state, player, body.action);
    } catch (error) {
      // Anything other than a rules violation means the request was malformed.
      console.error("Game action failed", body.action.type, error);
      return data(
        { success: false, error: "That action could not be understood." },
        { status: 400 },
      );
    }
    if (!result.ok) {
      return data({ success: false, error: result.error }, { status: 422 });
    }
    if (saveGame(game.id, result.state, game.state.version)) {
      broadcastGameUpdate(game.id, result.state.version);
      return data({ success: true, view: viewFor(result.state, player) });
    }
  }
  return data(
    { success: false, error: "The game is busy. Please try again." },
    { status: 409 },
  );
}
