import { notifications } from "@mantine/notifications";
import { create } from "zustand";
import { GameAction } from "~/game/actions";
import { openPrompts } from "~/game/engine/helpers";
import { HistoryStep } from "~/game/history";
import { SystemKey } from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";

/**
 * Who this browser is at the table. A developer plays every seat, becoming
 * whichever player the game is waiting on.
 */
export type Seat =
  | { kind: "player"; player: PlayerId }
  | { kind: "spectator" }
  | { kind: "developer" };

type GameStore = {
  urlName: string;
  view?: GameView;
  /** Undefined until this browser has chosen how it joins the game. */
  seat?: Seat;
  /** Seat whose view is shown and who acts; undefined while spectating. */
  player?: PlayerId;
  selectedSystem?: SystemKey;
  busy: boolean;
  /** Every point of the game so far, once history has been opened. */
  steps?: HistoryStep[];
  /** The earlier version on screen; undefined shows the game as it is now. */
  viewing?: number;
  /** The game at `viewing`, once it has arrived. */
  pastView?: GameView;
  load: (urlName: string, view: GameView) => void;
  /** Picks how to join the game; undefined goes back to choosing. */
  chooseSeat: (seat?: Seat) => Promise<void>;
  selectSystem: (system?: SystemKey) => void;
  refresh: () => Promise<void>;
  /** Takes in a move pushed over the socket. */
  receive: (update: GameUpdate) => Promise<void>;
  /** Sends an action as `as`, defaulting to the seat being played. */
  dispatch: (action: GameAction, as?: PlayerId) => Promise<boolean>;
  openHistory: () => Promise<void>;
  closeHistory: () => void;
  /** Shows the game as it was at `version`; undefined returns to now. */
  viewVersion: (version?: number) => Promise<void>;
};

/** What the server pushes when a game moves on. */
export type GameUpdate = {
  version: number;
  /** The seat `view` is shown to; undefined for a spectator's. */
  viewer?: PlayerId;
  /** Missing from servers that only announced the new version. */
  view?: GameView;
};

const seatKey = (urlName: string) => `game:seat:${urlName}`;
const sidebarKey = (urlName: string) => `game:sidebar:${urlName}`;
const historyKey = (urlName: string) => `game:history:${urlName}`;
/** Where the seat was kept before spectators and developers existed. */
const legacyPlayerKey = (urlName: string) => `game:player:${urlName}`;

/** The player a developer should be: whoever the game is waiting on. */
export function nextActor(view: GameView): PlayerId | undefined {
  return openPrompts(asState(view))[0]?.player ?? view.activePlayer;
}

function playerFor(seat: Seat | undefined, view: GameView | undefined) {
  if (seat?.kind === "player") return seat.player;
  if (seat?.kind === "developer" && view) {
    return nextActor(view) ?? view.seating[0];
  }
  return undefined;
}

