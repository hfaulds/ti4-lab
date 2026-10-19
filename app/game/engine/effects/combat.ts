/**
 * Action cards, abilities, technologies, unit abilities and promissory
 * notes used during space combat, invasions and ground combat.
 */
import { PlayerId } from "~/types";
import { isGroundForce, isShip, technologiesById, UNIT_NAMES } from "../../data";
import {
  CombatRoll,
  GameState,
  GroundCombat,
  SpaceCombat,
  UnitType,
  WindowContext,
} from "../../types";
import {
  adjacentSystems,
  controlledPlanets,
  hasAnomaly,
  otherShipOwners,
  planetOf,
  systemOf,
  wormholesIn,
} from "../board";
import {
  combatFlag,
  rerollAll,
  rerollMisses,
  rollHits,
  setCombatFlag,
} from "../combat";
import { pay, produce } from "../economy";
import {
  addUnits,
  countOf,
  ensure,
  entries,
  hasGroundForces,
  hasShips,
  hasTech,
  log,
  playerName,
  playerOf,
  plural,
  removeUnits,
  rollDie,
  sumCounts,
  unitOf,
  unitsAvailable,
  unitTypes,
} from "../helpers";
import { closeWindows } from "../reactions";
import { executeRetreat, queueHits } from "../tactical";
import {
  destroyUnits,
  exhaustTech,
  readyTech,
  targetSystem,
  targetTechnology,
} from "./helpers";
import type { EffectArea } from "./index";
import { unitIs } from "../units";
import { Effect } from "./types";

// --- Reading the combat in progress ---------------------------------------------

const spaceCombatOf = (state: GameState): SpaceCombat | undefined =>
  state.tactical?.groundCombat ? undefined : state.tactical?.spaceCombat;

const groundCombatOf = (state: GameState): GroundCombat | undefined =>
  state.tactical?.groundCombat;

const combatOf = (state: GameState) => groundCombatOf(state) ?? spaceCombatOf(state);

const inCombat = (state: GameState, id: PlayerId) => {
  const combat = combatOf(state);
  return !!combat && (combat.attacker === id || combat.defender === id);
};

const inSpaceCombat = (state: GameState, id: PlayerId) => {
  const combat = spaceCombatOf(state);
  return !!combat && (combat.attacker === id || combat.defender === id);
};

const inGroundCombat = (state: GameState, id: PlayerId) => {
  const combat = groundCombatOf(state);
  return !!combat && (combat.attacker === id || combat.defender === id);
};

const opponentOf = (state: GameState, id: PlayerId) => {
  const combat = combatOf(state)!;
  return id === combat.attacker ? combat.defender : combat.attacker;
};

const activeKey = (state: GameState) => state.tactical!.system;
const activeSpace = (state: GameState) => systemOf(state, activeKey(state)).space;

const ownRolls = (state: GameState, id: PlayerId): CombatRoll[] =>
  (combatOf(state)?.rolls ?? []).filter((r) => r.player === id);

/** Cancels hits waiting in an assignHits prompt (Shields Holding, Maneuvering Jets). */
function cancelHits(state: GameState, ref: number | undefined, count: number) {
  const prompt = state.prompts.find((p) => p.id === ref);
  if (prompt?.kind !== "assignHits") return;
  prompt.hits -= Math.min(count, prompt.hits);
  log(state, `${playerName(state, prompt.player)} cancelled ${plural(count, "hit")}.`, {
    player: prompt.player,
  });
  if (prompt.hits <= 0) state.prompts = state.prompts.filter((p) => p.id !== ref);
}

const hitsWaiting = (state: GameState, ref: number | undefined) =>
  state.prompts.some((p) => p.id === ref && p.kind === "assignHits" && p.hits > 0);

/** Units immune to Direct Hit say so in their text. */
const resistsDirectHit = (state: GameState, id: PlayerId, type: UnitType) =>
  !!unitOf(state, id, type)?.ability?.includes('"Direct Hit"');

