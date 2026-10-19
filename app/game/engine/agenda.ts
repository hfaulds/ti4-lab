/**
 * The agenda phase: revealing agendas, voting, and resolving each outcome,
 * with the laws that stay in play afterwards.
 */
import { PlayerId } from "~/types";
import {
  agendasById,
  isShip,
  objectivesById,
  strategyCardsById,
  technologiesById,
  UnitType,
} from "../data";
import { GameState } from "../types";
import {
  adjacentSystems,
  controlledPlanets,
  isDemilitarized,
  isHomeSystem,
  MECATOL_REX,
  planetInfluence,
  planetResources,
  planetTechSpecialties,
  planetTraits,
  systemsWithShips,
  wormholesOf,
} from "./board";
import { enforceFleetSupply } from "./combat";
import { checkVictory, gainControl, victoryPoints } from "./control";
import { destroyUnits, placeCommandToken, placeUnits } from "./effects/helpers";
import {
  activePlayers,
  addUnits,
  ask,
  clockwiseFrom,
  countOf,
  draw,
  drawActionCards,
  drawSecretObjective,
  ensure,
  log,
  playerName,
  playerOf,
  hasTech,
  plural,
  removeUnits,
  rollDie,
  shuffle,
  tokensInReinforcements,
  unitTypes,
} from "./helpers";
import { isSilenced, openWindow, ownsAbility } from "./reactions";
import { askSecondaries, placeStructure } from "./strategic";
import { hasCommander } from "./leaders";
import { gainCommandTokens, gainRelic } from "./relics";
import { startStrategyPhase } from "./phases";

export const playerByName = (state: GameState, name: string | undefined) =>
  state.seating.find((id) => state.players[id].name === name);

const lawInForce = (state: GameState, law: string) =>
  state.laws.some((l) => l.id === law && l.outcome !== "Against");

/** Reveals happen again when these agendas would have nothing to elect. */
const NEEDS_LAWS = ["abolishment", "miscount", "constitution"];

// --- Revealing ------------------------------------------------------------------

export function startAgendaPhase(state: GameState) {
  state.phase = "agenda";
  state.agenda = { number: 1, votes: [], voted: [], step: "start" };
  log(state, `Round ${state.round}: agenda phase.`);
  openWindow(state, "agendaStart", {}, clockwiseFrom(state, state.speaker));
}

/** Reveals the next agenda from the deck in place of the current one. */
function reveal(state: GameState) {
  const agenda = state.agenda!;
  for (;;) {
    const card = draw(state, state.decks.agendas);
    if (!card) {
      agenda.card = undefined;
      agenda.step = "done";
      log(state, "The agenda deck is empty.");
      return;
    }
    const data = agendasById[card];
    if (card === "covert") {
      // Covert Legislation: the players vote on the next agenda instead.
      state.decks.agendas.discard.push(card);
      log(state, "Covert Legislation: the speaker draws the agenda to be voted on.");
      continue;
    }
    const pointless =
      (NEEDS_LAWS.includes(card) && state.laws.length === 0) ||
      (card === "classified" &&
        state.seating.every((id) => state.players[id].scoredSecrets.length === 0));
    if (pointless) {
      state.decks.agendas.discard.push(card);
      log(state, `${data.name} was discarded with nothing to elect.`);
      continue;
    }
    agenda.card = card;
    agenda.votes = [];
    agenda.voted = [];
    agenda.result = undefined;
    agenda.step = "revealed";
    log(state, `Agenda ${agenda.number}: ${data.name} (${data.type}).`);
    // Veto, Quash, Political Favor, Political Secret
    openWindow(state, "agendaRevealed", { card }, clockwiseFrom(state, state.speaker));
    return;
  }
}

/** Discards the agenda being voted on and reveals another (Veto, Quash). */
export function replaceAgenda(state: GameState) {
  const agenda = state.agenda;
  if (!agenda?.card) return;
  state.decks.agendas.discard.push(agenda.card);
  log(state, `${agendasById[agenda.card].name} was discarded.`);
  state.prompts = state.prompts.filter(
    (p) => p.kind !== "window" || p.window !== "agendaRevealed",
  );
  reveal(state);
}

// --- Voting -----------------------------------------------------------------------

/** Outcomes that can be voted for on an agenda. */
export function agendaOutcomes(state: GameState, card: string): string[] {
  const agenda = agendasById[card];
  const planets = Object.values(state.planets).filter(
    (p) => p.controller !== undefined,
  );
  const withTrait = (trait: string) =>
    planets
      .filter((p) => planetTraits(state, p.name).includes(trait as never))
      .map((p) => p.name);
  switch (agenda.target) {
    case "forAgainst":
      return ["For", "Against"];
    case "player":
      return activePlayers(state).map((id) => state.players[id].name);
    case "planet":
      return planets.map((p) => p.name);
    case "nonHomePlanet":
      return planets
        .filter(
          (p) =>
            p.name !== MECATOL_REX &&
            state.systems[p.system].homeOf === undefined,
        )
        .map((p) => p.name);
    case "culturalPlanet":
      return withTrait("CULTURAL");
    case "hazardousPlanet":
      return withTrait("HAZARDOUS");
    case "industrialPlanet":
      return withTrait("INDUSTRIAL");
    case "law":
      return state.laws.map((law) => agendasById[law.id].name);
    case "strategyCard":
      return state.strategyCards.map((id) => strategyCardsById[id].name);
    case "scoredSecret":
      return state.seating.flatMap((id) => state.players[id].scoredSecrets);
    default:
      return [];
  }
}