export const useGame = create<GameStore>((set, get) => {
  /** A developer becomes whoever the game now waits on. */
  const followTurn = async () => {
    const { seat, view, player } = get();
    if (seat?.kind !== "developer" || !view) return;
    const next = playerFor(seat, view);
    if (next === player) return;
    set({ player: next });
    // The new seat sees its own hidden cards.
    await get().refresh();
  };

  return {
    urlName: "",
    busy: false,

    load: (urlName, view) =>
      set({
        urlName,
        view,
        selectedSystem: undefined,
        steps: undefined,
        viewing: undefined,
        pastView: undefined,
      }),

    chooseSeat: async (seat) => {
      const { urlName, view } = get();
      localStorage.removeItem(legacyPlayerKey(urlName));
      if (seat === undefined) localStorage.removeItem(seatKey(urlName));
      else localStorage.setItem(seatKey(urlName), JSON.stringify(seat));
      set({ seat, player: playerFor(seat, view) });
      if (!seat) return;
      await get().refresh();
      // What a seat may read in the past differs too.
      const { steps, viewing } = get();
      if (steps) {
        set({ steps: undefined });
        await get().openHistory();
      }
      if (viewing !== undefined) await get().viewVersion(viewing);
    },

    selectSystem: (selectedSystem) => set({ selectedSystem }),

    refresh: async () => {
      const { urlName, player } = get();
      const query = player === undefined ? "" : `?player=${player}`;
      const response = await fetch(`/api/game/${urlName}${query}`);
      if (!response.ok) return;
      const { view } = (await response.json()) as { view: GameView };
      // A slow response must not replace something newer.
      const current = get().view;
      if (!current || view.version >= current.version) set({ view });
      await followTurn();
      if (get().steps) await get().openHistory();
    },

    receive: async ({ version, viewer, view }) => {
      const { player, view: current } = get();
      if (current && version <= current.version) return;
      // A view for a seat this browser has since left is no use.
      if (!view || viewer !== player) {
        await get().refresh();
        return;
      }
      set({ view });
      await followTurn();
      if (get().steps) await get().openHistory();
    },

    dispatch: async (action, as) => {
      const { urlName, player } = get();
      const actor = as ?? player;
      if (get().viewing !== undefined) {
        notifications.show({
          color: "orange",
          title: "Viewing history",
          message: "Return to the current game before acting.",
        });
        return false;
      }
      if (actor === undefined) {
        notifications.show({
          color: "orange",
          title: "Spectating",
          message: "Choose which player you are before acting.",
        });
        return false;
      }
      set({ busy: true });
      try {
        const response = await fetch(`/api/game/${urlName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ player: actor, action }),
        });
        const result = (await response.json()) as {
          success: boolean;
          error?: string;
          view?: GameView;
        };
        if (!result.success) {
          notifications.show({
            color: "red",
            title: "Not allowed",
            message: result.error ?? "That action failed.",
          });
          return false;
        }
        // The response shows the actor's seat; re-read when acting for another.
        if (actor === player && result.view) {
          set({ view: result.view });
          await followTurn();
        } else {
          await get().refresh();
        }
        return true;
      } catch {
        notifications.show({
          color: "red",
          title: "Connection problem",
          message: "The action could not be sent. Please try again.",
        });
        return false;
      } finally {
        set({ busy: false });
      }
    },

    openHistory: async () => {
      const { urlName, player, steps } = get();
      const params = new URLSearchParams();
      if (player !== undefined) params.set("player", String(player));
      // Only the moves since the timeline was last read.
      const known = steps?.[steps.length - 1]?.version;
      if (known !== undefined) params.set("after", String(known));
      const response = await fetch(`/api/game/${urlName}/history?${params}`);
      if (!response.ok) return;
      const { steps: fresh } = (await response.json()) as {
        steps: HistoryStep[];
      };
      const current = get().steps ?? [];
      const last = current[current.length - 1]?.version ?? -1;
      set({ steps: [...current, ...fresh.filter((s) => s.version > last)] });
    },

    closeHistory: () =>
      set({ steps: undefined, viewing: undefined, pastView: undefined }),

    viewVersion: async (version) => {
      const { urlName, player, view } = get();
      if (version === undefined || version === view?.version) {
        set({ viewing: undefined, pastView: undefined });
        return;
      }
      set({ viewing: version });
      const params = new URLSearchParams({ version: String(version) });
      if (player !== undefined) params.set("player", String(player));
      const response = await fetch(`/api/game/${urlName}?${params}`);
      if (!response.ok) return;
      const { view: past } = (await response.json()) as { view: GameView };
      // Stepping on quickly must not show an older answer.
      if (get().viewing === version) set({ pastView: past });
    },
  };
});

export function storedSeat(urlName: string): Seat | undefined {
  try {
    const stored = localStorage.getItem(seatKey(urlName));
    if (stored !== null) return JSON.parse(stored) as Seat;
    const legacy = localStorage.getItem(legacyPlayerKey(urlName));
    if (legacy !== null) return { kind: "player", player: Number(legacy) };
  } catch {
    // Unreadable storage just means choosing again.
  }
  return undefined;
}

export function storedSidebarOpen(urlName: string): boolean {
  try {
    return localStorage.getItem(sidebarKey(urlName)) !== "closed";
  } catch {
    return true;
  }
}

export function storeSidebarOpen(urlName: string, open: boolean) {
  try {
    if (open) localStorage.removeItem(sidebarKey(urlName));
    else localStorage.setItem(sidebarKey(urlName), "closed");
  } catch {
    // Unwritable storage just means the panel reopens next visit.
  }
}

export function storedHistoryOpen(urlName: string): boolean {
  try {
    return localStorage.getItem(historyKey(urlName)) === "open";
  } catch {
    return false;
  }
}

export function storeHistoryOpen(urlName: string, open: boolean) {
  try {
    if (open) localStorage.setItem(historyKey(urlName), "open");
    else localStorage.removeItem(historyKey(urlName));
  } catch {
    // Unwritable storage just means the timeline starts closed next visit.
  }
}

/** The current view; only for components rendered once a game has loaded. */
export const useView = () => useGame((state) => state.view!);
