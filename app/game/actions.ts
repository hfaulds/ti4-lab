import { PlayerId } from "~/types";
import {
  CommandPools,
  Payment,
  SystemKey,
  TransactionSide,
  UnitCounts,
  UnitType,
} from "./types";

export type ShipMove = {
  from: SystemKey;
  ships: UnitCounts;
  /** Origin to active system. Worked out automatically when omitted. */
  path?: SystemKey[];
  /** Applies Gravity Drive to this move, which must be a single ship. */
  gravityDrive?: boolean;
};

export type CargoPickup = {
  system: SystemKey;
  /** Planet the units are lifted from; omitted for units already in space. */
  planet?: string;
  units: UnitCounts;
};

export type ProductionOrder = {
  type: UnitType;
  /** Number of units, so 2 for a full pair of fighters or infantry. */
  count: number;
  /** Planet for ground forces; omitted to place the units in space. */
  planet?: string;
};

export type Research = {
  technology: string;
  /** Planets exhausted for their technology specialty. */
  skips?: string[];
  /** Exhaust AI Development Algorithm to ignore a prerequisite. */
  useAida?: boolean;
};

export type StructurePlacement = { type: "pds" | "spacedock"; planet: string };

export type ObjectivePayment = {
  resources?: Payment;
  influence?: Payment;
  tradeGoods?: number;
  tokens?: { tactic: number; strategy: number };
  /** Cards given up for objectives that ask for them. */
  actionCards?: string[];
  relicFragments?: string[];
};

export type StrategicPayload =
  | { card: "leadership"; influence?: Payment; pools: CommandPools }
  | { card: "diplomacy"; system?: SystemKey; ready: string[] }
  | { card: "politics"; speaker?: PlayerId }
  | {
      card: "construction";
      structures: StructurePlacement[];
      /** Secondary only: where the command token goes. */
      system?: SystemKey;
      /** Thunder's Edge: produce at a space dock instead of building. */
      production?: { system: SystemKey; units: ProductionOrder[]; payment: Payment };
    }
  | { card: "trade"; allow?: PlayerId[] }
  | {
      card: "warfare";
      removeFrom?: SystemKey;
      pools?: CommandPools;
      production?: { units: ProductionOrder[]; payment: Payment };
    }
  | {
      card: "technology";
      research?: Research;
      second?: Research & { payment: Payment };
      payment?: Payment;
    }
  | { card: "imperial"; objective?: string; payment?: ObjectivePayment };

export type HitAssignment = {
  /** Units that use SUSTAIN DAMAGE, one entry per unit. */
  sustain: UnitType[];
  destroy: UnitCounts;
};

/** Hand-applied changes, for card text the engine does not resolve itself. */
export type Adjustment =
  | { type: "tradeGoods"; player: PlayerId; amount: number }
  | { type: "commodities"; player: PlayerId; amount: number }
  | { type: "commandTokens"; player: PlayerId; pool: keyof CommandPools; amount: number }
  | { type: "victoryPoints"; player: PlayerId; amount: number }
  | {
      type: "units";
      player: PlayerId;
      system: SystemKey;
      planet?: string;
      unit: UnitType;
      amount: number;
    }
  | {
      type: "damage";
      player: PlayerId;
      system: SystemKey;
      planet?: string;
      unit: UnitType;
      damaged: number;
    }
  | { type: "planetControl"; planet: string; player?: PlayerId }
  | { type: "planetExhausted"; planet: string; exhausted: boolean }
  | { type: "attachment"; planet: string; attachment: string; attached: boolean }
  | { type: "systemToken"; player: PlayerId; system: SystemKey; present: boolean }
  | { type: "frontier"; system: SystemKey; present: boolean }
  | { type: "wormhole"; system: SystemKey; wormhole: string; present: boolean }
  | { type: "technology"; player: PlayerId; technology: string; owned: boolean }
  | { type: "drawActionCards"; player: PlayerId; count: number }
  | { type: "discardActionCard"; player: PlayerId; card: string }
  | { type: "drawSecret"; player: PlayerId }
  | { type: "relic"; player: PlayerId; relic?: string; owned: boolean }
  | { type: "relicFragment"; player: PlayerId; fragment: string; owned: boolean }
  | { type: "speaker"; player: PlayerId }
  | { type: "law"; agenda: string; inPlay: boolean; outcome?: string }
  | { type: "custodians"; present: boolean }
  | { type: "scorePublic"; player: PlayerId; objective: string; scored: boolean }
  | { type: "explore"; player: PlayerId; planet?: string; system?: SystemKey; deck?: string }
  | { type: "note"; text: string };

