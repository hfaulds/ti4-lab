import {
  ActionIcon,
  Badge,
  Box,
  Checkbox,
  Group,
  NumberInput,
  Stack,
  Text,
} from "@mantine/core";
import { IconMinus, IconPlus } from "@tabler/icons-react";
import { ReactNode } from "react";
import { FactionIcon } from "~/components/icons/FactionIcon";
import { UNIT_NAMES } from "~/game/data";
import {
  controlledPlanets,
  planetInfluence,
  planetResources,
} from "~/game/engine/board";
import { unitTypes } from "~/game/engine/helpers";
import { Payment, UnitCounts, UnitGroup, UnitType } from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { playerColor, playerTextColor } from "../colors";

export const UNIT_SHORT: Record<UnitType, string> = {
  warsun: "WS",
  flagship: "FS",
  dreadnought: "DN",
  carrier: "CV",
  cruiser: "CA",
  destroyer: "DD",
  fighter: "FF",
  mech: "MF",
  infantry: "GF",
  spacedock: "SD",
  pds: "PDS",
};

const UNIT_ORDER = Object.keys(UNIT_SHORT) as UnitType[];

export const sortedUnitTypes = (group: UnitGroup | undefined) =>
  unitTypes(group).sort((a, b) => UNIT_ORDER.indexOf(a) - UNIT_ORDER.indexOf(b));

export function PlayerName({
  view,
  player,
  size = "sm",
}: {
  view: GameView;
  player: PlayerId;
  size?: "xs" | "sm" | "md";
}) {
  const data = view.players[player];
  if (!data) return null;
  return (
    <Group gap={6} wrap="nowrap" display="inline-flex">
      <Box
        w={10}
        h={10}
        style={{
          borderRadius: "50%",
          background: playerColor(data.color),
          flexShrink: 0,
        }}
      />
      <FactionIcon faction={data.faction} style={{ width: 18, height: 18 }} />
      <Text size={size} fw={600} span>
        {data.name}
      </Text>
    </Group>
  );
}

/** One player's units in a location, as compact colored chips. */
export function UnitChips({
  view,
  player,
  group,
  size = "sm",
}: {
  view: GameView;
  player: PlayerId;
  group: UnitGroup | undefined;
  size?: "xs" | "sm";
}) {
  const color = view.players[player]?.color ?? "black";
  return (
    <Group gap={4}>
      {sortedUnitTypes(group).map((type) => {
        const stack = group![type]!;
        return (
          <Badge
            key={type}
            size={size}
            radius="sm"
            title={`${stack.count} ${UNIT_NAMES[type]}${
              stack.damaged > 0 ? ` (${stack.damaged} damaged)` : ""
            }`}
            styles={{
              root: {
                background: playerColor(color),
                color: playerTextColor(color),
                textTransform: "none",
              },
            }}
          >
            {stack.count} {UNIT_SHORT[type]}
            {stack.damaged > 0 ? ` (${stack.damaged} dmg)` : ""}
          </Badge>
        );
      })}
    </Group>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label?: ReactNode;
}) {
  return (
    <Group gap={6} wrap="nowrap" justify="space-between">
      {label && (
        <Text size="sm" style={{ flex: 1 }}>
          {label}
        </Text>
      )}
      <Group gap={4} wrap="nowrap">
        <ActionIcon
          variant="default"
          size="sm"
          aria-label="Decrease"
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          <IconMinus size={12} />
        </ActionIcon>
        <Text size="sm" w={24} ta="center" fw={600}>
          {value}
        </Text>
        <ActionIcon
          variant="default"
          size="sm"
          aria-label="Increase"
          disabled={max !== undefined && value >= max}
          onClick={() => onChange(value + 1)}
        >
          <IconPlus size={12} />
        </ActionIcon>
      </Group>
    </Group>
  );
}

