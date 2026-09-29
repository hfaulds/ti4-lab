import { PlayerId } from "~/types";
import { isGroundForce, isShip, UNIT_NAMES } from "../data";
import { CargoPickup, ProductionOrder, ShipMove } from "../actions";
import {
  GameState,
  NewPrompt,
  Payment,
  SystemKey,
  TacticalAction,
  UnitCounts,
  UnitType,
} from "../types";
import {
  adjacentSystems,
  capacityIn,
  findRoute,
  fleetProblem,
  hasAnomaly,
  MECATOL_REX,
  moveRulesFor,
  otherShipOwners,
  retreatOptions,
  riftsExited,
  routeProblem,
  systemOf,
  WORMHOLE_NEXUS_ID,
} from "./board";
import {
  plasmaScoring,
  removeExcessCargo,
  rollAbility,
  Shooters,
  shootersIn,
} from "./combat";
import {
  activateNexus,
  checkElimination,
  exploreFrontier,
  gainControl,
  victoryPoints,
} from "./control";
import { pay, produce, productionCapacity } from "./economy";
import {
  addUnits,
  ask,
  clockwiseFrom,
  countOf,
  ensure,
  entries,
  fail,
  hasGroundForces,
  hasShips,
  hasTech,
  log,
  playerName,
  playerOf,
  playersWith,
  plural,
  removeUnits,
  rollDie,
  sumCounts,
  tokensInReinforcements,
  totalUnits,
  unitOf,
  unitTypes,
} from "./helpers";

const CUSTODIANS_COST = 6;

export function tacticalOf(state: GameState, id: PlayerId): TacticalAction {
  const tactical = state.tactical;
  if (!tactical) fail("No tactical action is in progress.");
  ensure(tactical.player === id, "This is not your tactical action.");
  return tactical;
}

// --- Activation -------------------------------------------------------------

export function activateSystem(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  options: { free?: boolean } = {},
) {
  const player = playerOf(state, id);
  const system = state.systems[key];
  ensure(system, "That system is not on the board.");
  if (!options.free) {
    ensure(
      !system.commandTokens.includes(id),
      "You already have a command token in that system.",
    );
    ensure(player.pools.tactic > 0, "Your tactic pool is empty.");
    player.pools.tactic--;
    system.commandTokens.push(id);
  }

  state.tactical = {
    player: id,
    system: key,
    step: "movement",
    invaded: [],
    resolved: [],
    bombarded: false,
  };
  log(state, `${player.name} activated ${describeSystem(state, key)}.`, {
    player: id,
  });
}

export function describeSystem(state: GameState, key: SystemKey) {
  const system = systemOf(state, key);
  if (system.planets.length > 0) return system.planets.join(" / ");
  return `system ${system.systemId}`;
}

// --- Movement ---------------------------------------------------------------

