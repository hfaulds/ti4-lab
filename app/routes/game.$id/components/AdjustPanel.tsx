import {
  Alert,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useState } from "react";
import { Section, SectionTitle } from "~/components/Section";
import {
  agendas,
  attachments,
  availableTechnologies,
  enabledContent,
  objectivesById,
  relics,
  UNIT_NAMES,
} from "~/game/data";
import { Adjustment } from "~/game/actions";
import { CommandPools, UnitType } from "~/game/types";
import { GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";

type Kind =
  | "economy"
  | "units"
  | "planet"
  | "system"
  | "cards"
  | "table"
  | "note";

const KINDS: { value: Kind; label: string }[] = [
  { value: "economy", label: "Player" },
  { value: "units", label: "Units" },
  { value: "planet", label: "Planet" },
  { value: "system", label: "System" },
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
  { value: "note", label: "Note" },
];

const UNIT_OPTIONS = (Object.keys(UNIT_NAMES) as UnitType[]).map((type) => ({
  value: type,
  label: UNIT_NAMES[type],
}));

const WORMHOLES = ["ALPHA", "BETA", "GAMMA", "DELTA"];

export function AdjustPanel({
  view,
  player,
}: {
  view: GameView;
  player?: PlayerId;
}) {
  const dispatch = useGame((state) => state.dispatch);
  const selectedSystem = useGame((state) => state.selectedSystem);
  const [kind, setKind] = useState<Kind>("economy");
  const [target, setTarget] = useState<string | null>(
    player === undefined ? null : String(player),
  );
  const [amount, setAmount] = useState(1);
  const [field, setField] = useState<string | null>("tradeGoods");
  const [unit, setUnit] = useState<string | null>("infantry");
  const [planet, setPlanet] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");

  if (player === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Choose which player you are to make adjustments.
      </Text>
    );
  }

  const system =
    selectedSystem !== undefined ? view.systems[selectedSystem] : undefined;
  const targetId = target === null ? undefined : Number(target);
  const players = view.seating.map((id) => ({
    value: String(id),
    label: view.players[id].name,
  }));
  const apply = (adjustment: Adjustment) =>
    dispatch({ type: "ADJUST", adjustment });

  const playerSelect = (
    <Select
      label="Player"
      data={players}
      value={target}
      onChange={setTarget}
      allowDeselect={false}
    />
  );
  const needsSystem = (
    <Text size="sm" c="dimmed">
      Select a system on the board first.
    </Text>
  );
  const systemPlanets = (system?.planets ?? []).map((name) => ({
    value: name,
    label: name,
  }));
  const allPlanets = Object.keys(view.planets)
    .sort()
    .map((name) => ({ value: name, label: name }));
  const expansions = view.options.expansions;

  return (
    <Section>
      <SectionTitle title="Adjust the game by hand" />
      <Stack gap="sm" px="sm">
        <Alert variant="light" color="gray" p="xs">
          <Text size="xs">
            Use this for card text and faction abilities the game does not
            resolve for you. Every change is recorded in the log.
          </Text>
        </Alert>
        <SegmentedControl
          size="xs"
          fullWidth
          data={KINDS}
          value={kind}
          onChange={(value) => {
            setKind(value as Kind);
            setChoice(null);
            setPlanet(null);
          }}
        />

        {kind === "economy" && (
          <>
            {playerSelect}
            <Select
              label="Change"
              allowDeselect={false}
              data={[
                { value: "tradeGoods", label: "Trade goods" },
                { value: "commodities", label: "Commodities" },
                { value: "tactic", label: "Tactic tokens" },
                { value: "fleet", label: "Fleet tokens" },
                { value: "strategy", label: "Strategy tokens" },
                { value: "victoryPoints", label: "Victory points" },
              ]}
              value={field}
              onChange={setField}
            />
            <NumberInput
              label="Amount (negative to take away)"
              value={amount}
              onChange={(value) => setAmount(Number(value) || 0)}
            />
            <Button
              disabled={targetId === undefined || amount === 0 || !field}
              onClick={() => {
                if (targetId === undefined || !field) return;
                if (["tactic", "fleet", "strategy"].includes(field)) {
                  return apply({
                    type: "commandTokens",
                    player: targetId,
                    pool: field as keyof CommandPools,
                    amount,
                  });
                }
                return apply({
                  type: field as "tradeGoods" | "commodities" | "victoryPoints",
                  player: targetId,
                  amount,
                });
              }}
            >
              Apply
            </Button>
          </>
        )}

        {kind === "units" &&
          (!system ? (
            needsSystem
          ) : (
            <>
              {playerSelect}
              <Select
                label="Where"
                placeholder="Space area"
                clearable
                data={systemPlanets}
                value={planet}
                onChange={setPlanet}
              />
              <Select
                label="Unit"
                allowDeselect={false}
                data={UNIT_OPTIONS}
                value={unit}
                onChange={setUnit}
              />
              <NumberInput
                label="Amount (negative to remove)"
                value={amount}
                onChange={(value) => setAmount(Number(value) || 0)}
              />
              <Button
                disabled={targetId === undefined || amount === 0 || !unit}
                onClick={() =>
                  apply({
                    type: "units",
                    player: targetId!,
                    system: system.key,
                    planet: planet ?? undefined,
                    unit: unit as UnitType,
                    amount,
                  })
                }
              >
                Apply
              </Button>
            </>
          ))}

        {kind === "planet" && (
          <>
            <Select
              label="Planet"
              searchable
              data={allPlanets}
              value={planet}
              onChange={setPlanet}
            />
            {planet && (
              <>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() =>
                      apply({
                        type: "planetExhausted",
                        planet,
                        exhausted: !view.planets[planet].exhausted,
                      })
                    }
                  >
                    {view.planets[planet].exhausted ? "Ready" : "Exhaust"}
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => apply({ type: "planetControl", planet })}
                  >
                    Make uncontrolled
                  </Button>
                  {expansions.includes("pok") && (
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() =>
                        apply({ type: "explore", player, planet })
                      }
                    >
                      Explore
                    </Button>
                  )}
                </Group>
                <Group gap="xs" align="flex-end">
                  <Select
                    label="Give control to"
                    data={players}
                    value={target}
                    onChange={setTarget}
                    style={{ flex: 1 }}
                  />
                  <Button
                    disabled={targetId === undefined}
                    onClick={() =>
                      apply({
                        type: "planetControl",
                        planet,
                        player: targetId,
                      })
                    }
                  >
                    Give
                  </Button>
                </Group>
                <Group gap="xs" align="flex-end">
                  <Select
                    label="Attachment"
                    searchable
                    data={enabledContent(attachments, expansions).map((a) => ({
                      value: a.id,
                      label: `${a.name}${
                        a.resources || a.influence
                          ? ` (+${a.resources}/+${a.influence})`
                          : ""
                      }`,
                    }))}
                    value={choice}
                    onChange={setChoice}
                    style={{ flex: 1 }}
                  />
                  <Button
                    disabled={!choice}
                    onClick={() =>
                      apply({
                        type: "attachment",
                        planet,
                        attachment: choice!,
                        attached:
                          !view.planets[planet].attachments.includes(choice!),
                      })
                    }
                  >
                    {choice && view.planets[planet].attachments.includes(choice)
                      ? "Remove"
                      : "Attach"}
                  </Button>
                </Group>
              </>
            )}
          </>
        )}

        {kind === "system" &&
          (!system ? (
            needsSystem
          ) : (
            <>
              <Group gap="xs" align="flex-end">
                <Select
                  label="Command token of"
                  data={players}
                  value={target}
                  onChange={setTarget}
                  style={{ flex: 1 }}
                />
                <Button
                  disabled={targetId === undefined}
                  onClick={() =>
                    apply({
                      type: "systemToken",
                      player: targetId!,
                      system: system.key,
                      present: !system.commandTokens.includes(targetId!),
                    })
                  }
                >
                  {targetId !== undefined &&
                  system.commandTokens.includes(targetId)
                    ? "Remove"
                    : "Place"}
                </Button>
              </Group>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() =>
                    apply({
                      type: "frontier",
                      system: system.key,
                      present: !system.frontier,
                    })
                  }
                >
                  {system.frontier ? "Remove" : "Place"} frontier token
                </Button>
                {system.frontier && (
                  <Button
                    size="xs"
                    variant="default"
                    onClick={async () => {
                      const explored = await apply({
                        type: "explore",
                        player,
                        system: system.key,
                      });
                      if (explored) {
                        await apply({
                          type: "frontier",
                          system: system.key,
                          present: false,
                        });
                      }
                    }}
                  >
                    Explore frontier
                  </Button>
                )}
              </Group>
              <Group gap="xs" align="flex-end">
                <Select
                  label="Wormhole token"
                  data={WORMHOLES.map((w) => ({
                    value: w,
                    label: w.toLowerCase(),
                  }))}
                  value={choice}
                  onChange={setChoice}
                  style={{ flex: 1 }}
                />
                <Button
                  disabled={!choice}
                  onClick={() =>
                    apply({
                      type: "wormhole",
                      system: system.key,
                      wormhole: choice!,
                      present: !system.addedWormholes.includes(choice as never),
                    })
                  }
                >
                  {choice && system.addedWormholes.includes(choice as never)
                    ? "Remove"
                    : "Place"}
                </Button>
              </Group>
            </>
          ))}

        {kind === "cards" && (
          <>
            {playerSelect}
            {targetId !== undefined && (
              <>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() =>
                      apply({
                        type: "drawActionCards",
                        player: targetId,
                        count: 1,
                      })
                    }
                  >
                    Draw an action card
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() =>
                      apply({ type: "drawSecret", player: targetId })
                    }
                  >
                    Draw a secret objective
                  </Button>
                  {expansions.includes("pok") && (
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() =>
                        apply({ type: "relic", player: targetId, owned: true })
                      }
                    >
                      Gain a relic
                    </Button>
                  )}
                </Group>
                {view.players[targetId].relics.length > 0 && (
                  <Group gap="xs">
                    {view.players[targetId].relics.map((relic) => (
                      <Button
                        key={relic}
                        size="xs"
                        variant="default"
                        onClick={() =>
                          apply({
                            type: "relic",
                            player: targetId,
                            relic,
                            owned: false,
                          })
                        }
                      >
                        Purge{" "}
                        {relics.find((r) => r.id === relic)?.name ?? relic}
                      </Button>
                    ))}
                  </Group>
                )}
                <Group gap="xs" align="flex-end">
                  <Select
                    label="Technology"
                    searchable
                    data={availableTechnologies(
                      view.players[targetId].faction,
                      expansions,
                    ).map((tech) => ({ value: tech.id, label: tech.name }))}
                    value={choice}
                    onChange={setChoice}
                    style={{ flex: 1 }}
                  />
                  <Button
                    disabled={!choice}
                    onClick={() =>
                      apply({
                        type: "technology",
                        player: targetId,
                        technology: choice!,
                        owned:
                          !view.players[targetId].technologies.includes(choice!),
                      })
                    }
                  >
                    {choice &&
                    view.players[targetId].technologies.includes(choice)
                      ? "Remove"
                      : "Gain"}
                  </Button>
                </Group>
              </>
            )}
          </>
        )}

        {kind === "table" && (
          <>
            <Group gap="xs" align="flex-end">
              <Select
                label="Speaker"
                data={players}
                value={target}
                onChange={setTarget}
                style={{ flex: 1 }}
              />
              <Button
                disabled={targetId === undefined || targetId === view.speaker}
                onClick={() => apply({ type: "speaker", player: targetId! })}
              >
                Pass token
              </Button>
            </Group>
            <Button
              size="xs"
              variant="default"
              onClick={() =>
                apply({ type: "custodians", present: !view.custodians })
              }
            >
              {view.custodians ? "Remove" : "Return"} the custodians token
            </Button>
            <Group gap="xs" align="flex-end">
              <Select
                label="Law"
                searchable
                data={enabledContent(agendas, expansions)
                  .filter((a) => a.type === "law")
                  .map((a) => ({ value: a.id, label: a.name }))}
                value={choice}
                onChange={setChoice}
                style={{ flex: 1 }}
              />
              <Button
                disabled={!choice}
                onClick={() =>
                  apply({
                    type: "law",
                    agenda: choice!,
                    inPlay: !view.laws.some((law) => law.id === choice),
                  })
                }
              >
                {choice && view.laws.some((law) => law.id === choice)
                  ? "Discard"
                  : "Put in play"}
              </Button>
            </Group>
            <Group gap="xs" align="flex-end">
              <Select
                label="Public objective scored by"
                data={players}
                value={target}
                onChange={setTarget}
                style={{ flex: 1 }}
              />
              <Select
                label="Objective"
                data={view.publicObjectives
                  .filter((o) => o.revealed)
                  .map((o) => ({
                    value: o.id,
                    label: objectivesById[o.id]?.name ?? o.id,
                  }))}
                value={planet}
                onChange={setPlanet}
                style={{ flex: 1 }}
              />
              <Button
                disabled={targetId === undefined || !planet}
                onClick={() => {
                  const objective = view.publicObjectives.find(
                    (o) => o.id === planet,
                  )!;
                  return apply({
                    type: "scorePublic",
                    player: targetId!,
                    objective: objective.id,
                    scored: !objective.scoredBy.includes(targetId!),
                  });
                }}
              >
                Toggle
              </Button>
            </Group>
          </>
        )}

        {kind === "note" && (
          <>
            <Textarea
              label="Note for the log"
              placeholder="What happened?"
              maxLength={500}
              autosize
              minRows={2}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
            <Button
              disabled={text.trim().length === 0}
              onClick={async () => {
                if (await apply({ type: "note", text })) setText("");
              }}
            >
              Add to log
            </Button>
          </>
        )}
      </Stack>
    </Section>
  );
}
