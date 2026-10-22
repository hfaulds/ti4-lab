import { Badge, Group, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { HistoryStep } from "~/game/history";
import { GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import { PlayerName } from "./shared";

/**
 * What the players said at the table and the deals they struck, kept or
 * broke, newest first. Table talk travels with the moves' notes, so it can
 * be read wherever the reasoning can: by everyone in games with no human
 * players, otherwise by the seat that made the move.
 */
export function TalkPanel({ view, player }: { view: GameView; player?: PlayerId }) {
  const urlName = useGame((state) => state.urlName);
  const [steps, setSteps] = useState<HistoryStep[]>([]);
  const known = useRef(-1);
  const finished = view.phase === "finished";

  useEffect(() => {
    known.current = -1;
    setSteps([]);
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
        const talked = body.steps.filter((step) => step.note?.talk?.length);
        if (talked.length > 0) setSteps((current) => [...current, ...talked]);
      });
    return () => {
      cancelled = true;
    };
  }, [urlName, player, finished, view.version]);

  if (steps.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nothing has been said at the table yet.
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      {[...steps].reverse().map((step) => (
        <Stack key={step.version} gap={2}>
          <Group gap="xs">
            <Badge variant="light">Round {step.round}</Badge>
            {step.player !== undefined && <PlayerName view={view} player={step.player} />}
          </Group>
          {step.note!.talk!.map((line, i) => (
            <Text key={i} size="sm">
              {line}
            </Text>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
