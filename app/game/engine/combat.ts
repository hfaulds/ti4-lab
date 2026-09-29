import { PlayerId } from "~/types";
import { isGroundForce, isShip, UNIT_NAMES, UnitData } from "../data";
import { HitAssignment } from "../actions";
import {
  CombatRoll,
  Forces,
  GameState,
  HitSource,
  Prompt,
  SystemKey,
  UnitGroup,
  UnitType,
} from "../types";
import { capacityIn, dockFighterAllowance, systemOf } from "./board";
import {
  countOf,
  ensure,
  entries,
  hasTech,
  log,
  playerName,
  plural,
  removeUnits,
  rollDie,
  sumCounts,
  unitOf,
  unitTypes,
} from "./helpers";

type Ability = "combat" | "afb" | "bombardment" | "spaceCannon";

const abilityOf = (unit: UnitData, ability: Ability) => {
  switch (ability) {
    case "combat":
      return { target: unit.combat, dice: unit.combatDice ?? 1 };
    case "afb":
      return { target: unit.afb, dice: unit.afbDice ?? 1 };
    case "bombardment":
      return { target: unit.bombardment, dice: unit.bombardmentDice ?? 1 };
    case "spaceCannon":
      return { target: unit.spaceCannon, dice: unit.spaceCannonDice ?? 1 };
  }
};

export type Shooters = { type: UnitType; count: number }[];

export const shootersIn = (
  state: GameState,
  id: PlayerId,
  group: UnitGroup | undefined,
  ability: Ability,
  filter: (type: UnitType) => boolean = () => true,
): Shooters =>
  unitTypes(group)
    .filter(filter)
    .filter((type) => {
      const unit = unitOf(state, id, type);
      return unit && abilityOf(unit, ability).target !== undefined;
    })
    .map((type) => ({ type, count: countOf(group, type) }));

/**
 * Rolls an ability for a set of units. `modifier` is added to each die;
 * `bonusDice` extra dice go to the unit most likely to hit (Plasma Scoring).
 */
export function rollAbility(
  state: GameState,
  id: PlayerId,
  shooters: Shooters,
  ability: Ability,
  options: { modifier?: number; bonusDice?: number } = {},
): { rolls: CombatRoll[]; hits: number } {
  const modifier = options.modifier ?? 0;
  const plans = shooters
    .map(({ type, count }) => {
      const unit = unitOf(state, id, type)!;
      const { target, dice } = abilityOf(unit, ability);
      return { type, target: target!, dice: dice * count };
    })
    .filter((plan) => plan.dice > 0)
    .sort((a, b) => a.target - b.target);

  if (plans.length > 0) plans[0].dice += options.bonusDice ?? 0;

  const rolls = plans.map((plan) => {
    const dice = Array.from({ length: plan.dice }, () => rollDie(state));
    return {
      player: id,
      unit: plan.type,
      target: plan.target,
      dice,
      hits: dice.filter((d) => d + modifier >= plan.target).length,
    };
  });
  return { rolls, hits: rolls.reduce((sum, r) => sum + r.hits, 0) };
}

export const plasmaScoring = (state: GameState, id: PlayerId) =>
  hasTech(state, id, "ps") ? 1 : 0;

// --- Assigning hits ---------------------------------------------------------

const SPACE_SOURCES: HitSource[] = [
  "spaceCannonOffense",
  "antiFighterBarrage",
  "spaceCombat",
];

/** The units a set of hits can land on. */
export function hitTargets(
  state: GameState,
  prompt: Pick<
    Extract<Prompt, { kind: "assignHits" }>,
    "source" | "system" | "planet" | "player"
  >,
): { forces: Forces; eligible: (type: UnitType) => boolean } {
  if (SPACE_SOURCES.includes(prompt.source)) {
    return {
      forces: systemOf(state, prompt.system).space,
      eligible:
        prompt.source === "antiFighterBarrage"
          ? (type) => type === "fighter"
          : isShip,
    };
  }
  return {
    forces: state.planets[prompt.planet!].units,
    eligible: isGroundForce,
  };
}

const canSustain = (state: GameState, id: PlayerId, type: UnitType) =>
  !!unitOf(state, id, type)?.sustainDamage;

/** Most hits a group can soak up, by sustaining damage and then dying. */
export function absorbable(
  state: GameState,
  id: PlayerId,
  group: UnitGroup | undefined,
  eligible: (type: UnitType) => boolean,
  allowSustain: boolean,
) {
  return unitTypes(group)
    .filter(eligible)
    .reduce((sum, type) => {
      const stack = group![type]!;
      const sustains =
        allowSustain && canSustain(state, id, type)
          ? stack.count - stack.damaged
          : 0;
      return sum + stack.count + sustains;
    }, 0);
}

/**
 * A reasonable default: sustain damage wherever possible, then lose the
 * cheapest units first.
 */
