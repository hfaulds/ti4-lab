import {
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useState } from "react";
import {
  actionCardsById,
  agendasById,
  objectivesById,
  technologiesById,
  UNIT_NAMES,
} from "~/game/data";
import { HitAssignment, ObjectivePayment } from "~/game/actions";
import {
  controlledPlanets,
  planetInfluence,
} from "~/game/engine/board";
import { hitTargets, suggestAssignment } from "~/game/engine/combat";
import { countOf, unitOf } from "~/game/engine/helpers";
import {
  objectiveStatus,
  scorableObjectives,
} from "~/game/engine/objectives";
import { agendaOutcomes, tallyVotes } from "~/game/engine/phases";
import { describeSystem } from "~/game/engine/tactical";
import { Payment, Prompt, UnitType } from "~/game/types";
import { asState, GameView, isHidden } from "~/game/view";
import { useGame } from "../gameStore";
import { defaultPools, PoolsEditor, tokensAfterGaining } from "./forms";
import {
  CardText,
  EMPTY_PAYMENT,
  PaymentPicker,
  PlayerName,
  sortedUnitTypes,
  Stepper,
} from "./shared";

type PromptProps<K extends Prompt["kind"]> = {
  view: GameView;
  prompt: Extract<Prompt, { kind: K }>;
};

const HIT_SOURCES: Record<string, string> = {
  spaceCannonOffense: "space cannon fire",
  antiFighterBarrage: "anti-fighter barrage",
  spaceCombat: "space combat",
  bombardment: "bombardment",
  spaceCannonDefense: "space cannon fire",
  groundCombat: "ground combat",
};

export function ChooseSecret({ prompt }: PromptProps<"chooseSecret">) {
  const dispatch = useGame((state) => state.dispatch);
  return (
    <Stack gap="xs">
      <Text size="sm">Keep one of these secret objectives.</Text>
      {prompt.options
        .filter((id) => !isHidden(id))
        .map((id) => (
          <CardText
            key={id}
            title={objectivesById[id].name}
            subtitle={`Scored in the ${objectivesById[id].phase} phase`}
            right={
              <Button
                size="compact-sm"
                onClick={() =>
                  dispatch({ type: "CHOOSE_SECRET", keep: id }, prompt.player)
                }
              >
                Keep
              </Button>
            }
          >
            {objectivesById[id].text}
          </CardText>
        ))}
    </Stack>
  );
}

export function ChooseStartingTech({
  prompt,
}: PromptProps<"chooseStartingTech">) {
  const dispatch = useGame((state) => state.dispatch);
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <Stack gap="xs">
      <Text size="sm">
        Choose {prompt.count} starting{" "}
        {prompt.count === 1 ? "technology" : "technologies"}.
      </Text>
      {prompt.options.map((id) => (
        <Checkbox
          key={id}
          label={technologiesById[id].name}
          description={technologiesById[id].text}
          checked={chosen.includes(id)}
          disabled={!chosen.includes(id) && chosen.length >= prompt.count}
          onChange={(event) =>
            setChosen(
              event.currentTarget.checked
                ? [...chosen, id]
                : chosen.filter((tech) => tech !== id),
            )
          }
        />
      ))}
      <Button
        disabled={chosen.length !== prompt.count}
        onClick={() =>
          dispatch(
            { type: "CHOOSE_STARTING_TECH", technologies: chosen },
            prompt.player,
          )
        }
      >
        Confirm
      </Button>
    </Stack>
  );
}

export function SpaceCannon({ view, prompt }: PromptProps<"spaceCannon">) {
  const dispatch = useGame((state) => state.dispatch);
  const answer = (fire: boolean) =>
    dispatch(
      { type: "FIRE_SPACE_CANNON", promptId: prompt.id, fire },
      prompt.player,
    );
  return (
    <Stack gap="xs">
      <Text size="sm">
        Your space cannons can fire on{" "}
        <PlayerName view={view} player={prompt.target} />
        {prompt.planet
          ? `'s ground forces landing on ${prompt.planet}.`
          : `'s ships in ${describeSystem(asState(view), prompt.system)}.`}
      </Text>
      <Group gap="xs">
        <Button onClick={() => answer(true)}>Fire</Button>
        <Button variant="default" onClick={() => answer(false)}>
          Hold fire
        </Button>
      </Group>
    </Stack>
  );
}

