import { Badge, Box, Button, Group, Stack, Text } from "@mantine/core";
import { Section, SectionTitle } from "~/components/Section";
import { agendasById, objectivesById } from "~/game/data";
import { objectiveStatus } from "~/game/engine/objectives";
import { asState, GameView, isHidden } from "~/game/view";
import { PlayerId } from "~/types";
import { playerColor } from "../colors";
import { useGame } from "../gameStore";
import { CardText } from "./shared";

export function StatusBadge({
  view,
  player,
  objective,
}: {
  view: GameView;
  player: PlayerId;
  objective: string;
}) {
  const status = objectiveStatus(asState(view), player, objective);
  if (status.met === "manual") {
    return (
      <Badge size="xs" variant="outline" color="gray">
        You judge
      </Badge>
    );
  }
  return (
    <Badge size="xs" variant="light" color={status.met ? "green" : "gray"}>
      {status.cost
        ? status.met
          ? "Can pay"
          : "Cannot pay"
        : status.met
          ? "Met"
          : "Not met"}
    </Badge>
  );
}

export function ObjectivesPanel({
  view,
  player,
}: {
  view: GameView;
  player?: PlayerId;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const me = player !== undefined ? view.players[player] : undefined;
  // Action and agenda phase secrets are claimed as they happen.
  const claimable = (id: string) => {
    const phase = objectivesById[id]?.phase;
    return phase === view.phase && (phase === "action" || phase === "agenda");
  };

  return (
    <Stack gap="md">
      <Section>
        <SectionTitle title="Public objectives" />
        <Stack gap="xs">
          {view.publicObjectives.map((objective, idx) => {
            const stage = idx < 5 ? "Stage I" : "Stage II";
            if (!objective.revealed || isHidden(objective.id)) {
              return (
                <Text key={idx} size="xs" c="dimmed" px="sm">
                  {stage}: not yet revealed
                </Text>
              );
            }
            const data = objectivesById[objective.id];
            return (
              <CardText
                key={objective.id}
                title={data.name}
                subtitle={`${stage}, ${data.points} VP`}
                right={
                  player !== undefined &&
                  !objective.scoredBy.includes(player) && (
                    <StatusBadge
                      view={view}
                      player={player}
                      objective={objective.id}
                    />
                  )
                }
              >
                {data.text}
                {objective.scoredBy.length > 0 && (
                  <Group gap={4} mt={4} component="span">
                    {objective.scoredBy.map((id) => (
                      <Badge
                        key={id}
                        size="xs"
                        styles={{
                          root: {
                            background: playerColor(view.players[id].color),
                            color: "#111",
                          },
                        }}
                      >
                        {view.players[id].name}
                      </Badge>
                    ))}
                  </Group>
                )}
              </CardText>
            );
          })}
        </Stack>
      </Section>

      {me && (
        <Section>
          <SectionTitle title="Your secret objectives" />
          <Stack gap="xs">
            {me.secretObjectives.length + me.scoredSecrets.length === 0 && (
              <Text size="sm" c="dimmed" px="sm">
                None yet.
              </Text>
            )}
            {me.scoredSecrets.map((id) => (
              <CardText
                key={id}
                title={objectivesById[id].name}
                subtitle="Scored"
              >
                {objectivesById[id].text}
              </CardText>
            ))}
            {me.secretObjectives.filter((id) => !isHidden(id)).map((id) => (
              <CardText
                key={id}
                title={objectivesById[id].name}
                subtitle={`Scored in the ${objectivesById[id].phase} phase`}
                right={
                  <Group gap={4} wrap="nowrap">
                    <StatusBadge view={view} player={me.id} objective={id} />
                    {claimable(id) && (
                      <Button
                        size="compact-xs"
                        onClick={() =>
                          dispatch({ type: "SCORE_OBJECTIVE", objective: id })
                        }
                      >
                        Score
                      </Button>
                    )}
                  </Group>
                }
              >
                {objectivesById[id].text}
              </CardText>
            ))}
          </Stack>
        </Section>
      )}

      <Section>
        <SectionTitle title="Scored secrets" />
        <Stack gap="xs" px="sm">
          {view.seating.every(
            (id) => view.players[id].scoredSecrets.length === 0,
          ) && (
            <Text size="sm" c="dimmed">
              None yet.
            </Text>
          )}
          {view.seating.flatMap((id) =>
            view.players[id].scoredSecrets.map((secret) => (
              <Text key={`${id}-${secret}`} size="sm">
                <Text span fw={700}>
                  {view.players[id].name}:
                </Text>{" "}
                {objectivesById[secret]?.name}
              </Text>
            )),
          )}
        </Stack>
      </Section>

      <Section>
        <SectionTitle title="Laws in play" />
        <Stack gap="xs">
          {view.laws.length === 0 && (
            <Text size="sm" c="dimmed" px="sm">
              None.
            </Text>
          )}
          {view.laws.map((law) => {
            const agenda = agendasById[law.id];
            return (
              <CardText
                key={law.id}
                title={agenda.name}
                subtitle={law.outcome ? `Outcome: ${law.outcome}` : undefined}
              >
                {agenda.text1}
              </CardText>
            );
          })}
        </Stack>
      </Section>
      <Box />
    </Stack>
  );
}
