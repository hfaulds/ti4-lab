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
  breakthroughsById,
  explorationsById,
  factionSetupFor,
  isGroundForce,
  leadersById,
  objectivesById,
  promissoryNotesById,
  relicsById,
  strategyCardsById,
  technologiesById,
  UNIT_NAMES,
} from "../data";
import { GameAction, ObjectivePayment, ShipMove, StrategicPayload } from "../actions";
import {
  EffectTargets,
  GameState,
  Payment,
  SystemKey,
  UnitCounts,
  UnitGroup,
  UnitType,
} from "../types";
import {
  adjacentSystems,
  anomaliesOf,
  capacityIn,
  dockFighterAllowance,
  findRoute,
  hasAnomaly,
  MECATOL_REX,
  moveRulesFor,
  neighborsOf,
  planetInfluence,
  planetInfo,
  planetResources,
  planetTechSpecialties,
  riftsExited,
  wormholesOf,
} from "../engine/board";
import { countOf, openPrompts, totalUnits, unitOf, unitTypes } from "../engine/helpers";
import { objectiveProgress, objectiveStatus } from "../engine/objectives";
import { reactionName } from "../engine/reactions";
import { moveBonus } from "../engine/tactical";
import { GameView, viewFor } from "../view";
import { neighborlyMove, shipsReaching, sliceOf } from "./reach";
import { liftAfter } from "./lift";
import { victoryPoints } from "../engine/control";
import { strategyKind } from "../engine/strategic";
import { bestPlan, scriptedMove } from "./scriptedBot";
import { applyAction } from "../engine/index";
import { productionCapacity } from "../engine/economy";

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

/**
 * A system by its tile number, as the web app's board and game log name
 * it, rather than by its position on the map.
 */
export const systemRef = (state: GameState, key: SystemKey) =>
  `#${state.systems[key]?.systemId ?? key}`;

export function systemLabel(state: GameState, key: SystemKey) {
  const system = state.systems[key];
  const planets = system.planets.length ? system.planets.join(" / ") : "no planets";
  return `${systemRef(state, key)} ${planets}`;
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
  const tile = (key: SystemKey) => Number(state.systems[key].systemId) || 0;
  const keys = Object.values(state.systems)
    .filter((s) => s.onBoard || s.homeOf !== undefined)
    .map((s) => s.key)
    .sort((a, b) => tile(a) - tile(b));
  for (const key of keys) {
    const system = state.systems[key];
    const features = [
      ...anomaliesOf(system).map((a) => a.toLowerCase().replace("_", " ")),
      ...wormholesOf(system).map((w) => `${w.toLowerCase()} wormhole`),
      ...(system.homeOf !== undefined ? [`home of P${system.homeOf}`] : []),
    ];
    const planets = system.planets.map((p) => planetLabel(state, p)).join("; ");
    lines.push(
      `- ${systemRef(state, key)}: ${planets || "no planets"}${features.length ? ` [${features.join(", ")}]` : ""}` +
        ` → ${adjacentSystems(state, key).sort((a, b) => tile(a) - tile(b)).map((k) => systemRef(state, k)).join(", ")}`,
    );
  }
  return lines.join("\n");
}

// --- Turn block ---------------------------------------------------------------

function objectiveLine(state: GameState, seat: PlayerId, id: string, scoredBy?: PlayerId[]) {
  const data = objectivesById[id];
  const status = objectiveStatus(state, seat, id);
  const progress = objectiveProgress(state, seat, id);
  const yours = scoredBy?.includes(seat)
    ? "you scored this; it cannot be scored again"
    : status.met === "manual"
      ? "cannot be scored here"
      : status.met
        ? "you meet it"
        : progress
          ? `not met: ${progress.have} of ${progress.need}`
          : "not met";
  // Secrets say when they are scored: action-phase ones as soon as they
  // happen, without using the status phase's one public objective.
  const when =
    data?.kind === "secret"
      ? data.phase === "action"
        ? " [secret, scored in the action phase as soon as you meet it]"
        : ` [secret, scored in the ${data.phase} phase]`
      : "";
  const cost = status.cost
    ? ` (costs ${Object.entries(status.cost)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")})`
    : "";
  const others = (scoredBy ?? []).filter((p) => p !== seat);
  const scored = others.length
    ? `; scored by ${others.map((p) => `P${p}`).join(", ")}` +
      (scoredBy?.includes(seat) ? "" : ", which does not stop you scoring it too")
    : "";
  const ready = status.cost && !scoredBy?.includes(seat) ? spendable(state, seat, status.cost) : "";
  return `- ${data?.name ?? id} [${data?.points ?? "?"} VP]${when}: ${data?.text ?? ""} — ${yours}${cost}${scored}${ready}`;
}

