import {
  Badge,
  Box,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconCode, IconEye } from "@tabler/icons-react";
import { ReactNode } from "react";
import { FactionIcon } from "~/components/icons/FactionIcon";
import { factions } from "~/data/factionData";
import { openPrompts } from "~/game/engine/helpers";
import { asState, GameView } from "~/game/view";
import { playerColor } from "../colors";
import { Seat } from "../gameStore";

const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: "var(--mantine-spacing-sm)",
};

function Choice({
  onClick,
  accent,
  children,
}: {
  onClick: () => void;
  accent?: string;
  children: ReactNode;
}) {
  return (
    <UnstyledButton onClick={onClick} style={{ display: "block" }}>
      <Paper
        withBorder
        p="md"
        h="100%"
        style={{
          borderLeft: accent ? `4px solid ${accent}` : undefined,
        }}
      >
        {children}
      </Paper>
    </UnstyledButton>
  );
}

export function SeatPicker({
  view,
  onChoose,
}: {
  view: GameView;
  onChoose: (seat: Seat) => void;
}) {
  const waitingOn = new Set(
    openPrompts(asState(view)).map((prompt) => prompt.player),
  );
  if (waitingOn.size === 0 && view.activePlayer !== undefined) {
    waitingOn.add(view.activePlayer);
  }

  return (
    <Container size="md" py="xl">
      <Stack gap="xl">
        <Stack gap={4}>
          <Title order={2}>Who are you playing?</Title>
          <Text c="dimmed">You can change this later from the game.</Text>
        </Stack>

        <Box style={grid}>
          {view.seating.map((id) => {
            const player = view.players[id];
            return (
              <Choice
                key={id}
                accent={playerColor(player.color)}
                onClick={() => onChoose({ kind: "player", player: id })}
              >
                <Group gap="sm" wrap="nowrap">
                  <FactionIcon
                    faction={player.faction}
                    style={{ width: 36, height: 36, flexShrink: 0 }}
                  />
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Text fw={700} truncate>
                      {player.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {factions[player.faction]?.name ?? player.faction}
                    </Text>
                    <Group gap={4}>
                      {view.speaker === id && (
                        <Badge size="xs" color="yellow" variant="light">
                          Speaker
                        </Badge>
                      )}
                      {waitingOn.has(id) && (
                        <Badge size="xs" variant="light">
                          Their move
                        </Badge>
                      )}
                    </Group>
                  </Stack>
                </Group>
              </Choice>
            );
          })}
        </Box>

        <Box style={grid}>
          <Choice onClick={() => onChoose({ kind: "spectator" })}>
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <IconEye size={28} style={{ flexShrink: 0 }} />
              <Stack gap={2}>
                <Text fw={700}>Spectator</Text>
                <Text size="xs" c="dimmed">
                  Watch the game. Everyone&apos;s hidden cards stay hidden.
                </Text>
              </Stack>
            </Group>
          </Choice>
          <Choice onClick={() => onChoose({ kind: "developer" })}>
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <IconCode size={28} style={{ flexShrink: 0 }} />
              <Stack gap={2}>
                <Text fw={700}>Developer</Text>
                <Text size="xs" c="dimmed">
                  Play every seat. You become whichever player the game is
                  waiting on, in turn.
                </Text>
              </Stack>
            </Group>
          </Choice>
        </Box>
      </Stack>
    </Container>
  );
}
