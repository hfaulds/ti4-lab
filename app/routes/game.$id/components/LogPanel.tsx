import { Badge, Box, ScrollArea, Stack, Text } from "@mantine/core";
import { UNIT_NAMES } from "~/game/data";
import { LogEntry } from "~/game/types";
import { GameView } from "~/game/view";
import { playerColor } from "../colors";

function Rolls({ view, entry }: { view: GameView; entry: LogEntry }) {
  if (!entry.rolls || entry.rolls.length === 0) return null;
  return (
    <Stack gap={0} mt={2}>
      {entry.rolls.map((roll, idx) => (
        <Text key={idx} size="xs" c="dimmed">
          {view.players[roll.player]?.name} {UNIT_NAMES[roll.unit]} (hits on{" "}
          {roll.target}):{" "}
          {roll.dice.map((die, i) => (
            <Text
              key={i}
              span
              fw={700}
              c={die >= roll.target ? "green" : "dimmed"}
            >
              {die}
              {i < roll.dice.length - 1 ? ", " : ""}
            </Text>
          ))}
        </Text>
      ))}
    </Stack>
  );
}

export function LogPanel({ view }: { view: GameView }) {
  const entries = [...view.log].reverse();
  return (
    <ScrollArea h="70vh" type="auto">
      <Stack gap={6}>
        {entries.map((entry) => (
          <Box
            key={entry.id}
            pl="xs"
            style={{
              borderLeft: `3px solid ${
                entry.player !== undefined && view.players[entry.player]
                  ? playerColor(view.players[entry.player].color)
                  : "var(--mantine-color-default-border)"
              }`,
            }}
          >
            <Text size="sm">
              {entry.text}{" "}
              {entry.manual && (
                <Badge size="xs" variant="outline" color="gray">
                  manual
                </Badge>
              )}
            </Text>
            <Rolls view={view} entry={entry} />
          </Box>
        ))}
      </Stack>
    </ScrollArea>
  );
}