export function AssignHits({ view, prompt }: PromptProps<"assignHits">) {
  const dispatch = useGame((state) => state.dispatch);
  const state = asState(view);
  const [assignment, setAssignment] = useState<HitAssignment>(() =>
    suggestAssignment(state, prompt),
  );
  const { forces, eligible } = hitTargets(state, prompt);
  const group = forces[prompt.player];
  const types = sortedUnitTypes(group).filter(eligible);
  const sustained = (type: UnitType) =>
    assignment.sustain.filter((t) => t === type).length;
  const assigned =
    assignment.sustain.length +
    Object.values(assignment.destroy).reduce((sum, n) => sum + (n ?? 0), 0);
  const allowSustain = prompt.source !== "antiFighterBarrage";

  const setSustained = (type: UnitType, count: number) =>
    setAssignment({
      ...assignment,
      sustain: [
        ...assignment.sustain.filter((t) => t !== type),
        ...Array<UnitType>(count).fill(type),
      ],
    });

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="sm">
          Assign {prompt.hits} {prompt.hits === 1 ? "hit" : "hits"} from{" "}
          {HIT_SOURCES[prompt.source]}
          {prompt.planet
            ? ` on ${prompt.planet}`
            : ` in ${describeSystem(state, prompt.system)}`}
          .
        </Text>
        <Badge
          variant="light"
          color={assigned === prompt.hits ? "green" : "orange"}
        >
          {assigned} / {prompt.hits}
        </Badge>
      </Group>
      {types.map((type) => {
        const stack = group[type]!;
        const canSustain =
          allowSustain &&
          stack.count - stack.damaged > 0 &&
          !!unitOf(state, prompt.player, type)?.sustainDamage;
        return (
          <Stack key={type} gap={2}>
            {canSustain && (
              <Stepper
                label={`${UNIT_NAMES[type]}: sustain damage`}
                value={sustained(type)}
                max={stack.count - stack.damaged}
                onChange={(count) => setSustained(type, count)}
              />
            )}
            <Stepper
              label={`${UNIT_NAMES[type]}: destroy (${stack.count})`}
              value={assignment.destroy[type] ?? 0}
              max={countOf(group, type)}
              onChange={(count) =>
                setAssignment({
                  ...assignment,
                  destroy: { ...assignment.destroy, [type]: count },
                })
              }
            />
          </Stack>
        );
      })}
      <Group gap="xs">
        <Button
          onClick={() =>
            dispatch(
              { type: "ASSIGN_HITS", promptId: prompt.id, assignment },
              prompt.player,
            )
          }
        >
          Confirm losses
        </Button>
        <Button
          variant="default"
          onClick={() => setAssignment(suggestAssignment(state, prompt))}
        >
          Suggest
        </Button>
      </Group>
    </Stack>
  );
}

export function AnnounceRetreat({
  view,
  prompt,
}: PromptProps<"announceRetreat">) {
  const dispatch = useGame((state) => state.dispatch);
  const state = asState(view);
  const [to, setTo] = useState<string | null>(null);
  return (
    <Stack gap="xs">
      <Text size="sm">
        You may announce a retreat from{" "}
        {describeSystem(state, prompt.system)}. Your ships leave after this
        round of combat.
      </Text>
      <Select
        placeholder="Retreat to"
        data={prompt.options.map((key) => ({
          value: String(key),
          label: describeSystem(state, key),
        }))}
        value={to}
        onChange={setTo}
      />
      <Group gap="xs">
        <Button
          disabled={to === null}
          onClick={() =>
            dispatch({ type: "ANNOUNCE_RETREAT", to: Number(to) }, prompt.player)
          }
        >
          Announce retreat
        </Button>
        <Button
          variant="default"
          onClick={() => dispatch({ type: "ANNOUNCE_RETREAT" }, prompt.player)}
        >
          Stay and fight
        </Button>
      </Group>
    </Stack>
  );
}

