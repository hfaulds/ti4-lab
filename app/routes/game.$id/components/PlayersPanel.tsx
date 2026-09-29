import { Badge, Box, Group, Stack, Text, Tooltip } from "@mantine/core";
import {
  abilitiesById,
  factionSetupFor,
  leadersById,
  strategyCardsById,
  technologiesById,
} from "~/game/data";
import {
  controlledPlanets,
  planetInfluence,
  planetResources,
} from "~/game/engine/board";
import { asState, GameView, PlayerView } from "~/game/view";
import { factions } from "~/data/factionData";
import { playerColor } from "../colors";
import { PlayerName } from "./shared";

const TECH_COLORS: Record<string, string> = {
  BIOTIC: "green",
  WARFARE: "red",
  PROPULSION: "blue",
  CYBERNETIC: "yellow",
};

export function TechBadge({ id, exhausted }: { id: string; exhausted?: boolean }) {
  const tech = technologiesById[id];
  if (!tech) return null;
  return (
    <Tooltip label={tech.text} multiline w={320} withArrow>
      <Badge
        size="sm"
        variant={exhausted ? "outline" : "light"}
        color={tech.color ? TECH_COLORS[tech.color] : "gray"}
        style={{ textTransform: "none", opacity: exhausted ? 0.6 : 1 }}
      >
        {tech.name}
      </Badge>
    </Tooltip>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </Box>
  );
}

function PlayerCard({ view, player }: { view: GameView; player: PlayerView }) {
  const state = asState(view);
  const planets = controlledPlanets(state, player.id);
  const ready = planets.filter((p) => !p.exhausted);
  const total = (list: typeof planets, value: typeof planetResources) =>
    list.reduce((sum, p) => sum + value(state, p.name), 0);
  const setup = factionSetupFor(player.faction, player.factionVariant);

  return (
    <Box
      p="sm"
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderLeft: `4px solid ${playerColor(player.color)}`,
        borderRadius: "var(--mantine-radius-sm)",
        opacity: player.eliminated ? 0.5 : 1,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Box>
          <PlayerName view={view} player={player.id} size="md" />
          <Text size="xs" c="dimmed">
            {factions[player.faction].name}
          </Text>
        </Box>
        <Group gap={4}>
          {view.speaker === player.id && <Badge color="yellow">Speaker</Badge>}
          {player.passed && view.phase === "action" && (
            <Badge color="gray">Passed</Badge>
          )}
          {player.eliminated && <Badge color="red">Eliminated</Badge>}
          <Badge size="lg" variant="filled">
            {player.victoryPoints} VP
          </Badge>
        </Group>
      </Group>

      <Group gap="lg" mt="xs">
        <Stat
          label="Tactic / Fleet / Strategy"
          value={`${player.pools.tactic} / ${player.pools.fleet} / ${player.pools.strategy}`}
        />
        <Stat label="Trade goods" value={player.tradeGoods} />
        <Stat
          label="Commodities"
          value={`${player.commodities} / ${player.commodityLimit}`}
        />
        <Stat label="Action cards" value={player.hand.actionCards} />
        <Stat label="Secrets" value={player.hand.secretObjectives} />
        <Stat label="Notes" value={player.hand.promissoryNotes} />
      </Group>

      <Group gap="lg" mt="xs">
        <Stat
          label="Planets"
          value={`${planets.length} (${ready.length} ready)`}
        />
        <Stat
          label="Resources"
          value={`${total(ready, planetResources)} / ${total(planets, planetResources)}`}
        />
        <Stat
          label="Influence"
          value={`${total(ready, planetInfluence)} / ${total(planets, planetInfluence)}`}
        />
      </Group>

      {player.strategyCards.length > 0 && (
        <Group gap={4} mt="xs">
          {player.strategyCards.map((card) => (
            <Badge
              key={card.id}
              variant={card.exhausted ? "outline" : "filled"}
              color={card.exhausted ? "gray" : undefined}
              styles={
                card.exhausted
                  ? undefined
                  : { root: { background: strategyCardsById[card.id].color } }
              }
            >
              {strategyCardsById[card.id].initiative}{" "}
              {strategyCardsById[card.id].name}
            </Badge>
          ))}
        </Group>
      )}

      {player.technologies.length > 0 && (
        <Group gap={4} mt="xs">
          {player.technologies.map((id) => (
            <TechBadge
              key={id}
              id={id}
              exhausted={player.exhaustedTechnologies.includes(id)}
            />
          ))}
        </Group>
      )}

      {player.leaders.length > 0 && (
        <Group gap={4} mt="xs">
          {player.leaders.map((leader) => {
            const data = leadersById[leader.id];
            return (
              <Tooltip
                key={leader.id}
                multiline
                w={320}
                withArrow
                label={`${data.window} ${data.text}${
                  leader.status === "locked" ? ` Unlock: ${data.unlock}` : ""
                }`}
              >
                <Badge
                  size="sm"
                  variant={leader.status === "ready" ? "light" : "outline"}
                  color={leader.status === "ready" ? "grape" : "gray"}
                  style={{ textTransform: "none" }}
                >
                  {data.name} ({leader.type}, {leader.status})
                </Badge>
              </Tooltip>
            );
          })}
        </Group>
      )}

      {setup && setup.abilities.length > 0 && (
        <Stack gap={2} mt="xs">
          {setup.abilities
            .map((id) => abilitiesById[id])
            .filter(Boolean)
            .map((ability) => (
              <Text key={ability.id} size="xs" c="dimmed">
                <Text span fw={700} c="var(--mantine-color-text)">
                  {ability.name}:
                </Text>{" "}
                {ability.text}
              </Text>
            ))}
        </Stack>
      )}
    </Box>
  );
}

export function PlayersPanel({ view }: { view: GameView }) {
  return (
    <Stack gap="sm">
      {view.seating.map((id) => (
        <PlayerCard key={id} view={view} player={view.players[id]} />
      ))}
    </Stack>
  );
}