/** Whether a player may vote on the agenda being decided. */
export function canVote(state: GameState, id: PlayerId) {
  const agenda = state.agenda;
  if (!agenda?.card) return false;
  if (state.players[id].eliminated) return false;
  if (hasCommander(state, id, "xxchacommander")) return true;
  // Galactic Threat
  if (ownsAbility(state, id, "galactic_threat")) return false;
  if (isSilenced(state, id) || agenda.barred?.includes(id)) return false;
  if (state.executed === id) return false;
  return true;
}

function askVotes(state: GameState) {
  // Voting starts left of the speaker, who votes last; Zeal puts the Argent first.
  const order = clockwiseFrom(state, state.speaker);
  const voters = [...order.slice(1), order[0]].filter((id) => canVote(state, id));
  const zealous = voters.filter((id) => ownsAbility(state, id, "zeal"));
  const sequence = [...zealous, ...voters.filter((id) => !zealous.includes(id))];
  for (const id of [...sequence].reverse()) {
    ask(state, [{ kind: "vote", player: id }]);
  }
  // Genetic Recombination
  openWindow(state, "beforeVote", { card: state.agenda?.card }, order);
}

const representativeGovernment = (state: GameState) =>
  lawInForce(state, "representative_government") || lawInForce(state, "rep_govt");

export function castVotes(
  state: GameState,
  id: PlayerId,
  outcome: string | undefined,
  planets: string[],
  extraVotes = 0,
  options: { predictive?: boolean; tradeGoods?: number } = {},
) {
  const agenda = state.agenda;
  ensure(agenda?.card, "There is no agenda to vote on.");
  ensure(canVote(state, id), "You cannot vote on this agenda.");
  const player = playerOf(state, id);
  agenda.voted.push(id);

  const representative = representativeGovernment(state);
  const recombination = agenda.recombination?.find((r) => r.player === id);
  if (
    outcome === undefined ||
    (!representative &&
      planets.length === 0 &&
      extraVotes === 0 &&
      !options.predictive &&
      !options.tradeGoods)
  ) {
    log(state, `${player.name} abstained.`, { player: id });
    if (recombination) loseFleetToken(state, id, "Genetic Recombination");
    return;
  }
  const outcomes = agendaOutcomes(state, agenda.card);
  ensure(
    outcomes.length === 0 || outcomes.includes(outcome),
    "That is not an outcome of this agenda.",
  );
  ensure(
    new Set(planets).size === planets.length,
    "A planet can only be exhausted once.",
  );
  ensure(
    Number.isInteger(extraVotes) && extraVotes >= 0,
    "Extra votes must be a whole number.",
  );
  let votes = extraVotes;
  if (representative) {
    // Representative Government: 1 vote each, no planets.
    ensure(planets.length === 0, "Planets cannot be exhausted to vote under Representative Government.");
    votes += 1;
  }
  // Elder Qanoj: each planet exhausted to vote gives 1 more vote.
  const qanoj = hasCommander(state, id, "xxchacommander") ? 1 : 0;
  for (const name of planets) {
    const planet = state.planets[name];
    ensure(planet?.controller === id, `You do not control ${name}.`);
    ensure(!planet.exhausted, `${name} is already exhausted.`);
    votes += planetInfluence(state, name) + qanoj;
    planet.exhausted = true;
  }
  if (options.predictive) {
    ensure(hasTech(state, id, "pi"), "You do not own Predictive Intelligence.");
    ensure(!player.exhaustedTechnologies.includes("pi"), "Predictive Intelligence is exhausted.");
    votes += 3;
    (agenda.predictive ??= []).push(id);
  }
  const tradeGoods = options.tradeGoods ?? 0;
  if (tradeGoods > 0) {
    ensure(hasCommander(state, id, "hacancommander"), "You cannot spend trade goods for votes.");
    ensure(Number.isInteger(tradeGoods) && tradeGoods <= player.tradeGoods, "You do not have that many trade goods.");
    player.tradeGoods -= tradeGoods;
    votes += 2 * tradeGoods;
  }
  // Zeal: 1 more vote for each player in the game.
  if (votes > 0 && ownsAbility(state, id, "zeal")) votes += activePlayers(state).length;
  if (recombination && !(outcome === recombination.outcome && votes > 0)) {
    loseFleetToken(state, id, "Genetic Recombination");
  }
  agenda.votes.push({ player: id, outcome, votes });
  log(state, `${player.name} cast ${plural(votes, "vote")} for ${outcome}.`, {
    player: id,
  });
  // Distinguished Councilor
  openWindow(state, "afterVote", { card: agenda.card }, [id]);
}

