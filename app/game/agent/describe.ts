/**
 * Plain-text descriptions of a game for a language-model agent: a block
 * that stays the same all game, a block for the current turn, and labels
 * for candidate actions.
 *
 * Everything about other players comes from `viewFor`, so the text never
 * shows hidden cards. Static map data (planet values, adjacency) is read
 * from the state, since it is public.
 */
import { PlayerId } from "~/types";
import { factions } from "~/data/factionData";
import {
  abilitiesById,
  actionCardsById,
  factionSetupFor,
  objectivesById,
  promissoryNotesById,
  EXPANSIONS,
  strategyCardsById,
  technologiesById,
  UNIT_NAMES,
} from "../data";
import { GameAction, ObjectivePayment, StrategicPayload } from "../actions";
import { EffectTargets, GameState, Payment, SystemKey, UnitGroup } from "../types";
import {
  adjacentSystems,
  anomaliesOf,
  MECATOL_REX,
  planetInfluence,
  planetInfo,
  planetResources,
  planetTechSpecialties,
  wormholesOf,
} from "../engine/board";
import { openPrompts, unitTypes } from "../engine/helpers";
import { objectiveStatus } from "../engine/objectives";
import { reactionName } from "../engine/reactions";
import { viewFor } from "../view";
import { bestPlan } from "./scriptedBot";

const factionName = (state: GameState, id: PlayerId) =>
  factions[state.players[id].faction]?.name ?? state.players[id].faction;

export const playerLabel = (state: GameState, id: PlayerId) =>
  `P${id} (${factionName(state, id)})`;

const cardName = (id: string) => strategyCardsById[id]?.name ?? id;
const techName = (id: string) => technologiesById[id]?.name ?? id;
const objectiveName = (id: string) => objectivesById[id]?.name ?? id;

function planetLabel(state: GameState, name: string) {
  const info = planetInfo(state, name);
  const extras = [
    ...(info?.trait ?? []).map((t) => t.toLowerCase()),
    ...planetTechSpecialties(state, name).map((t) => `${t.toLowerCase()} skip`),
    ...(info?.legendary ? ["legendary"] : []),
  ];
  const values = `${planetResources(state, name)}/${planetInfluence(state, name)}`;
  return `${name} ${values}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export function systemLabel(state: GameState, key: SystemKey) {
  const system = state.systems[key];
  const planets = system.planets.length ? system.planets.join(" / ") : "no planets";
  return `#${key} ${planets}`;
}

function unitsLabel(group: UnitGroup | undefined) {
  return unitTypes(group)
    .map((type) => {
      const stack = group![type]!;
      const damaged = stack.damaged ? `, ${stack.damaged} damaged` : "";
      return `${stack.count} ${UNIT_NAMES[type].toLowerCase()}${damaged}`;
    })
    .join(", ");
}

// --- Game block ---------------------------------------------------------------

/**
 * Facts that do not change during a game: who is playing what, and the map.
 * Sent before the turn so the provider can cache it.
 */
