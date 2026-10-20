import { PlayerId } from "~/types";
import { isGroundForce, isShip, UNIT_NAMES } from "../data";
import { CargoPickup, ProductionOrder, ShipMove } from "../actions";
import {
  CombatEffects,
  CombatRoll,
  GameState,
  GroundCombat,
  NewPrompt,
  Payment,
  SpaceCombat,
  SystemKey,
  TacticalAction,
  UnitCounts,
  UnitGroup,
  UnitType,
  WindowContext,
  WindowId,
} from "../types";
import {
  adjacentSystems,
  capacityIn,
  findRoute,
  fleetProblem,
  hasAnomaly,
  MECATOL_REX,
  moveRulesFor,
  nonFighterShips,
  otherShipOwners,
  planetTraits,
  retreatOptions,
  riftsExited,
  routeProblem,
  systemOf,
  WORMHOLE_NEXUS_ID,
  wormholesIn,
} from "./board";
import {
  combatFlag,
  naaluFightersLand,
  plasmaScoring,
  removeExcessCargo,
  removeExcessShips,
  rerollMisses,
  rollAbility,
  rollHits,
  Shooters,
  shootersIn,
} from "./combat";
import {
  activateNexus,
  checkElimination,
  checkVictory,
  exploreFrontier,
  gainControl,
  victoryPoints,
} from "./control";
import { achieve, destroyUnits, exhaustTech } from "./effects/helpers";
import { pay, produce, productionCapacity } from "./economy";
import {
  afterAction,
  afterActivating,
  afterMoving,
  gainTradeGoodsFrom,
} from "./events";
import { closeWindows, openWindow, ownsAbility } from "./reactions";
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
  movesAsShip,
  unitOf,
  unitsAvailable,
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

/**
 * Bonus move for ships leaving a system: Flank Speed, and Slipstream from
 * the Creuss home system or a system with an alpha or beta wormhole.
 */
export function moveBonus(state: GameState, id: PlayerId, from: SystemKey) {
  let bonus = state.tactical?.flags?.includes(`flank:${id}`) ? 1 : 0;
  if (ownsAbility(state, id, "slipstream")) {
    const origin = systemOf(state, from);
    if (
      origin.key === state.players[id].home ||
      wormholesIn(state, origin, id).some((w) => w === "ALPHA" || w === "BETA")
    ) {
      bonus++;
    }
  }
  return bonus;
}

export function activateSystem(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  options: { free?: boolean } = {},
) {
  const player = playerOf(state, id);
  const system = state.systems[key];
  ensure(system, "That system is not on the board.");
  // Chaos Mapping keeps others out of asteroid fields holding Saar ships.
  ensure(
    !hasAnomaly(system, "ASTEROID_FIELD") ||
      !playersWith(system.space, hasShips).some(
        (other) => other !== id && hasTech(state, other, "cm"),
      ),
    "Chaos Mapping: you cannot activate that asteroid field.",
  );
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
  afterActivating(state, id, key);
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
  const player = playerOf(state, id);
  ensure(
    !tactical.flags?.includes(`ceasefire:${id}`) ||
      moves.every((m) => sumCounts(m.ships) === 0),
    "Ceasefire: you cannot move units into the active system.",
  );

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
      ensure(movesAsShip(state, id, type), `${UNIT_NAMES[type]} cannot move on its own.`);
      const unit = unitOf(state, id, type);
      ensure(
        unit?.move,
        `${UNIT_NAMES[type]} must be transported by a ship with capacity.`,
      );
      slowest = Math.min(slowest, unit.move + (move.gravityDrive ? 1 : 0));
      capacity += (unit.capacity ?? 0) * count;
    }
    slowest += moveBonus(state, id, move.from);
    const rules = moveRulesFor(state, id, tactical.system, {
      origin: move.from,
      ships: ships.map(([type]) => type),
    });

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
  tactical.step = "moved";
  if (moved > 0) afterMoving(state, id, tactical.system);
}

