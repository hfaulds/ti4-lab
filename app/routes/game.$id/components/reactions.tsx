import {
  Button,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import { Research } from "~/game/actions";
import {
  abilitiesById,
  actionCardsById,
  agendasById,
  promissoryNotesById,
  strategyCardsById,
  technologies,
  technologiesById,
  UNIT_NAMES,
  unitsById,
} from "~/game/data";
import { agendaOutcomes } from "~/game/engine/agenda";
import { TargetKind } from "~/game/engine/effects/types";
import { effectFor, reactionAction, reactionName } from "~/game/engine/reactions";
import { describeSystem } from "~/game/engine/tactical";
import {
  EffectTargets,
  Prompt,
  Reaction,
  UnitCounts,
  UnitType,
} from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import { PoolsEditor, ResearchPicker, tokensAfterGaining } from "./forms";
import { CardText, EMPTY_PAYMENT, PaymentPicker } from "./shared";

/** What a card or ability says, for showing next to its button. */
export function reactionText(view: GameView, reaction: Reaction) {
  switch (reaction.kind) {
    case "actionCard":
      return actionCardsById[reaction.id]?.text ?? "";
    case "promissoryNote":
      return (promissoryNotesById[reaction.id]?.text ?? "").replace(
        /<color>/g,
        view.players[reaction.owner]?.name ?? "",
      );
    case "ability":
      return (
        abilitiesById[reaction.id]?.text ??
        technologiesById[reaction.id]?.text ??
        unitsById[reaction.id]?.ability ??
        agendasById[reaction.id]?.text1 ??
        ""
      );
  }
}

const UNIT_TYPES = Object.keys(UNIT_NAMES) as UnitType[];

/** Reads "dreadnought:1, cruiser:2" as unit counts. */
function parseUnits(text: string): UnitCounts {
  const counts: UnitCounts = {};
  for (const part of text.split(",")) {
    const [type, count] = part.split(":").map((s) => s.trim());
    if (UNIT_TYPES.includes(type as UnitType)) counts[type as UnitType] = Number(count) || 1;
  }
  return counts;
}

/** Reads "infantry:2@Jord, cruiser:1" as production orders. */
function parseProduction(text: string): EffectTargets["production"] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [unit, planet] = part.split("@").map((s) => s.trim());
      const [type, count] = unit.split(":").map((s) => s.trim());
      return { type: type as UnitType, count: Number(count) || 1, planet: planet || undefined };
    })
    .filter((order) => UNIT_TYPES.includes(order.type));
}

