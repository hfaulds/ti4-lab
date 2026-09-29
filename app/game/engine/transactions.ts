import { PlayerId } from "~/types";
import { promissoryNotesById } from "../data";
import { GameState, PromissoryNote, TransactionSide } from "../types";
import { areNeighbors } from "./board";
import { ensure, log, playerName, playerOf, plural } from "./helpers";

const sameNote = (a: PromissoryNote, b: PromissoryNote) =>
  a.id === b.id && a.owner === b.owner;

function requireSide(state: GameState, id: PlayerId, side: TransactionSide) {
  const player = playerOf(state, id);
  const tradeGoods = side.tradeGoods ?? 0;
  const commodities = side.commodities ?? 0;
  ensure(
    Number.isInteger(tradeGoods) && tradeGoods >= 0,
    "Trade goods must be a whole number.",
  );
  ensure(
    Number.isInteger(commodities) && commodities >= 0,
    "Commodities must be a whole number.",
  );
  ensure(
    tradeGoods <= player.tradeGoods,
    `${player.name} does not have ${plural(tradeGoods, "trade good")}.`,
  );
  ensure(
    commodities <= player.commodities,
    `${player.name} does not have ${plural(commodities, "commodity")}.`,
  );
  const notes = side.promissoryNotes ?? [];
  ensure(notes.length <= 1, "Only 1 promissory note can change hands per transaction.");
  for (const note of notes) {
    ensure(
      player.promissoryNotes.some((held) => sameNote(held, note)),
      `${player.name} does not hold that promissory note.`,
    );
  }
  for (const fragment of side.relicFragments ?? []) {
    ensure(
      player.relicFragments.includes(fragment),
      `${player.name} does not hold that relic fragment.`,
    );
  }
  const cards = side.actionCards ?? [];
  for (const card of cards) {
    ensure(
      player.actionCards.includes(card),
      `${player.name} does not hold that action card.`,
    );
  }
}

function transfer(
  state: GameState,
  from: PlayerId,
  to: PlayerId,
  side: TransactionSide,
) {
  const giver = playerOf(state, from);
  const receiver = playerOf(state, to);
  const tradeGoods = side.tradeGoods ?? 0;
  const commodities = side.commodities ?? 0;
  giver.tradeGoods -= tradeGoods;
  giver.commodities -= commodities;
  // Commodities become trade goods when they change hands.
  receiver.tradeGoods += tradeGoods + commodities;

  for (const note of side.promissoryNotes ?? []) {
    giver.promissoryNotes = giver.promissoryNotes.filter(
      (held) => !sameNote(held, note),
    );
    receiver.promissoryNotes.push(note);
  }
  for (const fragment of side.relicFragments ?? []) {
    giver.relicFragments.splice(giver.relicFragments.indexOf(fragment), 1);
    receiver.relicFragments.push(fragment);
  }
  for (const card of side.actionCards ?? []) {
    giver.actionCards.splice(giver.actionCards.indexOf(card), 1);
    receiver.actionCards.push(card);
  }
}

const describe = (side: TransactionSide) => {
  const parts = [
    side.tradeGoods ? plural(side.tradeGoods, "trade good") : "",
    side.commodities ? plural(side.commodities, "commodity") : "",
    ...(side.promissoryNotes ?? []).map(
      (note) => promissoryNotesById[note.id]?.name ?? "a promissory note",
    ),
    side.relicFragments?.length
      ? plural(side.relicFragments.length, "relic fragment")
      : "",
    side.actionCards?.length
      ? plural(side.actionCards.length, "action card")
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "nothing";
};

export function proposeTransaction(
  state: GameState,
  from: PlayerId,
  to: PlayerId,
  give: TransactionSide,
  receive: TransactionSide,
) {
  ensure(from !== to, "You cannot trade with yourself.");
  playerOf(state, to);
  ensure(
    state.phase === "action" || state.phase === "agenda",
    "Transactions happen during the action and agenda phases.",
  );
  if (state.phase === "action") {
    // The active player trades once with each neighbor on their turn.
    ensure(
      state.activePlayer === from || state.activePlayer === to,
      "Transactions involve the active player.",
    );
    const other = state.activePlayer === from ? to : from;
    ensure(
      areNeighbors(state, from, to),
      `${playerName(state, from)} and ${playerName(state, to)} are not neighbors.`,
    );
    ensure(
      !state.tradedWith.includes(other),
      `The active player has already traded with ${playerName(state, other)} this turn.`,
    );
  }
  const hacanInvolved = [from, to].some(
    (id) => state.players[id].faction === "hacan",
  );
  ensure(
    hacanInvolved ||
      ((give.actionCards ?? []).length === 0 &&
        (receive.actionCards ?? []).length === 0),
    "Only the Emirates of Hacan can trade action cards.",
  );
  requireSide(state, from, give);
  requireSide(state, to, receive);

  state.transactions = state.transactions.filter(
    (t) => !(t.from === from && t.to === to),
  );
  state.transactions.push({ id: state.nextId++, from, to, give, receive });
}

export function answerTransaction(
  state: GameState,
  id: PlayerId,
  transactionId: number,
  accept: boolean,
) {
  const transaction = state.transactions.find((t) => t.id === transactionId);
  ensure(transaction, "That offer is no longer open.");
  ensure(
    transaction.to === id || (!accept && transaction.from === id),
    "That offer was not made to you.",
  );
  state.transactions = state.transactions.filter((t) => t.id !== transactionId);
  if (!accept) return;

  const { from, to, give, receive } = transaction;
  if (state.phase === "action") {
    const other = state.activePlayer === from ? to : from;
    ensure(
      !state.tradedWith.includes(other),
      "The active player has already traded with them this turn.",
    );
    state.tradedWith.push(other);
  }
  requireSide(state, from, give);
  requireSide(state, to, receive);
  transfer(state, from, to, give);
  transfer(state, to, from, receive);
  log(
    state,
    `${playerName(state, from)} gave ${describe(give)} to ${playerName(state, to)} for ${describe(receive)}.`,
  );
}

export function playPromissoryNote(
  state: GameState,
  id: PlayerId,
  note: PromissoryNote,
) {
  const player = playerOf(state, id);
  ensure(note.owner !== id, "You cannot play your own promissory notes.");
  ensure(
    player.promissoryNotes.some((held) => sameNote(held, note)),
    "You do not hold that promissory note.",
  );
  const data = promissoryNotesById[note.id];
  player.promissoryNotes = player.promissoryNotes.filter(
    (held) => !sameNote(held, note),
  );
  if (data?.playArea) {
    player.promissoryNotesInPlay.push(note);
  } else {
    state.players[note.owner].promissoryNotes.push(note);
  }
  log(
    state,
    `${player.name} played ${data?.name ?? "a promissory note"} (${playerName(state, note.owner)}): ${data?.text ?? ""}`,
    { player: id },
  );
}

export function returnPromissoryNote(
  state: GameState,
  id: PlayerId,
  note: PromissoryNote,
) {
  const player = playerOf(state, id);
  ensure(
    player.promissoryNotesInPlay.some((held) => sameNote(held, note)),
    "That promissory note is not in your play area.",
  );
  player.promissoryNotesInPlay = player.promissoryNotesInPlay.filter(
    (held) => !sameNote(held, note),
  );
  state.players[note.owner].promissoryNotes.push(note);
  log(
    state,
    `${player.name} returned ${promissoryNotesById[note.id]?.name ?? "a promissory note"} to ${playerName(state, note.owner)}.`,
    { player: id },
  );
}
