import { FactionId, Map as TiMap, PlayerId, Wormhole } from "~/types";
import { Expansion, UnitCounts, UnitType } from "./data/types";

export type { Expansion, UnitCounts, UnitType };

export type GameOptions = {
  expansions: Expansion[];
  victoryPoints: number;
};

export type UnitStack = { count: number; damaged: number };
/** One player's units in a single space area or on a single planet. */
export type UnitGroup = Partial<Record<UnitType, UnitStack>>;
/** Units in one location, keyed by owning player. */
export type Forces = Record<PlayerId, UnitGroup>;

export type SystemKey = number;

export type SystemState = {
  /** Index into `map` for tiles on the board; 1000+ for off-board systems. */
  key: SystemKey;
  systemId: string;
  onBoard: boolean;
  planets: string[];
  space: Forces;
  commandTokens: PlayerId[];
  frontier: boolean;
  /** Wormholes added during play (gamma tokens, ion storm, Creuss tokens). */
  addedWormholes: Wormhole[];
  /** Wormholes printed on the tile that are not yet in effect (nexus). */
  inactiveWormholes: Wormhole[];
  homeOf?: PlayerId;
};

export type PlanetState = {
  name: string;
  system: SystemKey;
  controller?: PlayerId;
  exhausted: boolean;
  units: Forces;
  attachments: string[];
  legendaryExhausted?: boolean;
};

export type CommandPools = { tactic: number; fleet: number; strategy: number };

export type LeaderState = {
  id: string;
  type: "agent" | "commander" | "hero";
  status: "locked" | "ready" | "exhausted" | "purged";
};

export type PromissoryNote = {
  /** Card id from the data set. */
  id: string;
  /** Player the note belongs to; it returns to them when resolved. */
  owner: PlayerId;
};

export type HeldStrategyCard = { id: string; exhausted: boolean };

export type PlayerState = {
  id: PlayerId;
  name: string;
  faction: FactionId;
  /** Council Keleres: the faction whose home system they are using. */
  factionVariant?: FactionId;
  color: string;
  seat: number;
  home: SystemKey;
  commodities: number;
  commodityLimit: number;
  tradeGoods: number;
  pools: CommandPools;
  technologies: string[];
  exhaustedTechnologies: string[];
  actionCards: string[];
  secretObjectives: string[];
  scoredSecrets: string[];
  promissoryNotes: PromissoryNote[];
  promissoryNotesInPlay: PromissoryNote[];
  strategyCards: HeldStrategyCard[];
  leaders: LeaderState[];
  relics: string[];
  exhaustedRelics: string[];
  relicFragments: string[];
  breakthrough?: { id: string; unlocked: boolean; exhausted: boolean };
  passed: boolean;
  /** Victory points from sources other than objectives. */
  bonusVictoryPoints: number;
  eliminated: boolean;
};

export type Phase = "setup" | "strategy" | "action" | "status" | "agenda" | "finished";

export type Deck = { draw: string[]; discard: string[] };

export type PublicObjective = {
  id: string;
  revealed: boolean;
  scoredBy: PlayerId[];
};

export type Law = {
  id: string;
  /** Elected player, planet or other outcome, as voted. */
  outcome?: string;
  owner?: PlayerId;
};

export type Payment = { planets: string[]; tradeGoods: number };

export type HitSource =
  | "spaceCannonOffense"
  | "antiFighterBarrage"
  | "spaceCombat"
  | "bombardment"
  | "spaceCannonDefense"
  | "groundCombat";

export type Prompt = { id: number; player: PlayerId; group: number } & (
  | { kind: "chooseSecret"; options: string[] }
  | { kind: "chooseStartingTech"; options: string[]; count: number }
  | { kind: "secondary"; card: string; from: PlayerId; free?: boolean }
  | { kind: "politicsAgenda"; cards: string[] }
  | { kind: "spaceCannon"; system: SystemKey; planet?: string; target: PlayerId }
  | {
      kind: "assignHits";
      hits: number;
      source: HitSource;
      system: SystemKey;
      planet?: string;
      from?: PlayerId;
    }
  | { kind: "announceRetreat"; system: SystemKey; options: SystemKey[] }
  | { kind: "scoreObjectives" }
  | { kind: "redistribute"; gained: number }
  | { kind: "discardActionCards"; count: number }
  | { kind: "returnSecret" }
  | { kind: "vote" }
  | { kind: "breakTie"; outcomes: string[] }
  | {
      /** A card or ability the table resolves by hand before play continues. */
      kind: "resolve";
      title: string;
      text: string;
      card?: string;
    }
);

