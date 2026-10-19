import { FactionId } from "~/types";
import {
  EXPANSIONS,
  Expansion,
  isGroundForce,
  isShip,
  UnitCounts,
  UnitData,
  UnitType,
  unitFor,
} from "../data";

/**
 * Exact combat odds, computed as a Markov chain rather than by simulation.
 *
 * Hits are always assigned the way `suggestAssignment` does it: sustain
 * damage wherever possible, then lose the cheapest units first. Because that
 * policy is greedy, a fleet that has taken `k` hits is the same whatever
 * rounds they arrived in, so each side's state is a single number and a
 * combat is a grid of (attacker hits taken, defender hits taken). Every
 * round moves strictly forward through that grid, so one pass in order
 * solves it.
 *
 * Player choices (retreats, action cards, promissory notes, leaders) are
 * ignored, as are abilities that would break the forward-only grid, such as
 * Duranium Armor repairs.
 */

export type OddsSide = {
  faction: FactionId;
  technologies?: string[];
  /** Units fighting: ships in space combat, ground forces on the ground. */
  units: UnitCounts;
  /** How many of `units` have already sustained damage. */
  damaged?: UnitCounts;
  /**
   * Units that fire before combat without taking part in it. In space, PDS
   * and other SPACE CANNON in range of the system. On the ground, the
   * attacker's ships in orbit (BOMBARDMENT) and the defender's structures on
   * the planet (SPACE CANNON defense and PLANETARY SHIELD).
   */
  support?: UnitCounts;
};

export type OddsOptions = {
  expansions?: Expansion[];
  /** The defender is in a nebula (+1 to their space combat rolls). */
  nebula?: boolean;
};

export type FleetOutcome = {
  units: UnitCounts;
  damaged: UnitCounts;
  probability: number;
};

export type CombatOdds = {
  attackerWins: number;
  defenderWins: number;
  /** Both sides destroyed. */
  draw: number;
  /** Every way the attacker can end with units left, most likely first. */
  attackerSurvivors: FleetOutcome[];
  defenderSurvivors: FleetOutcome[];
};

// --- Units -----------------------------------------------------------------

type Fleet = { units: UnitCounts; damaged: UnitCounts };

type Side = {
  stats: (type: UnitType) => UnitData | undefined;
  technologies: string[];
  /** Faction modifier to combat rolls (Unrelenting, Fragile). */
  combatModifier: number;
  fleet: Fleet;
  support: UnitCounts;
};

const COMBAT_MODIFIERS: Partial<Record<FactionId, number>> = {
  sardakk: 1,
  jolnar: -1,
};

function sideOf(input: OddsSide, expansions: Expansion[]): Side {
  const technologies = input.technologies ?? [];
  const cache = new Map<UnitType, UnitData | undefined>();
  const stats = (type: UnitType) => {
    if (!cache.has(type)) {
      cache.set(type, unitFor(input.faction, type, technologies, expansions));
    }
    return cache.get(type);
  };
  for (const type of typesIn(input.units)) {
    if (!stats(type)) throw new Error(`${input.faction} cannot field ${type}.`);
  }
  return {
    stats,
    technologies,
    combatModifier: COMBAT_MODIFIERS[input.faction] ?? 0,
    fleet: { units: { ...input.units }, damaged: { ...input.damaged } },
    support: input.support ?? {},
  };
}

const typesIn = (counts: UnitCounts) =>
  (Object.keys(counts) as UnitType[]).filter((type) => (counts[type] ?? 0) > 0);

const fleetKey = (fleet: Fleet) =>
  typesIn(fleet.units)
    .sort()
    .map((type) => `${type}${fleet.units[type]}/${fleet.damaged[type] ?? 0}`)
    .join(",");

const fleetSize = (fleet: Fleet, eligible: (type: UnitType) => boolean) =>
  typesIn(fleet.units)
    .filter(eligible)
    .reduce((sum, type) => sum + fleet.units[type]!, 0);

// --- Assigning hits --------------------------------------------------------

/**
 * The fleet after taking `hits`, following the same default as
 * `suggestAssignment`: sustain damage first, then lose the cheapest units
 * (weaker ones first among equals).
 */
