/**
 * Playing action cards and promissory notes and using abilities: the windows
 * in which players may react, and the effects waiting to resolve while other
 * players decide whether to cancel them.
 */
import { PlayerId } from "~/types";
import {
  abilitiesById,
  actionCardsById,
  agendasById,
  explorationsById,
  factionSetupFor,
  leadersById,
  promissoryNotesById,
  relicsById,
  technologiesById,
  UNIT_NAMES,
  unitsById,
  UnitType,
} from "../data";
import { GameAction } from "../actions";
import {
  EffectTargets,
  GameState,
  NewPrompt,
  PendingEffect,
  Prompt,
  Reaction,
  WindowContext,
  WindowId,
} from "../types";
import { isLegendary } from "./board";
import { effects } from "./effects";
import { Effect } from "./effects/types";
import {
  ask,
  clockwiseFrom,
  ensure,
  fail,
  log,
  openPrompts,
  playerName,
  playerOf,
  takePrompt,
  unitOf,
} from "./helpers";
import { spendLeader, unlockCommander, usableLeaders } from "./leaders";
import { breakDuress, requireAction } from "./phases";

const UNIT_TYPES = Object.keys(UNIT_NAMES) as UnitType[];

// --- What a player can use ----------------------------------------------------

export function effectFor(reaction: Reaction): Effect | undefined {
  switch (reaction.kind) {
    case "actionCard": {
      const card = actionCardsById[reaction.id];
      return card ? effects().actionCards[card.name] : undefined;
    }
    case "ability":
      return effects().abilities[reaction.id];
    case "promissoryNote":
      return effects().notes[reaction.id];
    case "leader":
      return effects().leaders[reaction.id];
    case "relic":
      return effects().relics[reaction.id];
    case "exploration": {
      const card = explorationsById[reaction.id];
      return card ? effects().explorations[card.name] : undefined;
    }
    case "planet":
      return effects().planets[reaction.id];
  }
}

export const reactionName = (reaction: Reaction) => {
  switch (reaction.kind) {
    case "actionCard":
      return actionCardsById[reaction.id]?.name ?? reaction.id;
    case "promissoryNote":
      return promissoryNotesById[reaction.id]?.name ?? reaction.id;
    case "ability":
      return abilityName(reaction.id);
    case "leader":
      return leadersById[reaction.id]?.name ?? reaction.id;
    case "relic":
      return relicsById[reaction.id]?.name ?? reaction.id;
    case "exploration":
      return explorationsById[reaction.id]?.name ?? reaction.id;
    case "planet":
      return reaction.id;
  }
};

const abilityName = (id: string) =>
  abilitiesById[id]?.name ??
  technologiesById[id]?.name ??
  unitsById[id]?.name ??
  agendasById[id]?.name ??
  id;

/** Players the Political Secret note has silenced for the current agenda. */
export const isSilenced = (state: GameState, id: PlayerId) =>
  !!state.agenda?.silenced?.includes(id);

export function canPlayActionCards(state: GameState, id: PlayerId) {
  if (isSilenced(state, id)) return false;
  // Political Censure
  if (state.laws.some((law) => law.id === "censure" && law.owner === id)) return false;
  // Transparasteel Plating: passed players stay quiet on the Yssaril turn.
  const active = state.activePlayer;
  if (
    state.phase === "action" &&
    active !== undefined &&
    active !== id &&
    state.players[id].passed &&
    state.players[active].technologies.includes("tp")
  ) {
    return false;
  }
  return true;
}

/**
 * Faction abilities, technologies, unit abilities and laws a player owns,
 * by id. Faction abilities are left out while the player is silenced.
 */
export function ownedAbilities(state: GameState, id: PlayerId): string[] {
  const player = state.players[id];
  const owned: string[] = [];
  if (!isSilenced(state, id)) {
    owned.push(
      ...(factionSetupFor(player.faction, player.factionVariant)?.abilities ?? []),
    );
  }
  owned.push(...player.technologies);
  for (const type of UNIT_TYPES) {
    const unit = unitOf(state, id, type);
    if (unit?.ability) owned.push(unit.id);
  }
  owned.push(
    ...state.laws.filter((law) => law.owner === id).map((law) => law.id),
  );
  // Thunder's Edge: the breakthrough, once gained, and expeditions.
  if (player.breakthrough?.unlocked) owned.push(player.breakthrough.id);
  if (state.expedition?.includes(null)) owned.push("expedition");
  return owned;
}

export const ownsAbility = (state: GameState, id: PlayerId, ability: string) =>
  ownedAbilities(state, id).includes(ability);

/** Whether an ability is one printed on the player's faction sheet. */
export const isFactionAbility = (state: GameState, id: PlayerId, ability: string) => {
  const player = state.players[id];
  return !!factionSetupFor(player.faction, player.factionVariant)?.abilities.includes(ability);
};

