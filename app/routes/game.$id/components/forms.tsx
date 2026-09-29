import { Badge, Checkbox, Group, Select, Stack, Text } from "@mantine/core";
import {
  isGroundForce,
  isStructure,
  technologiesById,
  UNIT_NAMES,
} from "~/game/data";
import { ProductionOrder, Research, StructurePlacement } from "~/game/actions";
import {
  controlledPlanets,
  planetTechSpecialties,
} from "~/game/engine/board";
import { productionCapacity, productionCost } from "~/game/engine/economy";
import {
  COMMAND_TOKEN_LIMIT,
  countOf,
  tokensOnBoard,
  totalTokens,
  unitOf,
  unitsAvailable,
} from "~/game/engine/helpers";
import {
  missingPrerequisites,
  researchableTechnologies,
} from "~/game/engine/technology";
import { CommandPools, Payment, SystemKey, UnitType } from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { PaymentPicker, Stepper } from "./shared";

// --- Command tokens ---------------------------------------------------------

/** Tokens a player ends up with after gaining some from reinforcements. */
export function tokensAfterGaining(
  view: GameView,
  player: PlayerId,
  gained: number,
) {
  const state = asState(view);
  const current = totalTokens(view.players[player]);
  const room = COMMAND_TOKEN_LIMIT - current - tokensOnBoard(state, player);
  return current + Math.max(0, Math.min(gained, room));
}

export function defaultPools(
  view: GameView,
  player: PlayerId,
  gained: number,
): CommandPools {
  const pools = view.players[player].pools;
  const extra = tokensAfterGaining(view, player, gained) - totalTokens(view.players[player]);
  return { ...pools, tactic: pools.tactic + extra };
}

export function PoolsEditor({
  total,
  value,
  onChange,
}: {
  total: number;
  value: CommandPools;
  onChange: (value: CommandPools) => void;
}) {
  const assigned = value.tactic + value.fleet + value.strategy;
  const remaining = total - assigned;
  const pools: (keyof CommandPools)[] = ["tactic", "fleet", "strategy"];
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
          Command tokens
        </Text>
        <Badge variant="light" color={remaining === 0 ? "green" : "orange"}>
          {remaining === 0
            ? `${total} placed`
            : remaining > 0
              ? `${remaining} left to place`
              : `${-remaining} too many`}
        </Badge>
      </Group>
      {pools.map((pool) => (
        <Stepper
          key={pool}
          label={pool[0].toUpperCase() + pool.slice(1)}
          value={value[pool]}
          max={value[pool] + Math.max(0, remaining)}
          onChange={(count) => onChange({ ...value, [pool]: count })}
        />
      ))}
    </Stack>
  );
}

// --- Research ---------------------------------------------------------------

const COLOR_NAMES: Record<string, string> = {
  BIOTIC: "green",
  WARFARE: "red",
  PROPULSION: "blue",
  CYBERNETIC: "yellow",
};