export function moveShips(
  state: GameState,
  id: PlayerId,
  moves: ShipMove[],
  cargo: CargoPickup[],
) {
  const tactical = tacticalOf(state, id);
  ensure(tactical.step === "movement", "Ships have already moved.");
  const destination = systemOf(state, tactical.system);
  const rules = moveRulesFor(state, id, tactical.system);
  const player = playerOf(state, id);

  ensure(
    moves.filter((m) => m.gravityDrive).length <= 1,
    "Gravity Drive applies to a single ship.",
  );

  const visited = new Map<SystemKey, number>();
  const planned: { move: ShipMove; path: SystemKey[] }[] = [];

  for (const move of moves) {
    const ships = entries(move.ships);
    if (ships.length === 0) continue;
    ensure(move.from !== tactical.system, "Those ships are already there.");
    const origin = state.systems[move.from];
    ensure(origin, "Unknown system.");
    ensure(
      !origin.commandTokens.includes(id),
      `Ships in ${describeSystem(state, move.from)} cannot move: you have a command token there.`,
    );
    if (move.gravityDrive) {
      ensure(hasTech(state, id, "gd"), "You do not own Gravity Drive.");
      ensure(sumCounts(move.ships) === 1, "Gravity Drive applies to a single ship.");
    }

    let slowest = Infinity;
    let capacity = 0;
    for (const [type, count] of ships) {
      ensure(isShip(type), `${UNIT_NAMES[type]} cannot move on its own.`);
      const unit = unitOf(state, id, type);
      ensure(
        unit?.move,
        `${UNIT_NAMES[type]} must be transported by a ship with capacity.`,
      );
      slowest = Math.min(slowest, unit.move + (move.gravityDrive ? 1 : 0));
      capacity += (unit.capacity ?? 0) * count;
    }

    let path = move.path;
    if (path) {
      ensure(path[0] === move.from, "The route must start where the ships are.");
      const problem = routeProblem(state, path, slowest, rules);
      if (problem) fail(problem);
    } else {
      const route = findRoute(state, move.from, slowest, rules);
      if (!route) {
        fail(
          `Ships in ${describeSystem(state, move.from)} cannot reach the active system.`,
        );
      }
      path = route.path;
    }
    for (const key of path) visited.set(key, (visited.get(key) ?? 0) + capacity);
    planned.push({ move, path });
  }

  // Ships already in the active system can pick up units there too.
  visited.set(
    tactical.system,
    (visited.get(tactical.system) ?? 0) + capacityIn(state, tactical.system, id),
  );

  for (const pickup of cargo) {
    const amount = sumCounts(pickup.units);
    if (amount === 0) continue;
    const source = state.systems[pickup.system];
    ensure(source, "Unknown system.");
    ensure(
      pickup.system === tactical.system || !source.commandTokens.includes(id),
      `Units in ${describeSystem(state, pickup.system)} cannot be picked up: you have a command token there.`,
    );
    ensure(
      visited.has(pickup.system),
      `None of your moving ships pass through ${describeSystem(state, pickup.system)}.`,
    );
    ensure(
      amount <= visited.get(pickup.system)!,
      `The ships passing through ${describeSystem(state, pickup.system)} cannot carry that much.`,
    );
    for (const [type] of entries(pickup.units)) {
      ensure(
        type === "fighter" || isGroundForce(type),
        `${UNIT_NAMES[type]} cannot be transported.`,
      );
      if (pickup.planet) {
        ensure(isGroundForce(type), "Fighters are not on planets.");
        ensure(
          state.planets[pickup.planet]?.system === pickup.system,
          `${pickup.planet} is not in that system.`,
        );
      }
    }
  }

  // Everything is validated against the board as it stood; now move it.
  let riftLosses = false;
  for (const { move, path } of planned) {
    const rifts = riftsExited(state, path);
    for (const [type, count] of entries(move.ships)) {
      const damaged = removeUnits(
        state.systems[move.from].space,
        id,
        type,
        count,
        false,
      );
      let survivors = count;
      let survivingDamaged = damaged;
      for (let ship = 0; ship < count && rifts > 0; ship++) {
        const rolls = Array.from({ length: rifts }, () => rollDie(state));
        if (rolls.some((r) => r <= 3)) {
          survivors--;
          survivingDamaged = Math.min(survivingDamaged, survivors);
          riftLosses = true;
          log(
            state,
            `${player.name}'s ${UNIT_NAMES[type]} was lost in a gravity rift (rolled ${rolls.join(", ")}).`,
            { player: id },
          );
        }
      }
      addUnits(destination.space, id, type, survivors, survivingDamaged);
    }
  }

  for (const pickup of cargo) {
    for (const [type, count] of entries(pickup.units)) {
      const forces = pickup.planet
        ? state.planets[pickup.planet].units
        : state.systems[pickup.system].space;
      removeUnits(forces, id, type, count);
      addUnits(destination.space, id, type, count);
    }
  }

  if (riftLosses) removeExcessCargo(state, tactical.system, id);
  // Fighters and ground forces left behind with nothing to carry them are
  // returned to reinforcements (LRR 16.3).
  for (const { move } of planned) removeExcessCargo(state, move.from, id);
  const problem = fleetProblem(state, tactical.system, id);
  if (problem) fail(problem);

  const moved = planned.reduce((sum, p) => sum + sumCounts(p.move.ships), 0);
  log(
    state,
    moved > 0
      ? `${player.name} moved ${plural(moved, "ship")} into ${describeSystem(state, tactical.system)}.`
      : `${player.name} moved no ships.`,
    { player: id },
  );

  if (
    destination.systemId === WORMHOLE_NEXUS_ID &&
    totalUnits(destination.space[id]) > 0
  ) {
    activateNexus(state);
  }
  startSpaceCannonOffense(state);
}