export function describeGame(state: GameState, seat: PlayerId) {
  const lines: string[] = [];
  lines.push(`You are ${playerLabel(state, seat)}.`, "");
  const expansions = EXPANSIONS.filter((e) => state.options.expansions.includes(e.id));
  lines.push(
    `Expansions in play: ${expansions.length > 0 ? expansions.map((e) => e.name).join(", ") : "none (base game)"}.`,
    "",
  );
  lines.push("## Factions");
  for (const id of state.seating) {
    const setup = factionSetupFor(state.players[id].faction);
    const abilities = (setup?.abilities ?? [])
      .map((a) => abilitiesById[a]?.name)
      .filter(Boolean)
      .join(", ");
    lines.push(
      `- ${playerLabel(state, id)}${id === seat ? " — you" : ""}: home ${systemLabel(state, state.players[id].home)}. ` +
        `Abilities: ${abilities || "none"}.`,
    );
  }
  lines.push("", "## Strategy cards");
  for (const id of state.strategyCards) {
    const card = strategyCardsById[id];
    if (!card) continue;
    lines.push(
      `- ${card.name} (initiative ${card.initiative}). Primary: ${card.primary.join(" ")} ` +
        `Secondary: ${card.secondary.join(" ")}`,
    );
  }
  lines.push("", "## Map", "Each system: planets (resources/influence, traits), features, adjacent systems.");
  const keys = Object.values(state.systems)
    .filter((s) => s.onBoard || s.homeOf !== undefined)
    .map((s) => s.key)
    .sort((a, b) => a - b);
  for (const key of keys) {
    const system = state.systems[key];
    const features = [
      ...anomaliesOf(system).map((a) => a.toLowerCase().replace("_", " ")),
      ...wormholesOf(system).map((w) => `${w.toLowerCase()} wormhole`),
      ...(system.homeOf !== undefined ? [`home of P${system.homeOf}`] : []),
    ];
    const planets = system.planets.map((p) => planetLabel(state, p)).join("; ");
    lines.push(
      `- #${key}: ${planets || "no planets"}${features.length ? ` [${features.join(", ")}]` : ""}` +
        ` → ${adjacentSystems(state, key).sort((a, b) => a - b).join(", ")}`,
    );
  }
  return lines.join("\n");
}

// --- Turn block ---------------------------------------------------------------

function objectiveLine(state: GameState, seat: PlayerId, id: string, scoredBy?: PlayerId[]) {
  const data = objectivesById[id];
  const status = objectiveStatus(state, seat, id);
  const yours =
    status.met === "manual"
      ? "cannot be scored here"
      : status.met
        ? "you meet it"
        : "not met";
  const cost = status.cost
    ? ` (costs ${Object.entries(status.cost)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")})`
    : "";
  const scored = scoredBy?.length
    ? `; scored by ${scoredBy.map((p) => `P${p}`).join(", ")}`
    : "";
  return `- ${data?.name ?? id} [${data?.points ?? "?"} VP]: ${data?.text ?? ""} — ${yours}${cost}${scored}`;
}