// --- Hits -------------------------------------------------------------------

type HitsPrompt = Extract<NewPrompt, { kind: "assignHits" }>;

/**
 * Asks a player to assign hits, first giving them the chance to cancel some
 * (Maneuvering Jets against space cannon, Shields Holding in space combat).
 */
export function queueHits(state: GameState, prompts: HitsPrompt[]) {
  const asked = prompts.filter((p) => p.hits > 0);
  if (asked.length === 0) return;
  ask(state, asked);
  const queued = state.prompts.slice(0, asked.length);
  for (const prompt of queued) {
    if (prompt.kind !== "assignHits") continue;
    const window: WindowId | undefined =
      prompt.source === "spaceCannonOffense" || prompt.source === "spaceCannonDefense"
        ? "beforeSpaceCannonHits"
        : prompt.source === "spaceCombat"
          ? "beforeCombatHits"
          : undefined;
    if (!window) continue;
    openWindow(
      state,
      window,
      { player: prompt.from, system: prompt.system, ref: prompt.id, amount: prompt.hits },
      [prompt.player],
    );
  }
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
  gravitonLaser = false,
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
  if (gravitonLaser) {
    ensure(!defense, "Graviton Laser System helps against ships.");
    exhaustTech(state, id, "gls");
  }
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
  queueHits(state, [
    {
      kind: "assignHits",
      player: prompt.target,
      hits,
      source: defense ? "spaceCannonDefense" : "spaceCannonOffense",
      system: prompt.system,
      planet: prompt.planet,
      from: id,
      nonFighter: gravitonLaser ? hits : undefined,
    },
  ]);
}

// --- Combat rolls -------------------------------------------------------------

const opponentIn = (combat: { attacker: PlayerId; defender: PlayerId }, id: PlayerId) =>
  id === combat.attacker ? combat.defender : combat.attacker;

/** Modifier to one player's combat rolls for one unit type in the current combat. */
function combatModifier(
  state: GameState,
  id: PlayerId,
  type: UnitType,
  combat: CombatEffects,
  space: boolean,
) {
  const tactical = state.tactical!;
  let modifier = (combat.roundModifiers?.[id] ?? 0) + (combat.modifiers?.[id] ?? 0);
  const system = systemOf(state, tactical.system);
  if (space) {
    // Defenders in a nebula are harder to dislodge.
    if (id !== tactical.player && hasAnomaly(system, "NEBULA")) modifier += 1;
    if (type === "fighter" && combatFlag(combat, "r.prototype", id)) modifier += 2;
    // C'Morran N'orr
    if (
      type !== "flagship" &&
      countOf(system.space[id], "flagship") > 0 &&
      unitOf(state, id, "flagship")?.id === "sardakk_flagship"
    ) {
      modifier += 1;
    }
  }
  // Prophecy of Ixth
  if (type === "fighter" && state.laws.some((l) => l.id === "prophecy" && l.owner === id)) {
    modifier += 1;
  }
  return modifier;
}

/** Combat dice for one side of a combat this round. */
function rollCombatDice(
  state: GameState,
  id: PlayerId,
  group: UnitGroup | undefined,
  filter: (type: UnitType) => boolean,
  combat: CombatEffects,
  space: boolean,
) {
  const tactical = state.tactical!;
  const opponent = opponentIn(combat as SpaceCombat, id);
  const shooters = shootersIn(state, id, group, "combat", filter);
  return rollAbility(state, id, shooters, "combat", {
    unitModifier: (type) => combatModifier(state, id, type, combat, space),
    diceFor: (type) =>
      // Salai Sai Corian rolls a die per enemy non-fighter ship.
      type === "flagship" && unitOf(state, id, type)?.id === "winnu_flagship"
        ? nonFighterShips(state, tactical.system, opponent)
        : undefined,
  }).rolls;
}

// --- Space combat -----------------------------------------------------------

/**
 * Space docks that float in space (the Saar's) are destroyed when another
 * player's ships blockade them.
 */