// --- Space cannon -----------------------------------------------------------

/** Units that can fire SPACE CANNON at ships in a system. */
export function spaceCannonOffenseShooters(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
): Shooters {
  const shooters: Shooters = [];
  const collect = (from: SystemKey, deepOnly: boolean) => {
    const system = systemOf(state, from);
    const groups = [
      system.space[id],
      ...system.planets.map((p) => state.planets[p].units[id]),
    ];
    for (const group of groups) {
      for (const shooter of shootersIn(state, id, group, "spaceCannon")) {
        if (deepOnly && !unitOf(state, id, shooter.type)?.deepSpaceCannon) {
          continue;
        }
        const existing = shooters.find((s) => s.type === shooter.type);
        if (existing) existing.count += shooter.count;
        else shooters.push({ ...shooter });
      }
    }
  };
  collect(key, false);
  for (const adjacent of adjacentSystems(state, key)) collect(adjacent, true);
  return shooters;
}

function startSpaceCannonOffense(state: GameState) {
  const tactical = state.tactical!;
  tactical.step = "spaceCannonOffense";
  const system = systemOf(state, tactical.system);
  const active = tactical.player;

  const prompts: NewPrompt[] = [];
  for (const id of clockwiseFrom(state, active)) {
    const shooters = spaceCannonOffenseShooters(state, id, tactical.system);
    if (shooters.length === 0) continue;
    const targets =
      id === active
        ? otherShipOwners(system, active)
        : hasShips(system.space[active])
          ? [active]
          : [];
    if (targets.length === 0) continue;
    // With several fleets present the active player fires on the largest.
    const target = [...targets].sort(
      (a, b) => totalUnits(system.space[b]) - totalUnits(system.space[a]),
    )[0];
    prompts.push({
      kind: "spaceCannon",
      player: id,
      system: tactical.system,
      target,
    });
  }
  ask(state, prompts);
}

export function fireSpaceCannon(
  state: GameState,
  id: PlayerId,
  prompt: { system: SystemKey; planet?: string; target: PlayerId },
  fire: boolean,
) {
  if (!fire) {
    log(state, `${playerName(state, id)} held their space cannons.`, {
      player: id,
    });
    return;
  }
  const defense = prompt.planet !== undefined;
  const shooters = defense
    ? shootersIn(
        state,
        id,
        state.planets[prompt.planet!].units[id],
        "spaceCannon",
      )
    : spaceCannonOffenseShooters(state, id, prompt.system);
  // Antimass Deflectors make the target harder to hit.
  const modifier = hasTech(state, prompt.target, "amd") ? -1 : 0;
  const { rolls, hits } = rollAbility(state, id, shooters, "spaceCannon", {
    modifier,
    bonusDice: plasmaScoring(state, id),
  });
  log(
    state,
    `${playerName(state, id)} fired space cannons at ${playerName(state, prompt.target)}: ${plural(hits, "hit")}.`,
    { player: id, rolls },
  );
  if (hits > 0) {
    ask(state, [
      {
        kind: "assignHits",
        player: prompt.target,
        hits,
        source: defense ? "spaceCannonDefense" : "spaceCannonOffense",
        system: prompt.system,
        planet: prompt.planet,
        from: id,
      },
    ]);
  }
}