/** The current position as the seat sees it. */
export function describeTurn(state: GameState, seat: PlayerId) {
  const view = viewFor(state, seat);
  const me = view.players[seat];
  const lines: string[] = [];

  const step = state.tactical
    ? `, tactical action in ${systemLabel(state, state.tactical.system)} (${state.tactical.step})`
    : state.statusStep
      ? `, ${state.statusStep}`
      : "";
  lines.push(
    `Round ${view.round}, ${view.phase} phase${step}. Speaker: P${view.speaker}. ` +
      `Victory needs ${view.options.victoryPoints} VP.`,
  );

  lines.push("", "## You");
  lines.push(
    `${playerLabel(state, seat)}: ${me.victoryPoints} VP. Command tokens tactic ${me.pools.tactic}, ` +
      `fleet ${me.pools.fleet}, strategy ${me.pools.strategy}. Trade goods ${me.tradeGoods}, ` +
      `commodities ${me.commodities}/${me.commodityLimit}.`,
  );
  lines.push(
    `Strategy cards: ${
      me.strategyCards.map((c) => `${cardName(c.id)}${c.exhausted ? " (used)" : ""}`).join(", ") || "none"
    }.${me.passed ? " You have passed." : ""}`,
  );
  lines.push(`Technologies: ${me.technologies.map(techName).join(", ") || "none"}.`);
  lines.push(
    `Action cards in hand: ${me.actionCards.length} (they cannot be played in this engine).`,
  );
  const planets = Object.values(view.planets).filter((p) => p.controller === seat);
  const ready = planets.filter((p) => !p.exhausted);
  lines.push(
    `Planets (${ready.reduce((s, p) => s + planetResources(state, p.name), 0)} resources and ` +
      `${ready.reduce((s, p) => s + planetInfluence(state, p.name), 0)} influence ready):`,
  );
  for (const p of planets) {
    lines.push(`- ${planetLabel(state, p.name)}${p.exhausted ? " — exhausted" : ""}`);
  }

  lines.push("", "## Objectives");
  for (const o of view.publicObjectives.filter((o) => o.revealed)) {
    lines.push(objectiveLine(state, seat, o.id, o.scoredBy));
  }
  lines.push("Your secret objectives:");
  for (const o of me.secretObjectives) lines.push(objectiveLine(state, seat, o));
  if (me.scoredSecrets.length) {
    lines.push(`Secrets you scored: ${me.scoredSecrets.map(objectiveName).join(", ")}.`);
  }
  lines.push(
    `Mecatol Rex: ${
      view.custodians
        ? "custodians token still on it (6 influence to remove, +1 VP)"
        : `controlled by ${view.planets[MECATOL_REX]?.controller !== undefined ? `P${view.planets[MECATOL_REX].controller}` : "nobody"}`
    }.`,
  );

  lines.push("", "## Other players");
  for (const id of view.seating) {
    if (id === seat) continue;
    const p = view.players[id];
    const count = Object.values(view.planets).filter((x) => x.controller === id).length;
    lines.push(
      `- ${playerLabel(state, id)}: ${p.victoryPoints} VP, ${count} planets, ${p.technologies.length} technologies, ` +
        `cards ${p.strategyCards.map((c) => `${cardName(c.id)}${c.exhausted ? " (used)" : ""}`).join(", ") || "none"}` +
        `${p.passed ? ", passed" : ""}. Hand: ${p.hand.actionCards} action cards, ${p.hand.secretObjectives} secrets. ` +
        `Trade goods ${p.tradeGoods}, commodities ${p.commodities}.`,
    );
  }

  lines.push("", "## Board", "Systems with units or controlled planets:");
  const keys = Object.values(view.systems)
    .filter(
      (s) =>
        Object.keys(s.space).length > 0 ||
        s.planets.some((p) => view.planets[p].controller !== undefined || Object.keys(view.planets[p].units).length > 0),
    )
    .map((s) => s.key)
    .sort((a, b) => a - b);
  for (const key of keys) {
    const system = view.systems[key];
    const parts: string[] = [];
    for (const owner of Object.keys(system.space).map(Number)) {
      parts.push(`space P${owner}: ${unitsLabel(system.space[owner])}`);
    }
    for (const name of system.planets) {
      const planet = view.planets[name];
      const units = Object.keys(planet.units)
        .map(Number)
        .map((owner) => `P${owner} ${unitsLabel(planet.units[owner])}`)
        .join("; ");
      const owner = planet.controller !== undefined ? `P${planet.controller}` : "uncontrolled";
      parts.push(`${name} (${owner})${units ? `: ${units}` : ""}`);
    }
    const tokens = system.commandTokens.length
      ? ` | command tokens: ${system.commandTokens.map((t) => `P${t}`).join(", ")}`
      : "";
    lines.push(`- #${key}: ${parts.join(" | ")}${tokens}`);
  }
  return lines.join("\n");
}

// --- Candidate labels -----------------------------------------------------------

const paymentLabel = (payment: Payment | undefined) =>
  payment
    ? [...payment.planets, ...(payment.tradeGoods ? [`${payment.tradeGoods} trade goods`] : [])].join(", ") || "nothing"
    : "nothing";

function objectivePaymentLabel(payment: ObjectivePayment | undefined) {
  if (!payment) return "";
  const parts = [
    payment.resources && `resources from ${paymentLabel(payment.resources)}`,
    payment.influence && `influence from ${paymentLabel(payment.influence)}`,
    payment.tradeGoods && `${payment.tradeGoods} trade goods`,
    payment.tokens && `${payment.tokens.tactic} tactic + ${payment.tokens.strategy} strategy tokens`,
    payment.actionCards?.length && `${payment.actionCards.length} action cards`,
  ].filter(Boolean);
  return parts.length ? ` paying ${parts.join("; ")}` : "";
}