function takeHits(
  side: Side,
  fleet: Fleet,
  hits: number,
  eligible: (type: UnitType) => boolean,
  allowSustain: boolean,
): Fleet {
  const units = { ...fleet.units };
  const damaged = { ...fleet.damaged };
  let remaining = hits;
  const types = typesIn(units).filter(eligible);

  if (allowSustain) {
    for (const type of types) {
      if (!side.stats(type)?.sustainDamage) continue;
      const fresh = units[type]! - (damaged[type] ?? 0);
      const used = Math.min(fresh, remaining);
      damaged[type] = (damaged[type] ?? 0) + used;
      remaining -= used;
    }
  }

  const unitCost = (type: UnitType) => {
    const unit = side.stats(type);
    return (unit?.cost ?? 0) / (unit?.producedPerCost ?? 1);
  };
  const byCost = [...types].sort(
    (a, b) =>
      unitCost(a) - unitCost(b) ||
      (side.stats(b)?.combat ?? 11) - (side.stats(a)?.combat ?? 11),
  );
  for (const type of byCost) {
    const lost = Math.min(remaining, units[type]!);
    units[type] = units[type]! - lost;
    // Damaged units are the ones worth losing; their sustain is spent.
    damaged[type] = Math.max(0, Math.min(damaged[type] ?? 0, units[type]!));
    remaining -= lost;
  }
  return { units, damaged };
}

/** Hits a fleet can soak up before every eligible unit is gone. */
function absorbable(
  side: Side,
  fleet: Fleet,
  eligible: (type: UnitType) => boolean,
  allowSustain: boolean,
) {
  return typesIn(fleet.units)
    .filter(eligible)
    .reduce((sum, type) => {
      const count = fleet.units[type]!;
      const sustains =
        allowSustain && side.stats(type)?.sustainDamage
          ? count - (fleet.damaged[type] ?? 0)
          : 0;
      return sum + count + sustains;
    }, 0);
}

// --- Rolling ---------------------------------------------------------------

type Ability = "combat" | "afb" | "bombardment" | "spaceCannon";

const DICE_FIELDS: Record<Ability, [keyof UnitData, keyof UnitData]> = {
  combat: ["combat", "combatDice"],
  afb: ["afb", "afbDice"],
  bombardment: ["bombardment", "bombardmentDice"],
  spaceCannon: ["spaceCannon", "spaceCannonDice"],
};

/** Chance one die hits, matching the engine: d10 + modifier >= target. */
const hitChance = (target: number, modifier: number) =>
  Math.min(10, Math.max(0, 11 - target + modifier)) / 10;

/** Distribution of total hits, index = hits. */
type Distribution = number[];

function binomial(dice: number, p: number): Distribution {
  let dist = [1];
  for (let i = 0; i < dice; i++) dist = convolve(dist, [1 - p, p]);
  return dist;
}