function hitOpponent(
  state: GameState,
  id: PlayerId,
  hits: number,
  options: { nonFighter?: boolean } = {},
) {
  queueHits(state, [
    {
      kind: "assignHits",
      player: opponentOf(state, id),
      hits,
      source: "spaceCombat",
      system: activeKey(state),
      from: id,
      nonFighter: options.nonFighter ? hits : undefined,
    },
  ]);
}

/** Replaces 1 of the opponent's infantry on the planet with 1 of your own. */
function convertInfantry(state: GameState, id: PlayerId, into: UnitType = "infantry") {
  const combat = groundCombatOf(state)!;
  const planet = planetOf(state, combat.planet);
  const opponent = opponentOf(state, id);
  if (countOf(planet.units[opponent], "infantry") === 0) return;
  destroyUnits(state, opponent, { system: planet.system, planet: planet.name }, "infantry", 1, id);
  if (unitsAvailable(state, id, into) > 0) addUnits(planet.units, id, into, 1);
  log(state, `${playerName(state, id)} replaced 1 of ${playerName(state, opponent)}'s infantry on ${planet.name}.`, {
    player: id,
  });
}

/** Rolls 1 die per ship against its combat value; returns the hits. */
function rollShips(state: GameState, id: PlayerId, types: UnitType[], label: string) {
  const dice = types.map((type) => ({ type, roll: rollDie(state) }));
  const hits = dice.filter(
    ({ type, roll }) => roll >= (unitOf(state, id, type)?.combat ?? 11),
  ).length;
  log(
    state,
    `${label}: ${playerName(state, id)} rolled ${dice.map((d) => d.roll).join(", ")} (${plural(hits, "hit")}).`,
    { player: id },
  );
  return hits;
}

function repairAll(state: GameState, id: PlayerId) {
  const key = activeKey(state);
  const system = systemOf(state, key);
  const groups = [system.space[id], ...system.planets.map((p) => state.planets[p].units[id])];
  for (const group of groups) {
    for (const stack of Object.values(group ?? {})) stack.damaged = 0;
  }
  log(state, `${playerName(state, id)} repaired their units.`, { player: id });
}

// --- Action cards -------------------------------------------------------------

