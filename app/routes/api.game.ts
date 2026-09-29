import { ActionFunctionArgs, data } from "react-router";
import { draftById, draftByPrettyUrl } from "~/drizzle/draft.server";
import { createSavedGame } from "~/drizzle/game.server";
import { EXPANSIONS } from "~/game/data";
import { createGame, settle } from "~/game/engine";
import { gameSetupFromDraft, StartGameOptions } from "~/game/fromDraft";
import { Expansion, GameError } from "~/game/types";
import { Draft, FactionId } from "~/types";

type Body = {
  draft?: string;
  expansions?: string[];
  victoryPoints?: number;
  keleresVariant?: string;
};

const VICTORY_POINT_TRACKS = [10, 14];
const KELERES_VARIANTS: FactionId[] = ["mentak", "xxcha", "argent"];

/** Starts a game from a finished draft. */
export async function action({ request }: ActionFunctionArgs) {
  const body = (await request.json()) as Body;
  if (!body.draft) {
    return data({ success: false, error: "A draft is required." }, { status: 400 });
  }
  const saved =
    (await draftByPrettyUrl(body.draft)) ?? (await draftById(body.draft));
  if (!saved) {
    return data({ success: false, error: "Draft not found." }, { status: 404 });
  }

  const known = EXPANSIONS.map((e) => e.id);
  const expansions = (body.expansions ?? []).filter((e): e is Expansion =>
    known.includes(e as Expansion),
  );
  const options: StartGameOptions = {
    expansions,
    victoryPoints: VICTORY_POINT_TRACKS.includes(body.victoryPoints ?? 0)
      ? body.victoryPoints!
      : 10,
    keleresVariant: KELERES_VARIANTS.find((v) => v === body.keleresVariant),
  };

  try {
    const draft = JSON.parse(saved.data as string) as Draft;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const state = settle(
      createGame(gameSetupFromDraft(draft, options, seed)),
    );
    const { urlName } = await createSavedGame(state, saved.id);
    return data({ success: true, urlName });
  } catch (error) {
    if (error instanceof GameError) {
      return data({ success: false, error: error.message }, { status: 400 });
    }
    throw error;
  }
}