function destroyBlockadedDocks(state: GameState, key: SystemKey) {
  const system = systemOf(state, key);
  for (const owner of Object.keys(system.space).map(Number)) {
    if (countOf(system.space[owner], "spacedock") === 0) continue;
    if (hasShips(system.space[owner]) || otherShipOwners(system, owner).length === 0) {
      continue;
    }
    const lost = destroyUnits(
      state,
      owner,
      { system: key },
      "spacedock",
      countOf(system.space[owner], "spacedock"),
      otherShipOwners(system, owner)[0],
    );
    log(state, `${playerName(state, owner)} lost ${plural(lost, "blockaded space dock")}.`, {
      player: owner,
    });
  }
}

function startSpaceCombat(state: GameState) {
  const tactical = state.tactical!;
  const system = systemOf(state, tactical.system);
  const attacker = tactical.player;
  tactical.step = "spaceCombat";

  const opponents = otherShipOwners(system, attacker);
  if (!hasShips(system.space[attacker]) || opponents.length === 0) {
    // Space cannon fire may have destroyed ships that were carrying units.
    removeExcessCargo(state, tactical.system, attacker);
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
    combatFlag(combat, "draw", combat.attacker) ||
    !hasShips(system.space[combat.attacker]) ||
    !hasShips(system.space[combat.defender])
  );
}

/** Opens a window for both sides of a combat, each facing the other. */
function openCombatWindow(
  state: GameState,
  window: WindowId,
  combat: { attacker: PlayerId; defender: PlayerId },
  context: WindowContext = {},
) {
  const key = state.tactical!.system;
  for (const id of [combat.attacker, combat.defender]) {
    openWindow(state, window, { ...context, system: key, player: opponentIn(combat, id) }, [id]);
  }
}

const COMBAT_WINDOWS: WindowId[] = [
  "combatStart",
  "roundStart",
  "afterRolls",
  "beforeCombatHits",
  "afterSustain",
  "afterShipDestroyed",
  "afterUnitDestroyed",
  "roundEnd",
  "afterRetreat",
  "groundCombatStart",
];