const ACTION_CARDS: Record<string, Effect> = {
  "Morale Boost": {
    windows: ["roundStart"],
    usable: (state, id) => inCombat(state, id),
    resolve: (state, id) => {
      const combat = combatOf(state);
      if (!combat) return;
      combat.roundModifiers ??= {};
      combat.roundModifiers[id] = (combat.roundModifiers[id] ?? 0) + 1;
    },
  },
  "Fighter Prototype": {
    windows: ["roundStart"],
    usable: (state, id) =>
      inSpaceCombat(state, id) &&
      spaceCombatOf(state)!.round === 1 &&
      countOf(activeSpace(state)[id], "fighter") > 0,
    resolve: (state, id) => {
      const combat = spaceCombatOf(state);
      if (combat) setCombatFlag(combat, "r.prototype", id);
    },
  },
  "Skilled Retreat": {
    windows: ["roundStart"],
    targets: ["system"],
    usable: (state, id) => inSpaceCombat(state, id) && skilledRetreatOptions(state, id).length > 0,
    play: (state, id, targets) => {
      ensure(
        skilledRetreatOptions(state, id).includes(targetSystem(state, targets).key),
        "Choose an adjacent system without other players' ships.",
      );
    },
    resolve: (state, id, targets) => {
      const combat = spaceCombatOf(state);
      if (!combat) return;
      executeRetreat(state, id, targets.system!, true);
      combat.retreat = undefined;
      setCombatFlag(combat, "draw", combat.attacker);
      closeWindows(state, ["roundStart"]);
    },
  },
  "Emergency Repairs": {
    windows: ["roundStart", "roundEnd"],
    usable: (state, id) => inCombat(state, id),
    resolve: (state, id) => repairAll(state, id),
  },
  "Shields Holding": {
    windows: ["beforeCombatHits"],
    usable: (state, _id, context) => hitsWaiting(state, context.ref),
    resolve: (state, _id, _targets, context) => cancelHits(state, context.ref, 2),
  },
  "Maneuvering Jets": {
    windows: ["beforeSpaceCannonHits"],
    usable: (state, _id, context) => hitsWaiting(state, context.ref),
    resolve: (state, _id, _targets, context) => cancelHits(state, context.ref, 1),
  },
  "Direct Hit": {
    windows: ["afterSustain"],
    usable: (state, _id, context) =>
      context.player !== undefined &&
      context.unit !== undefined &&
      context.system !== undefined &&
      (systemOf(state, context.system).space[context.player]?.[context.unit]?.damaged ?? 0) > 0 &&
      !resistsDirectHit(state, context.player, context.unit),
    resolve: (state, id, _targets, context) =>
      destroyUnits(state, context.player!, { system: context.system! }, context.unit!, 1, id),
  },
  "Courageous to the End": {
    windows: ["afterShipDestroyed"],
    usable: (state, _id, context) =>
      context.player !== undefined &&
      context.system !== undefined &&
      hasShips(systemOf(state, context.system).space[context.player]),
    resolve: (state, id, _targets, context) => {
      const target = unitOf(state, id, context.unit!)?.combat ?? 11;
      const dice = [rollDie(state), rollDie(state)];
      const hits = dice.filter((d) => d >= target).length;
      log(state, `Courageous to the End: rolled ${dice.join(", ")} (${plural(hits, "hit")}).`, {
        player: id,
      });
      queueHits(state, [
        {
          kind: "assignHits",
          player: context.player!,
          hits,
          source: "destroyShips",
          system: context.system!,
          from: id,
        },
      ]);
    },
  },
  Intercept: {
    windows: ["afterRetreat"],
    usable: (state, _id, context) => spaceCombatOf(state)?.retreat?.player === context.player,
    resolve: (state, _id, _targets, context) => {
      const combat = spaceCombatOf(state);
      if (combat && combat.retreat?.player === context.player) {
        combat.retreat = undefined;
        log(state, `${playerName(state, context.player!)} cannot retreat this round.`);
      }
    },
  },
  Salvage: {
    windows: ["afterCombat"],
    usable: (state, _id, context) =>
      context.player !== undefined && state.players[context.player].commodities > 0,
    resolve: (state, id, _targets, context) => {
      const loser = playerOf(state, context.player!);
      const amount = loser.commodities;
      loser.commodities = 0;
      playerOf(state, id).tradeGoods += amount;
      log(state, `${loser.name} gave ${playerName(state, id)} ${plural(amount, "commodity")}.`, {
        player: id,
      });
    },
  },
  Bunker: {
    windows: ["invasionStart"],
    usable: (state, id, context) =>
      context.player !== id &&
      context.system !== undefined &&
      systemOf(state, context.system).planets.some(
        (p) => state.planets[p].controller === id,
      ),
    resolve: (state, id) => {
      (state.tactical!.flags ??= []).push(`bunker:${id}`);
    },
  },
  Disable: {
    windows: ["invasionStart"],
    usable: (state, id, context) =>
      context.player === id &&
      context.system !== undefined &&
      systemOf(state, context.system).planets.some((p) =>
        Object.keys(state.planets[p].units)
          .map(Number)
          .some((owner) => owner !== id && countOf(state.planets[p].units[owner], "pds") > 0),
      ),
    resolve: (state, id) => {
      (state.tactical!.flags ??= []).push(`disable:${id}`);
    },
  },
  Parley: {
    windows: ["afterCommit"],
    usable: (state, id, context) =>
      context.planet !== undefined &&
      context.player !== id &&
      state.planets[context.planet]?.controller === id,
    resolve: (state, _id, _targets, context) => {
      const invader = context.player!;
      const planet = planetOf(state, context.planet!);
      const space = systemOf(state, planet.system).space;
      for (const type of unitTypes(planet.units[invader])) {
        const stack = planet.units[invader][type]!;
        addUnits(space, invader, type, stack.count, stack.damaged);
      }
      delete planet.units[invader];
      const tactical = state.tactical!;
      tactical.invaded = tactical.invaded.filter((p) => p !== planet.name);
      log(state, `Parley: the units committed to ${planet.name} went back to space.`);
    },
  },
  "Fire Team": {
    windows: ["afterRolls"],
    usable: (state, id) => inGroundCombat(state, id) && ownRolls(state, id).length > 0,
    resolve: (state, id) => rerollMisses(state, ownRolls(state, id), () => true),
  },
};

