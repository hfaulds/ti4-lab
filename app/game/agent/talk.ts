/**
 * Table talk: messages between players and the deals they strike. None of
 * it is a rule of the game, so it lives beside the game rather than in the
 * engine: a deal is a promise, and the binding part of any trade is still
 * the engine's transaction. The table watches the moves to see promises
 * kept or broken, and everyone remembers who broke one.
 *
 * Deals have plain-text terms, for the players, and structured parts the
 * table can check: a free commodity refresh through Trade's secondary, a
 * payment of trade goods in a later transaction, and a truce (staying out of
 * each other's slice). The old table convention, that a player refreshed
 * for free owes the Trade holder one, is now the standard deal the Trade
 * holder offers when it lets others replenish.
 */
import { PlayerId } from "~/types";
import { factions } from "~/data/factionData";
import { GameAction } from "../actions";
import { GameState, TransactionSide } from "../types";
import { strategyKind } from "../engine/strategic";
import { totalUnits } from "../engine/helpers";
import { neighborsOf } from "../engine/board";
import { sliceOf } from "./reach";
import type { ProposeDealArgs } from "./tools";

export type Message = {
  round: number;
  move: number;
  from: PlayerId;
  /** One player, for a private message; otherwise the whole table. */
  to?: PlayerId;
  text: string;
};

export type DealTerms = {
  /** This player replenishes commodities for free when the other side plays Trade. */
  refresh?: PlayerId;
  /**
   * Trade goods one side pays the other, as the surplus of a later
   * transaction, from `dueRound` on (by default, at once).
   */
  payment?: { from: PlayerId; to: PlayerId; amount: number; dueRound?: number };
  /** Neither side activates a system in the other's slice or holding their units or planets. */
  truce?: boolean;
};

export type DealStatus = "proposed" | "accepted" | "kept" | "broken" | "dropped";

export type Deal = {
  id: number;
  round: number;
  move: number;
  from: PlayerId;
  to: PlayerId;
  text: string;
  terms: DealTerms;
  /** The last round in which the deal can be kept. */
  until: number;
  status: DealStatus;
  /** The refresh was given. */
  refreshed?: boolean;
  /** Trade goods paid so far. */
  paid: number;
  /** The payer had a turn, or the payee did, as neighbours with something to pay. */
  couldPay?: boolean;
  /** Who broke or dropped the deal, and why. */
  by?: PlayerId;
  reason?: string;
};

export type TalkEvent = {
  round: number;
  move: number;
  text: string;
  /** Only these players may read it (a private message). */
  visibleTo?: PlayerId[];
};

/** What the replay log keeps of the table talk. */
export type TalkLog = { messages: Message[]; deals: Deal[]; events: TalkEvent[] };

/** A side's worth in trade goods: commodities become trade goods on arrival. */
export const worth = (side: TransactionSide) =>
  (side.tradeGoods ?? 0) + (side.commodities ?? 0);

/**
 * What a bot reckons keeping its word is worth, in trade goods: the deals
 * that player will offer it later. It keeps a promise that costs less.
 */
export const WORD_WORTH = 2;
/** Gain from one activation that tempts a bot to break a truce. */
export const TRUCE_WORTH = 6;
/** Talk tool calls allowed per decision. */
const MAX_TALK = 6;
/** Messages shown in a turn block. */
const RECENT_MESSAGES = 8;

const label = (state: GameState, id: PlayerId) =>
  `P${id} (${factions[state.players[id]?.faction]?.name ?? state.players[id]?.faction})`;
const goods = (n: number) => `${n} trade good${n === 1 ? "" : "s"}`;
const open = (deal: Deal) => deal.status === "proposed" || deal.status === "accepted";
const partner = (deal: Deal, id: PlayerId) => (deal.from === id ? deal.to : deal.from);
const holdsTrade = (state: GameState, id: PlayerId) =>
  state.players[id].strategyCards.some((c) => !c.exhausted && strategyKind(c.id) === "trade");