function endSpaceCombat(state: GameState) {
  const tactical = state.tactical!;
  const combat = tactical.spaceCombat!;
  const system = systemOf(state, tactical.system);
  const draw = combatFlag(combat, "draw", combat.attacker);
  const survivors = [combat.attacker, combat.defender].filter((id) =>
    hasShips(system.space[id]),
  );
  for (const id of [combat.attacker, combat.defender]) {
    removeExcessCargo(state, tactical.system, id);
    checkElimination(state, id);
  }
  // Ground forces that fought as ships go back to being cargo.
  closeWindows(state, COMBAT_WINDOWS);
  const winner = !draw && survivors.length === 1 ? survivors[0] : undefined;
  log(
    state,
    winner !== undefined
      ? `${playerName(state, winner)} won the space combat.`
      : "The space combat ended with no winner.",
  );
  tactical.spaceCombat = undefined;

  for (const id of [combat.attacker, combat.defender]) {
    // Salvage Operations
    if (hasTech(state, id, "so") && !state.players[id].eliminated) {
      gainTradeGoodsFrom(state, id, 1, "Salvage Operations");
    }
  }
  if (winner !== undefined) {
    const loser = opponentIn(combat, winner);
    afterCombatWon(state, winner, loser);
    if (state.phase === "finished") return;
    // Unveil Flagship
    if (countOf(system.space[winner], "flagship") > 0) achieve(state, winner, "uf");
    openWindow(
      state,
      "afterCombat",
      { player: loser, system: tactical.system, units: destroyedCounts(combat) },
      [winner],
    );
  }

  destroyBlockadedDocks(state, tactical.system);
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

const destroyedCounts = (combat: CombatEffects): UnitCounts => {
  const counts: UnitCounts = {};
  for (const type of combat.destroyed ?? []) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
};

/** What winning any combat brings: Spark a Rebellion, Shard of the Throne. */
function afterCombatWon(state: GameState, winner: PlayerId, loser: PlayerId) {
  const loserPoints = victoryPoints(state, loser);
  if (
    state.seating.every(
      (other) => other === loser || victoryPoints(state, other) <= loserPoints,
    )
  ) {
    achieve(state, winner, "sar");
  }
  const shard = state.laws.find((law) => law.id === "shard_of_the_throne");
  if (shard && shard.owner === loser) {
    shard.owner = winner;
    state.players[loser].bonusVictoryPoints -= 1;
    state.players[winner].bonusVictoryPoints += 1;
    log(state, `${playerName(state, winner)} took the Shard of the Throne.`, {
      player: winner,
    });
    checkVictory(state);
  }
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
  const opponentOf = (id: PlayerId) => opponentIn(combat, id);

  switch (combat.stage) {
    case "start": {
      combat.stage = "afb";
      // Assault Cannon
      const prompts: HitsPrompt[] = [];
      for (const id of sides) {
        const opponent = opponentOf(id);
        if (
          hasTech(state, id, "asc") &&
          nonFighterShips(state, tactical.system, id) >= 3 &&
          nonFighterShips(state, tactical.system, opponent) > 0
        ) {
          prompts.push({
            kind: "assignHits",
            player: opponent,
            hits: 1,
            source: "destroyNonFighterShips",
            system: tactical.system,
            from: id,
          });
        }
      }
      queueHits(state, prompts);
      openCombatWindow(state, "combatStart", combat);
      return;
    }
    case "afb": {
      combat.stage = "roundStart";
      if (spaceCombatOver(state)) {
        endSpaceCombat(state);
        return;
      }
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
        if (lost > 0) destroyUnits(state, target, { system: tactical.system }, "fighter", lost, id);
      }
      if (spaceCombatOver(state)) endSpaceCombat(state);
      return;
    }
    case "roundStart": {
      combat.stage = "announce";
      combat.roundModifiers = {};
      combat.flags = (combat.flags ?? []).filter((flag) => !flag.startsWith("r."));
      combat.damagedAtStart = {};
      for (const id of sides) {
        const group = system.space[id];
        // Arc Secundus repairs itself.
        if (unitOf(state, id, "flagship")?.id === "letnev_flagship" && group?.flagship) {
          group.flagship.damaged = 0;
        }
        combat.damagedAtStart[id] = unitTypes(group).filter((t) => group![t]!.damaged > 0);
      }
      openCombatWindow(state, "roundStart", combat);
      return;
    }
    case "announce": {
      if (spaceCombatOver(state)) {
        endSpaceCombat(state);
        return;
      }
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
      const rolls: CombatRoll[] = [];
      for (const id of sides) {
        const fights = combatFlag(combat, "alastor", id)
          ? (type: UnitType) => isShip(type) || isGroundForce(type)
          : isShip;
        const own = rollCombatDice(state, id, system.space[id], fights, combat, true);
        // Munitions Reserves
        if (combatFlag(combat, "r.munitions", id)) {
          rerollMisses(state, own, () => true);
        }
        rolls.push(...own);
      }
      combat.rolls = rolls;
      combat.stage = "hits";
      openCombatWindow(state, "afterRolls", combat);
      return;
    }
    case "hits": {
      const rolls = combat.rolls ?? [];
      combat.rolls = undefined;
      const hits: Record<PlayerId, number> = {};
      const capital: Record<PlayerId, number> = {};
      for (const id of sides) {
        const own = rolls.filter((r) => r.player === id);
        hits[id] = own.reduce((sum, r) => sum + rollHits(state, r), 0);
        // [0.0.1]: hits from the flagship and dreadnoughts go to non-fighters.
        if (
          countOf(system.space[id], "flagship") > 0 &&
          unitOf(state, id, "flagship")?.id === "l1z1x_flagship"
        ) {
          capital[id] = own
            .filter((r) => r.unit === "flagship" || r.unit === "dreadnought")
            .reduce((sum, r) => sum + rollHits(state, r), 0);
        }
      }
      log(
        state,
        `Space combat round ${combat.round}: ${sides
          .map((id) => `${playerName(state, id)} ${plural(hits[id], "hit")}`)
          .join(", ")}.`,
        { rolls },
      );
      combat.stage = "assign";
      queueHits(
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
            nonFighter: capital[opponentOf(id)] || undefined,
          })),
      );
      return;
    }
    case "assign": {
      combat.stage = "retreat";
      for (const id of sides) duraniumArmor(state, id, combat.damagedAtStart?.[id] ?? []);
      if (!spaceCombatOver(state)) openCombatWindow(state, "roundEnd", combat);
      return;
    }
    case "roundEnd":
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
      combat.stage = "roundStart";
      return;
    }
  }
}

