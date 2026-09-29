import { Badge, Button, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { isGroundForce, isShip, UNIT_NAMES } from "~/game/data";
import { CargoPickup, ShipMove } from "~/game/actions";
import {
  findRoute,
  MECATOL_REX,
  moveRulesFor,
  systemsWithUnits,
} from "~/game/engine/board";
import { countOf, totalUnits, unitOf } from "~/game/engine/helpers";
import { bombardmentTargets, describeSystem } from "~/game/engine/tactical";
import {
  Payment,
  SystemKey,
  TacticalAction,
  UnitCounts,
  UnitGroup,
  UnitType,
} from "~/game/types";
import { asState, GameView } from "~/game/view";
import { PlayerId } from "~/types";
import { useGame } from "../gameStore";
import {
  EMPTY_PRODUCTION,
  ProductionForm,
  ProductionValue,
} from "./forms";
import {
  EMPTY_PAYMENT,
  PaymentPicker,
  sortedUnitTypes,
  Stepper,
  UnitPicker,
} from "./shared";

type StepProps = {
  view: GameView;
  player: PlayerId;
  tactical: TacticalAction;
};

const isCargo = (type: UnitType) => type === "fighter" || isGroundForce(type);
const sum = (counts: UnitCounts) =>
  Object.values(counts).reduce((total, n) => total + (n ?? 0), 0);

// --- Movement ---------------------------------------------------------------

type Origin = {
  system: SystemKey;
  /** Ships that can reach the active system from here. */
  ships: UnitGroup;
};

function origins(view: GameView, player: PlayerId, target: SystemKey) {
  const state = asState(view);
  const rules = moveRulesFor(state, player, target);
  const gravityDrive = view.players[player].technologies.includes("gd");
  const result: Origin[] = [];
  for (const system of systemsWithUnits(state, player)) {
    if (system.key === target) continue;
    if (system.commandTokens.includes(player)) continue;
    const ships: UnitGroup = {};
    for (const type of sortedUnitTypes(system.space[player])) {
      const unit = unitOf(state, player, type);
      if (!isShip(type) || !unit?.move) continue;
      const reach = unit.move + (gravityDrive ? 1 : 0);
      if (!findRoute(state, system.key, reach, rules)) continue;
      ships[type] = system.space[player][type];
    }
    if (totalUnits(ships) > 0) result.push({ system: system.key, ships });
  }
  return result;
}

function Movement({ view, player, tactical }: StepProps) {
  const dispatch = useGame((state) => state.dispatch);
  const state = asState(view);
  const [ships, setShips] = useState<Record<SystemKey, UnitCounts>>({});
  const [cargo, setCargo] = useState<Record<string, UnitCounts>>({});
  const [boosted, setBoosted] = useState<string | null>(null);
  const available = origins(view, player, tactical.system);
  const gravityDrive = view.players[player].technologies.includes("gd");
  const active = view.systems[tactical.system];

  // Units can be lifted from where ships start and from the active system.
  const pickupSystems = [
    ...available.filter((o) => sum(ships[o.system] ?? {}) > 0).map((o) => o.system),
    tactical.system,
  ];
  const cargoKey = (system: SystemKey, planet?: string) =>
    `${system}|${planet ?? ""}`;

  const capacity = available.reduce(
    (total, origin) =>
      total +
      Object.entries(ships[origin.system] ?? {}).reduce(
        (subtotal, [type, count]) =>
          subtotal +
          (unitOf(state, player, type as UnitType)?.capacity ?? 0) *
            (count ?? 0),
        0,
      ),
    0,
  );
  const carried = Object.entries(cargo)
    .filter(([key]) => !key.startsWith(`${tactical.system}|`))
    .reduce((total, [, counts]) => total + sum(counts), 0);

  const submit = () => {
    const moves: ShipMove[] = [];
    for (const origin of available) {
      const chosen = { ...(ships[origin.system] ?? {}) };
      if (sum(chosen) === 0) continue;
      // Gravity Drive applies to one ship, which travels as its own move.
      const [boostSystem, boostType] = (boosted ?? "|").split("|");
      if (
        boostSystem === String(origin.system) &&
        (chosen[boostType as UnitType] ?? 0) > 0
      ) {
        chosen[boostType as UnitType]! -= 1;
        moves.push({
          from: origin.system,
          ships: { [boostType]: 1 },
          gravityDrive: true,
        });
      }
      if (sum(chosen) > 0) moves.push({ from: origin.system, ships: chosen });
    }
    const pickups: CargoPickup[] = Object.entries(cargo)
      .filter(([, counts]) => sum(counts) > 0)
      .map(([key, units]) => {
        const [system, planet] = key.split("|");
        return { system: Number(system), planet: planet || undefined, units };
      })
      .filter((pickup) => pickupSystems.includes(pickup.system));
    return dispatch({ type: "MOVE_SHIPS", moves, cargo: pickups });
  };

  return (
    <Stack gap="sm">
      <Text size="sm">
        Move ships into {describeSystem(state, tactical.system)}.
      </Text>
      {available.length === 0 && (
        <Text size="sm" c="dimmed">
          None of your ships can reach this system.
        </Text>
      )}
      {available.map((origin) => (
        <Stack key={origin.system} gap={4}>
          <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
            From {describeSystem(state, origin.system)}
          </Text>
          <UnitPicker
            available={origin.ships}
            value={ships[origin.system] ?? {}}
            onChange={(value) =>
              setShips({ ...ships, [origin.system]: value })
            }
          />
          {gravityDrive &&
            sortedUnitTypes(origin.ships)
              .filter((type) => (ships[origin.system]?.[type] ?? 0) > 0)
              .map((type) => (
                <Checkbox
                  key={type}
                  size="xs"
                  label={`Gravity Drive: +1 move for one ${UNIT_NAMES[type]}`}
                  checked={boosted === `${origin.system}|${type}`}
                  onChange={(event) =>
                    setBoosted(
                      event.currentTarget.checked
                        ? `${origin.system}|${type}`
                        : null,
                    )
                  }
                />
              ))}
        </Stack>
      ))}

      {pickupSystems.map((key) => {
        const system = view.systems[key];
        const sources: { planet?: string; group: UnitGroup | undefined }[] = [
          ...(key === tactical.system
            ? []
            : [{ group: system.space[player] }]),
          ...system.planets.map((planet) => ({
            planet,
            group: view.planets[planet].units[player],
          })),
        ].filter((source) => totalUnits(source.group, isCargo) > 0);
        if (sources.length === 0) return null;
        return (
          <Stack key={`cargo-${key}`} gap={4}>
            <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
              Pick up in {describeSystem(state, key)}
            </Text>
            {sources.map((source) => (
              <Stack key={source.planet ?? "space"} gap={2}>
                <Text size="xs" c="dimmed">
                  {source.planet ?? "Space area"}
                </Text>
                <UnitPicker
                  available={source.group}
                  filter={isCargo}
                  value={cargo[cargoKey(key, source.planet)] ?? {}}
                  onChange={(value) =>
                    setCargo({
                      ...cargo,
                      [cargoKey(key, source.planet)]: value,
                    })
                  }
                />
              </Stack>
            ))}
          </Stack>
        );
      })}

      {capacity > 0 && (
        <Badge variant="light" color={carried <= capacity ? "green" : "orange"}>
          Carrying {carried} of {capacity} capacity
        </Badge>
      )}
      {active.planets.length === 0 && totalUnits(active.space[player]) === 0 && (
        <Text size="xs" c="dimmed">
          This system has no planets.
        </Text>
      )}
      <Button onClick={submit}>
        {Object.values(ships).some((s) => sum(s) > 0)
          ? "Move"
          : "Move no ships"}
      </Button>
    </Stack>
  );
}

// --- Invasion ---------------------------------------------------------------

function Bombardment({ view, player, tactical }: StepProps) {
  const dispatch = useGame((state) => state.dispatch);
  const state = asState(view);
  const targets = bombardmentTargets(state, player);
  const group = view.systems[tactical.system].space[player];
  const units = sortedUnitTypes(group).filter(
    (type) => unitOf(state, player, type)?.bombardment !== undefined,
  );
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const used = (type: UnitType) =>
    targets.reduce((total, planet) => total + (chosen[`${type}|${planet}`] ?? 0), 0);

  return (
    <Stack gap="sm">
      <Text size="sm">Choose which planets your ships bombard.</Text>
      {targets.map((planet) => (
        <Stack key={planet} gap={4}>
          <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
            {planet}
          </Text>
          {units.map((type) => {
            const unit = unitOf(state, player, type)!;
            const key = `${type}|${planet}`;
            return (
              <Stepper
                key={key}
                label={`${UNIT_NAMES[type]} (hits on ${unit.bombardment}${
                  (unit.bombardmentDice ?? 1) > 1
                    ? `, ${unit.bombardmentDice} dice`
                    : ""
                })`}
                value={chosen[key] ?? 0}
                max={(chosen[key] ?? 0) + countOf(group, type) - used(type)}
                onChange={(count) => setChosen({ ...chosen, [key]: count })}
              />
            );
          })}
        </Stack>
      ))}
      <Group gap="xs">
        <Button
          onClick={() =>
            dispatch({
              type: "BOMBARD",
              targets: Object.entries(chosen)
                .filter(([, count]) => count > 0)
                .map(([key, count]) => {
                  const [unit, ...planet] = key.split("|");
                  return {
                    unit: unit as UnitType,
                    planet: planet.join("|"),
                    count,
                  };
                }),
            })
          }
        >
          Bombard
        </Button>
        <Button
          variant="default"
          onClick={() => dispatch({ type: "BOMBARD", targets: [] })}
        >
          Skip
        </Button>
      </Group>
    </Stack>
  );
}

function Commit({ view, player, tactical }: StepProps) {
  const dispatch = useGame((state) => state.dispatch);
  const system = view.systems[tactical.system];
  const group = system.space[player];
  const [landings, setLandings] = useState<Record<string, UnitCounts>>({});
  const [custodians, setCustodians] = useState<Payment>(EMPTY_PAYMENT);
  const landed = (type: UnitType) =>
    Object.values(landings).reduce((total, units) => total + (units[type] ?? 0), 0);
  const paysCustodians =
    view.custodians && sum(landings[MECATOL_REX] ?? {}) > 0;

  return (
    <Stack gap="sm">
      <Text size="sm">Commit ground forces to planets.</Text>
      {system.planets.map((planet) => {
        const controller = view.planets[planet].controller;
        return (
          <Stack key={planet} gap={4}>
            <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
              {planet}
              {controller !== undefined
                ? ` (${view.players[controller].name})`
                : " (uncontrolled)"}
            </Text>
            {sortedUnitTypes(group)
              .filter(isGroundForce)
              .map((type) => (
                <Stepper
                  key={type}
                  label={UNIT_NAMES[type]}
                  value={landings[planet]?.[type] ?? 0}
                  max={
                    (landings[planet]?.[type] ?? 0) +
                    countOf(group, type) -
                    landed(type)
                  }
                  onChange={(count) =>
                    setLandings({
                      ...landings,
                      [planet]: { ...landings[planet], [type]: count },
                    })
                  }
                />
              ))}
          </Stack>
        );
      })}
      {paysCustodians && (
        <>
          <Text size="xs" c="dimmed">
            Landing on Mecatol Rex removes the custodians token for 6
            influence and earns 1 victory point.
          </Text>
          <PaymentPicker
            view={view}
            player={player}
            currency="influence"
            cost={6}
            value={custodians}
            onChange={setCustodians}
          />
        </>
      )}
      <Group gap="xs">
        <Button
          disabled={Object.values(landings).every((units) => sum(units) === 0)}
          onClick={() =>
            dispatch({
              type: "COMMIT_GROUND_FORCES",
              landings: Object.entries(landings).map(([planet, units]) => ({
                planet,
                units,
              })),
              custodians: paysCustodians ? custodians : undefined,
            })
          }
        >
          Land
        </Button>
        <Button
          variant="default"
          onClick={() =>
            dispatch({ type: "COMMIT_GROUND_FORCES", landings: [] })
          }
        >
          Land nothing
        </Button>
      </Group>
    </Stack>
  );
}

// --- Production -------------------------------------------------------------

function Production({ view, player, tactical }: StepProps) {
  const dispatch = useGame((state) => state.dispatch);
  const [production, setProduction] =
    useState<ProductionValue>(EMPTY_PRODUCTION);
  return (
    <Stack gap="sm">
      <ProductionForm
        view={view}
        player={player}
        system={tactical.system}
        value={production}
        onChange={setProduction}
      />
      <Group gap="xs">
        <Button
          disabled={production.units.length === 0}
          onClick={() => dispatch({ type: "PRODUCE", ...production })}
        >
          Produce
        </Button>
        <Button
          variant="default"
          onClick={() => dispatch({ type: "PRODUCE", ...EMPTY_PRODUCTION })}
        >
          Produce nothing
        </Button>
      </Group>
    </Stack>
  );
}

const STEP_NAMES: Record<TacticalAction["step"], string> = {
  movement: "Movement",
  spaceCannonOffense: "Space cannon offense",
  spaceCombat: "Space combat",
  bombardment: "Bombardment",
  commit: "Commit ground forces",
  spaceCannonDefense: "Space cannon defense",
  groundCombat: "Ground combat",
  production: "Production",
  done: "Done",
};

export const tacticalStepName = (tactical: TacticalAction) =>
  STEP_NAMES[tactical.step];

/** The decision the active player owes at this step, if any. */
export function TacticalStep(props: StepProps) {
  switch (props.tactical.step) {
    case "movement":
      return <Movement {...props} />;
    case "bombardment":
      return <Bombardment {...props} />;
    case "commit":
      return <Commit {...props} />;
    case "production":
      return <Production {...props} />;
    default:
      return null;
  }
}
