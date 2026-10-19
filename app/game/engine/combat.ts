import { FactionId, PlayerId } from "~/types";
import { isGroundForce, isShip, UNIT_NAMES, UnitData } from "../data";
import { HitAssignment } from "../actions";
import {
  CombatEffects,
  CombatRoll,
  Forces,
  GameState,
  HitSource,
  Prompt,
  SystemKey,
  UnitGroup,
  UnitType,
} from "../types";
import {
  capacityIn,
  dockFighterAllowance,
  fleetLimit,
  fleetProblem,
  nonFighterShips,
  systemOf,
} from "./board";
import { achieve, destroyUnits } from "./effects/helpers";
import {
  countOf,
  ensure,
  entries,
  hasGroundForces,
  hasTech,
  log,
  playerName,
  plural,
  removeUnits,
  rollDie,
  sumCounts,
  totalUnits,
  unitOf,
  unitTypes,
} from "./helpers";
import { openWindow } from "./reactions";

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

/** Faction modifiers to every combat roll (Unrelenting, Fragile). */
export const FACTION_COMBAT_MODIFIERS: Partial<Record<FactionId, number>> = {
  sardakk: 1,
  jolnar: -1,
};

export type RollOptions = {
  /** Added to every die. */
  modifier?: number;
  /** Extra dice for the unit most likely to hit (Plasma Scoring). */
  bonusDice?: number;
  /** Added to the dice of one unit type. */
  unitModifier?: (type: UnitType) => number;
  /** Replaces the number of dice a unit type rolls per unit. */
  diceFor?: (type: UnitType) => number | undefined;
};

/**
 * Rolls an ability for a set of units. `modifier` is added to each die, along
 * with the faction's modifier on combat rolls; `bonusDice` extra dice go to
 * the unit most likely to hit (Plasma Scoring).
 */
export function rollAbility(
  state: GameState,
  id: PlayerId,
  shooters: Shooters,
  ability: Ability,
  options: RollOptions = {},
): { rolls: CombatRoll[]; hits: number } {
  const faction =
    ability === "combat"
      ? (FACTION_COMBAT_MODIFIERS[state.players[id].faction] ?? 0)
      : 0;
  const modifier = (options.modifier ?? 0) + faction;
  const plans = shooters
    .map(({ type, count }) => {
      const unit = unitOf(state, id, type)!;
      const { target, dice } = abilityOf(unit, ability);
      const perUnit = options.diceFor?.(type) ?? dice;
      return { type, target: target!, dice: perUnit * count };
    })
    .filter((plan) => plan.dice > 0)
    .sort((a, b) => a.target - b.target);

  if (plans.length > 0) plans[0].dice += options.bonusDice ?? 0;

  const rolls = plans.map((plan): CombatRoll => {
    const dice = Array.from({ length: plan.dice }, () => rollDie(state));
    const roll: CombatRoll = {
      player: id,
      unit: plan.type,
      target: plan.target,
      dice,
      hits: 0,
      modifier: modifier + (options.unitModifier?.(plan.type) ?? 0),
    };
    roll.hits = rollHits(state, roll);
    return roll;
  });
  return { rolls, hits: rolls.reduce((sum, r) => sum + r.hits, 0) };
}

/**
 * Hits from one roll: each die plus its modifier against the target, and
 * two more for each natural 9 or 10 the Jol-Nar flagship rolls.
 */
export function rollHits(state: GameState, roll: CombatRoll) {
  const modifier = roll.modifier ?? 0;
  let hits = roll.dice.filter((d) => d + modifier >= roll.target).length;
  if (
    roll.unit === "flagship" &&
    unitOf(state, roll.player, "flagship")?.id === "jolnar_flagship"
  ) {
    hits += 2 * roll.dice.filter((d) => d >= 9).length;
  }
  return hits;
}

/** Rerolls dice that missed; `filter` limits which rolls are rerolled. */
export function rerollMisses(
  state: GameState,
  rolls: CombatRoll[],
  filter: (roll: CombatRoll) => boolean,
  onMiss?: (roll: CombatRoll) => void,
) {
  for (const roll of rolls) {
    if (!filter(roll)) continue;
    const modifier = roll.modifier ?? 0;
    roll.dice = roll.dice.map((d) => {
      if (d + modifier >= roll.target) return d;
      const again = rollDie(state);
      if (again + modifier < roll.target) onMiss?.(roll);
      return again;
    });
    roll.hits = rollHits(state, roll);
  }
}