/**
 * Duranium Armor: after hits are assigned, repair 1 unit that was already
 * damaged before this round, the most expensive first.
 */
function duraniumArmor(state: GameState, id: PlayerId, damagedBefore: UnitType[]) {
  if (!hasTech(state, id, "da")) return;
  const tactical = state.tactical!;
  const forces = tactical.groundCombat
    ? state.planets[tactical.groundCombat.planet].units
    : systemOf(state, tactical.system).space;
  const group = forces[id];
  const repairable = damagedBefore
    .filter((type) => (group?.[type]?.damaged ?? 0) > 0)
    .sort((a, b) => (unitOf(state, id, b)?.cost ?? 0) - (unitOf(state, id, a)?.cost ?? 0));
  const [type] = repairable;
  if (!type) return;
  group![type]!.damaged--;
  log(state, `Duranium Armor repaired ${playerName(state, id)}'s ${UNIT_NAMES[type]}.`, {
    player: id,
  });
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
  // Intercept
  openWindow(
    state,
    "afterRetreat",
    { player: id, system: state.tactical!.system },
    [opponentIn(combat, id)],
  );
}

/**
 * Moves a player's ships, and what they carry, out of the active system.
 * `checked` skips the usual retreat restrictions (Skilled Retreat checks its own).
 */
