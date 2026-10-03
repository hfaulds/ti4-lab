import {
  Badge,
  Box,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconCrown } from "@tabler/icons-react";
import { Link, MetaFunction, useLoaderData } from "react-router";
import { MainAppShell } from "~/components/MainAppShell";
import { FactionIcon } from "~/components/icons/FactionIcon";
import { factions } from "~/data/factionData";
import {
  listOngoingGames,
  OngoingGameSummary,
} from "~/drizzle/game.server";
import { playerColor } from "./game.$id/colors";

export const meta: MetaFunction = () => [{ title: "TI4 Lab Games" }];

export const loader = async () => {
  const games = await listOngoingGames();
  return { games };
};

const PHASE_NAMES = {
  setup: "Setup",
  strategy: "Strategy phase",
  action: "Action phase",
  status: "Status phase",
  agenda: "Agenda phase",
  finished: "Game over",
};

/** SQLite's CURRENT_TIMESTAMP is UTC without a zone marker. */
function formatUpdatedAt(value: string): string {
  const d = new Date(`${value.replace(" ", "T")}Z`);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time}`;
}

function GameCard({ game }: { game: OngoingGameSummary }) {
  const leader = Math.max(...game.players.map((p) => p.victoryPoints));
  return (
    <Paper
      component={Link}
      to={`/game/${game.urlName}`}
      withBorder
      p="md"
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <Stack gap="sm">
        <Stack gap={4} align="flex-start">
          <Text fw={700}>{game.urlName}</Text>
          <Badge variant="light">
            Round {game.round} · {PHASE_NAMES[game.phase]}
          </Badge>
        </Stack>

        <Stack gap={4}>
          {game.players.map((player) => (
            <Group key={player.name} gap="xs" wrap="nowrap">
              <Box
                w={4}
                h={20}
                style={{
                  background: playerColor(player.color),
                  borderRadius: 2,
                  flexShrink: 0,
                }}
              />
              <FactionIcon
                faction={player.faction}
                style={{ width: 20, height: 20, flexShrink: 0 }}
              />
              <Text size="sm" truncate style={{ flex: 1 }}>
                {player.name}
                <Text span size="xs" c="dimmed">
                  {" "}
                  · {factions[player.faction]?.name ?? player.faction}
                </Text>
              </Text>
              {player.speaker && (
                <IconCrown
                  size={14}
                  color="var(--mantine-color-yellow-5)"
                  style={{ flexShrink: 0 }}
                />
              )}
              <Text
                size="sm"
                fw={player.victoryPoints === leader && leader > 0 ? 700 : 400}
                style={{ flexShrink: 0 }}
              >
                {player.victoryPoints}
              </Text>
            </Group>
          ))}
        </Stack>

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            First to {game.victoryPointGoal} VP
          </Text>
          <Text size="xs" c="dimmed">
            Last played {formatUpdatedAt(game.updatedAt)}
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

export default function Games() {
  const { games } = useLoaderData<typeof loader>();

  return (
    <MainAppShell>
      <Container size="lg" py="xl">
        <Stack gap="lg">
          <Group gap="md">
            <Title order={2} ff="Orbitron">
              Ongoing Games
            </Title>
            <Badge variant="outline">{games.length}</Badge>
          </Group>

          {games.length === 0 ? (
            <Text c="dimmed">
              No games in progress. Start one from a finished draft.
            </Text>
          ) : (
            <Box
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: "var(--mantine-spacing-md)",
              }}
            >
              {games.map((game) => (
                <GameCard key={game.urlName} game={game} />
              ))}
            </Box>
          )}
        </Stack>
      </Container>
    </MainAppShell>
  );
}
