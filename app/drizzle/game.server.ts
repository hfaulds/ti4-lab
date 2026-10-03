import { and, desc, eq, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { generatePrettyUrlName } from "~/data/urlWords.server";
import { victoryPoints } from "~/game/engine/control";
import { GameState, Phase } from "~/game/types";
import { FactionId } from "~/types";
import { db } from "./config.server";
import { games } from "./schema.server";

export type SavedGame = {
  id: string;
  urlName: string;
  draftId: string | null;
  state: GameState;
};

function toSavedGame(row: typeof games.$inferSelect): SavedGame {
  return {
    id: row.id,
    urlName: row.urlName,
    draftId: row.draftId,
    state: JSON.parse(row.data as string) as GameState,
  };
}

export async function gameByUrlName(urlName: string) {
  const [row] = await db
    .select()
    .from(games)
    .where(eq(games.urlName, urlName))
    .limit(1);
  return row ? toSavedGame(row) : undefined;
}

export async function latestGameForDraft(draftId: string) {
  const [row] = await db
    .select({ urlName: games.urlName, isComplete: games.isComplete })
    .from(games)
    .where(eq(games.draftId, draftId))
    .orderBy(desc(games.createdAt))
    .limit(1);
  return row;
}

export type OngoingGameSummary = {
  urlName: string;
  round: number;
  phase: Phase;
  victoryPointGoal: number;
  updatedAt: string;
  players: {
    name: string;
    faction: FactionId;
    color: string;
    victoryPoints: number;
    speaker: boolean;
  }[];
};

/** Unfinished games, most recently played first. */
export async function listOngoingGames(): Promise<OngoingGameSummary[]> {
  const rows = await db
    .select()
    .from(games)
    .where(eq(games.isComplete, false))
    .orderBy(desc(games.updatedAt));
  return rows.map((row) => {
    const { urlName, state } = toSavedGame(row);
    // Clockwise around the table, starting from the speaker.
    const speakerSeat = state.seating.indexOf(state.speaker);
    const seating = [
      ...state.seating.slice(speakerSeat),
      ...state.seating.slice(0, speakerSeat),
    ];
    return {
      urlName,
      round: state.round,
      phase: state.phase,
      victoryPointGoal: state.options.victoryPoints,
      updatedAt: row.updatedAt,
      players: seating.map((id) => {
        const player = state.players[id];
        return {
          name: player.name,
          faction: player.faction,
          color: player.color,
          victoryPoints: victoryPoints(state, id),
          speaker: state.speaker === id,
        };
      }),
    };
  });
}

async function uniqueUrlName() {
  for (;;) {
    const urlName = generatePrettyUrlName();
    if (!(await gameByUrlName(urlName))) return urlName;
  }
}

export async function createSavedGame(state: GameState, draftId?: string) {
  const id = uuidv4().toString();
  const urlName = await uniqueUrlName();
  db.insert(games)
    .values({
      id,
      urlName,
      draftId: draftId ?? null,
      data: JSON.stringify(state),
      version: state.version,
      isComplete: state.phase === "finished",
    })
    .run();
  return { id, urlName };
}

/**
 * Saves a game only if nobody else has saved since `previousVersion` was
 * read. Returns false when the write lost that race.
 */
export function saveGame(
  id: string,
  state: GameState,
  previousVersion: number,
): boolean {
  const result = db
    .update(games)
    .set({
      data: JSON.stringify(state),
      version: state.version,
      isComplete: state.phase === "finished",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(games.id, id), eq(games.version, previousVersion)))
    .run();
  return result.changes > 0;
}
