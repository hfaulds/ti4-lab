import {
  Alert,
  Badge,
  Box,
  Grid,
  Group,
  LoadingOverlay,
  Select,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { useEffect } from "react";
import {
  data,
  LoaderFunctionArgs,
  MetaFunction,
  useLoaderData,
} from "react-router";
import { MainAppShell } from "~/components/MainAppShell";
import { gameByUrlName } from "~/drizzle/game.server";
import { EXPANSIONS } from "~/game/data";
import { openPrompts } from "~/game/engine/helpers";
import { asState, viewFor } from "~/game/view";
import { useSocketConnection } from "~/useSocketConnection";
import { ActionPanel } from "./components/ActionPanel";
import { AdjustPanel } from "./components/AdjustPanel";
import { GameBoard } from "./components/GameBoard";
import { HandPanel } from "./components/HandPanel";
import { LogPanel } from "./components/LogPanel";
import { ObjectivesPanel } from "./components/ObjectivesPanel";
import { PlayersPanel } from "./components/PlayersPanel";
import { PlayerName } from "./components/shared";
import { SystemPanel } from "./components/SystemPanel";
import { TradePanel } from "./components/TradePanel";
import { storedPlayer, useGame } from "./gameStore";

export async function loader({ params }: LoaderFunctionArgs) {
  const game = await gameByUrlName(params.id!);
  if (!game) throw new Response("Game not found", { status: 404 });
  // Everyone starts as a spectator; a seat's hidden cards are fetched once
  // the browser says which seat it is playing.
  return data({
    id: game.id,
    urlName: game.urlName,
    view: viewFor(game.state),
  });
}

export const meta: MetaFunction = () => [{ title: "TI4 Lab Game" }];

const PHASE_NAMES = {
  setup: "Setup",
  strategy: "Strategy phase",
  action: "Action phase",
  status: "Status phase",
  agenda: "Agenda phase",
  finished: "Game over",
};

export default function Game() {
  const loaded = useLoaderData<typeof loader>();
  const view = useGame((state) => state.view);
  const player = useGame((state) => state.player);
  const busy = useGame((state) => state.busy);
  const { load, setPlayer, refresh } = useGame.getState();

  useEffect(() => {
    load(loaded.urlName, loaded.view);
    void setPlayer(storedPlayer(loaded.urlName));
    // Only a different game should reset what is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.urlName]);

  const { socket, isDisconnected } = useSocketConnection({
    onConnect: () => {
      socket?.emit("joinGame", loaded.id);
      void refresh();
    },
  });
  useEffect(() => {
    if (!socket) return;
    socket.emit("joinGame", loaded.id);
    const onUpdate = ({ version }: { version: number }) => {
      const current = useGame.getState().view;
      if (!current || version > current.version) void refresh();
    };
    socket.on("gameUpdated", onUpdate);
    return () => {
      socket.off("gameUpdated", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, loaded.id]);

  if (!view) {
    return (
      <MainAppShell>
        <LoadingOverlay visible />
      </MainAppShell>
    );
  }

  const waitingOn = [
    ...new Set(openPrompts(asState(view)).map((prompt) => prompt.player)),
  ];
  const expansions = EXPANSIONS.filter((e) =>
    view.options.expansions.includes(e.id),
  );

  return (
    <MainAppShell>
      <Stack gap="md" mt="md" pos="relative">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Box>
            <Group gap="sm" align="baseline">
              <Title order={2}>Round {view.round}</Title>
              <Text size="lg" c="dimmed">
                {PHASE_NAMES[view.phase]}
              </Text>
            </Group>
            <Group gap="xs" mt={4}>
              <Badge variant="light" color="gray">
                Base game
              </Badge>
              {expansions.map((expansion) => (
                <Badge key={expansion.id} variant="light">
                  {expansion.name}
                </Badge>
              ))}
              <Badge variant="light" color="yellow">
                First to {view.options.victoryPoints} points
              </Badge>
            </Group>
          </Box>
          <Select
            label="Playing as"
            placeholder="Spectating"
            clearable
            w={220}
            data={view.seating.map((id) => ({
              value: String(id),
              label: view.players[id].name,
            }))}
            value={player === undefined ? null : String(player)}
            onChange={(value) =>
              void setPlayer(value === null ? undefined : Number(value))
            }
          />
        </Group>

        {isDisconnected && (
          <Alert color="orange" title="Disconnected">
            Live updates have stopped. They will resume when the connection
            returns.
          </Alert>
        )}

        {view.phase === "finished" && view.winner !== undefined && (
          <Alert color="green" title="Game over">
            <PlayerName view={view} player={view.winner} /> wins with{" "}
            {view.players[view.winner].victoryPoints} victory points.
          </Alert>
        )}

        {view.phase !== "finished" && (
          <Group gap="lg">
            {view.activePlayer !== undefined && (
              <Group gap={6}>
                <Text size="sm" c="dimmed">
                  Turn:
                </Text>
                <PlayerName view={view} player={view.activePlayer} />
              </Group>
            )}
            <Group gap={6}>
              <Text size="sm" c="dimmed">
                Speaker:
              </Text>
              <PlayerName view={view} player={view.speaker} />
            </Group>
            {waitingOn.length > 0 && (
              <Group gap={6}>
                <Text size="sm" c="dimmed">
                  Waiting on:
                </Text>
                {waitingOn.map((id) => (
                  <PlayerName key={id} view={view} player={id} />
                ))}
              </Group>
            )}
          </Group>
        )}

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 7 }}>
            <GameBoard view={view} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 5 }} pos="relative">
            <LoadingOverlay visible={busy} overlayProps={{ blur: 1 }} />
            <Tabs defaultValue="play" keepMounted={false}>
              <Tabs.List mb="sm">
                <Tabs.Tab value="play">Play</Tabs.Tab>
                <Tabs.Tab value="hand">Hand</Tabs.Tab>
                <Tabs.Tab value="players">Players</Tabs.Tab>
                <Tabs.Tab value="objectives">Objectives</Tabs.Tab>
                <Tabs.Tab value="trade">Trade</Tabs.Tab>
                <Tabs.Tab value="adjust">Adjust</Tabs.Tab>
                <Tabs.Tab value="log">Log</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="play">
                <Stack gap="md">
                  <ActionPanel view={view} player={player} />
                  <SystemPanel view={view} />
                </Stack>
              </Tabs.Panel>
              <Tabs.Panel value="hand">
                <HandPanel view={view} player={player} />
              </Tabs.Panel>
              <Tabs.Panel value="players">
                <PlayersPanel view={view} />
              </Tabs.Panel>
              <Tabs.Panel value="objectives">
                <ObjectivesPanel view={view} player={player} />
              </Tabs.Panel>
              <Tabs.Panel value="trade">
                <TradePanel view={view} player={player} />
              </Tabs.Panel>
              <Tabs.Panel value="adjust">
                <AdjustPanel view={view} player={player} />
              </Tabs.Panel>
              <Tabs.Panel value="log">
                <LogPanel view={view} />
              </Tabs.Panel>
            </Tabs>
          </Grid.Col>
        </Grid>
      </Stack>
    </MainAppShell>
  );
}