/** Rerolls every die in the rolls (War Funding against an opponent). */
export function rerollAll(state: GameState, rolls: CombatRoll[]) {
  for (const roll of rolls) {
    roll.dice = roll.dice.map(() => rollDie(state));
    roll.hits = rollHits(state, roll);
  }
}

export const plasmaScoring = (state: GameState, id: PlayerId) =>
  hasTech(state, id, "ps") ? 1 : 0;

export const combatFlag = (combat: CombatEffects | undefined, flag: string, id: PlayerId) =>
  !!combat?.flags?.includes(`${flag}:${id}`);

export function setCombatFlag(combat: CombatEffects, flag: string, id: PlayerId) {
  (combat.flags ??= []).push(`${flag}:${id}`);
}

/** The combat in progress, ground before space. */
export const currentCombat = (state: GameState) =>
  state.tactical?.groundCombat ?? state.tactical?.spaceCombat;

// --- Assigning hits ---------------------------------------------------------

const SPACE_SOURCES: HitSource[] = [
  "spaceCannonOffense",
  "antiFighterBarrage",
  "spaceCombat",
  "destroyShips",
  "destroyNonFighterShips",
];

/** Units the Nekro flagship lets fight as ships (ground forces in space). */
const alastorFights = (state: GameState, id: PlayerId) =>
  combatFlag(state.tactical?.spaceCombat, "alastor", id);

/** Fighters the Naalu flagship lets fight on a planet. */
export const naaluFightersLand = (state: GameState, id: PlayerId, system: SystemKey) =>
  countOf(systemOf(state, system).space[id], "flagship") > 0 &&
  unitOf(state, id, "flagship")?.id === "naalu_flagship";

/** The units a set of hits can land on. */
export function hitTargets(
  state: GameState,
  prompt: Pick<
    Extract<Prompt, { kind: "assignHits" }>,
    "source" | "system" | "planet" | "player"
  >,
): { forces: Forces; eligible: (type: UnitType) => boolean } {
  if (SPACE_SOURCES.includes(prompt.source)) {
    const ships =
      prompt.source === "spaceCombat" && alastorFights(state, prompt.player)
        ? (type: UnitType) => isShip(type) || isGroundForce(type)
        : isShip;
    return {
      forces: systemOf(state, prompt.system).space,
      eligible:
        prompt.source === "antiFighterBarrage"
          ? (type) => type === "fighter"
          : prompt.source === "destroyNonFighterShips"
            ? (type) => isShip(type) && type !== "fighter"
            : ships,
    };
  }
  const forces = state.planets[prompt.planet!].units;
  // Naalu fighters committed to a planet fight there as ground forces.
  const fighters = countOf(forces[prompt.player], "fighter") > 0;
  return {
    forces,
    eligible: fighters
      ? (type) => isGroundForce(type) || type === "fighter"
      : isGroundForce,
  };
}

/** Whether a source's hits can be cancelled with SUSTAIN DAMAGE at all. */
const sustainAllowed = (source: HitSource) =>
  source !== "antiFighterBarrage" &&
  source !== "destroyShips" &&
  source !== "destroyNonFighterShips";

/**
 * Whether a unit can use SUSTAIN DAMAGE where it is: not war suns under
 * Publicize Weapon Schematics, not ships facing the Mentak flagship.
 */
export function canSustain(
  state: GameState,
  id: PlayerId,
  type: UnitType,
  system?: SystemKey,
) {
  if (!unitOf(state, id, type)?.sustainDamage) return false;
  if (
    type === "warsun" &&
    state.laws.some((law) => law.id === "schematics" && law.outcome !== "Against")
  ) {
    return false;
  }
  if (system !== undefined && isShip(type)) {
    const space = systemOf(state, system).space;
    const mentak = Object.keys(space)
      .map(Number)
      .some(
        (other) =>
          other !== id &&
          countOf(space[other], "flagship") > 0 &&
          unitOf(state, other, "flagship")?.id === "mentak_flagship",
      );
    if (mentak) return false;
  }
  return true;
}

/** Hits one use of SUSTAIN DAMAGE cancels: 2 with Non-Euclidean Shielding. */
export const hitsPerSustain = (state: GameState, id: PlayerId) =>
  hasTech(state, id, "nes") ? 2 : 1;