export type DistributivePick<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never;
export type NewPrompt = DistributivePick<Prompt, "id" | "group">;

export type CombatRoll = {
  player: PlayerId;
  unit: UnitType;
  target: number;
  dice: number[];
  hits: number;
};

export type CombatStage = "start" | "announce" | "roll" | "assign" | "retreat";

export type SpaceCombat = {
  attacker: PlayerId;
  defender: PlayerId;
  round: number;
  stage: CombatStage;
  retreat?: { player: PlayerId; to: SystemKey };
};

export type GroundCombat = {
  planet: string;
  attacker: PlayerId;
  defender: PlayerId;
  round: number;
  stage: CombatStage;
};

export type TacticalStep =
  | "movement"
  | "spaceCannonOffense"
  | "spaceCombat"
  | "bombardment"
  | "commit"
  | "spaceCannonDefense"
  | "groundCombat"
  | "production"
  | "done";

export type TacticalAction = {
  player: PlayerId;
  system: SystemKey;
  step: TacticalStep;
  spaceCombat?: SpaceCombat;
  groundCombat?: GroundCombat;
  /** Planets ground forces were committed to this action. */
  invaded: string[];
  /** Planets already resolved in the ground combat step. */
  resolved: string[];
  bombarded: boolean;
};

export type StrategicAction = {
  player: PlayerId;
  card: string;
};

export type Vote = { player: PlayerId; outcome: string; votes: number };

export type AgendaState = {
  /** 1 or 2: which agenda of the phase this is. */
  number: number;
  card?: string;
  votes: Vote[];
  voted: PlayerId[];
  /** Outcome chosen once voting has finished. */
  result?: string;
};

export type Transaction = {
  id: number;
  from: PlayerId;
  to: PlayerId;
  give: TransactionSide;
  receive: TransactionSide;
};

export type TransactionSide = {
  tradeGoods?: number;
  commodities?: number;
  promissoryNotes?: PromissoryNote[];
  relicFragments?: string[];
  actionCards?: string[];
};

export type LogEntry = {
  id: number;
  round: number;
  phase: Phase;
  player?: PlayerId;
  text: string;
  rolls?: CombatRoll[];
  /** Hand-applied change rather than something the rules engine resolved. */
  manual?: boolean;
  /** Only these players may read the entry. */
  visibleTo?: PlayerId[];
};

export type GameState = {
  version: number;
  options: GameOptions;
  round: number;
  phase: Phase;
  /** Player ids clockwise around the table. */
  seating: PlayerId[];
  players: Record<PlayerId, PlayerState>;
  speaker: PlayerId;
  activePlayer?: PlayerId;
  /** Actions the active player has taken this turn. */
  actionsThisTurn: number;
  /** Players the active player has already traded with this turn. */
  tradedWith: PlayerId[];

  map: TiMap;
  systems: Record<SystemKey, SystemState>;
  planets: Record<string, PlanetState>;
  custodians: boolean;

  strategyCards: string[];
  /** Trade goods sitting on unpicked strategy cards. */
  strategyCardBonus: Record<string, number>;

  decks: {
    actionCards: Deck;
    agendas: Deck;
    secretObjectives: Deck;
    stage1: Deck;
    stage2: Deck;
    cultural: Deck;
    hazardous: Deck;
    industrial: Deck;
    frontier: Deck;
    relics: Deck;
  };
  publicObjectives: PublicObjective[];
  laws: Law[];

  tactical?: TacticalAction;
  strategic?: StrategicAction;
  agenda?: AgendaState;
  /** Step of the status phase that is waiting on players. */
  statusStep?: "score" | "redistribute";
  transactions: Transaction[];

  prompts: Prompt[];
  nextId: number;
  rng: number;
  log: LogEntry[];
  winner?: PlayerId;
};

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}