/** One input for each choice a card or ability needs. */
function TargetFields({
  view,
  player,
  kinds,
  reaction,
  value,
  onChange,
}: {
  view: GameView;
  player: PlayerId;
  kinds: TargetKind[];
  reaction: Reaction;
  value: EffectTargets;
  onChange: (value: EffectTargets) => void;
}) {
  const state = asState(view);
  const set = (patch: EffectTargets) => onChange({ ...value, ...patch });
  const planets = Object.keys(view.planets).sort();
  const systems = Object.values(view.systems)
    .filter((s) => s.onBoard)
    .map((s) => ({ value: String(s.key), label: describeSystem(state, s.key) }));
  const players = view.seating.map((id) => ({
    value: String(id),
    label: view.players[id].name,
  }));
  const fields = kinds.map((kind) => {
    switch (kind) {
      case "player":
        return (
          <Select
            key={kind}
            size="xs"
            label="Player"
            data={players}
            value={value.player !== undefined ? String(value.player) : null}
            onChange={(v) => set({ player: v === null ? undefined : Number(v) })}
          />
        );
      case "planet":
        return (
          <Select
            key={kind}
            size="xs"
            label="Planet"
            searchable
            data={planets}
            value={value.planet ?? null}
            onChange={(v) => set({ planet: v ?? undefined })}
          />
        );
      case "planets":
        return (
          <MultiSelect
            key={kind}
            size="xs"
            label="Planets"
            searchable
            data={planets}
            value={value.planets ?? []}
            onChange={(v) => set({ planets: v })}
          />
        );
      case "system":
        return (
          <Select
            key={kind}
            size="xs"
            label="System"
            searchable
            data={systems}
            value={value.system !== undefined ? String(value.system) : null}
            onChange={(v) => set({ system: v === null ? undefined : Number(v) })}
          />
        );
      case "unit":
        return (
          <Select
            key={kind}
            size="xs"
            label="Unit"
            data={UNIT_TYPES.map((t) => ({ value: t, label: UNIT_NAMES[t] }))}
            value={value.unit ?? null}
            onChange={(v) => set({ unit: (v ?? undefined) as UnitType | undefined })}
          />
        );
      case "units":
        return (
          <TextInput
            key={kind}
            size="xs"
            label="Units"
            placeholder="dreadnought:1, cruiser:1"
            onChange={(e) => set({ units: parseUnits(e.currentTarget.value) })}
          />
        );
      case "technology":
        return (
          <Select
            key={kind}
            size="xs"
            label="Technology"
            searchable
            data={technologies
              .filter((t) => t.source === "base" || view.options.expansions.includes(t.source as never))
              .map((t) => ({ value: t.id, label: t.name }))}
            value={value.technology ?? null}
            onChange={(v) => set({ technology: v ?? undefined })}
          />
        );
      case "card":
        return (
          <Select
            key={kind}
            size="xs"
            label="Card"
            searchable
            data={[
              ...view.players[player].actionCards.map((id) => ({
                value: id,
                label: actionCardsById[id]?.name ?? id,
              })),
              ...view.players[player].strategyCards.map((c) => ({
                value: c.id,
                label: strategyCardsById[c.id]?.name ?? c.id,
              })),
            ]}
            value={value.card ?? null}
            onChange={(v) => set({ card: v ?? undefined })}
          />
        );
      case "choice":
        return (
          <TextInput
            key={kind}
            size="xs"
            label="Choice"
            placeholder={choiceHint(reaction)}
            value={value.choice ?? ""}
            onChange={(e) => set({ choice: e.currentTarget.value || undefined })}
          />
        );
      case "outcome":
        return (
          <Select
            key={kind}
            size="xs"
            label="Predicted outcome"
            searchable
            data={view.agenda?.card ? agendaOutcomes(state, view.agenda.card) : []}
            value={value.outcome ?? null}
            onChange={(v) => set({ outcome: v ?? undefined })}
          />
        );
      case "amount":
        return (
          <NumberInput
            key={kind}
            size="xs"
            label="Amount"
            min={0}
            value={value.amount ?? 0}
            onChange={(v) => set({ amount: Number(v) || 0 })}
          />
        );
      case "payment":
        return (
          <PaymentPicker
            key={kind}
            view={view}
            player={player}
            currency={reaction.id === "indoctrination" ? "influence" : "resources"}
            value={value.payment ?? EMPTY_PAYMENT}
            onChange={(payment) => set({ payment })}
          />
        );
      case "pools":
        return (
          <PoolsEditor
            key={kind}
            total={tokensAfterGaining(view, player, 2)}
            value={value.pools ?? view.players[player].pools}
            onChange={(pools) => set({ pools })}
          />
        );
      case "production":
        return (
          <TextInput
            key={kind}
            size="xs"
            label="Units to produce"
            placeholder="infantry:2@Jord, cruiser:1"
            onChange={(e) => set({ production: parseProduction(e.currentTarget.value) })}
          />
        );
      case "transfers":
        return (
          <TextInput
            key={kind}
            size="xs"
            label="Moves (JSON)"
            placeholder='[{"from":{"system":3,"planet":"Jord"},"to":"Moll Primus","unit":"infantry","count":1}]'
            onChange={(e) => {
              try {
                set({ transfers: JSON.parse(e.currentTarget.value) });
              } catch {
                set({ transfers: [] });
              }
            }}
          />
        );
    }
  });
  return <>{fields}</>;
}

const choiceHint = (reaction: Reaction) => {
  switch (reaction.id) {
    case "star_forge":
      return "fighters or destroyer";
    case "pillage":
      return "tradeGood or commodity";
    case "wg":
    case "iff":
      return "alpha or beta";
    default:
      return "strategy card id to take";
  }
};

/**
 * A card or ability with the choices it needs and a button to use it, in a
 * window (`promptId`) or as a component action.
 */