export class TableTalk {
  readonly messages: Message[] = [];
  readonly deals: Deal[] = [];
  readonly events: TalkEvent[] = [];
  /** The move the game is on, for stamping what is said. */
  move = 0;
  private drained = 0;
  private round?: number;

  /** Agent seats decide for themselves; the rest answer by the bots' rules. */
  constructor(readonly agentSeats: PlayerId[] = []) {}

  private bot = (id: PlayerId) => !this.agentSeats.includes(id);

  private say(state: GameState, text: string, visibleTo?: PlayerId[]) {
    this.events.push({ round: state.round, move: this.move, text, ...(visibleTo ? { visibleTo } : {}) });
  }

  /** What was said since the last call, as lines for the move's note. */
  drain(): string[] {
    const fresh = this.events.slice(this.drained).map((e) => e.text);
    this.drained = this.events.length;
    return fresh;
  }

  log(): TalkLog {
    return { messages: this.messages, deals: this.deals, events: this.events };
  }

  // --- Messages and deals -------------------------------------------------------

  post(state: GameState, from: PlayerId, text: string, to?: PlayerId) {
    this.messages.push({ round: state.round, move: this.move, from, ...(to !== undefined ? { to } : {}), text });
    this.say(
      state,
      to === undefined
        ? `${label(state, from)} to everyone: "${text}"`
        : `${label(state, from)} to ${label(state, to)}, privately: "${text}"`,
      to === undefined ? undefined : [from, to],
    );
  }

  /** Proposes a deal; a bot on the other side answers at once. */
  propose(
    state: GameState,
    from: PlayerId,
    to: PlayerId,
    text: string,
    terms: DealTerms,
    until = Math.max(state.round + 1, terms.payment?.dueRound ?? 0),
  ) {
    const deal: Deal = {
      id: this.deals.length + 1,
      round: state.round,
      move: this.move,
      from,
      to,
      text,
      terms,
      until,
      status: "proposed",
      paid: 0,
    };
    this.deals.push(deal);
    this.say(state, `Deal #${deal.id} proposed by ${label(state, from)} to ${label(state, to)}: ${text} (until the end of round ${until}).`);
    return deal;
  }

  accept(state: GameState, id: number, player: PlayerId): string | undefined {
    const deal = this.deals.find((d) => d.id === id);
    if (!deal) return `There is no deal #${id}.`;
    if (deal.to !== player) return `Deal #${id} was not proposed to you.`;
    if (deal.status !== "proposed") return `Deal #${id} is already ${deal.status}.`;
    deal.status = "accepted";
    this.say(state, `Deal #${id} accepted by ${label(state, player)}.`);
    this.checkDone(state, deal);
    return undefined;
  }

  /**
   * Declines or withdraws a proposal; backing out of an accepted deal
   * breaks it.
   */
  drop(state: GameState, id: number, player: PlayerId, reason?: string): string | undefined {
    const deal = this.deals.find((d) => d.id === id);
    if (!deal) return `There is no deal #${id}.`;
    if (deal.from !== player && deal.to !== player) return `Deal #${id} is not yours.`;
    if (!open(deal)) return `Deal #${id} is already ${deal.status}.`;
    if (deal.status === "accepted") {
      this.close(state, deal, "broken", player, reason ?? "backed out");
    } else {
      this.close(state, deal, "dropped", player, reason);
    }
    return undefined;
  }

  private close(state: GameState, deal: Deal, status: "kept" | "broken" | "dropped", by?: PlayerId, reason?: string) {
    deal.status = status;
    if (by !== undefined) deal.by = by;
    if (reason) deal.reason = reason;
    const who = by !== undefined ? ` by ${label(state, by)}` : "";
    this.say(state, `Deal #${deal.id} ${status}${who}${reason ? `: ${reason}` : ""}.`);
  }

  /** An accepted deal with nothing left to do and no truce to hold is kept. */
  private checkDone(state: GameState, deal: Deal) {
    const { refresh, payment, truce } = deal.terms;
    if (deal.status !== "accepted" || truce) return;
    if (refresh !== undefined && !deal.refreshed) return;
    if (payment && deal.paid < payment.amount) return;
    if (refresh === undefined && !payment) return;
    this.close(state, deal, "kept");
  }