/** Adds votes to the outcome a player already voted for. */
export function addVotes(state: GameState, id: PlayerId, votes: number) {
  const vote = state.agenda?.votes.find((v) => v.player === id);
  ensure(vote, "You have not voted on this agenda.");
  vote.votes += votes;
  log(state, `${playerName(state, id)} cast ${plural(votes, "more vote")} for ${vote.outcome}.`, {
    player: id,
  });
}

export function tallyVotes(state: GameState) {
  const totals = new Map<string, number>();
  const votes = state.agenda?.votes ?? [];
  for (const vote of votes) {
    totals.set(vote.outcome, (totals.get(vote.outcome) ?? 0) + vote.votes);
    // Blood Pact: 4 more votes when the holder votes with the Empyrean.
    const pacts = state.players[vote.player].promissoryNotesInPlay.filter((n) => n.id === "blood_pact");
    for (const pact of pacts) {
      if (votes.some((v) => v.player === pact.owner && v.outcome === vote.outcome && v.votes > 0)) {
        totals.set(vote.outcome, totals.get(vote.outcome)! + 4);
      }
    }
  }
  return totals;
}

/** Returns a token from a player's fleet pool to their reinforcements. */
function loseFleetToken(state: GameState, id: PlayerId, reason: string) {
  const pools = state.players[id].pools;
  if (pools.fleet <= 0) return;
  pools.fleet--;
  enforceFleetSupply(state, id);
  log(state, `${reason}: ${playerName(state, id)} lost a token from their fleet pool.`, { player: id });
}

// --- Resolving --------------------------------------------------------------------

/** Settles the outcome; an elected player may still pass it on. */
export function resolveAgenda(state: GameState, outcome: string) {
  const agenda = state.agenda!;
  agenda.result = outcome;
  const elected = playerByName(state, outcome);
  agenda.step = "elected";
  if (elected !== undefined && agendasById[agenda.card!].target === "player") {
    // Confusing Legal Text, Confounding Legal Text
    openWindow(
      state,
      "whenElected",
      { card: agenda.card, player: elected },
      clockwiseFrom(state, state.speaker),
    );
  }
}

export function continueAgendaPhase(state: GameState): boolean {
  if (state.phase !== "agenda") return false;
  const agenda = state.agenda;
  if (!agenda) return false;

  switch (agenda.step ?? "start") {
    case "start":
      reveal(state);
      return true;
    case "revealed":
      agenda.step = "riders";
      // Riders, Assassinate Representative, Galactic Threat, Committee Formation
      openWindow(
        state,
        "afterAgendaRevealed",
        { card: agenda.card },
        clockwiseFrom(state, state.speaker),
      );
      return true;
    case "riders":
      if (agenda.result !== undefined) {
        // Committee Formation chose the elected player.
        resolveAgenda(state, agenda.result);
        return true;
      }
      agenda.step = "voting";
      askVotes(state);
      return true;
    case "voting":
      agenda.step = "tally";
      // Bribery
      openWindow(state, "afterSpeakerVotes", { card: agenda.card });
      return true;
    case "tally": {
      const totals = tallyVotes(state);
      const most = Math.max(0, ...totals.values());
      const leaders = [...totals.entries()]
        .filter(([, votes]) => votes === most && votes > 0)
        .map(([outcome]) => outcome);
      if (leaders.length === 1) {
        resolveAgenda(state, leaders[0]);
      } else {
        // A tie, or nobody voted: the speaker decides (LRR 8.19).
        agenda.step = "tie";
        const outcomes =
          leaders.length > 1 ? leaders : agendaOutcomes(state, agenda.card!);
        ask(state, [{ kind: "breakTie", player: state.speaker, outcomes }]);
      }
      return true;
    }
    case "tie":
      return false;
    case "elected":
      // Deadly Plot
      agenda.step = "outcome";
      openWindow(state, "whenOutcomeResolved", { card: agenda.card }, clockwiseFrom(state, state.speaker));
      return true;
    case "outcome":
      agenda.step = "done";
      applyOutcome(state);
      return true;
    case "done":
      finishAgenda(state);
      return true;
  }
}

function finishAgenda(state: GameState) {
  const agenda = state.agenda!;
  if (agenda.number === 1 && state.decks.agendas.draw.length + state.decks.agendas.discard.length > 0) {
    state.agenda = { number: 2, votes: [], voted: [], step: "start" };
    reveal(state);
    return;
  }
  // Checks and Balances (Against): each player readies only 3 planets.
  const limit = state.readyLimit;
  state.readyLimit = undefined;
  for (const id of state.seating) {
    const exhausted = controlledPlanets(state, id)
      .filter((p) => p.exhausted)
      .sort((a, b) => planetInfluence(state, b.name) + planetResources(state, b.name) - planetInfluence(state, a.name) - planetResources(state, a.name));
    for (const planet of exhausted.slice(0, limit ?? exhausted.length)) planet.exhausted = false;
  }
  state.agenda = undefined;
  state.executed = undefined;
  state.round++;
  startStrategyPhase(state);
}

// --- Laws -------------------------------------------------------------------------

