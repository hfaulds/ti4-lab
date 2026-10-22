import type { Server } from "socket.io";
import type { GameState } from "~/game/types";
import { viewFor } from "~/game/view";
import { Draft, PlayerId } from "~/types";

interface SocketState {
  instance: Server | null;
}

interface GlobalWithSocket {
  __socketIO?: SocketState;
}

const socketState: SocketState = {
  instance: null,
};

if (typeof global !== "undefined") {
  const globalWithSocket = global as GlobalWithSocket;
  globalWithSocket.__socketIO = globalWithSocket.__socketIO || socketState;
}

export function setSocketIO(ioInstance: Server): void {
  socketState.instance = ioInstance;
  if (typeof global !== "undefined") {
    const globalWithSocket = global as GlobalWithSocket;
    if (globalWithSocket.__socketIO) {
      globalWithSocket.__socketIO.instance = ioInstance;
    }
  }
  console.log("Socket.IO instance set successfully");
}

function getSocketIO(): Server | null {
  if (typeof global !== "undefined") {
    const globalWithSocket = global as GlobalWithSocket;
    if (globalWithSocket.__socketIO?.instance) {
      return globalWithSocket.__socketIO.instance;
    }
  }
  return socketState.instance;
}

export async function broadcastDraftUpdate(
  draftId: string,
  draft: Draft,
): Promise<void> {
  const io = getSocketIO();

  if (!io) {
    console.warn(
      "Socket.IO instance not available, skipping WebSocket broadcast. " +
        "Clients will receive updates via API responses instead.",
    );
    return;
  }

  try {
    io.to(`draft:${draftId}`).emit("syncDraft", JSON.stringify(draft));
    console.log(`Broadcasted draft update to draft:${draftId}`);
  } catch (error) {
    console.error("Error broadcasting draft update:", error);
  }
}

/** The room for one seat of a game; spectators share the room without one. */
export function gameSeatRoom(gameId: string, player?: PlayerId): string {
  return player === undefined
    ? `game:${gameId}:spectator`
    : `game:${gameId}:seat:${player}`;
}

/**
 * Sends everyone watching a game its new state. Each seat sees different
 * hidden information, so each seat's room gets its own view.
 */
export function broadcastGameUpdate(gameId: string, state: GameState): void {
  const io = getSocketIO();
  if (!io) return;
  const { version } = state;
  try {
    io.to(gameSeatRoom(gameId)).emit("gameUpdated", {
      version,
      view: viewFor(state),
    });
    for (const player of Object.values(state.players)) {
      io.to(gameSeatRoom(gameId, player.id)).emit("gameUpdated", {
        version,
        viewer: player.id,
        view: viewFor(state, player.id),
      });
    }
  } catch (error) {
    console.error("Error broadcasting game update:", error);
  }
}
