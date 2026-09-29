import { draftConfig } from "~/draft";
import { computePlayerSelections, hydratePlayers } from "~/hooks/useHydratedDraft";
import { Draft, FactionId } from "~/types";
import { hydrateMap, hydratePresetMap } from "~/utils/map";
import { GameSetup } from "./engine/setup";
import { GameError, GameOptions } from "./types";

export type StartGameOptions = GameOptions & {
  /** Home system Council Keleres takes, when they are in the game. */
  keleresVariant?: FactionId;
};

/** Turns a finished draft into the starting position of a game. */
export function gameSetupFromDraft(
  draft: Draft,
  options: StartGameOptions,
  seed: number,
): GameSetup {
  if (draft.selections.length < draft.pickOrder.length) {
    throw new GameError("Finish the draft before starting a game.");
  }
  if (draft.settings.draftGameMode === "twilightsFall") {
    throw new GameError(
      "Twilight's Fall drafts cannot be played here yet: the game mode has its own rules.",
    );
  }

  const players = hydratePlayers(
    draft.players,
    draft.selections,
    draft.settings.draftSpeaker,
    draft.integrations.discord?.players,
    draft.availableReferenceCardPacks,
    draft.texasDraft,
    draft.settings,
  );
  const selections = computePlayerSelections(players);
  const map =
    draft.settings.draftGameMode === "presetMap"
      ? hydratePresetMap(draft.presetMap, selections)
      : hydrateMap(
          draftConfig[draft.settings.type],
          draft.presetMap,
          draft.slices,
          selections,
        );

  return {
    players: players.map((player, idx) => {
      if (!player.faction) {
        throw new GameError(`${player.name} has not chosen a faction.`);
      }
      return {
        id: player.id,
        name: player.name || `Player ${idx + 1}`,
        faction: player.faction,
        factionVariant:
          player.faction === "keleres" ? options.keleresVariant : undefined,
        color: player.factionColor,
        speakerOrder: player.speakerOrder ?? idx,
      };
    }),
    map,
    options: {
      expansions: options.expansions,
      victoryPoints: options.victoryPoints,
    },
    seed,
  };
}