/** Discards a law from play, with the attachment or card it put out. */
export function discardLaw(state: GameState, law: string) {
  const index = state.laws.findIndex((l) => l.id === law);
  if (index < 0) return;
  const [removed] = state.laws.splice(index, 1);
  for (const planet of Object.values(state.planets)) {
    planet.attachments = planet.attachments.filter((a) => a !== law);
  }
  // Cards that came with a victory point take it back.
  if (
    (law === "shard_of_the_throne" || law === "crown_of_emphidia" || law === "censure") &&
    removed.owner !== undefined
  ) {
    state.players[removed.owner].bonusVictoryPoints -= 1;
  }
  state.decks.agendas.discard.push(law);
  log(state, `${agendasById[law]?.name ?? law} was discarded from play.`);
}

/** Laws that attach to the elected planet. */
const PLANET_LAWS = [
  "core_mining",
  "demilitarized_zone",
  "holy_planet_of_ixth",
  "rt_biotic",
  "rt_cybernetic",
  "rt_propulsion",
  "rt_warfare",
  "senate_sanctuary",
  "terraforming_initiative",
];

/** Carries out the outcome of the agenda just decided. */
function applyOutcome(state: GameState) {
  const agenda = state.agenda!;
  const card = agendasById[agenda.card!];
  const outcome = agenda.result!;
  log(state, `${card.name} resolved: ${outcome}.`);

  const against = outcome === "Against";
  const staysInPlay = card.type === "law" && !(card.target === "forAgainst" && against);
  if (staysInPlay) {
    const owner = playerByName(state, outcome);
    state.laws.push({
      id: card.id,
      outcome,
      owner: card.target === "player" ? owner : undefined,
    });
    if (PLANET_LAWS.includes(card.id) && state.planets[outcome]) {
      state.planets[outcome].attachments.push(card.id);
    }
  } else {
    state.decks.agendas.discard.push(card.id);
  }

  OUTCOMES[card.id]?.(state, outcome);
  resolvePredictions(state, outcome);
  afterOutcome(state, outcome);
  checkVictory(state);
}

/** Future Sight, and Predictive Intelligence exhausting when its outcome lost. */
function afterOutcome(state: GameState, outcome: string) {
  const agenda = state.agenda!;
  for (const id of activePlayers(state)) {
    const backed =
      agenda.votes.some((v) => v.player === id && v.outcome === outcome && v.votes > 0) ||
      !!agenda.predictions?.some((p) => p.player === id && p.outcome === outcome);
    if (backed && ownsAbility(state, id, "future_sight")) {
      state.players[id].tradeGoods++;
      log(state, `Future Sight: ${playerName(state, id)} gained 1 trade good.`, { player: id });
    }
  }
  for (const id of agenda.predictive ?? []) {
    const vote = agenda.votes.find((v) => v.player === id);
    if (vote?.outcome !== outcome) state.players[id].exhaustedTechnologies.push("pi");
  }
}

const votersFor = (state: GameState, outcome: string) =>
  (state.agenda?.votes ?? []).filter((v) => v.outcome === outcome && v.votes > 0).map((v) => v.player);

const everyone = (state: GameState) => activePlayers(state);

function discardHand(state: GameState, id: PlayerId) {
  const player = state.players[id];
  state.decks.actionCards.discard.push(...player.actionCards);
  if (player.actionCards.length > 0) {
    log(state, `${player.name} discarded ${plural(player.actionCards.length, "action card")}.`, {
      player: id,
    });
  }
  player.actionCards = [];
}

/** Destroys the cheapest of a player's ships of a type beyond a limit. */
function destroyBeyond(state: GameState, id: PlayerId, type: UnitType, keep: number) {
  let excess =
    Object.values(state.systems).reduce((sum, s) => sum + countOf(s.space[id], type), 0) - keep;
  for (const system of Object.values(state.systems)) {
    if (excess <= 0) return;
    excess -= destroyUnits(state, id, { system: system.key }, type, Math.min(excess, countOf(system.space[id], type)));
  }
}

function placeInfantryEverywhere(state: GameState, id: PlayerId) {
  for (const planet of controlledPlanets(state, id)) {
    if (isDemilitarized(planet)) continue;
    placeUnits(state, id, "infantry", 1, { system: planet.system, planet: planet.name });
  }
}

/** Removes a command token from a player's pools, tactic first. */
function loseCommandToken(state: GameState, id: PlayerId) {
  const pools = state.players[id].pools;
  const pool = (["tactic", "fleet", "strategy"] as const).find((p) => pools[p] > 0);
  if (pool) pools[pool]--;
  if (pool === "fleet") enforceFleetSupply(state, id);
}

function grantResearch(state: GameState, id: PlayerId, count: number) {
  if (state.players[id].faction === "nekro") {
    // Propagation
    ask(state, [{ kind: "redistribute", player: id, gained: 3 * count }]);
    return;
  }
  ask(state, [{ kind: "research", player: id, count }]);
}

function addPublicObjective(state: GameState, deck: "stage1" | "stage2") {
  const id = draw(state, state.decks[deck]);
  if (!id) return;
  state.publicObjectives.push({ id, revealed: true, scoredBy: [] });
  log(state, `${objectivesById[id]?.name ?? id} was revealed as a public objective.`);
}