/**
 * What the seat could pay towards a spend objective right now, from ready
 * planets and trade goods, since exhausting a planet for anything else
 * before the status phase takes it out of the total.
 */
function spendable(state: GameState, seat: PlayerId, cost: { resources?: number; influence?: number; tradeGoods?: number }) {
  const ready = Object.values(state.planets).filter((p) => p.controller === seat && !p.exhausted);
  const tradeGoods = state.players[seat].tradeGoods;
  const parts: string[] = [];
  for (const [currency, value] of [
    ["resources", planetResources],
    ["influence", planetInfluence],
  ] as const) {
    if (!cost[currency]) continue;
    const planets = ready.map((p) => ({ name: p.name, amount: value(state, p.name) })).filter((p) => p.amount > 0);
    const onPlanets = planets.reduce((sum, p) => sum + p.amount, 0);
    const list = planets.length ? ` (${planets.map((p) => `${p.name} ${p.amount}`).join(", ")})` : "";
    parts.push(
      `${onPlanets} ${currency} on ready planets${list} + ${tradeGoods} trade goods = ${onPlanets + tradeGoods} of ${cost[currency]}`,
    );
  }
  if (cost.tradeGoods) parts.push(`${tradeGoods} of ${cost.tradeGoods} trade goods`);
  return parts.length
    ? `. Ready now: ${parts.join("; ")}. Paid in the status phase, so exhausting these planets or spending trade goods first lowers it`
    : "";
}

/**
 * Where the seat's ships and ground forces are, so plans start from what
 * can actually move: carriers with what they hold aboard, ground forces on
 * planets, and systems already holding the seat's command token.
 */
function forcesSummary(state: GameState, seat: PlayerId): string[] {
  const lines: string[] = [];
  for (const system of Object.values(state.systems)) {
    const ships = unitTypes(system.space[seat]).filter((t) => t !== "fighter" && unitOf(state, seat, t)?.move);
    const aboard = totalUnits(system.space[seat], isGroundForce);
    const onPlanets = system.planets
      .filter((p) => totalUnits(state.planets[p].units[seat], isGroundForce) > 0)
      .map((p) => `${totalUnits(state.planets[p].units[seat], isGroundForce)} on ${p}`);
    const empty = system.planets.filter(
      (p) => state.planets[p].controller === seat && totalUnits(state.planets[p].units[seat], isGroundForce) === 0,
    );
    if (ships.length === 0 && onPlanets.length === 0 && empty.length === 0) continue;
    const capacity = capacityIn(state, system.key, seat);
    const fighters = countOf(system.space[seat], "fighter");
    const parts = [
      ships.length ? unitsLabel(Object.fromEntries(ships.map((t) => [t, system.space[seat]![t]!]))) : "no ships",
      capacity ? `${aboard} ground forces and ${fighters} fighters aboard, capacity ${capacity}` : "",
      onPlanets.length ? `ground forces ${onPlanets.join(", ")}` : "",
      empty.length ? `no ground forces on ${empty.join(", ")}` : "",
      system.commandTokens.includes(seat) ? "your command token is here, so these ships cannot move this round" : "",
      threatsTo(state, seat, system.key),
    ].filter(Boolean);
    lines.push(`- ${systemLabel(state, system.key)}: ${parts.join("; ")}`);
  }
  return lines.length ? lines : ["- none"];
}

/** Other players' ships that could reach `key` with one tactical action. */
function threatsTo(state: GameState, seat: PlayerId, key: SystemKey) {
  const threats = state.seating.flatMap((other) => {
    if (other === seat || state.players[other].eliminated) return [];
    const ships = Object.entries(shipsReaching(state, other, key)).filter(([, n]) => n);
    if (ships.length === 0) return [];
    return [`P${other} with ${ships.map(([t, n]) => `${n} ${t}`).join(", ")}`];
  });
  return threats.length ? `within one move of ${threats.join("; ")}` : "";
}

/**
 * Ground forces in `key` after building `units`, and how many of them
 * the seat's ships there could carry.
 */
