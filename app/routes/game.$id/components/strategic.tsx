import { Button, Checkbox, Group, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { objectivesById, strategyCardsById } from "~/game/data";
import {
  ObjectivePayment,
  Research,
  StrategicPayload,
  StructurePlacement,
} from "~/game/actions";
import { controlledPlanets, MECATOL_REX } from "~/game/engine/board";
import { totalTokens } from "~/game/engine/helpers";
import { objectiveStatus } from "~/game/engine/objectives";
import { strategyKind } from "~/game/engine/strategic";
import { describeSystem } from "~/game/engine/tactical";
import { CommandPools, Payment, Prompt } from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import {
  defaultPools,
  EMPTY_PRODUCTION,
  PoolsEditor,
  ProductionForm,
  ProductionValue,
  ResearchPicker,
  StructurePicker,
  tokensAfterGaining,
} from "./forms";
import { ObjectiveCost } from "./prompts";
import {
  CardText,
  EMPTY_PAYMENT,
  PaymentPicker,
  paymentTotal,
} from "./shared";

type FormProps = {
  view: GameView;
  player: PlayerId;
  card: string;
  secondary: boolean;
  onSubmit: (payload: StrategicPayload) => void;
};

const structuresOf = (...placements: (StructurePlacement | undefined)[]) =>
  placements.filter((p): p is StructurePlacement => !!p);

function Leadership({ view, player, secondary, onSubmit }: FormProps) {
  const [influence, setInfluence] = useState<Payment>(EMPTY_PAYMENT);
  const spent = paymentTotal(view, influence, "influence");
  const gained = (secondary ? 0 : 3) + Math.floor(spent / 3);
  const total = tokensAfterGaining(view, player, gained);
  const [pools, setPools] = useState<CommandPools>(() =>
    defaultPools(view, player, gained),
  );
  const placed = pools.tactic + pools.fleet + pools.strategy;

  return (
    <Stack gap="xs">
      <PaymentPicker
        view={view}
        player={player}
        currency="influence"
        value={influence}
        onChange={(payment) => {
          setInfluence(payment);
          // Start again from the current pools with the new total.
          const next = (secondary ? 0 : 3) +
            Math.floor(paymentTotal(view, payment, "influence") / 3);
          setPools(defaultPools(view, player, next));
        }}
      />
      <Text size="xs" c="dimmed">
        Gaining {total - totalTokens(view.players[player])} command tokens.
      </Text>
      <PoolsEditor total={total} value={pools} onChange={setPools} />
      <Button
        disabled={placed !== total || (secondary && gained === 0)}
        onClick={() => onSubmit({ card: "leadership", influence, pools })}
      >
        Confirm
      </Button>
    </Stack>
  );
}

function Diplomacy({ view, player, secondary, onSubmit }: FormProps) {
  const state = asState(view);
  const [system, setSystem] = useState<string | null>(null);
  const [ready, setReady] = useState<string[]>([]);
  const planets = controlledPlanets(state, player);
  const systems = [
    ...new Set(
      planets.filter((p) => p.name !== MECATOL_REX).map((p) => p.system),
    ),
  ].filter((key) => !view.systems[key].planets.includes(MECATOL_REX));
  // The chosen system's token keeps others out, so exhausted planets there
  // are the usual ones to ready.
  const exhausted = planets.filter((p) => p.exhausted);

  return (
    <Stack gap="xs">
      {!secondary && (
        <Select
          label="System to protect"
          placeholder="Choose a system"
          data={systems.map((key) => ({
            value: String(key),
            label: describeSystem(state, key),
          }))}
          value={system}
          onChange={setSystem}
        />
      )}
      <Text size="xs" c="dimmed">
        Ready up to 2 exhausted planets
      </Text>
      {exhausted.length === 0 && (
        <Text size="xs" c="dimmed">
          None of your planets are exhausted.
        </Text>
      )}
      {exhausted.map((planet) => (
        <Checkbox
          key={planet.name}
          size="xs"
          label={planet.name}
          checked={ready.includes(planet.name)}
          disabled={!ready.includes(planet.name) && ready.length >= 2}
          onChange={(event) =>
            setReady(
              event.currentTarget.checked
                ? [...ready, planet.name]
                : ready.filter((name) => name !== planet.name),
            )
          }
        />
      ))}
      <Button
        disabled={!secondary && system === null}
        onClick={() =>
          onSubmit({
            card: "diplomacy",
            system: system === null ? undefined : Number(system),
            ready,
          })
        }
      >
        Confirm
      </Button>
    </Stack>
  );
}

function Politics({ view, secondary, onSubmit }: FormProps) {
  const [speaker, setSpeaker] = useState<string | null>(null);
  if (secondary) {
    return (
      <Button onClick={() => onSubmit({ card: "politics" })}>
        Draw 2 action cards
      </Button>
    );
  }
  return (
    <Stack gap="xs">
      <Select
        label="New speaker"
        placeholder="Choose a player"
        data={view.seating
          .filter((id) => id !== view.speaker && !view.players[id].eliminated)
          .map((id) => ({ value: String(id), label: view.players[id].name }))}
        value={speaker}
        onChange={setSpeaker}
      />
      <Button
        disabled={speaker === null}
        onClick={() =>
          onSubmit({ card: "politics", speaker: Number(speaker) })
        }
      >
        Confirm
      </Button>
    </Stack>
  );
}

function Construction({ view, player, card, secondary, onSubmit }: FormProps) {
  const [first, setFirst] = useState<StructurePlacement>();
  const [second, setSecond] = useState<StructurePlacement>();
  const thundersEdge = strategyCardsById[card].source === "te";
  if (secondary) {
    return (
      <Stack gap="xs">
        <StructurePicker
          view={view}
          player={player}
          label="Structure"
          value={first}
          onChange={setFirst}
        />
        {!thundersEdge && (
          <Text size="xs" c="dimmed">
            Your command token is placed in the system you build in.
          </Text>
        )}
        <Button
          disabled={!first}
          onClick={() =>
            onSubmit({ card: "construction", structures: structuresOf(first) })
          }
        >
          Build
        </Button>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <StructurePicker
        view={view}
        player={player}
        label="First structure"
        value={first}
        onChange={setFirst}
      />
      <StructurePicker
        view={view}
        player={player}
        label="Second structure"
        types={thundersEdge ? ["spacedock", "pds"] : ["pds"]}
        value={second}
        onChange={setSecond}
      />
      <Button
        onClick={() =>
          onSubmit({
            card: "construction",
            structures: structuresOf(first, second),
          })
        }
      >
        Build
      </Button>
    </Stack>
  );
}

function Trade({ view, player, secondary, onSubmit }: FormProps) {
  const [allow, setAllow] = useState<PlayerId[]>([]);
  if (secondary) {
    return (
      <Button onClick={() => onSubmit({ card: "trade" })}>
        Replenish commodities
      </Button>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Gain 3 trade goods and replenish commodities. Choose who may replenish
        theirs without spending a command token.
      </Text>
      {view.seating
        .filter((id) => id !== player && !view.players[id].eliminated)
        .map((id) => (
          <Checkbox
            key={id}
            size="xs"
            label={view.players[id].name}
            checked={allow.includes(id)}
            onChange={(event) =>
              setAllow(
                event.currentTarget.checked
                  ? [...allow, id]
                  : allow.filter((other) => other !== id),
              )
            }
          />
        ))}
      <Button onClick={() => onSubmit({ card: "trade", allow })}>Confirm</Button>
    </Stack>
  );
}

function Warfare({ view, player, card, secondary, onSubmit }: FormProps) {
  const state = asState(view);
  const me = view.players[player];
  const thundersEdge = strategyCardsById[card].source === "te";
  const selected = useGame((s) => s.selectedSystem);
  const [removeFrom, setRemoveFrom] = useState<string | null>(null);
  const gained = removeFrom === null || thundersEdge ? 0 : 1;
  const [pools, setPools] = useState<CommandPools>(me.pools);
  const [production, setProduction] =
    useState<ProductionValue>(EMPTY_PRODUCTION);
  const total = totalTokens(me) + gained;
  const placed = pools.tactic + pools.fleet + pools.strategy;

  if (secondary) {
    return (
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          Produce in your home system
          {thundersEdge ? "." : " using one space dock."}
        </Text>
        <ProductionForm
          view={view}
          player={player}
          system={me.home}
          docksOnly={!thundersEdge}
          value={production}
          onChange={setProduction}
        />
        <Button
          disabled={production.units.length === 0}
          onClick={() => onSubmit({ card: "warfare", production })}
        >
          Produce
        </Button>
      </Stack>
    );
  }

  if (thundersEdge) {
    return (
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          Select a system on the board, then take a tactical action there
          without placing a command token.
        </Text>
        <PoolsEditor total={totalTokens(me)} value={pools} onChange={setPools} />
        <Button
          disabled={selected === undefined || placed !== totalTokens(me)}
          onClick={() =>
            onSubmit({ card: "warfare", removeFrom: selected, pools })
          }
        >
          {selected === undefined
            ? "Select a system"
            : `Activate ${describeSystem(state, selected)}`}
        </Button>
      </Stack>
    );
  }

  const tokens = Object.values(view.systems).filter((system) =>
    system.commandTokens.includes(player),
  );
  return (
    <Stack gap="xs">
      <Select
        label="Remove your command token from"
        placeholder="Nowhere"
        clearable
        data={tokens.map((system) => ({
          value: String(system.key),
          label: describeSystem(state, system.key),
        }))}
        value={removeFrom}
        onChange={(value) => {
          setRemoveFrom(value);
          setPools({
            ...me.pools,
            tactic: me.pools.tactic + (value === null ? 0 : 1),
          });
        }}
      />
      <PoolsEditor total={total} value={pools} onChange={setPools} />
      <Button
        disabled={placed !== total}
        onClick={() =>
          onSubmit({
            card: "warfare",
            removeFrom: removeFrom === null ? undefined : Number(removeFrom),
            pools,
          })
        }
      >
        Confirm
      </Button>
    </Stack>
  );
}

function Technology({ view, player, secondary, onSubmit }: FormProps) {
  const [research, setResearch] = useState<Research>();
  const [second, setSecond] = useState<Research>();
  const [payment, setPayment] = useState<Payment>(EMPTY_PAYMENT);
  const skips = [...(research?.skips ?? []), ...(second?.skips ?? [])];

  if (secondary) {
    return (
      <Stack gap="xs">
        <ResearchPicker
          view={view}
          player={player}
          value={research}
          onChange={setResearch}
        />
        <PaymentPicker
          view={view}
          player={player}
          currency="resources"
          cost={4}
          value={payment}
          exclude={skips}
          onChange={setPayment}
        />
        <Button
          disabled={!research}
          onClick={() => onSubmit({ card: "technology", research, payment })}
        >
          Research
        </Button>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <ResearchPicker
        view={view}
        player={player}
        value={research}
        onChange={setResearch}
      />
      <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
        Second technology for 6 resources
      </Text>
      <ResearchPicker
        view={view}
        player={player}
        value={second}
        exclude={research ? [research.technology] : []}
        onChange={setSecond}
      />
      {second && (
        <PaymentPicker
          view={view}
          player={player}
          currency="resources"
          cost={6}
          value={payment}
          exclude={skips}
          onChange={setPayment}
        />
      )}
      <Button
        onClick={() =>
          onSubmit({
            card: "technology",
            research,
            second: second ? { ...second, payment } : undefined,
          })
        }
      >
        {research || second ? "Research" : "Research nothing"}
      </Button>
    </Stack>
  );
}

function Imperial({ view, player, secondary, onSubmit }: FormProps) {
  const state = asState(view);
  const [objective, setObjective] = useState<string | null>(null);
  const [payment, setPayment] = useState<ObjectivePayment>({});
  if (secondary) {
    return (
      <Button onClick={() => onSubmit({ card: "imperial" })}>
        Draw a secret objective
      </Button>
    );
  }
  const holdsMecatol = view.planets[MECATOL_REX]?.controller === player;
  const options = view.publicObjectives
    .filter((o) => o.revealed && !o.scoredBy.includes(player))
    .map((o) => {
      const status = objectiveStatus(state, player, o.id);
      return {
        value: o.id,
        label: `${objectivesById[o.id].name}${
          status.met === true ? "" : status.met === false ? " (not met)" : ""
        }`,
      };
    });
  return (
    <Stack gap="xs">
      <Select
        label="Score a public objective"
        placeholder="None"
        clearable
        data={options}
        value={objective}
        onChange={(value) => {
          setObjective(value);
          setPayment({});
        }}
      />
      {objective && (
        <>
          <Text size="xs" c="dimmed">
            {objectivesById[objective].text}
          </Text>
          <ObjectiveCost
            view={view}
            player={player}
            objective={objective}
            value={payment}
            onChange={setPayment}
          />
        </>
      )}
      <Text size="xs" c="dimmed">
        {holdsMecatol
          ? "You control Mecatol Rex and will gain 1 victory point."
          : "You do not control Mecatol Rex and will draw a secret objective."}
      </Text>
      <Button
        onClick={() =>
          onSubmit({
            card: "imperial",
            objective: objective ?? undefined,
            payment,
          })
        }
      >
        Confirm
      </Button>
    </Stack>
  );
}

const FORMS = {
  leadership: Leadership,
  diplomacy: Diplomacy,
  politics: Politics,
  construction: Construction,
  trade: Trade,
  warfare: Warfare,
  technology: Technology,
  imperial: Imperial,
};

function StrategyCardText({ card, secondary }: { card: string; secondary: boolean }) {
  const data = strategyCardsById[card];
  return (
    <CardText
      title={`${data.initiative}. ${data.name}`}
      subtitle={secondary ? "Secondary ability" : "Primary ability"}
    >
      {(secondary ? data.secondary : data.primary).join("\n")}
    </CardText>
  );
}

/** The active player resolving the primary ability of one of their cards. */
export function StrategicActionForm({
  view,
  player,
  card,
  onCancel,
}: {
  view: GameView;
  player: PlayerId;
  card: string;
  onCancel: () => void;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const Form = FORMS[strategyKind(card)];
  return (
    <Stack gap="xs">
      <StrategyCardText card={card} secondary={false} />
      <Form
        view={view}
        player={player}
        card={card}
        secondary={false}
        onSubmit={(payload) => dispatch({ type: "STRATEGIC_ACTION", payload })}
      />
      <Button variant="subtle" color="gray" size="xs" onClick={onCancel}>
        Back
      </Button>
    </Stack>
  );
}

export function Secondary({
  view,
  prompt,
}: {
  view: GameView;
  prompt: Extract<Prompt, { kind: "secondary" }>;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const [using, setUsing] = useState(false);
  const Form = FORMS[strategyKind(prompt.card)];
  const me = view.players[prompt.player];
  const free = prompt.free || strategyKind(prompt.card) === "leadership";
  const decline = () =>
    dispatch(
      { type: "RESOLVE_SECONDARY", promptId: prompt.id },
      prompt.player,
    );

  return (
    <Stack gap="xs">
      <Text size="sm">
        {view.players[prompt.from].name} played{" "}
        {strategyCardsById[prompt.card].name}.
      </Text>
      <StrategyCardText card={prompt.card} secondary />
      {!using ? (
        <Group gap="xs">
          <Button
            disabled={!free && me.pools.strategy === 0}
            onClick={() => setUsing(true)}
          >
            Use it{free ? " (free)" : " (1 strategy token)"}
          </Button>
          <Button variant="default" onClick={decline}>
            Pass
          </Button>
        </Group>
      ) : (
        <>
          <Form
            view={view}
            player={prompt.player}
            card={prompt.card}
            secondary
            onSubmit={(payload) =>
              dispatch(
                { type: "RESOLVE_SECONDARY", promptId: prompt.id, payload },
                prompt.player,
              )
            }
          />
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={() => setUsing(false)}
          >
            Back
          </Button>
        </>
      )}
    </Stack>
  );
}
