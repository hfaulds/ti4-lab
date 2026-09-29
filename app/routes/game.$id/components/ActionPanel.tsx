import { Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { Section, SectionTitle } from "~/components/Section";
import { strategyCardsById } from "~/game/data";
import { openPrompts } from "~/game/engine/helpers";
import { actionsAllowed, availableStrategyCards } from "~/game/engine/phases";
import { describeSystem } from "~/game/engine/tactical";
import { Prompt } from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import {
  AgendaCard,
  AnnounceRetreat,
  AssignHits,
  BreakTie,
  ChooseSecret,
  ChooseStartingTech,
  DiscardActionCards,
  PoliticsAgenda,
  Redistribute,
  Resolve,
  ReturnSecret,
  ScoreObjectives,
  SpaceCannon,
  Vote,
} from "./prompts";
import { CardText, PlayerName } from "./shared";
import { Secondary, StrategicActionForm } from "./strategic";
import { TacticalStep, tacticalStepName } from "./tactical";

function PromptForm({ view, prompt }: { view: GameView; prompt: Prompt }) {
  switch (prompt.kind) {
    case "chooseSecret":
      return <ChooseSecret view={view} prompt={prompt} />;
    case "chooseStartingTech":
      return <ChooseStartingTech view={view} prompt={prompt} />;
    case "secondary":
      return <Secondary view={view} prompt={prompt} />;
    case "politicsAgenda":
      return <PoliticsAgenda view={view} prompt={prompt} />;
    case "spaceCannon":
      return <SpaceCannon view={view} prompt={prompt} />;
    case "assignHits":
      return <AssignHits view={view} prompt={prompt} />;
    case "announceRetreat":
      return <AnnounceRetreat view={view} prompt={prompt} />;
    case "scoreObjectives":
      return <ScoreObjectives view={view} prompt={prompt} />;
    case "redistribute":
      return <Redistribute view={view} prompt={prompt} />;
    case "discardActionCards":
      return <DiscardActionCards view={view} prompt={prompt} />;
    case "returnSecret":
      return <ReturnSecret view={view} prompt={prompt} />;
    case "vote":
      return <Vote view={view} prompt={prompt} />;
    case "breakTie":
      return <BreakTie view={view} prompt={prompt} />;
    case "resolve":
      return <Resolve view={view} prompt={prompt} />;
  }
}

function StrategyPick({ view }: { view: GameView }) {
  const dispatch = useGame((state) => state.dispatch);
  return (
    <Stack gap="xs">
      <Text size="sm">Choose a strategy card.</Text>
      {availableStrategyCards(asState(view)).map((id) => {
        const card = strategyCardsById[id];
        const bonus = view.strategyCardBonus[id] ?? 0;
        return (
          <CardText
            key={id}
            title={`${card.initiative}. ${card.name}`}
            subtitle={
              bonus > 0
                ? `${bonus} trade ${bonus === 1 ? "good" : "goods"} on this card`
                : undefined
            }
            right={
              <Button
                size="compact-sm"
                onClick={() => dispatch({ type: "PICK_STRATEGY_CARD", card: id })}
              >
                Choose
              </Button>
            }
          >
            {card.primary.join("\n")}
          </CardText>
        );
      })}
    </Stack>
  );
}

function Turn({ view, player }: { view: GameView; player: PlayerId }) {
  const dispatch = useGame((state) => state.dispatch);
  const selected = useGame((state) => state.selectedSystem);
  const [card, setCard] = useState<string>();
  const [component, setComponent] = useState("");
  const state = asState(view);
  const me = view.players[player];
  const remaining = actionsAllowed(state, player) - view.actionsThisTurn;
  const unused = me.strategyCards.filter((c) => !c.exhausted);

  if (card && unused.some((c) => c.id === card)) {
    return (
      <StrategicActionForm
        view={view}
        player={player}
        card={card}
        onCancel={() => setCard(undefined)}
      />
    );
  }

  if (remaining <= 0) {
    return (
      <Stack gap="xs">
        <Text size="sm">
          Your action is done. Trade or make adjustments if you need to, then
          end your turn.
        </Text>
        <Button onClick={() => dispatch({ type: "END_TURN" })}>End turn</Button>
      </Stack>
    );
  }

  const system = selected !== undefined ? view.systems[selected] : undefined;
  const blocked = system?.commandTokens.includes(player);
  return (
    <Stack gap="md">
      <Stack gap={6}>
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
          Tactical action ({me.pools.tactic} tactic{" "}
          {me.pools.tactic === 1 ? "token" : "tokens"})
        </Text>
        <Button
          disabled={!system || blocked || me.pools.tactic === 0}
          onClick={() =>
            dispatch({ type: "ACTIVATE_SYSTEM", system: selected! })
          }
        >
          {!system
            ? "Select a system on the board"
            : blocked
              ? "You already have a token there"
              : `Activate ${describeSystem(state, system.key)}`}
        </Button>
      </Stack>

      {unused.length > 0 && (
        <Stack gap={6}>
          <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
            Strategic action
          </Text>
          <Group gap="xs">
            {unused.map((held) => (
              <Button
                key={held.id}
                variant="default"
                onClick={() => setCard(held.id)}
              >
                {strategyCardsById[held.id].name}
              </Button>
            ))}
          </Group>
        </Stack>
      )}

      <Stack gap={6}>
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
          Component action
        </Text>
        <Text size="xs" c="dimmed">
          For an action on a technology, leader, relic or faction sheet. Action
          cards are played from the Hand tab.
        </Text>
        <Group gap="xs" align="flex-end">
          <TextInput
            placeholder="What are you doing?"
            maxLength={300}
            value={component}
            onChange={(event) => setComponent(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button
            variant="default"
            disabled={component.trim().length === 0}
            onClick={async () => {
              const done = await dispatch({
                type: "COMPONENT_ACTION",
                description: component,
              });
              if (done) setComponent("");
            }}
          >
            Take action
          </Button>
        </Group>
      </Stack>

      <Group gap="xs">
        {view.actionsThisTurn > 0 && (
          <Button onClick={() => dispatch({ type: "END_TURN" })}>
            End turn
          </Button>
        )}
        <Button
          variant="default"
          disabled={unused.length > 0 || view.actionsThisTurn > 0}
          title={
            unused.length > 0
              ? "Use your strategy card before passing"
              : undefined
          }
          onClick={() => dispatch({ type: "PASS" })}
        >
          Pass
        </Button>
      </Group>
    </Stack>
  );
}

function Waiting({ view }: { view: GameView }) {
  const waitingOn = [
    ...new Set(openPrompts(asState(view)).map((prompt) => prompt.player)),
  ];
  const players =
    waitingOn.length > 0
      ? waitingOn
      : view.activePlayer !== undefined
        ? [view.activePlayer]
        : [];
  if (players.length === 0) return null;
  return (
    <Group gap="xs">
      <Text size="sm" c="dimmed">
        Waiting on
      </Text>
      {players.map((id) => (
        <PlayerName key={id} view={view} player={id} />
      ))}
    </Group>
  );
}

export function ActionPanel({
  view,
  player,
}: {
  view: GameView;
  player?: PlayerId;
}) {
  const state = asState(view);
  const open = openPrompts(state);
  const mine = open.filter((prompt) => prompt.player === player);
  const tactical = view.tactical;

  let title = "Play";
  let body: React.ReactNode = null;

  if (view.phase === "finished") {
    title = "Game over";
    body = (
      <Text size="sm" c="dimmed">
        The game has ended. All cards are now visible.
      </Text>
    );
  } else if (player === undefined) {
    body = (
      <Stack gap="xs">
        <Text size="sm">
          You are watching. Choose who you are playing as to take part.
        </Text>
        <Waiting view={view} />
      </Stack>
    );
  } else if (mine.length > 0) {
    title = "Your decision";
    body = (
      <Stack gap="lg">
        {mine.map((prompt) => (
          <PromptForm key={prompt.id} view={view} prompt={prompt} />
        ))}
      </Stack>
    );
  } else if (open.length > 0) {
    body = (
      <Stack gap="xs">
        {view.phase === "agenda" && <AgendaCard view={view} />}
        <Waiting view={view} />
      </Stack>
    );
  } else if (view.activePlayer !== player) {
    body = <Waiting view={view} />;
  } else if (view.phase === "strategy") {
    title = "Your pick";
    body = <StrategyPick view={view} />;
  } else if (view.phase === "action" && tactical) {
    title = tacticalStepName(tactical);
    body = <TacticalStep view={view} player={player} tactical={tactical} />;
  } else if (view.phase === "action") {
    title = "Your turn";
    body = <Turn view={view} player={player} />;
  }

  return (
    <Section>
      <SectionTitle title={title}>
        {tactical && (
          <Badge variant="light" color="yellow">
            {describeSystem(state, tactical.system)}:{" "}
            {tacticalStepName(tactical)}
          </Badge>
        )}
      </SectionTitle>
      <Stack px="sm">{body}</Stack>
    </Section>
  );
}
