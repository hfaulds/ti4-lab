import { PlayerId } from "~/types";
import {
  actionCardsById,
  isGroundForce,
  isShip,
  strategyCardsById,
  unitFor,
  UNIT_LIMITS,
  UnitData,
} from "../data";
import {
  CombatRoll,
  Deck,
  Forces,
  GameError,
  GameState,
  LogEntry,
  NewPrompt,
  PlayerState,
  Prompt,
  UnitCounts,
  UnitGroup,
  UnitType,
} from "../types";

export const MAX_ACTION_CARDS = 7;
export const MAX_SECRET_OBJECTIVES = 3;
const MAX_LOG_ENTRIES = 500;

export function fail(message: string): never {
  throw new GameError(message);
}

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

// --- Randomness -----------------------------------------------------------
// The generator state lives in the game so that replaying the same actions
// against the same starting state always produces the same dice and draws.

export function random(state: GameState): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const rollDie = (state: GameState) => Math.floor(random(state) * 10) + 1;

export function shuffle<T>(state: GameState, items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Draws from a deck, reshuffling the discard pile when it runs out. */
export function draw(state: GameState, deck: Deck): string | undefined {
  if (deck.draw.length === 0 && deck.discard.length > 0) {
    deck.draw = shuffle(state, deck.discard);
    deck.discard = [];
  }
  return deck.draw.shift();
}

// --- Log and prompts ------------------------------------------------------

export function log(
  state: GameState,
  text: string,
  extra: Partial<Omit<LogEntry, "id" | "round" | "phase" | "text">> = {},
) {
  state.log.push({
    id: state.nextId++,
    round: state.round,
    phase: state.phase,
    text,
    ...extra,
  });
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
  }
}

/**
 * Queues decisions ahead of anything already waiting. Prompts queued in the
 * same call may be answered in any order; later groups wait for them.
 */
export function ask(state: GameState, prompts: NewPrompt[]) {
  if (prompts.length === 0) return;
  const group = state.nextId++;
  state.prompts.unshift(
    ...prompts.map(
      (prompt) => ({ ...prompt, id: state.nextId++, group }) as Prompt,
    ),
  );
}

/** Prompts that can be answered right now. */
export function openPrompts(state: GameState): Prompt[] {
  const first = state.prompts[0];
  if (!first) return [];
  return state.prompts.filter((p) => p.group === first.group);
}

export function takePrompt<K extends Prompt["kind"]>(
  state: GameState,
  player: PlayerId,
  kind: K,
  promptId?: number,
): Extract<Prompt, { kind: K }> {
  const prompt = openPrompts(state).find(
    (p) =>
      p.player === player &&
      p.kind === kind &&
      (promptId === undefined || p.id === promptId),
  );
  if (!prompt) fail("There is nothing waiting on you for that.");
  state.prompts = state.prompts.filter((p) => p.id !== prompt.id);
  return prompt as Extract<Prompt, { kind: K }>;
}

// --- Players --------------------------------------------------------------

export function playerOf(state: GameState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (!player) fail(`Unknown player ${id}.`);
  return player;
}

export const playerName = (state: GameState, id: PlayerId) =>
  state.players[id]?.name ?? `Player ${id}`;

export const activePlayers = (state: GameState) =>
  state.seating.filter((id) => !state.players[id].eliminated);

/** Seats clockwise starting from `from` (inclusive). */
export function clockwiseFrom(state: GameState, from: PlayerId): PlayerId[] {
  const seats = activePlayers(state);
  const start = Math.max(0, seats.indexOf(from));
  return [...seats.slice(start), ...seats.slice(0, start)];
}

export const initiativeOf = (state: GameState, id: PlayerId) => {
  const cards = state.players[id].strategyCards.map(
    (card) => strategyCardsById[card.id]?.initiative ?? 99,
  );
  return cards.length > 0 ? Math.min(...cards) : 99;
};

/** Players in initiative order; clockwise from the speaker without cards. */
export function initiativeOrder(state: GameState): PlayerId[] {
  const seats = clockwiseFrom(state, state.speaker);
  return [...seats].sort(
    (a, b) =>
      initiativeOf(state, a) - initiativeOf(state, b) ||
      seats.indexOf(a) - seats.indexOf(b),
  );
}

export const totalTokens = (player: PlayerState) =>
  player.pools.tactic + player.pools.fleet + player.pools.strategy;

export const COMMAND_TOKEN_LIMIT = 16;

export function tokensOnBoard(state: GameState, id: PlayerId) {
  return Object.values(state.systems).filter((s) =>
    s.commandTokens.includes(id),
  ).length;
}

export const tokensInReinforcements = (state: GameState, id: PlayerId) =>
  COMMAND_TOKEN_LIMIT -
  totalTokens(state.players[id]) -
  tokensOnBoard(state, id);

export function hasTech(state: GameState, id: PlayerId, ...techs: string[]) {
  return techs.some((tech) => state.players[id].technologies.includes(tech));
}