function liftNote(state: GameState, seat: PlayerId, key: SystemKey, units: { type: string; count: number }[]) {
  const { ground, room } = liftAfter(state, seat, key, units);
  return `; afterwards ${ground} ground forces here and room for ${room} aboard your ships here`;
}

/** Everything the table can see about another player. */
function otherPlayer(state: GameState, view: GameView, id: PlayerId): string[] {
  const p = view.players[id];
  const planets = Object.values(view.planets).filter((x) => x.controller === id);
  const ready = planets.filter((x) => !x.exhausted);
  const sum = (list: typeof planets, value: typeof planetResources) =>
    list.reduce((s, x) => s + value(state, x.name), 0);
  const list = (items: string[]) => items.join(", ") || "none";

  const lines = [
    `- ${playerLabel(state, id)}: ${p.victoryPoints} VP${p.eliminated ? ", eliminated" : ""}${p.passed ? ", passed" : ""}. ` +
      `${planets.length} planets (${sum(ready, planetResources)}/${sum(planets, planetResources)} resources and ` +
      `${sum(ready, planetInfluence)}/${sum(planets, planetInfluence)} influence ready). ` +
      `Command tokens tactic ${p.pools.tactic}, fleet ${p.pools.fleet}, strategy ${p.pools.strategy}. ` +
      `Trade goods ${p.tradeGoods}, commodities ${p.commodities}/${p.commodityLimit}. ` +
      `Hand: ${p.hand.actionCards} action cards, ${p.hand.secretObjectives} secrets, ${p.hand.promissoryNotes} promissory notes.`,
    `  Strategy cards: ${list(p.strategyCards.map((c) => `${cardName(c.id)}${c.exhausted ? " (used)" : ""}`))}.`,
    `  Technologies: ${list(p.technologies.map((t) => `${techName(t)}${p.exhaustedTechnologies.includes(t) ? " (exhausted)" : ""}`))}.`,
  ];
  if (p.scoredSecrets.length) {
    lines.push(`  Secrets scored: ${list(p.scoredSecrets.map(objectiveName))}.`);
  }
  if (p.leaders.length) {
    lines.push(
      `  Leaders: ${list(p.leaders.map((l) => `${leadersById[l.id]?.name ?? l.id} (${l.type}, ${l.status})`))}.`,
    );
  }
  if (p.breakthrough) {
    const b = p.breakthrough;
    lines.push(
      `  Breakthrough: ${breakthroughsById[b.id]?.name ?? b.id} (${b.unlocked ? (b.exhausted ? "exhausted" : "unlocked") : "locked"}).`,
    );
  }
  if (p.relics.length || p.relicFragments.length) {
    lines.push(
      `  Relics: ${list(p.relics.map((r) => `${relicsById[r]?.name ?? r}${p.exhaustedRelics.includes(r) ? " (exhausted)" : ""}`))}; ` +
        `relic fragments: ${list(p.relicFragments.map((f) => explorationsById[f]?.name ?? f))}.`,
    );
  }
  if (p.promissoryNotesInPlay.length) {
    lines.push(
      `  Promissory notes in play: ${list(
        p.promissoryNotesInPlay.map((n) => `${promissoryNotesById[n.id]?.name ?? n.id} from P${n.owner}`),
      )}.`,
    );
  }
  return lines;
}

/**
 * Who leads and what each player could score this round, so the agent can
 * plan to deny the leader; and who holds Mecatol Rex and Imperial.
 */
function standings(state: GameState, seat: PlayerId): string[] {
  const mecatol = state.planets[MECATOL_REX]?.controller;
  const imperial = state.strategyCards.find((c) => strategyKind(c) === "imperial");
  const imperialHolder = state.seating.find((id) =>
    state.players[id].strategyCards.some((c) => strategyKind(c.id) === "imperial"),
  );
  const rows = [...state.seating]
    .sort((a, b) => victoryPoints(state, b) - victoryPoints(state, a))
    .map((id) => {
      const scorable = state.publicObjectives
        .filter((o) => o.revealed && !o.scoredBy.includes(id))
        .filter((o) => objectiveStatus(state, id, o.id).met === true)
        .map((o) => objectiveName(o.id));
      const notes = [
        id === mecatol ? "holds Mecatol Rex" : "",
        id === imperialHolder ? "holds Imperial" : "",
        scorable.length ? `could score now: ${scorable.join(", ")}` : "",
      ].filter(Boolean);
      return `- ${id === seat ? "You" : playerLabel(state, id)}: ${victoryPoints(state, id)} VP` +
        (notes.length ? `; ${notes.join("; ")}` : "");
    });
  const warnings: string[] = [];
  if (mecatol !== undefined && imperial && imperialHolder === undefined && state.phase === "strategy") {
    warnings.push(
      `Imperial is still unpicked and P${mecatol} holds Mecatol Rex: with Imperial they score a public objective and a point for Mecatol. Deny it if you can.`,
    );
  }
  if (mecatol !== undefined && imperialHolder === mecatol) {
    warnings.push(`P${mecatol} holds both Mecatol Rex and Imperial: taking Mecatol from them before they play it denies the extra point.`);
  }
  return [...rows, ...warnings];
}