// --- Space combat -----------------------------------------------------------

function startSpaceCombat(state: GameState) {
  const tactical = state.tactical!;
  const system = systemOf(state, tactical.system);
  const attacker = tactical.player;
  tactical.step = "spaceCombat";

  const opponents = otherShipOwners(system, attacker);
  if (!hasShips(system.space[attacker]) || opponents.length === 0) {
    startInvasion(state);
    return;
  }
  tactical.spaceCombat = {
    attacker,
    defender: opponents[0],
    round: 1,
    stage: "start",
  };
  log(
    state,
    `Space combat: ${playerName(state, attacker)} attacks ${playerName(state, opponents[0])} in ${describeSystem(state, tactical.system)}.`,
  );
}

function spaceCombatOver(state: GameState) {
  const tactical = state.tactical!;
  const combat = tactical.spaceCombat!;
  const system = systemOf(state, tactical.system);
  return (
    !hasShips(system.space[combat.attacker]) ||
    !hasShips(system.space[combat.defender])
  );
}

function endSpaceCombat(state: GameState) {
  const tactical = state.tactical!;
  const combat = tactical.spaceCombat!;
  const system = systemOf(state, tactical.system);
  const survivors = [combat.attacker, combat.defender].filter((id) =>
    hasShips(system.space[id]),
  );
  for (const id of [combat.attacker, combat.defender]) {
    removeExcessCargo(state, tactical.system, id);
    checkElimination(state, id);
  }
  log(
    state,
    survivors.length === 1
      ? `${playerName(state, survivors[0])} won the space combat.`
      : "The space combat ended with no winner.",
  );
  tactical.spaceCombat = undefined;

  // Further fleets in the system must be fought before the invasion.
  if (
    hasShips(system.space[combat.attacker]) &&
    otherShipOwners(system, combat.attacker).length > 0
  ) {
    startSpaceCombat(state);
    return;
  }
  startInvasion(state);
}

function continueSpaceCombat(state: GameState) {
  const tactical = state.tactical!;
  const combat = tactical.spaceCombat;
  if (!combat) {
    startSpaceCombat(state);
    return;
  }
  const system = systemOf(state, tactical.system);
  const sides = [combat.attacker, combat.defender];
  const opponentOf = (id: PlayerId) =>
    id === combat.attacker ? combat.defender : combat.attacker;

  switch (combat.stage) {
    case "start": {
      // Anti-fighter barrage, first round only.
      for (const id of sides) {
        const shooters = shootersIn(state, id, system.space[id], "afb");
        if (shooters.length === 0) continue;
        const { rolls, hits } = rollAbility(state, id, shooters, "afb");
        const target = opponentOf(id);
        const lost = Math.min(hits, countOf(system.space[target], "fighter"));
        log(
          state,
          `${playerName(state, id)} anti-fighter barrage: ${plural(hits, "hit")}, ${plural(lost, "fighter")} destroyed.`,
          { player: id, rolls },
        );
        if (lost > 0) removeUnits(system.space, target, "fighter", lost);
      }
      combat.stage = "announce";
      if (spaceCombatOver(state)) endSpaceCombat(state);
      return;
    }
    case "announce": {
      combat.stage = "roll";
      combat.retreat = undefined;
      const options = retreatOptions(state, tactical.system, combat.defender);
      if (options.length > 0) {
        ask(state, [
          {
            kind: "announceRetreat",
            player: combat.defender,
            system: tactical.system,
            options,
          },
        ]);
      } else {
        askAttackerToRetreat(state);
      }
      return;
    }
    case "roll": {
      const allRolls = [];
      const hits: Record<PlayerId, number> = {};
      for (const id of sides) {
        // Defenders in a nebula are harder to dislodge.
        const modifier =
          id === combat.defender && hasAnomaly(system, "NEBULA") ? 1 : 0;
        const shooters = shootersIn(
          state,
          id,
          system.space[id],
          "combat",
          isShip,
        );
        const result = rollAbility(state, id, shooters, "combat", { modifier });
        hits[id] = result.hits;
        allRolls.push(...result.rolls);
      }
      log(
        state,
        `Space combat round ${combat.round}: ${sides
          .map((id) => `${playerName(state, id)} ${plural(hits[id], "hit")}`)
          .join(", ")}.`,
        { rolls: allRolls },
      );
      combat.stage = "assign";
      ask(
        state,
        sides
          .filter((id) => hits[opponentOf(id)] > 0)
          .map((id) => ({
            kind: "assignHits" as const,
            player: id,
            hits: hits[opponentOf(id)],
            source: "spaceCombat" as const,
            system: tactical.system,
            from: opponentOf(id),
          })),
      );
      return;
    }
    case "assign": {
      combat.stage = "retreat";
      return;
    }
    case "retreat": {
      const retreat = combat.retreat;
      if (retreat && !spaceCombatOver(state)) {
        executeRetreat(state, retreat.player, retreat.to);
      }
      if (spaceCombatOver(state)) {
        endSpaceCombat(state);
        return;
      }
      combat.round++;
      combat.stage = "announce";
      return;
    }
  }
}