export function ReactionForm({
  view,
  player,
  reaction,
  promptId,
  label = "Use",
}: {
  view: GameView;
  player: PlayerId;
  reaction: Reaction;
  promptId?: number;
  label?: string;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<EffectTargets>({});
  const kinds = effectFor(reaction)?.targets ?? [];
  const use = () => dispatch(reactionAction(reaction, targets, promptId), player);

  return (
    <CardText
      title={reactionName(reaction)}
      right={
        kinds.length === 0 || open ? (
          <Button size="compact-xs" onClick={use}>
            {label}
          </Button>
        ) : (
          <Button size="compact-xs" variant="default" onClick={() => setOpen(true)}>
            {label}…
          </Button>
        )
      }
    >
      <Stack gap={6}>
        <Text size="xs">{reactionText(view, reaction)}</Text>
        {open && (
          <TargetFields
            view={view}
            player={player}
            kinds={kinds}
            reaction={reaction}
            value={targets}
            onChange={setTargets}
          />
        )}
      </Stack>
    </CardText>
  );
}

const WINDOW_NAMES: Partial<Record<string, string>> = {
  actionCardPlayed: "An action card was played",
  turnStart: "Start of a turn",
  afterActivate: "A system was activated",
  afterMove: "Ships moved",
  beforeSpaceCannonHits: "Before assigning space cannon hits",
  combatStart: "Start of combat",
  roundStart: "Start of a combat round",
  afterRolls: "After combat rolls",
  beforeCombatHits: "Before assigning hits",
  afterSustain: "A ship sustained damage",
  afterShipDestroyed: "A ship was destroyed",
  afterUnitDestroyed: "A unit was destroyed",
  roundEnd: "End of a combat round",
  afterRetreat: "A retreat was announced",
  afterCombat: "After combat",
  invasionStart: "Start of an invasion",
  afterCommit: "Ground forces committed",
  groundCombatStart: "Start of ground combat",
  afterGainControl: "A planet changed hands",
  afterProduce: "Units were produced",
  afterAction: "After your action",
  agendaRevealed: "An agenda was revealed",
  afterAgendaRevealed: "Before voting",
  afterSpeakerVotes: "The speaker has voted",
  afterVote: "After your vote",
  whenElected: "You were elected",
};

export function WindowPrompt({
  view,
  prompt,
}: {
  view: GameView;
  prompt: Extract<Prompt, { kind: "window" }>;
}) {
  const dispatch = useGame((state) => state.dispatch);
  return (
    <Stack gap="xs">
      <Text size="sm">
        {WINDOW_NAMES[prompt.window] ?? prompt.window}: you may use any of
        these, or carry on.
      </Text>
      {prompt.options.map((reaction) => (
        <ReactionForm
          key={JSON.stringify(reaction)}
          view={view}
          player={prompt.player}
          reaction={reaction}
          promptId={prompt.id}
        />
      ))}
      <Button
        variant="default"
        onClick={() => dispatch({ type: "PASS_WINDOW", promptId: prompt.id }, prompt.player)}
      >
        Carry on
      </Button>
    </Stack>
  );
}

export function ResearchPrompt({
  view,
  prompt,
}: {
  view: GameView;
  prompt: Extract<Prompt, { kind: "research" }>;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const [choices, setChoices] = useState<(Research | undefined)[]>([]);
  const picked = choices.filter((c): c is Research => !!c);
  return (
    <Stack gap="xs">
      <Text size="sm">Research up to {prompt.count} technologies for free.</Text>
      {Array.from({ length: prompt.count }, (_, i) => (
        <ResearchPicker
          key={i}
          view={view}
          player={prompt.player}
          value={choices[i]}
          exclude={picked.filter((_, j) => j !== i).map((c) => c.technology)}
          onChange={(value) => {
            const next = [...choices];
            next[i] = value;
            setChoices(next);
          }}
        />
      ))}
      <Button
        onClick={() =>
          dispatch(
            { type: "RESEARCH", promptId: prompt.id, research: picked },
            prompt.player,
          )
        }
      >
        {picked.length > 0 ? "Research" : "Research nothing"}
      </Button>
    </Stack>
  );
}