  // --- Watching the moves ---------------------------------------------------------

  /** Notes what a move means for the deals. Call it before applying the move. */
  observe(state: GameState, player: PlayerId, action: GameAction) {
    if (action.type === "STRATEGIC_ACTION" && action.payload.card === "trade") {
      const allowed = action.payload.allow ?? [];
      for (const deal of this.deals) {
        const { refresh } = deal.terms;
        if (deal.status !== "accepted" || refresh === undefined || deal.refreshed) continue;
        if (partner(deal, refresh) !== player || allowed.includes(refresh)) continue;
        this.close(state, deal, "broken", player, `played Trade without letting P${refresh} replenish for free`);
      }
      // The standard deal: a free refresh for a trade good, unless another was struck.
      for (const other of allowed) {
        const covered = this.deals.some(
          (d) => open(d) && d.terms.refresh === other && partner(d, other) === player && !d.refreshed,
        );
        if (covered) continue;
        this.propose(
          state,
          player,
          other,
          `${label(state, player)} lets ${label(state, other)} replenish commodities without spending a strategy token, ` +
            "for 1 trade good later",
          { refresh: other, payment: { from: other, to: player, amount: 1 } },
        );
      }
    }

    if (action.type === "RESOLVE_SECONDARY") {
      const prompt = state.prompts.find((p) => p.id === action.promptId);
      if (prompt?.kind === "secondary" && prompt.free && strategyKind(prompt.card) === "trade") {
        const deal = this.deals.find(
          (d) => open(d) && d.terms.refresh === player && partner(d, player) === prompt.from && !d.refreshed,
        );
        const { commodities, commodityLimit } = state.players[player];
        if (deal && action.payload && commodities >= commodityLimit) {
          // A refresh that replenishes nothing is not worth paying for.
          this.close(state, deal, "dropped", undefined, `P${player} had nothing to replenish`);
        } else if (deal && action.payload) {
          // Taking the free refresh accepts the deal that came with it.
          if (deal.status === "proposed" && deal.to === player) this.accept(state, deal.id, player);
          if (deal.status === "proposed") deal.status = "accepted";
          deal.refreshed = true;
          this.say(state, `${label(state, player)} replenished commodities for free under deal #${deal.id}.`);
          this.checkDone(state, deal);
        } else if (deal) {
          this.close(state, deal, "dropped", player, "turned down the free refresh");
        }
      }
    }

    if (action.type === "ANSWER_TRANSACTION" && action.accept) {
      const offer = state.transactions.find((t) => t.id === action.transaction);
      if (!offer) return;
      const surplus = worth(offer.give) - worth(offer.receive);
      if (surplus === 0) return;
      // Whoever gives more than they get pays towards what they owe the other.
      const [payer, payee] = surplus > 0 ? [offer.from, offer.to] : [offer.to, offer.from];
      let left = Math.abs(surplus);
      for (const deal of this.deals) {
        const payment = deal.terms.payment;
        if (left === 0) break;
        if (!payment || payment.from !== payer || payment.to !== payee || !this.due(state, deal)) continue;
        const part = Math.min(left, payment.amount - deal.paid);
        if (part <= 0) continue;
        deal.paid += part;
        left -= part;
        this.say(
          state,
          `${label(state, payer)} paid ${goods(part)} towards deal #${deal.id} (${deal.paid} of ${payment.amount}).`,
        );
        this.checkDone(state, deal);
      }
    }

    if (action.type === "ACTIVATE_SYSTEM") {
      const deal = this.truceAt(state, player, action.system);
      if (deal) this.close(state, deal, "broken", player, `activated ${action.system}, which the truce kept them out of`);
    }
  }