function convolve(a: Distribution, b: Distribution): Distribution {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

/**
 * Hit distribution for an ability roll. `bonusDice` go to the unit most
 * likely to hit (Plasma Scoring).
 */
function rollDistribution(
  side: Side,
  units: UnitCounts,
  ability: Ability,
  filter: (type: UnitType) => boolean,
  options: { modifier?: number; bonusDice?: number } = {},
): Distribution {
  const [targetField, diceField] = DICE_FIELDS[ability];
  const plans = typesIn(units)
    .filter(filter)
    .map((type) => {
      const unit = side.stats(type);
      const target = unit?.[targetField] as number | undefined;
      const dice =
        ((unit?.[diceField] as number | undefined) ?? 1) * units[type]!;
      return { target, dice };
    })
    .filter(
      (plan): plan is { target: number; dice: number } =>
        plan.target !== undefined && plan.dice > 0,
    )
    .sort((a, b) => a.target - b.target);
  if (plans.length > 0) plans[0].dice += options.bonusDice ?? 0;

  const modifier = options.modifier ?? 0;
  return plans.reduce(
    (dist, plan) =>
      convolve(dist, binomial(plan.dice, hitChance(plan.target, modifier))),
    [1] as Distribution,
  );
}

const plasmaScoring = (side: Side) =>
  side.technologies.includes("ps") ? 1 : 0;

// --- Fleet distributions ---------------------------------------------------

type FleetDistribution = Map<string, { fleet: Fleet; p: number }>;

const certain = (fleet: Fleet): FleetDistribution =>
  new Map([[fleetKey(fleet), { fleet, p: 1 }]]);

/** Applies a hit distribution to every fleet in a distribution. */
function applyDistribution(
  side: Side,
  fleets: FleetDistribution,
  hits: Distribution,
  eligible: (type: UnitType) => boolean,
  allowSustain: boolean,
): FleetDistribution {
  const out: FleetDistribution = new Map();
  for (const { fleet, p } of fleets.values()) {
    hits.forEach((ph, k) => {
      if (ph === 0) return;
      const next = takeHits(side, fleet, k, eligible, allowSustain);
      const key = fleetKey(next);
      const entry = out.get(key);
      if (entry) entry.p += p * ph;
      else out.set(key, { fleet: next, p: p * ph });
    });
  }
  return out;
}

// --- The combat grid -------------------------------------------------------

type Combatant = {
  side: Side;
  eligible: (type: UnitType) => boolean;
  modifier: number;
};

/**
 * Exact result of rounds of combat between two starting fleets. The state
 * (i, j) is attacker having taken i hits and defender j hits.
 */
function solveGrid(
  attacker: Combatant,
  defender: Combatant,
  startA: Fleet,
  startD: Fleet,
  add: (a: Fleet, d: Fleet, p: number) => void,
) {
  const sequence = ({ side, eligible }: Combatant, start: Fleet) => {
    const length = absorbable(side, start, eligible, true);
    return Array.from({ length: length + 1 }, (_, k) =>
      takeHits(side, start, k, eligible, true),
    );
  };
  const seqA = sequence(attacker, startA);
  const seqD = sequence(defender, startD);
  const lastA = seqA.length - 1;
  const lastD = seqD.length - 1;

  const hitsOf = (c: Combatant, fleet: Fleet) =>
    rollDistribution(c.side, fleet.units, "combat", c.eligible, {
      modifier: c.modifier + c.side.combatModifier,
    });
  const hitsA = seqA.map((fleet) => hitsOf(attacker, fleet));
  const hitsD = seqD.map((fleet) => hitsOf(defender, fleet));

  /** Hits capped at what the target can still take. */
  const capped = (dist: Distribution, room: number) => {
    const out = dist.slice(0, room + 1);
    for (let k = room + 1; k < dist.length; k++) out[room] += dist[k];
    return out;
  };

  const grid = Array.from({ length: lastA + 1 }, () =>
    new Array<number>(lastD + 1).fill(0),
  );
  grid[0][0] = 1;
  for (let i = 0; i <= lastA; i++) {
    for (let j = 0; j <= lastD; j++) {
      const p = grid[i][j];
      if (p === 0) continue;
      if (i === lastA || j === lastD) {
        add(seqA[i], seqD[j], p);
        continue;
      }
      // Hits dealt by each side this round.
      const fromA = capped(hitsA[i], lastD - j);
      const fromD = capped(hitsD[j], lastA - i);
      const stall = fromA[0] * fromD[0];
      if (stall >= 1) throw new Error("Neither side can score a hit.");
      // Rounds where nobody hits change nothing, so divide them out.
      const scale = p / (1 - stall);
      for (let l = 0; l < fromD.length; l++) {
        for (let k = 0; k < fromA.length; k++) {
          if (k === 0 && l === 0) continue;
          grid[i + l][j + k] += scale * fromD[l] * fromA[k];
        }
      }
    }
  }
}

function resolve(
  attacker: Combatant,
  defender: Combatant,
  fleetsA: FleetDistribution,
  fleetsD: FleetDistribution,
): CombatOdds {
  const odds = { attackerWins: 0, defenderWins: 0, draw: 0 };
  const survivorsA = new Map<string, FleetOutcome>();
  const survivorsD = new Map<string, FleetOutcome>();
  const record = (into: Map<string, FleetOutcome>, fleet: Fleet, p: number) => {
    const key = fleetKey(fleet);
    const entry = into.get(key);
    if (entry) entry.probability += p;
    else into.set(key, { ...trimmed(fleet), probability: p });
  };

  for (const a of fleetsA.values()) {
    for (const d of fleetsD.values()) {
      solveGrid(attacker, defender, a.fleet, d.fleet, (fa, fd, p) => {
        const prob = a.p * d.p * p;
        const aliveA = fleetSize(fa, attacker.eligible) > 0;
        const aliveD = fleetSize(fd, defender.eligible) > 0;
        if (aliveA) record(survivorsA, fa, prob);
        if (aliveD) record(survivorsD, fd, prob);
        if (aliveA) odds.attackerWins += prob;
        else if (aliveD) odds.defenderWins += prob;
        else odds.draw += prob;
      });
    }
  }
  const sorted = (m: Map<string, FleetOutcome>) =>
    [...m.values()].sort((x, y) => y.probability - x.probability);
  return {
    ...odds,
    attackerSurvivors: sorted(survivorsA),
    defenderSurvivors: sorted(survivorsD),
  };
}

const trimmed = (fleet: Fleet): Fleet => {
  const units: UnitCounts = {};
  const damaged: UnitCounts = {};
  for (const type of typesIn(fleet.units)) {
    units[type] = fleet.units[type];
    if (fleet.damaged[type]) damaged[type] = fleet.damaged[type];
  }
  return { units, damaged };
};

// --- Public API ------------------------------------------------------------

const allExpansions = () => EXPANSIONS.map((e) => e.id);

/**
 * Odds of a space combat: SPACE CANNON offense, then ANTI-FIGHTER BARRAGE,
 * then rounds of combat until one side has no ships left.
 */
export function spaceCombatOdds(
  attackerInput: OddsSide,
  defenderInput: OddsSide,
  options: OddsOptions = {},
): CombatOdds {
  const expansions = options.expansions ?? allExpansions();
  const attacker = sideOf(attackerInput, expansions);
  const defender = sideOf(defenderInput, expansions);
  const ships = (fleet: Fleet): Fleet => {
    const units: UnitCounts = {};
    for (const type of typesIn(fleet.units).filter(isShip)) {
      units[type] = fleet.units[type];
    }
    return { units, damaged: fleet.damaged };
  };
  let fleetsA = certain(ships(attacker.fleet));
  let fleetsD = certain(ships(defender.fleet));

  // SPACE CANNON offense. Antimass Deflectors make the target harder to hit.
  const cannon = (shooter: Side, target: Side) =>
    rollDistribution(shooter, shooter.support, "spaceCannon", () => true, {
      modifier: target.technologies.includes("amd") ? -1 : 0,
      bonusDice: plasmaScoring(shooter),
    });
  const cannonAtA = cannon(defender, attacker);
  const cannonAtD = cannon(attacker, defender);
  fleetsA = applyDistribution(attacker, fleetsA, cannonAtA, isShip, true);
  fleetsD = applyDistribution(defender, fleetsD, cannonAtD, isShip, true);

  // ANTI-FIGHTER BARRAGE, rolled by whatever survived the cannons.
  const isFighter = (type: UnitType) => type === "fighter";
  const barrage = (
    shooterSide: Side,
    shooters: FleetDistribution,
    target: Side,
    targets: FleetDistribution,
  ) => {
    const out: FleetDistribution = new Map();
    for (const { fleet, p } of shooters.values()) {
      const hits = rollDistribution(
        shooterSide,
        fleet.units,
        "afb",
        () => true,
      );
      for (const [key, entry] of applyDistribution(
        target,
        targets,
        hits,
        isFighter,
        false,
      )) {
        const existing = out.get(key);
        if (existing) existing.p += p * entry.p;
        else out.set(key, { fleet: entry.fleet, p: p * entry.p });
      }
    }
    return out;
  };
  // Both barrages are simultaneous, so each uses the other's pre-barrage fleet.
  const afterA = barrage(defender, fleetsD, attacker, fleetsA);
  const afterD = barrage(attacker, fleetsA, defender, fleetsD);

  return resolve(
    { side: attacker, eligible: isShip, modifier: 0 },
    { side: defender, eligible: isShip, modifier: options.nebula ? 1 : 0 },
    afterA,
    afterD,
  );
}

/**
 * Odds of a ground combat on one planet: BOMBARDMENT (unless a PLANETARY
 * SHIELD stops it), SPACE CANNON defense, then rounds of combat.
 */
export function groundCombatOdds(
  attackerInput: OddsSide,
  defenderInput: OddsSide,
  options: Omit<OddsOptions, "nebula"> = {},
): CombatOdds {
  const expansions = options.expansions ?? allExpansions();
  const attacker = sideOf(attackerInput, expansions);
  const defender = sideOf(defenderInput, expansions);
  const ground = (fleet: Fleet): Fleet => {
    const units: UnitCounts = {};
    for (const type of typesIn(fleet.units).filter(isGroundForce)) {
      units[type] = fleet.units[type];
    }
    return { units, damaged: fleet.damaged };
  };
  let fleetsA = certain(ground(attacker.fleet));
  let fleetsD = certain(ground(defender.fleet));

  const shielded =
    typesIn(defender.support).some((t) => defender.stats(t)?.planetaryShield) &&
    !typesIn(attacker.support).some(
      (t) => attacker.stats(t)?.disablesPlanetaryShield,
    );
  if (!shielded) {
    const bombardment = rollDistribution(
      attacker,
      attacker.support,
      "bombardment",
      () => true,
      { bonusDice: plasmaScoring(attacker) },
    );
    fleetsD = applyDistribution(
      defender,
      fleetsD,
      bombardment,
      isGroundForce,
      true,
    );
  }

  const cannonDefense = rollDistribution(
    defender,
    defender.support,
    "spaceCannon",
    () => true,
    {
      modifier: attacker.technologies.includes("amd") ? -1 : 0,
      bonusDice: plasmaScoring(defender),
    },
  );
  fleetsA = applyDistribution(
    attacker,
    fleetsA,
    cannonDefense,
    isGroundForce,
    true,
  );

  return resolve(
    { side: attacker, eligible: isGroundForce, modifier: 0 },
    { side: defender, eligible: isGroundForce, modifier: 0 },
    fleetsA,
    fleetsD,
  );
}
