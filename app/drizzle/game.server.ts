import { and, asc, desc, eq, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { generatePrettyUrlName } from "~/data/urlWords.server";
import { victoryPoints } from "~/game/engine/control";
import { GameAction } from "~/game/actions";
import { MoveNote } from "~/game/history";
import { GameState, Phase } from "~/game/types";
import { FactionId, PlayerId } from "~/types";
import { db } from "./config.server";
import { gameMoves, games } from "./schema.server";

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

export type GameMove = {
  /** The game's version once the move was applied. */
  version: number;
  player: PlayerId;
  action: GameAction;
  note?: MoveNote;
};

/**
 * Saves a new game that begins at `initial`. A game imported from elsewhere
 * passes the moves already played and the state they led to.
 */
export async function createSavedGame(
  initial: GameState,
  draftId?: string,
  played?: { moves: GameMove[]; state: GameState },
) {
  const id = uuidv4().toString();
  const urlName = await uniqueUrlName();
  const state = played?.state ?? initial;
  db.transaction((tx) => {
    tx.insert(games)
      .values({
        id,
        urlName,
        draftId: draftId ?? null,
        data: JSON.stringify(state),
        initialData: JSON.stringify(initial),
        version: state.version,
        isComplete: state.phase === "finished",
      })
      .run();
    for (const move of played?.moves ?? []) {
      tx.insert(gameMoves)
        .values({
          gameId: id,
          version: move.version,
          player: move.player,
          action: JSON.stringify(move.action),
          note: move.note ? JSON.stringify(move.note) : null,
        })
        .run();
    }
  });
  return { id, urlName };
}

/**
 * Saves a game and the move that produced it, only if nobody else has saved
 * since `previousVersion` was read. Returns false when the write lost that
 * race.
 */
export function saveGame(
  id: string,
  state: GameState,
  previousVersion: number,
  move: { player: PlayerId; action: GameAction; note?: MoveNote },
): boolean {
  return db.transaction((tx) => {
    const result = tx
      .update(games)
      .set({
        data: JSON.stringify(state),
        version: state.version,
        isComplete: state.phase === "finished",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(eq(games.id, id), eq(games.version, previousVersion)))
      .run();
    if (result.changes === 0) return false;
    tx.insert(gameMoves)
      .values({
        gameId: id,
        version: state.version,
        player: move.player,
        action: JSON.stringify(move.action),
        note: move.note ? JSON.stringify(move.note) : null,
      })
      .run();
    return true;
  });
}

/** The moves applied to a game after `afterVersion`, oldest first. */
export function gameMovesSince(id: string, afterVersion: number) {
  return db
    .select()
    .from(gameMoves)
    .where(
      and(
        eq(gameMoves.gameId, id),
        sql`${gameMoves.version} > ${afterVersion}`,
      ),
    )
    .orderBy(asc(gameMoves.version))
    .all()
    .map(
      (row): GameMove => ({
        version: row.version,
        player: row.player,
        action: JSON.parse(row.action) as GameAction,
        note: row.note ? (JSON.parse(row.note) as MoveNote) : undefined,
      }),
    );
}

/**
 * The state a game began from, or undefined for a game saved before moves
 * were recorded.
 */
export function initialGameState(id: string): GameState | undefined {
  const [row] = db
    .select({ initialData: games.initialData })
    .from(games)
    .where(eq(games.id, id))
    .limit(1)
    .all();
  return row?.initialData
    ? (JSON.parse(row.initialData as string) as GameState)
    : undefined;
}