/** Legendary planets a player controls with their ability ready, by name. */
const legendaryPlanets = (state: GameState, id: PlayerId) =>
  Object.values(state.planets)
    .filter(
      (p) => p.controller === id && !p.legendaryExhausted && isLegendary(state, p.name),
    )
    .map((p) => p.name);

/** Exploration cards a player holds that can be used: fragments and play-area cards. */
const heldExplorations = (state: GameState, id: PlayerId) => {
  const player = state.players[id];
  return [...player.relicFragments, ...(player.explorationCards ?? [])];
};

function holds(state: GameState, id: PlayerId, reaction: Reaction) {
  const player = state.players[id];
  switch (reaction.kind) {
    case "actionCard":
      return (
        player.actionCards.includes(reaction.id) &&
        canPlayActionCards(state, id)
      );
    case "ability":
      return ownsAbility(state, id, reaction.id);
    case "promissoryNote":
      return (
        reaction.owner !== id &&
        player.promissoryNotes.some(
          (note) => note.id === reaction.id && note.owner === reaction.owner,
        )
      );
    case "leader":
      return usableLeaders(state, id).includes(reaction.id);
    case "relic":
      return player.relics.includes(reaction.id);
    case "exploration":
      return heldExplorations(state, id).includes(reaction.id);
    case "planet":
      return legendaryPlanets(state, id).includes(reaction.id);
  }
}

/** Everything a player holds that could be used in some way. */
function everythingHeld(state: GameState, id: PlayerId): Reaction[] {
  const player = state.players[id];
  const cards = canPlayActionCards(state, id)
    ? player.actionCards.map((card): Reaction => ({ kind: "actionCard", id: card }))
    : [];
  return [
    ...cards,
    ...ownedAbilities(state, id).map((ability): Reaction => ({
      kind: "ability",
      id: ability,
    })),
    ...player.promissoryNotes
      .filter((note) => note.owner !== id)
      .map((note): Reaction => ({
        kind: "promissoryNote",
        id: note.id,
        owner: note.owner,
      })),
    ...usableLeaders(state, id).map((leader): Reaction => ({ kind: "leader", id: leader })),
    ...player.relics.map((relic): Reaction => ({ kind: "relic", id: relic })),
    ...heldExplorations(state, id).map((card): Reaction => ({ kind: "exploration", id: card })),
    ...legendaryPlanets(state, id).map((planet): Reaction => ({ kind: "planet", id: planet })),
  ];
}

/** The context an effect sees: a note also learns whose note it is. */
const contextFor = (reaction: Reaction, context: WindowContext): WindowContext =>
  reaction.kind === "promissoryNote" ? { ...context, noteOwner: reaction.owner } : context;

function isUsable(
  state: GameState,
  id: PlayerId,
  effect: Effect,
  context: WindowContext,
) {
  try {
    return effect.usable ? effect.usable(state, id, context) : true;
  } catch {
    return false;
  }
}

/** Identifies a reaction; copies of an action card or exploration card share one key. */
const reactionKey = (reaction: Reaction) =>
  reaction.kind === "actionCard"
    ? `card:${actionCardsById[reaction.id]?.name}`
    : reaction.kind === "exploration"
      ? `exploration:${explorationsById[reaction.id]?.name}`
      : JSON.stringify(reaction);

/** What a player could use in a window, one entry per distinct card name. */
export function reactionsFor(
  state: GameState,
  id: PlayerId,
  window: WindowId,
  context: WindowContext,
): Reaction[] {
  if (state.players[id].eliminated) return [];
  const seen = new Set<string>();
  return everythingHeld(state, id).filter((reaction) => {
    const effect = effectFor(reaction);
    if (!effect?.windows?.includes(window)) return false;
    // Copies of the same card are one option.
    const key = reactionKey(reaction);
    if (seen.has(key)) return false;
    if (!isUsable(state, id, effect, contextFor(reaction, context))) return false;
    seen.add(key);
    return true;
  });
}

/** Component actions a player could take now, other than tactical or strategic. */
export function componentActions(state: GameState, id: PlayerId): Reaction[] {
  const seen = new Set<string>();
  return everythingHeld(state, id).filter((reaction) => {
    const effect = effectFor(reaction);
    if (!effect?.action) return false;
    const key = reactionKey(reaction);
    if (seen.has(key)) return false;
    if (!isUsable(state, id, effect, contextFor(reaction, {}))) return false;
    seen.add(key);
    return true;
  });
}