function askAttackerToRetreat(state: GameState) {
  const tactical = state.tactical!;
  const combat = tactical.spaceCombat!;
  const options = retreatOptions(state, tactical.system, combat.attacker);
  if (options.length === 0) return;
  ask(state, [
    {
      kind: "announceRetreat",
      player: combat.attacker,
      system: tactical.system,
      options,
    },
  ]);
}

export function announceRetreat(
  state: GameState,
  id: PlayerId,
  options: SystemKey[],
  to?: SystemKey,
) {
  const combat = state.tactical?.spaceCombat;
  ensure(combat, "There is no space combat.");
  if (to === undefined) {
    // The attacker may only retreat if the defender chose not to.
    if (id === combat.defender) askAttackerToRetreat(state);
    return;
  }
  ensure(options.includes(to), "Your fleet cannot retreat there.");
  combat.retreat = { player: id, to };
  log(state, `${playerName(state, id)} announced a retreat.`, { player: id });
}

function executeRetreat(state: GameState, id: PlayerId, to: SystemKey) {
  const tactical = state.tactical!;
  const from = systemOf(state, tactical.system);
  const target = systemOf(state, to);
  if (!retreatOptions(state, tactical.system, id).includes(to)) return;

  let capacity = 0;
  for (const type of unitTypes(from.space[id])) {
    const unit = unitOf(state, id, type);
    if (!isShip(type) || !unit?.move) continue;
    const stack = from.space[id][type]!;
    capacity += (unit.capacity ?? 0) * stack.count;
    addUnits(target.space, id, type, stack.count, stack.damaged);
    delete from.space[id][type];
  }
  // Cargo leaves with the fleet as far as there is room for it.
  for (const type of ["mech", "infantry", "fighter"] as UnitType[]) {
    const count = countOf(from.space[id], type);
    const taken = Math.min(count, capacity);
    if (taken > 0) {
      removeUnits(from.space, id, type, taken);
      addUnits(target.space, id, type, taken);
      capacity -= taken;
    }
  }
  delete from.space[id];

  if (!target.commandTokens.includes(id)) {
    const player = playerOf(state, id);
    if (tokensInReinforcements(state, id) <= 0) {
      const pool = (["tactic", "strategy", "fleet"] as const).find(
        (p) => player.pools[p] > 0,
      );
      if (pool) player.pools[pool]--;
    }
    target.commandTokens.push(id);
  }
  log(
    state,
    `${playerName(state, id)} retreated to ${describeSystem(state, to)}.`,
    { player: id },
  );
}

