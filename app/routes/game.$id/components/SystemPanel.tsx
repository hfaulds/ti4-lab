import { Badge, Box, Group, Stack, Text } from "@mantine/core";
import { Section, SectionTitle } from "~/components/Section";
import { attachmentsById } from "~/game/data";
import {
  anomaliesOf,
  infoOf,
  planetInfluence,
  planetResources,
  planetTechSpecialties,
  planetTraits,
  wormholesOf,
} from "~/game/engine/board";
import { productionCapacity } from "~/game/engine/economy";
import { totalUnits } from "~/game/engine/helpers";
import { asState, GameView } from "~/game/view";
import { useGame } from "../gameStore";
import { PlayerName, UnitChips } from "./shared";

const label = (value: string) => value.toLowerCase().replace(/_/g, " ");

export function SystemPanel({ view }: { view: GameView }) {
  const selected = useGame((state) => state.selectedSystem);
  const system = selected !== undefined ? view.systems[selected] : undefined;
  if (!system) {
    return (
      <Text size="sm" c="dimmed">
        Select a system on the board to see what is there.
      </Text>
    );
  }
  const state = asState(view);
  const info = infoOf(system);
  const fleets = Object.keys(system.space)
    .map(Number)
    .filter((id) => totalUnits(system.space[id]) > 0);
  const title =
    system.planets.length > 0
      ? system.planets.join(" / ")
      : `System ${system.systemId}`;

  return (
    <Section>
      <SectionTitle title={title}>
        <Text size="xs" c="dimmed">
          Tile {info?.id ?? system.systemId}
        </Text>
      </SectionTitle>
      <Stack gap="sm" px="sm">
        <Group gap={4}>
          {system.homeOf !== undefined && (
            <Badge variant="light" color="green">
              Home of {view.players[system.homeOf].name}
            </Badge>
          )}
          {anomaliesOf(system).map((anomaly) => (
            <Badge key={anomaly} variant="light" color="red">
              {label(anomaly)}
            </Badge>
          ))}
          {wormholesOf(system).map((wormhole) => (
            <Badge key={wormhole} variant="light" color="orange">
              {label(wormhole)} wormhole
            </Badge>
          ))}
          {system.frontier && <Badge variant="light">Frontier token</Badge>}
          {system.commandTokens.map((id) => (
            <Badge key={id} variant="outline" color="gray">
              {view.players[id].name} token
            </Badge>
          ))}
          {view.seating
            .filter((id) => productionCapacity(state, system.key, id) > 0)
            .map((id) => (
              <Badge key={`production-${id}`} variant="outline" color="gray">
                {view.players[id].name} production{" "}
                {productionCapacity(state, system.key, id)}
              </Badge>
            ))}
        </Group>

        <Box>
          <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
            Space
          </Text>
          {fleets.length === 0 && (
            <Text size="sm" c="dimmed">
              Empty
            </Text>
          )}
          {fleets.map((id) => (
            <Group key={id} gap="xs" mt={4}>
              <PlayerName view={view} player={id} />
              <UnitChips view={view} player={id} group={system.space[id]} />
            </Group>
          ))}
        </Box>

        {system.planets.map((name) => {
          const planet = view.planets[name];
          const owners = Object.keys(planet.units)
            .map(Number)
            .filter((id) => totalUnits(planet.units[id]) > 0);
          return (
            <Box key={name}>
              <Group gap="xs">
                <Text size="sm" fw={700}>
                  {name}
                </Text>
                <Badge variant="light" color="yellow">
                  {planetResources(state, name)} resources
                </Badge>
                <Badge variant="light" color="blue">
                  {planetInfluence(state, name)} influence
                </Badge>
                {planetTraits(state, name).map((trait) => (
                  <Badge key={trait} variant="outline" color="gray">
                    {label(trait)}
                  </Badge>
                ))}
                {planetTechSpecialties(state, name).map((tech, idx) => (
                  <Badge key={idx} variant="outline">
                    {label(tech)} specialty
                  </Badge>
                ))}
                {planet.exhausted && <Badge color="gray">Exhausted</Badge>}
                {name === "Mecatol Rex" && view.custodians && (
                  <Badge color="yellow">Custodians token</Badge>
                )}
              </Group>
              <Group gap={6} mt={2}>
                <Text size="xs" c="dimmed">
                  Controlled by
                </Text>
                {planet.controller !== undefined ? (
                  <PlayerName view={view} player={planet.controller} size="xs" />
                ) : (
                  <Text size="xs">nobody</Text>
                )}
              </Group>
              {planet.attachments.map((id) => (
                <Text key={id} size="xs" c="dimmed">
                  Attached: {attachmentsById[id]?.name ?? id}
                </Text>
              ))}
              {owners.map((id) => (
                <Group key={id} gap="xs" mt={4}>
                  <PlayerName view={view} player={id} size="xs" />
                  <UnitChips view={view} player={id} group={planet.units[id]} />
                </Group>
              ))}
            </Box>
          );
        })}
      </Stack>
    </Section>
  );
}