// --- Objectives -------------------------------------------------------------

export function ObjectiveCost({
  view,
  player,
  objective,
  value,
  onChange,
}: {
  view: GameView;
  player: number;
  objective: string;
  value: ObjectivePayment;
  onChange: (value: ObjectivePayment) => void;
}) {
  const cost = objectiveStatus(asState(view), player, objective).cost;
  const me = view.players[player];
  if (!cost) return null;
  const resources = value.resources ?? EMPTY_PAYMENT;
  const influence = value.influence ?? EMPTY_PAYMENT;
  const tokens = value.tokens ?? { tactic: 0, strategy: 0 };
  return (
    <Stack gap="xs">
      {cost.resources !== undefined && (
        <PaymentPicker
          view={view}
          player={player}
          currency="resources"
          cost={cost.resources}
          value={resources}
          exclude={influence.planets}
          onChange={(payment: Payment) =>
            onChange({ ...value, resources: payment })
          }
        />
      )}
      {cost.influence !== undefined && (
        <PaymentPicker
          view={view}
          player={player}
          currency="influence"
          cost={cost.influence}
          value={influence}
          exclude={resources.planets}
          onChange={(payment: Payment) =>
            onChange({ ...value, influence: payment })
          }
        />
      )}
      {cost.tradeGoods !== undefined && (
        <Checkbox
          label={`Spend ${cost.tradeGoods} trade goods (you have ${me.tradeGoods})`}
          checked={value.tradeGoods === cost.tradeGoods}
          onChange={(event) =>
            onChange({
              ...value,
              tradeGoods: event.currentTarget.checked ? cost.tradeGoods : 0,
            })
          }
        />
      )}
      {cost.tokens !== undefined && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Spend {cost.tokens} command tokens
          </Text>
          <Stepper
            label={`From tactic (${me.pools.tactic})`}
            value={tokens.tactic}
            max={Math.min(me.pools.tactic, cost.tokens - tokens.strategy)}
            onChange={(tactic) =>
              onChange({ ...value, tokens: { ...tokens, tactic } })
            }
          />
          <Stepper
            label={`From strategy (${me.pools.strategy})`}
            value={tokens.strategy}
            max={Math.min(me.pools.strategy, cost.tokens - tokens.tactic)}
            onChange={(strategy) =>
              onChange({ ...value, tokens: { ...tokens, strategy } })
            }
          />
        </Stack>
      )}
      {cost.actionCards !== undefined && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Discard {cost.actionCards} action cards
          </Text>
          {me.actionCards
            .filter((id) => !isHidden(id))
            .map((id, idx) => (
              <Checkbox
                key={`${id}-${idx}`}
                size="xs"
                label={actionCardsById[id].name}
                checked={(value.actionCards ?? []).includes(id)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    actionCards: event.currentTarget.checked
                      ? [...(value.actionCards ?? []), id]
                      : (value.actionCards ?? []).filter((c) => c !== id),
                  })
                }
              />
            ))}
        </Stack>
      )}
      {cost.relicFragments !== undefined && (
        <Checkbox
          label={`Purge ${cost.relicFragments} relic fragments (you have ${me.relicFragments.length})`}
          checked={(value.relicFragments ?? []).length === cost.relicFragments}
          onChange={(event) =>
            onChange({
              ...value,
              relicFragments: event.currentTarget.checked
                ? me.relicFragments.slice(0, cost.relicFragments)
                : [],
            })
          }
        />
      )}
    </Stack>
  );
}