export type GameAction =
  // Setup
  | { type: "CHOOSE_SECRET"; keep: string }
  | { type: "CHOOSE_STARTING_TECH"; technologies: string[] }
  // Strategy phase
  | { type: "PICK_STRATEGY_CARD"; card: string }
  // Action phase
  | { type: "ACTIVATE_SYSTEM"; system: SystemKey }
  | { type: "MOVE_SHIPS"; moves: ShipMove[]; cargo: CargoPickup[] }
  | { type: "FIRE_SPACE_CANNON"; promptId: number; fire: boolean }
  | { type: "ASSIGN_HITS"; promptId: number; assignment: HitAssignment }
  | { type: "ANNOUNCE_RETREAT"; to?: SystemKey }
  | { type: "BOMBARD"; targets: { unit: UnitType; planet: string; count: number }[] }
  | {
      type: "COMMIT_GROUND_FORCES";
      landings: { planet: string; units: UnitCounts }[];
      /** Influence spent to remove the custodians token. */
      custodians?: Payment;
    }
  | { type: "PRODUCE"; units: ProductionOrder[]; payment: Payment }
  | { type: "STRATEGIC_ACTION"; payload: StrategicPayload }
  | { type: "RESOLVE_SECONDARY"; promptId: number; payload?: StrategicPayload }
  | { type: "ORDER_AGENDAS"; top: string[]; bottom: string[] }
  | { type: "PLAY_ACTION_CARD"; card: string }
  | { type: "COMPONENT_ACTION"; description: string }
  | { type: "PASS" }
  | { type: "END_TURN" }
  // Status phase
  | {
      type: "SCORE_OBJECTIVES";
      publicObjective?: string;
      secretObjective?: string;
      payment?: ObjectivePayment;
    }
  | { type: "SCORE_OBJECTIVE"; objective: string; payment?: ObjectivePayment }
  | { type: "REDISTRIBUTE"; pools: CommandPools }
  | { type: "DISCARD_ACTION_CARDS"; cards: string[] }
  | { type: "RETURN_SECRET"; objective: string }
  // Agenda phase
  | { type: "CAST_VOTES"; outcome?: string; planets: string[]; extraVotes?: number }
  | { type: "BREAK_TIE"; outcome: string }
  // Any time
  | { type: "RESOLVE"; promptId: number }
  | { type: "PROPOSE_TRANSACTION"; to: PlayerId; give: TransactionSide; receive: TransactionSide }
  | { type: "ANSWER_TRANSACTION"; transaction: number; accept: boolean }
  | { type: "PLAY_PROMISSORY_NOTE"; note: string; owner: PlayerId }
  | { type: "RETURN_PROMISSORY_NOTE"; note: string; owner: PlayerId }
  | { type: "SET_LEADER"; leader: string; status: "locked" | "ready" | "exhausted" | "purged" }
  | { type: "SET_EXHAUSTED"; kind: "technology" | "relic" | "breakthrough"; id: string; exhausted: boolean }
  | { type: "SET_BREAKTHROUGH"; unlocked: boolean }
  | { type: "ADJUST"; adjustment: Adjustment };

export type GameActionType = GameAction["type"];
