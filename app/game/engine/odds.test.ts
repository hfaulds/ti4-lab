import { describe, expect, test } from "vitest";
import { FactionId } from "~/types";
import {
  isGroundForce,
  isShip,
  UnitCounts,
  UnitData,
  UnitType,
  unitFor,
  EXPANSIONS,
} from "../data";
import {
  CombatOdds,
  groundCombatOdds,
  OddsSide,
  spaceCombatOdds,
} from "./odds";

const total = (odds: CombatOdds) =>
  odds.attackerWins + odds.defenderWins + odds.draw;

const hacan = (units: UnitCounts, extra: Partial<OddsSide> = {}): OddsSide => ({
  faction: "hacan",
  units,
  ...extra,
});

describe("spaceCombatOdds", () => {
  test("one destroyer each matches the closed form", () => {
    const odds = spaceCombatOdds(
      hacan({ destroyer: 1 }),
      hacan({ destroyer: 1 }),
    );
    // p = 0.2 a round each; nobody-hits rounds are divided out.
    const stall = 0.8 * 0.8;
    expect(odds.attackerWins).toBeCloseTo((0.2 * 0.8) / (1 - stall), 10);
    expect(odds.defenderWins).toBeCloseTo((0.2 * 0.8) / (1 - stall), 10);
    expect(odds.draw).toBeCloseTo((0.2 * 0.2) / (1 - stall), 10);
  });

  test("probabilities sum to one and survivors add up to the wins", () => {
    const odds = spaceCombatOdds(
      hacan({ dreadnought: 2, carrier: 1, fighter: 3 }),
      hacan({ cruiser: 2, destroyer: 2, fighter: 2 }, { support: { pds: 1 } }),
    );
    expect(total(odds)).toBeCloseTo(1, 10);
    const sum = (list: CombatOdds["attackerSurvivors"]) =>
      list.reduce((s, o) => s + o.probability, 0);
    expect(sum(odds.attackerSurvivors)).toBeCloseTo(odds.attackerWins, 10);
    expect(sum(odds.defenderSurvivors)).toBeCloseTo(odds.defenderWins, 10);
  });

  test("an undefended system is won outright", () => {
    const odds = spaceCombatOdds(hacan({ cruiser: 1 }), hacan({}));
    expect(odds.attackerWins).toBe(1);
    expect(odds.attackerSurvivors).toEqual([
      { units: { cruiser: 1 }, damaged: {}, probability: 1 },
    ]);
  });

  test("unit upgrades and faction abilities shift the odds", () => {
    const base = spaceCombatOdds(hacan({ cruiser: 2 }), hacan({ cruiser: 2 }));
    const upgraded = spaceCombatOdds(
      hacan({ cruiser: 2 }, { technologies: ["cr2"] }),
      hacan({ cruiser: 2 }),
    );
    expect(base.attackerWins).toBeCloseTo(base.defenderWins, 10);
    expect(upgraded.attackerWins).toBeGreaterThan(base.attackerWins);

    const sardakk = spaceCombatOdds(
      { faction: "sardakk", units: { cruiser: 2 } },
      hacan({ cruiser: 2 }),
    );
    const jolnar = spaceCombatOdds(
      { faction: "jolnar", units: { cruiser: 2 } },
      hacan({ cruiser: 2 }),
    );
    expect(sardakk.attackerWins).toBeGreaterThan(base.attackerWins);
    expect(jolnar.attackerWins).toBeLessThan(base.attackerWins);
  });

  test("a nebula favours the defender", () => {
    const open = spaceCombatOdds(hacan({ cruiser: 2 }), hacan({ cruiser: 2 }));
    const nebula = spaceCombatOdds(
      hacan({ cruiser: 2 }),
      hacan({ cruiser: 2 }),
      {
        nebula: true,
      },
    );
    expect(nebula.defenderWins).toBeGreaterThan(open.defenderWins);
  });

  test("a war sun without its technology is rejected", () => {
    expect(() =>
      spaceCombatOdds(hacan({ warsun: 1 }), hacan({ cruiser: 1 })),
    ).toThrow();
  });
});

