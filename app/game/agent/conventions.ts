/**
 * Table conventions the bots follow that are not rules of the game. A
 * player the Trade holder lets replenish commodities without spending a
 * token owes them one: that round, they accept one trade from the holder
 * that is one commodity or trade good short (an "X-1" trade). The engine
 * knows nothing of this; the bots remember who refreshed them from the
 * moves they see.
 */
import { PlayerId } from "~/types";
import { GameAction } from "../actions";
import { GameState, TransactionSide } from "../types";

type Refresh = { player: PlayerId; by: PlayerId; round: number; repaid?: boolean };

export type TableMemory = { refreshes: Refresh[] };

export const newTableMemory = (): TableMemory => ({ refreshes: [] });

export const worth = (side: TransactionSide) =>
  (side.tradeGoods ?? 0) + (side.commodities ?? 0);

/** The refresh `debtor` has not yet repaid `creditor` this round, if any. */
export const owedRefresh = (
  memory: TableMemory | undefined,
  state: GameState,
  debtor: PlayerId,
  creditor: PlayerId,
) =>
  memory?.refreshes.find(
    (r) => r.player === debtor && r.by === creditor && r.round === state.round && !r.repaid,
  );

/** Notes what a move means for the conventions. Call it before applying the move. */
export function remember(
  memory: TableMemory,
  state: GameState,
  player: PlayerId,
  action: GameAction,
) {
  if (action.type === "RESOLVE_SECONDARY" && action.payload?.card === "trade") {
    const prompt = state.prompts.find((p) => p.id === action.promptId);
    if (prompt?.kind === "secondary" && prompt.free) {
      memory.refreshes.push({ player, by: prompt.from, round: state.round });
    }
  }
  if (action.type === "ANSWER_TRANSACTION" && action.accept) {
    const offer = state.transactions.find((t) => t.id === action.transaction);
    if (!offer) return;
    // Whoever gives more than they get back repays what they owe the other.
    const [debtor, creditor] =
      worth(offer.receive) > worth(offer.give) ? [offer.to, offer.from] : [offer.from, offer.to];
    if (worth(offer.receive) === worth(offer.give)) return;
    const debt = owedRefresh(memory, state, debtor, creditor);
    if (debt) debt.repaid = true;
  }
}