/** Steppers for choosing how many of each available unit to use. */
export function UnitPicker({
  available,
  value,
  onChange,
  filter = () => true,
}: {
  available: UnitGroup | undefined;
  value: UnitCounts;
  onChange: (value: UnitCounts) => void;
  filter?: (type: UnitType) => boolean;
}) {
  const types = sortedUnitTypes(available).filter(filter);
  if (types.length === 0) return null;
  return (
    <Stack gap={4}>
      {types.map((type) => (
        <Stepper
          key={type}
          label={`${UNIT_NAMES[type]} (${available![type]!.count})`}
          value={value[type] ?? 0}
          max={available![type]!.count}
          onChange={(count) => onChange({ ...value, [type]: count })}
        />
      ))}
    </Stack>
  );
}

export const EMPTY_PAYMENT: Payment = { planets: [], tradeGoods: 0 };

export function paymentTotal(
  view: GameView,
  payment: Payment,
  currency: "resources" | "influence",
  allowTradeGoods = true,
) {
  const value = currency === "resources" ? planetResources : planetInfluence;
  return (
    payment.planets.reduce((sum, name) => sum + value(asState(view), name), 0) +
    (allowTradeGoods ? payment.tradeGoods : 0)
  );
}

/** Chooses the planets and trade goods that pay for something. */
export function PaymentPicker({
  view,
  player,
  currency,
  cost,
  value,
  onChange,
  allowTradeGoods = true,
  exclude = [],
}: {
  view: GameView;
  player: PlayerId;
  currency: "resources" | "influence";
  /** Omitted when any amount may be spent. */
  cost?: number;
  value: Payment;
  onChange: (value: Payment) => void;
  allowTradeGoods?: boolean;
  /** Planets already committed to another payment. */
  exclude?: string[];
}) {
  const state = asState(view);
  const worth = currency === "resources" ? planetResources : planetInfluence;
  const planets = controlledPlanets(state, player)
    .filter((p) => !p.exhausted && !exclude.includes(p.name))
    .sort((a, b) => worth(state, b.name) - worth(state, a.name));
  const total = paymentTotal(view, value, currency, allowTradeGoods);
  const enough = cost === undefined || total >= cost;

  return (
    <Stack gap={6}>
      <Group justify="space-between">
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
          Pay with {currency}
        </Text>
        <Badge color={enough ? "green" : "orange"} variant="light">
          {total}
          {cost !== undefined ? ` / ${cost}` : ""}
        </Badge>
      </Group>
      {planets.length === 0 && (
        <Text size="xs" c="dimmed">
          No readied planets.
        </Text>
      )}
      <Group gap="xs">
        {planets.map((planet) => (
          <Checkbox
            key={planet.name}
            size="xs"
            label={`${planet.name} (${worth(state, planet.name)})`}
            checked={value.planets.includes(planet.name)}
            onChange={(event) =>
              onChange({
                ...value,
                planets: event.currentTarget.checked
                  ? [...value.planets, planet.name]
                  : value.planets.filter((name) => name !== planet.name),
              })
            }
          />
        ))}
      </Group>
      {allowTradeGoods && view.players[player].tradeGoods > 0 && (
        <NumberInput
          size="xs"
          label={`Trade goods (${view.players[player].tradeGoods} available)`}
          min={0}
          max={view.players[player].tradeGoods}
          value={value.tradeGoods}
          onChange={(amount) =>
            onChange({ ...value, tradeGoods: Number(amount) || 0 })
          }
        />
      )}
    </Stack>
  );
}

export function CardText({
  title,
  subtitle,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Box
      p="xs"
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: "var(--mantine-radius-sm)",
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <Box>
          <Text size="sm" fw={700}>
            {title}
          </Text>
          {subtitle && (
            <Text size="xs" c="dimmed" fs="italic">
              {subtitle}
            </Text>
          )}
        </Box>
        {right}
      </Group>
      {children && (
        <Text size="xs" mt={4} style={{ whiteSpace: "pre-line" }}>
          {children}
        </Text>
      )}
    </Box>
  );
}