export function executeRetreat(
  state: GameState,
  id: PlayerId,
  to: SystemKey,
  checked = false,
) {
  const tactical = state.tactical!;
  const from = systemOf(state, tactical.system);
  const target = systemOf(state, to);
  if (!checked && !retreatOptions(state, tactical.system, id).includes(to)) return;

  let capacity = 0;
  for (const type of unitTypes(from.space[id])) {
    const unit = unitOf(state, id, type);
    if (!movesAsShip(state, id, type) || !unit?.move) continue;
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
  // Joining ships already there, or losing a fleet token to the command
  // token, can leave more ships than the fleet pool supports.
  removeExcessShips(state, to, id);
}

// --- Invasion ---------------------------------------------------------------

/** Ground forces, and Naalu fighters committed to a planet, that fight there. */
const fightsOnPlanet = (group: UnitGroup | undefined) =>
  hasGroundForces(group) || countOf(group, "fighter") > 0;

const groundForceOwners = (state: GameState, planet: string) =>
  playersWith(state.planets[planet].units, fightsOnPlanet);

const tacticalFlagged = (state: GameState, flag: string, id: PlayerId) =>
  !!state.tactical?.flags?.includes(`${flag}:${id}`);

function isShielded(state: GameState, planet: string, attacker: PlayerId) {
  const target = state.planets[planet];
  const system = systemOf(state, target.system);
  const ignoresShields = unitTypes(system.space[attacker]).some((type) => {
    const unit = unitOf(state, attacker, type);
    // Arc Secundus strips PLANETARY SHIELD like a war sun.
    return unit?.disablesPlanetaryShield || unit?.id === "letnev_flagship";
  });
  if (ignoresShields) return false;
  // Disable: PDS lose PLANETARY SHIELD for this invasion.
  const disabled = tacticalFlagged(state, "disable", attacker);
  return Object.keys(target.units)
    .map(Number)
    .filter((owner) => owner !== attacker)
    .some((owner) =>
      unitTypes(target.units[owner]).some(
        (type) =>
          unitOf(state, owner, type)?.planetaryShield && !(disabled && type === "pds"),
      ),
    );
}

const conventionsOfWar = (state: GameState) =>
  state.laws.some((law) => law.id === "conventions" && law.outcome !== "Against");

/** Planets in the active system the active player may bombard. */
export function bombardmentTargets(state: GameState, id: PlayerId) {
  const tactical = state.tactical;
  if (!tactical) return [];
  return systemOf(state, tactical.system).planets.filter(
    (planet) =>
      groundForceOwners(state, planet).some((owner) => owner !== id) &&
      !isShielded(state, planet, id) &&
      !(conventionsOfWar(state) && planetTraits(state, planet).includes("CULTURAL")),
  );
}

const canBombard = (state: GameState) => {
  const tactical = state.tactical!;
  const id = tactical.player;
  return (
    shootersIn(state, id, systemOf(state, tactical.system).space[id], "bombardment")
      .length > 0 && bombardmentTargets(state, id).length > 0
  );
};

function startInvasion(state: GameState) {
  const tactical = state.tactical!;
  tactical.step = "bombardment";
  closeWindows(state, COMBAT_WINDOWS);
  const system = systemOf(state, tactical.system);
  if (system.planets.length === 0) {
    startProduction(state);
    return;
  }
  // Bunker for the defenders, Disable for the attacker.
  openWindow(state, "invasionStart", { system: tactical.system, player: tactical.player });
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
  const prompts: HitsPrompt[] = [];
  for (const planet of [...new Set(chosen.map((t) => t.planet))]) {
    const shooters = chosen
      .filter((t) => t.planet === planet)
      .map((t) => ({ type: t.unit, count: t.count }));
    const defender = groundForceOwners(state, planet).find((o) => o !== id)!;
    // Bunker
    const modifier =
      state.planets[planet].controller !== undefined &&
      tacticalFlagged(state, "bunker", state.planets[planet].controller!)
        ? -4
        : 0;
    const { rolls, hits } = rollAbility(state, id, shooters, "bombardment", {
      bonusDice: bonus,
      modifier,
    });
    bonus = 0;
    log(
      state,
      `${playerName(state, id)} bombarded ${planet}: ${plural(hits, "hit")}.`,
      { player: id, rolls },
    );
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
  tactical.step = "commit";
  queueHits(state, prompts);
}

function canCommit(state: GameState) {
  const tactical = state.tactical!;
  const system = systemOf(state, tactical.system);
  return (
    system.planets.length > 0 &&
    (hasGroundForces(system.space[tactical.player]) ||
      (naaluFightersLand(state, tactical.player, tactical.system) &&
        countOf(system.space[tactical.player], "fighter") > 0))
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
  const fightersLand = naaluFightersLand(state, id, tactical.system);

  const landing: Partial<Record<UnitType, number>> = {};
  for (const { planet, units } of chosen) {
    ensure(system.planets.includes(planet), `${planet} is not in that system.`);
    ensure(
      !state.planets[planet].attachments.includes("demilitarized_zone"),
      `${planet} is a demilitarized zone.`,
    );
    for (const [type, count] of entries(units)) {
      ensure(
        isGroundForce(type) || (type === "fighter" && fightersLand),
        `${UNIT_NAMES[type]} cannot land on planets.`,
      );
      landing[type] = (landing[type] ?? 0) + count;
      ensure(
        landing[type]! <= countOf(system.space[id], type),
        `You do not have that many ${UNIT_NAMES[type]} in space.`,
      );
    }
  }

  const landsOnMecatol = chosen.some((l) => l.planet === MECATOL_REX);
  if (landsOnMecatol && state.custodians) {
    // Blood Ties: the Winnu owe the custodians nothing.
    const cost = ownsAbility(state, id, "blood_ties") ? 0 : CUSTODIANS_COST;
    pay(state, id, custodians, "influence", cost);
    state.custodians = false;
    player.bonusVictoryPoints += 1;
    log(
      state,
      `${player.name} removed the custodians token and gained 1 victory point (${victoryPoints(state, id)}).`,
      { player: id },
    );
    checkVictory(state);
    if (state.phase === "finished") return;
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
  // Parley for the planets' owners, Ragh's Call for the invader.
  tactical.step = "committed";
  for (const planet of tactical.invaded) {
    openWindow(state, "afterCommit", { system: tactical.system, planet, player: id });
  }
}

function startSpaceCannonDefense(state: GameState) {
  const tactical = state.tactical!;
  const id = tactical.player;
  tactical.step = "spaceCannonDefense";
  // L4 Disruptors keep space cannons quiet during the invasion.
  if (hasTech(state, id, "l4")) return;
  const disabled = tacticalFlagged(state, "disable", id);
  const prompts: NewPrompt[] = [];
  for (const planet of tactical.invaded) {
    const units = state.planets[planet].units;
    if (!fightsOnPlanet(units[id])) continue;
    for (const owner of Object.keys(units).map(Number)) {
      if (owner === id) continue;
      const shooters = shootersIn(state, owner, units[owner], "spaceCannon").filter(
        (s) => !(disabled && s.type === "pds"),
      );
      if (shooters.length === 0) continue;
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
        stage: "start",
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
  const opponentOf = (id: PlayerId) => opponentIn(combat, id);
  const over = () => sides.some((id) => !fightsOnPlanet(units[id]));
  const context = { planet: combat.planet };

  switch (combat.stage) {
    case "start":
      combat.stage = "roundStart";
      openCombatWindow(state, "groundCombatStart", combat, context);
      return;
    case "roundStart":
      if (over()) break;
      combat.stage = "roll";
      combat.roundModifiers = {};
      combat.flags = (combat.flags ?? []).filter((flag) => !flag.startsWith("r."));
      combat.damagedAtStart = {};
      for (const id of sides) {
        combat.damagedAtStart[id] = unitTypes(units[id]).filter(
          (t) => units[id]![t]!.damaged > 0,
        );
      }
      openCombatWindow(state, "roundStart", combat, context);
      return;
    case "roll": {
      const rolls: CombatRoll[] = [];
      for (const id of sides) {
        // Magen Defense Grid stops the opponent rolling this round.
        if (combatFlag(combat, "r.magen", opponentOf(id))) continue;
        const fighters = naaluFightersLand(state, id, tactical.system);
        rolls.push(
          ...rollCombatDice(
            state,
            id,
            units[id],
            (type) => isGroundForce(type) || (fighters && type === "fighter"),
            combat,
            false,
          ),
        );
      }
      combat.rolls = rolls;
      combat.stage = "hits";
      openCombatWindow(state, "afterRolls", combat, context);
      return;
    }
    case "hits": {
      const rolls = combat.rolls ?? [];
      combat.rolls = undefined;
      const hits: Record<PlayerId, number> = {};
      for (const id of sides) {
        hits[id] = rolls
          .filter((r) => r.player === id)
          .reduce((sum, r) => sum + rollHits(state, r), 0);
      }
      // Valkyrie Particle Weave
      for (const id of sides) {
        if (hasTech(state, id, "vpw") && hits[opponentOf(id)] > 0) hits[id]++;
      }
      log(
        state,
        `Ground combat round ${combat.round} on ${combat.planet}: ${sides
          .map((id) => `${playerName(state, id)} ${plural(hits[id], "hit")}`)
          .join(", ")}.`,
        { rolls },
      );
      combat.stage = "assign";
      queueHits(
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
    case "assign":
      combat.stage = "roundEnd";
      for (const id of sides) duraniumArmor(state, id, combat.damagedAtStart?.[id] ?? []);
      harrow(state, combat);
      return;
    default:
      if (over()) break;
      combat.round++;
      combat.stage = "roundStart";
      return;
  }

  // The combat is over.
  const winner = sides.find((id) => fightsOnPlanet(units[id]));
  log(
    state,
    winner !== undefined
      ? `${playerName(state, winner)} won the ground combat on ${combat.planet}.`
      : `The ground combat on ${combat.planet} ended with no survivors.`,
  );
  tactical.groundCombat = undefined;
  closeWindows(state, COMBAT_WINDOWS);
  if (winner !== undefined) {
    afterCombatWon(state, winner, opponentOf(winner));
    if (state.phase === "finished") return;
    // Dacxive Animators
    if (hasTech(state, winner, "dxa")) {
      addUnits(units, winner, "infantry", 1);
      log(state, `Dacxive Animators placed 1 infantry on ${combat.planet}.`, {
        player: winner,
      });
    }
  }
  nextGroundCombat(state);
}

/**
 * Harrow: at the end of each round of ground combat, the L1Z1X ships in the
 * system bombard their opponent's ground forces on the planet.
 */
function harrow(state: GameState, combat: GroundCombat) {
  const tactical = state.tactical!;
  for (const id of [combat.attacker, combat.defender]) {
    if (!ownsAbility(state, id, "harrow")) continue;
    const opponent = opponentIn(combat, id);
    if (!hasGroundForces(state.planets[combat.planet].units[opponent])) continue;
    if (isShielded(state, combat.planet, id)) continue;
    if (conventionsOfWar(state) && planetTraits(state, combat.planet).includes("CULTURAL")) {
      continue;
    }
    const shooters = shootersIn(
      state,
      id,
      systemOf(state, tactical.system).space[id],
      "bombardment",
    );
    if (shooters.length === 0) continue;
    const { rolls, hits } = rollAbility(state, id, shooters, "bombardment");
    log(state, `Harrow: ${playerName(state, id)} bombarded ${combat.planet}: ${plural(hits, "hit")}.`, {
      player: id,
      rolls,
    });
    queueHits(state, [
      {
        kind: "assignHits",
        player: opponent,
        hits,
        source: "bombardment",
        system: tactical.system,
        planet: combat.planet,
        from: id,
      },
    ]);
  }
}

function establishControl(state: GameState) {
  const tactical = state.tactical!;
  const id = tactical.player;
  const system = systemOf(state, tactical.system);
  for (const name of tactical.invaded) {
    const planet = state.planets[name];
    // Naalu fighters return to space after the combat.
    const fighters = countOf(planet.units[id], "fighter");
    if (fighters > 0) {
      removeUnits(planet.units, id, "fighter", fighters);
      addUnits(system.space, id, "fighter", fighters);
    }
    const owners = playersWith(planet.units, hasGroundForces);
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
  const player = playerOf(state, id);
  const system = systemOf(state, tactical.system);
  tactical.step = "done";
  state.tactical = undefined;
  state.actionsThisTurn++;
  // Reclamation
  if (
    tactical.flags?.includes(`mecatol:${id}`) &&
    ownsAbility(state, id, "reclamation") &&
    state.planets[MECATOL_REX]?.controller === id
  ) {
    const mecatol = state.planets[MECATOL_REX];
    for (const type of ["pds", "spacedock"] as const) {
      if (unitsAvailable(state, id, type) > 0) addUnits(mecatol.units, id, type, 1);
    }
    log(state, `Reclamation: ${player.name} built on Mecatol Rex.`, { player: id });
  }
  afterAction(state, id);
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
  if (!tactical || state.phase === "finished") return false;
  switch (tactical.step) {
    case "moved":
      destroyBlockadedDocks(state, tactical.system);
      startSpaceCannonOffense(state);
      return true;
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
    case "bombardment":
      // Bombard, or move on once there is nothing to bombard.
      if (!canBombard(state)) {
        startCommit(state);
        return true;
      }
      return false;
    case "committed":
      startSpaceCannonDefense(state);
      return true;
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