export function ScoreObjectives({
  view,
  prompt,
}: PromptProps<"scoreObjectives">) {
  const dispatch = useGame((state) => state.dispatch);
  const state = asState(view);
  const me = view.players[prompt.player];
  const [publicObjective, setPublic] = useState<string | null>(null);
  const [secretObjective, setSecret] = useState<string | null>(null);
  const [payment, setPayment] = useState<ObjectivePayment>({});

  const candidates = scorableObjectives(state, prompt.player, "status").filter(
    (id) => !isHidden(id),
  );
  const option = (id: string) => {
    const status = objectiveStatus(state, prompt.player, id);
    const note =
      status.met === "manual"
        ? "you judge"
        : status.met
          ? status.cost
            ? "can pay"
            : "met"
          : status.cost
            ? "cannot pay"
            : "not met";
    return { value: id, label: `${objectivesById[id].name} (${note})` };
  };
  const publics = candidates.filter((id) => !me.secretObjectives.includes(id));
  const secrets = candidates.filter((id) => me.secretObjectives.includes(id));
  const paid = publicObjective ?? secretObjective;

  return (
    <Stack gap="xs">
      <Text size="sm">
        Score up to one public and one secret objective.
      </Text>
      <Select
        label="Public objective"
        placeholder="None"
        clearable
        data={publics.map(option)}
        value={publicObjective}
        onChange={(value) => {
          setPublic(value);
          setPayment({});
        }}
      />
      {publicObjective && (
        <Text size="xs" c="dimmed">
          {objectivesById[publicObjective].text}
        </Text>
      )}
      <Select
        label="Secret objective"
        placeholder="None"
        clearable
        data={secrets.map(option)}
        value={secretObjective}
        onChange={(value) => {
          setSecret(value);
          setPayment({});
        }}
      />
      {secretObjective && (
        <Text size="xs" c="dimmed">
          {objectivesById[secretObjective].text}
        </Text>
      )}
      {paid && (
        <ObjectiveCost
          view={view}
          player={prompt.player}
          objective={paid}
          value={payment}
          onChange={setPayment}
        />
      )}
      <Button
        onClick={() =>
          dispatch(
            {
              type: "SCORE_OBJECTIVES",
              publicObjective: publicObjective ?? undefined,
              secretObjective: secretObjective ?? undefined,
              payment,
            },
            prompt.player,
          )
        }
      >
        {publicObjective || secretObjective ? "Score" : "Score nothing"}
      </Button>
    </Stack>
  );
}

export function Redistribute({ view, prompt }: PromptProps<"redistribute">) {
  const dispatch = useGame((state) => state.dispatch);
  const total = tokensAfterGaining(view, prompt.player, prompt.gained);
  const [pools, setPools] = useState(() =>
    defaultPools(view, prompt.player, prompt.gained),
  );
  const placed = pools.tactic + pools.fleet + pools.strategy;
  return (
    <Stack gap="xs">
      <Text size="sm">
        Gain {prompt.gained} command tokens and redistribute your pools.
      </Text>
      <PoolsEditor total={total} value={pools} onChange={setPools} />
      <Button
        disabled={placed !== total}
        onClick={() => dispatch({ type: "REDISTRIBUTE", pools }, prompt.player)}
      >
        Confirm
      </Button>
    </Stack>
  );
}

