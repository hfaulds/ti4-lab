import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { HistoryStep } from "~/game/history";
import { GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import { Reasoning } from "./HistoryBar";
import { PlayerName } from "./shared";

const PAGE = 20;

/**
 * Why agents chose their moves, newest first, kept up to date as the game is
 * played. A note can mention its player's hidden cards, so the server only
 * sends it to that player's seat until the game is over, except in games
 * with no human players, where everyone reads it. While looking back
 * through history, the panel shows the reasoning behind the move on screen.
 */
export function ReasoningPanel({
  view,
  player,
}: {
  view: GameView;
  player?: PlayerId;
}) {
  const urlName = useGame((state) => state.urlName);
  const viewing = useGame((state) => state.viewing);
  const [notes, setNotes] = useState<HistoryStep[]>([]);
  const [shown, setShown] = useState(PAGE);
  const known = useRef(-1);
  const finished = view.phase === "finished";

  // A different seat, or the end of the game, changes what may be read.
  useEffect(() => {
    known.current = -1;
    setNotes([]);
  }, [urlName, player, finished]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ after: String(known.current) });
    if (player !== undefined) params.set("player", String(player));
    void fetch(`/api/game/${urlName}/history?${params}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body?: { steps: HistoryStep[] }) => {
        if (cancelled || !body || body.steps.length === 0) return;
        known.current = body.steps[body.steps.length - 1].version;
        const reasoned = body.steps.filter((step) => step.note);
        if (reasoned.length > 0) setNotes((current) => [...current, ...reasoned]);
      });
    return () => {
      cancelled = true;
    };
  }, [urlName, player, finished, view.version]);

  if (notes.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {finished
          ? "No agent explained its moves in this game."
          : "No reasoning to show yet. In games with human players, an agent's reasoning can mention its hidden cards, so it is shown only to the agent's own seat until the game is over."}
      </Text>
    );
  }

  // Looking back: the reasoning behind the latest move up to that point.
  if (viewing !== undefined) {
    const current = [...notes].reverse().find((step) => step.version <= viewing);
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          The latest reasoning up to the point on screen.
        </Text>
        {current ? (
          <NoteCard view={view} step={current} />
        ) : (
          <Text size="sm" c="dimmed">
            No agent had explained a move yet at this point.
          </Text>
        )}
      </Stack>
    );
  }

  const newest = [...notes].reverse();
  return (
    <Stack gap="md">
      {newest.slice(0, shown).map((step) => (
        <NoteCard key={step.version} view={view} step={step} />
      ))}
      {newest.length > shown && (
        <Button variant="subtle" size="xs" onClick={() => setShown(shown + PAGE)}>
          Show older reasoning ({newest.length - shown} more)
        </Button>
      )}
    </Stack>
  );
}

function NoteCard({ view, step }: { view: GameView; step: HistoryStep }) {
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Badge variant="light">Round {step.round}</Badge>
        <Text size="xs" c="dimmed">
          {step.phase} phase
        </Text>
        {step.player !== undefined && <PlayerName view={view} player={step.player} />}
      </Group>
      <Reasoning note={step.note!} />
    </Stack>
  );
}
