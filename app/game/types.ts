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
  /**
   * Events this turn that action-phase secret objectives ask for, such as
   * "dtgs" after destroying a war sun. Cleared when the turn ends.
   */
  achievements?: string[];
  /** Infantry waiting on the Infantry II card to return at the next turn. */
  revivingInfantry?: number;
  /** Abilities used this round or this combat that are limited in use. */
  used?: string[];
  /** Political Stability: keeps strategy cards through the next strategy phase. */
  keepsStrategyCards?: boolean;
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
  | "groundCombat"
  /** Ships the player must choose and destroy; SUSTAIN DAMAGE does not help. */
  | "destroyShips"
  /** As above, but only non-fighter ships (Assault Cannon). */
  | "destroyNonFighterShips";

/**
 * Moments in the game when players may play cards or use abilities. Each
 * one is offered, as a "window" prompt, only to players with something they
 * could use in it.
 */
export type WindowId =
  // Action phase
  | "turnStart"
  | "afterActivate"
  | "afterMove"
  | "beforeSpaceCannonHits"
  | "combatStart"
  | "roundStart"
  | "afterRolls"
  | "beforeCombatHits"
  | "afterSustain"
  | "afterShipDestroyed"
  | "afterUnitDestroyed"
  | "roundEnd"
  | "afterRetreat"
  | "afterCombat"
  | "invasionStart"
  | "afterCommit"
  | "groundCombatStart"
  | "afterGainControl"
  | "afterProduce"
  | "afterPlaceDock"
  | "afterTacticalAction"
  | "afterAction"
  | "afterGainTradeGoods"
  | "afterReplenish"
  | "afterStrategicAction"
  | "afterResearch"
  | "actionCardPlayed"
  // Strategy phase
  | "strategyStart"
  | "afterPickStrategyCard"
  | "strategyEnd"
  // Status phase
  | "statusStart"
  | "returnStrategyCards"
  | "gainStatusTokens"
  | "statusEnd"
  // Agenda phase
  | "agendaStart"
  | "agendaRevealed"
  | "afterAgendaRevealed"
  | "afterSpeakerVotes"
  | "afterVote"
  | "whenElected";

/** What a window is about. Which fields are set depends on the window. */
export type WindowContext = {
  system?: SystemKey;
  planet?: string;
  /** The other player involved: the opponent, the active player, the player who played a card. */
  player?: PlayerId;
  unit?: UnitType;
  /** Action card, agenda, strategy card kind or technology the window is about. */
  card?: string;
  /** Prompt (hits to cancel) or pending effect (card to cancel) it refers to. */
  ref?: number;
  amount?: number;
  /** Units involved, such as the structures lost with a planet. */
  units?: UnitCounts;
  /** Set when a promissory note is played: the player it belongs to. */
  noteOwner?: PlayerId;
};

/** Something a player can use: an action card in hand, an ability, a note. */
export type Reaction =
  | { kind: "actionCard"; id: string }
  /** Faction abilities, technologies, unit abilities and laws the player owns. */
  | { kind: "ability"; id: string }
  | { kind: "promissoryNote"; id: string; owner: PlayerId };

/** Choices made when playing a card or using an ability. */
export type EffectTargets = {
  player?: PlayerId;
  planet?: string;
  planets?: string[];
  system?: SystemKey;
  unit?: UnitType;
  units?: UnitCounts;
  technology?: string;
  card?: string;
  cards?: string[];
  outcome?: string;
  amount?: number;
  payment?: Payment;
  production?: { type: UnitType; count: number; planet?: string }[];
  pools?: CommandPools;
  /** Units moved from one place to a planet (Transit Diodes, Bioplasmosis). */
  transfers?: {
    from: { system: SystemKey; planet?: string };
    to: string;
    unit: UnitType;
    count: number;
  }[];
  /** A named choice, such as "tradeGood" or "commodity" for Pillage. */
  choice?: string;
};

/** A card or ability that has been played and resolves once nobody cancels it. */
export type PendingEffect = {
  id: number;
  player: PlayerId;
  reaction: Reaction;
  targets: EffectTargets;
  context: WindowContext;
  /** Prompt group (players deciding whether to cancel it) to wait for. */
  group: number;
  cancelled?: boolean;
};