// --- Invasion ---------------------------------------------------------------

const groundForceOwners = (state: GameState, planet: string) =>
  playersWith(state.planets[planet].units, hasGroundForces);

function isShielded(state: GameState, planet: string, attacker: PlayerId) {
  const target = state.planets[planet];
  const system = systemOf(state, target.system);
  const ignoresShields = unitTypes(system.space[attacker]).some(
    (type) => unitOf(state, attacker, type)?.disablesPlanetaryShield,
  );
  if (ignoresShields) return false;
  return Object.keys(target.units)
    .map(Number)
    .filter((owner) => owner !== attacker)
    .some((owner) =>
      unitTypes(target.units[owner]).some(
        (type) => unitOf(state, owner, type)?.planetaryShield,
      ),
    );
}

/** Planets in the active system the active player may bombard. */
export function bombardmentTargets(state: GameState, id: PlayerId) {
  const tactical = state.tactical;
  if (!tactical) return [];
  return systemOf(state, tactical.system).planets.filter(
    (planet) =>
      groundForceOwners(state, planet).some((owner) => owner !== id) &&
      !isShielded(state, planet, id),
  );
}

function startInvasion(state: GameState) {
  const tactical = state.tactical!;
  const system = systemOf(state, tactical.system);
  const id = tactical.player;
  tactical.step = "bombardment";
  const canBombard =
    shootersIn(state, id, system.space[id], "bombardment").length > 0 &&
    bombardmentTargets(state, id).length > 0;
  if (!canBombard) startCommit(state);
}

export function bombard(
  state: GameState,
  id: PlayerId,
  targets: { unit: UnitType; planet: string; count: number }[],
) {
  const tactical = tacticalOf(state, id);
  ensure(tactical.step === "bombardment", "It is not the bombardment step.");
  const system = systemOf(state, tactical.system);
  const allowed = bombardmentTargets(state, id);
  const chosen = targets.filter((t) => t.count > 0);

  const used: Partial<Record<UnitType, number>> = {};
  for (const target of chosen) {
    ensure(
      allowed.includes(target.planet),
      `${target.planet} cannot be bombarded.`,
    );
    ensure(
      unitOf(state, id, target.unit)?.bombardment !== undefined,
      `${UNIT_NAMES[target.unit]} has no BOMBARDMENT.`,
    );
    used[target.unit] = (used[target.unit] ?? 0) + target.count;
    ensure(
      used[target.unit]! <= countOf(system.space[id], target.unit),
      `You do not have that many ${UNIT_NAMES[target.unit]} there.`,
    );
  }

  tactical.bombarded = chosen.length > 0;
  let bonus = plasmaScoring(state, id);
  const prompts: NewPrompt[] = [];
  for (const planet of [...new Set(chosen.map((t) => t.planet))]) {
    const shooters = chosen
      .filter((t) => t.planet === planet)
      .map((t) => ({ type: t.unit, count: t.count }));
    const { rolls, hits } = rollAbility(state, id, shooters, "bombardment", {
      bonusDice: bonus,
    });
    bonus = 0;
    const defender = groundForceOwners(state, planet).find((o) => o !== id)!;
    log(
      state,
      `${playerName(state, id)} bombarded ${planet}: ${plural(hits, "hit")}.`,
      { player: id, rolls },
    );
    if (hits > 0) {
      prompts.push({
        kind: "assignHits",
        player: defender,
        hits,
        source: "bombardment",
        system: tactical.system,
        planet,
        from: id,
      });
    }
  }
  tactical.step = "commit";
  ask(state, prompts);
}

function canCommit(state: GameState) {
  const tactical = state.tactical!;
  const system = systemOf(state, tactical.system);
  return (
    system.planets.length > 0 &&
    hasGroundForces(system.space[tactical.player])
  );
}

