import { notifications } from "@mantine/notifications";
import { create } from "zustand";
import { GameAction } from "~/game/actions";
import { openPrompts } from "~/game/engine/helpers";
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
  load: (urlName: string, view: GameView) => void;
  /** Picks how to join the game; undefined goes back to choosing. */
  chooseSeat: (seat?: Seat) => Promise<void>;
  selectSystem: (system?: SystemKey) => void;
  refresh: () => Promise<void>;
  /** Sends an action as `as`, defaulting to the seat being played. */
  dispatch: (action: GameAction, as?: PlayerId) => Promise<boolean>;
};

const seatKey = (urlName: string) => `game:seat:${urlName}`;
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

    load: (urlName, view) => set({ urlName, view, selectedSystem: undefined }),

    chooseSeat: async (seat) => {
      const { urlName, view } = get();
      localStorage.removeItem(legacyPlayerKey(urlName));
      if (seat === undefined) localStorage.removeItem(seatKey(urlName));
      else localStorage.setItem(seatKey(urlName), JSON.stringify(seat));
      set({ seat, player: playerFor(seat, view) });
      if (seat) await get().refresh();
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
    },

    dispatch: async (action, as) => {
      const { urlName, player } = get();
      const actor = as ?? player;
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

/** The current view; only for components rendered once a game has loaded. */
export const useView = () => useGame((state) => state.view!);