export function DiscardActionCards({
  view,
  prompt,
}: PromptProps<"discardActionCards">) {
  const dispatch = useGame((state) => state.dispatch);
  const [chosen, setChosen] = useState<number[]>([]);
  const cards = view.players[prompt.player].actionCards;
  return (
    <Stack gap="xs">
      <Text size="sm">
        You are over the hand limit. Discard {prompt.count} action{" "}
        {prompt.count === 1 ? "card" : "cards"}.
      </Text>
      {cards.map((id, idx) =>
        isHidden(id) ? null : (
          <Checkbox
            key={idx}
            label={actionCardsById[id].name}
            description={actionCardsById[id].text}
            checked={chosen.includes(idx)}
            disabled={!chosen.includes(idx) && chosen.length >= prompt.count}
            onChange={(event) =>
              setChosen(
                event.currentTarget.checked
                  ? [...chosen, idx]
                  : chosen.filter((i) => i !== idx),
              )
            }
          />
        ),
      )}
      <Button
        disabled={chosen.length !== prompt.count}
        onClick={() =>
          dispatch(
            {
              type: "DISCARD_ACTION_CARDS",
              cards: chosen.map((idx) => cards[idx]),
            },
            prompt.player,
          )
        }
      >
        Discard
      </Button>
    </Stack>
  );
}

export function ReturnSecret({ view, prompt }: PromptProps<"returnSecret">) {
  const dispatch = useGame((state) => state.dispatch);
  return (
    <Stack gap="xs">
      <Text size="sm">
        You hold more than 3 secret objectives. Return one to the deck.
      </Text>
      {view.players[prompt.player].secretObjectives
        .filter((id) => !isHidden(id))
        .map((id) => (
          <CardText
            key={id}
            title={objectivesById[id].name}
            right={
              <Button
                size="compact-sm"
                variant="default"
                onClick={() =>
                  dispatch(
                    { type: "RETURN_SECRET", objective: id },
                    prompt.player,
                  )
                }
              >
                Return
              </Button>
            }
          >
            {objectivesById[id].text}
          </CardText>
        ))}
    </Stack>
  );
}

// --- Agenda phase -----------------------------------------------------------

export function AgendaCard({ view }: { view: GameView }) {
  const card = view.agenda?.card;
  if (!card) return null;
  const agenda = agendasById[card];
  const totals = [...tallyVotes(asState(view)).entries()];
  return (
    <CardText
      title={agenda.name}
      subtitle={`Agenda ${view.agenda!.number}: ${agenda.type}, ${agenda.targetText}`}
    >
      {[agenda.text1, agenda.text2].filter(Boolean).join("\n")}
      {totals.length > 0 &&
        `\n\nVotes so far: ${totals
          .map(([outcome, votes]) => `${outcome} ${votes}`)
          .join(", ")}`}
    </CardText>
  );
}

function outcomeOptions(view: GameView) {
  const state = asState(view);
  return agendaOutcomes(state, view.agenda!.card!).map((outcome) => ({
    value: outcome,
    label: objectivesById[outcome]?.name ?? outcome,
  }));
}

export function Vote({ view, prompt }: PromptProps<"vote">) {
  const dispatch = useGame((state) => state.dispatch);
  const state = asState(view);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [planets, setPlanets] = useState<string[]>([]);
  const [extra, setExtra] = useState(0);
  const ready = controlledPlanets(state, prompt.player).filter(
    (p) => !p.exhausted,
  );
  const votes =
    planets.reduce((sum, name) => sum + planetInfluence(state, name), 0) +
    extra;
  const options = outcomeOptions(view);

  return (
    <Stack gap="xs">
      <AgendaCard view={view} />
      {options.length > 0 ? (
        <Select
          label="Vote for"
          placeholder="Choose an outcome"
          searchable
          data={options}
          value={outcome}
          onChange={setOutcome}
        />
      ) : (
        <Text size="sm" c="dimmed">
          This agenda has no fixed outcomes. Agree the vote at the table and
          let the speaker record the result.
        </Text>
      )}
      <Group gap="xs">
        {ready.map((planet) => (
          <Checkbox
            key={planet.name}
            size="xs"
            label={`${planet.name} (${planetInfluence(state, planet.name)})`}
            checked={planets.includes(planet.name)}
            onChange={(event) =>
              setPlanets(
                event.currentTarget.checked
                  ? [...planets, planet.name]
                  : planets.filter((name) => name !== planet.name),
              )
            }
          />
        ))}
      </Group>
      <NumberInput
        size="xs"
        label="Extra votes from cards and abilities"
        min={0}
        value={extra}
        onChange={(value) => setExtra(Number(value) || 0)}
      />
      <Group gap="xs">
        <Button
          disabled={!outcome || votes === 0}
          onClick={() =>
            dispatch(
              {
                type: "CAST_VOTES",
                outcome: outcome ?? undefined,
                planets,
                extraVotes: extra,
              },
              prompt.player,
            )
          }
        >
          Cast {votes} {votes === 1 ? "vote" : "votes"}
        </Button>
        <Button
          variant="default"
          onClick={() =>
            dispatch({ type: "CAST_VOTES", planets: [] }, prompt.player)
          }
        >
          Abstain
        </Button>
      </Group>
    </Stack>
  );
}

