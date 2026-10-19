import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  LoadingOverlay,
  Stack,
  Tabs,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
} from "@tabler/icons-react";
import { useMediaQuery } from "@mantine/hooks";
import { ReactNode, useEffect, useState } from "react";
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
import { asState, GameView, viewFor } from "~/game/view";
import { PlayerId } from "~/types";
import { useDimensions } from "~/hooks/useDimensions";
import { useSocketConnection } from "~/useSocketConnection";
import { ActionPanel } from "./components/ActionPanel";
import { AdjustPanel } from "./components/AdjustPanel";
import { GameBoard } from "./components/GameBoard";
import { HandPanel } from "./components/HandPanel";
import { HistoryBar } from "./components/HistoryBar";
import { LogPanel } from "./components/LogPanel";
import { ReasoningPanel } from "./components/ReasoningPanel";
import { ObjectivesPanel } from "./components/ObjectivesPanel";
import { PlayersPanel } from "./components/PlayersPanel";
import { SeatPicker } from "./components/SeatPicker";
import { PlayerName } from "./components/shared";
import { SystemPanel } from "./components/SystemPanel";
import { TradePanel } from "./components/TradePanel";
import classes from "./layout.module.css";
import {
  Seat,
  storedSeat,
  storedSidebarOpen,
  storeSidebarOpen,
  useGame,
} from "./gameStore";

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
  const liveView = useGame((state) => state.view);
  const viewing = useGame((state) => state.viewing);
  const pastView = useGame((state) => state.pastView);
  const seat = useGame((state) => state.seat);
  const player = useGame((state) => state.player);
  const busy = useGame((state) => state.busy);
  const { load, chooseSeat, refresh } = useGame.getState();
  // The seat lives in this browser's storage, so it is only known once the
  // page is running here.
  const [seatRead, setSeatRead] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<string | null>("play");
  const sideBySide = useMediaQuery("(min-width: 75em)") ?? true;
  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    storeSidebarOpen(loaded.urlName, open);
  };

  useEffect(() => {
    load(loaded.urlName, loaded.view);
    void chooseSeat(storedSeat(loaded.urlName));
    setSidebarOpen(storedSidebarOpen(loaded.urlName));
    setSeatRead(true);
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

  // While looking back, everything below shows the game as it was then.
  const inPast = viewing !== undefined;
  const view = inPast && pastView ? pastView : liveView;

  if (!view || !liveView || !seatRead) {
    return (
      <MainAppShell>
        <LoadingOverlay visible />
      </MainAppShell>
    );
  }

  if (!seat) {
    return (
      <MainAppShell>
        <SeatPicker
          view={view}
          onChoose={(chosen) => void chooseSeat(chosen)}
        />
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
          <SeatSummary
            view={liveView}
            seat={seat}
            player={player}
            onChange={() => void chooseSeat(undefined)}
          />
        </Group>

        <HistoryBar view={liveView} />

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

        <MeasuredLayout>
          {(layoutWidth) => (
            <>
              <div className={classes.board}>
                <GameBoard
                  view={view}
                  wide={!sidebarOpen}
                  baseWidth={boardWidth(layoutWidth, sidebarOpen, sideBySide)}
                />
              </div>
              {!sidebarOpen && (
                <div>
                  <Tooltip label="Show panel" position="left">
                    <ActionIcon
                      variant="default"
                      size="lg"
                      aria-label="Show panel"
                      onClick={() => toggleSidebar(true)}
                    >
                      <IconLayoutSidebarRightExpand size={20} />
                    </ActionIcon>
                  </Tooltip>
                </div>
              )}
              {sidebarOpen && (
                <div className={classes.panel}>
                  <LoadingOverlay visible={busy} overlayProps={{ blur: 1 }} />
                  <Tabs value={tab} onChange={setTab} keepMounted={false}>
                    <Tabs.List mb="sm">
                      <Tooltip label="Hide panel">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="lg"
                          aria-label="Hide panel"
                          onClick={() => toggleSidebar(false)}
                          style={{ alignSelf: "center" }}
                        >
                          <IconLayoutSidebarRightCollapse size={20} />
                        </ActionIcon>
                      </Tooltip>
                      <Tabs.Tab value="play">Play</Tabs.Tab>
                      <Tabs.Tab value="hand">Hand</Tabs.Tab>
                      <Tabs.Tab value="players">Players</Tabs.Tab>
                      <Tabs.Tab value="objectives">Objectives</Tabs.Tab>
                      <Tabs.Tab value="trade">Trade</Tabs.Tab>
                      <Tabs.Tab value="adjust">Adjust</Tabs.Tab>
                      <Tabs.Tab value="log">Log</Tabs.Tab>
                      <Tabs.Tab value="reasoning">Reasoning</Tabs.Tab>
                    </Tabs.List>
                    {/* The tabs and panel toggle stay usable while looking back. */}
                    <ReadOnly when={inPast}>
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
                    </ReadOnly>
                    {/* Reading reasoning is not playing, so it stays usable. */}
                    <Tabs.Panel value="reasoning">
                      <ReasoningPanel view={liveView} player={player} />
                    </Tabs.Panel>
                  </Tabs>
                </div>
              )}
            </>
          )}
        </MeasuredLayout>
      </Stack>
    </MainAppShell>
  );
}

// Mantine's "lg" spacing, the gap between the board and what sits beside it.
const LAYOUT_GAP = 20;
// The "lg" ActionIcon that reopens the panel.
const EXPAND_BUTTON = 34;

/** The board's share of the layout's width. */
function boardWidth(layout: number, sidebarOpen: boolean, sideBySide: boolean) {
  if (!sideBySide) return layout;
  if (!sidebarOpen) return layout - LAYOUT_GAP - EXPAND_BUTTON;
  return ((layout - LAYOUT_GAP) * 7) / 12;
}

/** The board and panel row, which tells its contents how wide it is. */
function MeasuredLayout({
  children,
}: {
  children: (width: number) => React.ReactNode;
}) {
  const { ref, width } = useDimensions<HTMLDivElement>();
  return (
    <div ref={ref} className={classes.layout}>
      {children(width)}
    </div>
  );
}

/** Disables every control inside while viewing the past. */
function ReadOnly({ when, children }: { when: boolean; children: ReactNode }) {
  return (
    <Box
      component="fieldset"
      disabled={when}
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
    >
      {children}
    </Box>
  );
}

function SeatSummary({
  view,
  seat,
  player,
  onChange,
}: {
  view: GameView;
  seat: Seat;
  player?: PlayerId;
  onChange: () => void;
}) {
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {seat.kind === "developer" ? "Developer, playing as" : "Playing as"}
      </Text>
      {player !== undefined ? (
        <PlayerName view={view} player={player} />
      ) : (
        <Text size="sm" fw={600}>
          Spectator
        </Text>
      )}
      <Button size="compact-sm" variant="default" onClick={onChange}>
        Change
      </Button>
    </Group>
  );
}
