/**
 * The knowledge base built from the SCPT Strategy Guides: each episode split
 * into sections and single-topic chunks, distilled into advice, plus the
 * strategic concepts the chunks rely on.
 */
import type { Expansion } from "~/game/data/types";
import type { Scope } from "./scope";

/** When in a game a piece of advice applies. */
export const PHASES = ["setup", "round 1", "early", "mid", "late", "any"] as const;
export type Phase = (typeof PHASES)[number];

export const TOPICS = [
  "strategy cards",
  "opening",
  "expansion",
  "technology",
  "objectives",
  "economy",
  "trade and diplomacy",
  "combat",
  "faction abilities",
  "promissory notes",
  "action cards",
  "agendas",
  "mecatol",
  "threats and matchups",
  "general strategy",
] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * Game mechanics a piece of advice depends on. Whether the engine supports
 * each one is decided when the knowledge is used, not stored with it.
 */
export const MECHANICS = [
  "faction abilities",
  "faction technologies",
  "action cards",
  "agendas",
  "promissory notes",
  "leaders",
] as const;
export type Mechanic = (typeof MECHANICS)[number];

export const STANCES = ["recommended", "avoid", "situational", "rating"] as const;
export type Stance = (typeof STANCES)[number];

export type Advice = {
  /** One piece of advice, about using something, not what it does. */
  point: string;
  stance: Stance;
  /** Canonical names of the factions, cards, techs, notes or abilities it is about. */
  subjects: string[];
};

export type Chunk = {
  /** "118-07": episode and position. */
  id: string;
  episode: number;
  section: string;
  /** Seconds into the episode. */
  start: number;
  end: number;
  title: string;
  /** Off-topic passages (intros, banter, sponsor reads) are kept but not indexed. */
  kind: "strategy" | "banter";
  /** How to play and how good things are, without restating rules text. */
  summary: string;
  advice: Advice[];
  factions: string[];
  phases: Phase[];
  topics: Topic[];
  /** Mechanics the advice depends on, beyond the core rules. */
  requires: Mechanic[];
  /** Strategic concepts the chunk refers to, by short canonical name. */
  concepts: string[];
  /** The content the advice holds for; most hold whatever is in play. */
  scope: Scope;
  /** The corrected transcript for the span. */
  text: string;
};

export type Section = {
  id: string;
  title: string;
  start: number;
  end: number;
  summary: string;
  chunks: string[];
};

export type EpisodeChunks = {
  episode: number;
  title: string;
  factionId: string;
  /** The content the hosts played with when they recorded it; [] is the base game alone. */
  recordedWith: Expansion[];
  glossaryVersion: number;
  chunkerVersion: number;
  model: string;
  builtAt: string;
  sections: Section[];
  chunks: Chunk[];
  /** Misheard names the model corrected, "heard -> meant". */
  nameFixes: Record<string, string>;
};

export type Concept = {
  name: string;
  aliases: string[];
  definition: string;
  /** Whether any chunk explains the concept, rather than taking it as known. */
  explained: boolean;
  chunks: string[];
};

// --- Drafts -----------------------------------------------------------------------
//
// Agents write drafts that point at sentence ids; `tsx scripts/kb.ts assemble`
// checks them and fills in ids, times and transcript text.

export type ChunkDraft = Omit<Chunk, "id" | "episode" | "section" | "start" | "end" | "text" | "scope"> & {
  /** Id of the chunk's first sentence, e.g. "s412". */
  start: string;
  /** Left out for advice that holds whatever content is in play. */
  scope?: Scope;
};

export type EpisodeDraft = {
  episode: number;
  recordedWith: Expansion[];
  sections: { title: string; summary: string; chunks: ChunkDraft[] }[];
  nameFixes: Record<string, string>;
};

export type ConceptDraft = Omit<Concept, "chunks"> & {
  /** Concept names as chunks wrote them, which this concept covers. */
  covers: string[];
};