const OUTCOMES: Record<string, (state: GameState, outcome: string) => void> = {
  revolution: (state, outcome) => {
    if (outcome === "Against") state.nextStrategyEffects = [...(state.nextStrategyEffects ?? []), { kind: "exhaustPerTech" }];
  },
  secret: (state, outcome) => {
    const id = playerByName(state, outcome);
    if (id !== undefined) drawSecretObjective(state, id);
  },
  arms_reduction: (state, outcome) => {
    if (outcome === "For") {
      for (const id of everyone(state)) {
        destroyBeyond(state, id, "dreadnought", 2);
        destroyBeyond(state, id, "cruiser", 4);
      }
    } else {
      state.nextStrategyEffects = [...(state.nextStrategyEffects ?? []), { kind: "exhaustSpecialty" }];
    }
  },
  classified: (state, outcome) => {
    const owner = state.seating.find((id) => state.players[id].scoredSecrets.includes(outcome));
    if (owner === undefined) return;
    const player = state.players[owner];
    player.scoredSecrets = player.scoredSecrets.filter((s) => s !== outcome);
    state.publicObjectives.push({ id: outcome, revealed: true, scoredBy: [owner] });
    log(state, `${objectivesById[outcome]?.name ?? outcome} became a public objective.`);
  },
  redistribution: (state, outcome) => {
    const planet = state.planets[outcome];
    if (!planet) return;
    const controller = planet.controller;
    for (const owner of Object.keys(planet.units).map(Number)) {
      for (const type of unitTypes(planet.units[owner])) {
        destroyUnits(state, owner, { system: planet.system, planet: planet.name }, type, countOf(planet.units[owner], type));
      }
    }
    if (controller === undefined) return;
    const fewest = Math.min(...everyone(state).map((id) => victoryPoints(state, id)));
    const chosen = everyone(state).find((id) => victoryPoints(state, id) === fewest)!;
    if (placeUnits(state, chosen, "infantry", 1, { system: planet.system, planet: planet.name }) > 0) {
      gainControl(state, chosen, planet.name, { explore: false });
    }
  },
  disarmament: (state, outcome) => {
    const planet = state.planets[outcome];
    if (!planet) return;
    let destroyed = 0;
    for (const owner of Object.keys(planet.units).map(Number)) {
      for (const type of ["infantry", "mech"] as UnitType[]) {
        destroyed += destroyUnits(state, owner, { system: planet.system, planet: planet.name }, type, countOf(planet.units[owner], type));
      }
    }
    if (planet.controller !== undefined && destroyed > 0) {
      state.players[planet.controller].tradeGoods += destroyed;
      log(state, `${playerName(state, planet.controller)} gained ${plural(destroyed, "trade good")}.`);
    }
  },
  conventions: (state, outcome) => {
    if (outcome === "Against") for (const id of votersFor(state, "Against")) discardHand(state, id);
  },
  economic_equality: (state, outcome) => {
    for (const id of everyone(state)) {
      state.players[id].tradeGoods = outcome === "For" ? 5 : 0;
    }
  },
  travel_ban: (state, outcome) => {
    if (outcome !== "Against") return;
    const wormholeSystems = Object.values(state.systems).filter((s) => wormholesOf(s).length > 0);
    const affected = new Set<number>();
    for (const system of wormholeSystems) {
      affected.add(system.key);
      for (const key of adjacentSystems(state, system.key)) affected.add(key);
    }
    for (const key of affected) {
      for (const name of state.systems[key].planets) {
        const planet = state.planets[name];
        for (const owner of Object.keys(planet.units).map(Number)) {
          destroyUnits(state, owner, { system: key, planet: name }, "pds", countOf(planet.units[owner], "pds"));
        }
      }
    }
  },
  sanctions: (state, outcome) => {
    for (const id of everyone(state)) {
      if (outcome === "Against") {
        const hand = state.players[id].actionCards;
        if (hand.length === 0) continue;
        const [card] = shuffle(state, hand);
        hand.splice(hand.indexOf(card), 1);
        state.decks.actionCards.discard.push(card);
      } else {
        drawActionCards(state, id, 0);
      }
    }
  },
  regulations: (state, outcome) => {
    for (const id of everyone(state)) {
      const pools = state.players[id].pools;
      if (outcome === "For") {
        pools.fleet = Math.min(pools.fleet, 4);
        enforceFleetSupply(state, id);
      } else if (tokensInReinforcements(state, id) > 0) {
        pools.fleet++;
      }
    }
  },
  defense_act: (state, outcome) => {
    if (outcome !== "Against") return;
    for (const id of everyone(state)) {
      const planet = Object.values(state.planets).find((p) => countOf(p.units[id], "pds") > 0);
      if (planet) destroyUnits(state, id, { system: planet.system, planet: planet.name }, "pds", 1);
    }
  },
  incentive: (state, outcome) => addPublicObjective(state, outcome === "For" ? "stage1" : "stage2"),
  artifact: (state, outcome) => {
    if (outcome !== "For") return;
    const roll = rollDie(state);
    log(state, `Ixthian Artifact: the speaker rolled ${roll}.`);
    if (roll >= 6) {
      for (const id of everyone(state)) grantResearch(state, id, 2);
      return;
    }
    const mecatol = state.planets[MECATOL_REX]?.system;
    if (mecatol === undefined) return;
    destroyEverything(state, mecatol);
    for (const key of adjacentSystems(state, mecatol)) {
      for (const id of everyone(state)) destroySome(state, id, key, 3);
    }
  },
  abolishment: (state, outcome) => {
    const law = state.laws.find((l) => agendasById[l.id].name === outcome);
    if (law) discardLaw(state, law.id);
  },
  miscount: (state, outcome) => {
    const law = state.laws.find((l) => agendasById[l.id].name === outcome);
    if (!law) return;
    const index = state.laws.indexOf(law);
    state.laws.splice(index, 1);
    for (const planet of Object.values(state.planets)) {
      planet.attachments = planet.attachments.filter((a) => a !== law.id);
    }
    // Vote on it again as if it had just been revealed.
    const agenda = state.agenda!;
    agenda.card = law.id;
    agenda.votes = [];
    agenda.voted = [];
    agenda.result = undefined;
    agenda.predictions = undefined;
    agenda.barred = undefined;
    agenda.step = "revealed";
    log(state, `${agendasById[law.id].name} is voted on again.`);
  },
  mutiny: (state, outcome) => {
    for (const id of votersFor(state, "For")) {
      state.players[id].bonusVictoryPoints += outcome === "For" ? 1 : -1;
    }
  },
  constitution: (state, outcome) => {
    if (outcome !== "For") return;
    for (const law of [...state.laws]) discardLaw(state, law.id);
    state.nextStrategyEffects = [...(state.nextStrategyEffects ?? []), { kind: "exhaustHome" }];
  },
  execution: (state, outcome) => {
    const id = playerByName(state, outcome);
    if (id === undefined) return;
    discardHand(state, id);
    if (state.speaker === id) {
      const order = clockwiseFrom(state, id);
      state.speaker = order[1] ?? id;
      log(state, `${playerName(state, state.speaker)} is now the speaker.`);
    }
    state.executed = id;
  },
  schematics: (state, outcome) => {
    if (outcome !== "Against") return;
    for (const id of everyone(state)) {
      if (state.players[id].technologies.some((t) => t === "ws" || t === "pws2")) discardHand(state, id);
    }
  },
  seed_empire: (state, outcome) => {
    const points = everyone(state).map((id) => victoryPoints(state, id));
    const target = outcome === "For" ? Math.max(...points) : Math.min(...points);
    for (const id of everyone(state)) {
      if (victoryPoints(state, id) === target) state.players[id].bonusVictoryPoints += 1;
    }
  },
  shared_research: (state, outcome) => {
    if (outcome !== "Against") return;
    for (const id of everyone(state)) placeCommandToken(state, id, state.players[id].home);
  },
  plowshares: (state, outcome) => {
    for (const id of everyone(state)) {
      if (outcome === "Against") {
        placeInfantryEverywhere(state, id);
        continue;
      }
      let destroyed = 0;
      for (const planet of controlledPlanets(state, id)) {
        const half = Math.ceil(countOf(planet.units[id], "infantry") / 2);
        destroyed += destroyUnits(state, id, { system: planet.system, planet: planet.name }, "infantry", half);
      }
      state.players[id].tradeGoods += destroyed;
    }
  },
  unconventional: (state, outcome) => {
    for (const id of votersFor(state, "For")) {
      if (outcome === "For") drawActionCards(state, id, 2);
      else discardHand(state, id);
    }
  },
  wormhole_recon: (state, outcome) => {
    if (outcome !== "Against") return;
    for (const id of everyone(state)) {
      for (const system of systemsWithShips(state, id)) {
        if (wormholesOf(system).length > 0) placeCommandToken(state, id, system.key);
      }
    }
  },
  wormhole_research: (state, outcome) => {
    if (outcome === "Against") {
      for (const id of votersFor(state, "Against")) loseCommandToken(state, id);
      return;
    }
    for (const id of everyone(state)) {
      if (systemsWithShips(state, id).some((s) => wormholesOf(s).length > 0)) {
        grantResearch(state, id, 1);
      }
    }
    for (const system of Object.values(state.systems)) {
      if (!wormholesOf(system).some((w) => w === "ALPHA" || w === "BETA")) continue;
      for (const id of Object.keys(system.space).map(Number)) {
        for (const type of unitTypes(system.space[id]).filter(isShip)) {
          destroyUnits(state, id, { system: system.key }, type, countOf(system.space[id], type));
        }
      }
    }
  },
  core_mining: (state, outcome) => {
    const planet = state.planets[outcome];
    if (!planet) return;
    for (const owner of Object.keys(planet.units).map(Number)) {
      if (destroyUnits(state, owner, { system: planet.system, planet: outcome }, "infantry", 1) > 0) break;
    }
  },
  demilitarized_zone: (state, outcome) => {
    const planet = state.planets[outcome];
    if (!planet) return;
    for (const owner of Object.keys(planet.units).map(Number)) {
      for (const type of unitTypes(planet.units[owner])) {
        destroyUnits(state, owner, { system: planet.system, planet: outcome }, type, countOf(planet.units[owner], type));
      }
    }
  },
  representative_government: (state, outcome) => {
    if (outcome === "Against") {
      state.nextStrategyEffects = [
        ...(state.nextStrategyEffects ?? []),
        { kind: "exhaustCultural", players: votersFor(state, "Against") },
      ];
    }
  },
  rep_govt: (state, outcome) => OUTCOMES.representative_government(state, outcome),
  standardization: (state, outcome) => {
    const id = playerByName(state, outcome);
    if (id === undefined) return;
    const player = state.players[id];
    const available =
      player.pools.tactic + player.pools.fleet + player.pools.strategy + tokensInReinforcements(state, id);
    const tactic = Math.min(3, available);
    const fleet = Math.min(3, available - tactic);
    player.pools = { tactic, fleet, strategy: Math.min(2, available - tactic - fleet) };
    enforceFleetSupply(state, id);
  },
  articles_war: (state, outcome) => {
    if (outcome !== "Against") return;
    for (const id of votersFor(state, "For")) state.players[id].tradeGoods += 3;
  },
  checks: (state, outcome) => {
    if (outcome === "Against") state.readyLimit = 3;
  },
  cladenstine: (state, outcome) => {
    for (const id of everyone(state)) {
      if (outcome === "For") {
        loseCommandToken(state, id);
        loseCommandToken(state, id);
      } else {
        loseFleetToken(state, id, "Clandestine Operations");
      }
    }
  },
  crisis: (state, outcome) => {
    const card = state.strategyCards.find((c) => strategyCardsById[c].name === outcome);
    if (!card) return;
    const players = clockwiseFrom(state, state.speaker);
    askSecondaries(state, state.speaker, card, players, players);
  },
  minister_antiquities: (state, outcome) => {
    const id = playerByName(state, outcome);
    if (id !== undefined) gainRelic(state, id);
  },
  nexus: (state, outcome) => {
    if (outcome !== "Against") return;
    const mecatol = state.planets[MECATOL_REX]?.system;
    if (mecatol !== undefined) state.systems[mecatol].addedWormholes.push("GAMMA");
  },
  censure: (state, outcome) => gainCardPoint(state, outcome),
  rearmament: (state, outcome) => {
    for (const id of everyone(state)) {
      if (outcome === "For") {
        const home = controlledPlanets(state, id).find((p) => p.system === state.players[id].home);
        if (home) placeUnits(state, id, "mech", 1, { system: home.system, planet: home.name });
        continue;
      }
      for (const planet of Object.values(state.planets)) {
        const mechs = countOf(planet.units[id], "mech");
        if (mechs === 0) continue;
        removeUnits(planet.units, id, "mech", mechs);
        addUnits(planet.units, id, "infantry", mechs);
      }
      for (const system of Object.values(state.systems)) {
        const mechs = countOf(system.space[id], "mech");
        if (mechs === 0) continue;
        removeUnits(system.space, id, "mech", mechs);
        addUnits(system.space, id, "infantry", mechs);
      }
    }
  },
  grant_reallocation: (state, outcome) => {
    const id = playerByName(state, outcome);
    if (id === undefined) return;
    ask(state, [
      {
        kind: "effect",
        player: id,
        reaction: { kind: "ability", id: "grant_reallocation" },
        context: {},
      },
    ]);
  },
  warrant: (state, outcome) => {
    const id = playerByName(state, outcome);
    if (id === undefined) return;
    drawSecretObjective(state, id);
    drawSecretObjective(state, id);
  },
  shard_of_the_throne: (state, outcome) => gainCardPoint(state, outcome),
  crown_of_emphidia: (state, outcome) => gainCardPoint(state, outcome),
};