export function BreakTie({ view, prompt }: PromptProps<"breakTie">) {
  const dispatch = useGame((state) => state.dispatch);
  const [outcome, setOutcome] = useState<string | null>(null);
  const options =
    prompt.outcomes.length > 0
      ? prompt.outcomes.map((o) => ({
          value: o,
          label: objectivesById[o]?.name ?? o,
        }))
      : outcomeOptions(view);
  return (
    <Stack gap="xs">
      <AgendaCard view={view} />
      <Text size="sm">
        The vote did not settle it. As speaker, you decide the outcome.
      </Text>
      <Select
        placeholder="Choose the outcome"
        searchable
        data={options}
        value={outcome}
        onChange={setOutcome}
      />
      <Button
        disabled={!outcome}
        onClick={() =>
          dispatch({ type: "BREAK_TIE", outcome: outcome! }, prompt.player)
        }
      >
        Decide
      </Button>
    </Stack>
  );
}

export function PoliticsAgenda({ prompt }: PromptProps<"politicsAgenda">) {
  const dispatch = useGame((state) => state.dispatch);
  const cards = prompt.cards.filter((id) => !isHidden(id));
  const [order, setOrder] = useState(cards);
  const [bottom, setBottom] = useState<string[]>([]);
  return (
    <Stack gap="xs">
      <Text size="sm">
        These are the top cards of the agenda deck. Put each on the top or the
        bottom; the first card listed is drawn first.
      </Text>
      {order.map((id, idx) => {
        const agenda = agendasById[id];
        return (
          <CardText
            key={id}
            title={agenda.name}
            subtitle={`${agenda.type}, ${agenda.targetText}`}
            right={
              <Group gap={4} wrap="nowrap">
                <Checkbox
                  size="xs"
                  label="Bottom"
                  checked={bottom.includes(id)}
                  onChange={(event) =>
                    setBottom(
                      event.currentTarget.checked
                        ? [...bottom, id]
                        : bottom.filter((c) => c !== id),
                    )
                  }
                />
                {idx > 0 && (
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() => setOrder([...order].reverse())}
                  >
                    Move first
                  </Button>
                )}
              </Group>
            }
          >
            {[agenda.text1, agenda.text2].filter(Boolean).join("\n")}
          </CardText>
        );
      })}
      <Button
        onClick={() =>
          dispatch(
            {
              type: "ORDER_AGENDAS",
              top: order.filter((id) => !bottom.includes(id)),
              bottom: order.filter((id) => bottom.includes(id)),
            },
            prompt.player,
          )
        }
      >
        Return to the deck
      </Button>
    </Stack>
  );
}

export function Resolve({ prompt }: PromptProps<"resolve">) {
  const dispatch = useGame((state) => state.dispatch);
  return (
    <Stack gap="xs">
      <CardText title={prompt.title}>{prompt.text}</CardText>
      <Text size="xs" c="dimmed">
        Carry this out using the Adjust tab, then continue.
      </Text>
      <Button
        onClick={() =>
          dispatch({ type: "RESOLVE", promptId: prompt.id }, prompt.player)
        }
      >
        Done
      </Button>
    </Stack>
  );
}
