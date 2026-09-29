import { FactionId, TechSpecialty } from "~/types";

/**
 * Official content a card or component ships with.
 * "base" is always in play; everything else is opt-in per game.
 */
export type ContentSource =
  | "base"
  | "pok"
  | "codex1"
  | "codex2"
  | "codex3"
  | "codex4"
  | "te";

export type Expansion = Exclude<ContentSource, "base">;

export type UnitType =
  | "carrier"
  | "cruiser"
  | "destroyer"
  | "dreadnought"
  | "fighter"
  | "flagship"
  | "infantry"
  | "mech"
  | "pds"
  | "spacedock"
  | "warsun";

export type UnitCounts = Partial<Record<UnitType, number>>;

export type UnitData = {
  id: string;
  type: UnitType;
  name: string;
  source: ContentSource;
  faction?: FactionId;
  /** Technology that must be owned for this version of the unit to apply. */
  requiredTechId?: string;
  upgradesFromUnitId?: string;
  upgradesToUnitId?: string;
  cost?: number;
  /** Number of units produced for `cost` (2 for fighters and infantry). */
  producedPerCost: number;
  move?: number;
  capacity?: number;
  combat?: number;
  combatDice?: number;
  afb?: number;
  afbDice?: number;
  bombardment?: number;
  bombardmentDice?: number;
  spaceCannon?: number;
  spaceCannonDice?: number;
  deepSpaceCannon?: boolean;
  sustainDamage?: boolean;
  planetaryShield?: boolean;
  disablesPlanetaryShield?: boolean;
  /** Flat production value, e.g. a flagship with PRODUCTION 2. */
  production?: number;
  /** Production added to the planet's resource value (space docks). */
  productionPlusResources?: number;
  /** Floating Factory style units that live in the space area. */
  spaceOnly?: boolean;
  ability?: string;
};

export type TechColor = TechSpecialty;
export type TechnologyData = {
  id: string;
  name: string;
  source: ContentSource;
  color?: TechColor;
  unitUpgrade: boolean;
  prerequisites: TechColor[];
  faction?: FactionId;
  /** Generic unit upgrade this faction upgrade stands in for. */
  baseUpgrade?: string;
  text: string;
};

export type ActionCardData = {
  id: string;
  name: string;
  source: ContentSource;
  phase: string;
  window: string;
  text: string;
  /** True when playing the card uses the player's action for the turn. */
  componentAction: boolean;
};

export type AgendaTarget =
  | "forAgainst"
  | "player"
  | "planet"
  | "nonHomePlanet"
  | "culturalPlanet"
  | "hazardousPlanet"
  | "industrialPlanet"
  | "scoredSecret"
  | "law"
  | "strategyCard"
  | "other";

export type AgendaData = {
  id: string;
  name: string;
  source: ContentSource;
  type: "law" | "directive";
  target: AgendaTarget;
  targetText: string;
  text1: string;
  text2: string;
};

export type ObjectiveData = {
  id: string;
  name: string;
  source: ContentSource;
  kind: "stage1" | "stage2" | "secret";
  phase: "status" | "action" | "agenda";
  points: number;
  text: string;
};

export type StrategyCardData = {
  id: string;
  name: string;
  source: ContentSource;
  initiative: number;
  color: string;
  primary: string[];
  secondary: string[];
};

export type ExplorationDeck = "cultural" | "hazardous" | "industrial" | "frontier";
export type ExplorationData = {
  id: string;
  name: string;
  source: ContentSource;
  deck: ExplorationDeck;
  resolution: "instant" | "attach" | "fragment" | "token";
  attachmentId?: string;
  text: string;
};

export type AttachmentData = {
  id: string;
  name: string;
  source: ContentSource;
  resources: number;
  influence: number;
  techSpecialty: TechSpecialty[];
  legendary?: boolean;
};

export type RelicData = {
  id: string;
  name: string;
  source: ContentSource;
  text: string;
};

export type LeaderData = {
  id: string;
  faction: FactionId;
  source: ContentSource;
  type: "agent" | "commander" | "hero";
  name: string;
  title: string;
  window: string;
  text: string;
  unlock: string;
};

export type PromissoryNoteData = {
  id: string;
  name: string;
  source: ContentSource;
  /** Present for faction notes, absent for the generic color notes. */
  faction?: FactionId;
  playArea: boolean;
  text: string;
};

export type AbilityData = {
  id: string;
  name: string;
  source: ContentSource;
  faction: FactionId;
  text: string;
};

export type BreakthroughData = {
  id: string;
  name: string;
  source: ContentSource;
  faction: FactionId;
  synergy: TechColor[];
  text: string;
};

export type GalacticEventData = {
  id: string;
  name: string;
  source: ContentSource;
  text: string;
};

export type StartingUnits = {
  space: UnitCounts;
  planets: Record<string, UnitCounts>;
};

export type FactionSetupData = {
  faction: FactionId;
  /** Distinguishes the three Council Keleres home system choices. */
  variant?: FactionId;
  source: ContentSource;
  commodities: number;
  startingTech: string[];
  startingTechOptions: string[];
  startingTechChoices: number;
  factionTech: string[];
  abilities: string[];
  leaders: string[];
  promissoryNotes: string[];
  units: string[];
  breakthrough?: string;
  homePlanets: string[];
  startingUnits: StartingUnits;
};