function payloadLabel(payload: StrategicPayload) {
  switch (payload.card) {
    case "leadership":
      return `pools become ${payload.pools.tactic}/${payload.pools.fleet}/${payload.pools.strategy} (tactic/fleet/strategy)` +
        (payload.influence ? `, spending influence from ${paymentLabel(payload.influence)}` : "");
    case "diplomacy":
      return payload.ready.length ? `ready ${payload.ready.join(" and ")}` : "ready nothing";
    case "politics":
      return payload.speaker !== undefined ? `make P${payload.speaker} speaker, draw 2 action cards` : "draw 2 action cards";
    case "construction":
      return payload.structures.length
        ? `build ${payload.structures.map((s) => `${s.type === "pds" ? "PDS" : "space dock"} on ${s.planet}`).join(" and ")}`
        : "build nothing";
    case "trade":
      return "gain 3 trade goods and replenish commodities";
    case "warfare":
      return payload.production
        ? `produce ${payload.production.units.map((u) => `${u.count} ${u.type}`).join(", ")} at home, paying ${paymentLabel(payload.production.payment)}`
        : payload.removeFrom !== undefined
          ? `remove your command token from #${payload.removeFrom}`
          : "gain a tactic token";
    case "technology": {
      const research = [payload.research, payload.second].filter(Boolean).map((r) => techName(r!.technology));
      const pay = payload.payment ? `, paying ${paymentLabel(payload.payment)}` : "";
      return research.length ? `research ${research.join(" then ")}${pay}` : "research nothing";
    }
    case "imperial":
      return payload.objective
        ? `score ${objectiveName(payload.objective)}${objectivePaymentLabel(payload.payment)}`
        : "score nothing (gain Mecatol VP or draw a secret)";
  }
}

/** What a secondary does, which differs from the card's primary. */
function secondaryLabel(state: GameState, payload: StrategicPayload) {
  switch (payload.card) {
    case "leadership": {
      const spent = payload.influence
        ? payload.influence.planets.reduce(
            (sum, p) => sum + planetInfluence(state, p),
            payload.influence.tradeGoods,
          )
        : 0;
      const gained = Math.floor(spent / 3);
      return `spend influence from ${paymentLabel(payload.influence)} for ${gained} command token${gained === 1 ? "" : "s"}; ` +
        `pools become ${payload.pools.tactic}/${payload.pools.fleet}/${payload.pools.strategy} (tactic/fleet/strategy)`;
    }
    case "politics":
      return "draw 2 action cards (they cannot be played in this engine)";
    case "construction": {
      const [structure] = payload.structures;
      if (!structure) return "build nothing";
      const system = state.planets[structure.planet]?.system;
      return `build a ${structure.type === "pds" ? "PDS" : "space dock"} on ${structure.planet}; ` +
        `your command token goes into #${system}, so you cannot activate it this round`;
    }
    case "trade":
      return "replenish your commodities (no trade goods)";
    case "imperial":
      return "draw a secret objective";
    default:
      return payloadLabel(payload);
  }
}