export type Prompt = { id: number; player: PlayerId; group: number } & (
  | { kind: "chooseSecret"; options: string[] }
  | { kind: "chooseStartingTech"; options: string[]; count: number }
  | {
      kind: "placeStartingUnits";
      /** Home planets the units can go on. */
      planets: string[];
      /** Ground forces and structures still to be placed. */
      units: UnitCounts;
      /** Where the faction sheet puts them, offered as a starting point. */
      suggested: Record<string, UnitCounts>;
    }
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
      /** Hits that must go to non-fighter ships if able (Graviton Laser System, L1Z1X flagship). */
      nonFighter?: number;
    }
  | { kind: "announceRetreat"; system: SystemKey; options: SystemKey[] }
  | { kind: "scoreObjectives" }
  | { kind: "redistribute"; gained: number }
  | { kind: "discardActionCards"; count: number }
  | { kind: "returnSecret" }
  | { kind: "vote" }
  | { kind: "breakTie"; outcomes: string[] }
  /** Research technologies for free, as an agenda or rider allows. */
  | { kind: "research"; count: number }
  | {
      kind: "window";
      window: WindowId;
      context: WindowContext;
      options: Reaction[];
      /** Abilities and notes already used in this window; each is used once. */
      used?: string[];
    }
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
  /** Added to each die before comparing it with the target. */
  modifier?: number;
};

export type CombatStage =
  /** Start-of-combat abilities (Assault Cannon, Ambush). */
  | "start"
  /** Anti-fighter barrage, or the start of the invasion combat on the ground. */
  | "afb"
  /** Start of a combat round (Morale Boost). */
  | "roundStart"
  | "announce"
  | "roll"
  /** Dice are counted once rerolls are done. */
  | "hits"
  | "assign"
  /** End of a combat round (Devotion, Harrow). */
  | "roundEnd"
  | "retreat";

export type CombatEffects = {
  /** Added to every combat roll of a player this round (Morale Boost). */
  roundModifiers?: Record<PlayerId, number>;
  /** Added to every combat roll of a player for the whole combat. */
  modifiers?: Record<PlayerId, number>;
  /** Card and ability flags in force, as "<id>:<player>". */
  flags?: string[];
  /** Dice rolled this round, kept so they can be rerolled before hits count. */
  rolls?: CombatRoll[];
  /** Unit types destroyed in the combat (Salvage Operations). */
  destroyed?: UnitType[];
  /** Damaged units each player had at the start of the round (Duranium Armor). */
  damagedAtStart?: Record<PlayerId, UnitType[]>;
};

export type SpaceCombat = CombatEffects & {
  attacker: PlayerId;
  defender: PlayerId;
  round: number;
  stage: CombatStage;
  retreat?: { player: PlayerId; to: SystemKey };
};

export type GroundCombat = CombatEffects & {
  planet: string;
  attacker: PlayerId;
  defender: PlayerId;
  round: number;
  stage: CombatStage;
};

export type TacticalStep =
  | "movement"
  | "moved"
  | "spaceCannonOffense"
  | "spaceCombat"
  | "bombardment"
  | "commit"
  | "committed"
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
  /** Card and ability flags in force for this tactical action, as "<id>:<player>". */
  flags?: string[];
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
  /** Players who cannot vote on this agenda (Political Secret, Assassinate Representative). */
  silenced?: PlayerId[];
  /** Players who may not vote, but did not lose the use of action cards and abilities. */
  barred?: PlayerId[];
  /** Rider predictions: who predicted which outcome with which card or ability. */
  predictions?: {
    player: PlayerId;
    card: string;
    outcome: string;
    /** Where a correct prediction places things, chosen when it was made. */
    planet?: string;
    system?: SystemKey;
  }[];
  step?: "start" | "revealed" | "riders" | "voting" | "tally" | "tie" | "elected" | "done";
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
  /** The pick other players may still object to (Public Disgrace). */
  lastPick?: { player: PlayerId; card: string; bonus: number };
  /** A card a player may not choose again this strategy phase. */
  disgraced?: { player: PlayerId; card: string };
  /** The strategy phase has ended; waiting on end-of-phase abilities. */
  strategyEnding?: boolean;
  /** Holder of the Naalu "0" token, first in initiative order this round. */
  zeroToken?: PlayerId;
  /** Public Execution: the player who cannot vote for the rest of the agenda phase. */
  executed?: PlayerId;
  /** What agendas left to happen at the start of the next strategy phase. */
  nextStrategyEffects?: {
    kind: "exhaustPerTech" | "exhaustSpecialty" | "exhaustHome" | "exhaustCultural";
    players?: PlayerId[];
  }[];

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
  statusStep?: "score" | "redistribute" | "return" | "end";
  transactions: Transaction[];

  prompts: Prompt[];
  /** Played cards and abilities waiting to resolve, newest last. */
  pending?: PendingEffect[];
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