export function unitOf(
  state: GameState,
  id: PlayerId,
  type: UnitType,
): UnitData | undefined {
  const player = state.players[id];
  return unitFor(
    player.faction,
    type,
    player.technologies,
    state.options.expansions,
  );
}

export function requireUnit(state: GameState, id: PlayerId, type: UnitType) {
  const unit = unitOf(state, id, type);
  if (!unit) fail(`${playerName(state, id)} cannot field that unit.`);
  return unit;
}

// --- Units ----------------------------------------------------------------

export const countOf = (group: UnitGroup | undefined, type: UnitType) =>
  group?.[type]?.count ?? 0;

export const unitTypes = (group: UnitGroup | undefined) =>
  (Object.keys(group ?? {}) as UnitType[]).filter(
    (type) => countOf(group, type) > 0,
  );

export const totalUnits = (
  group: UnitGroup | undefined,
  filter: (type: UnitType) => boolean = () => true,
) =>
  unitTypes(group)
    .filter(filter)
    .reduce((sum, type) => sum + countOf(group, type), 0);

export const hasShips = (group: UnitGroup | undefined) =>
  totalUnits(group, isShip) > 0;
export const hasGroundForces = (group: UnitGroup | undefined) =>
  totalUnits(group, isGroundForce) > 0;

export const playersWith = (
  forces: Forces,
  test: (group: UnitGroup) => boolean,
): PlayerId[] =>
  Object.keys(forces)
    .map(Number)
    .filter((id) => test(forces[id]));

export function addUnits(
  forces: Forces,
  player: PlayerId,
  type: UnitType,
  count: number,
  damaged = 0,
) {
  if (count <= 0) return;
  const group = (forces[player] ??= {});
  const stack = (group[type] ??= { count: 0, damaged: 0 });
  stack.count += count;
  stack.damaged += damaged;
}

/** Removes units, taking damaged ones first unless told otherwise. */
export function removeUnits(
  forces: Forces,
  player: PlayerId,
  type: UnitType,
  count: number,
  preferDamaged = true,
): number {
  if (count <= 0) return 0;
  const stack = forces[player]?.[type];
  if (!stack || stack.count < count) fail(`Not enough ${type} there.`);
  const healthy = stack.count - stack.damaged;
  const damagedRemoved = preferDamaged
    ? Math.min(stack.damaged, count)
    : Math.max(0, count - healthy);
  stack.count -= count;
  stack.damaged -= damagedRemoved;
  if (stack.count === 0) delete forces[player][type];
  if (Object.keys(forces[player]).length === 0) delete forces[player];
  return damagedRemoved;
}

export const entries = (counts: UnitCounts | undefined) =>
  (Object.entries(counts ?? {}) as [UnitType, number][]).filter(
    ([, count]) => count > 0,
  );

export const sumCounts = (counts: UnitCounts | undefined) =>
  entries(counts).reduce((sum, [, count]) => sum + count, 0);

export function unitsOnBoard(state: GameState, id: PlayerId, type: UnitType) {
  let total = 0;
  for (const system of Object.values(state.systems)) {
    total += countOf(system.space[id], type);
  }
  for (const planet of Object.values(state.planets)) {
    total += countOf(planet.units[id], type);
  }
  return total;
}

export const unitsAvailable = (state: GameState, id: PlayerId, type: UnitType) =>
  UNIT_LIMITS[type] - unitsOnBoard(state, id, type);

// --- Cards ----------------------------------------------------------------

export function drawActionCards(state: GameState, id: PlayerId, count: number) {
  const player = playerOf(state, id);
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const card = draw(state, state.decks.actionCards);
    if (!card) break;
    player.actionCards.push(card);
    drawn++;
  }
  if (drawn > 0) {
    log(
      state,
      `${player.name} drew ${drawn} action card${drawn === 1 ? "" : "s"}.`,
      { player: id },
    );
  }
  const excess = player.actionCards.length - MAX_ACTION_CARDS;
  if (
    excess > 0 &&
    !state.prompts.some(
      (p) => p.kind === "discardActionCards" && p.player === id,
    )
  ) {
    ask(state, [{ kind: "discardActionCards", player: id, count: excess }]);
  }
}

export function drawSecretObjective(state: GameState, id: PlayerId) {
  const player = playerOf(state, id);
  const card = draw(state, state.decks.secretObjectives);
  if (!card) return;
  player.secretObjectives.push(card);
  log(state, `${player.name} drew a secret objective.`, { player: id });
  const held = player.secretObjectives.length + player.scoredSecrets.length;
  if (held > MAX_SECRET_OBJECTIVES) {
    ask(state, [{ kind: "returnSecret", player: id }]);
  }
}

export const actionCardName = (id: string) => actionCardsById[id]?.name ?? id;

export function describeRolls(rolls: CombatRoll[]) {
  return rolls
    .map((r) => `${r.unit} [${r.dice.join(", ")}] vs ${r.target}`)
    .join("; ");
}

export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