function skilledRetreatOptions(state: GameState, id: PlayerId) {
  const key = activeKey(state);
  return adjacentSystems(state, key).filter((other) => {
    const system = state.systems[other];
    if (otherShipOwners(system, id).length > 0) return false;
    if (hasAnomaly(system, "SUPERNOVA")) return false;
    if (hasAnomaly(system, "ASTEROID_FIELD") && !hasTech(state, id, "amd")) return false;
    return true;
  });
}

// --- Abilities ----------------------------------------------------------------

const cruisersAndDestroyers = (state: GameState, id: PlayerId) =>
  countOf(activeSpace(state)[id], "cruiser") + countOf(activeSpace(state)[id], "destroyer");

const flagshipHere = (state: GameState, id: PlayerId, unit: string) =>
  countOf(activeSpace(state)[id], "flagship") > 0 && unitOf(state, id, "flagship")?.id === unit;

function sacrifice(state: GameState, id: PlayerId, unit: UnitType | undefined) {
  const type =
    unit === "cruiser" || unit === "destroyer"
      ? unit
      : countOf(activeSpace(state)[id], "destroyer") > 0
        ? "destroyer"
        : "cruiser";
  ensure(countOf(activeSpace(state)[id], type) > 0, `You have no ${UNIT_NAMES[type]} there.`);
  destroyUnits(state, id, { system: activeKey(state) }, type, 1);
}