function gainCardPoint(state: GameState, outcome: string) {
  const id = playerByName(state, outcome);
  if (id === undefined) return;
  state.players[id].bonusVictoryPoints += 1;
  log(state, `${playerName(state, id)} gained 1 victory point (${victoryPoints(state, id)} VP).`);
}

function destroyEverything(state: GameState, key: number) {
  const system = state.systems[key];
  for (const id of Object.keys(system.space).map(Number)) {
    for (const type of unitTypes(system.space[id])) {
      destroyUnits(state, id, { system: key }, type, countOf(system.space[id], type));
    }
  }
  for (const name of system.planets) {
    const planet = state.planets[name];
    for (const id of Object.keys(planet.units).map(Number)) {
      for (const type of unitTypes(planet.units[id])) {
        destroyUnits(state, id, { system: key, planet: name }, type, countOf(planet.units[id], type));
      }
    }
  }
}

/** Destroys a player's cheapest units in a system, up to `count`. */
function destroySome(state: GameState, id: PlayerId, key: number, count: number) {
  const system = state.systems[key];
  const places = [
    { planet: undefined as string | undefined, group: system.space[id] },
    ...system.planets.map((name) => ({ planet: name, group: state.planets[name].units[id] })),
  ];
  let remaining = count;
  for (const type of ["fighter", "infantry", "destroyer", "pds", "cruiser", "carrier", "dreadnought", "spacedock", "flagship", "warsun", "mech"] as UnitType[]) {
    for (const place of places) {
      if (remaining <= 0) return;
      remaining -= destroyUnits(state, id, { system: key, planet: place.planet }, type, Math.min(remaining, countOf(place.group, type)));
    }
  }
}