  /**
   * Closes deals whose time is up. Call it after applying each move. A
   * payer who never had the chance to pay (they were never neighbours on
   * either one's turn) has not broken the deal; it lapses.
   */
  settle(state: GameState) {
    const active = state.activePlayer;
    if (state.phase === "action" && active !== undefined) {
      for (const deal of this.deals) {
        const payment = deal.terms.payment;
        if (!payment || deal.couldPay || !this.due(state, deal) || deal.paid >= payment.amount) continue;
        if (active !== payment.from && active !== payment.to) continue;
        const payer = state.players[payment.from];
        if (payer.commodities + payer.tradeGoods === 0) continue;
        if (neighborsOf(state, payment.from).includes(payment.to)) deal.couldPay = true;
      }
    }
    if (this.round === undefined) this.round = state.round;
    if (state.round === this.round) return;
    this.round = state.round;
    for (const deal of this.deals) {
      if (!open(deal) || deal.until >= state.round) continue;
      if (deal.status === "proposed") {
        this.close(state, deal, "dropped", undefined, "never answered");
        continue;
      }
      const { refresh, payment } = deal.terms;
      if (refresh !== undefined && !deal.refreshed) {
        this.close(state, deal, "broken", partner(deal, refresh), `P${refresh} was never let replenish for free`);
      } else if (payment && deal.paid < payment.amount && !deal.couldPay) {
        this.close(state, deal, "dropped", undefined, "the two were never neighbours with something to pay");
      } else if (payment && deal.paid < payment.amount) {
        this.close(state, deal, "broken", payment.from, `${goods(payment.amount - deal.paid)} never paid`);
      } else {
        this.close(state, deal, "kept");
      }
    }
  }

  // --- What players know ------------------------------------------------------------

  /** Deals kept and broken by a player (a kept deal counts for both sides). */
  record(player: PlayerId) {
    const mine = this.deals.filter((d) => d.from === player || d.to === player);
    return {
      kept: mine.filter((d) => d.status === "kept").length,
      broken: mine.filter((d) => d.status === "broken" && d.by === player).length,
    };
  }

  /** A player who has broken no deal. */
  trusted(player: PlayerId) {
    return this.record(player).broken === 0;
  }

  /** A payment that can be collected now: agreed, any refresh given, and its round come. */
  private due(state: GameState, deal: Deal) {
    return (
      deal.status === "accepted" &&
      (deal.terms.refresh === undefined || !!deal.refreshed) &&
      (deal.terms.payment?.dueRound ?? 0) <= state.round
    );
  }

  /** Trade goods `debtor` owes `creditor` now. */
  owed(state: GameState, debtor: PlayerId, creditor: PlayerId) {
    return this.deals.reduce((sum, d) => {
      const p = d.terms.payment;
      return p && p.from === debtor && p.to === creditor && this.due(state, d) ? sum + p.amount - d.paid : sum;
    }, 0);
  }

  /**
   * What `debtor` will pay `creditor` now. An agent's menu offers the whole
   * debt; a bot pays while keeping its word costs less than it is worth,
   * and never pays a player who has broken a deal.
   */
  willPay(state: GameState, debtor: PlayerId, creditor: PlayerId) {
    const owed = this.owed(state, debtor, creditor);
    if (!this.bot(debtor)) return owed;
    return owed <= WORD_WORTH && this.trusted(creditor) ? owed : 0;
  }

  /** Players the Trade holder has promised a free refresh. */
  promisedRefreshes(holder: PlayerId): PlayerId[] {
    return this.deals.flatMap((d) =>
      d.status === "accepted" && d.terms.refresh !== undefined && partner(d, d.terms.refresh) === holder && !d.refreshed
        ? [d.terms.refresh]
        : [],
    );
  }

  /** The truce `player` would break by activating `system`, if any. */
  truceAt(state: GameState, player: PlayerId, system: number): Deal | undefined {
    return this.deals.find((d) => {
      if (d.status !== "accepted" || !d.terms.truce || (d.from !== player && d.to !== player)) return false;
      const other = partner(d, player);
      const s = state.systems[system];
      if (!s) return false;
      const slice = sliceOf(state, other);
      return (
        system === state.players[other].home ||
        slice.own.includes(system) ||
        totalUnits(s.space[other]) > 0 ||
        s.planets.some((p) => state.planets[p].controller === other || totalUnits(state.planets[p].units[other]) > 0)
      );
    });
  }