const ABILITIES: Record<string, Effect> = {
  // Mentak
  ambush: {
    windows: ["combatStart"],
    usable: (state, id) => inSpaceCombat(state, id) && cruisersAndDestroyers(state, id) > 0,
    resolve: (state, id) => {
      // Up to 2 cruisers or destroyers, cruisers first as they hit more often.
      const space = activeSpace(state)[id];
      const types: UnitType[] = [];
      for (const type of ["cruiser", "destroyer"] as UnitType[]) {
        for (let i = 0; i < countOf(space, type) && types.length < 2; i++) types.push(type);
      }
      const hits = rollShips(state, id, types, "Ambush");
      hitOpponent(state, id, hits);
    },
  },
  // Letnev
  munitions: {
    windows: ["roundStart"],
    usable: (state, id) => inSpaceCombat(state, id) && state.players[id].tradeGoods >= 2,
    play: (state, id) => {
      playerOf(state, id).tradeGoods -= 2;
    },
    resolve: (state, id) => {
      const combat = spaceCombatOf(state);
      if (combat) setCombatFlag(combat, "r.munitions", id);
    },
  },
  // Yin
  devotion: {
    windows: ["roundEnd"],
    targets: ["unit"],
    usable: (state, id) =>
      inSpaceCombat(state, id) &&
      !combatFlag(spaceCombatOf(state), "r.devotion", id) &&
      cruisersAndDestroyers(state, id) > 0 &&
      hasShips(activeSpace(state)[opponentOf(state, id)]),
    play: (state, id, targets) => {
      setCombatFlag(spaceCombatOf(state)!, "r.devotion", id);
      sacrifice(state, id, targets.unit);
    },
    resolve: (state, id) => hitOpponent(state, id, 1),
  },
  indoctrination: {
    windows: ["groundCombatStart"],
    targets: ["payment", "choice"],
    usable: (state, id) => {
      if (!inGroundCombat(state, id)) return false;
      const planet = state.planets[groundCombatOf(state)!.planet];
      return countOf(planet.units[opponentOf(state, id)], "infantry") > 0;
    },
    play: (state, id, targets) => {
      // Moyin's Ashes: 1 more influence for a mech instead.
      const mech = targets.choice === "mech";
      if (mech) {
        ensure(unitIs(state, id, "mech", "yin_mech"), "You cannot deploy a mech this way.");
        ensure(unitsAvailable(state, id, "mech") > 0, "You have no mechs in your reinforcements.");
      }
      pay(state, id, targets.payment, "influence", mech ? 3 : 2);
    },
    resolve: (state, id, targets) => convertInfantry(state, id, targets.choice === "mech" ? "mech" : "infantry"),
  },
  ic: {
    windows: ["combatStart"],
    targets: ["unit"],
    usable: (state, id) => inSpaceCombat(state, id) && cruisersAndDestroyers(state, id) > 0,
    play: (state, id, targets) => sacrifice(state, id, targets.unit),
    resolve: (state, id) => hitOpponent(state, id, 1, { nonFighter: true }),
  },
  // Nekro
  technological_singularity: {
    windows: ["afterUnitDestroyed"],
    targets: ["technology"],
    usable: (state, id, context) =>
      inCombat(state, id) &&
      context.player !== undefined &&
      context.player !== id &&
      !combatFlag(combatOf(state), "singularity", id) &&
      !state.players[context.player].promissoryNotesInPlay.some(
        (n) => n.id === "antivirus" && n.owner === id,
      ) &&
      singularityTechs(state, id, context.player).length > 0,
    play: (state, id, targets, context) => {
      ensure(
        singularityTechs(state, id, context.player!).includes(targetTechnology(targets)),
        `Choose a technology ${playerName(state, context.player!)} owns that you do not.`,
      );
      setCombatFlag(combatOf(state)!, "singularity", id);
    },
    resolve: (state, id, targets) => {
      const player = playerOf(state, id);
      if (player.technologies.includes(targets.technology!)) return;
      player.technologies.push(targets.technology!);
      log(state, `${player.name} gained ${technologiesById[targets.technology!].name}.`, {
        player: id,
      });
    },
  },
  nekro_flagship: {
    windows: ["combatStart"],
    usable: (state, id) =>
      inSpaceCombat(state, id) &&
      flagshipHere(state, id, "nekro_flagship") &&
      hasGroundForces(activeSpace(state)[id]),
    resolve: (state, id) => {
      const combat = spaceCombatOf(state);
      if (combat) setCombatFlag(combat, "alastor", id);
    },
  },
  // Creuss
  ds: {
    windows: ["combatStart"],
    usable: (state, id) =>
      inSpaceCombat(state, id) &&
      wormholesIn(state, systemOf(state, activeKey(state)), id).length > 0,
    resolve: (state, id) => hitOpponent(state, id, 1),
  },
  md_base: {
    windows: ["roundStart"],
    usable: (state, id) => {
      if (!inGroundCombat(state, id) || !readyTech(state, id, "md_base")) return false;
      const planet = state.planets[groundCombatOf(state)!.planet];
      return unitTypes(planet.units[id]).some(
        (type) => unitOf(state, id, type)?.planetaryShield,
      );
    },
    play: (state, id) => exhaustTech(state, id, "md_base"),
    resolve: (state, id) => {
      const combat = groundCombatOf(state);
      if (combat) setCombatFlag(combat, "r.magen", id);
    },
  },
  hacan_flagship: {
    windows: ["afterRolls"],
    targets: ["amount"],
    usable: (state, id) =>
      inSpaceCombat(state, id) &&
      flagshipHere(state, id, "hacan_flagship") &&
      state.players[id].tradeGoods > 0,
    play: (state, id, targets) => {
      const amount = targets.amount ?? 1;
      ensure(
        Number.isInteger(amount) && amount > 0 && amount <= state.players[id].tradeGoods,
        "Spend a whole number of trade goods you have.",
      );
      playerOf(state, id).tradeGoods -= amount;
    },
    resolve: (state, id, targets) => {
      // Each trade good lifts the missed die closest to hitting.
      let budget = targets.amount ?? 1;
      const rolls = ownRolls(state, id);
      while (budget > 0) {
        const candidates = rolls.flatMap((roll) =>
          roll.dice.map((d, index) => ({ roll, index, gap: roll.target - (d + (roll.modifier ?? 0)) })),
        ).filter((c) => c.gap > 0);
        if (candidates.length === 0) break;
        candidates.sort((a, b) => a.gap - b.gap);
        const best = candidates[0];
        best.roll.dice[best.index]++;
        best.roll.hits = rollHits(state, best.roll);
        budget--;
      }
    },
  },
  sardakk_dreadnought2: {
    windows: ["roundEnd"],
    targets: ["units"],
    usable: (state, id) =>
      inSpaceCombat(state, id) && countOf(activeSpace(state)[id], "dreadnought") > 0,
    play: (state, id, targets) => {
      const opponent = opponentOf(state, id);
      const chosen = entries(targets.units);
      ensure(sumCounts(targets.units) <= 2, "Destroy up to 2 ships.");
      for (const [type, count] of chosen) {
        ensure(isShip(type), `${UNIT_NAMES[type]} is not a ship.`);
        ensure(
          countOf(activeSpace(state)[opponent], type) >= count,
          `${playerName(state, opponent)} does not have ${count} ${UNIT_NAMES[type]} there.`,
        );
      }
      destroyUnits(state, id, { system: activeKey(state) }, "dreadnought", 1);
    },
    resolve: (state, id, targets) => {
      const opponent = opponentOf(state, id);
      for (const [type, count] of entries(targets.units)) {
        destroyUnits(state, opponent, { system: activeKey(state) }, type, count, id);
      }
    },
  },
  // Salvage Operations: rebuild a ship type lost in the combat just won.
  so: {
    windows: ["afterCombat"],
    targets: ["production", "payment"],
    usable: (_state, _id, context) => sumCounts(context.units) > 0,
    resolve: (state, id, targets, context) => {
      const orders = (targets.production ?? []).filter((o) => o.count > 0);
      if (orders.length === 0) return;
      ensure(
        orders.length === 1 &&
          orders[0].count === 1 &&
          isShip(orders[0].type) &&
          (context.units?.[orders[0].type] ?? 0) > 0,
        "Produce 1 ship of a type destroyed in the combat.",
      );
      produce(state, id, context.system!, orders, targets.payment ?? { planets: [], tradeGoods: 0 }, {
        limit: 1,
      });
    },
  },
  // The Crown of Thalnos (law)
  crown_of_thalnos: {
    windows: ["afterRolls"],
    usable: (state, id) =>
      inCombat(state, id) &&
      !combatFlag(combatOf(state), "r.thalnos", id) &&
      ownRolls(state, id).some((r) => r.hits < r.dice.length),
    resolve: (state, id) => {
      const combat = combatOf(state)!;
      setCombatFlag(combat, "r.thalnos", id);
      const losses: UnitType[] = [];
      rerollMisses(state, ownRolls(state, id), () => true, (roll) => losses.push(roll.unit));
      const ground = groundCombatOf(state);
      const where = ground
        ? { system: activeKey(state), planet: ground.planet }
        : { system: activeKey(state) };
      for (const type of losses) destroyUnits(state, id, where, type, 1);
    },
  },
};