export function ResearchPicker({
  view,
  player,
  value,
  onChange,
  exclude = [],
}: {
  view: GameView;
  player: PlayerId;
  value?: Research;
  onChange: (value?: Research) => void;
  /** Technologies being researched elsewhere in the same action. */
  exclude?: string[];
}) {
  const state = asState(view);
  const me = view.players[player];
  const options = researchableTechnologies(state, player)
    .filter((tech) => !exclude.includes(tech.id))
    .map((tech) => {
      const missing = missingPrerequisites(state, player, tech.id);
      return {
        value: tech.id,
        label: `${tech.name}${
          missing.length > 0
            ? ` (needs ${missing.map((c) => COLOR_NAMES[c]).join(", ")})`
            : ""
        }`,
        missing: missing.length,
      };
    })
    .sort((a, b) => a.missing - b.missing || a.label.localeCompare(b.label));

  const chosen = value ? technologiesById[value.technology] : undefined;
  const missing = chosen ? missingPrerequisites(state, player, chosen.id) : [];
  const freeSkips = me.technologies.includes("pa");
  const skipPlanets = controlledPlanets(state, player).filter(
    (planet) =>
      (freeSkips || !planet.exhausted) &&
      planetTechSpecialties(state, planet.name).some((c) => missing.includes(c)),
  );
  const canUseAida =
    !!chosen?.unitUpgrade &&
    me.technologies.includes("aida") &&
    !me.exhaustedTechnologies.includes("aida");

  return (
    <Stack gap={6}>
      <Select
        label="Technology"
        placeholder="Choose a technology"
        searchable
        clearable
        data={options}
        value={value?.technology ?? null}
        onChange={(technology) =>
          onChange(technology ? { technology, skips: [] } : undefined)
        }
      />
      {chosen && (
        <Text size="xs" style={{ whiteSpace: "pre-line" }}>
          {chosen.text}
        </Text>
      )}
      {chosen && missing.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="orange">
            Missing prerequisites:{" "}
            {missing.map((c) => COLOR_NAMES[c]).join(", ")}
          </Text>
          {skipPlanets.map((planet) => (
            <Checkbox
              key={planet.name}
              size="xs"
              label={`${freeSkips ? "Use" : "Exhaust"} ${planet.name} (${planetTechSpecialties(
                state,
                planet.name,
              )
                .map((c) => COLOR_NAMES[c])
                .join(", ")} specialty)`}
              checked={(value?.skips ?? []).includes(planet.name)}
              onChange={(event) =>
                onChange({
                  ...value!,
                  skips: event.currentTarget.checked
                    ? [...(value?.skips ?? []), planet.name]
                    : (value?.skips ?? []).filter((n) => n !== planet.name),
                })
              }
            />
          ))}
          {canUseAida && (
            <Checkbox
              size="xs"
              label="Exhaust AI Development Algorithm to ignore 1 prerequisite"
              checked={!!value?.useAida}
              onChange={(event) =>
                onChange({ ...value!, useAida: event.currentTarget.checked })
              }
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

// --- Structures -------------------------------------------------------------

export function StructurePicker({
  view,
  player,
  label,
  value,
  onChange,
  types = ["spacedock", "pds"],
}: {
  view: GameView;
  player: PlayerId;
  label: string;
  value?: StructurePlacement;
  onChange: (value?: StructurePlacement) => void;
  types?: StructurePlacement["type"][];
}) {
  const state = asState(view);
  const limit = { pds: 2, spacedock: 1 };
  const planets = controlledPlanets(state, player);
  const options = types.flatMap((type) =>
    unitsAvailable(state, player, type) <= 0
      ? []
      : planets
          .filter((p) => countOf(p.units[player], type) < limit[type])
          .map((p) => ({
            value: `${type}|${p.name}`,
            label: `${UNIT_NAMES[type]} on ${p.name}`,
          })),
  );
  return (
    <Select
      label={label}
      placeholder="Nothing"
      searchable
      clearable
      data={options}
      value={value ? `${value.type}|${value.planet}` : null}
      onChange={(selected) => {
        if (!selected) return onChange(undefined);
        const [type, ...planet] = selected.split("|");
        onChange({
          type: type as StructurePlacement["type"],
          planet: planet.join("|"),
        });
      }}
    />
  );
}

// --- Production -------------------------------------------------------------

export type ProductionValue = { units: ProductionOrder[]; payment: Payment };
export const EMPTY_PRODUCTION: ProductionValue = {
  units: [],
  payment: { planets: [], tradeGoods: 0 },
};

const PRODUCIBLE: UnitType[] = [
  "warsun",
  "flagship",
  "dreadnought",
  "carrier",
  "cruiser",
  "destroyer",
  "fighter",
  "mech",
  "infantry",
];

export function ProductionForm({
  view,
  player,
  system,
  value,
  onChange,
  docksOnly = false,
}: {
  view: GameView;
  player: PlayerId;
  system: SystemKey;
  value: ProductionValue;
  onChange: (value: ProductionValue) => void;
  docksOnly?: boolean;
}) {
  const state = asState(view);
  const capacity = productionCapacity(state, system, player, { docksOnly });
  const types = PRODUCIBLE.filter((type) => {
    const unit = unitOf(state, player, type);
    return unit?.cost !== undefined && !isStructure(type);
  });
  const planets = view.systems[system].planets.filter(
    (name) => view.planets[name].controller === player,
  );
  const countFor = (type: UnitType) =>
    value.units
      .filter((u) => u.type === type)
      .reduce((sum, u) => sum + u.count, 0);
  const total = value.units.reduce((sum, u) => sum + u.count, 0);
  const cost = total > 0 ? productionCost(state, player, value.units) : 0;
  const landing = value.units.find((u) => isGroundForce(u.type))?.planet;

  const setCount = (type: UnitType, count: number) => {
    const others = value.units.filter((u) => u.type !== type);
    const planet = isGroundForce(type) ? (landing ?? planets[0]) : undefined;
    onChange({
      ...value,
      units: count > 0 ? [...others, { type, count, planet }] : others,
    });
  };

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
          Units to produce
        </Text>
        <Badge variant="light" color={total <= capacity ? "green" : "orange"}>
          {total} / {capacity} production
        </Badge>
      </Group>
      {types.map((type) => {
        const unit = unitOf(state, player, type)!;
        const available = unitsAvailable(state, player, type);
        return (
          <Stepper
            key={type}
            label={`${unit.name} (${unit.cost}${
              unit.producedPerCost > 1 ? ` for ${unit.producedPerCost}` : ""
            })`}
            value={countFor(type)}
            max={Math.min(
              available,
              countFor(type) + Math.max(0, capacity - total),
            )}
            onChange={(count) => setCount(type, count)}
          />
        );
      })}
      {value.units.some((u) => isGroundForce(u.type)) && (
        <Select
          label="Place ground forces"
          allowDeselect={false}
          data={[
            ...planets.map((name) => ({ value: name, label: `On ${name}` })),
            { value: "", label: "In the space area" },
          ]}
          value={landing ?? ""}
          onChange={(planet) =>
            onChange({
              ...value,
              units: value.units.map((u) =>
                isGroundForce(u.type)
                  ? { ...u, planet: planet || undefined }
                  : u,
              ),
            })
          }
        />
      )}
      {total > 0 && (
        <PaymentPicker
          view={view}
          player={player}
          currency="resources"
          cost={cost}
          value={value.payment}
          onChange={(payment) => onChange({ ...value, payment })}
        />
      )}
    </Stack>
  );
}
