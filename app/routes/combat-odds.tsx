import {
  Box,
  Checkbox,
  Container,
  Group,
  MultiSelect,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { MetaFunction } from "react-router";
import { useDeferredValue, useMemo, useState } from "react";
import { HeaderControls } from "~/components/HeaderControls";
import { MainAppShell } from "~/components/MainAppShell";
import { NumberStepper } from "~/components/NumberStepper";
import { FactionIcon } from "~/components/icons/FactionIcon";
import { factions } from "~/data/factionData";
import {
  availableTechnologies,
  EXPANSIONS,
  factionSetups,
  SHIP_TYPES,
  UNIT_LIMITS,
  UNIT_NAMES,
  UnitCounts,
  UnitType,
  unitFor,
} from "~/game/data";
import {
  CombatOdds,
  FleetOutcome,
  groundCombatOdds,
  OddsSide,
  spaceCombatOdds,
} from "~/game/engine/odds";
import { FactionId } from "~/types";
import classes from "~/components/CombatOdds.module.css";

export const meta: MetaFunction = () => [
  { title: "TI4 Lab Combat Odds" },
  {
    name: "description",
    content:
      "Exact space and ground combat odds for Twilight Imperium 4th Edition.",
  },
];

type Mode = "space" | "ground";
type Role = "attacker" | "defender";

type SideState = {
  faction: FactionId;
  technologies: string[];
  units: UnitCounts;
  support: UnitCounts;
};

const EXPANSION_IDS = EXPANSIONS.map((e) => e.id);
const GROUND_TYPES: UnitType[] = ["mech", "infantry"];
/** Fighters and infantry are unlimited; cap them to keep the maths quick. */
const TOKEN_LIMIT = 20;
/** Techs that change combat without being unit upgrades. */
const COMBAT_TECHS = ["ps", "amd"];
const COLORS: Record<Role | "draw", string> = {
  attacker: "blue.6",
  defender: "red.8",
  draw: "gray.6",
};

const FACTION_OPTIONS = [...new Set(factionSetups.map((s) => s.faction))]
  .filter((id) => factions[id])
  .sort((a, b) => factions[a].name.localeCompare(factions[b].name))
  .map((id) => ({ value: id, label: factions[id].name }));

function techOptions(faction: FactionId) {
  const techs = availableTechnologies(faction, EXPANSION_IDS).filter(
    (t) => (t.unitUpgrade && t.id !== "sd2") || COMBAT_TECHS.includes(t.id),
  );
  // A faction's own upgrade stands in for the generic one.
  const replaced = new Set(techs.map((t) => t.baseUpgrade).filter(Boolean));
  return techs
    .filter((t) => !replaced.has(t.id))
    .map((t) => ({ value: t.id, label: t.name }));
}

const unitOf = (side: SideState, type: UnitType) =>
  unitFor(side.faction, type, side.technologies, EXPANSION_IDS);

const limitOf = (type: UnitType) =>
  Number.isFinite(UNIT_LIMITS[type]) ? UNIT_LIMITS[type] : TOKEN_LIMIT;

/** Drops units this side cannot field, e.g. a war sun without the tech. */
function fieldable(side: SideState, counts: UnitCounts): UnitCounts {
  const out: UnitCounts = {};
  for (const [type, count] of Object.entries(counts) as [UnitType, number][]) {
    if (count > 0 && unitOf(side, type)) out[type] = count;
  }
  return out;
}

const toOddsSide = (side: SideState): OddsSide => ({
  faction: side.faction,
  technologies: side.technologies,
  units: fieldable(side, side.units),
  support: fieldable(side, side.support),
});

/** Never rounds a possible outcome to 0% or an uncertain one to 100%. */
function percent(p: number) {
  if (p >= 1) return "100%";
  if (p >= 0.999) return ">99.9%";
  if (p > 0 && p < 0.001) return "<0.1%";
  return `${(p * 100).toFixed(1)}%`;
}

export default function CombatOddsPage() {
  const [accessibleColors, setAccessibleColors] = useState(false);
  const [mode, setMode] = useState<Mode>("space");
  const [nebula, setNebula] = useState(false);
  const [attacker, setAttacker] = useState<SideState>({
    faction: "sol",
    technologies: [],
    units: { carrier: 2, destroyer: 1, fighter: 2, infantry: 4 },
    support: { dreadnought: 0 },
  });
  const [defender, setDefender] = useState<SideState>({
    faction: "hacan",
    technologies: [],
    units: { cruiser: 2, fighter: 2, infantry: 2 },
    support: { pds: 1 },
  });

  const inputs = useDeferredValue({ mode, nebula, attacker, defender });
  const result = useMemo(() => {
    const a = toOddsSide(inputs.attacker);
    const d = toOddsSide(inputs.defender);
    const types = inputs.mode === "space" ? SHIP_TYPES : GROUND_TYPES;
    const fighting = (side: OddsSide) =>
      types.some((type) => (side.units[type] ?? 0) > 0);
    if (!fighting(a)) return { error: "Give the attacker some units." };
    if (inputs.mode === "space" && !fighting(d)) {
      return { error: "The defender has no ships, so there is no combat." };
    }
    if (inputs.mode === "ground" && !fighting(d)) {
      return { error: "The planet is undefended, so there is no combat." };
    }
    try {
      return {
        odds:
          inputs.mode === "space"
            ? spaceCombatOdds(a, d, { nebula: inputs.nebula })
            : groundCombatOdds(a, d),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [inputs]);
  const stale =
    inputs.attacker !== attacker ||
    inputs.defender !== defender ||
    inputs.mode !== mode ||
    inputs.nebula !== nebula;

  return (
    <MainAppShell
      headerRightSection={
        <HeaderControls
          accessibleColors={accessibleColors}
          onAccessibleColorsChange={setAccessibleColors}
        />
      }
    >
      <Container size="lg" py="xl">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <Stack gap={4}>
              <Title order={2}>Combat Odds</Title>
              <Text size="sm" c="dimmed">
                Exact odds, not a simulation. Hits go to sustain damage first,
                then the cheapest units. Retreats, action cards and leaders are
                ignored.
              </Text>
            </Stack>
            <Group>
              {mode === "space" && (
                <Checkbox
                  label="Defender in a nebula"
                  checked={nebula}
                  onChange={(e) => setNebula(e.currentTarget.checked)}
                />
              )}
              <SegmentedControl
                value={mode}
                onChange={(v) => setMode(v as Mode)}
                data={[
                  { value: "space", label: "Space combat" },
                  { value: "ground", label: "Ground combat" },
                ]}
              />
            </Group>
          </Group>

          <div className={classes.columns}>
            <SidePanel
              role="attacker"
              mode={mode}
              side={attacker}
              onChange={setAttacker}
            />
            <SidePanel
              role="defender"
              mode={mode}
              side={defender}
              onChange={setDefender}
            />
          </div>

          <Paper
            withBorder
            p="lg"
            radius="md"
            style={{ opacity: stale ? 0.6 : 1 }}
          >
            {result.odds ? (
              <Results
                odds={result.odds}
                attacker={inputs.attacker.faction}
                defender={inputs.defender.faction}
              />
            ) : (
              <Text c="dimmed">{result.error}</Text>
            )}
          </Paper>
        </Stack>
      </Container>
    </MainAppShell>
  );
}

// --- Inputs ------------------------------------------------------------------

function SidePanel({
  role,
  mode,
  side,
  onChange,
}: {
  role: Role;
  mode: Mode;
  side: SideState;
  onChange: (side: SideState) => void;
}) {
  const options = useMemo(() => techOptions(side.faction), [side.faction]);
  const fighting = mode === "space" ? SHIP_TYPES : GROUND_TYPES;

  const support: { label: string; types: UnitType[] } =
    mode === "space"
      ? { label: "PDS in range (space cannon)", types: ["pds"] }
      : role === "attacker"
        ? {
            label: "Ships bombarding",
            types: SHIP_TYPES.filter(
              (type) => unitOf(side, type)?.bombardment !== undefined,
            ),
          }
        : { label: "PDS on the planet", types: ["pds"] };

  const setFaction = (faction: FactionId) => {
    const allowed = new Set(techOptions(faction).map((o) => o.value));
    onChange({
      ...side,
      faction,
      technologies: side.technologies.filter((t) => allowed.has(t)),
    });
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group gap="xs">
          <Box w={12} h={12} bg={COLORS[role]} style={{ borderRadius: 2 }} />
          <Title order={4}>
            {role === "attacker" ? "Attacker" : "Defender"}
          </Title>
        </Group>
        <Select
          label="Faction"
          searchable
          allowDeselect={false}
          data={FACTION_OPTIONS}
          value={side.faction}
          onChange={(v) => v && setFaction(v as FactionId)}
          leftSection={
            <FactionIcon
              faction={side.faction}
              style={{ width: 18, height: 18 }}
            />
          }
          renderOption={({ option }) => (
            <Group gap="xs" wrap="nowrap">
              <FactionIcon
                faction={option.value as FactionId}
                style={{ width: 18, height: 18 }}
              />
              <Text size="sm">{option.label}</Text>
            </Group>
          )}
        />
        <MultiSelect
          label="Technologies"
          placeholder={
            side.technologies.length
              ? undefined
              : "Unit upgrades, Plasma Scoring…"
          }
          searchable
          clearable
          data={options}
          value={side.technologies}
          onChange={(technologies) => onChange({ ...side, technologies })}
        />
        <UnitSteppers
          label={mode === "space" ? "Ships" : "Ground forces"}
          side={side}
          types={fighting}
          counts={side.units}
          onChange={(units) => onChange({ ...side, units })}
        />
        {support.types.length > 0 && (
          <UnitSteppers
            label={support.label}
            side={side}
            types={support.types}
            counts={side.support}
            onChange={(counts) => onChange({ ...side, support: counts })}
          />
        )}
      </Stack>
    </Paper>
  );
}

function UnitSteppers({
  label,
  side,
  types,
  counts,
  onChange,
}: {
  label: string;
  side: SideState;
  types: UnitType[];
  counts: UnitCounts;
  onChange: (counts: UnitCounts) => void;
}) {
  const set = (type: UnitType, count: number) =>
    onChange({ ...counts, [type]: count });

  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      {types.map((type) => {
        const unit = unitOf(side, type);
        const count = counts[type] ?? 0;
        const stats = unit && describe(unit);
        return (
          <Group key={type} justify="space-between" wrap="nowrap">
            <Stack gap={0}>
              <Text size="sm" c={unit ? undefined : "dimmed"}>
                {unit?.name ?? UNIT_NAMES[type]}
              </Text>
              <Text size="xs" c="dimmed">
                {stats ?? "Needs its technology"}
              </Text>
            </Stack>
            <NumberStepper
              value={unit ? count : 0}
              decreaseDisabled={!unit || count <= 0}
              increaseDisabled={!unit || count >= limitOf(type)}
              decrease={() => set(type, count - 1)}
              increase={() => set(type, count + 1)}
            />
          </Group>
        );
      })}
    </Stack>
  );
}

/** "Combat 5 · Sustain" style summary of a unit's combat stats. */
function describe(unit: NonNullable<ReturnType<typeof unitFor>>) {
  const roll = (label: string, value?: number, dice?: number) =>
    value === undefined
      ? undefined
      : `${label} ${value}${dice && dice > 1 ? `×${dice}` : ""}`;
  return [
    roll("Combat", unit.combat, unit.combatDice),
    roll("AFB", unit.afb, unit.afbDice),
    roll("Bombard", unit.bombardment, unit.bombardmentDice),
    roll("Cannon", unit.spaceCannon, unit.spaceCannonDice),
    unit.sustainDamage ? "Sustain" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

// --- Results -----------------------------------------------------------------

function Results({
  odds,
  attacker,
  defender,
}: {
  odds: CombatOdds;
  attacker: FactionId;
  defender: FactionId;
}) {
  const segments = [
    {
      key: "attacker",
      label: `${factions[attacker].name} wins`,
      p: odds.attackerWins,
    },
    { key: "draw", label: "Both destroyed", p: odds.draw },
    {
      key: "defender",
      label: `${factions[defender].name} wins`,
      p: odds.defenderWins,
    },
  ] as const;

  return (
    <Stack gap="md">
      <Title order={4}>Outcome</Title>
      <Progress.Root size={32} radius="sm" style={{ gap: 2 }}>
        {segments
          .filter((s) => s.p > 0)
          .map((s) => (
            <Tooltip key={s.key} label={`${s.label}: ${percent(s.p)}`}>
              <Progress.Section value={s.p * 100} color={COLORS[s.key]}>
                {s.p >= 0.12 && <Progress.Label>{percent(s.p)}</Progress.Label>}
              </Progress.Section>
            </Tooltip>
          ))}
      </Progress.Root>
      <Group gap="lg" wrap="wrap">
        {segments.map((s) => (
          <Group key={s.key} gap={6} wrap="nowrap">
            <Box w={10} h={10} bg={COLORS[s.key]} style={{ borderRadius: 2 }} />
            <Text size="sm">
              {s.label}{" "}
              <Text span fw={700}>
                {percent(s.p)}
              </Text>
            </Text>
          </Group>
        ))}
      </Group>

      <div className={classes.columns}>
        <Survivors
          title={`${factions[attacker].name}: most likely survivors`}
          outcomes={odds.attackerSurvivors}
        />
        <Survivors
          title={`${factions[defender].name}: most likely survivors`}
          outcomes={odds.defenderSurvivors}
        />
      </div>
    </Stack>
  );
}

const SURVIVOR_ROWS = 6;

function Survivors({
  title,
  outcomes,
}: {
  title: string;
  outcomes: FleetOutcome[];
}) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {title}
      </Text>
      {outcomes.length === 0 ? (
        <Text size="sm" c="dimmed">
          Never survives.
        </Text>
      ) : (
        <Table striped withRowBorders={false} verticalSpacing={4}>
          <Table.Tbody>
            {outcomes.slice(0, SURVIVOR_ROWS).map((o, i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  <Text size="sm">{fleetLabel(o)}</Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Text size="sm" fw={600}>
                    {percent(o.probability)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {outcomes.length > SURVIVOR_ROWS && (
        <Text size="xs" c="dimmed">
          {outcomes.length - SURVIVOR_ROWS} less likely outcomes not shown.
        </Text>
      )}
    </Stack>
  );
}

function fleetLabel(outcome: FleetOutcome) {
  return (Object.entries(outcome.units) as [UnitType, number][])
    .map(([type, count]) => {
      const damaged = outcome.damaged[type] ?? 0;
      return `${count} ${UNIT_NAMES[type]}${damaged ? ` (${damaged} damaged)` : ""}`;
    })
    .join(", ");
}