function startCommit(state: GameState) {
  const tactical = state.tactical!;
  tactical.step = "commit";
  if (!canCommit(state)) startProduction(state);
}

export function commitGroundForces(
  state: GameState,
  id: PlayerId,
  landings: { planet: string; units: UnitCounts }[],
  custodians?: Payment,
) {
  const tactical = tacticalOf(state, id);
  ensure(tactical.step === "commit", "It is not time to commit ground forces.");
  const system = systemOf(state, tactical.system);
  const player = playerOf(state, id);
  const chosen = landings.filter((l) => sumCounts(l.units) > 0);

  const landing: Partial<Record<UnitType, number>> = {};
  for (const { planet, units } of chosen) {
    ensure(system.planets.includes(planet), `${planet} is not in that system.`);
    for (const [type, count] of entries(units)) {
      ensure(isGroundForce(type), `${UNIT_NAMES[type]} cannot land on planets.`);
      landing[type] = (landing[type] ?? 0) + count;
      ensure(
        landing[type]! <= countOf(system.space[id], type),
        `You do not have that many ${UNIT_NAMES[type]} in space.`,
      );
    }
  }

  const landsOnMecatol = chosen.some((l) => l.planet === MECATOL_REX);
  if (landsOnMecatol && state.custodians) {
    pay(state, id, custodians, "influence", CUSTODIANS_COST);
    state.custodians = false;
    player.bonusVictoryPoints += 1;
    log(
      state,
      `${player.name} removed the custodians token and gained 1 victory point (${victoryPoints(state, id)}).`,
      { player: id },
    );
  }

  for (const { planet, units } of chosen) {
    for (const [type, count] of entries(units)) {
      const damaged = removeUnits(system.space, id, type, count, false);
      addUnits(state.planets[planet].units, id, type, count, damaged);
    }
    log(
      state,
      `${player.name} landed ${entries(units)
        .map(([type, count]) => `${count} ${UNIT_NAMES[type]}`)
        .join(", ")} on ${planet}.`,
      { player: id },
    );
  }

  tactical.invaded = chosen.map((l) => l.planet);
  if (tactical.invaded.length === 0) {
    startProduction(state);
    return;
  }

  // Space cannon defense
  tactical.step = "spaceCannonDefense";
  const prompts: NewPrompt[] = [];
  for (const planet of tactical.invaded) {
    const units = state.planets[planet].units;
    for (const owner of Object.keys(units).map(Number)) {
      if (owner === id) continue;
      if (shootersIn(state, owner, units[owner], "spaceCannon").length === 0) {
        continue;
      }
      prompts.push({
        kind: "spaceCannon",
        player: owner,
        system: tactical.system,
        planet,
        target: id,
      });
    }
  }
  ask(state, prompts);
}

function nextGroundCombat(state: GameState) {
  const tactical = state.tactical!;
  const id = tactical.player;
  tactical.step = "groundCombat";

  for (const planet of tactical.invaded) {
    if (tactical.resolved.includes(planet)) continue;
    tactical.resolved.push(planet);
    const owners = groundForceOwners(state, planet);
    const defender = owners.find((owner) => owner !== id);
    if (owners.includes(id) && defender !== undefined) {
      tactical.groundCombat = {
        planet,
        attacker: id,
        defender,
        round: 1,
        stage: "roll",
      };
      log(
        state,
        `Ground combat on ${planet}: ${playerName(state, id)} against ${playerName(state, defender)}.`,
      );
      return;
    }
  }
  establishControl(state);
}

