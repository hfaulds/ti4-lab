import { useEffect } from "react";
import {
  playNotificationSound,
  requestNotificationPermission,
  showNotification,
} from "~/utils/notifications";
import { useHydratedDraft } from "./useHydratedDraft";
import { useDraft } from "~/draftStore";

export function useNotifyActivePlayer() {
  const { activePlayer } = useHydratedDraft();
  const activePlayerId = activePlayer?.id;
  const selectedPlayer = useDraft((state) => state.selectedPlayer);
  // A developer is every player in turn, so every pick would alert.
  const developer = useDraft((state) => state.developer);

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  const handleNotify = () => {
    const title = "It's your turn to draft!";
    const options = {
      icon: "/icon.png",
      badge: "/badge.png",
    };
    showNotification(title, options);
    playNotificationSound();
  };

  useEffect(() => {
    if (developer) return;
    if (activePlayerId === undefined || selectedPlayer === undefined) return;
    if (activePlayerId === selectedPlayer) {
      handleNotify();
    }
  }, [activePlayerId === selectedPlayer]);
}