/** Turns a reaction and its choices into the action that plays it. */
export function reactionAction(
  reaction: Reaction,
  targets: EffectTargets = {},
  promptId?: number,
): GameAction {
  switch (reaction.kind) {
    case "actionCard":
      return { type: "PLAY_ACTION_CARD", card: reaction.id, targets, promptId };
    case "ability":
      return { type: "USE_ABILITY", ability: reaction.id, targets, promptId };
    case "promissoryNote":
      return {
        type: "PLAY_PROMISSORY_NOTE",
        note: reaction.id,
        owner: reaction.owner,
        targets,
        promptId,
      };
    default:
      return { type: "USE_ABILITY", ability: reaction.id, targets, promptId, source: reaction.kind };
  }
}

// --- Windows ------------------------------------------------------------------

function tableOrder(state: GameState): PlayerId[] {
  const first = state.activePlayer ?? state.tactical?.player ?? state.speaker;
  return clockwiseFrom(state, first);
}

/**
 * Offers a window to the players who have something to use in it (all
 * players in table order by default). Returns true if anyone was asked.
 * `group` puts the prompts in an existing group, as for the players deciding
 * whether to cancel a card.
 */
export function openWindow(
  state: GameState,
  window: WindowId,
  context: WindowContext = {},
  players: PlayerId[] = tableOrder(state),
  group?: number,
): boolean {
  const prompts: NewPrompt[] = [];
  for (const player of players) {
    const options = reactionsFor(state, player, window, context);
    if (options.length === 0) continue;
    prompts.push({ kind: "window", player, window, context, options });
  }
  if (prompts.length === 0) return false;
  const id = group ?? state.nextId++;
  state.prompts.unshift(
    ...prompts.map(
      (prompt) => ({ ...prompt, id: state.nextId++, group: id }) as Prompt,
    ),
  );
  return true;
}

/** Keeps open windows in step with what their players can still use. */
export function pruneWindows(state: GameState) {
  state.prompts = state.prompts.flatMap((prompt): Prompt[] => {
    if (prompt.kind !== "window") return [prompt];
    const options = reactionsFor(state, prompt.player, prompt.window, prompt.context).filter(
      (reaction) => !prompt.used?.includes(reactionKey(reaction)),
    );
    return options.length > 0 ? [{ ...prompt, options }] : [];
  });
}

/** Closes windows that no longer make sense, such as when a combat ends. */
export function closeWindows(state: GameState, windows: WindowId[]) {
  state.prompts = state.prompts.filter(
    (prompt) => prompt.kind !== "window" || !windows.includes(prompt.window),
  );
}

export function passWindow(state: GameState, id: PlayerId, promptId: number) {
  const prompt = openPrompts(state).find(
    (p) => p.id === promptId && p.player === id && p.kind === "window",
  );
  ensure(prompt, "There is nothing waiting on you for that.");
  state.prompts = state.prompts.filter((p) => p.id !== promptId);
}

// --- Playing ------------------------------------------------------------------