function continueGroundCombat(state: GameState) {
  const tactical = state.tactical!;
  const combat = tactical.groundCombat;
  if (!combat) {
    nextGroundCombat(state);
    return;
  }
  const units = state.planets[combat.planet].units;
  const sides = [combat.attacker, combat.defender];
  const opponentOf = (id: PlayerId) =>
    id === combat.attacker ? combat.defender : combat.attacker;
  const over = () => sides.some((id) => !hasGroundForces(units[id]));

  if (combat.stage === "roll") {
    const hits: Record<PlayerId, number> = {};
    const allRolls = [];
    for (const id of sides) {
      const shooters = shootersIn(state, id, units[id], "combat", isGroundForce);
      const result = rollAbility(state, id, shooters, "combat");
      hits[id] = result.hits;
      allRolls.push(...result.rolls);
    }
    log(
      state,
      `Ground combat round ${combat.round} on ${combat.planet}: ${sides
        .map((id) => `${playerName(state, id)} ${plural(hits[id], "hit")}`)
        .join(", ")}.`,
      { rolls: allRolls },
    );
    combat.stage = "assign";
    ask(
      state,
      sides
        .filter((id) => hits[opponentOf(id)] > 0)
        .map((id) => ({
          kind: "assignHits" as const,
          player: id,
          hits: hits[opponentOf(id)],
          source: "groundCombat" as const,
          system: tactical.system,
          planet: combat.planet,
          from: opponentOf(id),
        })),
    );
    return;
  }

  if (over()) {
    const winner = sides.find((id) => hasGroundForces(units[id]));
    log(
      state,
      winner !== undefined
        ? `${playerName(state, winner)} won the ground combat on ${combat.planet}.`
        : `The ground combat on ${combat.planet} ended with no survivors.`,
    );
    tactical.groundCombat = undefined;
    nextGroundCombat(state);
    return;
  }
  combat.round++;
  combat.stage = "roll";
}

function establishControl(state: GameState) {
  const tactical = state.tactical!;
  const id = tactical.player;
  for (const name of tactical.invaded) {
    const planet = state.planets[name];
    const owners = groundForceOwners(state, name);
    if (owners.includes(id) && owners.every((owner) => owner === id)) {
      gainControl(state, id, name);
    }
    for (const owner of Object.keys(planet.units).map(Number)) {
      checkElimination(state, owner);
    }
  }
  startProduction(state);
}

// --- Production -------------------------------------------------------------

function startProduction(state: GameState) {
  const tactical = state.tactical!;
  tactical.step = "production";
  if (productionCapacity(state, tactical.system, tactical.player) === 0) {
    finishTactical(state);
  }
}

export function produceUnits(
  state: GameState,
  id: PlayerId,
  units: ProductionOrder[],
  payment: Payment,
) {
  const tactical = tacticalOf(state, id);
  ensure(tactical.step === "production", "It is not the production step.");
  if (units.some((u) => u.count > 0)) {
    produce(state, id, tactical.system, units, payment);
  }
  finishTactical(state);
}

function finishTactical(state: GameState) {
  const tactical = state.tactical!;
  const id = tactical.player;
  const system = systemOf(state, tactical.system);
  tactical.step = "done";
  state.tactical = undefined;
  state.actionsThisTurn++;
  // Dark Energy Tap
  if (
    system.frontier &&
    hasTech(state, id, "det") &&
    hasShips(system.space[id])
  ) {
    exploreFrontier(state, id, tactical.system);
  }
}

// --- Driver -----------------------------------------------------------------

/**
 * Moves the tactical action on once nothing is waiting on a player.
 * Returns true if it changed anything.
 */
export function continueTactical(state: GameState): boolean {
  const tactical = state.tactical;
  if (!tactical) return false;
  switch (tactical.step) {
    case "spaceCannonOffense":
      startSpaceCombat(state);
      return true;
    case "spaceCombat":
      continueSpaceCombat(state);
      return true;
    case "commit":
      // Reached after bombardment hits are assigned; wait for the landing
      // unless there is nothing to land.
      if (!canCommit(state)) {
        startProduction(state);
        return true;
      }
      return false;
    case "spaceCannonDefense":
      nextGroundCombat(state);
      return true;
    case "groundCombat":
      continueGroundCombat(state);
      return true;
    default:
      return false;
  }
}