// --- Predictions ------------------------------------------------------------------

/** Rider rewards and Galactic Threat, once the outcome is known. */
function resolvePredictions(state: GameState, outcome: string) {
  for (const prediction of state.agenda?.predictions ?? []) {
    if (prediction.outcome !== outcome) {
      log(state, `${playerName(state, prediction.player)} predicted wrongly.`);
      continue;
    }
    RIDER_REWARDS[prediction.card]?.(state, prediction.player, prediction);
  }
}

type Prediction = NonNullable<NonNullable<GameState["agenda"]>["predictions"]>[number];

const RIDER_REWARDS: Record<string, (state: GameState, id: PlayerId, prediction: Prediction) => void> = {
  "Construction Rider": (state, id, prediction) => {
    const planets = controlledPlanets(state, id).filter(
      (p) => countOf(p.units[id], "spacedock") === 0 && !isDemilitarized(p),
    );
    const planet =
      planets.find((p) => p.name === prediction.planet) ??
      planets.find((p) => !isHomeSystem(state.systems[p.system])) ??
      planets[0];
    if (planet) placeStructure(state, id, { type: "spacedock", planet: planet.name });
  },
  "Diplomacy Rider": (state, id, prediction) => {
    const systems = controlledPlanets(state, id).map((p) => p.system);
    const key = systems.find((k) => k === prediction.system) ?? state.players[id].home;
    for (const other of everyone(state)) {
      if (other !== id) placeCommandToken(state, other, key);
    }
  },
  "Imperial Rider": (state, id) => {
    state.players[id].bonusVictoryPoints += 1;
    log(state, `${playerName(state, id)} gained 1 victory point.`, { player: id });
  },
  "Leadership Rider": (state, id) => {
    ask(state, [{ kind: "redistribute", player: id, gained: 3 }]);
  },
  "Politics Rider": (state, id) => {
    drawActionCards(state, id, 3);
    state.speaker = id;
    log(state, `${playerName(state, id)} is now the speaker.`);
  },
  "Technology Rider": (state, id) => grantResearch(state, id, 1),
  "Keleres Rider": (state, id) => {
    drawActionCards(state, id, 1);
    state.players[id].tradeGoods += 2;
    log(state, `${playerName(state, id)} gained 2 trade goods.`, { player: id });
  },
  // Odlynn Myrr: a trade good and a command token for each player who did not back the prediction.
  "Odlynn Myrr": (state, id, prediction) => {
    const against = activePlayers(state).filter(
      (other) =>
        other !== id &&
        !state.agenda!.votes.some((v) => v.player === other && v.outcome === prediction.outcome && v.votes > 0),
    ).length;
    state.players[id].tradeGoods += against;
    gainCommandTokens(state, id, against);
  },
  "Trade Rider": (state, id) => {
    state.players[id].tradeGoods += 5;
    log(state, `${playerName(state, id)} gained 5 trade goods.`, { player: id });
  },
  "Warfare Rider": (state, id, prediction) => {
    const systems = systemsWithShips(state, id);
    const system =
      systems.find((s) => s.key === prediction.system) ??
      systems.find((s) => s.key === state.players[id].home) ??
      systems[0];
    if (system) placeUnits(state, id, "dreadnought", 1, { system: system.key });
  },
  "Galactic Threat": (state, id) => {
    const owned = new Set(state.players[id].technologies);
    const voters = votersFor(state, state.agenda!.result!);
    const tech = voters
      .flatMap((voter) => state.players[voter].technologies)
      .find((t) => !owned.has(t) && !isFactionTech(t));
    if (!tech) return;
    state.players[id].technologies.push(tech);
    log(state, `${playerName(state, id)} gained a technology through Galactic Threat.`, { player: id });
  },
};

