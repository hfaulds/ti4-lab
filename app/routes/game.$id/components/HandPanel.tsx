import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { Section, SectionTitle } from "~/components/Section";
import {
  actionCardsById,
  breakthroughsById,
  explorationsById,
  leadersById,
  promissoryNotesById,
  relicsById,
  technologiesById,
} from "~/game/data";
import { LeaderState } from "~/game/types";
import { GameView, isHidden } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import { CardText } from "./shared";

const NEXT_LEADER_STATUS: Record<
  LeaderState["status"],
  { label: string; status: LeaderState["status"] }[]
> = {
  locked: [{ label: "Unlock", status: "ready" }],
  ready: [
    { label: "Exhaust", status: "exhausted" },
    { label: "Purge", status: "purged" },
  ],
  exhausted: [{ label: "Ready", status: "ready" }],
  purged: [],
};

export function HandPanel({
  view,
  player,
}: {
  view: GameView;
  player?: PlayerId;
}) {
  const dispatch = useGame((state) => state.dispatch);
  if (player === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Choose which player you are to see your cards.
      </Text>
    );
  }
  const me = view.players[player];
  const cards = me.actionCards.filter((id) => !isHidden(id));
  const notes = me.promissoryNotes.filter((note) => !isHidden(note.id));

  return (
    <Stack gap="md">
      <Section>
        <SectionTitle title={`Action cards (${cards.length})`} />
        <Stack gap="xs">
          {cards.length === 0 && (
            <Text size="sm" c="dimmed" px="sm">
              None.
            </Text>
          )}
          {cards.map((id, idx) => {
            const card = actionCardsById[id];
            return (
              <CardText
                key={`${id}-${idx}`}
                title={card.name}
                subtitle={card.window}
                right={
                  <Button
                    size="compact-xs"
                    onClick={() => dispatch({ type: "PLAY_ACTION_CARD", card: id })}
                  >
                    Play
                  </Button>
                }
              >
                {card.text}
              </CardText>
            );
          })}
          <Text size="xs" c="dimmed" px="sm">
            Playing a card announces it and discards it. Apply what it does
            from the Adjust tab.
          </Text>
        </Stack>
      </Section>

      <Section>
        <SectionTitle title="Technologies" />
        <Stack gap="xs">
          {me.technologies.map((id) => {
            const tech = technologiesById[id];
            const exhausted = me.exhaustedTechnologies.includes(id);
            const exhaustible = /exhaust this card/i.test(tech.text);
            return (
              <CardText
                key={id}
                title={tech.name}
                subtitle={
                  tech.unitUpgrade ? "Unit upgrade" : tech.color?.toLowerCase()
                }
                right={
                  exhaustible && (
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() =>
                        dispatch({
                          type: "SET_EXHAUSTED",
                          kind: "technology",
                          id,
                          exhausted: !exhausted,
                        })
                      }
                    >
                      {exhausted ? "Ready" : "Exhaust"}
                    </Button>
                  )
                }
              >
                {tech.text}
              </CardText>
            );
          })}
        </Stack>
      </Section>

      {me.leaders.length > 0 && (
        <Section>
          <SectionTitle title="Leaders" />
          <Stack gap="xs">
            {me.leaders.map((leader) => {
              const data = leadersById[leader.id];
              return (
                <CardText
                  key={leader.id}
                  title={`${data.name}, ${leader.type}`}
                  subtitle={
                    leader.status === "locked"
                      ? `Locked. Unlock: ${data.unlock}`
                      : leader.status
                  }
                  right={
                    <Group gap={4} wrap="nowrap">
                      {NEXT_LEADER_STATUS[leader.status].map((next) => (
                        <Button
                          key={next.status}
                          size="compact-xs"
                          variant="default"
                          onClick={() =>
                            dispatch({
                              type: "SET_LEADER",
                              leader: leader.id,
                              status: next.status,
                            })
                          }
                        >
                          {next.label}
                        </Button>
                      ))}
                    </Group>
                  }
                >
                  {data.window} {data.text}
                </CardText>
              );
            })}
          </Stack>
        </Section>
      )}

      {me.breakthrough && (
        <Section>
          <SectionTitle title="Breakthrough" />
          <CardText
            title={breakthroughsById[me.breakthrough.id]?.name ?? "Breakthrough"}
            subtitle={me.breakthrough.unlocked ? "Unlocked" : "Locked"}
            right={
              <Button
                size="compact-xs"
                variant="default"
                onClick={() =>
                  dispatch({
                    type: "SET_BREAKTHROUGH",
                    unlocked: !me.breakthrough!.unlocked,
                  })
                }
              >
                {me.breakthrough.unlocked ? "Lock" : "Unlock"}
              </Button>
            }
          >
            {breakthroughsById[me.breakthrough.id]?.text}
          </CardText>
        </Section>
      )}

      <Section>
        <SectionTitle title="Promissory notes" />
        <Stack gap="xs">
          {notes.map((note) => {
            const data = promissoryNotesById[note.id];
            const own = note.owner === player;
            return (
              <CardText
                key={`${note.id}-${note.owner}`}
                title={data.name}
                subtitle={own ? "Yours to give" : `From ${view.players[note.owner].name}`}
                right={
                  !own && (
                    <Button
                      size="compact-xs"
                      onClick={() =>
                        dispatch({
                          type: "PLAY_PROMISSORY_NOTE",
                          note: note.id,
                          owner: note.owner,
                        })
                      }
                    >
                      Play
                    </Button>
                  )
                }
              >
                {data.text.replace(/<color>/g, view.players[note.owner].name)}
              </CardText>
            );
          })}
          {me.promissoryNotesInPlay.map((note) => {
            const data = promissoryNotesById[note.id];
            return (
              <CardText
                key={`play-${note.id}-${note.owner}`}
                title={data.name}
                subtitle={`In play, from ${view.players[note.owner].name}`}
                right={
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() =>
                      dispatch({
                        type: "RETURN_PROMISSORY_NOTE",
                        note: note.id,
                        owner: note.owner,
                      })
                    }
                  >
                    Return
                  </Button>
                }
              >
                {data.text.replace(/<color>/g, view.players[note.owner].name)}
              </CardText>
            );
          })}
        </Stack>
      </Section>

      {(me.relics.length > 0 || me.relicFragments.length > 0) && (
        <Section>
          <SectionTitle title="Relics" />
          <Stack gap="xs">
            {me.relics.map((id) => (
              <CardText key={id} title={relicsById[id]?.name ?? id}>
                {relicsById[id]?.text}
              </CardText>
            ))}
            {me.relicFragments.length > 0 && (
              <Group gap={4} px="sm">
                {me.relicFragments.map((id, idx) => (
                  <Badge key={`${id}-${idx}`} variant="light">
                    {explorationsById[id]?.name ?? "Relic fragment"}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