function singularityTechs(state: GameState, id: PlayerId, from: PlayerId) {
  const mine = state.players[id].technologies;
  const assimilator = hasTech(state, id, "vax", "vay");
  return state.players[from].technologies.filter(
    (tech) =>
      !mine.includes(tech) &&
      (!technologiesById[tech]?.faction || assimilator),
  );
}

// --- Promissory notes -----------------------------------------------------------

const noteOwner = (state: GameState, id: PlayerId, note: string) =>
  state.players[id].promissoryNotes.find((n) => n.id === note)?.owner;

const NOTES: Record<string, Effect> = {
  war_funding: {
    windows: ["afterRolls"],
    usable: (state, id) => {
      const owner = noteOwner(state, id, "war_funding");
      return owner !== undefined && owner !== id && inSpaceCombat(state, id);
    },
    resolve: (state, id) => {
      const opponent = opponentOf(state, id);
      rerollAll(state, ownRolls(state, opponent));
      rerollMisses(state, ownRolls(state, id), () => true);
    },
  },
  antivirus: {
    windows: ["combatStart", "groundCombatStart"],
    usable: (state, id, context: WindowContext) =>
      inCombat(state, id) && context.noteOwner === context.player,
    resolve: () => {},
  },
  tekklar: {
    windows: ["groundCombatStart"],
    usable: (state, id) => {
      const owner = noteOwner(state, id, "tekklar");
      return owner !== undefined && owner !== id && inGroundCombat(state, id);
    },
    resolve: (state, id) => {
      const combat = groundCombatOf(state);
      if (!combat) return;
      const opponent = opponentOf(state, id);
      combat.modifiers ??= {};
      combat.modifiers[id] = (combat.modifiers[id] ?? 0) + 1;
      if (state.players[opponent].faction === "sardakk") {
        combat.modifiers[opponent] = (combat.modifiers[opponent] ?? 0) - 1;
      }
    },
  },
  greyfire: {
    windows: ["groundCombatStart"],
    usable: (state, id) => {
      const owner = noteOwner(state, id, "greyfire");
      if (owner === undefined || owner === id || !inGroundCombat(state, id)) return false;
      const planet = state.planets[groundCombatOf(state)!.planet];
      const opponent = opponentOf(state, id);
      const defenders = unitTypes(planet.units[opponent])
        .filter(isGroundForce)
        .reduce((sum, type) => sum + countOf(planet.units[opponent], type), 0);
      return (
        state.players[opponent].faction !== "yin" &&
        defenders >= 2 &&
        countOf(planet.units[opponent], "infantry") > 0
      );
    },
    resolve: (state, id) => convertInfantry(state, id),
  },
  ragh: {
    windows: ["afterCommit"],
    targets: ["planet"],
    usable: (state, id, context) => {
      const owner = noteOwner(state, id, "ragh");
      return (
        context.player === id &&
        owner !== undefined &&
        owner !== id &&
        context.planet !== undefined &&
        hasGroundForces(state.planets[context.planet].units[owner])
      );
    },
    resolve: (state, id, targets, context) => {
      const saar = state.seating.find((p) => state.players[p].faction === "saar");
      if (saar === undefined) return;
      const from = planetOf(state, context.planet!);
      const destinations = controlledPlanets(state, saar).filter((p) => p.name !== from.name);
      const to =
        destinations.find((p) => p.name === targets.planet) ?? destinations[0];
      for (const type of unitTypes(from.units[saar]).filter(isGroundForce)) {
        const count = countOf(from.units[saar], type);
        removeUnits(from.units, saar, type, count);
        if (to) addUnits(to.units, saar, type, count);
      }
      log(
        state,
        `Ragh's Call: the Saar ground forces left ${from.name}${to ? ` for ${to.name}` : ""}.`,
        { player: id },
      );
    },
  },
};

export const COMBAT_EFFECTS: EffectArea = {
  actionCards: ACTION_CARDS,
  abilities: ABILITIES,
  notes: NOTES,
};
