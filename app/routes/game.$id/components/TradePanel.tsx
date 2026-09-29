import {
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { useState } from "react";
import { Section, SectionTitle } from "~/components/Section";
import { explorationsById, promissoryNotesById } from "~/game/data";
import { areNeighbors } from "~/game/engine/board";
import { Transaction, TransactionSide } from "~/game/types";
import { asState, GameView, isHidden, PlayerView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import { CardText, PlayerName } from "./shared";

function describeSide(view: GameView, side: TransactionSide) {
  const parts = [
    side.tradeGoods ? `${side.tradeGoods} trade goods` : "",
    side.commodities ? `${side.commodities} commodities` : "",
    ...(side.promissoryNotes ?? []).map(
      (note) =>
        `${promissoryNotesById[note.id]?.name ?? "a promissory note"} (${view.players[note.owner].name})`,
    ),
    side.relicFragments?.length
      ? `${side.relicFragments.length} relic fragments`
      : "",
    side.actionCards?.length ? `${side.actionCards.length} action cards` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

function Offer({
  view,
  offer,
  player,
}: {
  view: GameView;
  offer: Transaction;
  player?: PlayerId;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const answer = (accept: boolean) =>
    dispatch({ type: "ANSWER_TRANSACTION", transaction: offer.id, accept });
  return (
    <CardText
      title={`${view.players[offer.from].name} to ${view.players[offer.to].name}`}
      right={
        <Group gap={4} wrap="nowrap">
          {offer.to === player && (
            <Button size="compact-xs" onClick={() => answer(true)}>
              Accept
            </Button>
          )}
          {(offer.to === player || offer.from === player) && (
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => answer(false)}
            >
              {offer.from === player ? "Withdraw" : "Decline"}
            </Button>
          )}
        </Group>
      }
    >
      Gives {describeSide(view, offer.give)} for{" "}
      {describeSide(view, offer.receive)}.
    </CardText>
  );
}

/** One side of an offer. Only open information about `owner` is offered. */
function SideEditor({
  view,
  owner,
  own,
  value,
  onChange,
}: {
  view: GameView;
  owner: PlayerView;
  own: boolean;
  value: TransactionSide;
  onChange: (value: TransactionSide) => void;
}) {
  const notes = owner.promissoryNotes.filter((note) => !isHidden(note.id));
  return (
    <Stack gap={6}>
      <PlayerName view={view} player={owner.id} />
      <NumberInput
        size="xs"
        label={`Trade goods (${owner.tradeGoods})`}
        min={0}
        max={owner.tradeGoods}
        value={value.tradeGoods ?? 0}
        onChange={(amount) =>
          onChange({ ...value, tradeGoods: Number(amount) || 0 })
        }
      />
      <NumberInput
        size="xs"
        label={`Commodities (${owner.commodities})`}
        min={0}
        max={owner.commodities}
        value={value.commodities ?? 0}
        onChange={(amount) =>
          onChange({ ...value, commodities: Number(amount) || 0 })
        }
      />
      {own && notes.length > 0 && (
        <Select
          size="xs"
          label="Promissory note"
          clearable
          placeholder="None"
          data={notes.map((note) => ({
            value: `${note.id}|${note.owner}`,
            label: `${promissoryNotesById[note.id].name} (${view.players[note.owner].name})`,
          }))}
          value={
            value.promissoryNotes?.[0]
              ? `${value.promissoryNotes[0].id}|${value.promissoryNotes[0].owner}`
              : null
          }
          onChange={(selected) => {
            if (!selected) return onChange({ ...value, promissoryNotes: [] });
            const [id, noteOwner] = selected.split("|");
            onChange({
              ...value,
              promissoryNotes: [{ id, owner: Number(noteOwner) }],
            });
          }}
        />
      )}
      {owner.relicFragments.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" fw={500}>
            Relic fragments
          </Text>
          {owner.relicFragments.map((fragment, idx) => (
            <Checkbox
              key={`${fragment}-${idx}`}
              size="xs"
              label={explorationsById[fragment]?.name ?? "Relic fragment"}
              checked={(value.relicFragments ?? []).includes(fragment)}
              onChange={(event) =>
                onChange({
                  ...value,
                  relicFragments: event.currentTarget.checked
                    ? [...(value.relicFragments ?? []), fragment]
                    : (value.relicFragments ?? []).filter((f) => f !== fragment),
                })
              }
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function TradePanel({
  view,
  player,
}: {
  view: GameView;
  player?: PlayerId;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const [partner, setPartner] = useState<string | null>(null);
  const [give, setGive] = useState<TransactionSide>({});
  const [receive, setReceive] = useState<TransactionSide>({});

  const others = view.seating.filter(
    (id) => id !== player && !view.players[id].eliminated,
  );
  const partnerId = partner === null ? undefined : Number(partner);
  const neighbors =
    player !== undefined && partnerId !== undefined
      ? areNeighbors(asState(view), player, partnerId)
      : true;

  return (
    <Stack gap="md">
      <Section>
        <SectionTitle title="Open offers" />
        <Stack gap="xs">
          {view.transactions.length === 0 && (
            <Text size="sm" c="dimmed" px="sm">
              No offers are waiting.
            </Text>
          )}
          {view.transactions.map((offer) => (
            <Offer key={offer.id} view={view} offer={offer} player={player} />
          ))}
        </Stack>
      </Section>

      {player !== undefined && (
        <Section>
          <SectionTitle title="Make an offer" />
          <Stack gap="sm" px="sm">
            <Select
              label="Trade with"
              placeholder="Choose a player"
              data={others.map((id) => ({
                value: String(id),
                label: view.players[id].name,
              }))}
              value={partner}
              onChange={(value) => {
                setPartner(value);
                setGive({});
                setReceive({});
              }}
            />
            {partnerId !== undefined && (
              <>
                {view.phase === "action" && !neighbors && (
                  <Text size="xs" c="orange">
                    You are not neighbors, so you cannot trade during the
                    action phase.
                  </Text>
                )}
                <SimpleGrid cols={2}>
                  <SideEditor
                    view={view}
                    owner={view.players[player]}
                    own
                    value={give}
                    onChange={setGive}
                  />
                  <SideEditor
                    view={view}
                    owner={view.players[partnerId]}
                    own={false}
                    value={receive}
                    onChange={setReceive}
                  />
                </SimpleGrid>
                <Button
                  onClick={async () => {
                    const sent = await dispatch({
                      type: "PROPOSE_TRANSACTION",
                      to: partnerId,
                      give,
                      receive,
                    });
                    if (sent) {
                      setGive({});
                      setReceive({});
                    }
                  }}
                >
                  Send offer
                </Button>
              </>
            )}
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