describe("groundCombatOdds", () => {
  test("a planetary shield stops bombardment unless a war sun is present", () => {
    const attacker = (support: UnitCounts) =>
      hacan({ infantry: 2 }, { support, technologies: ["ws"] });
    const defender = hacan({ infantry: 2 }, { support: { pds: 1 } });
    const blocked = groundCombatOdds(attacker({ dreadnought: 2 }), defender);
    const noBombard = groundCombatOdds(
      attacker({}),
      hacan({ infantry: 2 }, { support: { pds: 1 } }),
    );
    expect(blocked.attackerWins).toBeCloseTo(noBombard.attackerWins, 10);

    const warSun = groundCombatOdds(attacker({ warsun: 1 }), defender);
    expect(warSun.attackerWins).toBeGreaterThan(blocked.attackerWins);
  });
});

// --- Monte Carlo cross-check ------------------------------------------------

/** Deterministic RNG so the cross-check never flakes. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Unit = { type: UnitType; data: UnitData; damaged: boolean };

/**
 * A straightforward simulation written independently of the exact solver,
 * assigning hits one at a time with the same default policy.
 */
function simulate(
  attacker: OddsSide,
  defender: OddsSide,
  ground: boolean,
  trials: number,
  random: () => number,
) {
  const expansions = EXPANSIONS.map((e) => e.id);
  const stat = (side: OddsSide, type: UnitType) =>
    unitFor(side.faction, type, side.technologies ?? [], expansions)!;
  const eligible = ground ? isGroundForce : isShip;
  const modifierOf = (f: FactionId) =>
    f === "sardakk" ? 1 : f === "jolnar" ? -1 : 0;
  const has = (side: OddsSide, tech: string) =>
    side.technologies?.includes(tech) ?? false;
  const d10 = () => Math.floor(random() * 10) + 1;

  const roll = (
    side: OddsSide,
    units: { type: UnitType; data: UnitData }[],
    target: "combat" | "afb" | "spaceCannon" | "bombardment",
    modifier: number,
    bonus: number,
  ) => {
    const dice: number[] = [];
    for (const u of units) {
      const value = u.data[target];
      if (value === undefined) continue;
      const count =
        (u.data[`${target}Dice` as keyof UnitData] as number | undefined) ?? 1;
      for (let i = 0; i < count; i++) dice.push(value);
    }
    if (dice.length > 0 && bonus > 0) dice.push(Math.min(...dice));
    return dice.filter((value) => d10() + modifier >= value).length;
  };

  const expand = (
    side: OddsSide,
    counts: UnitCounts,
    filter: (t: UnitType) => boolean,
  ) =>
    (Object.keys(counts) as UnitType[]).filter(filter).flatMap((type) =>
      Array.from({ length: counts[type] ?? 0 }, (_, i) => ({
        type,
        data: stat(side, type),
        damaged: i < (side.damaged?.[type] ?? 0),
      })),
    );

  const assign = (
    units: Unit[],
    hits: number,
    canTake: (u: Unit) => boolean,
    sustain: boolean,
  ) => {
    for (let h = 0; h < hits; h++) {
      const pool = units.filter(canTake);
      if (pool.length === 0) return;
      const sustainer =
        sustain && pool.find((u) => u.data.sustainDamage && !u.damaged);
      if (sustainer) {
        sustainer.damaged = true;
        continue;
      }
      const cost = (u: Unit) => (u.data.cost ?? 0) / u.data.producedPerCost;
      pool.sort(
        (a, b) =>
          cost(a) - cost(b) ||
          (b.data.combat ?? 11) - (a.data.combat ?? 11) ||
          Number(b.damaged) - Number(a.damaged),
      );
      units.splice(units.indexOf(pool[0]), 1);
    }
  };

  const tally = { attackerWins: 0, defenderWins: 0, draw: 0 };
  for (let t = 0; t < trials; t++) {
    const a = expand(attacker, attacker.units, eligible);
    const d = expand(defender, defender.units, eligible);
    const supportA = expand(attacker, attacker.support ?? {}, () => true);
    const supportD = expand(defender, defender.support ?? {}, () => true);

    if (!ground) {
      const cannonAtA = roll(
        defender,
        supportD,
        "spaceCannon",
        has(attacker, "amd") ? -1 : 0,
        has(defender, "ps") ? 1 : 0,
      );
      const cannonAtD = roll(
        attacker,
        supportA,
        "spaceCannon",
        has(defender, "amd") ? -1 : 0,
        has(attacker, "ps") ? 1 : 0,
      );
      assign(a, cannonAtA, () => true, true);
      assign(d, cannonAtD, () => true, true);
      const afbAtA = roll(defender, d, "afb", 0, 0);
      const afbAtD = roll(attacker, a, "afb", 0, 0);
      assign(a, afbAtA, (u) => u.type === "fighter", false);
      assign(d, afbAtD, (u) => u.type === "fighter", false);
    } else {
      const shielded =
        supportD.some((u) => u.data.planetaryShield) &&
        !supportA.some((u) => u.data.disablesPlanetaryShield);
      if (!shielded) {
        assign(
          d,
          roll(
            attacker,
            supportA,
            "bombardment",
            0,
            has(attacker, "ps") ? 1 : 0,
          ),
          () => true,
          true,
        );
      }
      assign(
        a,
        roll(
          defender,
          supportD,
          "spaceCannon",
          has(attacker, "amd") ? -1 : 0,
          has(defender, "ps") ? 1 : 0,
        ),
        () => true,
        true,
      );
    }

    while (a.length > 0 && d.length > 0) {
      const hitsByA = roll(
        attacker,
        a,
        "combat",
        modifierOf(attacker.faction),
        0,
      );
      const hitsByD = roll(
        defender,
        d,
        "combat",
        modifierOf(defender.faction),
        0,
      );
      assign(d, hitsByA, () => true, true);
      assign(a, hitsByD, () => true, true);
    }
    if (a.length > 0) tally.attackerWins++;
    else if (d.length > 0) tally.defenderWins++;
    else tally.draw++;
  }
  return {
    attackerWins: tally.attackerWins / trials,
    defenderWins: tally.defenderWins / trials,
    draw: tally.draw / trials,
  };
}