  /**
   * Whether a bot holds back from activating `system` for a truce: it does
   * unless the activation gains more than the truce is worth, or the other
   * side has broken a deal. Agents decide for themselves.
   */
  holdsBack(state: GameState, player: PlayerId, system: number, gain: number) {
    if (!this.bot(player)) return false;
    const deal = this.truceAt(state, player, system);
    return !!deal && gain <= TRUCE_WORTH && this.trusted(partner(deal, player));
  }

  // --- Bots ---------------------------------------------------------------------------

  /**
   * A bot's answer to a deal proposed to it: it accepts deals that pay (a
   * refresh is worth the commodities it replenishes) and that it means to
   * keep, from players who have broken none.
   */
  botAnswer(state: GameState, deal: Deal): { accept: boolean; reason: string } {
    const me = deal.to;
    const { refresh, payment, truce } = deal.terms;
    if (!this.trusted(deal.from)) return { accept: false, reason: `P${deal.from} has broken a deal` };
    if (refresh === undefined && !payment && !truce) {
      return { accept: false, reason: "the bots only take deals with terms they can check" };
    }
    if (refresh !== undefined && refresh !== me && !holdsTrade(state, me)) {
      return { accept: false, reason: "it does not hold an unplayed Trade card" };
    }
    const player = state.players[me];
    const gain = refresh === me ? player.commodityLimit - player.commodities : 0;
    let value = gain;
    if (payment?.to === me) value += payment.amount;
    if (payment?.from === me) {
      if (payment.amount > WORD_WORTH) return { accept: false, reason: "it would not keep a promise that costly" };
      value -= payment.amount;
    }
    // Breaking even is worth it for a truce or a refresh that gains something.
    if (value > 0 || (value === 0 && (truce || gain > 0))) return { accept: true, reason: "" };
    return { accept: false, reason: "it does not pay" };
  }

  // --- The agent's side -------------------------------------------------------------

  /** The turn block's table talk section for `seat`. */
  describeFor(state: GameState, seat: PlayerId) {
    const lines = ["", "## Table talk"];
    const heard = this.messages.filter((m) => m.to === undefined || m.to === seat || m.from === seat);
    lines.push(
      heard.length ? "Recent messages:" : "No messages yet.",
      ...heard.slice(-RECENT_MESSAGES).map(
        (m) =>
          `- Round ${m.round}, ${label(state, m.from)}${m.to !== undefined ? ` to ${m.to === seat ? "you" : label(state, m.to)}, privately` : " to everyone"}: "${m.text}"`,
      ),
    );
    const mine = this.deals.filter((d) => open(d) && (d.from === seat || d.to === seat));
    const offered = mine.filter((d) => d.status === "proposed" && d.to === seat);
    const rest = mine.filter((d) => !offered.includes(d));
    if (offered.length) {
      lines.push("Deals proposed to you (accept_deal or drop_deal; taking a free Trade refresh accepts the deal that came with it):");
      lines.push(...offered.map((d) => `- ${this.dealLine(state, d, seat)}`));
    }
    lines.push(rest.length ? "Your open deals:" : "You have no open deals.");
    lines.push(...rest.map((d) => `- ${this.dealLine(state, d, seat)}`));
    const records = state.seating
      .map((id) => ({ id, ...this.record(id) }))
      .filter((r) => r.kept + r.broken > 0)
      .map((r) => `${label(state, r.id)} kept ${r.kept}, broke ${r.broken}`);
    lines.push(`Records: ${records.join("; ") || "no deals kept or broken yet"}.`);
    return lines.join("\n");
  }