function describeTargets(state: GameState, targets: EffectTargets) {
  const parts = [
    targets.player !== undefined ? playerName(state, targets.player) : "",
    targets.planet ?? "",
    ...(targets.planets ?? []),
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Plays a card or uses an ability, either in answer to a window prompt or as
 * a component action on the player's turn. The effect resolves once anyone
 * able to cancel it has decided not to.
 */
export function playReaction(
  state: GameState,
  id: PlayerId,
  reaction: Reaction,
  targets: EffectTargets = {},
  promptId?: number,
) {
  const player = playerOf(state, id);
  const effect = effectFor(reaction);
  const name = reactionName(reaction);
  if (!effect) fail(`${name} has no effect the engine can resolve.`);
  ensure(holds(state, id, reaction), `You cannot use ${name}.`);

  let context: WindowContext = {};
  if (promptId !== undefined) {
    const prompt = openPrompts(state).find(
      (p) => p.id === promptId && p.player === id && p.kind === "window",
    );
    ensure(prompt?.kind === "window", "There is nothing waiting on you for that.");
    ensure(
      effect.windows?.includes(prompt.window),
      `${name} cannot be used now.`,
    );
    // Abilities and notes are used once in a window; action cards can be
    // played again while copies last.
    const key = reactionKey(reaction);
    ensure(!prompt.used?.includes(key), `${name} has already been used.`);
    if (reaction.kind !== "actionCard") prompt.used = [...(prompt.used ?? []), key];
    context = prompt.context;
  } else {
    ensure(effect.action, `${name} can only be used at a particular moment.`);
    requireAction(state, id);
  }
  context = contextFor(reaction, context);
  ensure(isUsable(state, id, effect, context), `${name} cannot be used now.`);

  if (reaction.kind === "actionCard") {
    player.actionCards.splice(player.actionCards.indexOf(reaction.id), 1);
    state.decks.actionCards.discard.push(reaction.id);
  }
  if (reaction.kind === "promissoryNote") {
    const note = { id: reaction.id, owner: reaction.owner };
    player.promissoryNotes = player.promissoryNotes.filter(
      (held) => !(held.id === note.id && held.owner === note.owner),
    );
    // Notes either stay face up in the play area or go back to their owner.
    if (promissoryNotesById[note.id]?.playArea) {
      player.promissoryNotesInPlay.push(note);
    } else {
      state.players[note.owner].promissoryNotes.push(note);
    }
  }
  if (promptId === undefined) {
    state.actionsThisTurn++;
    breakDuress(state, id);
  }
  if (reaction.kind === "leader" && !effect.keep) spendLeader(state, id, reaction.id);
  if (reaction.kind === "planet") state.planets[reaction.id].legendaryExhausted = true;
  // Brother Omar unlocks when the Yin use a faction ability.
  if (
    reaction.kind === "ability" &&
    player.faction === "yin" &&
    isFactionAbility(state, id, reaction.id)
  ) {
    unlockCommander(state, id);
  }

  effect.play?.(state, id, targets, context);
  const card = reaction.kind === "actionCard" ? actionCardsById[reaction.id] : undefined;
  log(
    state,
    card
      ? `${player.name} played ${card.name}${describeTargets(state, targets)}: ${card.text}`
      : `${player.name} used ${name}${describeTargets(state, targets)}.`,
    { player: id },
  );

  const pending: PendingEffect = {
    id: state.nextId++,
    player: id,
    reaction,
    targets,
    context,
    group: state.nextId++,
  };
  (state.pending ??= []).push(pending);
  if (reaction.kind === "actionCard") {
    // Everyone else may now cancel it (Sabotage, Instinct Training).
    openWindow(
      state,
      "actionCardPlayed",
      { player: id, card: reaction.id, ref: pending.id },
      tableOrder(state).filter((other) => other !== id),
      pending.group,
    );
  }
}

// --- Effects that resolve at once ------------------------------------------------

/**
 * Asks a player for the choices an effect needs before it resolves, such as
 * an exploration card. Effects that need no choices resolve straight away.
 */
export function resolveOrAsk(
  state: GameState,
  id: PlayerId,
  reaction: Reaction,
  context: WindowContext,
  options: { optional?: boolean } = {},
) {
  const effect = effectFor(reaction);
  if (!effect) return;
  if (!effect.targets?.length && !options.optional) {
    effect.resolve(state, id, {}, context);
    return;
  }
  ask(state, [{ kind: "effect", player: id, reaction, context, optional: options.optional }]);
}

/**
 * Choices for an effect prompt that a bot can send, best first: the effect's
 * own suggestion, then the defaults, then turning it down if allowed.
 */
export function effectAnswers(
  state: GameState,
  prompt: Extract<Prompt, { kind: "effect" }>,
): GameAction[] {
  const effect = effectFor(prompt.reaction);
  let suggested: EffectTargets | undefined;
  try {
    suggested = effect?.bot?.(state, prompt.player, prompt.context);
  } catch {
    suggested = undefined;
  }
  const answers: EffectTargets[] = [];
  if (suggested) answers.push(suggested);
  if (!suggested && prompt.optional) answers.push({ decline: true });
  answers.push({});
  if (prompt.optional) answers.push({ decline: true });
  return answers.map((targets) => ({ type: "RESOLVE_EFFECT", promptId: prompt.id, targets }));
}

/** Answers an effect prompt. */
export function answerEffect(
  state: GameState,
  id: PlayerId,
  promptId: number,
  targets: EffectTargets = {},
) {
  const prompt = takePrompt(state, id, "effect", promptId);
  const effect = effectFor(prompt.reaction);
  ensure(effect, "That effect cannot be resolved.");
  if (targets.decline) {
    ensure(prompt.optional, "You must resolve this.");
    return;
  }
  effect.play?.(state, id, targets, prompt.context);
  effect.resolve(state, id, targets, prompt.context);
}

/** Cancels a played card that has not resolved yet. */
export function cancelPending(state: GameState, ref: number | undefined) {
  const pending = state.pending?.find((p) => p.id === ref);
  if (!pending || pending.cancelled) return;
  pending.cancelled = true;
  state.prompts = state.prompts.filter((p) => p.group !== pending.group);
}

/**
 * Resolves the most recently played effect once nobody is still deciding
 * whether to cancel it. Returns true if it did anything.
 */
export function resolvePending(state: GameState): boolean {
  const pending = state.pending?.at(-1);
  if (!pending) return false;
  if (state.prompts.some((p) => p.group === pending.group)) return false;
  state.pending!.pop();
  const name = reactionName(pending.reaction);
  if (pending.cancelled) {
    log(state, `${name} was cancelled.`);
  } else {
    effectFor(pending.reaction)!.resolve(
      state,
      pending.player,
      pending.targets,
      pending.context,
    );
  }
  pruneWindows(state);
  return true;
}