/** A short, readable description of an action the agent could take. */
export function describeAction(state: GameState, seat: PlayerId, action: GameAction): string {
  switch (action.type) {
    case "PICK_STRATEGY_CARD": {
      const bonus = state.strategyCardBonus[action.card] ?? 0;
      return `Pick ${cardName(action.card)} (initiative ${strategyCardsById[action.card]?.initiative})` +
        (bonus ? `, with ${bonus} trade goods on it` : "");
    }
    case "ACTIVATE_SYSTEM": {
      const plan = bestPlan(state, seat, action.system);
      const system = state.systems[action.system];
      const enemies = Object.keys(system.space).map(Number).filter((p) => p !== seat);
      const moves = plan?.moves
        .map((m) => `${Object.entries(m.ships).map(([t, n]) => `${n} ${t}`).join(", ")} from #${m.from}`)
        .join("; ");
      const cargo = plan?.cargo.reduce(
        (sum, c) => sum + (c.units.infantry ?? 0) + (c.units.mech ?? 0),
        0,
      );
      const targets = system.planets.filter((p) => state.planets[p].controller !== seat);
      const parts = [
        moves ? `move ${moves}` : "move nothing",
        cargo ? `carrying ${cargo} ground forces` : "",
        enemies.length ? `fight ${enemies.map((e) => `P${e} (${unitsLabel(system.space[e])})`).join(", ")}` : "",
        targets.length ? `planets not yours: ${targets.join(", ")}` : "",
      ].filter(Boolean);
      return `Tactical action in ${systemLabel(state, action.system)}: ${parts.join("; ")}. ` +
        `Bot's estimate of the gain: ${(plan?.value ?? 0).toFixed(1)}. The bot plays out movement, landing and production.`;
    }
    case "STRATEGIC_ACTION":
      return `Play ${payloadName(action.payload)} (primary): ${payloadLabel(action.payload)}`;
    case "RESOLVE_SECONDARY": {
      if (!action.payload) return "Skip the secondary";
      const [prompt] = openPrompts(state);
      const free =
        action.payload.card === "leadership" ||
        (prompt?.kind === "secondary" && prompt.free);
      return `Use the secondary: ${secondaryLabel(state, action.payload)}` +
        (free ? "" : " (costs 1 strategy token)");
    }
    case "SCORE_OBJECTIVES": {
      const scored = [action.publicObjective, action.secretObjective].filter(Boolean).map((o) => objectiveName(o!));
      return scored.length
        ? `Score ${scored.join(" and ")}${objectivePaymentLabel(action.payment)}`
        : "Score nothing";
    }
    case "ANNOUNCE_RETREAT":
      return action.to !== undefined ? `Retreat to ${systemLabel(state, action.to)}` : "Do not retreat";
    case "PROPOSE_TRANSACTION":
      return `Offer P${action.to} a trade: give ${JSON.stringify(action.give)}, receive ${JSON.stringify(action.receive)}`;
    case "PLAY_ACTION_CARD": {
      const card = actionCardsById[action.card];
      return `Play the action card ${card?.name ?? action.card}${targetsLabel(state, action.targets)}: ${card?.text ?? ""}`;
    }
    case "USE_ABILITY":
      return `Use ${reactionName({ kind: action.source ?? "ability", id: action.ability })}${targetsLabel(state, action.targets)}`;
    case "RESOLVE_EFFECT":
      return `Resolve it${targetsLabel(state, action.targets)}${action.targets?.decline ? " (decline)" : ""}`;
    case "PLAY_PROMISSORY_NOTE":
      return `Play ${promissoryNotesById[action.note]?.name ?? action.note} (P${action.owner}'s note)${targetsLabel(state, action.targets)}`;
    case "PASS":
      return "Pass for the rest of the round";
    case "END_TURN":
      return "End your turn";
    default:
      return JSON.stringify(action);
  }
}

/** Choices made with a card or ability, in words. */
function targetsLabel(state: GameState, targets: EffectTargets | undefined) {
  if (!targets) return "";
  const parts = [
    targets.player !== undefined ? `targeting ${playerLabel(state, targets.player)}` : "",
    targets.planet ? `on ${targets.planet}` : "",
    targets.system !== undefined ? `in ${systemLabel(state, targets.system)}` : "",
    targets.technology ? `for ${technologiesById[targets.technology]?.name ?? targets.technology}` : "",
    targets.outcome ? `predicting ${targets.outcome}` : "",
    targets.choice ? `(${targets.choice})` : "",
    targets.card ? `choosing ${targets.card}` : "",
    targets.fragments?.length ? `purging ${targets.fragments.length} relic fragments` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(", ")}` : "";
}

const payloadName = (payload: StrategicPayload) =>
  payload.card.charAt(0).toUpperCase() + payload.card.slice(1);