  private dealLine(state: GameState, deal: Deal, seat: PlayerId) {
    const other = partner(deal, seat);
    const { refresh, payment, truce } = deal.terms;
    const parts: string[] = [];
    if (refresh !== undefined) {
      parts.push(
        `${refresh === seat ? "you replenish" : `${label(state, refresh)} replenishes`} for free when ${refresh === seat ? label(state, other) : "you"} play Trade${deal.refreshed ? " (done)" : ""}`,
      );
    }
    if (payment) {
      const who = payment.from === seat ? `you pay ${label(state, other)}` : `${label(state, other)} pays you`;
      const when = [
        payment.dueRound !== undefined && payment.dueRound > state.round ? `due from round ${payment.dueRound}` : "",
        refresh !== undefined && !deal.refreshed ? "due once refreshed" : "",
      ].filter(Boolean);
      parts.push(`${who} ${goods(payment.amount)} in a trade (${[`${deal.paid} paid`, ...when].join(", ")})`);
    }
    if (truce) parts.push("neither of you activates a system in the other's slice or holding the other's units or planets");
    return (
      `#${deal.id} with ${label(state, other)}, ${deal.status}, until the end of round ${deal.until}: "${deal.text}"` +
      (parts.length ? `. Checked: ${parts.join("; ")}.` : ". Nothing the table can check.")
    );
  }

  /**
   * The talk tools for one decision by `seat`: post_message, propose_deal,
   * accept_deal and drop_deal, run on already parsed arguments.
   */
  toolsFor(state: GameState, seat: PlayerId) {
    let calls = 0;
    const known = (id: PlayerId) => state.players[id] !== undefined && id !== seat;
    return {
      post: (args: { text: string; to?: PlayerId }) => {
        if (++calls > MAX_TALK) return "Enough talk for this decision.";
        if (args.to !== undefined && !known(args.to)) return `There is no other player P${args.to}.`;
        this.post(state, seat, args.text, args.to);
        return args.to === undefined ? "Message posted to the table." : `Message sent to P${args.to}.`;
      },
      propose: (args: ProposeDealArgs) => {
        if (++calls > MAX_TALK) return "Enough talk for this decision.";
        if (!known(args.to)) return `There is no other player P${args.to}.`;
        if (args.until_round !== undefined && args.until_round < Math.max(state.round, args.due_round ?? 0)) {
          return "until_round cannot be in the past, or before due_round.";
        }
        const role = (r: "me" | "them") => (r === "me" ? seat : args.to);
        const terms: DealTerms = {
          ...(args.refresh ? { refresh: role(args.refresh) } : {}),
          ...(args.payer && args.trade_goods
            ? {
                payment: {
                  from: role(args.payer),
                  to: role(args.payer === "me" ? "them" : "me"),
                  amount: args.trade_goods,
                  ...(args.due_round !== undefined ? { dueRound: args.due_round } : {}),
                },
              }
            : {}),
          ...(args.truce ? { truce: true } : {}),
        };
        const deal = this.propose(state, seat, args.to, args.text, terms, args.until_round);
        if (!this.bot(args.to)) return `Deal #${deal.id} proposed to P${args.to}, who will answer when they next decide.`;
        const answer = this.botAnswer(state, deal);
        if (answer.accept) {
          this.accept(state, deal.id, args.to);
          return `Deal #${deal.id} proposed; P${args.to} accepted it.`;
        }
        this.close(state, deal, "dropped", args.to, `declined, as ${answer.reason}`);
        return `Deal #${deal.id} proposed; P${args.to} declined it: ${answer.reason}.`;
      },
      accept: (id: number) => {
        if (++calls > MAX_TALK) return "Enough talk for this decision.";
        return this.accept(state, id, seat) ?? `Deal #${id} accepted.`;
      },
      drop: (id: number, reason?: string) => {
        if (++calls > MAX_TALK) return "Enough talk for this decision.";
        const wasAccepted = this.deals.find((d) => d.id === id)?.status === "accepted";
        return (
          this.drop(state, id, seat, reason) ??
          (wasAccepted
            ? `Deal #${id} dropped; you had agreed to it, so the table counts it as broken by you.`
            : `Deal #${id} dropped.`)
        );
      },
    };
  }
}

export type TalkTools = ReturnType<TableTalk["toolsFor"]>;