/** The seat's slice and equidistant, with who holds each planet. */
function sliceSummary(state: GameState, seat: PlayerId): string[] {
  const { own, equidistant } = sliceOf(state, seat);
  const line = (key: SystemKey, label: string) => {
    const planets = state.systems[key].planets.map((p) => {
      const owner = state.planets[p].controller;
      return `${p} (${owner === seat ? "yours" : owner === undefined ? "unclaimed" : `P${owner}'s`})`;
    });
    return `- ${label} ${systemRef(state, key)}: ${planets.join(", ") || "no planets"}`;
  };
  const missing = own
    .flatMap((k) => state.systems[k].planets)
    .filter((p) => state.planets[p].controller !== seat);
  return [
    ...own.map((k) => line(k, "Slice")),
    ...equidistant.map((k) => line(k, "Equidistant (shared with a neighbour)")),
    missing.length
      ? `You do not yet hold ${missing.join(", ")} in your slice; each player is expected to own their slice, and not owning it is a severe economic disadvantage.`
      : "You hold every planet in your slice.",
  ];
}

/** Who could become your neighbor with one move, by you or by them. */
function neighborsInReach(state: GameState, seat: PlayerId, neighbors: PlayerId[]) {
  return state.seating.flatMap((id) => {
    if (id === seat || neighbors.includes(id) || state.players[id].eliminated) return [];
    const mine = neighborlyMove(state, seat, id);
    if (mine !== undefined) return [`${playerLabel(state, id)}, you can move to ${systemRef(state, mine)}`];
    const theirs = neighborlyMove(state, id, seat);
    return theirs !== undefined ? [`${playerLabel(state, id)}, they can move to ${systemRef(state, theirs)}`] : [];
  });
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
  lines.push(
    `Technologies: ${
      me.technologies
        .map((t) => `${techName(t)} (${technologiesById[t]?.color?.toLowerCase() ?? "unit upgrade"})`)
        .join(", ") || "none"
    }.`,
  );
  lines.push(
    `Action cards in hand: ${me.actionCards.length} (the planner offers them on your menu when one is worth playing).`,
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

  const neighbors = neighborsOf(state, seat);
  const reach = neighborsInReach(state, seat, neighbors);
  lines.push(
    `Neighbors: ${neighbors.map((id) => playerLabel(state, id)).join("; ") || "none yet"}. ` +
      `Could become neighbors with one move: ${reach.join("; ") || "nobody"}. ` +
      "Only neighbors can trade; you become neighbors by having units or planets in or next to a system where they do.",
  );

  lines.push("", "## Other players");
  for (const id of view.seating) {
    if (id === seat) continue;
    lines.push(...otherPlayer(state, view, id));
  }

  lines.push("", "## Standings", ...standings(state, seat));
  lines.push("", "## Your slice", ...sliceSummary(state, seat));
  lines.push("", "## Your forces", ...forcesSummary(state, seat));

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
    lines.push(`- ${systemRef(state, key)}: ${parts.join(" | ")}${tokens}`);
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

function payloadLabel(state: GameState, payload: StrategicPayload, seat: PlayerId) {
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
      return payload.allow?.length
        ? `gain 3 trade goods and replenish commodities; ${payload.allow.map((id) => `P${id}`).join(", ")} may replenish theirs without spending a token`
        : "gain 3 trade goods and replenish commodities";
    case "warfare":
      return payload.production
        ? `produce ${payload.production.units.map((u) => `${u.count} ${u.type}`).join(", ")} at home, paying ${paymentLabel(payload.production.payment)}` +
            liftNote(state, seat, state.players[seat].home, payload.production.units) +
            fighterNote(state, seat, payload.production.units)
        : payload.removeFrom !== undefined
          ? `remove your command token from ${systemRef(state, payload.removeFrom)}${freedShips(state, seat, payload.removeFrom)}`
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
function secondaryLabel(state: GameState, payload: StrategicPayload, seat: PlayerId) {
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
      return "draw 2 action cards";
    case "construction": {
      const [structure] = payload.structures;
      if (!structure) return "build nothing";
      const system = state.planets[structure.planet]?.system;
      return `build a ${structure.type === "pds" ? "PDS" : "space dock"} on ${structure.planet}; ` +
        `your command token goes into ${systemRef(state, system)}, so you cannot activate it this round`;
    }
    case "trade":
      return "replenish your commodities (no trade goods)";
    case "imperial":
      return "draw a secret objective";
    default:
      return payloadLabel(state, payload, seat);
  }
}

/** What taking a command token back from `key` frees to move again this round. */
function freedShips(state: GameState, seat: PlayerId, key: SystemKey) {
  const space = state.systems[key].space[seat];
  const ships = unitTypes(space).filter((t) => t !== "fighter" && unitOf(state, seat, t)?.move);
  if (ships.length === 0) return "";
  const aboard = totalUnits(space, isGroundForce);
  return `, so ${unitsLabel(Object.fromEntries(ships.map((t) => [t, space![t]!])))} there can move again this round` +
    (aboard ? ` with ${aboard} ground forces aboard` : " (with no ground forces aboard)");
}

/**
 * What fighters produced at home do to carrier space there: a space dock
 * keeps 3 fighters without a carrier, and the rest fill carrier capacity,
 * leaving less for ground forces (and stranding them if the carriers go).
 */
function fighterNote(state: GameState, seat: PlayerId, units: { type: string; count: number }[]) {
  const built = units.filter((u) => u.type === "fighter").reduce((sum, u) => sum + u.count, 0);
  if (built === 0) return "";
  const home = state.players[seat].home;
  const fighters = countOf(state.systems[home].space[seat], "fighter") + built;
  const free = dockFighterAllowance(state, home, seat);
  const over = fighters - free;
  if (over <= 0) return "";
  const capacity = capacityIn(state, home, seat);
  return `; afterwards ${fighters} fighters at home, where the space dock keeps ${free} without a carrier, so ${over} fill carrier space ` +
    `(${Math.max(0, capacity - over)} of ${capacity} left for ground forces there)`;
}

/**
 * Warnings for moves whose route leaves or passes through a gravity rift,
 * where each ship is lost on a roll of 1-3, with what it carries.
 */
function riftWarnings(state: GameState, seat: PlayerId, target: SystemKey, moves: ShipMove[]) {
  return moves.flatMap((m) => {
    const speeds = Object.keys(m.ships).map((t) => unitOf(state, seat, t as UnitType)?.move ?? 0);
    const move = Math.min(...speeds) + moveBonus(state, seat, m.from) + (m.gravityDrive ? 1 : 0);
    const route = m.path
      ? { path: m.path, rifts: riftsExited(state, m.path) }
      : findRoute(state, m.from, move, moveRulesFor(state, seat, target));
    if (!route || route.rifts === 0) return [];
    const via = route.path
      .slice(0, -1)
      .filter((k) => hasAnomaly(state.systems[k], "GRAVITY_RIFT"))
      .map((k) => systemRef(state, k));
    const loss = Math.round((1 - 0.7 ** route.rifts) * 100);
    return [
      `ships from ${systemRef(state, m.from)} go via the gravity rift at ${via.join(" and ")}: each has a ${loss}% chance to be lost, with its cargo`,
    ];
  });
}

/** What activating `key` would build, if the seat can produce there. */
function buildPreview(state: GameState, seat: PlayerId, key: SystemKey) {
  const dockArrives = bestPlan(state, seat, key)?.moves.some((m) => m.ships.spacedock);
  return productionCapacity(state, key, seat) > 0 || dockArrives
    ? productionPreview(state, seat, key)
    : undefined;
}

/**
 * Whether activating `key` would move nothing and build nothing: a stall,
 * which only spends a tactic token so that others act first.
 */
export function isStall(state: GameState, seat: PlayerId, key: SystemKey) {
  if (bestPlan(state, seat, key)?.moves.length) return false;
  return !buildPreview(state, seat, key)?.units.length;
}

/**
 * What activating `key` costs the seat beyond its tactic token, from what
 * happens the moment it is activated: promissory notes in its play area
 * going back to their owners (Support for the Throne with its point),
 * other players' technologies (Neuroglaive, E-Res Siphons), and the seat's
 * own notes another player could now play, such as Ceasefire. Only what
 * the seat can know is reported: no one's hidden action cards.
 */
export function activationCosts(state: GameState, seat: PlayerId, key: SystemKey): string[] {
  const activated = applyAction(state, seat, { type: "ACTIVATE_SYSTEM", system: key });
  if (!activated.ok) return [];
  const after = activated.state;
  const costs: string[] = [];
  const kept = after.players[seat].promissoryNotesInPlay;
  for (const note of state.players[seat].promissoryNotesInPlay) {
    if (kept.some((n) => n.id === note.id && n.owner === note.owner)) continue;
    const name = promissoryNotesById[note.id]?.name ?? note.id;
    costs.push(`returns ${name} to P${note.owner}${note.id === "sftt" ? ", losing its victory point" : ""}`);
  }
  const fleet = state.players[seat].pools.fleet - after.players[seat].pools.fleet;
  if (fleet > 0) costs.push(`loses ${fleet} fleet pool token${fleet === 1 ? "" : "s"}`);
  for (const other of state.seating) {
    if (other === seat) continue;
    const gained = after.players[other].tradeGoods - state.players[other].tradeGoods;
    if (gained > 0) costs.push(`P${other} gains ${gained} trade goods`);
  }
  for (const prompt of openPrompts(after)) {
    if (prompt.kind !== "window" || prompt.player === seat) continue;
    for (const option of prompt.options) {
      if (option.kind === "promissoryNote" && option.owner === seat) {
        costs.push(`P${prompt.player} may play your ${reactionName(option)}`);
      }
    }
  }
  return costs;
}

/** The menu line for choosing where to stall. */
export function stallLabel(state: GameState, seat: PlayerId, key: SystemKey) {
  const ships = totalUnits(state.systems[key].space[seat]) > 0;
  const costs = activationCosts(state, seat, key);
  return `Stall in ${systemLabel(state, key)}: ` +
    (ships ? "your ships there cannot move for the rest of the round" : "nothing of yours is there") +
    (costs.length ? `; ${costs.join("; ")}` : "");
}

/** The menu line that stands for every stall on offer. */
export const stallChoice = (count: number) =>
  `Stall: take a tactical action that does nothing but spend a tactic token, so others act first ` +
  `(you then choose where, from ${count} system${count === 1 ? "" : "s"}). Worth it late in the game with tokens to spare; ` +
  "early on the token is worth more to expansion and production.";

/**
 * What the planner would build in an activated system, found by playing the
 * activation forward with its choices up to the production step.
 */
function productionPreview(state: GameState, seat: PlayerId, key: SystemKey) {
  const activated = applyAction(state, seat, { type: "ACTIVATE_SYSTEM", system: key });
  if (!activated.ok) return undefined;
  let current = activated.state;
  for (let step = 0; step < 50; step++) {
    if (current.tactical?.system !== key) return undefined;
    const move = scriptedMove(current);
    if (!move) return undefined;
    if (move.player === seat && move.action.type === "PRODUCE") return move.action;
    const next = applyAction(current, move.player, move.action);
    if (!next.ok) return undefined;
    current = next.state;
  }
  return undefined;
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
        .map((m) => `${Object.entries(m.ships).map(([t, n]) => `${n} ${t}`).join(", ")} from ${systemRef(state, m.from)}`)
        .join("; ");
      const groundForces = (units: UnitCounts) => (units.infantry ?? 0) + (units.mech ?? 0);
      const cargo = plan?.cargo.reduce((sum, c) => sum + groundForces(c.units), 0);
      const sources = [
        ...new Set(plan?.cargo.filter((c) => groundForces(c.units) > 0).map((c) => c.planet ?? "space")),
      ];
      // Planets whose last ground forces leave can be taken by anyone who lands.
      const emptied = (plan?.cargo ?? [])
        .filter((c) => c.planet !== undefined && groundForces(c.units) > 0)
        .filter((c) => totalUnits(state.planets[c.planet!].units[seat], isGroundForce) <= groundForces(c.units))
        .map((c) => c.planet!);
      const rifts = plan ? [...new Set(riftWarnings(state, seat, action.system, plan.moves))] : [];
      const targets = system.planets.filter((p) => state.planets[p].controller !== seat);
      const defenders = (planet: string) =>
        Object.entries(state.planets[planet].units)
          .filter(([owner]) => Number(owner) !== seat)
          .reduce((sum, [, units]) => sum + totalUnits(units, isGroundForce), 0);
      const against = (planet: string) => (defenders(planet) ? ` against ${defenders(planet)} defending` : "");
      const landings = plan?.landings ?? [];
      const left = targets.filter((p) => !landings.some((l) => l.planet === p));
      const landing = [
        ...landings.map((l) => `lands ${l.need} on ${l.planet}${against(l.planet)}`),
        ...(left.length && landings.length
          ? [`does not take ${left.map((p) => `${p}${against(p)}`).join(", ")}: not enough ground forces`]
          : []),
      ];
      const parts = [
        moves ? `move ${moves}` : "move nothing",
        cargo ? `carrying ${cargo} ground forces (from ${sources.join(", ")})` : "",
        emptied.length ? `leaves ${emptied.join(" and ")} with no ground forces` : "",
        plan?.moves.some((m) => m.ships.spacedock) && action.system !== state.players[seat].home
          ? `your Floating Factory arrives and can produce here (production ${unitOf(state, seat, "spacedock")?.production ?? 0}) in this same action`
          : "",
        ...rifts,
        enemies.length ? `fight ${enemies.map((e) => `P${e} (${unitsLabel(system.space[e])})`).join(", ")}` : "",
        targets.length && !landings.length
          ? cargo
            ? `planets not yours: ${targets.join(", ")}`
            : `carries no ground forces, so takes none of ${targets.join(", ")}`
          : "",
        ...landing,
      ].filter(Boolean);
      parts.push(...activationCosts(state, seat, action.system));
      const built = buildPreview(state, seat, action.system);
      if (built?.units.length) {
        parts.push(
          `then you choose what to build here (the planner would build ${built.units.map((u) => `${u.count} ${u.type}`).join(", ")}, paying ${paymentLabel(built.payment)})`,
        );
      }
      return `Tactical action in ${systemLabel(state, action.system)}: ${parts.join("; ")}. ` +
        `Bot's estimate of the gain: ${(plan?.value ?? 0).toFixed(1)}. The bot plays out movement and landing.`;
    }
    case "STRATEGIC_ACTION":
      return `Play ${payloadName(action.payload)} (primary): ${payloadLabel(state, action.payload, seat)}`;
    case "PRODUCE": {
      if (action.units.length === 0) return "Build nothing";
      const units = action.units
        .map((u) => `${u.count} ${u.type}${u.planet ? ` on ${u.planet}` : ""}`)
        .join(", ");
      const key = state.tactical?.system ?? state.players[seat].home;
      const atHome = key === state.players[seat].home;
      return `Build ${units}, paying ${paymentLabel(action.payment)}` +
        liftNote(state, seat, key, action.units) +
        (atHome ? fighterNote(state, seat, action.units) : "");
    }
    case "RESOLVE_SECONDARY": {
      const [prompt] = openPrompts(state);
      // Which card, and whose: secondaries come from other players' cards.
      const whose =
        prompt?.kind === "secondary" ? ` of ${cardName(prompt.card)} (P${prompt.from} played it)` : "";
      if (!action.payload) return `Skip the secondary${whose}`;
      const free =
        action.payload.card === "leadership" ||
        (prompt?.kind === "secondary" && prompt.free);
      return `Use the secondary${whose}: ${secondaryLabel(state, action.payload, seat)}` +
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
      return `Use ${reactionName({ kind: "ability", id: action.ability })}${targetsLabel(state, action.targets)}`;
    case "PLAY_PROMISSORY_NOTE":
      return `Play ${promissoryNotesById[action.note]?.name ?? action.note} (P${action.owner}'s note)${targetsLabel(state, action.targets)}`;
    case "CHOOSE_SECRET":
      return `Keep the secret objective ${objectiveLine(state, seat, action.keep).slice(2)}`;
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
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(", ")}` : "";
}

const payloadName = (payload: StrategicPayload) =>
  payload.card.charAt(0).toUpperCase() + payload.card.slice(1);
