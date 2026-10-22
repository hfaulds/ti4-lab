import { ActionFunctionArgs, data, LoaderFunctionArgs } from "react-router";
import { gameByUrlName, saveGame } from "~/drizzle/game.server";
import { GameAction } from "~/game/actions";
import { applyAction } from "~/game/engine";
import { MoveNote } from "~/game/history";
import { historyOf } from "~/game/history.server";
import { viewFor } from "~/game/view";
import { broadcastGameUpdate } from "~/websocket/broadcast.server";

const SAVE_ATTEMPTS = 3;

function parseInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const player = Number(value);
  return Number.isInteger(player) ? player : undefined;
}

/** Longest note kept with a move, in characters. */
const MAX_NOTE_LENGTH = 20000;

/** A note saying why the move was chosen, if the request has a sound one. */
function parseNote(value: unknown): MoveNote | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const note = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string";
  if (
    !text(note.chosen) ||
    !text(note.rationale) ||
    (note.plan !== undefined && !text(note.plan)) ||
    (note.fallback !== undefined && !text(note.fallback)) ||
    !Array.isArray(note.options) ||
    !note.options.every(text) ||
    (note.talk !== undefined &&
      (!Array.isArray(note.talk) || !note.talk.every(text))) ||
    JSON.stringify(note).length > MAX_NOTE_LENGTH
  ) {
    return undefined;
  }
  return {
    chosen: note.chosen as string,
    rationale: note.rationale as string,
    plan: note.plan as string | undefined,
    options: note.options as string[],
    fallback: note.fallback as string | undefined,
    talk: note.talk as string[] | undefined,
  };
}

/**
 * The game as seen from one seat, or by a spectator. With `version`, the
 * game as it stood at that earlier point; once the game is over, every hand
 * is shown.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const game = await gameByUrlName(params.id!);
  if (!game) throw new Response("Game not found", { status: 404 });
  const query = new URL(request.url).searchParams;
  const asked = parseInteger(query.get("player"));
  const viewer =
    asked !== undefined && game.state.players[asked] ? asked : undefined;
  const version = parseInteger(query.get("version"));
  if (version === undefined || version === game.state.version) {
    return data({ view: viewFor(game.state, viewer) });
  }

  const state = historyOf(game.id, version)?.stateAt(version);
  if (!state) {
    throw new Response("That point of the game is not recorded", {
      status: 404,
    });
  }
  return data({
    view: viewFor(state, viewer, game.state.phase === "finished"),
  });
}

/**
 * Applies one player's action to the game, keeping the player's note on why
 * they chose it, if they sent one.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  const body = (await request.json()) as {
    player?: number;
    action?: GameAction;
    note?: unknown;
  };
  const player = parseInteger(body.player);
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
      return data(
        { success: false, error: "Game not found." },
        { status: 404 },
      );
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
    if (
      saveGame(game.id, result.state, game.state.version, {
        player,
        action: body.action,
        note: parseNote(body.note),
      })
    ) {
      broadcastGameUpdate(game.id, result.state.version);
      return data({ success: true, view: viewFor(result.state, player) });
    }
  }
  return data(
    { success: false, error: "The game is busy. Please try again." },
    { status: 409 },
  );
}