/** Most hits a group can soak up, by sustaining damage and then dying. */
export function absorbable(
  state: GameState,
  id: PlayerId,
  group: UnitGroup | undefined,
  eligible: (type: UnitType) => boolean,
  allowSustain: boolean,
  system?: SystemKey,
) {
  return unitTypes(group)
    .filter(eligible)
    .reduce((sum, type) => {
      const stack = group![type]!;
      const sustains =
        allowSustain && canSustain(state, id, type, system)
          ? (stack.count - stack.damaged) * hitsPerSustain(state, id)
          : 0;
      return sum + stack.count + sustains;
    }, 0);
}

/**
 * A reasonable default: sustain damage wherever possible, then lose the
 * cheapest units first, sending the hits that must go to non-fighter ships
 * there.
 */
export function suggestAssignment(
  state: GameState,
  prompt: Extract<Prompt, { kind: "assignHits" }>,
): HitAssignment {
  const { forces, eligible } = hitTargets(state, prompt);
  const group = forces[prompt.player];
  const allowSustain = sustainAllowed(prompt.source);
  const space = SPACE_SOURCES.includes(prompt.source) ? prompt.system : undefined;
  const assignment: HitAssignment = { sustain: [], destroy: {} };
  const perSustain = hitsPerSustain(state, prompt.player);
  let remaining = prompt.hits;

  const types = unitTypes(group).filter(eligible);
  if (allowSustain) {
    for (const type of types) {
      if (!canSustain(state, prompt.player, type, space)) continue;
      const stack = group![type]!;
      for (let i = stack.damaged; i < stack.count && remaining > 0; i++) {
        assignment.sustain.push(type);
        remaining -= perSustain;
      }
    }
  }
  remaining = Math.max(0, remaining);
  const cost = (type: UnitType) => unitOf(state, prompt.player, type)?.cost ?? 0;
  // Hits that must find a non-fighter ship skip the fighters.
  let nonFighter = Math.max(0, (prompt.nonFighter ?? 0) - assignment.sustain.length);
  const byCost = [...types].sort((a, b) => cost(a) - cost(b));
  const destroy = (type: UnitType, count: number) => {
    const lost = Math.min(count, countOf(group, type) - (assignment.destroy[type] ?? 0));
    if (lost <= 0) return 0;
    assignment.destroy[type] = (assignment.destroy[type] ?? 0) + lost;
    remaining -= lost;
    return lost;
  };
  for (const type of byCost) {
    if (nonFighter <= 0 || remaining <= 0) break;
    if (!isShip(type) || type === "fighter") continue;
    nonFighter -= destroy(type, Math.min(nonFighter, remaining));
  }
  for (const type of byCost) {
    if (remaining <= 0) break;
    destroy(type, remaining);
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
  const allowSustain = sustainAllowed(prompt.source);
  const space = SPACE_SOURCES.includes(prompt.source) ? prompt.system : undefined;
  const nonFighterBefore = totalUnits(
    systemOf(state, prompt.system).space[id],
    (type) => isShip(type) && type !== "fighter",
  );

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
      canSustain(state, id, type, space),
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
  const perSustain = hitsPerSustain(state, id);
  const cancelled = assignment.sustain.length * perSustain;
  const total = destroyed + cancelled;
  const everything = unitTypes(group)
    .filter(eligible)
    .reduce((sum, type) => sum + countOf(group, type), 0);
  ensure(
    destroyed + assignment.sustain.length <= prompt.hits,
    `Only ${plural(prompt.hits, "hit")} to assign.`,
  );
  ensure(
    total >= prompt.hits || destroyed === everything,
    `Assign all ${plural(prompt.hits, "hit")}, or lose every unit there.`,
  );
  if (prompt.nonFighter) {
    const onCapitalShips =
      assignment.sustain.filter((t) => isShip(t) && t !== "fighter").length +
      entries(assignment.destroy)
        .filter(([t]) => isShip(t) && t !== "fighter")
        .reduce((sum, [, n]) => sum + n, 0);
    const possible = Math.min(prompt.nonFighter, nonFighterBefore);
    ensure(
      onCapitalShips >= possible,
      `${plural(possible, "hit")} must be assigned to non-fighter ships.`,
    );
  }

  for (const [type, count] of entries(sustained)) {
    group![type]!.damaged += count;
  }
  const where = { system: prompt.system, planet: space === undefined ? prompt.planet : undefined };
  for (const [type, count] of entries(assignment.destroy)) {
    destroyUnits(state, id, where, type, count, prompt.from);
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
  afterHits(state, prompt, sustained, assignment, nonFighterBefore);
}

/** Objectives and windows that follow units being damaged or destroyed. */
function afterHits(
  state: GameState,
  prompt: Extract<Prompt, { kind: "assignHits" }>,
  sustained: Partial<Record<UnitType, number>>,
  assignment: HitAssignment,
  nonFighterBefore: number,
) {
  const id = prompt.player;
  const from = prompt.from;
  const system = systemOf(state, prompt.system);
  const combat = currentCombat(state);

  if (combat && entries(assignment.destroy).length > 0) {
    combat.destroyed = [
      ...(combat.destroyed ?? []),
      ...entries(assignment.destroy).map(([type]) => type),
    ];
  }
  if (from === undefined) return;

  // Turn Their Fleets to Dust
  const nonFighterAfter = totalUnits(
    system.space[id],
    (type) => isShip(type) && type !== "fighter",
  );
  if (
    prompt.source === "spaceCannonOffense" &&
    nonFighterBefore > 0 &&
    nonFighterAfter === 0
  ) {
    achieve(state, from, "ttfd");
  }
  // Make an Example of Their World
  if (
    prompt.source === "bombardment" &&
    prompt.planet &&
    !hasGroundForces(state.planets[prompt.planet].units[id])
  ) {
    achieve(state, from, "mew");
  }

  // Direct Hit: a ship that just sustained damage can be finished off.
  for (const [type, count] of entries(sustained)) {
    if (!isShip(type) || !SPACE_SOURCES.includes(prompt.source)) continue;
    openWindow(
      state,
      "afterSustain",
      { player: id, unit: type, system: prompt.system, amount: count },
      [from],
    );
  }
  const destroyedShips = entries(assignment.destroy).filter(([type]) => isShip(type));
  if (prompt.source === "spaceCombat" && destroyedShips.length > 0) {
    // Courageous to the End uses the best combat value among the losses.
    const best = destroyedShips
      .map(([type]) => type)
      .sort(
        (a, b) =>
          (unitOf(state, id, a)?.combat ?? 10) - (unitOf(state, id, b)?.combat ?? 10),
      )[0];
    openWindow(
      state,
      "afterShipDestroyed",
      { player: from, unit: best, system: prompt.system },
      [id],
    );
  }
  if (combat && entries(assignment.destroy).length > 0) {
    // Technological Singularity
    openWindow(state, "afterUnitDestroyed", { player: id, system: prompt.system }, [from]);
  }
}

/** Brings every fleet of a player back within supply after their fleet pool shrinks. */
export function enforceFleetSupply(state: GameState, id: PlayerId) {
  for (const system of Object.values(state.systems)) {
    if (fleetProblem(state, system.key, id)) removeExcessShips(state, system.key, id);
  }
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

/**
 * Removes ships beyond what the fleet pool supports, cheapest first, then the
 * cargo the remaining ships can no longer carry (LRR 37.3). Players would
 * choose which ships to lose; the engine picks the cheapest for them.
 */
export function removeExcessShips(state: GameState, key: SystemKey, id: PlayerId) {
  const system = systemOf(state, key);
  const removed: string[] = [];
  const lose = (type: UnitType, count: number) => {
    if (count <= 0) return;
    removeUnits(system.space, id, type, count);
    removed.push(`${count} ${UNIT_NAMES[type]}`);
  };

  let excess = nonFighterShips(state, key, id) - fleetLimit(state, id);
  if (excess > 0) {
    const byCost = unitTypes(system.space[id])
      .filter((type) => isShip(type) && type !== "fighter")
      .sort(
        (a, b) => (unitOf(state, id, a)?.cost ?? 0) - (unitOf(state, id, b)?.cost ?? 0),
      );
    for (const type of byCost) {
      const lost = Math.min(excess, countOf(system.space[id], type));
      lose(type, lost);
      excess -= lost;
    }
  }
  if (removed.length > 0) {
    log(
      state,
      `${playerName(state, id)} removed ${removed.join(", ")} over their fleet pool.`,
      { player: id },
    );
  }
  removeExcessCargo(state, key, id);
  // Fighters that fly on their own count against the fleet pool too.
  let fighters = 0;
  while (fleetProblem(state, key, id) && countOf(system.space[id], "fighter") > 0) {
    removeUnits(system.space, id, "fighter", 1);
    fighters++;
  }
  if (fighters > 0) {
    log(
      state,
      `${playerName(state, id)} removed ${fighters} ${UNIT_NAMES.fighter} over their fleet pool.`,
      { player: id },
    );
  }
}