describe("matches a Monte Carlo simulation", () => {
  const TRIALS = 40_000;
  // Three standard errors at p = 0.5 is about 0.0075.
  const TOLERANCE = 0.012;

  const cases: [string, OddsSide, OddsSide, boolean][] = [
    [
      "mixed fleets with AFB, space cannon and upgrades",
      hacan(
        { dreadnought: 2, carrier: 2, fighter: 4, destroyer: 1 },
        { technologies: ["ps", "dn2"] },
      ),
      {
        faction: "sardakk",
        units: { cruiser: 3, destroyer: 2, fighter: 3 },
        support: { pds: 2 },
        technologies: ["dd2", "amd"],
      },
      false,
    ],
    [
      "flagships, war suns and pre-damaged ships",
      {
        faction: "sol",
        units: { warsun: 1, flagship: 1, fighter: 2 },
        damaged: { warsun: 1 },
        technologies: ["ws"],
      },
      {
        faction: "jolnar",
        units: { dreadnought: 3, cruiser: 2, fighter: 2 },
        technologies: ["cr2"],
      },
      false,
    ],
    [
      "ground combat with bombardment and space cannon defense",
      hacan(
        { infantry: 4, mech: 1 },
        { support: { dreadnought: 2 }, technologies: ["ps"] },
      ),
      {
        faction: "sol",
        units: { infantry: 3, mech: 1 },
        support: { pds: 1 },
        technologies: ["inf2"],
      },
      true,
    ],
  ];

  test.each(cases)("%s", (_, attacker, defender, ground) => {
    const exact = ground
      ? groundCombatOdds(attacker, defender)
      : spaceCombatOdds(attacker, defender);
    const sim = simulate(attacker, defender, ground, TRIALS, mulberry32(1234));
    expect(total(exact)).toBeCloseTo(1, 10);
    expect(Math.abs(exact.attackerWins - sim.attackerWins)).toBeLessThan(
      TOLERANCE,
    );
    expect(Math.abs(exact.defenderWins - sim.defenderWins)).toBeLessThan(
      TOLERANCE,
    );
    expect(Math.abs(exact.draw - sim.draw)).toBeLessThan(TOLERANCE);
  });
});
