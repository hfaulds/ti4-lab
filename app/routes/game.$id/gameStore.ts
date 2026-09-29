import { notifications } from "@mantine/notifications";
import { create } from "zustand";
import { GameAction } from "~/game/actions";
import { SystemKey } from "~/game/types";
import { GameView } from "~/game/view";
import { PlayerId } from "~/types";

type GameStore = {
  urlName: string;
  view?: GameView;
  /** Seat this browser is playing; undefined while spectating. */
  player?: PlayerId;
  selectedSystem?: SystemKey;
  busy: boolean;
  load: (urlName: string, view: GameView) => void;
  setPlayer: (player?: PlayerId) => Promise<void>;
  selectSystem: (system?: SystemKey) => void;
  refresh: () => Promise<void>;
  /** Sends an action as `as`, defaulting to the seat being played. */
  dispatch: (action: GameAction, as?: PlayerId) => Promise<boolean>;
};

const playerKey = (urlName: string) => `game:player:${urlName}`;

export const useGame = create<GameStore>((set, get) => ({
  urlName: "",
  busy: false,

  load: (urlName, view) => set({ urlName, view, selectedSystem: undefined }),

  setPlayer: async (player) => {
    const { urlName } = get();
    if (player === undefined) localStorage.removeItem(playerKey(urlName));
    else localStorage.setItem(playerKey(urlName), String(player));
    set({ player });
    await get().refresh();
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
      if (actor === player && result.view) set({ view: result.view });
      else await get().refresh();
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
}));

export const storedPlayer = (urlName: string): PlayerId | undefined => {
  const stored = localStorage.getItem(playerKey(urlName));
  return stored === null ? undefined : Number(stored);
};

/** The current view; only for components rendered once a game has loaded. */
export const useView = () => useGame((state) => state.view!);
