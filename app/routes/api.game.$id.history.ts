import { data, LoaderFunctionArgs } from "react-router";
import { gameByUrlName } from "~/drizzle/game.server";
import { historyOf } from "~/game/history.server";

/**
 * Every point of the game so far, or only those after `after`, for stepping
 * back through it. Empty for a game saved before moves were recorded.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const game = await gameByUrlName(params.id!);
  if (!game) throw new Response("Game not found", { status: 404 });
  const query = new URL(request.url).searchParams;
  const asked = query.get("player");
  const after = Number(query.get("after") ?? -1);
  const viewer =
    asked !== null && asked !== "" && game.state.players[Number(asked)]
      ? Number(asked)
      : undefined;
  const history = historyOf(game.id, game.state.version);
  return data({
    steps: (
      history?.timeline(viewer, game.state.phase === "finished") ?? []
    ).filter((step) => step.version > after),
  });
}