export function suggestAssignment(
  state: GameState,
  prompt: Extract<Prompt, { kind: "assignHits" }>,
): HitAssignment {
  const { forces, eligible } = hitTargets(state, prompt);
  const group = forces[prompt.player];
  const allowSustain = prompt.source !== "antiFighterBarrage";
  const assignment: HitAssignment = { sustain: [], destroy: {} };
  let remaining = prompt.hits;

  const types = unitTypes(group).filter(eligible);
  if (allowSustain) {
    for (const type of types) {
      if (!canSustain(state, prompt.player, type)) continue;
      const stack = group![type]!;
      for (let i = stack.damaged; i < stack.count && remaining > 0; i++) {
        assignment.sustain.push(type);
        remaining--;
      }
    }
  }
  const byCost = [...types].sort(
    (a, b) =>
      (unitOf(state, prompt.player, a)?.cost ?? 0) -
      (unitOf(state, prompt.player, b)?.cost ?? 0),
  );
  for (const type of byCost) {
    const lost = Math.min(remaining, countOf(group, type));
    if (lost > 0) assignment.destroy[type] = lost;
    remaining -= lost;
  }
  return assignment;
}

export function applyHits(
  state: GameState,
  prompt: Extract<Prompt, { kind: "assignHits" }>,
  assignment: HitAssignment,
) {
  const id = prompt.player;
  const { forces, eligible } = hitTargets(state, prompt);
  const group = forces[id];
  const allowSustain = prompt.source !== "antiFighterBarrage";

  const sustained: Partial<Record<UnitType, number>> = {};
  for (const type of assignment.sustain) {
    sustained[type] = (sustained[type] ?? 0) + 1;
  }
  ensure(
    assignment.sustain.length === 0 || allowSustain,
    "SUSTAIN DAMAGE cannot cancel these hits.",
  );
  for (const [type, count] of entries(sustained)) {
    ensure(eligible(type), `${UNIT_NAMES[type]} cannot take these hits.`);
    ensure(
      canSustain(state, id, type),
      `${UNIT_NAMES[type]} cannot sustain damage.`,
    );
    const stack = group?.[type];
    ensure(
      stack && stack.count - stack.damaged >= count,
      `You do not have ${count} undamaged ${UNIT_NAMES[type]}.`,
    );
  }
  for (const [type, count] of entries(assignment.destroy)) {
    ensure(eligible(type), `${UNIT_NAMES[type]} cannot take these hits.`);
    ensure(
      countOf(group, type) >= count,
      `You do not have ${count} ${UNIT_NAMES[type]} there.`,
    );
  }

  const destroyed = sumCounts(assignment.destroy);
  const total = destroyed + assignment.sustain.length;
  const everything = unitTypes(group)
    .filter(eligible)
    .reduce((sum, type) => sum + countOf(group, type), 0);
  ensure(total <= prompt.hits, `Only ${plural(prompt.hits, "hit")} to assign.`);
  ensure(
    total === prompt.hits || destroyed === everything,
    `Assign all ${plural(prompt.hits, "hit")}, or lose every unit there.`,
  );

  for (const [type, count] of entries(sustained)) {
    group![type]!.damaged += count;
  }
  for (const [type, count] of entries(assignment.destroy)) {
    removeUnits(forces, id, type, count);
  }

  const parts = [
    ...entries(sustained).map(
      ([type, count]) => `${count} ${UNIT_NAMES[type]} sustained damage`,
    ),
    ...entries(assignment.destroy).map(
      ([type, count]) => `${count} ${UNIT_NAMES[type]} destroyed`,
    ),
  ];
  log(
    state,
    `${playerName(state, id)}: ${parts.length > 0 ? parts.join(", ") : "no losses"}.`,
    { player: id },
  );
}

/**
 * Removes fighters and ground forces a fleet can no longer carry, fighters
 * first (LRR 78.10a).
 */
export function removeExcessCargo(state: GameState, key: SystemKey, id: PlayerId) {
  const system = systemOf(state, key);
  const group = system.space[id];
  if (!group) return;
  const capacity = capacityIn(state, key, id);
  // Fighters covered by a space dock, or able to fly on their own, are safe.
  const independent = !!unitOf(state, id, "fighter")?.move;
  const carriedFighters = independent
    ? 0
    : Math.max(
        0,
        countOf(group, "fighter") - dockFighterAllowance(state, key, id),
      );
  const limits: [UnitType, number][] = [
    ["fighter", carriedFighters],
    ["infantry", countOf(group, "infantry")],
    ["mech", countOf(group, "mech")],
  ];
  let excess = limits.reduce((sum, [, count]) => sum + count, 0) - capacity;
  if (excess <= 0) return;

  const removed: string[] = [];
  for (const [type, removable] of limits) {
    const lost = Math.min(excess, removable);
    if (lost <= 0) continue;
    removeUnits(system.space, id, type, lost);
    removed.push(`${lost} ${UNIT_NAMES[type]}`);
    excess -= lost;
  }
  if (removed.length > 0) {
    log(
      state,
      `${playerName(state, id)} lost ${removed.join(", ")} with nothing left to carry them.`,
      { player: id },
    );
  }
}
