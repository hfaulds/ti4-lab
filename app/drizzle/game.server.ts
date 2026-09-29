import { and, desc, eq, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { generatePrettyUrlName } from "~/data/urlWords.server";
import { GameState } from "~/game/types";
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