const isFactionTech = (tech: string) => !!technologiesById[tech]?.faction;

// --- The next strategy phase ------------------------------------------------------

/** Effects agendas left for the start of the next strategy phase. */
export function applyNextStrategyEffects(state: GameState) {
  const effects = state.nextStrategyEffects ?? [];
  state.nextStrategyEffects = undefined;
  for (const effect of effects) {
    for (const id of effect.players ?? everyone(state)) {
      const planets = controlledPlanets(state, id);
      switch (effect.kind) {
        case "exhaustPerTech": {
          // The engine picks the least valuable planets.
          const count = state.players[id].technologies.length;
          const cheapest = [...planets].sort(
            (a, b) => planetInfluence(state, a.name) - planetInfluence(state, b.name),
          );
          for (const planet of cheapest.slice(0, count)) planet.exhausted = true;
          break;
        }
        case "exhaustSpecialty":
          for (const planet of planets) {
            if (planetTechSpecialties(state, planet.name).length > 0) planet.exhausted = true;
          }
          break;
        case "exhaustHome":
          for (const planet of planets) {
            if (planet.system === state.players[id].home) planet.exhausted = true;
          }
          break;
        case "exhaustCultural":
          for (const planet of planets) {
            if (planetTraits(state, planet.name).includes("CULTURAL")) planet.exhausted = true;
          }
          break;
      }
    }
  }
}
